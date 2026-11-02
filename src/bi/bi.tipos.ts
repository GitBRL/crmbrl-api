import type { Area } from '../generated/prisma/client';

export type PainelBi =
  'marketing' | 'comercial' | 'cs' | 'atendimento' | 'financeiro';

export const PAINEIS_BI: readonly PainelBi[] = [
  'marketing',
  'comercial',
  'cs',
  'atendimento',
  'financeiro',
];

export type UnidadeBi =
  'numero' | 'moeda' | 'percentual' | 'segundos' | 'dias' | 'nota';

/** Cartão de indicador: valor do período, o do período anterior e a variação. */
export interface CartaoBi {
  chave: string;
  rotulo: string;
  valor: number | null;
  /** `null` para indicadores "de agora" (sem comparação) ou quando a comparação está desligada. */
  anterior: number | null;
  /** Variação percentual sobre o anterior; `null` se não há anterior ou ele é zero. */
  variacao: number | null;
  unidade: UnidadeBi;
  /** Para pintar a variação: `maior` = subir é bom, `menor` = descer é bom, `null` = neutro. */
  melhorQuando: 'maior' | 'menor' | null;
  /** Dica curta que explica a métrica. */
  dica: string;
}

export type TipoColunaBi =
  | 'texto'
  | 'numero'
  | 'moeda'
  | 'percentual'
  | 'segundos'
  | 'dias'
  | 'nota'
  | 'data'
  | 'id';

export interface ColunaBi {
  chave: string;
  rotulo: string;
  tipo: TipoColunaBi;
  /** `false` para colunas de apoio (ids para o clique no gráfico), que a exportação omite. */
  visivel: boolean;
}

export type CelulaBi = string | number | boolean | null;

/** Tabela de um painel: serve ao gráfico, à tabela da tela e à exportação. */
export interface TabelaBi {
  chave: string;
  titulo: string;
  dica: string;
  colunas: ColunaBi[];
  linhas: Record<string, CelulaBi>[];
}

export interface PeriodoBi {
  de: string;
  ate: string;
}

/** O que cada serviço de painel devolve (o `BiService` acrescenta o envelope). */
export interface ConteudoDoPainel {
  cartoes: CartaoBi[];
  tabelas: Record<string, TabelaBi>;
  /** Apoio para a tela (funil usado, faixas…). */
  meta: Record<string, unknown>;
}

export interface PainelCalculado extends ConteudoDoPainel {
  painel: PainelBi;
  periodo: PeriodoBi;
  anterior: PeriodoBi | null;
  geradoEm: string;
  filtros: FiltrosAplicados;
}

export interface FiltrosAplicados {
  area: Area | null;
  equipeId: string | null;
  pessoaId: string | null;
  funilId: string | null;
  canalId: string | null;
  filaId: string | null;
  comparar: boolean;
}

/** Filtros já validados e resolvidos (períodos com `Date`, pessoas como lista de ids). */
export interface FiltroResolvido {
  de: Date;
  ate: Date;
  anteriorDe: Date | null;
  anteriorAte: Date | null;
  area: Area | null;
  /** Ids permitidos pelos filtros de equipe e pessoa; `null` = sem filtro de pessoa. */
  pessoas: string[] | null;
  funilId: string | null;
  canalId: string | null;
  filaId: string | null;
  aplicados: FiltrosAplicados;
}
