import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria } from '../comum/dominio/papeis';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CATEGORIAS_DE_PASSAGEM } from '../sdr/categoria-passagem';
import type {
  CelulaBi,
  ConteudoDoPainel,
  FiltroResolvido,
  TabelaBi,
} from './bi.tipos';
import {
  type DefinicaoDeCartao,
  montarCartoes,
  numero,
  tabela,
  type Valores,
} from './cartoes';
import { sqlConversasVisiveis, sqlPessoas, VERDADEIRO } from './escopo-bi';
import { diasDoIntervalo, percentual } from './periodo';
import { FUSO_DO_BI } from './bi.constantes';

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'atendidas',
    rotulo: 'Conversas atendidas pela IA',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Conversas que a IA (SDR) assumiu no período.',
  },
  {
    chave: 'qualificadas',
    rotulo: 'Qualificadas',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Leads que a IA qualificou e passou ao Comercial no período.',
  },
  {
    chave: 'desqualificadas',
    rotulo: 'Desqualificadas',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Leads que a IA desqualificou no período.',
  },
  {
    chave: 'passadas',
    rotulo: 'Passadas para a equipe',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Conversas que a IA passou para uma pessoa no período (o motivo está na tabela "Passagens por motivo").',
  },
  {
    chave: 'primeiraResposta',
    rotulo: 'Primeira resposta da IA (média)',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Tempo médio entre o início da conversa e a primeira resposta da IA, nas conversas atendidas no modo automático.',
  },
  {
    chave: 'primeiraRespostaMediana',
    rotulo: 'Primeira resposta da IA (mediana)',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Metade das conversas foi respondida pela IA em menos que isto.',
  },
  {
    chave: 'negociosGanhos',
    rotulo: 'Qualificadas que viraram negócio ganho',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Leads qualificados no período cujo negócio no Comercial está ganho hoje.',
  },
  {
    chave: 'conversao',
    rotulo: 'Conversão para o Comercial',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Qualificadas do período cujo negócio foi ganho, sobre o total de qualificadas. Sem qualificadas, não há valor.',
  },
  {
    chave: 'emAtendimento',
    rotulo: 'IA atendendo agora',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Conversas em que a IA está atendendo neste momento.',
  },
  {
    chave: 'tokens',
    rotulo: 'Tokens gastos',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Tokens de entrada, saída e cache gastos pela IA no período (o simulador não conta). Só Admin e C-level veem.',
  },
  {
    chave: 'tokensPorConversa',
    rotulo: 'Tokens por conversa atendida',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Tokens gastos no período divididos pelas conversas em que a IA agiu. Só Admin e C-level veem.',
  },
];

/** Cartões que só a diretoria vê (o custo da IA é assunto de configuração). */
const SO_DIRETORIA: ReadonlySet<string> = new Set([
  'tokens',
  'tokensPorConversa',
]);
const DE_AGORA: ReadonlySet<string> = new Set(['emAtendimento']);

interface LinhaDeEventos {
  chave: string | null;
  qualificadas: number;
  desqualificadas: number;
  passadas: number;
  conversas_com_acao: number;
  tokens_entrada: number;
  tokens_saida: number;
  tokens_cache_leitura: number;
  tokens_cache_escrita: number;
  ganhos: number;
}

interface LinhaDeAtendidas {
  chave: string | null;
  atendidas: number;
  primeira_media: number | null;
  primeira_mediana: number | null;
}

type Contagens = Omit<LinhaDeEventos, 'chave'> &
  Omit<LinhaDeAtendidas, 'chave'>;

const SEM_EVENTOS: Omit<LinhaDeEventos, 'chave'> = {
  qualificadas: 0,
  desqualificadas: 0,
  passadas: 0,
  conversas_com_acao: 0,
  tokens_entrada: 0,
  tokens_saida: 0,
  tokens_cache_leitura: 0,
  tokens_cache_escrita: 0,
  ganhos: 0,
};

