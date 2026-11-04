/**
 * Constantes dos webhooks de entrada (R8) e de saída (R9): filas, limites e
 * travas. Ficam juntas para ser fácil conferir com as regras.
 */

// ---------------------------------------------------------------------------
// Entrada (R8)
// ---------------------------------------------------------------------------

/** Fila que processa cada recebimento (R8.4). */
export const FILA_PROCESSAR_RECEBIMENTO = 'webhooks-entrada.processar';

/** Tentativas de processamento de um recebimento, contando a primeira (R8.4). */
export const TENTATIVAS_DE_PROCESSAMENTO = 3;

/**
 * Itens (leads) processados por recebimento: um corpo com milhares de leads
 * ocuparia o banco e o worker além do prazo do job. Os que passam do limite
 * ficam registrados como ignorados, com o aviso (R32.2).
 */
export const MAXIMO_DE_ITENS_POR_RECEBIMENTO = 100;

/** Espera antes de tentar processar de novo (com espera exponencial), em segundos. */
export const ESPERA_ENTRE_PROCESSAMENTOS_SEGUNDOS = 30;

/** Tamanho do token da URL (R8.2): 32 bytes aleatórios, em base64url (43 caracteres). */
export const BYTES_DO_TOKEN = 32;

/** Formato aceito no `:token` da rota pública (fora dele, 404 sem consultar o banco). */
export const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** Caracteres do começo do token guardados para reconhecer o endereço na tela. */
export const TAMANHO_DO_PREFIXO_DO_TOKEN = 8;

/** Corpo máximo aceito (R8.2), conferido pelo corpo bruto. */
export const BYTES_MAXIMOS_DO_CORPO = 256 * 1024;

/** Limite de chamadas por ponto de entrada numa janela de 1 minuto (R8.7). */
export const CHAMADAS_POR_MINUTO = 60;
export const JANELA_DO_LIMITE_MS = 60_000;

/** Trava consultiva que serializa os recebimentos de um ponto (limite de chamadas, R8.7). */
export const TRAVA_RECEBIMENTO = 'webhook-entrada-recebimento';

/** Trava do nome dos pontos de entrada e dos destinos (nome único entre os não excluídos). */
export const TRAVA_NOME_ENTRADA = 'webhook-entrada-nome';
export const TRAVA_NOME_SAIDA = 'webhook-saida-nome';

/** Trava consultiva de um evento de entrada (integração + chave de idempotência, R32.15): o mesmo evento não se processa em paralelo. */
export const TRAVA_EVENTO_DE_ENTRADA = 'webhook-entrada-evento';

/** Segredo HMAC informado pelo Admin (R8.3): tamanho aceito. */
export const TAMANHO_MINIMO_SEGREDO = 16;
export const TAMANHO_MAXIMO_SEGREDO = 200;

/** Bytes do segredo gerado pelo sistema (entrada e saída). */
export const BYTES_DO_SEGREDO = 32;

export const TAMANHO_MAXIMO_NOME_WEBHOOK = 100;

// ---------------------------------------------------------------------------
// Saída (R9)
// ---------------------------------------------------------------------------

/** Fila de cada tentativa de entrega (R9.4). */
export const FILA_ENTREGAR = 'webhooks-saida.entregar';

/** Tempo limite de cada envio (R9.3). */
export const PRAZO_DO_ENVIO_MS = 10_000;

/** Tempo máximo para resolver o nome do destino (proteção contra SSRF, R9.1). */
export const PRAZO_DO_DNS_MS = 5_000;

/** Bytes da resposta guardados em cada tentativa (R9.5). */
export const BYTES_DO_TRECHO_DA_RESPOSTA = 2 * 1024;

/**
 * Esperas entre uma tentativa que falhou e a seguinte (R9.4): 1 min, 5 min,
 * 30 min, 2 h, 6 h e 24 h. Depois da última, a entrega é marcada como falha.
 */
export const ESPERAS_ENTRE_TENTATIVAS_SEGUNDOS = [
  60, 300, 1_800, 7_200, 21_600, 86_400,
] as const;

/** Tentativas de uma entrega: a primeira e as seis novas tentativas (R9.4). */
export const MAXIMO_DE_TENTATIVAS_DE_ENTREGA =
  ESPERAS_ENTRE_TENTATIVAS_SEGUNDOS.length + 1;

/** Falhas seguidas que desativam o destino automaticamente (R9.4). */
export const FALHAS_PARA_DESATIVAR = 20;

/**
 * Uma tentativa "em andamento" há mais que isto é considerada perdida (a API
 * caiu no meio) e pode ser retomada pela retentativa do job.
 */
export const PRAZO_DA_TENTATIVA_EM_ANDAMENTO_MS = 2 * 60_000;

/** Cabeçalhos extras de um destino (R9.1). */
export const CABECALHOS_EXTRAS_MAXIMOS = 20;
export const TAMANHO_MAXIMO_NOME_CABECALHO = 100;
export const TAMANHO_MAXIMO_VALOR_CABECALHO = 2_000;
export const TAMANHO_MAXIMO_URL = 2_000;

/** `User-Agent` dos envios. */
export const AGENTE_DO_ENVIO = 'CRM-BRL-Webhooks/1.0';

/** Evento de teste (R9.2, R9.5): enviado só ao destino testado. */
export const EVENTO_DE_TESTE = 'webhook.teste';
