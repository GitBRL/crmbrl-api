import type { CookieSerializeOptions } from '@nestjs/common';
import type { Request } from 'express';
import type { Ambiente } from '../config/ambiente';

/** Cookie da sessão (R2.2). */
export const NOME_COOKIE_SESSAO = 'crmbrl_sessao';

/**
 * Atributos do cookie de sessão (R2.2): `HttpOnly`, `SameSite=Lax`, `Path=/`,
 * `Secure` conforme `COOKIE_SEGURO` e vida igual à duração máxima da sessão (o
 * banco é quem decide se ela ainda vale).
 */
export function opcoesDoCookieDeSessao(
  ambiente: Ambiente,
): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: ambiente.cookieSeguro,
    maxAge: ambiente.sessao.duracaoMaximaDias * 24 * 60 * 60,
  };
}

/** Um cookie da requisição, lendo o cabeçalho `Cookie` (RFC 6265: a primeira ocorrência vale). */
export function lerCookie(
  requisicao: Request,
  nome: string,
): string | undefined {
  const cabecalho = requisicao.headers.cookie;
  if (!cabecalho) {
    return undefined;
  }
  for (const par of cabecalho.split(';')) {
    const separador = par.indexOf('=');
    if (separador === -1) {
      continue;
    }
    if (par.slice(0, separador).trim() !== nome) {
      continue;
    }
    let valor = par.slice(separador + 1).trim();
    if (valor.length >= 2 && valor.startsWith('"') && valor.endsWith('"')) {
      valor = valor.slice(1, -1);
    }
    try {
      return decodeURIComponent(valor);
    } catch {
      return valor;
    }
  }
  return undefined;
}
