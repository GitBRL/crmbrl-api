/**
 * Catálogo de indicadores (R33.1): constante da API. Cada indicador declara o que
 * é (nome, grupo, unidade, parâmetros, visualizações) e como se calcula
 * (`calculo`: a fonte das linhas, a coluna de tempo, a condição e as duas
 * expressões agregadas `a` e `b` que a fórmula combina). O resto — recorte de
 * visibilidade, filtros, período, série, ranking — é montado igual para todos
 * (`calculo-indicadores.service.ts`).
 */
import { Prisma } from '../generated/prisma/client';
import {
  taxa,
  taxaDeComparecimento,
  taxaDeConversao,
  taxaDeNoShow,
  ticketMedio,
} from './formulas';
import type {
  Grupo,
  OpcaoDeParametro,
  ParametroDoIndicador,
  Parametros,
  Unidade,
  Visualizacao,
} from './indicadores.tipos';

export type Fonte = 'NEGOCIO' | 'ATIVIDADE' | 'LIGACAO';

/** Dimensões de barras (`por`): rótulo e a expressão SQL (chave) por fonte. */
export const DIMENSOES_DE_BARRAS: Readonly<
  Record<string, { rotulo: string; fonte: Fonte; sql: string }>
> = {
  ORIGEM: { rotulo: 'Origem', fonte: 'NEGOCIO', sql: `n.origem::text` },
  FUNIL: { rotulo: 'Funil', fonte: 'NEGOCIO', sql: `f.nome` },
  UTM_SOURCE: {
    rotulo: 'UTM source',
    fonte: 'NEGOCIO',
    sql: `nullif(lower(n.utm->>'source'), '')`,
  },
  MOTIVO: {
    rotulo: 'Motivo da perda',
    fonte: 'NEGOCIO',
    sql: `n.motivo_perda`,
  },
  TIPO: {
    rotulo: 'Tipo de atividade',
    fonte: 'ATIVIDADE',
    sql: `a.tipo::text`,
  },
  RESULTADO: {
    rotulo: 'Resultado da reunião',
    fonte: 'ATIVIDADE',
    sql: `coalesce(a.resultado_reuniao::text, 'SEM_RESULTADO')`,
  },
  DIRECAO: { rotulo: 'Direção', fonte: 'LIGACAO', sql: `l.direcao::text` },
  ESTADO: { rotulo: 'Como terminou', fonte: 'LIGACAO', sql: `l.estado::text` },
};

export interface CalculoDoIndicador {
  fonte: Fonte;
  /** Expressão SQL do instante que decide o período; `null` = retrato de agora (sem período). */
  tempo: string | null;
  /** Condições fixas do indicador (SQL estático, nunca com dado do usuário). */
  onde: (parametros: Parametros) => Prisma.Sql;
  /** Expressões agregadas (uma por linha do agrupamento). */
  a: (parametros: Parametros) => Prisma.Sql;
  b?: (parametros: Parametros) => Prisma.Sql;
  /** Combina `a` e `b` no valor do indicador. */
  formula: (a: number | null, b: number | null) => number | null;
  /** `NULO`: sem linhas não há média (o balde vazio da série fica sem valor, em vez de zero). */
  semAmostra?: 'NULO';
  /** Indicador calculado à parte (movimentações de etapa). */
  especial?: 'CONVERSAO_ENTRE_ETAPAS';
}

export interface IndicadorDoCatalogo {
  chave: string;
  nome: string;
  descricao: string;
  grupo: Grupo;
  unidade: Unidade;
  melhorQuando: 'maior' | 'menor' | null;
  /** Retrato de agora: sem período, sem comparação, sem série. */
  agora: boolean;
  parametros: readonly ParametroDoIndicador[];
  visualizacoes: readonly Visualizacao[];
  /** Dimensões aceitas na visualização `BARRAS` (`por`). */
  barras: readonly string[];
  calculo: CalculoDoIndicador;
}

// ---------------------------------------------------------------------------
// Parâmetros reutilizados
// ---------------------------------------------------------------------------

const TIPOS_DE_ATIVIDADE: readonly OpcaoDeParametro[] = [
  { valor: 'TAREFA', rotulo: 'Tarefa' },
  { valor: 'LIGACAO', rotulo: 'Ligação' },
  { valor: 'REUNIAO', rotulo: 'Reunião' },
  { valor: 'EMAIL', rotulo: 'E-mail' },
  { valor: 'WHATSAPP', rotulo: 'WhatsApp' },
];

