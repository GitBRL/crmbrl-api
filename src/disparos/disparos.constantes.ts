/** Disparos — campanhas de WhatsApp e e-mail (R17, contrato da Onda B §2.3). */

/** Fila do envio de uma campanha (`{ campanhaId }`, com `startAfter` para o ritmo). */
export const FILA_DISPAROS_ENVIAR = 'disparos.enviar';

/** Chave da configuração do módulo em `configuracoes`. */
export const CHAVE_CONFIGURACAO_DISPAROS = 'disparos';

/** Palavras de saída padrão (opt-out, R4.6), comparadas sem acento nem caixa. */
export const PALAVRAS_DE_SAIDA_PADRAO = ['SAIR', 'PARAR', 'CANCELAR'] as const;
