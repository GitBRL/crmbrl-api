import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FUSO_DO_BI } from './bi.constantes';
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
import {
  sqlConversasVisiveis,
  sqlLigacoesVisiveis,
  sqlPessoas,
  VERDADEIRO,
} from './escopo-bi';
import { diasDoIntervalo, percentual } from './periodo';

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'conversas',
    rotulo: 'Conversas novas',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Conversas iniciadas no período.',
  },
  {
    chave: 'resolvidas',
    rotulo: 'Conversas resolvidas',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Conversas resolvidas no período (as reabertas depois não contam).',
  },
  {
    chave: 'primeiraResposta',
    rotulo: 'Primeira resposta (média)',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Tempo médio entre o início da conversa e a primeira resposta de uma pessoa, nas conversas novas já respondidas.',
  },
  {
    chave: 'primeiraRespostaMediana',
    rotulo: 'Primeira resposta (mediana)',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Metade das conversas novas foi respondida em menos que isto.',
  },
  {
    chave: 'tempoAtendimento',
    rotulo: 'Tempo médio de atendimento',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Tempo médio entre o início e a resolução, nas conversas resolvidas no período.',
  },
  {
    chave: 'slaPrimeiraResposta',
    rotulo: 'SLA da primeira resposta',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Conversas novas com prazo cuja primeira resposta saiu dentro do prazo, entre as que já cumpriram ou estouraram.',
  },
  {
    chave: 'slaResolucao',
    rotulo: 'SLA de resolução',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Conversas com prazo de resolução, resolvidas no período, que fecharam dentro do prazo.',
  },
  {
    chave: 'csat',
    rotulo: 'Satisfação (CSAT)',
    unidade: 'nota',
    melhorQuando: 'maior',
    dica: 'Nota média (1 a 5) das pesquisas de satisfação respondidas no período.',
  },
  {
    chave: 'respostasCsat',
    rotulo: 'Respostas de satisfação',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Pesquisas de satisfação respondidas no período.',
  },
  {
    chave: 'emAberto',
    rotulo: 'Em aberto agora',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Conversas abertas ou pendentes agora.',
  },
  {
    chave: 'semResponsavel',
    rotulo: 'Sem responsável agora',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Conversas em aberto que ninguém assumiu.',
  },
  {
    chave: 'ligacoesRecebidas',
    rotulo: 'Ligações recebidas',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Ligações do WhatsApp recebidas no período e já terminadas (atendidas ou não).',
  },
  {
    chave: 'ligacoesFeitas',
    rotulo: 'Ligações feitas',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Ligações que os atendentes fizeram pelo CRM no período e já terminadas (atendidas ou não).',
  },
  {
    chave: 'ligacoesAtendidas',
    rotulo: 'Ligações atendidas',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Ligações recebidas e feitas que chegaram a ser atendidas.',
  },
  {
    chave: 'ligacoesPerdidas',
    rotulo: 'Ligações perdidas',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Ligações recebidas que ninguém atendeu (tempo de toque, fora do horário, sem atendente ou cliente desistiu).',
  },
  {
    chave: 'ligacoesTaxaAtendimento',
    rotulo: 'Ligações recebidas atendidas',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Parte das ligações recebidas que foi atendida.',
  },
  {
    chave: 'ligacoesEspera',
    rotulo: 'Espera até atender (média)',
    unidade: 'segundos',
    melhorQuando: 'menor',
    dica: 'Tempo médio entre a ligação começar a tocar e ser atendida, nas recebidas atendidas.',
  },
  {
    chave: 'ligacoesDuracao',
    rotulo: 'Duração da conversa (média)',
    unidade: 'segundos',
    melhorQuando: 'maior',
    dica: 'Duração média das ligações atendidas, recebidas e feitas.',
  },
];

const DE_AGORA: ReadonlySet<string> = new Set(['emAberto', 'semResponsavel']);

interface LinhaDeIndicadores {
  chave: string | null;
  conversas: number;
  respondidas: number;
  primeira_media: number | null;
  primeira_mediana: number | null;
  sla_cumpridos: number;
  sla_estourados: number;
  resolvidas: number;
  atendimento_medio: number | null;
  res_cumpridos: number;
  res_estourados: number;
  csat: number | null;
  respostas_csat: number;
}

type Grupo = 'canal' | 'atendente' | 'fila';

