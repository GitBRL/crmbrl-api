import { Injectable } from '@nestjs/common';
import { ehAtrasada } from '../atividades/regras-atividades';
import { referenciaDeAuditoria } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { semCodigoDeRegra } from '../comum/dados/textos';
import { ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { AcessoAosFunis } from '../funis/acesso-funis';
import { funisAcessiveis } from '../funis/acessos-no-banco';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { type EventoAuditoria, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsuarioVinculadoDto } from './dto/comum.dto';
import { sqlLigacoesVisiveis } from '../bi/escopo-bi';
import {
  ESTADOS_TERMINAIS,
  resultadoDaLigacao,
  textoDoMotivo,
} from '../ligacoes/ligacoes.constantes';
import type { ResumoGravado } from '../transcricao/transcricao.constantes';
import type {
  AtividadeDaLinhaDoTempoDto,
  LigacaoDaLinhaDoTempoDto,
  ConteudoDaLinhaDoTempo,
  EventoDaLinhaDoTempoDto,
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from './dto/linha-do-tempo.dto';
import { SELECIONAR_USUARIO_VINCULADO } from './relacoes';

export type EntidadeDaLinhaDoTempo = 'contato' | 'empresa' | 'negocio';

/** Texto com cara de UUID (a coluna `entidade_id` da auditoria é texto livre). */
const PADRAO_UUID =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** `negocio:<uuid>` em `eventos_auditoria.relacionados`. */
const PADRAO_REFERENCIA_DE_NEGOCIO =
  '^negocio:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

interface LinhaDoIndice {
  tipo: 'evento' | 'atividade' | 'ligacao';
  evento_id: bigint | null;
  atividade_id: string | null;
  ligacao_id: string | null;
  ocorrido_em: Date;
}

const INCLUIR_NA_ATIVIDADE = {
  responsavel: { select: SELECIONAR_USUARIO_VINCULADO },
  criadoPor: { select: SELECIONAR_USUARIO_VINCULADO },
} as const satisfies Prisma.AtividadeInclude;

type AtividadeComRelacoes = Prisma.AtividadeGetPayload<{
  include: typeof INCLUIR_NA_ATIVIDADE;
}>;

/**
 * Linha do tempo de um contato, de uma empresa ou de um negócio (R3.5): os
 * eventos de auditoria ligados a ele (`relacionados`) e as atividades — no
 * contato e na empresa, as ligadas direto e as dos negócios deles; no negócio,
 * as dele —, numa só lista paginada, dos mais recentes para os mais antigos.
 * Quem chama confere antes se o usuário vê a entidade (o negócio segue a R5.9;
 * contatos e empresas todos veem).
 *
 * Quem vê o contato não vê tudo o que está ligado a ele: atividades seguem a
 * R6.4 (responsável, criador, líder da equipe, C-level e Admin) e eventos de
 * negócio seguem a R5.9 (área do funil; membro, os seus e os sem
 * responsável). O filtro vale para os itens e para o total.
 */
@Injectable()
export class LinhaDoTempoService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(
    usuario: UsuarioAutenticado,
    entidade: EntidadeDaLinhaDoTempo,
    id: string,
    filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    const acesso = await funisAcessiveis(this.prisma, usuario);
    const uniao = this.montarUniao(
      usuario,
      acesso,
      entidade,
      id,
      filtro.incluir,
    );
    const { skip, take } = paraSkipTake(filtro);
    const [linhas, contagem] = await Promise.all([
      this.prisma.$queryRaw<LinhaDoIndice[]>`
        SELECT tipo, evento_id, atividade_id, ligacao_id, ocorrido_em
          FROM (${uniao}) AS itens
         ORDER BY ocorrido_em DESC, tipo ASC,
                  evento_id DESC NULLS LAST, atividade_id DESC NULLS LAST,
                  ligacao_id DESC NULLS LAST
         LIMIT ${take}::int OFFSET ${skip}::int`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM (${uniao}) AS itens`,
    ]);
    const itens = await this.hidratar(linhas, acesso);
    return montarPagina(itens, contagem[0]?.total ?? 0, filtro);
  }

  private montarUniao(
    usuario: UsuarioAutenticado,
    acesso: AcessoAosFunis,
    entidade: EntidadeDaLinhaDoTempo,
    id: string,
    incluir: ConteudoDaLinhaDoTempo,
  ): Prisma.Sql {
    const ramos: Prisma.Sql[] = [];
    const so = (conteudo: ConteudoDaLinhaDoTempo): boolean =>
      incluir === 'tudo' || incluir === conteudo;
    if (so('eventos')) {
      ramos.push(Prisma.sql`
        SELECT 'evento'::text AS tipo, e.id AS evento_id, NULL::uuid AS atividade_id,
               NULL::uuid AS ligacao_id, e.criado_em AS ocorrido_em
          FROM eventos_auditoria e
         WHERE e.relacionados @> ARRAY[${referenciaDeAuditoria(entidade, id)}]::text[]
           AND ${this.eventoVisivel(usuario, acesso)}`);
    }
    if (so('atividades')) {
      ramos.push(Prisma.sql`
        SELECT 'atividade'::text AS tipo, NULL::bigint AS evento_id, a.id AS atividade_id,
               NULL::uuid AS ligacao_id,
               COALESCE(a.concluida_em, a.cancelada_em, a.inicio_em, a.vence_em, a.criado_em)
                 AS ocorrido_em
          FROM atividades a
         WHERE ${this.atividadesDa(entidade, id)}
           AND ${this.atividadeVisivel(usuario, Prisma.raw('a'))}
           AND NOT (a.status = 'CONCLUIDA'::status_atividade AND EXISTS (
                 SELECT 1 FROM ligacoes la WHERE la.atividade_id = a.id))`);
    }
    if (so('ligacoes') && entidade !== 'negocio') {
      const coluna =
        entidade === 'contato'
          ? Prisma.sql`l.contato_id = ${id}::uuid`
          : Prisma.sql`l.contato_id IN (SELECT ct.id FROM contatos ct WHERE ct.empresa_id = ${id}::uuid)`;
      ramos.push(Prisma.sql`
        SELECT 'ligacao'::text AS tipo, NULL::bigint AS evento_id, NULL::uuid AS atividade_id,
               l.id AS ligacao_id, COALESCE(l.encerrada_em, l.iniciada_em) AS ocorrido_em
          FROM ligacoes l
          LEFT JOIN conversas c ON c.id = l.conversa_id
          LEFT JOIN filas_atendimento f ON f.id = c.fila_id
         WHERE ${coluna} AND ${sqlLigacoesVisiveis(usuario)}`);
    }
    if (ramos.length === 0) {
      ramos.push(Prisma.sql`
        SELECT 'evento'::text AS tipo, NULL::bigint AS evento_id, NULL::uuid AS atividade_id,
               NULL::uuid AS ligacao_id, now() AS ocorrido_em WHERE FALSE`);
    }
    return Prisma.join(ramos, ' UNION ALL ');
  }

  /** Atividades (`a`) da entidade: no negócio, as dele; no contato e na empresa, também as dos negócios deles. */
  private atividadesDa(
    entidade: EntidadeDaLinhaDoTempo,
    id: string,
  ): Prisma.Sql {
    if (entidade === 'negocio') {
      return Prisma.sql`a.negocio_id = ${id}::uuid`;
    }
    const coluna = Prisma.raw(
      entidade === 'contato' ? 'contato_id' : 'empresa_id',
    );
    return Prisma.sql`(a.${coluna} = ${id}::uuid
                OR a.negocio_id IN (SELECT n.id FROM negocios n WHERE n.${coluna} = ${id}::uuid))`;
  }

  /**
   * Eventos de atividade e de negócio passam pelos mesmos filtros dos itens
   * (R6.4, R5.9); e nenhum evento ligado (em `relacionados`) a um negócio que a
   * pessoa não vê aparece — ex.: o negócio criado a partir de uma conversa.
   */
  private eventoVisivel(
    usuario: UsuarioAutenticado,
    acesso: AcessoAosFunis,
  ): Prisma.Sql {
    // O fechamento da ligação aparece como entrada de ligação (só a quem a vê, R12), não como evento.
    const semFechamentoDeLigacao = Prisma.sql`NOT (e.entidade = 'ligacao' AND e.acao IN ('ligacao.encerrada', 'ligacao.perdida', 'ligacao.recusada', 'ligacao.sem_resposta', 'ligacao.falhou'))`;
    if (ehDiretoria(usuario.papel)) {
      return semFechamentoDeLigacao;
    }
    const idDaEntidade = Prisma.sql`(CASE WHEN e.entidade_id ~ ${PADRAO_UUID} THEN e.entidade_id::uuid END)`;
    return Prisma.sql`(
      ${semFechamentoDeLigacao} AND (
      e.entidade NOT IN ('negocio', 'atividade')
      OR (e.entidade = 'atividade' AND EXISTS (
            SELECT 1 FROM atividades ea
             WHERE ea.id = ${idDaEntidade}
               AND ${this.atividadeVisivel(usuario, Prisma.raw('ea'))}))
      OR (e.entidade = 'negocio' AND EXISTS (
            SELECT 1 FROM negocios en
             WHERE en.id = ${idDaEntidade}
               AND ${acesso.sqlDeNegocios(Prisma.raw('en'))}))
    ) AND NOT EXISTS (
      SELECT 1 FROM unnest(e.relacionados) AS r(ref)
        JOIN negocios rn
          ON rn.id = (CASE WHEN r.ref ~ ${PADRAO_REFERENCIA_DE_NEGOCIO}
                           THEN substr(r.ref, 9)::uuid END)
       WHERE NOT ${acesso.sqlDeNegocios(Prisma.raw('rn'))}
    ))`;
  }

  /** R6.4: responsável, criador, líder da equipe do responsável, C-level e Admin. */
  private atividadeVisivel(
    usuario: UsuarioAutenticado,
    tabela: Prisma.Sql,
  ): Prisma.Sql {
    if (ehDiretoria(usuario.papel)) {
      return Prisma.sql`TRUE`;
    }
    const minhas = Prisma.sql`${tabela}.responsavel_id = ${usuario.id}::uuid
      OR ${tabela}.criado_por_id = ${usuario.id}::uuid`;
    if (ehLider(usuario.papel)) {
      return Prisma.sql`(${minhas}
        OR ${tabela}.responsavel_id IN (
             SELECT u.id FROM usuarios u WHERE u.lider_id = ${usuario.id}::uuid))`;
    }
    return Prisma.sql`(${minhas})`;
  }

  private async hidratar(
    linhas: readonly LinhaDoIndice[],
    acesso: AcessoAosFunis,
  ): Promise<RegistroDaLinhaDoTempoDto[]> {
    const idsDeEventos = linhas.flatMap((linha) =>
      linha.evento_id === null ? [] : [linha.evento_id],
    );
    const idsDeAtividades = linhas.flatMap((linha) =>
      linha.atividade_id === null ? [] : [linha.atividade_id],
    );
    const idsDeLigacoes = linhas.flatMap((linha) =>
      linha.ligacao_id === null ? [] : [linha.ligacao_id],
    );
    const [eventos, atividades, ligacoes] = await Promise.all([
      idsDeEventos.length > 0
        ? this.prisma.eventoAuditoria.findMany({
            where: { id: { in: idsDeEventos } },
          })
        : Promise.resolve([]),
      idsDeAtividades.length > 0
        ? this.prisma.atividade.findMany({
            where: { id: { in: idsDeAtividades } },
            include: INCLUIR_NA_ATIVIDADE,
          })
        : Promise.resolve([] as AtividadeComRelacoes[]),
      idsDeLigacoes.length > 0
        ? this.prisma.ligacao.findMany({
            where: { id: { in: idsDeLigacoes } },
            include: {
              canal: { select: { id: true, nome: true } },
              atendente: { select: SELECIONAR_USUARIO_VINCULADO },
            },
          })
        : Promise.resolve([]),
    ]);
    const ligacoesPorId = new Map(ligacoes.map((l) => [l.id, l]));
    const eventosPorId = new Map(
      eventos.map((evento) => [evento.id.toString(), evento]),
    );
    const atividadesPorId = new Map(
      atividades.map((atividade) => [atividade.id, atividade]),
    );
    // A atividade que a pessoa vê (R6.4) pode ser de um negócio que ela não vê: o vínculo some (R5.9).
    const idsDeNegocios = [
      ...new Set(atividades.flatMap((a) => (a.negocioId ? [a.negocioId] : []))),
    ];
    const negociosVisiveis = new Set(
      idsDeNegocios.length > 0
        ? (
            await this.prisma.negocio.findMany({
              where: { id: { in: idsDeNegocios } },
              select: { id: true, funilId: true, responsavelId: true },
            })
          )
            .filter((negocio) => acesso.podeVerNegocio(negocio))
            .map(({ id }) => id)
        : [],
    );
    const agora = new Date();
    const registros: RegistroDaLinhaDoTempoDto[] = [];
    for (const linha of linhas) {
      const ocorridoEm = new Date(linha.ocorrido_em).toISOString();
      if (linha.evento_id !== null) {
        const evento = eventosPorId.get(linha.evento_id.toString());
        if (evento) {
          registros.push({
            tipo: 'evento',
            ocorridoEm,
            evento: this.paraEvento(evento),
            atividade: null,
            ligacao: null,
          });
        }
      } else if (linha.atividade_id !== null) {
        const atividade = atividadesPorId.get(linha.atividade_id);
        if (atividade) {
          registros.push({
            tipo: 'atividade',
            ocorridoEm,
            evento: null,
            atividade: this.paraAtividade(
              atividade,
              agora,
              atividade.negocioId !== null &&
                negociosVisiveis.has(atividade.negocioId),
            ),
            ligacao: null,
          });
        }
      } else if (linha.ligacao_id !== null) {
        const ligacao = ligacoesPorId.get(linha.ligacao_id);
        if (ligacao) {
          registros.push({
            tipo: 'ligacao',
            ocorridoEm,
            evento: null,
            atividade: null,
            ligacao: this.paraLigacao(ligacao),
          });
        }
      }
    }
    return registros;
  }

  private paraLigacao(
    ligacao: Prisma.LigacaoGetPayload<{
      include: {
        canal: { select: { id: true; nome: true } };
        atendente: { select: typeof SELECIONAR_USUARIO_VINCULADO };
      };
    }>,
  ): LigacaoDaLinhaDoTempoDto {
    const resumo = ligacao.resumo as ResumoGravado | null;
    const terminal = ESTADOS_TERMINAIS.includes(ligacao.estado);
    const pronto = ligacao.resumoSituacao === 'PRONTO' && resumo !== null;
    const trecho = pronto
      ? [...resumo.pontosPrincipais, ...resumo.combinados].join(' • ')
      : '';
    return {
      id: ligacao.id,
      direcao: ligacao.direcao,
      estado: ligacao.estado,
      resultado: terminal ? resultadoDaLigacao(ligacao.estado) : null,
      motivoTexto: textoDoMotivo(ligacao.motivo),
      duracaoSegundos: ligacao.duracaoSegundos,
      conversaId: ligacao.conversaId,
      canalId: ligacao.canal.id,
      canalNome: ligacao.canal.nome,
      atendente: ligacao.atendente
        ? UsuarioVinculadoDto.de(ligacao.atendente)
        : null,
      iniciadaEm: ligacao.iniciadaEm.toISOString(),
      encerradaEm: ligacao.encerradaEm?.toISOString() ?? null,
      resumoAssunto: pronto ? resumo.assunto : null,
      resumoTrecho: trecho ? trecho.slice(0, 240) : null,
      temGravacao:
        ligacao.gravacaoArquivoId !== null &&
        ligacao.gravacaoRemovidaEm === null &&
        ligacao.gravacaoSituacao === 'PRONTA',
      temTranscricao: ligacao.transcricaoSituacao === 'PRONTA',
    };
  }

  private paraEvento(evento: EventoAuditoria): EventoDaLinhaDoTempoDto {
    return {
      id: evento.id.toString(),
      acao: evento.acao,
      entidade: evento.entidade,
      entidadeId: evento.entidadeId,
      // Eventos antigos guardam o código da regra no resumo; a leitura o tira.
      resumo: semCodigoDeRegra(evento.resumo),
      dados: evento.dados ?? null,
      tipoAtor: evento.tipoAtor,
      usuarioId: evento.usuarioId,
      atorDescricao: evento.atorDescricao,
      criadoEm: evento.criadoEm.toISOString(),
    };
  }

  private paraAtividade(
    atividade: AtividadeComRelacoes,
    agora: Date,
    negocioVisivel: boolean,
  ): AtividadeDaLinhaDoTempoDto {
    return {
      id: atividade.id,
      tipo: atividade.tipo,
      titulo: atividade.titulo,
      descricao: atividade.descricao,
      status: atividade.status,
      prioridade: atividade.prioridade,
      // R6.3: calculado, não gravado, pela mesma regra do módulo de
      // atividades (na reunião, o prazo é o fim).
      atrasada: ehAtrasada(atividade, agora),
      venceEm: atividade.venceEm?.toISOString() ?? null,
      inicioEm: atividade.inicioEm?.toISOString() ?? null,
      fimEm: atividade.fimEm?.toISOString() ?? null,
      concluidaEm: atividade.concluidaEm?.toISOString() ?? null,
      canceladaEm: atividade.canceladaEm?.toISOString() ?? null,
      responsavel: UsuarioVinculadoDto.de(atividade.responsavel),
      criadoPor: atividade.criadoPor
        ? UsuarioVinculadoDto.de(atividade.criadoPor)
        : null,
      contatoId: atividade.contatoId,
      empresaId: atividade.empresaId,
      negocioId: negocioVisivel ? atividade.negocioId : null,
      criadoEm: atividade.criadoEm.toISOString(),
    };
  }
}
