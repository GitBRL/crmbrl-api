/**
 * Nomes estáveis do módulo de atendimento: código da regra, filas do pg-boss,
 * eventos de domínio e tipos de notificação (R12).
 */

/** Código da regra do Atendimento (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_ATENDIMENTO = 'R12';

/** Fila de envio das mensagens de saída (um job por mensagem). */
export const FILA_ENVIO_ATENDIMENTO = 'atendimento.enviar';

/** Varredura do SLA (a cada minuto): avisa o líder quando um prazo estoura. */
export const FILA_SLA_ATENDIMENTO = 'atendimento.sla';

/** Retentativas do envio depois da primeira falha passageira (com espera crescente). */
export const RETENTATIVAS_DE_ENVIO = 3;

/** Primeira espera entre tentativas de envio, em segundos (dobra a cada vez). */
export const ESPERA_ENTRE_ENVIOS_SEGUNDOS = 15;

/**
 * Evento interno da outbox: depois do commit, recalcula a contagem do menu
 * (`nao-lidas.atendimento`) de quem está conectado e foi afetado.
 */
export const EVENTO_CONTAGENS_ATENDIMENTO = 'atendimento.contagens';

/** Eventos de domínio do Atendimento (outbox, uso interno e futuras automações). */
export const EVENTOS_DO_ATENDIMENTO = {
  MENSAGEM_RECEBIDA: 'mensagem.recebida',
  MENSAGEM_ENVIADA: 'mensagem.enviada',
  CONVERSA_CRIADA: 'conversa.criada',
  CONVERSA_ATRIBUIDA: 'conversa.atribuida',
  CONVERSA_TRANSFERIDA: 'conversa.transferida',
  CONVERSA_RESOLVIDA: 'conversa.resolvida',
  CONVERSA_REABERTA: 'conversa.reaberta',
  CONVERSA_AVALIADA: 'conversa.avaliada',
  /** Uma pessoa da equipe escreveu ao contato (o SDR com IA, R31, para de responder). */
  MENSAGEM_DA_EQUIPE: 'conversa.mensagem_da_equipe',
} as const;

/**
 * Tipos de notificação do Atendimento (o front escolhe o ícone pelo prefixo
 * `conversa.`). O `link` leva a `/atendimento/<conversaId>`.
 */
export const TIPOS_NOTIFICACAO_ATENDIMENTO = {
  /** Conversa nova (ou reaberta) distribuída para a pessoa. */
  CONVERSA_ATRIBUIDA: 'conversa.atribuida',
  /** Alguém transferiu a conversa para a pessoa. */
  CONVERSA_TRANSFERIDA: 'conversa.transferida',
  /** Mensagem nova do contato (a primeira não lida, com a pessoa fora do CRM). */
  MENSAGEM_RECEBIDA: 'conversa.mensagem_recebida',
  /** Conversas recebidas pelo desligamento de alguém (R7). */
  CONVERSAS_ENCAMINHADAS: 'conversa.encaminhadas',
  /** Nota interna de outra pessoa numa conversa que está com a pessoa. */
  NOTA_INTERNA: 'conversa.nota_interna',
  /** Líder: o prazo da primeira resposta estourou (R12). */
  SLA_PRIMEIRA_RESPOSTA: 'conversa.sla_primeira_resposta',
  /** Líder: o prazo de resolução estourou (R12). */
  SLA_RESOLUCAO: 'conversa.sla_resolucao',
  /** Líder: o contato deu nota baixa (1 ou 2) na pesquisa de satisfação. */
  AVALIACAO_BAIXA: 'conversa.avaliacao_baixa',
} as const;

/** Rota da conversa no front. */
export function linkDaConversa(conversaId: string): string {
  return `/atendimento/${conversaId}`;
}

/** Corta um texto para notificações e resumos. */
export function resumir(
  texto: string | null | undefined,
  tamanho = 120,
): string {
  const limpo = (texto ?? '').replace(/\s+/g, ' ').trim();
  return limpo.length > tamanho ? `${limpo.slice(0, tamanho - 1)}…` : limpo;
}
