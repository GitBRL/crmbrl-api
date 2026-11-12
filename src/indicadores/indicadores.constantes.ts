/**
 * Nomes e limites estáveis dos indicadores configuráveis (R33).
 */

/** Código da regra (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_INDICADORES = 'R33';

/** Máximo de indicadores (widgets) num painel. */
export const MAXIMO_DE_WIDGETS = 40;

/** Máximo de painéis ativos por pessoa dona (evita lixo; Admin e C-level também). */
export const MAXIMO_DE_PAINEIS_POR_DONO = 100;

/** Linhas de um ranking, de barras ou de uma tabela de widget. */
export const LIMITE_DE_LINHAS_DO_WIDGET = 50;

/** Cache de 30 s por pessoa e filtros (R20.6, igual ao BI). */
export const CACHE_INDICADORES_SEGUNDOS = 30;
export const CACHE_INDICADORES_MAXIMO = 300;

/** Tamanho máximo de nome, descrição e título. */
export const TAMANHO_NOME_PAINEL = 80;
export const TAMANHO_DESCRICAO_PAINEL = 300;
export const TAMANHO_TITULO_WIDGET = 80;

/** Valor máximo de uma meta (cabe em `numeric` e no JSON sem perda). */
export const META_MAXIMA = 1_000_000_000_000;
