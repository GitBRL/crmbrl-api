/** Importação de contatos e empresas (R16, contrato da Onda B §2.2). */

/** Fila do processamento de uma importação (`{ importacaoId }`). */
export const FILA_IMPORTACAO = 'importacao.processar';

/** Linhas de dados por arquivo, no máximo. */
export const LIMITE_DE_LINHAS_DA_IMPORTACAO = 50_000;

/** Formatos aceitos (`importacoes.formato`). */
export const FORMATOS_DE_IMPORTACAO = ['csv', 'xlsx'] as const;
