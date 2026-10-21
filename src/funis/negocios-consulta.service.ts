import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { formatarValor } from '../comum/dominio/dinheiro';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { NaoEncontradoException } from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { Prisma } from '../generated/prisma/client';
import type {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from '../contatos/dto/linha-do-tempo.dto';
import { LinhaDoTempoService } from '../contatos/linha-do-tempo.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  filtroDeNegociosVisiveis,
  podeVerArea,
  podeVerNegocio,
} from './acesso-funis';
import { EtapaDto } from './dto/funis.dto';
import {
  type FiltroBaseNegociosDto,
  type FiltroNegociosDto,
  MovimentacaoDto,
  NegocioDto,
} from './dto/negocios.dto';
import type { FiltroQuadroDto, QuadroDto } from './dto/quadro.dto';
import {
  INCLUIR_MOVIMENTACAO,
  INCLUIR_NEGOCIO,
  limiteDeParado,
} from './negocio-completo';

/** Ordem dos cartões no kanban: posição e, no empate, o id. */
const ORDEM_DO_QUADRO = [
  { posicao: 'asc' },
  { id: 'asc' },
] satisfies Prisma.NegocioOrderByWithRelationInput[];

/**
 * Consultas de negócios: lista paginada, quadro kanban por funil e histórico
 * de movimentação. Toda consulta aplica a visibilidade do papel (R5.9) antes
 * dos filtros (visão, busca, etiqueta, responsável).
 */
