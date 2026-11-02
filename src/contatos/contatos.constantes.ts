import type { OrigemContato } from '../generated/prisma/client';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';

/**
 * Chaves das travas consultivas (`travarChave`). Toda gravação de e-mail ou
 * telefone de contato e de CNPJ de empresa trava a chave antes de procurar:
 * duas transações com o mesmo valor se enfileiram, e a segunda encontra o que
 * a primeira gravou (R4.2, R4.4). O índice único parcial é a última barreira.
 */
export const TRAVA_EMAIL_DO_CONTATO = 'contato-email';
export const TRAVA_TELEFONE_DO_CONTATO = 'contato-telefone';
export const TRAVA_CNPJ_DA_EMPRESA = 'empresa-cnpj';
/** Empresa criada pelo nome na deduplicação (webhooks): o mesmo nome não vira duas empresas. */
export const TRAVA_NOME_DA_EMPRESA = 'empresa-nome';

export const TAMANHO_MAXIMO_NOME = 200;
/** Cargo, detalhe da origem, segmento, cidade, origem do consentimento. */
export const TAMANHO_MAXIMO_TEXTO_CURTO = 200;
export const TAMANHO_MAXIMO_SITE = 500;
export const TAMANHO_MAXIMO_MOTIVO = 500;
export const TAMANHO_MAXIMO_BUSCA = 200;

/** Campos personalizados (R4.7): limites do objeto JSON aceito na entrada. */
export const CHAVES_MAXIMAS_CAMPOS_PERSONALIZADOS = 200;
export const TAMANHO_MAXIMO_CHAVE_PERSONALIZADA = 100;
export const BYTES_MAXIMOS_CAMPOS_PERSONALIZADOS = 64 * 1024;

/**
 * Origens que uma pessoa escolhe ao cadastrar à mão. `WEBHOOK`, `PASSAGEM` e
 * `IMPORTACAO` só nascem de automações do sistema.
 */
export const ORIGENS_MANUAIS = [
  'MANUAL',
  'WHATSAPP',
  'SITE',
  'INDICACAO',
  'OUTRO',
] as const satisfies readonly OrigemContato[];

export type OrigemManual = (typeof ORIGENS_MANUAIS)[number];

/** Nome que fica no lugar do nome do contato anonimizado (R4.6). */
export const NOME_DO_CONTATO_ANONIMIZADO = 'Contato anonimizado';

/**
 * Tipos de notificação deste módulo (R10.2, "lead atribuído"): um contato ou
 * uma empresa passou a ser de alguém por ação de outra pessoa. Ficam na lista
 * única da base (`TIPOS_NOTIFICACAO`), que o front usa para escolher o ícone.
 */
export const NOTIFICACAO_CONTATO_ATRIBUIDO =
  TIPOS_NOTIFICACAO.CONTATO_ATRIBUIDO;
export const NOTIFICACAO_EMPRESA_ATRIBUIDA =
  TIPOS_NOTIFICACAO.EMPRESA_ATRIBUIDA;

/** Unidades da federação (CHECK `empresas_uf_check` aceita duas letras maiúsculas). */
export const UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
