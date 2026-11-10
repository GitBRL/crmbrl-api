import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  ehDoSetor,
  ehLiderDoSetor,
  ehMembroDoSetor,
  rotuloDaArea,
} from '../comum/dominio/papeis';
import { permissoesDoPapel } from '../comum/dominio/permissoes';
import {
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type {
  EstrategiaDistribuicao,
  Papel,
  Prisma,
  RegraDistribuicao,
} from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  atuaNoSetor,
  type FunilParaAcesso,
  podeConfigurarRodizio,
} from './acesso-funis';
import {
  type AcessosCarregados,
  acessosDoFunil,
  podeSerResponsavel,
} from './acessos-no-banco';
import type {
  AguardandoAcessoDto,
  AjusteDoRodizioDto,
  AtualizarRegraDistribuicaoDto,
  DefinirParticipacaoDto,
  MotivoAguardandoAcesso,
  MotivoNoRodizio,
  ParticipanteDoRodizioDto,
  RegraDistribuicaoDto,
} from './dto/distribuicao.dto';
import {
  motivoSemAcessoAtivado,
  ordenarParaRodizio,
  proximoDoRodizio,
} from './rodizio';
import type { Area } from '../comum/dominio/setores';

/** Ordem estável dos usuários: quem entrou primeiro no CRM primeiro. */
const ORDEM_ESTAVEL = [
  { criadoEm: 'asc' },
  { id: 'asc' },
] satisfies Prisma.UsuarioOrderByWithRelationInput[];

const DADOS_DO_CANDIDATO = {
  id: true,
  nome: true,
  avatarUrl: true,
  papel: true,
  area: true,
  criadoEm: true,
  // Para saber se já ativou o acesso e, se não, por quê (R5.8).
  acessoAtivadoEm: true,
  senhaHash: true,
} satisfies Prisma.UsuarioSelect;

type Candidato = Prisma.UsuarioGetPayload<{
  select: typeof DADOS_DO_CANDIDATO;
}>;

interface LinhaDaRegra {
  id: string;
  incluir_lideres: boolean;
  ultimo_usuario_id: string | null;
}

/**
 * Distribuição de negócios criados por automação (R5.8, R8.1).
 *
 * - `RODIZIO`: por área, entre os membros ativos que já ativaram o acesso (o
 *   líder só se a regra da área disser, ou se for incluído à mão), em ordem
 *   estável e com o ponteiro salvo na regra. A linha da regra fica travada
 *   (`SELECT … FOR UPDATE`) até o fim da transação: duas distribuições ao
 *   mesmo tempo não repetem a pessoa.
 * - `LIDER_DA_AREA`: o líder ativo da área.
 * - `RESPONSAVEL_FIXO`: a pessoa escolhida, se estiver ativa.
 *
 * Sem ninguém disponível, vai para o líder da área; sem líder, para um
 * C-level ativo; sem nenhum dos dois, fica sem responsável (`null`).
 */
