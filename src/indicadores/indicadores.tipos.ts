import type { Papel } from '../generated/prisma/client';

export const GRUPOS = [
  'LEADS',
  'REUNIOES',
  'VENDAS',
  'LIGACOES',
  'ATIVIDADES',
] as const;
export type Grupo = (typeof GRUPOS)[number];

export const ROTULO_DO_GRUPO: Readonly<Record<Grupo, string>> = {
  LEADS: 'Leads',
  REUNIOES: 'Reuniões',
  VENDAS: 'Vendas',
  LIGACOES: 'Ligações e mensagens',
  ATIVIDADES: 'Atividades',
};

/** `DURACAO` é sempre em segundos. */
export const UNIDADES = ['NUMERO', 'PERCENTUAL', 'MOEDA', 'DURACAO'] as const;
export type Unidade = (typeof UNIDADES)[number];

export const VISUALIZACOES = [
  'NUMERO',
  'SERIE',
  'RANKING',
  'POR_ETAPA',
  'BARRAS',
  'FUNIL',
] as const;
export type Visualizacao = (typeof VISUALIZACOES)[number];

export const AGRUPAMENTOS = ['DIA', 'SEMANA', 'MES'] as const;
export type Agrupamento = (typeof AGRUPAMENTOS)[number];

export const PERIODOS = [
  'HOJE',
  'ULTIMOS_7_DIAS',
  'ULTIMOS_30_DIAS',
  'MES_ATUAL',
  'MES_ANTERIOR',
  'TRIMESTRE',
  'ANO',
  'PERSONALIZADO',
] as const;
export type TipoDePeriodo = (typeof PERIODOS)[number];

/** Tipos de parâmetro de um indicador (a tela escolhe o campo certo). */
export type TipoDeParametro =
  | 'ETAPA'
  | 'FUNIL'
  | 'TIPO_ATIVIDADE'
  | 'ESTATISTICA'
  | 'DIRECAO'
  | 'AGRUPAMENTO'
  | 'POR';

export interface OpcaoDeParametro {
  valor: string;
  rotulo: string;
}

export interface ParametroDoIndicador {
  chave: string;
  rotulo: string;
  tipo: TipoDeParametro;
  /** Obrigatório nestas visualizações (`null` = em todas). */
  obrigatorioEm: readonly Visualizacao[] | null;
  /** Só tem sentido nestas visualizações (`null` = em todas). */
  vale: readonly Visualizacao[] | null;
  opcoes?: readonly OpcaoDeParametro[];
  padrao?: string;
  dica: string;
}

export type Parametros = Readonly<Record<string, string | undefined>>;

/** Meta de um widget (R33.5), na unidade do indicador (duração em segundos). */
export interface MetaDoWidget {
  geral?: number | null;
  porPessoa?: number | null;
}

export interface FiltrosPeriodo {
  tipo: TipoDePeriodo;
  de?: string;
  ate?: string;
}

/** Filtros do painel ou do widget, como guardados e recebidos (R33.3). */
export interface FiltrosDoIndicador {
  periodo?: FiltrosPeriodo;
  comparar?: boolean;
  funilIds?: string[];
  etapaIds?: string[];
  setor?: string;
  equipeId?: string;
  pessoaIds?: string[];
  origens?: string[];
  utmSource?: string[];
  utmCampaign?: string[];
  etiquetas?: string[];
}

export interface Widget {
  id: string;
  indicador: string;
  parametros: Record<string, string>;
  visualizacao: Visualizacao;
  titulo?: string;
  filtros?: FiltrosDoIndicador;
  meta?: MetaDoWidget;
  /** 1 a 3 colunas da grade. */
  largura: 1 | 2 | 3;
  ordem: number;
}

export interface Compartilhamento {
  setores: string[];
  pessoas: string[];
  papeis: Papel[];
}

/** Filtros já validados e resolvidos (datas como `Date`, listas normalizadas; `null` = sem filtro). */
export interface FiltroResolvido {
  de: Date;
  ate: Date;
  anteriorDe: Date | null;
  anteriorAte: Date | null;
  comparar: boolean;
  pessoas: string[] | null;
  funilIds: string[] | null;
  etapaIds: string[] | null;
  setor: string | null;
  origens: string[] | null;
  utmSource: string[] | null;
  utmCampaign: string[] | null;
  etiquetas: string[] | null;
  /** O que a tela mostra como "filtros aplicados". */
  aplicados: Record<string, unknown>;
}

/** Descreve a lista que sustenta o número (R20.8): a tela monta o endereço. */
export interface CliqueDoWidget {
  lista: 'NEGOCIOS' | 'ATIVIDADES';
  filtros: Record<string, unknown>;
}

export interface LinhaDoWidget {
  /** Id da pessoa, da etapa ou da chave da barra (para o clique). */
  id: string | null;
  rotulo: string;
  valor: number | null;
  /** Funil: conversão sobre a linha anterior (%) e sobre a primeira (%). */
  conversao?: number | null;
  conversaoTotal?: number | null;
  tipo?: string | null;
  meta?: ProgressoDeMeta | null;
}

export interface ProgressoDeMeta {
  alvo: number;
  /** Percentual do alvo já alcançado (pode passar de 100). */
  progresso: number | null;
  atingida: boolean;
}

export interface PontoDaSerie {
  chave: string;
  rotulo: string;
  valor: number | null;
  anterior?: number | null;
}

export interface ResultadoDoWidget {
  id: string;
  indicador: string;
  nome: string;
  visualizacao: Visualizacao;
  titulo: string;
  unidade: Unidade;
  melhorQuando: 'maior' | 'menor' | null;
  largura: 1 | 2 | 3;
  ordem: number;
  periodo: { de: string; ate: string } | null;
  anterior: { de: string; ate: string } | null;
  ok: boolean;
  erro?: { mensagem: string; status: number };
  valor?: number | null;
  valorAnterior?: number | null;
  variacao?: number | null;
  meta?: ProgressoDeMeta | null;
  agrupamento?: Agrupamento;
  por?: string;
  funil?: { id: string; nome: string; area: string } | null;
  pontos?: PontoDaSerie[];
  linhas?: LinhaDoWidget[];
  clique?: CliqueDoWidget | null;
}