const SEM_ATENDIDAS: Omit<LinhaDeAtendidas, 'chave'> = {
  atendidas: 0,
  primeira_media: null,
  primeira_mediana: null,
};

function totalDeTokens(l: LinhaDeEventos | Contagens): number {
  return (
    l.tokens_entrada +
    l.tokens_saida +
    l.tokens_cache_leitura +
    l.tokens_cache_escrita
  );
}

/**
 * Painel SDR com IA (R20, R31.22): conversas atendidas, qualificadas,
 * desqualificadas e passadas para a equipe (por motivo), primeira resposta da
 * IA, conversão para o Comercial e custo em tokens, por canal e por dia.
 * Visibilidade: a das conversas (R12) — como o Atendimento, o Marketing não vê o
 * painel. O custo em tokens só aparece para Admin e C-level.
 *
 * Contagem: "atendidas" pelo início da atuação da IA; qualificadas,
 * desqualificadas e passadas pelo dia da decisão (registro de decisões);
 * tokens pelo dia de cada turno. Turnos do simulador não entram.
 */
@Injectable()
export class PainelSdrService {
  constructor(private readonly prisma: PrismaService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const base = this.condicoes(usuario, filtro);
    const custo = ehDiretoria(usuario.papel);
    const [atual, agora] = await Promise.all([
      this.valoresDoPeriodo(base, filtro.de, filtro.ate),
      this.valoresDeAgora(base),
    ]);
    const anterior =
      filtro.anteriorDe && filtro.anteriorAte
        ? await this.valoresDoPeriodo(
            base,
            filtro.anteriorDe,
            filtro.anteriorAte,
          )
        : null;
    const [porCanal, porDia, passagensPorMotivo] = await Promise.all([
      this.porCanal(base, filtro, custo),
      this.porDia(base, filtro, custo),
      this.passagensPorMotivo(base, filtro),
    ]);
    const cartoes = montarCartoes(
      CARTOES,
      { ...atual, ...agora },
      anterior,
      DE_AGORA,
    ).filter((c) => custo || !SO_DIRETORIA.has(c.chave));
    return {
      cartoes,
      tabelas: { porCanal, porDia, passagensPorMotivo },
      meta: { custoEmTokens: custo },
    };
  }

  /** Conversas `c` (filas `f`) que o usuário vê, com os filtros do painel. */
  private condicoes(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`${sqlConversasVisiveis(usuario)}
      AND ${filtro.area ? Prisma.sql`f.area = ${filtro.area}::area` : VERDADEIRO}
      AND ${sqlPessoas(Prisma.sql`c.responsavel_id`, filtro.pessoas)}
      AND ${filtro.canalId ? Prisma.sql`c.canal_id = ${filtro.canalId}::uuid` : VERDADEIRO}
      AND ${filtro.filaId ? Prisma.sql`c.fila_id = ${filtro.filaId}::uuid` : VERDADEIRO}`;
  }

