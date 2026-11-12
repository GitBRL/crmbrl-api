import type { CookieSerializeOptions } from '@nestjs/common';
import type { Request } from 'express';
import type { Ambiente } from '../config/ambiente';

/** Cookie da sessão (R2.2) quando o cookie não é `Secure` (desenvolvimento local em http). */
export const NOME_COOKIE_SESSAO = 'crmbrl_sessao';

/**
 * Com `Secure`, o cookie leva o prefixo `__Host-` (R2.2): o navegador só o aceita vindo de https,
 * sem `Domain` e com `Path=/`, e um subdomínio ou um http interceptado não consegue plantar um
 * cookie de sessão com esse nome.
 */
export const NOME_COOKIE_SESSAO_SEGURO = '__Host-crmbrl_sessao';

/** O nome do cookie de sessão deste ambiente (`COOKIE_SEGURO`). */
export function nomeDoCookieDeSessao(
  ambiente: Pick<Ambiente, 'cookieSeguro'>,
): string {
  return ambiente.cookieSeguro ? NOME_COOKIE_SESSAO_SEGURO : NOME_COOKIE_SESSAO;
}

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
