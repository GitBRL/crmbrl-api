import { ConsoleLogger } from '@nestjs/common';
import type { Ambiente } from '../config/ambiente';

/** Campos que o logger mascara em qualquer profundidade, em qualquer formato. */
export const CAMPOS_MASCARADOS_NO_LOG = [
  'senha',
  'senhaAtual',
  'novaSenha',
  'senhaHash',
  'token',
  'tokenHash',
  'segredo',
  'authorization',
  'cookie',
  'databaseUrl',
];

/**
 * Logger da aplicação: o `ConsoleLogger` nativo do Nest, em JSON (uma linha por
 * registro, parâmetros na raiz) quando `LOG_FORMATO=json` — o padrão em
 * produção (R3.6) — ou em texto colorido para desenvolvimento.
 */
export function criarLogger(ambiente: Ambiente): ConsoleLogger {
  if (ambiente.logFormato === 'json') {
    return new ConsoleLogger({
      json: true,
      flattenParams: true,
      redact: CAMPOS_MASCARADOS_NO_LOG,
    });
  }
  return new ConsoleLogger({ redact: CAMPOS_MASCARADOS_NO_LOG });
}