const PARAMETRO_AGRUPAMENTO: ParametroDoIndicador = {
  chave: 'agrupamento',
  rotulo: 'Agrupar a série por',
  tipo: 'AGRUPAMENTO',
  obrigatorioEm: null,
  vale: ['SERIE'],
  opcoes: [
    { valor: 'DIA', rotulo: 'Dia' },
    { valor: 'SEMANA', rotulo: 'Semana' },
    { valor: 'MES', rotulo: 'Mês' },
  ],
  padrao: 'DIA',
  dica: 'Dia, semana (de segunda a domingo) ou mês, no fuso de São Paulo.',
};

function parametroPor(barras: readonly string[]): ParametroDoIndicador {
  return {
    chave: 'por',
    rotulo: 'Dividir por',
    tipo: 'POR',
    obrigatorioEm: null,
    vale: ['BARRAS'],
    opcoes: barras.map((valor) => ({
      valor,
      rotulo: DIMENSOES_DE_BARRAS[valor].rotulo,
    })),
    padrao: barras[0],
    dica: 'O que forma cada barra.',
  };
}

const PARAMETRO_FUNIL: ParametroDoIndicador = {
  chave: 'funilId',
  rotulo: 'Funil',
  tipo: 'FUNIL',
  obrigatorioEm: null,
  vale: ['POR_ETAPA', 'FUNIL'],
  dica: 'Sem escolha, vale o funil do filtro (se for um só) ou o funil-base do Comercial.',
};

const PARAMETRO_ESTATISTICA: ParametroDoIndicador = {
  chave: 'estatistica',
  rotulo: 'Cálculo',
  tipo: 'ESTATISTICA',
  obrigatorioEm: null,
  vale: null,
  opcoes: [
    { valor: 'MEDIA', rotulo: 'Média' },
    { valor: 'MEDIANA', rotulo: 'Mediana' },
  ],
  padrao: 'MEDIA',
  dica: 'A mediana ignora os casos extremos.',
};

const PARAMETRO_DIRECAO: ParametroDoIndicador = {
  chave: 'direcao',
  rotulo: 'Ligações',
  tipo: 'DIRECAO',
  obrigatorioEm: null,
  vale: null,
  opcoes: [
    { valor: 'TODAS', rotulo: 'Feitas e recebidas' },
    { valor: 'FEITA', rotulo: 'Só as feitas' },
    { valor: 'RECEBIDA', rotulo: 'Só as recebidas' },
  ],
  padrao: 'TODAS',
  dica: 'Quais ligações entram na conta.',
};

const SQL_VERDADEIRO = Prisma.sql`TRUE`;

const contar = () => Prisma.sql`count(*)::float8`;
const somar = (coluna: string) =>
  Prisma.sql`sum(${Prisma.raw(coluna)})::float8`;
const contarOnde = (condicao: string) =>
  Prisma.sql`(count(*) FILTER (WHERE ${Prisma.raw(condicao)}))::float8`;
const identidade = (a: number | null): number | null => a;

type EntradaDoIndicador = Omit<
  IndicadorDoCatalogo,
  'parametros' | 'barras' | 'agora' | 'melhorQuando'
> & {
  parametros?: readonly ParametroDoIndicador[];
  barras?: readonly string[];
  melhorQuando?: 'maior' | 'menor' | null;
};

function indicador(entrada: EntradaDoIndicador): IndicadorDoCatalogo {
  const barras = entrada.barras ?? [];
  const parametros = [...(entrada.parametros ?? [])];
  if (entrada.visualizacoes.includes('SERIE')) {
    parametros.push(PARAMETRO_AGRUPAMENTO);
  }
  if (barras.length > 0) {
    parametros.push(parametroPor(barras));
  }
  if (
    entrada.visualizacoes.includes('POR_ETAPA') ||
    entrada.visualizacoes.includes('FUNIL')
  ) {
    parametros.push(PARAMETRO_FUNIL);
  }
  return {
    ...entrada,
    parametros,
    barras,
    agora: entrada.calculo.tempo === null,
    melhorQuando: entrada.melhorQuando ?? 'maior',
  };
}

