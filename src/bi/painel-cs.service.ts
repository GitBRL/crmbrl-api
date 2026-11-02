import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Prisma } from '../generated/prisma/client';
import { RiscoDeChurnService } from '../financeiro/risco-de-churn.service';
import { PrismaService } from '../prisma/prisma.service';
import { FUSO_DO_BI, LIMITE_DE_LINHAS } from './bi.constantes';
import type { ConteudoDoPainel, FiltroResolvido } from './bi.tipos';
import {
  type DefinicaoDeCartao,
  montarCartoes,
  numero,
  tabela,
  type Valores,
} from './cartoes';
import {
  sqlConversasVisiveis,
  sqlNegociosVisiveis,
  sqlPessoas,
  VERDADEIRO,
} from './escopo-bi';
import { percentual } from './periodo';

/** Etapas do funil-base de CS que formam o onboarding (chaves das etapas). */
export const ETAPAS_DE_ONBOARDING = [
  'boas_vindas',
  'onboarding',
  'implantacao',
] as const;

const CARTOES: readonly DefinicaoDeCartao[] = [
  {
    chave: 'renovados',
    rotulo: 'Renovados',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Negócios de CS que chegaram à etapa de ganho (renovado) no período.',
  },
  {
    chave: 'cancelados',
    rotulo: 'Cancelados (churn)',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Negócios de CS que chegaram à etapa de perda (cancelado) no período.',
  },
  {
    chave: 'taxaRenovacao',
    rotulo: 'Taxa de renovação',
    unidade: 'percentual',
    melhorQuando: 'maior',
    dica: 'Renovados ÷ (renovados + cancelados) no período.',
  },
  {
    chave: 'valorRecorrenteCancelado',
    rotulo: 'Recorrente cancelado',
    unidade: 'moeda',
    melhorQuando: 'menor',
    dica: 'Soma do valor recorrente dos negócios cancelados no período.',
  },
  {
    chave: 'satisfacao',
    rotulo: 'Satisfação (CSAT)',
    unidade: 'nota',
    melhorQuando: 'maior',
    dica: 'Nota média (1 a 5) das pesquisas de satisfação respondidas no período nas conversas das filas de CS.',
  },
  {
    chave: 'respostasSatisfacao',
    rotulo: 'Respostas de satisfação',
    unidade: 'numero',
    melhorQuando: 'maior',
    dica: 'Pesquisas de satisfação respondidas no período (CS).',
  },
  {
    chave: 'carteira',
    rotulo: 'Carteira',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Clientes (negócios de CS em etapas abertas) agora.',
  },
  {
    chave: 'valorRecorrenteCarteira',
    rotulo: 'Recorrente da carteira',
    unidade: 'moeda',
    melhorQuando: null,
    dica: 'Soma do valor recorrente dos negócios da carteira agora.',
  },
  {
    chave: 'emOnboarding',
    rotulo: 'Em onboarding',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Clientes nas etapas Boas-vindas, Onboarding e Implantação agora.',
  },
  {
    chave: 'renovacoesProximas',
    rotulo: 'Renovações em 30 dias',
    unidade: 'numero',
    melhorQuando: null,
    dica: 'Negócios da carteira com previsão de renovação de hoje até daqui a 30 dias.',
  },
  {
    chave: 'renovacoesVencidas',
    rotulo: 'Renovações vencidas',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Negócios da carteira com a previsão de renovação já passada.',
  },
  {
    chave: 'riscoAlto',
    rotulo: 'Clientes em risco alto',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Contatos com contrato ativo ou título em aberto e pontuação de churn de 60 ou mais (atraso, satisfação baixa e silêncio) agora.',
  },
  {
    chave: 'riscoMedio',
    rotulo: 'Clientes em risco médio',
    unidade: 'numero',
    melhorQuando: 'menor',
    dica: 'Contatos com pontuação de churn de 30 a 59 agora.',
  },
];

const DE_AGORA: ReadonlySet<string> = new Set([
  'carteira',
  'valorRecorrenteCarteira',
  'emOnboarding',
  'renovacoesProximas',
  'renovacoesVencidas',
  'riscoAlto',
  'riscoMedio',
]);