@Injectable()
export class NegociosConsultaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly linhaDoTempoService: LinhaDoTempoService,
  ) {}

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroNegociosDto,
  ): Promise<Pagina<NegocioDto>> {
    const agora = new Date();
    const condicoes = await this.condicoes(usuario, filtro);
    if (filtro.funilId) {
      condicoes.push({ funilId: filtro.funilId });
    }
    if (filtro.etapaId) {
      condicoes.push({ etapaId: filtro.etapaId });
    }
    if (filtro.status) {
      condicoes.push({ status: filtro.status });
    }
    if (filtro.contatoId) {
      condicoes.push({ contatoId: filtro.contatoId });
    }
    if (filtro.empresaId) {
      condicoes.push({ empresaId: filtro.empresaId });
    }
    if (filtro.parados) {
      condicoes.push(await this.condicaoDeParados(agora, filtro.funilId));
    }
    const where: Prisma.NegocioWhereInput = { AND: condicoes };
    const ordem: Prisma.NegocioOrderByWithRelationInput =
      filtro.ordenarPor === 'previsaoFechamento'
        ? { previsaoFechamento: { sort: filtro.direcao, nulls: 'last' } }
        : { [filtro.ordenarPor]: filtro.direcao };
    const [itens, total] = await Promise.all([
      this.prisma.negocio.findMany({
        where,
        include: INCLUIR_NEGOCIO,
        orderBy: [ordem, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.negocio.count({ where }),
    ]);
    return montarPagina(
      itens.map((negocio) => NegocioDto.de(negocio, agora)),
      total,
      filtro,
    );
  }

  /**
   * Quadro kanban de um funil: as etapas em ordem, cada uma com o total, a soma
   * dos valores, os parados e até `limitePorEtapa` cartões em ordem de posição.
   */
  async quadro(
    usuario: UsuarioAutenticado,
    funilId: string,
    filtro: FiltroQuadroDto,
  ): Promise<QuadroDto> {
    const funil = await this.prisma.funil.findFirst({
      where: { id: funilId, excluidoEm: null },
      include: { etapas: { orderBy: [{ ordem: 'asc' }, { criadoEm: 'asc' }] } },
    });
    if (!funil || !podeVerArea(usuario, funil.area)) {
      throw new NaoEncontradoException('Funil não encontrado.');
    }
    const agora = new Date();
    const condicoes = await this.condicoes(usuario, filtro);
    condicoes.push({ funilId: funil.id });
    const where: Prisma.NegocioWhereInput = { AND: condicoes };
    const totais = await this.prisma.negocio.groupBy({
      by: ['etapaId'],
      where,
      _count: { _all: true },
      _sum: { valor: true },
    });
    const totalPorEtapa = new Map(
      totais.map((linha) => [linha.etapaId, linha]),
    );
    const colunas = await Promise.all(
      funil.etapas.map(async (etapa) => {
        const naEtapa: Prisma.NegocioWhereInput = {
          AND: [...condicoes, { etapaId: etapa.id }],
        };
        const [cartoes, parados] = await Promise.all([
          this.prisma.negocio.findMany({
            where: naEtapa,
            include: INCLUIR_NEGOCIO,
            orderBy: ORDEM_DO_QUADRO,
            take: filtro.limitePorEtapa + 1,
          }),
          etapa.tipo === 'ABERTA' && etapa.prazoDias !== null
            ? this.prisma.negocio.count({
                where: {
                  AND: [
                    ...condicoes,
                    {
                      etapaId: etapa.id,
                      status: 'ABERTO',
                      etapaDesde: {
                        lt: limiteDeParado(etapa.prazoDias, agora),
                      },
                    },
                  ],
                },
              })
            : Promise.resolve(0),
        ]);
        const total = totalPorEtapa.get(etapa.id);
        return {
          etapa: EtapaDto.de(etapa),
          total: total?._count._all ?? 0,
          valorTotal: formatarValor(total?._sum.valor ?? 0) ?? '0.00',
          parados,
          negocios: cartoes
            .slice(0, filtro.limitePorEtapa)
            .map((negocio) => NegocioDto.de(negocio, agora)),
          temMais: cartoes.length > filtro.limitePorEtapa,
        };
      }),
    );
    const valorTotal = totais.reduce(
      (soma, linha) => soma.add(linha._sum.valor ?? 0),
      new Prisma.Decimal(0),
    );
    return {
      funil: { id: funil.id, nome: funil.nome, area: funil.area },
      ativo: funil.ativo,
      colunas,
      total: totais.reduce((soma, linha) => soma + linha._count._all, 0),
      valorTotal: formatarValor(valorTotal) ?? '0.00',
    };
  }

  /** Histórico de movimentação do negócio (R5.4), do mais antigo ao mais novo. */
  async movimentacoes(
    usuario: UsuarioAutenticado,
    negocioId: string,
  ): Promise<MovimentacaoDto[]> {
    await this.exigirVisivel(usuario, negocioId);
    const movimentacoes = await this.prisma.negocioMovimentacao.findMany({
      where: { negocioId },
      include: INCLUIR_MOVIMENTACAO,
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
    return movimentacoes.map((movimentacao) =>
      MovimentacaoDto.de(movimentacao),
    );
  }

  /**
   * Linha do tempo do negócio (R3.5): os eventos de auditoria ligados a ele e
   * as atividades dele, com a mesma regra da linha do tempo de contatos e
   * empresas (atividades pela R6.4, eventos de outros negócios pela R5.9).
   */
  async linhaDoTempo(
    usuario: UsuarioAutenticado,
    negocioId: string,
    filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    await this.exigirVisivel(usuario, negocioId);
    return this.linhaDoTempoService.listar(
      usuario,
      'negocio',
      negocioId,
      filtro,
    );
  }

  /** 404 para negócio inexistente, excluído ou fora do que o papel vê (R5.9). */
  private async exigirVisivel(
    usuario: UsuarioAutenticado,
    negocioId: string,
  ): Promise<void> {
    const negocio = await this.prisma.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      select: {
        id: true,
        responsavelId: true,
        funil: { select: { area: true } },
      },
    });
    if (!negocio || !podeVerNegocio(usuario, negocio)) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
  }

  // -------------------------------------------------------------------------
  // Filtros
  // -------------------------------------------------------------------------

  /** Condições (para `AND`) de visibilidade (R5.9) e dos filtros comuns. */
  private async condicoes(
    usuario: UsuarioAutenticado,
    filtro: FiltroBaseNegociosDto,
  ): Promise<Prisma.NegocioWhereInput[]> {
    const condicoes: Prisma.NegocioWhereInput[] = [
      { excluidoEm: null },
      { funil: { excluidoEm: null } },
      filtroDeNegociosVisiveis(usuario),
    ];
    if (filtro.visao === 'MEUS') {
      condicoes.push({ responsavelId: usuario.id });
    } else if (filtro.visao === 'EQUIPE') {
      condicoes.push({
        responsavelId: { in: await this.idsDaEquipe(usuario.id) },
      });
    }
    if (filtro.responsavelId) {
      condicoes.push({ responsavelId: filtro.responsavelId });
    }
    if (filtro.semResponsavel === true) {
      condicoes.push({ responsavelId: null });
    } else if (filtro.semResponsavel === false) {
      condicoes.push({ responsavelId: { not: null } });
    }
    if (filtro.busca) {
      condicoes.push(this.condicaoDeBusca(filtro.busca));
    }
    if (filtro.etiqueta) {
      condicoes.push(await this.condicaoDeEtiqueta(filtro.etiqueta));
    }
    return condicoes;
  }

  /** Eu, meus liderados diretos e os liderados deles (líder → membros; C-level → líderes → membros). */
  private async idsDaEquipe(usuarioId: string): Promise<string[]> {
    const liderados = await this.prisma.usuario.findMany({
      where: {
        OR: [{ liderId: usuarioId }, { lider: { liderId: usuarioId } }],
      },
      select: { id: true },
    });
    return [usuarioId, ...liderados.map(({ id }) => id)];
  }

  private condicaoDeBusca(busca: string): Prisma.NegocioWhereInput {
    const texto = busca.trim();
    if (!texto) {
      return {};
    }
    const contem = { contains: texto, mode: 'insensitive' } as const;
    const alternativas: Prisma.NegocioWhereInput[] = [
      { titulo: contem },
      { contato: { nome: contem } },
      { contato: { email: contem } },
      { empresa: { nome: contem } },
    ];
    const digitos = texto.replace(/\D/g, '');
    if (digitos.length >= 4) {
      alternativas.push({ contato: { telefone: { contains: digitos } } });
    }
    return { OR: alternativas };
  }

  /**
   * Etiqueta do contato ou da empresa do negócio, sem diferenciar maiúsculas
   * (as etiquetas guardam a grafia de quem criou, R4.7).
   */
  private async condicaoDeEtiqueta(
    etiqueta: string,
  ): Promise<Prisma.NegocioWhereInput> {
    const [normalizada] = normalizarEtiquetas([etiqueta]);
    if (!normalizada) {
      return {};
    }
    const [contatos, empresas] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contatos
         WHERE EXISTS (SELECT 1 FROM unnest(etiquetas) AS e WHERE lower(e) = lower(${normalizada}))`,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM empresas
         WHERE EXISTS (SELECT 1 FROM unnest(etiquetas) AS e WHERE lower(e) = lower(${normalizada}))`,
    ]);
    return {
      OR: [
        { contatoId: { in: contatos.map(({ id }) => id) } },
        { empresaId: { in: empresas.map(({ id }) => id) } },
      ],
    };
  }

  /** Abertos há mais tempo na etapa que o prazo-alvo dela (R5.10). */
  private async condicaoDeParados(
    agora: Date,
    funilId?: string,
  ): Promise<Prisma.NegocioWhereInput> {
    const etapas = await this.prisma.etapa.findMany({
      where: {
        tipo: 'ABERTA',
        prazoDias: { not: null },
        ...(funilId ? { funilId } : {}),
      },
      select: { id: true, prazoDias: true },
    });
    if (etapas.length === 0) {
      return { id: { in: [] } };
    }
    return {
      status: 'ABERTO',
      OR: etapas.map((etapa) => ({
        etapaId: etapa.id,
        etapaDesde: { lt: limiteDeParado(etapa.prazoDias as number, agora) },
      })),
    };
  }
}
