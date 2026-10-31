/** Automações e cadências (R19, contrato da Onda B §2.5). */

/** Nome do destino de gatilhos e da agenda das automações. */
export const DESTINO_DE_GATILHO_AUTOMACOES = 'automacoes';

/** Código da regra nos erros (`detalhes.regra`). */
export const REGRA_AUTOMACOES = 'R19';

/** Varredura das agendas (data relativa, recorrência, negócio parado, atividade atrasada). */
export const AGENDA_DE_VARREDURA = '*/5 * * * *';

/** Sobreposição das janelas de varredura (a idempotência por `chaveUnica` absorve a repetição). */
export const SOBREPOSICAO_DA_VARREDURA_MS = 10 * 60_000;

/** Entidades por varredura/lote. */
export const LOTE_DA_VARREDURA = 500;

/** Critérios de parada (`automacoes.criterios_parada`). */
export const CRITERIOS_DE_PARADA = [
  'RESPONDEU',
  'GANHOU',
  'PERDEU',
  'SAIU_DO_SEGMENTO',
] as const;
export type CriterioDeParada = (typeof CRITERIOS_DE_PARADA)[number];

/** Eventos que cancelam execuções ativas (critérios de parada). */
export const EVENTOS_DE_PARADA = [
  'mensagem.recebida',
  'campanha.respondida',
  'negocio.ganho',
  'negocio.perdido',
] as const;

/** Tipos de passo das automações (registrados no `PassosService` para `AUTOMACAO`). */
export const TIPOS_DE_PASSO_DE_AUTOMACAO = {
  WHATSAPP: 'acao.whatsapp',
  EMAIL: 'acao.email',
  ATIVIDADE: 'acao.atividade',
  MOVER_ETAPA: 'acao.mover_etapa',
  ATRIBUIR: 'acao.atribuir',
  ETIQUETAR: 'acao.etiquetar',
  CRIAR_NEGOCIO: 'acao.criar_negocio',
  NOTIFICAR: 'acao.notificar',
  WEBHOOK: 'acao.webhook',
  CHATBOT: 'acao.chatbot',
  CONDICAO: 'condicao',
} as const;

/** Tipo de webhook de saída gravado nas entregas de `acao.webhook`. */
export const EVENTO_DE_WEBHOOK_DA_AUTOMACAO = 'automacao.acionada';

/** Máximo de automações por listagem de gatilho (segurança). */
export const MAXIMO_DE_AUTOMACOES_POR_EVENTO = 200;