  /** Eventos (decisões) do período, agrupados por `chave`. */
  private eventos(
    chave: Prisma.Sql,
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<LinhaDeEventos[]> {
    return this.prisma.$queryRaw<LinhaDeEventos[]>(Prisma.sql`
      SELECT ${chave} AS chave,
        (count(*) FILTER (WHERE d.tipo = 'QUALIFICADO'::tipo_decisao_sdr))::int AS qualificadas,
        (count(*) FILTER (WHERE d.tipo = 'DESQUALIFICADO'::tipo_decisao_sdr))::int AS desqualificadas,
        (count(*) FILTER (WHERE d.categoria IS NOT NULL))::int AS passadas,
        (count(DISTINCT d.conversa_id) FILTER (WHERE d.tipo IN ('TURNO'::tipo_decisao_sdr, 'QUALIFICADO'::tipo_decisao_sdr, 'DESQUALIFICADO'::tipo_decisao_sdr)))::int AS conversas_com_acao,
        (coalesce(sum(d.tokens_entrada), 0))::int AS tokens_entrada,
        (coalesce(sum(d.tokens_saida), 0))::int AS tokens_saida,
        (coalesce(sum(d.tokens_cache_leitura), 0))::int AS tokens_cache_leitura,
        (coalesce(sum(d.tokens_cache_escrita), 0))::int AS tokens_cache_escrita,
        (count(*) FILTER (WHERE d.tipo = 'QUALIFICADO'::tipo_decisao_sdr AND n.status = 'GANHO'::status_negocio))::int AS ganhos
      FROM sdr_decisoes d
        JOIN conversas c ON c.id = d.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        LEFT JOIN sdr_conversas s ON s.conversa_id = d.conversa_id
        LEFT JOIN negocios n ON n.id = s.negocio_id AND n.excluido_em IS NULL
      WHERE d.simulador = false AND d.criado_em >= ${de} AND d.criado_em < ${ate}
        AND ${base}
      GROUP BY 1`);
  }

  /** Conversas que a IA assumiu no período, agrupadas por `chave`. */
  private atendidas(
    chave: Prisma.Sql,
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<LinhaDeAtendidas[]> {
    const tempo = Prisma.sql`extract(epoch FROM s.primeira_resposta_em - c.criado_em)`;
    return this.prisma.$queryRaw<LinhaDeAtendidas[]>(Prisma.sql`
      SELECT ${chave} AS chave,
        (count(*))::int AS atendidas,
        (avg(${tempo}) FILTER (WHERE s.primeira_resposta_em IS NOT NULL))::float AS primeira_media,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${tempo}) FILTER (WHERE s.primeira_resposta_em IS NOT NULL))::float AS primeira_mediana
      FROM sdr_conversas s
        JOIN conversas c ON c.id = s.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE s.criado_em >= ${de} AND s.criado_em < ${ate} AND ${base}
      GROUP BY 1`);
  }

  private async valoresDoPeriodo(
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [[e], [a]] = await Promise.all([
      this.eventos(Prisma.sql`NULL::uuid`, base, de, ate),
      this.atendidas(Prisma.sql`NULL::uuid`, base, de, ate),
    ]);
    return valores({ ...SEM_EVENTOS, ...SEM_ATENDIDAS, ...e, ...a });
  }

  private async valoresDeAgora(base: Prisma.Sql): Promise<Valores> {
    const [linha] = await this.prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total
      FROM sdr_conversas s
        JOIN conversas c ON c.id = s.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE s.situacao = 'ATIVA'::situacao_sdr AND c.status <> 'RESOLVIDA'::status_conversa AND ${base}`);
    return { emAtendimento: linha?.total ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Tabelas
  // -------------------------------------------------------------------------

  private async porCanal(
    base: Prisma.Sql,
    filtro: FiltroResolvido,
    custo: boolean,
  ): Promise<TabelaBi> {
    const [eventos, atendidas] = await Promise.all([
      this.eventos(Prisma.sql`c.canal_id`, base, filtro.de, filtro.ate),
      this.atendidas(Prisma.sql`c.canal_id`, base, filtro.de, filtro.ate),
    ]);
    const ids = [
      ...new Set(
        [...eventos, ...atendidas]
          .map((l) => l.chave)
          .filter((id): id is string => !!id),
      ),
    ];
    const canais = ids.length
      ? await this.prisma.canal.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            nome: true,
            tipo: true,
            sdr: { select: { modo: true } },
          },
        })
      : [];
    const porId = new Map(canais.map((c) => [c.id, c]));
    const eventosPorCanal = new Map(eventos.map((l) => [l.chave, l]));
    const atendidasPorCanal = new Map(atendidas.map((l) => [l.chave, l]));
    const linhas = ids
      .map((id): Record<string, CelulaBi> => {
        const canal = porId.get(id);
        const v = valores({
          ...SEM_EVENTOS,
          ...SEM_ATENDIDAS,
          ...eventosPorCanal.get(id),
          ...atendidasPorCanal.get(id),
        });
        return {
          id,
          nome: canal?.nome ?? 'Canal removido',
          tipo: canal?.tipo ?? null,
          modo: canal?.sdr?.modo ?? 'DESLIGADO',
          atendidas: v.atendidas,
          qualificadas: v.qualificadas,
          desqualificadas: v.desqualificadas,
          passadas: v.passadas,
          primeiraResposta: v.primeiraResposta,
          negociosGanhos: v.negociosGanhos,
          conversao: v.conversao,
          ...(custo
            ? { tokens: v.tokens, tokensPorConversa: v.tokensPorConversa }
            : {}),
        };
      })
      .sort(
        (a, b) =>
          Number(b.atendidas) - Number(a.atendidas) ||
          String(a.nome).localeCompare(String(b.nome), 'pt-BR'),
      );
    return tabela(
      'porCanal',
      'SDR por canal',
      'Atendidas, qualificadas, desqualificadas, passadas para a equipe, primeira resposta, conversão e tokens de cada canal no período. "Modo" é o ajuste atual do canal.',
      [
        ['id', 'Canal', 'id'],
        ['nome', 'Canal', 'texto'],
        ['tipo', 'Tipo', 'texto'],
        ['modo', 'Modo do SDR', 'texto'],
        ['atendidas', 'Atendidas', 'numero'],
        ['qualificadas', 'Qualificadas', 'numero'],
        ['desqualificadas', 'Desqualificadas', 'numero'],
        ['passadas', 'Passadas para a equipe', 'numero'],
        ['primeiraResposta', 'Primeira resposta da IA (média)', 'segundos'],
        ['negociosGanhos', 'Viraram negócio ganho', 'numero'],
        ['conversao', 'Conversão para o Comercial', 'percentual'],
        ...(custo
          ? ([
              ['tokens', 'Tokens', 'numero'],
              ['tokensPorConversa', 'Tokens por conversa', 'numero'],
            ] as const)
          : []),
      ],
      linhas,
    );
  }

  private async porDia(
    base: Prisma.Sql,
    filtro: FiltroResolvido,
    custo: boolean,
  ): Promise<TabelaBi> {
    const { de, ate } = filtro;
    const dia = (coluna: Prisma.Sql) =>
      Prisma.sql`to_char(${coluna} AT TIME ZONE ${FUSO_DO_BI}, 'YYYY-MM-DD')`;
    const [eventos, atendidas] = await Promise.all([
      this.prisma.$queryRaw<
        (Omit<LinhaDeEventos, 'chave'> & { dia: string })[]
      >(Prisma.sql`
        SELECT ${dia(Prisma.sql`d.criado_em`)} AS dia,
          (count(*) FILTER (WHERE d.tipo = 'QUALIFICADO'::tipo_decisao_sdr))::int AS qualificadas,
          (count(*) FILTER (WHERE d.tipo = 'DESQUALIFICADO'::tipo_decisao_sdr))::int AS desqualificadas,
          (count(*) FILTER (WHERE d.categoria IS NOT NULL))::int AS passadas,
          (coalesce(sum(d.tokens_entrada), 0))::int AS tokens_entrada,
          (coalesce(sum(d.tokens_saida), 0))::int AS tokens_saida,
          (coalesce(sum(d.tokens_cache_leitura), 0))::int AS tokens_cache_leitura,
          (coalesce(sum(d.tokens_cache_escrita), 0))::int AS tokens_cache_escrita
        FROM sdr_decisoes d
          JOIN conversas c ON c.id = d.conversa_id
          LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE d.simulador = false AND d.criado_em >= ${de} AND d.criado_em < ${ate} AND ${base}
        GROUP BY 1`),
      this.prisma.$queryRaw<{ dia: string; atendidas: number }[]>(Prisma.sql`
        SELECT ${dia(Prisma.sql`s.criado_em`)} AS dia, count(*)::int AS atendidas
        FROM sdr_conversas s
          JOIN conversas c ON c.id = s.conversa_id
          LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE s.criado_em >= ${de} AND s.criado_em < ${ate} AND ${base}
        GROUP BY 1`),
    ]);
    const porEvento = new Map(eventos.map((l) => [l.dia, l]));
    const porAtendida = new Map(atendidas.map((l) => [l.dia, l.atendidas]));
    return tabela(
      'porDia',
      'SDR por dia',
      'Conversas atendidas, qualificadas, desqualificadas e passadas para a equipe por dia (fuso de Brasília)' +
        (custo ? ', e tokens gastos.' : '.'),
      [
        ['dia', 'Dia', 'data'],
        ['atendidas', 'Atendidas', 'numero'],
        ['qualificadas', 'Qualificadas', 'numero'],
        ['desqualificadas', 'Desqualificadas', 'numero'],
        ['passadas', 'Passadas para a equipe', 'numero'],
        ...(custo ? ([['tokens', 'Tokens', 'numero']] as const) : []),
      ],
      diasDoIntervalo(de, ate).map((d): Record<string, CelulaBi> => {
        const e = porEvento.get(d);
        return {
          dia: d,
          atendidas: porAtendida.get(d) ?? 0,
          qualificadas: e?.qualificadas ?? 0,
          desqualificadas: e?.desqualificadas ?? 0,
          passadas: e?.passadas ?? 0,
          ...(custo
            ? { tokens: e ? totalDeTokens({ ...SEM_ATENDIDAS, ...e }) : 0 }
            : {}),
        };
      }),
    );
  }

  private async passagensPorMotivo(
    base: Prisma.Sql,
    filtro: FiltroResolvido,
  ): Promise<TabelaBi> {
    const linhas = await this.prisma.$queryRaw<
      { categoria: string; total: number }[]
    >(Prisma.sql`
      SELECT d.categoria, count(*)::int AS total
      FROM sdr_decisoes d
        JOIN conversas c ON c.id = d.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE d.simulador = false AND d.categoria IS NOT NULL
        AND d.criado_em >= ${filtro.de} AND d.criado_em < ${filtro.ate} AND ${base}
      GROUP BY 1`);
    const total = linhas.reduce((soma, l) => soma + l.total, 0);
    return tabela(
      'passagensPorMotivo',
      'Passagens para a equipe por motivo',
      'Por que a IA passou a conversa para uma pessoa no período: pedido do lead, assunto sensível, limites, orçamento, falhas e outros.',
      [
        ['categoria', 'Motivo', 'id'],
        ['motivo', 'Motivo', 'texto'],
        ['total', 'Passagens', 'numero'],
        ['percentual', 'Parte do total', 'percentual'],
      ],
      linhas
        .map((l): Record<string, CelulaBi> => ({
          categoria: l.categoria,
          motivo:
            (CATEGORIAS_DE_PASSAGEM as Record<string, string>)[l.categoria] ??
            l.categoria,
          total: l.total,
          percentual: percentual(l.total, total),
        }))
        .sort(
          (a, b) =>
            Number(b.total) - Number(a.total) ||
            String(a.motivo).localeCompare(String(b.motivo), 'pt-BR'),
        ),
    );
  }
}

function valores(
  l: Omit<LinhaDeEventos, 'chave'> & Omit<LinhaDeAtendidas, 'chave'>,
): Valores {
  const tokens = totalDeTokens(l);
  return {
    atendidas: l.atendidas,
    qualificadas: l.qualificadas,
    desqualificadas: l.desqualificadas,
    passadas: l.passadas,
    primeiraResposta: numero(l.primeira_media, 0),
    primeiraRespostaMediana: numero(l.primeira_mediana, 0),
    negociosGanhos: l.ganhos,
    conversao: percentual(l.ganhos, l.qualificadas),
    tokens,
    tokensPorConversa:
      l.conversas_com_acao > 0
        ? Math.round(tokens / l.conversas_com_acao)
        : null,
  };
}
