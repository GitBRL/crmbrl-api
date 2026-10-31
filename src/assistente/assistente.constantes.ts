/**
 * Assistente de ajuda por IA e chamados (R25): modelo, limites e tempos. O que
 * o Admin pode mudar fica em `configuracoes` (chave `assistente-ia`).
 */

/** Código da regra (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_ASSISTENTE = 'R25';

/** Modelo do Claude (o mesmo da análise do BI). */
export const MODELO_ASSISTENTE = 'claude-opus-5-5';

/**
 * Esforço do raciocínio: `low` (conversa de ajuda, respostas curtas e rápidas).
 * Fixo: trocar o esforço no meio da conversa invalida o cache.
 */
export const ESFORCO_ASSISTENTE = 'low' as const;

/** Teto de tokens de saída por resposta (raciocínio incluído). */
export const MAX_TOKENS_ASSISTENTE = 16_000;

/** Chave da linha em `configuracoes`. */
export const CHAVE_CONFIGURACAO_ASSISTENTE = 'assistente-ia';

/** Perguntas por pessoa por dia (fuso de São Paulo). 0 desliga o assistente. */
export const PERGUNTAS_POR_DIA_PADRAO = 30;
export const PERGUNTAS_POR_DIA_MAXIMO = 1000;

/**
 * Orçamento mensal de tokens (somando entrada, saída e cache, de todas as
 * pessoas). `null` = sem orçamento.
 */
export const ORCAMENTO_MENSAL_PADRAO = 20_000_000;
export const ORCAMENTO_MENSAL_MAXIMO = 10_000_000_000;

/** Tamanho da pergunta. */
export const MIN_CARACTERES_PERGUNTA = 2;
export const MAX_CARACTERES_PERGUNTA = 2000;

/** Perguntas por conversa (depois disso, uma conversa nova). */
export const MAX_PERGUNTAS_POR_CONVERSA = 30;

/** Pares pergunta/resposta anteriores reenviados ao modelo. */
export const HISTORICO_ENVIADO = 10;

/** Tamanho máximo gravado de cada campo da resposta. */
export const MAX_CARACTERES_RESPOSTA = 8000;
export const MAX_CARACTERES_RESUMO = 300;

/** Base de conhecimento: limites de leitura (avisam no log e no estado). */
export const MAX_CARACTERES_ARTIGO = 60_000;
export const MAX_CARACTERES_BASE = 600_000;

/** Intervalo mínimo entre dois eventos `parcial` do streaming. */
export const INTERVALO_PARCIAL_MS = 100;

/** Uma pergunta "em andamento" mais antiga que isto é tratada como abandonada. */
export const ANDAMENTO_ABANDONADO_MS = 2 * 120_000 * 2;

/** Aviso mostrado no painel (R25: as perguntas ficam registradas). */
export const AVISO_DE_REGISTRO =
  'As perguntas e as respostas ficam registradas e podem ser lidas pelo Admin para melhorar o CRM e a ajuda. ' +
  'Não escreva dados de clientes (nomes, telefones, documentos) nas perguntas.';

/** Categorias da resposta (saída estruturada). */
export const CATEGORIAS = [
  'duvida_de_uso',
  'funcionalidade_inexistente_no_escopo',
  'fora_do_escopo',
  'erro_do_sistema',
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** Categorias em que o painel oferece "Abrir chamado". */
export const CATEGORIAS_DE_CHAMADO: readonly Categoria[] = [
  'funcionalidade_inexistente_no_escopo',
  'erro_do_sistema',
];

export const ROTULO_DA_CATEGORIA: Readonly<Record<Categoria, string>> = {
  duvida_de_uso: 'Dúvida de uso',
  funcionalidade_inexistente_no_escopo: 'Funcionalidade que não existe',
  fora_do_escopo: 'Fora do escopo',
  erro_do_sistema: 'Erro do sistema',
};

// ---------------------------------------------------------------------------
// Chamados
// ---------------------------------------------------------------------------

/** Fila do envio dos chamados. */
export const FILA_CHAMADOS = 'assistente.enviar-chamado';

/** Tentativas de envio de um chamado (a 1ª e as novas). */
export const MAX_TENTATIVAS_CHAMADO = 6;

/** Espera antes de cada nova tentativa (depois da 1ª, 2ª… falha), em segundos. */
export const ESPERAS_DO_CHAMADO_S = [60, 300, 900, 3600, 3 * 3600];

/** Tempo limite de cada chamada HTTP ao destino. */
export const PRAZO_DO_DESTINO_MS = 15_000;

/** Limites do TicketHub (`server/src/routes/chamados.routes.js`). */
export const TITULO_TICKETHUB = { min: 3, max: 200 } as const;
export const DESCRICAO_TICKETHUB = { min: 6, max: 10_000 } as const;
export const PRIORIDADES_TICKETHUB = [
  'baixa',
  'media',
  'alta',
  'critica',
] as const;
export type PrioridadeTicketHub = (typeof PRIORIDADES_TICKETHUB)[number];

/** Tamanho do título e da descrição que a pessoa pode editar. */
export const MAX_CARACTERES_TITULO_CHAMADO = 200;
export const MAX_CARACTERES_DESCRICAO_CHAMADO = 4000;

/** Modelo do corpo do webhook. */
export const MAX_CARACTERES_MODELO_CORPO = 10_000;
export const MIN_CARACTERES_SEGREDO = 16;