/**
 * Painel Atendimento (R20): volume por canal e por hora, tempo da primeira
 * resposta, tempo médio de atendimento, SLA e CSAT, por atendente e por fila.
 * Visibilidade: a mesma das conversas (R12) — Marketing não vê o painel e o
 * membro vê só o que está com ele e as conversas sem responsável das filas da área.
 */
@Injectable()
export class PainelAtendimentoService {
  constructor(private readonly prisma: PrismaService) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const base = this.condicoes(usuario, filtro);
    const baseLigacoes = this.condicoesDeLigacoes(usuario, filtro);
    const [atual, atualLigacoes, agora] = await Promise.all([
      this.valoresDoPeriodo(base, filtro.de, filtro.ate),
      this.valoresDeLigacoes(baseLigacoes, filtro.de, filtro.ate),
      this.valoresDeAgora(base),
    ]);
    const anterior =
      filtro.anteriorDe && filtro.anteriorAte
        ? {
            ...(await this.valoresDoPeriodo(
              base,
              filtro.anteriorDe,
              filtro.anteriorAte,
            )),
            ...(await this.valoresDeLigacoes(
              baseLigacoes,
              filtro.anteriorDe,
              filtro.anteriorAte,
            )),
          }
        : null;
    const [
      porCanal,
      porAtendente,
      porFila,
      porHora,
      porDia,
      ligacoesPorAtendente,
      ligacoesPorHora,
    ] = await Promise.all([
      this.porGrupo('canal', base, filtro),
      this.porGrupo('atendente', base, filtro),
      this.porGrupo('fila', base, filtro),
      this.porHora(base, filtro),
      this.porDia(base, filtro),
      this.ligacoesPorAtendente(baseLigacoes, filtro),
      this.ligacoesPorHora(baseLigacoes, filtro),
    ]);
    return {
      cartoes: montarCartoes(
        CARTOES,
        { ...atual, ...atualLigacoes, ...agora },
        anterior,
        DE_AGORA,
      ),
      tabelas: {
        porCanal,
        porHora,
        porDia,
        porAtendente,
        porFila,
        ligacoesPorAtendente,
        ligacoesPorHora,
      },
      meta: {},
    };
  }

  /** Conversas `c` (filas `f`) que o usuário vê, com os filtros. */
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

  /**
   * Ligações `l` (conversas `c`, filas `f`) que o usuário vê (R12, R29.8), já terminadas, com os
   * filtros do painel. Quem filtra por pessoa vê as ligações do atendente.
   */
  private condicoesDeLigacoes(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`l.estado IN ('ENCERRADA'::estado_ligacao, 'PERDIDA'::estado_ligacao, 'RECUSADA'::estado_ligacao, 'SEM_RESPOSTA'::estado_ligacao, 'FALHOU'::estado_ligacao)
      AND ${sqlLigacoesVisiveis(usuario)}
      AND ${filtro.area ? Prisma.sql`f.area = ${filtro.area}::area` : VERDADEIRO}
      AND ${sqlPessoas(Prisma.sql`l.atendente_id`, filtro.pessoas)}
      AND ${filtro.canalId ? Prisma.sql`l.canal_id = ${filtro.canalId}::uuid` : VERDADEIRO}
      AND ${filtro.filaId ? Prisma.sql`c.fila_id = ${filtro.filaId}::uuid` : VERDADEIRO}`;
  }

  private async valoresDeLigacoes(
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [linha] = await this.prisma.$queryRaw<LinhaDeLigacoes[]>(Prisma.sql`
      SELECT ${LIGACOES_AGREGADAS}
      FROM ligacoes l
        LEFT JOIN conversas c ON c.id = l.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE l.iniciada_em >= ${de} AND l.iniciada_em < ${ate} AND ${base}`);
    return valoresDeLigacao(linha);
  }

  private async ligacoesPorAtendente(
    base: Prisma.Sql,
    filtro: FiltroResolvido,
  ): Promise<TabelaBi> {
    const linhas = await this.prisma.$queryRaw<
      (LinhaDeLigacoes & { chave: string | null })[]
    >(Prisma.sql`
      SELECT l.atendente_id AS chave, ${LIGACOES_AGREGADAS}
      FROM ligacoes l
        LEFT JOIN conversas c ON c.id = l.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE l.iniciada_em >= ${filtro.de} AND l.iniciada_em < ${filtro.ate} AND ${base}
      GROUP BY 1`);
    const ids = linhas.map((l) => l.chave).filter((id): id is string => !!id);
    const nomes = await this.nomes('atendente', ids);
    return tabela(
      'ligacoesPorAtendente',
      'Ligações por atendente',
      'Ligações do período por quem atendeu ou ligou. As perdidas não têm atendente e ficam em "Sem atendente".',
      [
        ['id', 'Atendente', 'id'],
        ['nome', 'Atendente', 'texto'],
        ['recebidas', 'Recebidas', 'numero'],
        ['feitas', 'Feitas', 'numero'],
        ['atendidas', 'Atendidas', 'numero'],
        ['perdidas', 'Perdidas', 'numero'],
        ['espera', 'Espera até atender (média)', 'segundos'],
        ['duracao', 'Duração (média)', 'segundos'],
      ],
      linhas
        .map((l): Record<string, CelulaBi> => {
          const v = valoresDeLigacao(l);
          return {
            id: l.chave,
            nome: (l.chave && nomes.get(l.chave)?.nome) || 'Sem atendente',
            recebidas: v.ligacoesRecebidas,
            feitas: v.ligacoesFeitas,
            atendidas: v.ligacoesAtendidas,
            perdidas: v.ligacoesPerdidas,
            espera: v.ligacoesEspera,
            duracao: v.ligacoesDuracao,
          };
        })
        .sort(
          (a, b) =>
            Number(b.atendidas) - Number(a.atendidas) ||
            Number(b.recebidas) +
              Number(b.feitas) -
              (Number(a.recebidas) + Number(a.feitas)) ||
            String(a.nome).localeCompare(String(b.nome), 'pt-BR'),
        ),
    );
  }

  private async ligacoesPorHora(
    base: Prisma.Sql,
    filtro: FiltroResolvido,
  ): Promise<TabelaBi> {
    const linhas = await this.prisma.$queryRaw<
      (LinhaDeLigacoes & { hora: number })[]
    >(Prisma.sql`
      SELECT extract(hour FROM l.iniciada_em AT TIME ZONE ${FUSO_DO_BI})::int AS hora, ${LIGACOES_AGREGADAS}
      FROM ligacoes l
        LEFT JOIN conversas c ON c.id = l.conversa_id
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE l.iniciada_em >= ${filtro.de} AND l.iniciada_em < ${filtro.ate} AND ${base}
      GROUP BY 1`);
    const por = new Map(linhas.map((l) => [l.hora, valoresDeLigacao(l)]));
    return tabela(
      'ligacoesPorHora',
      'Ligações por hora',
      'Ligações por hora do dia em que começaram (fuso de Brasília), somando todos os dias do período.',
      [
        ['hora', 'Hora', 'numero'],
        ['recebidas', 'Recebidas', 'numero'],
        ['feitas', 'Feitas', 'numero'],
        ['atendidas', 'Atendidas', 'numero'],
        ['perdidas', 'Perdidas', 'numero'],
      ],
      Array.from({ length: 24 }, (_, hora) => {
        const v = por.get(hora);
        return {
          hora,
          recebidas: v?.ligacoesRecebidas ?? 0,
          feitas: v?.ligacoesFeitas ?? 0,
          atendidas: v?.ligacoesAtendidas ?? 0,
          perdidas: v?.ligacoesPerdidas ?? 0,
        };
      }),
    );
  }

  /** Agregados do período, agrupados por `chave` (`NULL` = tudo junto). */
  private indicadores(
    chave: Prisma.Sql,
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<LinhaDeIndicadores[]> {
    const novas = Prisma.sql`c.criado_em >= ${de} AND c.criado_em < ${ate}`;
    const resolvidas = Prisma.sql`c.status = 'RESOLVIDA'::status_conversa AND c.resolvida_em >= ${de} AND c.resolvida_em < ${ate}`;
    const respondidasCsat = Prisma.sql`c.satisfacao_nota IS NOT NULL AND c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate}`;
    const tempoPrimeira = Prisma.sql`extract(epoch FROM c.primeira_resposta_em - c.criado_em)`;
    return this.prisma.$queryRaw<LinhaDeIndicadores[]>(Prisma.sql`
      SELECT ${chave} AS chave,
        (count(*) FILTER (WHERE ${novas}))::int AS conversas,
        (count(*) FILTER (WHERE ${novas} AND c.primeira_resposta_em IS NOT NULL))::int AS respondidas,
        (avg(${tempoPrimeira}) FILTER (WHERE ${novas} AND c.primeira_resposta_em IS NOT NULL))::float AS primeira_media,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${tempoPrimeira}) FILTER (WHERE ${novas} AND c.primeira_resposta_em IS NOT NULL))::float AS primeira_mediana,
        (count(*) FILTER (WHERE ${novas} AND c.sla_primeira_resposta_ate IS NOT NULL
          AND c.primeira_resposta_em IS NOT NULL AND c.primeira_resposta_em <= c.sla_primeira_resposta_ate))::int AS sla_cumpridos,
        (count(*) FILTER (WHERE ${novas} AND c.sla_primeira_resposta_ate IS NOT NULL AND (
          (c.primeira_resposta_em IS NOT NULL AND c.primeira_resposta_em > c.sla_primeira_resposta_ate)
          OR (c.primeira_resposta_em IS NULL AND c.sla_primeira_resposta_ate <= now()))))::int AS sla_estourados,
        (count(*) FILTER (WHERE ${resolvidas}))::int AS resolvidas,
        (avg(extract(epoch FROM c.resolvida_em - c.criado_em)) FILTER (WHERE ${resolvidas}))::float AS atendimento_medio,
        (count(*) FILTER (WHERE ${resolvidas} AND c.sla_resolucao_ate IS NOT NULL AND c.resolvida_em <= c.sla_resolucao_ate))::int AS res_cumpridos,
        (count(*) FILTER (WHERE ${resolvidas} AND c.sla_resolucao_ate IS NOT NULL AND c.resolvida_em > c.sla_resolucao_ate))::int AS res_estourados,
        (avg(c.satisfacao_nota) FILTER (WHERE ${respondidasCsat}))::float AS csat,
        (count(*) FILTER (WHERE ${respondidasCsat}))::int AS respostas_csat
      FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE (c.criado_em >= ${de} AND c.criado_em < ${ate}
          OR c.resolvida_em >= ${de} AND c.resolvida_em < ${ate}
          OR c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate})
        AND ${base}
      GROUP BY 1`);
  }

  private async valoresDoPeriodo(
    base: Prisma.Sql,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [linha] = await this.indicadores(
      Prisma.sql`NULL::uuid`,
      base,
      de,
      ate,
    );
    if (!linha) {
      return {
        conversas: 0,
        resolvidas: 0,
        primeiraResposta: null,
        primeiraRespostaMediana: null,
        tempoAtendimento: null,
        slaPrimeiraResposta: null,
        slaResolucao: null,
        csat: null,
        respostasCsat: 0,
      };
    }
    return valoresDaLinha(linha);
  }

  private async valoresDeAgora(base: Prisma.Sql): Promise<Valores> {
    const [linha] = await this.prisma.$queryRaw<
      { em_aberto: number; sem_responsavel: number }[]
    >(Prisma.sql`
      SELECT count(*)::int AS em_aberto,
        (count(*) FILTER (WHERE c.responsavel_id IS NULL))::int AS sem_responsavel
      FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE c.status <> 'RESOLVIDA'::status_conversa AND ${base}`);
    return { emAberto: linha.em_aberto, semResponsavel: linha.sem_responsavel };
  }

  // ---------------------------------------------------------------------
  // Tabelas
  // ---------------------------------------------------------------------

  private async porGrupo(
    grupo: Grupo,
    base: Prisma.Sql,
    filtro: FiltroResolvido,
  ): Promise<TabelaBi> {
    const chave =
      grupo === 'canal'
        ? Prisma.sql`c.canal_id`
        : grupo === 'fila'
          ? Prisma.sql`c.fila_id`
          : Prisma.sql`c.responsavel_id`;
    const linhas = await this.indicadores(chave, base, filtro.de, filtro.ate);
    const ids = linhas.map((l) => l.chave).filter((id): id is string => !!id);
    const nomes = await this.nomes(grupo, ids);
    const colunasBase = [
      ['conversas', 'Conversas', 'numero'],
      ['resolvidas', 'Resolvidas', 'numero'],
      ['primeiraResposta', 'Primeira resposta (média)', 'segundos'],
      ['tempoAtendimento', 'Tempo de atendimento (média)', 'segundos'],
      ['slaPrimeiraResposta', 'SLA da 1ª resposta', 'percentual'],
      ['slaResolucao', 'SLA de resolução', 'percentual'],
      ['csat', 'Satisfação (CSAT)', 'nota'],
      ['respostasCsat', 'Respostas de satisfação', 'numero'],
    ] as const;
    const rotuloVazio =
      grupo === 'fila'
        ? 'Sem fila'
        : grupo === 'atendente'
          ? 'Sem responsável'
          : 'Sem canal';
    const linhasDaTabela = linhas
      .map((l): Record<string, CelulaBi> => {
        const v = valoresDaLinha(l);
        const info = l.chave ? nomes.get(l.chave) : undefined;
        return {
          id: l.chave,
          nome: info?.nome ?? rotuloVazio,
          ...(grupo === 'canal' ? { tipo: info?.detalhe ?? null } : {}),
          ...v,
        };
      })
      .sort(
        (a, b) =>
          Number(b.conversas) - Number(a.conversas) ||
          String(a.nome).localeCompare(String(b.nome), 'pt-BR'),
      );
    const titulos: Record<Grupo, [string, string, string]> = {
      canal: [
        'porCanal',
        'Volume por canal',
        'Conversas novas e indicadores de cada canal no período.',
      ],
      atendente: [
        'porAtendente',
        'Por atendente',
        'Indicadores por responsável atual da conversa.',
      ],
      fila: ['porFila', 'Por fila', 'Indicadores de cada fila de atendimento.'],
    };
    const [chaveDaTabela, titulo, dica] = titulos[grupo];
    return tabela(
      chaveDaTabela,
      titulo,
      dica,
      [
        [
          'id',
          grupo === 'canal' ? 'Canal' : grupo === 'fila' ? 'Fila' : 'Atendente',
          'id',
        ],
        [
          'nome',
          grupo === 'canal' ? 'Canal' : grupo === 'fila' ? 'Fila' : 'Atendente',
          'texto',
        ],
        ...(grupo === 'canal' ? ([['tipo', 'Tipo', 'texto']] as const) : []),
        ...colunasBase,
      ],
      linhasDaTabela,
    );
  }

  private async nomes(
    grupo: Grupo,
    ids: string[],
  ): Promise<Map<string, { nome: string; detalhe?: string }>> {
    if (ids.length === 0) {
      return new Map();
    }
    if (grupo === 'canal') {
      const canais = await this.prisma.canal.findMany({
        where: { id: { in: ids } },
        select: { id: true, nome: true, tipo: true },
      });
      return new Map(
        canais.map((c) => [c.id, { nome: c.nome, detalhe: c.tipo }]),
      );
    }
    if (grupo === 'fila') {
      const filas = await this.prisma.filaAtendimento.findMany({
        where: { id: { in: ids } },
        select: { id: true, nome: true },
      });
      return new Map(filas.map((f) => [f.id, { nome: f.nome }]));
    }
    const usuarios = await this.prisma.usuario.findMany({
      where: { id: { in: ids } },
      select: { id: true, nome: true },
    });
    return new Map(usuarios.map((u) => [u.id, { nome: u.nome }]));
  }

  private async porHora(base: Prisma.Sql, filtro: FiltroResolvido) {
    const linhas = await this.prisma.$queryRaw<
      { hora: number; total: number }[]
    >(
      Prisma.sql`
      SELECT extract(hour FROM c.criado_em AT TIME ZONE ${FUSO_DO_BI})::int AS hora, count(*)::int AS total
      FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE c.criado_em >= ${filtro.de} AND c.criado_em < ${filtro.ate} AND ${base}
      GROUP BY 1`,
    );
    const por = new Map(linhas.map((l) => [l.hora, l.total]));
    return tabela(
      'porHora',
      'Volume por hora',
      'Conversas novas por hora do dia (fuso de Brasília), somando todos os dias do período.',
      [
        ['hora', 'Hora', 'numero'],
        ['conversas', 'Conversas', 'numero'],
      ],
      Array.from({ length: 24 }, (_, hora) => ({
        hora,
        conversas: por.get(hora) ?? 0,
      })),
    );
  }

  private async porDia(base: Prisma.Sql, filtro: FiltroResolvido) {
    const { de, ate } = filtro;
    const linhas = await this.prisma.$queryRaw<
      { dia: string; tipo: string; total: number }[]
    >(Prisma.sql`
      SELECT to_char(x.quando AT TIME ZONE ${FUSO_DO_BI}, 'YYYY-MM-DD') AS dia, x.tipo, count(*)::int AS total
      FROM (
        SELECT c.criado_em AS quando, 'conversas' AS tipo
          FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.criado_em >= ${de} AND c.criado_em < ${ate} AND ${base}
        UNION ALL
        SELECT c.resolvida_em, 'resolvidas'
          FROM conversas c LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.status = 'RESOLVIDA'::status_conversa AND c.resolvida_em >= ${de} AND c.resolvida_em < ${ate} AND ${base}
      ) x GROUP BY 1, 2`);
    const por = new Map(linhas.map((l) => [`${l.dia}|${l.tipo}`, l.total]));
    return tabela(
      'porDia',
      'Conversas por dia',
      'Conversas novas e resolvidas por dia (fuso de Brasília).',
      [
        ['dia', 'Dia', 'data'],
        ['conversas', 'Novas', 'numero'],
        ['resolvidas', 'Resolvidas', 'numero'],
      ],
      diasDoIntervalo(de, ate).map((dia) => ({
        dia,
        conversas: por.get(`${dia}|conversas`) ?? 0,
        resolvidas: por.get(`${dia}|resolvidas`) ?? 0,
      })),
    );
  }
}

