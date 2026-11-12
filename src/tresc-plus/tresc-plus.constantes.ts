/** 3C+ (Onda T, R34): constantes compartilhadas. */

export const REGRA_TRESC_PLUS = 'R34';

/** URL padrão da API REST do 3C+ (swagger oficial: host 3c.plus, basePath /api/v1). */
export const URL_API_PADRAO = 'https://3c.plus/api/v1';
/** Caminho padrão do socket.io. */
export const CAMINHO_SOCKET_PADRAO = '/socket.io';

/** Formatos do envelope dos eventos do socket (lacuna da referência: o real só se confirma com a conta). */
export const FORMATOS_DE_ENVELOPE = ['AUTO', 'EVENTO_DADOS', 'OBJETO'] as const;
export type FormatoDeEnvelope = (typeof FORMATOS_DE_ENVELOPE)[number];

/** Filas (pg-boss). */
export const FILA_RECONCILIAR = 'tresc-plus.reconciliar';
export const FILA_BAIXAR_GRAVACAO = 'tresc-plus.baixar-gravacao';
export const FILA_LIMPAR_EVENTOS = 'tresc-plus.limpar-eventos';

/** Cron da reconciliação padrão: a cada 10 minutos. */
export const AGENDA_DA_LIMPEZA = '40 3 * * *';

/** Eventos antigos de dedupe saem depois deste prazo (dias). */
export const DIAS_DE_DEDUPE = 7;

/** A reconciliação olha as chamadas das últimas horas. */
export const JANELA_DA_RECONCILIACAO_HORAS = 6;

/** Timeout de cada chamada HTTP ao 3C+ (ms). */
export const TIMEOUT_HTTP_MS = 15_000;
/** Tentativas e espera base do backoff do cliente HTTP (429 e 5xx). */
export const TENTATIVAS_HTTP = 3;
export const ESPERA_BASE_HTTP_MS = 400;

/** Backoff da reconexão do socket (ms): base, teto e fator de variação. */
export const RECONEXAO_BASE_MS = 1_000;
export const RECONEXAO_TETO_MS = 60_000;

/** Tamanho máximo de uma gravação baixada do 3C+ quando o ambiente não limita (bytes). */
export const GRAVACAO_MAX_BYTES_PADRAO = 100 * 1024 * 1024;

/** Máximo de contatos/negócios por envio ao discador. */
export const LIMITE_ENVIO_DISCADOR = 500;

/** Nomes dos eventos do socket que o CRM trata (referência §5). */
export const EVENTOS_DE_CHAMADA = [
  'call-was-created',
  'call-was-answered',
  'call-was-connected',
  'call-was-ended',
  'call-was-finished',
  'call-was-abandoned',
  'call-was-abandoned-due-amd',
  'call-was-not-answered',
  'call-was-failed',
  'manual-call-acw-connected',
  'manual-call-acw-disconnected',
] as const;

export const EVENTOS_DE_AGENTE = [
  'agent-is-idle',
  'agent-in-acw',
  'agent-login-failed',
  'agent-was-logged-out',
  'agent-entered-manual',
  'agent-failed-to-enter-manual',
  'agent-left-manual-mode',
  'agent-entered-manual-acw',
  'agent-left-manual-acw',
  'agent-entered-work-break',
  'agent-enter-work-break-failed',
  'agent-left-work-break',
] as const;

export const EVENTO_HISTORICO = 'call-history-was-created';

/** Estados do agente que a API devolve (derivados dos eventos). */
export type EstadoDoAgente =
  | 'desconectado'
  | 'ocioso'
  | 'manual'
  | 'em_ligacao'
  | 'pos_atendimento'
  | 'pausa';
