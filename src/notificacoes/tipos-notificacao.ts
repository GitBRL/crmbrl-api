/**
 * Tipos de notificação interna da Fase 1 (R10.2). Use estas constantes no campo
 * `tipo` — o front escolhe ícone e texto a partir delas.
 */
export const TIPOS_NOTIFICACAO = {
  /** Lead ou negócio atribuído a alguém (webhook, rodízio, atribuição manual). */
  NEGOCIO_ATRIBUIDO: 'negocio.atribuido',
  /** Contato passou a ser de alguém por ação de outra pessoa (R4.5). */
  CONTATO_ATRIBUIDO: 'contato.atribuido',
  /** Empresa passou a ser de alguém por ação de outra pessoa (R4.5). */
  EMPRESA_ATRIBUIDA: 'empresa.atribuida',
  /** Negócio recebido por passagem entre funis (R5.7). */
  PASSAGEM_RECEBIDA: 'passagem.recebida',
  /** Itens encaminhados por desligamento (R7.4). */
  ITENS_ENCAMINHADOS: 'desligamento.itens_recebidos',
  /** Atividade vence em 1 hora (R6.5). */
  ATIVIDADE_VENCENDO: 'atividade.vencendo',
  /** Atividade atrasou (R6.5). */
  ATIVIDADE_ATRASADA: 'atividade.atrasada',
  /** Entrega de webhook de saída falhou de vez (Admin, R9.4). */
  WEBHOOK_SAIDA_FALHOU: 'webhook_saida.falhou',
  /** Destino desativado automaticamente após 20 falhas seguidas (Admin, R9.4). */
  WEBHOOK_SAIDA_DESATIVADO: 'webhook_saida.desativado',
  /** Integração com a credencial recusada pelo aplicativo: precisa de atenção (Admin, R32.9). */
  INTEGRACAO_PRECISA_ATENCAO: 'integracao.precisa_atencao',
  /** Líder desligado deixou a equipe sem líder (Admin, R7.3). */
  EQUIPE_SEM_LIDER: 'equipe.sem_lider',
} as const;

export type TipoNotificacao =
  (typeof TIPOS_NOTIFICACAO)[keyof typeof TIPOS_NOTIFICACAO];
