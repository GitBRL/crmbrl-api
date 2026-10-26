import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService } from '../fila/fila.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { PublicacaoChatService } from './publicacao-chat.service';
import {
  areasDoChat,
  CANAIS_DO_SISTEMA,
  CHAVE_DO_GERAL,
  canaisAutomaticosPorPapel,
  chaveDaArea,
  marcarMencao,
} from './regras-chat';

/** Fila do job que confere os membros automáticos (R15.1). */
export const FILA_SINCRONIZAR_CHAT = 'chat-interno.sincronizar';

/** A cada minuto: pega quem foi criado, mudou de papel ou foi reativado. */
export const AGENDA_DA_SINCRONIZACAO = '* * * * *';

/** Quem faz as mudanças automáticas (mesmo quando disparadas por uma requisição). */
const ATOR_DO_CHAT = {
  tipoAtor: 'SISTEMA',
  descricao: 'Chat interno',
} as const;

/** Um membro que entrou ou saiu de um canal. */
export interface MudancaDeMembro {
  canalId: string;
  usuarioId: string;
}

export interface ResultadoDaSincronizacao {
  /** Entradas automáticas no Geral e nos canais das áreas. */
  entraram: MudancaDeMembro[];
  /** Saídas automáticas (mudou de papel, foi desligado) e de grupos (desligado). */
  sairam: MudancaDeMembro[];
}

interface SaidaDeGrupo extends MudancaDeMembro {
  administrador: boolean;
}

/**
 * Canais padrão e membros automáticos (R15.1): o "Geral" (todos os usuários
 * ativos) e um canal por área (as pessoas da área e o C-level), criados e
 * mantidos pelo sistema.
 *
 * O módulo de usuários não publica eventos de criação nem de mudança de papel
 * (só `usuario.desligado`), então a sincronização é feita por um SQL
 * idempotente, que compara os membros automáticos com os papéis atuais:
 *
 * - na subida da API (com `PROCESSAR_FILAS=true`) e a cada minuto (job
 *   `chat-interno.sincronizar`);
 * - logo depois de um desligamento (manipulador de `usuario.desligado`) — quem
 *   foi desligado sai também dos grupos (com aviso no grupo; se era o único
 *   administrador, o membro mais antigo assume);
 * - sob demanda, para quem abre o chat (`sincronizarSeNecessario`) e para quem
 *   é mencionado num canal padrão.
 *
 * Cada mudança vai para a outbox (`chat_canal.atualizado`): o tempo real
 * avisa quem entrou ou saiu depois do commit.
 */
