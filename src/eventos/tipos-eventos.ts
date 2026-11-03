/**
 * Eventos de domínio da Fase 1 que os webhooks de saída podem assinar (R9.2).
 * Outros tipos podem ser publicados (ex.: `contato.reconvertido`) para uso
 * interno; estes são os oferecidos aos destinos externos.
 */
export const EVENTOS_DE_WEBHOOK = [
  'contato.criado',
  'contato.atualizado',
  'negocio.criado',
  'negocio.movido',
  'negocio.ganho',
  'negocio.perdido',
  'atividade.criada',
  'atividade.concluida',
  'usuario.desligado',
  // Onda C: Financeiro (R22).
  'contrato.criado',
  'contrato.atualizado',
  'contrato.suspenso',
  'contrato.reativado',
  'contrato.cancelado',
  'contrato.encerrado',
  'parcela.paga',
  'parcela.atrasada',
  // Onda E: Ligações (R29.9). Sem áudio nem transcrição; o resumo só se o Admin marcar no canal.
  'ligacao.encerrada',
  'webhook.teste',
] as const;

export type EventoDeWebhook = (typeof EVENTOS_DE_WEBHOOK)[number];

/** Tipo de um evento de domínio: os de webhook, com autocompletar, ou qualquer outro `entidade.verbo`. */
export type TipoEventoDominio = EventoDeWebhook | (string & {});

export function ehEventoDeWebhook(tipo: string): tipo is EventoDeWebhook {
  return (EVENTOS_DE_WEBHOOK as readonly string[]).includes(tipo);
}