@Injectable()
export class DistribuicaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /**
   * Escolhe o responsável de um negócio novo do funil (ou, sem funil, de algo
   * da `area`, como um contato), **dentro da transação que cria o negócio** (o
   * ponteiro do rodízio avança junto com ele; se a transação desfizer, o
   * ponteiro volta). Com o funil, o responsável fixo precisa atuar nele
   * (R5.13) e o rodízio de um funil `RESTRITA` fica só com quem o vê como
   * membro (os líderes e quem está na lista dele).
   *
   * ```ts
   * const responsavelId = await this.distribuicao.escolherResponsavel(tx, funil, 'RODIZIO');
   * ```
   */
  async escolherResponsavel(
    tx: Tx,
    destino: Area | FunilParaAcesso,
    estrategia: EstrategiaDistribuicao,
    responsavelFixoId?: string,
  ): Promise<string | null> {
    const funil = typeof destino === 'string' ? null : destino;
    const area = funil ? funil.area : (destino as Area);
    const acessos = funil ? await acessosDoFunil(tx, funil) : null;
    if (estrategia === 'RESPONSAVEL_FIXO') {
      if (responsavelFixoId) {
        const fixo = await tx.usuario.findUnique({
          where: { id: responsavelFixoId },
          select: { id: true, ativo: true, papel: true, area: true },
        });
        // Ativo e atuando no funil (a pessoa pode ter mudado de setor ou perdido o acesso).
        if (
          fixo &&
          (acessos
            ? podeSerResponsavel(acessos, fixo)
            : fixo.ativo && atuaNoSetor(fixo, area))
        ) {
          return fixo.id;
        }
      }
      await this.logs.aviso(
        'Distribuicao',
        `Responsável fixo ${responsavelFixoId ? 'inativo, de outro setor ou inexistente' : 'não informado'}: o negócio vai para o líder do setor ${rotuloDaArea(area)}.`,
        { area, responsavelFixoId: responsavelFixoId ?? null, regra: 'R5.8' },
      );
      return this.liderOuCLevel(tx, area);
    }
    if (estrategia === 'LIDER_DA_AREA') {
      return this.liderOuCLevel(tx, area);
    }
    return this.proximoDoRodizio(
      tx,
      area,
      acessos?.funil.visibilidade === 'RESTRITA' ? acessos : null,
    );
  }

  /**
   * O próximo da vez no rodízio da área, avançando o ponteiro (R5.8). Num
   * funil `RESTRITA`, só entra quem atua nele (R5.13).
   */
  private async proximoDoRodizio(
    tx: Tx,
    area: Area,
    restrito: AcessosCarregados | null,
  ): Promise<string | null> {
    const regra = await this.travarRegra(tx, area);
    const { candidatos: todos } = await this.candidatos(tx, area, {
      id: regra.id,
      incluirLideres: regra.incluir_lideres,
    });
    const candidatos = restrito
      ? todos.filter(({ usuario }) =>
          podeSerResponsavel(restrito, { ...usuario, ativo: true }),
        )
      : todos;
    const ponteiro = regra.ultimo_usuario_id
      ? await tx.usuario.findUnique({
          where: { id: regra.ultimo_usuario_id },
          select: { id: true, criadoEm: true },
        })
      : null;
    const escolhido = proximoDoRodizio(
      candidatos.map(({ usuario }) => usuario),
      ponteiro,
    );
    if (!escolhido) {
      return this.liderOuCLevel(tx, area);
    }
    await tx.regraDistribuicao.update({
      where: { id: regra.id },
      data: { ultimoUsuarioId: escolhido.id },
    });
    return escolhido.id;
  }

  /**
   * Trava a linha da regra da área até o fim da transação. Se a regra não
   * existir (a configuração inicial sempre cria), cria a padrão antes.
   */
  private async travarRegra(tx: Tx, area: Area): Promise<LinhaDaRegra> {
    const [existente] = await tx.$queryRaw<LinhaDaRegra[]>`
      SELECT id, incluir_lideres, ultimo_usuario_id
        FROM regras_distribuicao
       WHERE area = ${area}
         FOR UPDATE`;
    if (existente) {
      return existente;
    }
    const criadas = await tx.$executeRaw`
      INSERT INTO regras_distribuicao (id, area, incluir_lideres, criado_em, atualizado_em)
      VALUES (gen_random_uuid(), ${area}, false, now(), now())
      ON CONFLICT (area) DO NOTHING`;
    const [regra] = await tx.$queryRaw<LinhaDaRegra[]>`
      SELECT id, incluir_lideres, ultimo_usuario_id
        FROM regras_distribuicao
       WHERE area = ${area}
         FOR UPDATE`;
    if (criadas > 0) {
      await this.auditoria.registrar(tx, {
        acao: 'regra_distribuicao.criada',
        entidade: 'regra_distribuicao',
        entidadeId: regra.id,
        resumo: `Rodízio da área ${rotuloDaArea(area)} criado na primeira distribuição`,
        dados: { area, incluirLideres: false },
      });
    }
    return regra;
  }

  /**
   * Quem está no rodízio da área, em ordem: membros ativos, o líder se a regra
   * incluir líderes, os incluídos à mão (só pessoas da área) e sem os tirados
   * à mão — e, desses, só quem já ativou o acesso. Os outros vêm à parte, em
   * `aguardandoAcesso`, com o motivo (R5.8).
   */
  private async candidatos(
    tx: Tx,
    area: Area,
    regra: { id: string; incluirLideres: boolean },
  ): Promise<{
    candidatos: { usuario: Candidato; motivo: MotivoNoRodizio }[];
    aguardandoAcesso: { usuario: Candidato; motivo: MotivoAguardandoAcesso }[];
  }> {
    const ajustes = await tx.regraDistribuicaoParticipante.findMany({
      where: { regraId: regra.id },
      select: { usuarioId: true, participa: true },
    });
    const incluidos = new Set(
      ajustes.filter((ajuste) => ajuste.participa).map((a) => a.usuarioId),
    );
    const excluidos = new Set(
      ajustes.filter((ajuste) => !ajuste.participa).map((a) => a.usuarioId),
    );
    const papeisPadrao: Papel[] = regra.incluirLideres
      ? ['MEMBRO', 'LIDER']
      : ['MEMBRO'];
    const usuarios = await tx.usuario.findMany({
      where: {
        ativo: true,
        OR: [
          { area, papel: { in: papeisPadrao } },
          ...(incluidos.size > 0 ? [{ id: { in: [...incluidos] }, area }] : []),
        ],
        ...(excluidos.size > 0 ? { id: { notIn: [...excluidos] } } : {}),
      },
      orderBy: ORDEM_ESTAVEL,
      select: DADOS_DO_CANDIDATO,
    });
    const candidatos: { usuario: Candidato; motivo: MotivoNoRodizio }[] = [];
    const aguardandoAcesso: {
      usuario: Candidato;
      motivo: MotivoAguardandoAcesso;
    }[] = [];
    for (const usuario of ordenarParaRodizio(usuarios)) {
      const semAcesso = motivoSemAcessoAtivado(usuario);
      if (semAcesso) {
        aguardandoAcesso.push({ usuario, motivo: semAcesso });
        continue;
      }
      candidatos.push({
        usuario,
        motivo: ehMembroDoSetor(usuario, area)
          ? 'MEMBRO_DA_AREA'
          : regra.incluirLideres && ehLiderDoSetor(usuario, area)
            ? 'LIDER_INCLUIDO_PELA_REGRA'
            : 'INCLUIDO_MANUALMENTE',
      });
    }
    return { candidatos, aguardandoAcesso };
  }

  /** Sem ninguém no rodízio: o líder ativo da área; sem líder, um C-level ativo. */
  private async liderOuCLevel(tx: Tx, area: Area): Promise<string | null> {
    const lider = await tx.usuario.findFirst({
      where: { ativo: true, papel: 'LIDER', area },
      orderBy: ORDEM_ESTAVEL,
      select: { id: true },
    });
    if (lider) {
      return lider.id;
    }
    const cLevel = await tx.usuario.findFirst({
      where: { ativo: true, papel: 'C_LEVEL' },
      orderBy: ORDEM_ESTAVEL,
      select: { id: true },
    });
    return cLevel?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Configuração do rodízio (matriz: Admin e C-level, todas; líder, a sua área)
  // -------------------------------------------------------------------------

  async listar(usuario: UsuarioAutenticado): Promise<RegraDistribuicaoDto[]> {
    const escopo = permissoesDoPapel(usuario.papel).configurarRodizio;
    if (escopo === 'NENHUM' || (escopo === 'AREA' && !usuario.area)) {
      throw new SemPermissaoException(
        'Só o Admin, o C-level e os líderes configuram o rodízio.',
      );
    }
    // Admin e C-level: os rodízios dos setores ativos; o líder, o do seu setor.
    const regras = await this.prisma.regraDistribuicao.findMany({
      where:
        escopo === 'TODOS'
          ? { setor: { ativo: true } }
          : { area: usuario.area ?? undefined },
      orderBy: { setor: { ordem: 'asc' } },
    });
    return Promise.all(regras.map((regra) => this.montar(this.prisma, regra)));
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    area: Area,
  ): Promise<RegraDistribuicaoDto> {
    this.exigirPermissao(usuario, area);
    return this.montar(this.prisma, await this.regraDaArea(this.prisma, area));
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    area: Area,
    dto: AtualizarRegraDistribuicaoDto,
  ): Promise<RegraDistribuicaoDto> {
    this.exigirPermissao(usuario, area);
    return this.prisma.$transaction(async (tx) => {
      const antes = await this.regraDaArea(tx, area);
      const regra = await tx.regraDistribuicao.update({
        where: { id: antes.id },
        data: { incluirLideres: dto.incluirLideres },
      });
      if (antes.incluirLideres !== regra.incluirLideres) {
        await this.auditoria.registrar(tx, {
          acao: 'regra_distribuicao.atualizada',
          entidade: 'regra_distribuicao',
          entidadeId: regra.id,
          resumo: `Rodízio de ${rotuloDaArea(area)}: líderes ${regra.incluirLideres ? 'passam a participar' : 'deixam de participar'}`,
          dados: {
            area,
            alteracoes: {
              incluirLideres: {
                antes: antes.incluirLideres,
                depois: regra.incluirLideres,
              },
            },
          },
        });
      }
      return this.montar(tx, regra);
    });
  }

  /** Inclui ou tira alguém do rodízio da área (ajuste manual). */
  async definirParticipacao(
    usuario: UsuarioAutenticado,
    area: Area,
    usuarioId: string,
    dto: DefinirParticipacaoDto,
  ): Promise<RegraDistribuicaoDto> {
    this.exigirPermissao(usuario, area);
    return this.prisma.$transaction(async (tx) => {
      const regra = await this.regraDaArea(tx, area);
      const pessoa = await tx.usuario.findUnique({ where: { id: usuarioId } });
      if (!pessoa) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      if (!ehDoSetor(pessoa, area)) {
        throw new RegraVioladaException(
          'R5.8',
          `Só pessoas do setor ${rotuloDaArea(area)} (líder ou membro) participam deste rodízio.`,
          { usuarioId, papel: pessoa.papel, area },
        );
      }
      if (dto.participa && !pessoa.ativo) {
        throw new RegraVioladaException(
          'R5.8',
          'Usuário desligado não entra no rodízio.',
          { usuarioId },
        );
      }
      const anterior = await tx.regraDistribuicaoParticipante.findUnique({
        where: { regraId_usuarioId: { regraId: regra.id, usuarioId } },
      });
      await tx.regraDistribuicaoParticipante.upsert({
        where: { regraId_usuarioId: { regraId: regra.id, usuarioId } },
        create: { regraId: regra.id, usuarioId, participa: dto.participa },
        update: { participa: dto.participa },
      });
      if (anterior?.participa !== dto.participa) {
        await this.auditoria.registrar(tx, {
          acao: 'regra_distribuicao.participante_definido',
          entidade: 'regra_distribuicao',
          entidadeId: regra.id,
          resumo: `${pessoa.nome} ${dto.participa ? 'incluído(a) no' : 'tirado(a) do'} rodízio de ${rotuloDaArea(area)}`,
          dados: {
            area,
            usuarioId,
            alteracoes: {
              participa: {
                antes: anterior ? anterior.participa : null,
                depois: dto.participa,
              },
            },
          },
          relacionados: { usuario: usuarioId },
        });
      }
      return this.montar(tx, regra);
    });
  }

  /** Desfaz o ajuste manual: a pessoa volta a seguir a regra da área. */
  async removerAjuste(
    usuario: UsuarioAutenticado,
    area: Area,
    usuarioId: string,
  ): Promise<RegraDistribuicaoDto> {
    this.exigirPermissao(usuario, area);
    return this.prisma.$transaction(async (tx) => {
      const regra = await this.regraDaArea(tx, area);
      const ajuste = await tx.regraDistribuicaoParticipante.findUnique({
        where: { regraId_usuarioId: { regraId: regra.id, usuarioId } },
        include: { usuario: { select: { nome: true } } },
      });
      if (!ajuste) {
        throw new NaoEncontradoException(
          'Essa pessoa não tem ajuste manual neste rodízio.',
        );
      }
      await tx.regraDistribuicaoParticipante.delete({
        where: { id: ajuste.id },
      });
      await this.auditoria.registrar(tx, {
        acao: 'regra_distribuicao.participante_removido',
        entidade: 'regra_distribuicao',
        entidadeId: regra.id,
        resumo: `Ajuste manual de ${ajuste.usuario.nome} removido do rodízio de ${rotuloDaArea(area)}`,
        dados: { area, usuarioId, participava: ajuste.participa },
        relacionados: { usuario: usuarioId },
      });
      return this.montar(tx, regra);
    });
  }

  private exigirPermissao(usuario: UsuarioAutenticado, area: Area): void {
    if (!podeConfigurarRodizio(usuario, area)) {
      throw new SemPermissaoException(
        `Você não pode configurar o rodízio de ${rotuloDaArea(area)}.`,
      );
    }
  }

  private async regraDaArea(tx: Tx, area: Area): Promise<RegraDistribuicao> {
    const regra = await tx.regraDistribuicao.findUnique({ where: { area } });
    if (regra) {
      return regra;
    }
    // A configuração inicial cria uma por área; se faltar, nasce a padrão.
    await this.travarRegra(tx, area);
    return tx.regraDistribuicao.findUniqueOrThrow({ where: { area } });
  }

  /** A regra como a tela mostra: participantes em ordem, ajustes e o próximo da vez. */
  private async montar(
    tx: Tx,
    regra: RegraDistribuicao,
  ): Promise<RegraDistribuicaoDto> {
    // Em sequência: `tx` pode ser uma transação (uma conexão só).
    const { candidatos, aguardandoAcesso } = await this.candidatos(
      tx,
      regra.area,
      regra,
    );
    const ajustes = await tx.regraDistribuicaoParticipante.findMany({
      where: { regraId: regra.id },
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            avatarUrl: true,
            papel: true,
            ativo: true,
          },
        },
      },
      orderBy: { criadoEm: 'asc' },
    });
    const ultimo = regra.ultimoUsuarioId
      ? await tx.usuario.findUnique({
          where: { id: regra.ultimoUsuarioId },
          select: { id: true, nome: true, avatarUrl: true, criadoEm: true },
        })
      : null;
    const participantes: ParticipanteDoRodizioDto[] = candidatos.map(
      ({ usuario, motivo }) => ({
        id: usuario.id,
        nome: usuario.nome,
        avatarUrl: usuario.avatarUrl,
        papel: usuario.papel,
        motivo,
      }),
    );
    const daVez = proximoDoRodizio(
      candidatos.map(({ usuario }) => usuario),
      ultimo,
    );
    const reservaId = daVez ? null : await this.liderOuCLevel(tx, regra.area);
    const proximo = daVez
      ? { id: daVez.id, nome: daVez.nome, avatarUrl: daVez.avatarUrl }
      : reservaId
        ? await tx.usuario.findUnique({
            where: { id: reservaId },
            select: { id: true, nome: true, avatarUrl: true },
          })
        : null;
    const listaDeAjustes: AjusteDoRodizioDto[] = ajustes.map((ajuste) => ({
      id: ajuste.usuario.id,
      nome: ajuste.usuario.nome,
      avatarUrl: ajuste.usuario.avatarUrl,
      papel: ajuste.usuario.papel,
      ativo: ajuste.usuario.ativo,
      participa: ajuste.participa,
    }));
    return {
      id: regra.id,
      area: regra.area,
      incluirLideres: regra.incluirLideres,
      ultimoUsuario: ultimo
        ? { id: ultimo.id, nome: ultimo.nome, avatarUrl: ultimo.avatarUrl }
        : null,
      proximo,
      participantes,
      ajustes: listaDeAjustes,
      aguardandoAcesso: aguardandoAcesso.map(
        ({ usuario, motivo }): AguardandoAcessoDto => ({
          id: usuario.id,
          nome: usuario.nome,
          avatarUrl: usuario.avatarUrl,
          papel: usuario.papel,
          motivo,
        }),
      ),
      atualizadoEm: regra.atualizadoEm.toISOString(),
    };
  }
}