interface LinhaDeLigacoes {
  recebidas: number;
  feitas: number;
  atendidas: number;
  perdidas: number;
  recebidas_atendidas: number;
  espera_media: number | null;
  duracao_media: number | null;
}

/** Contagens e médias das ligações (terminadas) de um grupo. */
const LIGACOES_AGREGADAS = Prisma.sql`
  (count(*) FILTER (WHERE l.direcao = 'RECEBIDA'::direcao_ligacao))::int AS recebidas,
  (count(*) FILTER (WHERE l.direcao = 'FEITA'::direcao_ligacao))::int AS feitas,
  (count(*) FILTER (WHERE l.atendida_em IS NOT NULL))::int AS atendidas,
  (count(*) FILTER (WHERE l.estado = 'PERDIDA'::estado_ligacao))::int AS perdidas,
  (count(*) FILTER (WHERE l.direcao = 'RECEBIDA'::direcao_ligacao AND l.atendida_em IS NOT NULL))::int AS recebidas_atendidas,
  (avg(extract(epoch FROM l.atendida_em - l.iniciada_em)) FILTER (WHERE l.direcao = 'RECEBIDA'::direcao_ligacao AND l.atendida_em IS NOT NULL))::float AS espera_media,
  (avg(l.duracao_segundos) FILTER (WHERE l.atendida_em IS NOT NULL AND l.duracao_segundos IS NOT NULL))::float AS duracao_media`;

