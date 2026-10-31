/** Financeiro (Onda C, §2.3): contratos, parcelas e régua de cobrança (R22–R24). */

/** Fuso das datas do Financeiro (vencimentos, régua, indicadores). */
export const FUSO_DO_FINANCEIRO = 'America/Sao_Paulo';

/** Configuração do módulo (`configuracoes.financeiro`). */
export const CHAVE_CONFIGURACAO_FINANCEIRO = 'financeiro';

/** Fila do envio de uma mensagem da régua (WhatsApp): própria, em paralelo com as campanhas. */
export const FILA_REGUA_WHATSAPP = 'financeiro.regua.whatsapp';
/** Fila do envio de e-mail da régua. */
export const FILA_REGUA_EMAIL = 'financeiro.regua.email';
/** Cron que decide a execução diária da régua, o atraso das parcelas e as pendências de ligação. */
export const FILA_REGUA_AGENDA = 'financeiro.regua.agenda';
/** A cada 15 minutos: confere se chegou o horário da régua (padrão 09:00). */
export const AGENDA_DA_REGUA = '*/15 * * * *';

export const DESCRICAO_DO_ATOR_DA_REGUA = 'Régua de cobrança';

/** Máximo de parcelas geradas de uma vez por contrato. */
export const LIMITE_DE_PARCELAS_GERADAS = 120;

/** Faixas de inadimplência em dias de atraso (R23.2). */
export const FAIXAS_DE_ATRASO = ['0-30', '31-60', '61-90', '90+'] as const;
export type FaixaDeAtraso = (typeof FAIXAS_DE_ATRASO)[number];

/** Marcos (dias a partir do vencimento) das etapas padrão (R24.1). */
export const MARCOS_PADRAO = [-7, -3, 0, 3, 5, 7, 15, 30, 45, 60] as const;

/** Etiqueta/campo do contato que impede cobrança por WhatsApp (R24.7). */
export const ETIQUETA_NAO_CONTATAR_WHATSAPP = 'nao-contatar-whatsapp';
export const CAMPO_NAO_CONTATAR_WHATSAPP = 'nao_contatar_whatsapp';

/** Variáveis do título aceitas nos textos da régua (R24.1). */
export const VARIAVEIS_DO_TITULO = [
  'titulo.numero',
  'titulo.valor',
  'titulo.vencimento',
  'titulo.dias_atraso',
  'titulo.descricao',
  'titulo.link_boleto',
  'titulo.link_pagamento',
  'titulo.pix',
  'titulo.promessa',
  'contrato.produto',
] as const;
