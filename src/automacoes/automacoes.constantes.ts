/** Automações e cadências (R19, contrato da Onda B §2.5). */

/** Nome do destino de gatilhos e da agenda das automações. */
export const DESTINO_DE_GATILHO_AUTOMACOES = 'automacoes';

/** Critérios de parada (`automacoes.criterios_parada`). */
export const CRITERIOS_DE_PARADA = [
  'RESPONDEU',
  'GANHOU',
  'PERDEU',
  'SAIU_DO_SEGMENTO',
] as const;
