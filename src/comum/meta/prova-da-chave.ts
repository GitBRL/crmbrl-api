import { createHmac } from 'node:crypto';

/**
 * Prova da chave secreta da Meta (`appsecret_proof`): HMAC-SHA256 do token de
 * acesso, com a chave secreta do app que o emitiu como chave, em hexadecimal.
 * Com "Exigir chave secreta do aplicativo" ligado no app, a Graph API recusa
 * toda chamada feita com token de acesso que não a traga.
 * https://developers.facebook.com/docs/graph-api/guides/secure-requests
 */
export function provaDaChaveSecreta(
  accessToken: string,
  appSecret: string,
): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Token de acesso e a chave secreta do app que o emitiu (quando guardada). */
export interface CredencialMeta {
  readonly token: string;
  readonly appSecret?: string | null;
}

/** Aceita só o token (sem prova) ou o token com a chave do app. */
export type AcessoMeta = string | CredencialMeta;

export function tokenDe(acesso: AcessoMeta): string {
  return typeof acesso === 'string' ? acesso : acesso.token;
}

/** A prova para este acesso, ou `null` se não há chave secreta. */
export function provaDoAcesso(acesso: AcessoMeta): string | null {
  if (typeof acesso === 'string' || !acesso.appSecret || !acesso.token) {
    return null;
  }
  return provaDaChaveSecreta(acesso.token, acesso.appSecret);
}

/**
 * Acrescenta `appsecret_proof` à URL (query string): é o jeito de GET e de
 * DELETE e também vale em POST (a Meta aceita na query). Sem prova (acesso só
 * com o token, ou conexão sem chave secreta), devolve a URL como veio.
 */
export function urlComProva(url: string, acesso: AcessoMeta): string {
  const prova = provaDoAcesso(acesso);
  if (!prova) {
    return url;
  }
  const separador = url.includes('?') ? '&' : '?';
  return `${url}${separador}appsecret_proof=${prova}`;
}

/** Parâmetros de formulário/query com a prova acrescentada (cópia). */
export function parametrosComProva(
  parametros: Record<string, string>,
  acesso: AcessoMeta,
): Record<string, string> {
  const prova = provaDoAcesso(acesso);
  return prova ? { ...parametros, appsecret_proof: prova } : { ...parametros };
}

/** Uma conexão que usa token de acesso mas não tem a chave secreta guardada. */
export function semChaveSecreta(acesso: AcessoMeta): boolean {
  return typeof acesso === 'string' || !acesso.appSecret;
}
