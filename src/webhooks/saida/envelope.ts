/**
 * Envelope, cabeçalhos e assinatura das entregas (R9.3), e a agenda das novas
 * tentativas (R9.4). Funções puras.
 *
 * Como o destino confere a assinatura:
 *
 * ```js
 * const esperado = 'sha256=' + createHmac('sha256', segredo)
 *   .update(`${req.headers['x-crm-timestamp']}.${corpoBruto}`)
 *   .digest('hex');
 * // compare em tempo constante com req.headers['x-crm-assinatura']
 * // e use o `id` do envelope para não processar o mesmo evento duas vezes (R9.6)
 * ```
 */
import {
  AGENTE_DO_ENVIO,
  ESPERAS_ENTRE_TENTATIVAS_SEGUNDOS,
  MAXIMO_DE_TENTATIVAS_DE_ENTREGA,
} from '../webhooks.constantes';

/** Envelope de todo evento entregue (R9.3). */
export interface Envelope {
  /** Id do evento (o mesmo em todos os destinos): use para deduplicar (R9.6). */
  readonly id: string;
  readonly evento: string;
  /** ISO 8601. */
  readonly ocorridoEm: string;
  readonly dados: unknown;
}

export function montarEnvelope(evento: {
  id: string;
  tipo: string;
  ocorridoEm: Date;
  dados: unknown;
}): Envelope {
  return {
    id: evento.id,
    evento: evento.tipo,
    ocorridoEm: evento.ocorridoEm.toISOString(),
    dados: evento.dados ?? {},
  };
}

/**
 * O envelope gravado (`webhook_entregas.payload`, em `jsonb`) volta com as
 * chaves em outra ordem: o corpo enviado é montado sempre na ordem do
 * contrato. A assinatura é calculada sobre exatamente estes bytes.
 */
export function serializarEnvelope(payload: unknown): string {
  const registro = (
    typeof payload === 'object' && payload !== null ? payload : {}
  ) as Partial<Envelope>;
  return JSON.stringify({
    id: registro.id,
    evento: registro.evento,
    ocorridoEm: registro.ocorridoEm,
    dados: registro.dados ?? {},
  });
}

/** O texto assinado (R9.3): `timestamp + "." + corpo`. */
export function conteudoAssinado(timestamp: string, corpo: string): string {
  return `${timestamp}.${corpo}`;
}

/** Valor de `X-CRM-Assinatura` a partir do HMAC-SHA256 em hexadecimal. */
export function formatarAssinatura(hmacHex: string): string {
  return `sha256=${hmacHex}`;
}

/**
 * Cabeçalhos de uma tentativa: os extras do destino primeiro e, por cima, os
 * do CRM (`Content-Type`, `User-Agent`, `X-CRM-*`), que um extra não pode
 * substituir.
 */
export function cabecalhosDaEntrega(dados: {
  evento: string;
  entregaId: string;
  timestamp: string;
  assinatura: string;
  extras?: Readonly<Record<string, string>>;
  /** Formato Clint com GET: sem corpo, sem `Content-Type`. */
  semCorpo?: boolean;
}): Record<string, string> {
  return {
    ...dados.extras,
    ...(dados.semCorpo
      ? {}
      : { 'Content-Type': 'application/json; charset=utf-8' }),
    'User-Agent': AGENTE_DO_ENVIO,
    'X-CRM-Evento': dados.evento,
    'X-CRM-Entrega': dados.entregaId,
    'X-CRM-Timestamp': dados.timestamp,
    'X-CRM-Assinatura': dados.assinatura,
  };
}

/** Segundos desde 1970 (o valor de `X-CRM-Timestamp`). */
export function timestampDoEnvio(agora: Date): string {
  return String(Math.floor(agora.getTime() / 1000));
}

/**
 * Quando tentar de novo depois da `tentativa`-ésima falha (R9.4): 1 min, 5 min,
 * 30 min, 2 h, 6 h e 24 h depois. `null` quando as 7 tentativas acabaram.
 */
export function proximaTentativaDepoisDe(
  tentativa: number,
  agora: Date,
): Date | null {
  if (tentativa < 1 || tentativa >= MAXIMO_DE_TENTATIVAS_DE_ENTREGA) {
    return null;
  }
  const espera = ESPERAS_ENTRE_TENTATIVAS_SEGUNDOS[tentativa - 1];
  return new Date(agora.getTime() + espera * 1000);
}