const PADRAO: readonly Visualizacao[] = ['NUMERO', 'SERIE', 'RANKING'];
const COM_BARRAS: readonly Visualizacao[] = [...PADRAO, 'BARRAS'];
const BARRAS_DE_NEGOCIO = ['ORIGEM', 'FUNIL', 'UTM_SOURCE'] as const;

const NEGOCIO = { fonte: 'NEGOCIO' as const };
const ATIVIDADE = { fonte: 'ATIVIDADE' as const };
const LIGACAO = { fonte: 'LIGACAO' as const };

const REUNIAO_VALIDA = `a.tipo = 'REUNIAO'::tipo_atividade AND a.status <> 'CANCELADA'::status_atividade`;

function reuniao(
  chave: string,
  nome: string,
  descricao: string,
  filtro: string | null,
): IndicadorDoCatalogo {
  return indicador({
    chave,
    nome,
    descricao,
    grupo: 'REUNIOES',
    unidade: 'NUMERO',
    visualizacoes: chave === 'reunioes_agendadas' ? COM_BARRAS : PADRAO,
    barras: chave === 'reunioes_agendadas' ? ['RESULTADO'] : [],
    melhorQuando: chave === 'reunioes_no_show' ? 'menor' : 'maior',
    calculo: {
      ...ATIVIDADE,
      tempo: 'a.inicio_em',
      onde: () =>
        Prisma.raw(`${REUNIAO_VALIDA}${filtro ? ` AND ${filtro}` : ''}`),
      a: contar,
      formula: identidade,
    },
  });
}

const NEGOCIO_ABERTO = `n.status = 'ABERTO'::status_negocio`;
const NEGOCIO_GANHO = `n.status = 'GANHO'::status_negocio`;
const NEGOCIO_PERDIDO = `n.status = 'PERDIDO'::status_negocio`;
const SEGUNDOS = (fim: string, inicio: string) =>
  `extract(epoch FROM (${fim} - ${inicio}))`;