@Injectable()
export class SincronizacaoChatService
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger('ChatInterno');

  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly eventos: EventosDominioService,
    private readonly auditoria: AuditoriaService,
    private readonly publicacao: PublicacaoChatService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(
      FILA_SINCRONIZAR_CHAT,
      async () => {
        await this.sincronizar();
      },
      {
        // Sem retentativa: a execução do minuto seguinte refaz o que faltou.
        tentativas: 0,
        prazoDeExecucaoSegundos: 5 * 60,
        guardarConcluidosPorSegundos: 60 * 60,
      },
    );
    await this.fila.agendar(FILA_SINCRONIZAR_CHAT, AGENDA_DA_SINCRONIZACAO);
    this.eventos.registrarManipulador<{ usuario?: { id?: string } }>(
      'usuario.desligado',
      async (evento) => {
        const usuarioId = evento.dados.usuario?.id;
        if (usuarioId) {
          await this.sincronizar({ usuarioIds: [usuarioId] });
        }
      },
      'chat-interno:desligamento',
    );
  }

  /** Na subida, em segundo plano (não segura a API se o banco demorar). */
  onApplicationBootstrap(): void {
    if (!this.ambiente.processarFilas) {
      return;
    }
    void executarComoAtor(ATOR_DO_CHAT, () => this.sincronizar()).catch(
      (erro: unknown) =>
        this.logger.warn(
          `Sincronização inicial do chat falhou (o job do minuto seguinte tenta de novo): ${erro instanceof Error ? erro.message : String(erro)}`,
        ),
    );
  }

  /**
   * Cria os canais padrão que faltam e acerta os membros automáticos — de
   * todos, ou só de `usuarioIds`. Idempotente.
   */
  async sincronizar(
    opcoes: { usuarioIds?: readonly string[] } = {},
  ): Promise<ResultadoDaSincronizacao> {
    if (opcoes.usuarioIds && opcoes.usuarioIds.length === 0) {
      return { entraram: [], sairam: [] };
    }
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'chat-interno', 'sincronizacao');
      await this.garantirCanaisDoSistema(tx);
      const automaticos = Prisma.join(
        canaisAutomaticosPorPapel().map(
          ([papel, chave]) => Prisma.sql`(${papel}::papel, ${chave}::text)`,
        ),
      );
      const ids = opcoes.usuarioIds ? [...new Set(opcoes.usuarioIds)] : null;
      const soDosUsuarios = (coluna: string) =>
        ids
          ? Prisma.sql`AND ${Prisma.raw(coluna)} = ANY(${ids}::uuid[])`
          : Prisma.empty;

      const entraram = await tx.$queryRaw<MudancaDeMembro[]>`
        INSERT INTO chat_membros (id, canal_id, usuario_id, automatico, criado_em, atualizado_em)
        SELECT gen_random_uuid(), c.id, u.id, true, now(), now()
          FROM usuarios u
          JOIN (VALUES ${automaticos}) AS automaticos(papel, chave)
            ON automaticos.papel = u.papel
          JOIN chat_canais c ON c.chave = automaticos.chave
         WHERE u.ativo ${soDosUsuarios('u.id')}
        ON CONFLICT (canal_id, usuario_id) DO NOTHING
        RETURNING canal_id AS "canalId", usuario_id AS "usuarioId"`;

      const sairamDosPadrao = await tx.$queryRaw<MudancaDeMembro[]>`
        DELETE FROM chat_membros mb
         USING chat_canais c, usuarios u
         WHERE c.id = mb.canal_id
           AND u.id = mb.usuario_id
           AND c.tipo IN ('GERAL', 'AREA')
           AND c.chave IS NOT NULL
           ${soDosUsuarios('mb.usuario_id')}
           AND NOT (u.ativo AND (u.papel, c.chave) IN (VALUES ${automaticos}))
        RETURNING mb.canal_id AS "canalId", mb.usuario_id AS "usuarioId"`;

      // Trava os grupos afetados antes de mexer nos membros (na mesma ordem
      // das mudanças de grupo feitas pelas pessoas: canal primeiro).
      await tx.$queryRaw`
        SELECT c.id FROM chat_canais c
         WHERE c.tipo = 'GRUPO'
           AND EXISTS (
             SELECT 1 FROM chat_membros mb
               JOIN usuarios u ON u.id = mb.usuario_id
              WHERE mb.canal_id = c.id AND NOT u.ativo
                    ${soDosUsuarios('mb.usuario_id')}
           )
         ORDER BY c.id
           FOR NO KEY UPDATE OF c`;

      const sairamDosGrupos = await tx.$queryRaw<SaidaDeGrupo[]>`
        DELETE FROM chat_membros mb
         USING chat_canais c, usuarios u
         WHERE c.id = mb.canal_id
           AND u.id = mb.usuario_id
           AND c.tipo = 'GRUPO'
           AND NOT u.ativo
           ${soDosUsuarios('mb.usuario_id')}
        RETURNING mb.canal_id AS "canalId", mb.usuario_id AS "usuarioId",
                  mb.administrador AS "administrador"`;

      await this.acertarGrupos(tx, sairamDosGrupos);

      const sairam = [...sairamDosPadrao, ...sairamDosGrupos].map(
        ({ canalId, usuarioId }) => ({ canalId, usuarioId }),
      );
      const porCanal = new Map<
        string,
        { entraram: string[]; sairam: string[] }
      >();
      const doCanal = (canalId: string) => {
        const grupo = porCanal.get(canalId) ?? { entraram: [], sairam: [] };
        porCanal.set(canalId, grupo);
        return grupo;
      };
      for (const { canalId, usuarioId } of entraram) {
        doCanal(canalId).entraram.push(usuarioId);
      }
      for (const { canalId, usuarioId } of sairam) {
        doCanal(canalId).sairam.push(usuarioId);
      }
      for (const [canalId, mudancas] of porCanal) {
        await this.publicacao.canalAtualizado(tx, { canalId, ...mudancas });
      }
      return { entraram, sairam };
    });
  }

  /**
   * Sincroniza a pessoa só se os canais padrão dela não batem com o papel
   * (uma leitura barata no caminho comum). Chamado por quem abre o chat.
   */
  async sincronizarSeNecessario(usuarioIds: readonly string[]): Promise<void> {
    const unicos = [...new Set(usuarioIds)];
    if (unicos.length === 0) {
      return;
    }
    const [usuarios, membros] = await Promise.all([
      this.prisma.usuario.findMany({
        where: { id: { in: unicos } },
        select: { id: true, papel: true, ativo: true },
      }),
      this.prisma.chatMembro.findMany({
        where: {
          usuarioId: { in: unicos },
          canal: { tipo: { in: ['GERAL', 'AREA'] } },
        },
        select: { usuarioId: true, canal: { select: { chave: true } } },
      }),
    ]);
    const atuais = new Map<string, Set<string>>();
    for (const membro of membros) {
      const chaves = atuais.get(membro.usuarioId) ?? new Set<string>();
      if (membro.canal.chave) {
        chaves.add(membro.canal.chave);
      }
      atuais.set(membro.usuarioId, chaves);
    }
    const divergentes = usuarios.filter((usuario) => {
      const esperadas = usuario.ativo
        ? [CHAVE_DO_GERAL, ...areasDoChat(usuario.papel).map(chaveDaArea)]
        : [];
      const tem = atuais.get(usuario.id) ?? new Set<string>();
      return (
        esperadas.length !== tem.size ||
        esperadas.some((chave) => !tem.has(chave))
      );
    });
    if (divergentes.length > 0) {
      await this.sincronizar({ usuarioIds: divergentes.map(({ id }) => id) });
    }
  }

  /** Cria o "Geral" e os canais das áreas que ainda não existem. */
  private async garantirCanaisDoSistema(tx: Tx): Promise<void> {
    await tx.chatCanal.createMany({
      data: CANAIS_DO_SISTEMA.map((canal) => ({
        tipo: canal.tipo,
        chave: canal.chave,
        nome: canal.nome,
        descricao: canal.descricao,
        area: canal.area,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Grupos que perderam alguém desligado: aviso no grupo, novo administrador
   * (o membro mais antigo) se não sobrou nenhum, arquivamento se ficou vazio.
   */
  private async acertarGrupos(
    tx: Tx,
    saidas: readonly SaidaDeGrupo[],
  ): Promise<void> {
    const porGrupo = new Map<string, SaidaDeGrupo[]>();
    for (const saida of saidas) {
      porGrupo.set(saida.canalId, [
        ...(porGrupo.get(saida.canalId) ?? []),
        saida,
      ]);
    }
    for (const [canalId, doGrupo] of porGrupo) {
      const canal = await tx.chatCanal.findUnique({
        where: { id: canalId },
        select: { id: true, nome: true, arquivadoEm: true },
      });
      if (!canal) {
        continue;
      }
      const restantes = await tx.chatMembro.findMany({
        where: { canalId },
        orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
        select: { usuarioId: true, administrador: true },
      });
      const ids = doGrupo.map(({ usuarioId }) => usuarioId);
      const nomes = ids.map(marcarMencao).join(', ');
      let novoAdministrador: string | null = null;
      let arquivado = false;
      if (restantes.length === 0) {
        if (!canal.arquivadoEm) {
          await tx.chatCanal.update({
            where: { id: canalId },
            data: { arquivadoEm: new Date() },
          });
          arquivado = true;
        }
      } else if (!restantes.some((membro) => membro.administrador)) {
        novoAdministrador = restantes[0].usuarioId;
        await tx.chatMembro.update({
          where: {
            canalId_usuarioId: { canalId, usuarioId: novoAdministrador },
          },
          data: { administrador: true },
        });
      }
      await this.publicacao.aviso(
        tx,
        canalId,
        `${nomes} ${ids.length > 1 ? 'saíram' : 'saiu'} do grupo (não ${ids.length > 1 ? 'estão' : 'está'} mais no CRM).` +
          (novoAdministrador
            ? ` ${marcarMencao(novoAdministrador)} passou a administrar o grupo.`
            : ''),
      );
      await this.auditoria.registrar(tx, {
        ator: ATOR_DO_CHAT,
        acao: 'chat_canal.membros_removidos',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo:
          `${ids.length === 1 ? 'Pessoa desligada removida' : `${ids.length} pessoas desligadas removidas`} do grupo "${canal.nome ?? ''}"` +
          (arquivado ? ' (o grupo ficou vazio e foi arquivado)' : ''),
        dados: {
          motivo: 'desligamento',
          usuarioIds: ids,
          eramAdministradores: doGrupo
            .filter((saida) => saida.administrador)
            .map(({ usuarioId }) => usuarioId),
          novoAdministradorId: novoAdministrador,
          arquivado,
        },
      });
    }
  }
}
