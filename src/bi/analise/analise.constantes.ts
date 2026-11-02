/**
 * Análise do BI por IA (R21): modelo, limites e tempos. Os valores que o Admin
 * pode mudar (limite diário) ficam em `configuracoes` (chave `analise-ia`).
 */

/** Código da regra (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_ANALISE = 'R21';

/** Modelo do Claude usado na análise e nas perguntas. */
export const MODELO_ANALISE = 'claude-opus-5-5';

/**
 * Esforço do raciocínio (adaptativo). `medium` é o padrão do modelo; fica
 * explícito para não mudar sem querer (e é o mesmo nas perguntas: trocar o
 * esforço no meio da conversa invalida o cache).
 */
export const ESFORCO_ANALISE = 'medium' as const;

/** Teto de tokens de saída por resposta (raciocínio incluído). */
export const MAX_TOKENS_ANALISE = 32_000;

/** Tempo máximo de uma tentativa (a resposta inteira, não só o primeiro byte). */
export const TIMEOUT_ANALISE_MS = 120_000;

/** Tentativas por pedido: a primeira e uma nova em caso de falha transitória. */
export const TENTATIVAS_ANALISE = 2;

/** Espera antes da nova tentativa. */
export const ESPERA_ENTRE_TENTATIVAS_MS = 1_500;

/** Chave da linha em `configuracoes`. */
export const CHAVE_CONFIGURACAO_ANALISE = 'analise-ia';

/** Análises por dia (no fuso de São Paulo), somando todos os Admins. */
export const LIMITE_DIARIO_PADRAO = 20;
export const LIMITE_DIARIO_MAXIMO = 1000;

/** Perguntas de acompanhamento por análise. */
export const MAX_PERGUNTAS_POR_ANALISE = 5;

/** Tamanho máximo de uma pergunta. */
export const MAX_CARACTERES_PERGUNTA = 1000;

/** Intervalo mínimo entre dois eventos `parcial` do streaming. */
export const INTERVALO_PARCIAL_MS = 120;

/** Comentário SSE para manter a conexão viva enquanto o modelo pensa. */
export const INTERVALO_BATIMENTO_MS = 15_000;

/** Linhas por tabela enviadas ao modelo (as séries longas já vêm resumidas). */
export const MAX_LINHAS_POR_TABELA = 60;

/** Uma análise "em andamento" mais antiga que isto é tratada como abandonada. */
export const ANDAMENTO_ABANDONADO_MS =
  2 * TIMEOUT_ANALISE_MS * TENTATIVAS_ANALISE;

/** Texto para quem ainda não configurou a chave. */
export const COMO_CONFIGURAR =
  'Defina a variável ANTHROPIC_API_KEY no arquivo .env da API com uma chave criada em console.anthropic.com ' +
  '(Settings → API Keys) e reinicie a API (docker compose up -d). A chave fica só no servidor: nunca aparece na tela nem nos logs.';