export const CATALOGO: readonly IndicadorDoCatalogo[] = [
  // ----- Leads ------------------------------------------------------------
  indicador({
    chave: 'leads_recebidos',
    nome: 'Leads recebidos',
    descricao: 'Negócios criados no período.',
    grupo: 'LEADS',
    unidade: 'NUMERO',
    visualizacoes: [...COM_BARRAS, 'POR_ETAPA'],
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.criado_em',
      onde: () => SQL_VERDADEIRO,
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'leads_atendidos',
    nome: 'Leads atendidos',
    descricao:
      'Dos negócios criados no período, quantos já tiveram a primeira interação de uma pessoa (ligação, mensagem enviada, e-mail ou atividade concluída).',
    grupo: 'LEADS',
    unidade: 'NUMERO',
    visualizacoes: COM_BARRAS,
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.criado_em',
      onde: () => Prisma.raw('n.primeira_interacao_em IS NOT NULL'),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'taxa_atendimento',
    nome: 'Taxa de atendimento',
    descricao:
      'Leads atendidos ÷ leads recebidos, entre os criados no período.',
    grupo: 'LEADS',
    unidade: 'PERCENTUAL',
    visualizacoes: PADRAO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.criado_em',
      onde: () => SQL_VERDADEIRO,
      a: () => contarOnde('n.primeira_interacao_em IS NOT NULL'),
      b: contar,
      formula: (a, b) => taxa(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'tempo_ate_atendimento',
    nome: 'Tempo até o atendimento',
    descricao:
      'Média ou mediana do tempo entre a criação do negócio e a primeira interação, entre as primeiras interações que aconteceram no período.',
    grupo: 'LEADS',
    unidade: 'DURACAO',
    melhorQuando: 'menor',
    visualizacoes: PADRAO,
    parametros: [PARAMETRO_ESTATISTICA],
    calculo: {
      ...NEGOCIO,
      tempo: 'n.primeira_interacao_em',
      onde: () =>
        Prisma.raw(
          'n.primeira_interacao_em IS NOT NULL AND n.primeira_interacao_em >= n.criado_em',
        ),
      a: (p) =>
        p['estatistica'] === 'MEDIANA'
          ? Prisma.raw(
              `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${SEGUNDOS('n.primeira_interacao_em', 'n.criado_em')})::float8`,
            )
          : Prisma.raw(
              `avg(${SEGUNDOS('n.primeira_interacao_em', 'n.criado_em')})::float8`,
            ),
      formula: identidade,
      semAmostra: 'NULO',
    },
  }),
  indicador({
    chave: 'leads_sem_atendimento',
    nome: 'Leads sem atendimento',
    descricao:
      'Negócios abertos que ainda não tiveram a primeira interação, agora.',
    grupo: 'LEADS',
    unidade: 'NUMERO',
    melhorQuando: 'menor',
    visualizacoes: ['NUMERO', 'RANKING', 'POR_ETAPA', 'BARRAS'],
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: null,
      onde: () =>
        Prisma.raw(`${NEGOCIO_ABERTO} AND n.primeira_interacao_em IS NULL`),
      a: contar,
      formula: identidade,
    },
  }),

  // ----- Reuniões ---------------------------------------------------------
  reuniao(
    'reunioes_agendadas',
    'Reuniões agendadas',
    'Reuniões com início no período, sem as canceladas.',
    null,
  ),
  reuniao(
    'reunioes_realizadas',
    'Reuniões realizadas',
    'Reuniões do período em que o lead compareceu.',
    `a.resultado_reuniao = 'COMPARECEU'::resultado_reuniao`,
  ),
  reuniao(
    'reunioes_no_show',
    'Reuniões com no-show',
    'Reuniões do período em que o lead não compareceu.',
    `a.resultado_reuniao = 'NAO_COMPARECEU'::resultado_reuniao`,
  ),
  reuniao(
    'reunioes_remarcadas',
    'Reuniões remarcadas',
    'Reuniões do período que foram remarcadas para outra data.',
    `a.resultado_reuniao = 'REMARCADA'::resultado_reuniao`,
  ),
  reuniao(
    'reunioes_sem_resultado',
    'Reuniões sem resultado',
    'Reuniões do período que já começaram e ainda não têm o resultado registrado.',
    `a.resultado_reuniao IS NULL AND a.inicio_em < now()`,
  ),
  indicador({
    chave: 'taxa_comparecimento',
    nome: 'Taxa de comparecimento',
    descricao:
      'Compareceu ÷ (compareceu + não compareceu), nas reuniões do período.',
    grupo: 'REUNIOES',
    unidade: 'PERCENTUAL',
    visualizacoes: PADRAO,
    calculo: {
      ...ATIVIDADE,
      tempo: 'a.inicio_em',
      onde: () => Prisma.raw(REUNIAO_VALIDA),
      a: () =>
        contarOnde(`a.resultado_reuniao = 'COMPARECEU'::resultado_reuniao`),
      b: () =>
        contarOnde(`a.resultado_reuniao = 'NAO_COMPARECEU'::resultado_reuniao`),
      formula: (a, b) => taxaDeComparecimento(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'taxa_no_show',
    nome: 'Taxa de no-show',
    descricao:
      'Não compareceu ÷ (compareceu + não compareceu), nas reuniões do período.',
    grupo: 'REUNIOES',
    unidade: 'PERCENTUAL',
    melhorQuando: 'menor',
    visualizacoes: PADRAO,
    calculo: {
      ...ATIVIDADE,
      tempo: 'a.inicio_em',
      onde: () => Prisma.raw(REUNIAO_VALIDA),
      a: () =>
        contarOnde(`a.resultado_reuniao = 'COMPARECEU'::resultado_reuniao`),
      b: () =>
        contarOnde(`a.resultado_reuniao = 'NAO_COMPARECEU'::resultado_reuniao`),
      formula: (a, b) => taxaDeNoShow(a ?? 0, b ?? 0),
    },
  }),

  // ----- Vendas -----------------------------------------------------------
  indicador({
    chave: 'negocios_ganhos',
    nome: 'Negócios ganhos',
    descricao: 'Negócios que chegaram à etapa de ganho no período.',
    grupo: 'VENDAS',
    unidade: 'NUMERO',
    visualizacoes: COM_BARRAS,
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.ganho_em',
      onde: () => Prisma.raw(NEGOCIO_GANHO),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'valor_ganho',
    nome: 'Valor ganho',
    descricao: 'Soma do valor dos negócios ganhos no período.',
    grupo: 'VENDAS',
    unidade: 'MOEDA',
    visualizacoes: COM_BARRAS,
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.ganho_em',
      onde: () => Prisma.raw(NEGOCIO_GANHO),
      a: () => somar('n.valor'),
      formula: (a) => a ?? 0,
    },
  }),
  indicador({
    chave: 'ticket_medio',
    nome: 'Ticket médio',
    descricao: 'Valor ganho ÷ negócios ganhos no período.',
    grupo: 'VENDAS',
    unidade: 'MOEDA',
    visualizacoes: PADRAO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.ganho_em',
      onde: () => Prisma.raw(NEGOCIO_GANHO),
      a: () => somar('n.valor'),
      b: contar,
      formula: (a, b) => ticketMedio(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'negocios_perdidos',
    nome: 'Negócios perdidos',
    descricao: 'Negócios que chegaram à etapa de perda no período.',
    grupo: 'VENDAS',
    unidade: 'NUMERO',
    melhorQuando: 'menor',
    visualizacoes: COM_BARRAS,
    barras: ['MOTIVO', ...BARRAS_DE_NEGOCIO],
    calculo: {
      ...NEGOCIO,
      tempo: 'n.perdido_em',
      onde: () => Prisma.raw(NEGOCIO_PERDIDO),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'perdas_por_motivo',
    nome: 'Perdas por motivo',
    descricao: 'Negócios perdidos no período, por motivo da perda.',
    grupo: 'VENDAS',
    unidade: 'NUMERO',
    melhorQuando: 'menor',
    visualizacoes: ['BARRAS'],
    barras: ['MOTIVO'],
    calculo: {
      ...NEGOCIO,
      tempo: 'n.perdido_em',
      onde: () => Prisma.raw(NEGOCIO_PERDIDO),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'taxa_conversao',
    nome: 'Taxa de conversão',
    descricao:
      'Ganhos ÷ (ganhos + perdidos), entre os negócios fechados no período.',
    grupo: 'VENDAS',
    unidade: 'PERCENTUAL',
    visualizacoes: PADRAO,
    calculo: {
      ...NEGOCIO,
      tempo: 'coalesce(n.ganho_em, n.perdido_em)',
      onde: () =>
        Prisma.raw(
          `n.status IN ('GANHO'::status_negocio, 'PERDIDO'::status_negocio)`,
        ),
      a: () => contarOnde(NEGOCIO_GANHO),
      b: () => contarOnde(NEGOCIO_PERDIDO),
      formula: (a, b) => taxaDeConversao(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'taxa_conversao_coorte',
    nome: 'Conversão dos leads do período',
    descricao: 'Dos negócios criados no período, quantos % já foram ganhos.',
    grupo: 'VENDAS',
    unidade: 'PERCENTUAL',
    visualizacoes: PADRAO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.criado_em',
      onde: () => SQL_VERDADEIRO,
      a: () => contarOnde(NEGOCIO_GANHO),
      b: contar,
      formula: (a, b) => taxa(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'conversao_entre_etapas',
    nome: 'Conversão entre etapas',
    descricao:
      'Dos negócios que entraram na etapa de origem no período, quantos % chegaram à etapa de destino. Como funil, mostra os negócios que entraram no funil no período e quantos chegaram a cada etapa.',
    grupo: 'VENDAS',
    unidade: 'PERCENTUAL',
    visualizacoes: ['NUMERO', 'FUNIL'],
    parametros: [
      {
        chave: 'etapaOrigemId',
        rotulo: 'Etapa de origem',
        tipo: 'ETAPA',
        obrigatorioEm: ['NUMERO'],
        vale: ['NUMERO'],
        dica: 'A etapa em que o negócio entrou no período.',
      },
      {
        chave: 'etapaDestinoId',
        rotulo: 'Etapa de destino',
        tipo: 'ETAPA',
        obrigatorioEm: ['NUMERO'],
        vale: ['NUMERO'],
        dica: 'A etapa que ele precisa ter alcançado depois.',
      },
    ],
    calculo: {
      ...NEGOCIO,
      tempo: 'n.criado_em',
      onde: () => SQL_VERDADEIRO,
      a: contar,
      formula: identidade,
      especial: 'CONVERSAO_ENTRE_ETAPAS',
    },
  }),
  indicador({
    chave: 'ciclo_medio',
    nome: 'Ciclo médio de vendas',
    descricao:
      'Tempo médio entre a criação e o ganho, dos negócios ganhos no período.',
    grupo: 'VENDAS',
    unidade: 'DURACAO',
    melhorQuando: 'menor',
    visualizacoes: PADRAO,
    calculo: {
      ...NEGOCIO,
      tempo: 'n.ganho_em',
      onde: () => Prisma.raw(NEGOCIO_GANHO),
      a: () =>
        Prisma.raw(`avg(${SEGUNDOS('n.ganho_em', 'n.criado_em')})::float8`),
      formula: identidade,
      semAmostra: 'NULO',
    },
  }),
  indicador({
    chave: 'negocios_abertos',
    nome: 'Negócios abertos',
    descricao: 'Negócios em etapas abertas, agora.',
    grupo: 'VENDAS',
    unidade: 'NUMERO',
    melhorQuando: null,
    visualizacoes: ['NUMERO', 'RANKING', 'POR_ETAPA', 'BARRAS'],
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: null,
      onde: () => Prisma.raw(NEGOCIO_ABERTO),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'valor_em_aberto',
    nome: 'Valor em aberto',
    descricao: 'Soma do valor dos negócios abertos, agora.',
    grupo: 'VENDAS',
    unidade: 'MOEDA',
    melhorQuando: null,
    visualizacoes: ['NUMERO', 'RANKING', 'POR_ETAPA', 'BARRAS'],
    barras: BARRAS_DE_NEGOCIO,
    calculo: {
      ...NEGOCIO,
      tempo: null,
      onde: () => Prisma.raw(NEGOCIO_ABERTO),
      a: () => somar('n.valor'),
      formula: (a) => a ?? 0,
    },
  }),

  // ----- Ligações ---------------------------------------------------------
  indicador({
    chave: 'ligacoes_feitas',
    nome: 'Ligações feitas',
    descricao:
      'Ligações que as pessoas fizeram no período, por qualquer provedor (o discador sem atendente não entra).',
    grupo: 'LIGACOES',
    unidade: 'NUMERO',
    visualizacoes: [...COM_BARRAS],
    barras: ['ESTADO'],
    calculo: {
      ...LIGACAO,
      tempo: 'l.iniciada_em',
      // Só ligações de pessoas: o discador sem atendente não vira "Sem responsável" no ranking.
      onde: () =>
        Prisma.raw(
          `l.direcao = 'FEITA'::direcao_ligacao AND l.atendente_id IS NOT NULL`,
        ),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'ligacoes_atendidas',
    nome: 'Ligações atendidas',
    descricao: 'Ligações feitas no período que o cliente atendeu.',
    grupo: 'LIGACOES',
    unidade: 'NUMERO',
    visualizacoes: PADRAO,
    calculo: {
      ...LIGACAO,
      tempo: 'l.iniciada_em',
      onde: () =>
        Prisma.raw(
          `l.direcao = 'FEITA'::direcao_ligacao AND l.atendente_id IS NOT NULL AND l.atendida_em IS NOT NULL`,
        ),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'taxa_atendimento_ligacoes',
    nome: 'Taxa de atendimento das ligações',
    descricao: 'Ligações atendidas ÷ ligações feitas, no período.',
    grupo: 'LIGACOES',
    unidade: 'PERCENTUAL',
    visualizacoes: PADRAO,
    calculo: {
      ...LIGACAO,
      tempo: 'l.iniciada_em',
      onde: () =>
        Prisma.raw(
          `l.direcao = 'FEITA'::direcao_ligacao AND l.atendente_id IS NOT NULL`,
        ),
      a: () => contarOnde('l.atendida_em IS NOT NULL'),
      b: contar,
      formula: (a, b) => taxa(a ?? 0, b ?? 0),
    },
  }),
  indicador({
    chave: 'duracao_media_ligacao',
    nome: 'Duração média das ligações',
    descricao: 'Duração média das ligações atendidas no período.',
    grupo: 'LIGACOES',
    unidade: 'DURACAO',
    melhorQuando: null,
    visualizacoes: PADRAO,
    parametros: [PARAMETRO_DIRECAO],
    calculo: {
      ...LIGACAO,
      tempo: 'l.iniciada_em',
      onde: (p) => ligacoesComDuracao(p),
      a: () => Prisma.raw('avg(l.duracao_segundos)::float8'),
      formula: identidade,
      semAmostra: 'NULO',
    },
  }),
  indicador({
    chave: 'tempo_falado',
    nome: 'Tempo falado',
    descricao: 'Soma da duração das ligações atendidas no período.',
    grupo: 'LIGACOES',
    unidade: 'DURACAO',
    visualizacoes: PADRAO,
    parametros: [PARAMETRO_DIRECAO],
    calculo: {
      ...LIGACAO,
      tempo: 'l.iniciada_em',
      onde: (p) => ligacoesComDuracao(p),
      a: () => somar('l.duracao_segundos'),
      formula: (a) => a ?? 0,
    },
  }),

  // ----- Atividades -------------------------------------------------------
  indicador({
    chave: 'atividades_concluidas',
    nome: 'Atividades concluídas',
    descricao:
      'Atividades concluídas no período (sem notas), de um tipo ou de todos.',
    grupo: 'ATIVIDADES',
    unidade: 'NUMERO',
    visualizacoes: COM_BARRAS,
    barras: ['TIPO'],
    parametros: [
      {
        chave: 'tipo',
        rotulo: 'Tipo de atividade',
        tipo: 'TIPO_ATIVIDADE',
        obrigatorioEm: null,
        vale: null,
        opcoes: TIPOS_DE_ATIVIDADE,
        dica: 'Sem escolha, conta todos os tipos.',
      },
    ],
    calculo: {
      ...ATIVIDADE,
      tempo: 'a.concluida_em',
      onde: (p) =>
        p['tipo']
          ? Prisma.sql`a.status = 'CONCLUIDA'::status_atividade AND a.tipo = ${p['tipo']}::tipo_atividade`
          : Prisma.raw(
              `a.status = 'CONCLUIDA'::status_atividade AND a.tipo <> 'NOTA'::tipo_atividade`,
            ),
      a: contar,
      formula: identidade,
    },
  }),
  indicador({
    chave: 'atividades_atrasadas',
    nome: 'Atividades atrasadas',
    descricao:
      'Atividades pendentes com o prazo vencido, agora (sem notas e sem reuniões: a reunião passada aguarda resultado).',
    grupo: 'ATIVIDADES',
    unidade: 'NUMERO',
    melhorQuando: 'menor',
    visualizacoes: ['NUMERO', 'RANKING', 'BARRAS'],
    barras: ['TIPO'],
    calculo: {
      ...ATIVIDADE,
      tempo: null,
      onde: () =>
        Prisma.raw(
          // A mesma regra da aba "Atrasadas" da agenda (R6.3, `condicaoAtrasada` sem notas), para o número
          // bater com a lista que o clique abre (R20.2): a reunião vale pelo fim.
          `a.status = 'PENDENTE'::status_atividade AND a.tipo <> 'NOTA'::tipo_atividade AND (` +
            `(a.tipo <> 'REUNIAO'::tipo_atividade AND a.vence_em < now()) OR ` +
            `(a.tipo = 'REUNIAO'::tipo_atividade AND coalesce(a.fim_em, a.vence_em) < now()))`,
        ),
      a: contar,
      formula: identidade,
    },
  }),
];

function ligacoesComDuracao(p: Parametros): Prisma.Sql {
  const direcao =
    p['direcao'] === 'FEITA' || p['direcao'] === 'RECEBIDA'
      ? Prisma.sql` AND l.direcao = ${p['direcao']}::direcao_ligacao`
      : Prisma.empty;
  return Prisma.sql`l.atendida_em IS NOT NULL AND l.duracao_segundos IS NOT NULL${direcao}`;
}

const POR_CHAVE: ReadonlyMap<string, IndicadorDoCatalogo> = new Map(
  CATALOGO.map((item) => [item.chave, item]),
);

export function indicadorDoCatalogo(
  chave: string,
): IndicadorDoCatalogo | undefined {
  return POR_CHAVE.get(chave);
}

/** O catálogo como a API devolve (sem a parte de cálculo). */
export function catalogoPublico() {
  return CATALOGO.map(({ calculo: _calculo, ...publico }) => publico);
}