function valoresDeLigacao(l: LinhaDeLigacoes | undefined): Valores {
  return {
    ligacoesRecebidas: l?.recebidas ?? 0,
    ligacoesFeitas: l?.feitas ?? 0,
    ligacoesAtendidas: l?.atendidas ?? 0,
    ligacoesPerdidas: l?.perdidas ?? 0,
    ligacoesTaxaAtendimento: l
      ? percentual(l.recebidas_atendidas, l.recebidas)
      : null,
    ligacoesEspera: numero(l?.espera_media ?? null, 0),
    ligacoesDuracao: numero(l?.duracao_media ?? null, 0),
  };
}

function valoresDaLinha(l: LinhaDeIndicadores): Valores {
  return {
    conversas: l.conversas,
    resolvidas: l.resolvidas,
    primeiraResposta: numero(l.primeira_media, 0),
    primeiraRespostaMediana: numero(l.primeira_mediana, 0),
    tempoAtendimento: numero(l.atendimento_medio, 0),
    slaPrimeiraResposta: percentual(
      l.sla_cumpridos,
      l.sla_cumpridos + l.sla_estourados,
    ),
    slaResolucao: percentual(
      l.res_cumpridos,
      l.res_cumpridos + l.res_estourados,
    ),
    csat: numero(l.csat, 2),
    respostasCsat: l.respostas_csat,
  };
}