/**
 * Painel CS (R20): carteira, onboarding por etapa, renovações próximas,
 * satisfação e o resultado das renovações. O risco de churn vem do Financeiro
 * (R23.4). Visibilidade: negócios como no kanban (R5.9) e
 * conversas como no Atendimento (R12).
 */
@Injectable()
export class PainelCsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly risco: RiscoDeChurnService,
  ) {}

  async calcular(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<ConteudoDoPainel> {
    const [atual, agora] = await Promise.all([
      this.valoresDoPeriodo(usuario, filtro, filtro.de, filtro.ate),
      this.valoresDeAgora(usuario, filtro),
    ]);
    const anterior =
      filtro.anteriorDe && filtro.anteriorAte
        ? await this.valoresDoPeriodo(
            usuario,
            filtro,
            filtro.anteriorDe,
            filtro.anteriorAte,
          )
        : null;
    const [onboarding, porResponsavel, renovacoes, proximas, notas, churn] =
      await Promise.all([
        this.onboarding(usuario, filtro),
        this.carteiraPorResponsavel(usuario, filtro),
        this.renovacoes(usuario, filtro),
        this.proximasRenovacoes(usuario, filtro),
        this.satisfacaoPorNota(usuario, filtro),
        this.riscoDeChurn(usuario, filtro),
      ]);
    return {
      cartoes: montarCartoes(
        CARTOES,
        {
          ...atual,
          ...agora,
          riscoAlto: churn.contagem.ALTO,
          riscoMedio: churn.contagem.MEDIO,
        },
        anterior,
        DE_AGORA,
      ),
      tabelas: {
        onboardingPorEtapa: onboarding,
        carteiraPorResponsavel: porResponsavel,
        renovacoes,
        proximasRenovacoes: proximas,
        satisfacaoPorNota: notas,
        riscoDeChurn: churn.tabela,
      },
      meta: { etapasDeOnboarding: [...ETAPAS_DE_ONBOARDING] },
    };
  }

  // ---------------------------------------------------------------------
  // Fragmentos
  // ---------------------------------------------------------------------

  /** Negócios `n` de funis `f` de CS que o usuário vê, com os filtros. */
  private condicoesDeNegocios(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`f.area = 'CS'::area AND n.excluido_em IS NULL
      AND ${sqlNegociosVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`n.responsavel_id`, filtro.pessoas)}
      AND ${filtro.funilId ? Prisma.sql`n.funil_id = ${filtro.funilId}::uuid` : VERDADEIRO}`;
  }

  /** Conversas `c` das filas `f` de CS que o usuário vê. */
  private condicoesDeConversas(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Prisma.Sql {
    return Prisma.sql`f.area = 'CS'::area
      AND ${sqlConversasVisiveis(usuario)}
      AND ${sqlPessoas(Prisma.sql`c.responsavel_id`, filtro.pessoas)}`;
  }

  /** Hoje, no fuso do BI (a previsão de renovação é uma data, sem hora). */
  private readonly hoje = Prisma.sql`(now() AT TIME ZONE ${FUSO_DO_BI})::date`;

  // ---------------------------------------------------------------------
  // Indicadores
  // ---------------------------------------------------------------------

  private async valoresDoPeriodo(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
    de: Date,
    ate: Date,
  ): Promise<Valores> {
    const [[negocios], [satisfacao]] = await Promise.all([
      this.prisma.$queryRaw<
        { renovados: number; cancelados: number; recorrente: number | null }[]
      >(Prisma.sql`
        SELECT
          (count(*) FILTER (WHERE n.status = 'GANHO'::status_negocio AND n.ganho_em >= ${de} AND n.ganho_em < ${ate}))::int AS renovados,
          (count(*) FILTER (WHERE n.status = 'PERDIDO'::status_negocio AND n.perdido_em >= ${de} AND n.perdido_em < ${ate}))::int AS cancelados,
          (sum(n.valor_recorrente) FILTER (WHERE n.status = 'PERDIDO'::status_negocio AND n.perdido_em >= ${de} AND n.perdido_em < ${ate}))::float AS recorrente
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        WHERE ${this.condicoesDeNegocios(usuario, filtro)}`),
      this.prisma.$queryRaw<{ media: number | null; respostas: number }[]>(
        Prisma.sql`
        SELECT avg(c.satisfacao_nota)::float AS media, count(c.satisfacao_nota)::int AS respostas
        FROM conversas c JOIN filas_atendimento f ON f.id = c.fila_id
        WHERE c.satisfacao_nota IS NOT NULL
          AND c.satisfacao_respondida_em >= ${de} AND c.satisfacao_respondida_em < ${ate}
          AND ${this.condicoesDeConversas(usuario, filtro)}`,
      ),
    ]);
    return {
      renovados: negocios.renovados,
      cancelados: negocios.cancelados,
      taxaRenovacao: percentual(
        negocios.renovados,
        negocios.renovados + negocios.cancelados,
      ),
      valorRecorrenteCancelado: numero(negocios.recorrente ?? 0),
      satisfacao: numero(satisfacao.media, 2),
      respostasSatisfacao: satisfacao.respostas,
    };
  }

  private async valoresDeAgora(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ): Promise<Valores> {
    const [linha] = await this.prisma.$queryRaw<
      {
        carteira: number;
        recorrente: number | null;
        onboarding: number;
        proximas: number;
        vencidas: number;
      }[]
    >(Prisma.sql`
      SELECT count(*)::int AS carteira,
        sum(n.valor_recorrente)::float AS recorrente,
        (count(*) FILTER (WHERE e.chave = ANY(${[...ETAPAS_DE_ONBOARDING]}::text[])))::int AS onboarding,
        (count(*) FILTER (WHERE n.previsao_fechamento >= ${this.hoje} AND n.previsao_fechamento <= ${this.hoje} + 30))::int AS proximas,
        (count(*) FILTER (WHERE n.previsao_fechamento < ${this.hoje}))::int AS vencidas
      FROM negocios n JOIN funis f ON f.id = n.funil_id JOIN etapas e ON e.id = n.etapa_id
      WHERE n.status = 'ABERTO'::status_negocio
        AND ${this.condicoesDeNegocios(usuario, filtro)}`);
    return {
      carteira: linha.carteira,
      valorRecorrenteCarteira: numero(linha.recorrente ?? 0),
      emOnboarding: linha.onboarding,
      renovacoesProximas: linha.proximas,
      renovacoesVencidas: linha.vencidas,
    };
  }

  // ---------------------------------------------------------------------
  // Tabelas
  // ---------------------------------------------------------------------

  private async onboarding(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      {
        etapa_id: string;
        etapa: string;
        chave: string;
        quantidade: number;
        dias: number | null;
        parados: number;
      }[]
    >(Prisma.sql`
      SELECT e.id::text AS etapa_id, e.nome AS etapa, e.chave,
        count(*)::int AS quantidade,
        avg(extract(epoch FROM now() - n.etapa_desde) / 86400.0)::float AS dias,
        (count(*) FILTER (WHERE e.prazo_dias IS NOT NULL AND n.etapa_desde < now() - make_interval(days => e.prazo_dias)))::int AS parados
      FROM negocios n JOIN funis f ON f.id = n.funil_id JOIN etapas e ON e.id = n.etapa_id
      WHERE n.status = 'ABERTO'::status_negocio
        AND e.chave = ANY(${[...ETAPAS_DE_ONBOARDING]}::text[])
        AND ${this.condicoesDeNegocios(usuario, filtro)}
      GROUP BY e.id ORDER BY e.ordem`);
    return tabela(
      'onboardingPorEtapa',
      'Onboarding por etapa',
      'Clientes em Boas-vindas, Onboarding e Implantação agora, o tempo médio que estão na etapa e quantos já passaram do prazo da etapa.',
      [
        ['etapaId', 'Etapa', 'id'],
        ['etapa', 'Etapa', 'texto'],
        ['quantidade', 'Clientes', 'numero'],
        ['diasNaEtapa', 'Dias na etapa (média)', 'dias'],
        ['parados', 'Acima do prazo', 'numero'],
      ],
      linhas.map((l) => ({
        etapaId: l.etapa_id,
        etapa: l.etapa,
        quantidade: l.quantidade,
        diasNaEtapa: numero(l.dias, 1),
        parados: l.parados,
      })),
    );
  }

  private async carteiraPorResponsavel(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      {
        usuario_id: string | null;
        nome: string | null;
        clientes: number;
        recorrente: number;
      }[]
    >(Prisma.sql`
      SELECT n.responsavel_id::text AS usuario_id, u.nome, count(*)::int AS clientes,
        coalesce(sum(n.valor_recorrente), 0)::float AS recorrente
      FROM negocios n JOIN funis f ON f.id = n.funil_id
      LEFT JOIN usuarios u ON u.id = n.responsavel_id
      WHERE n.status = 'ABERTO'::status_negocio
        AND ${this.condicoesDeNegocios(usuario, filtro)}
      GROUP BY n.responsavel_id, u.nome
      ORDER BY count(*) DESC, u.nome NULLS LAST`);
    return tabela(
      'carteiraPorResponsavel',
      'Carteira por responsável',
      'Clientes abertos de cada pessoa de CS e o valor recorrente deles.',
      [
        ['usuarioId', 'Responsável', 'id'],
        ['nome', 'Responsável', 'texto'],
        ['clientes', 'Clientes', 'numero'],
        ['valorRecorrente', 'Valor recorrente', 'moeda'],
      ],
      linhas.map((l) => ({
        usuarioId: l.usuario_id,
        nome: l.nome ?? 'Sem responsável',
        clientes: l.clientes,
        valorRecorrente: numero(l.recorrente) ?? 0,
      })),
    );
  }

  private async renovacoes(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      { faixa: string; quantidade: number; recorrente: number }[]
    >(Prisma.sql`
      SELECT x.faixa, count(*)::int AS quantidade, coalesce(sum(x.valor_recorrente), 0)::float AS recorrente
      FROM (
        SELECT n.valor_recorrente,
          CASE
            WHEN n.previsao_fechamento < ${this.hoje} THEN 'vencidas'
            WHEN n.previsao_fechamento <= ${this.hoje} + 30 THEN 'ate30'
            WHEN n.previsao_fechamento <= ${this.hoje} + 60 THEN 'ate60'
            WHEN n.previsao_fechamento <= ${this.hoje} + 90 THEN 'ate90'
            ELSE 'depois'
          END AS faixa
        FROM negocios n JOIN funis f ON f.id = n.funil_id
        WHERE n.status = 'ABERTO'::status_negocio AND n.previsao_fechamento IS NOT NULL
          AND ${this.condicoesDeNegocios(usuario, filtro)}
      ) x GROUP BY x.faixa`);
    const por = new Map(linhas.map((l) => [l.faixa, l]));
    const faixas: [string, string][] = [
      ['vencidas', 'Vencidas'],
      ['ate30', 'Até 30 dias'],
      ['ate60', '31 a 60 dias'],
      ['ate90', '61 a 90 dias'],
      ['depois', 'Depois de 90 dias'],
    ];
    return tabela(
      'renovacoes',
      'Renovações por faixa',
      'Clientes abertos com previsão de renovação, por faixa de prazo a partir de hoje.',
      [
        ['faixa', 'Faixa', 'texto'],
        ['quantidade', 'Clientes', 'numero'],
        ['valorRecorrente', 'Valor recorrente', 'moeda'],
      ],
      faixas.map(([chave, rotulo]) => ({
        faixa: rotulo,
        quantidade: por.get(chave)?.quantidade ?? 0,
        valorRecorrente: numero(por.get(chave)?.recorrente ?? 0) ?? 0,
      })),
    );
  }

  private async proximasRenovacoes(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      {
        id: string;
        titulo: string;
        contato: string;
        responsavel: string | null;
        previsao: string;
        recorrente: number | null;
        etapa: string;
      }[]
    >(Prisma.sql`
      SELECT n.id::text AS id, n.titulo, c.nome AS contato, u.nome AS responsavel,
        to_char(n.previsao_fechamento, 'YYYY-MM-DD') AS previsao,
        n.valor_recorrente::float AS recorrente, e.nome AS etapa
      FROM negocios n JOIN funis f ON f.id = n.funil_id JOIN etapas e ON e.id = n.etapa_id
      JOIN contatos c ON c.id = n.contato_id
      LEFT JOIN usuarios u ON u.id = n.responsavel_id
      WHERE n.status = 'ABERTO'::status_negocio AND n.previsao_fechamento IS NOT NULL
        AND n.previsao_fechamento <= ${this.hoje} + 90
        AND ${this.condicoesDeNegocios(usuario, filtro)}
      ORDER BY n.previsao_fechamento, n.id
      LIMIT ${LIMITE_DE_LINHAS}`);
    return tabela(
      'proximasRenovacoes',
      'Próximas renovações',
      'Os 50 clientes abertos com a previsão de renovação mais próxima (inclui as vencidas), até 90 dias à frente.',
      [
        ['negocioId', 'Negócio', 'id'],
        ['titulo', 'Cliente', 'texto'],
        ['contato', 'Contato', 'texto'],
        ['responsavel', 'Responsável', 'texto'],
        ['etapa', 'Etapa', 'texto'],
        ['previsao', 'Previsão', 'data'],
        ['valorRecorrente', 'Valor recorrente', 'moeda'],
      ],
      linhas.map((l) => ({
        negocioId: l.id,
        titulo: l.titulo,
        contato: l.contato,
        responsavel: l.responsavel,
        etapa: l.etapa,
        previsao: l.previsao,
        valorRecorrente: numero(l.recorrente),
      })),
    );
  }

  /** R23.4 — risco de churn (Financeiro): contagem por nível e os contatos mais em risco, só do que o usuário vê. */
  private async riscoDeChurn(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const todos = await this.risco.ranking(usuario, {
      nivelMinimo: 'BAIXO',
      limite: 100_000,
      pessoas: filtro.pessoas,
    });
    const contagem = { BAIXO: 0, MEDIO: 0, ALTO: 0 };
    for (const r of todos) {
      contagem[r.nivel] += 1;
    }
    const nivel = { ALTO: 'Alto', MEDIO: 'Médio', BAIXO: 'Baixo' } as const;
    return {
      contagem,
      tabela: tabela(
        'riscoDeChurn',
        'Risco de churn',
        'Os 50 contatos com maior pontuação de risco (médio ou alto): atraso no pagamento, nota de satisfação baixa e tempo sem interação.',
        [
          ['contatoId', 'Contato', 'id'],
          ['contato', 'Cliente', 'texto'],
          ['pontuacao', 'Pontuação', 'numero'],
          ['nivel', 'Risco', 'texto'],
          ['motivos', 'Motivos', 'texto'],
        ],
        todos
          .filter((r) => r.nivel !== 'BAIXO')
          .slice(0, LIMITE_DE_LINHAS)
          .map((r) => ({
            contatoId: r.contatoId,
            contato: r.contato.nome,
            pontuacao: r.pontuacao,
            nivel: nivel[r.nivel],
            motivos: r.fatores.map((f) => f.detalhe).join('; '),
          })),
      ),
    };
  }

  private async satisfacaoPorNota(
    usuario: UsuarioAutenticado,
    filtro: FiltroResolvido,
  ) {
    const linhas = await this.prisma.$queryRaw<
      { nota: number; respostas: number }[]
    >(Prisma.sql`
      SELECT c.satisfacao_nota AS nota, count(*)::int AS respostas
      FROM conversas c JOIN filas_atendimento f ON f.id = c.fila_id
      WHERE c.satisfacao_nota IS NOT NULL
        AND c.satisfacao_respondida_em >= ${filtro.de} AND c.satisfacao_respondida_em < ${filtro.ate}
        AND ${this.condicoesDeConversas(usuario, filtro)}
      GROUP BY c.satisfacao_nota`);
    const por = new Map(linhas.map((l) => [l.nota, l.respostas]));
    return tabela(
      'satisfacaoPorNota',
      'Satisfação por nota',
      'Respostas de satisfação no período, por nota de 1 a 5.',
      [
        ['nota', 'Nota', 'nota'],
        ['respostas', 'Respostas', 'numero'],
      ],
      [1, 2, 3, 4, 5].map((nota) => ({ nota, respostas: por.get(nota) ?? 0 })),
    );
  }
}
