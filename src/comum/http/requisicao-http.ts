import type { Request } from 'express';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import type { ContextoRequisicao } from '../contexto/contexto-requisicao';

/** Requisição Express com o que a API pendura nela. */
export interface RequisicaoHttp extends Request {
  /** Contexto da requisição (id, IP, ator), criado pelo middleware de requisição. */
  contexto?: ContextoRequisicao;
  /** Preenchido pelo `SessaoGuard` quando há sessão válida. */
  usuarioAutenticado?: UsuarioAutenticado;
}

/** Corta um texto vindo de fora (user agent, cabeçalhos) num tamanho seguro para gravar. */
export function truncar(
  texto: string | undefined | null,
  limite: number,
): string | undefined {
  if (!texto) {
    return undefined;
  }
  return texto.length > limite ? texto.slice(0, limite) : texto;
}

/**
 * Rota da requisição para log: o padrão casado (`/api/v1/negocios/:id`) quando
 * houver — nunca a URL crua, que pode levar o token de um webhook de entrada —,
 * ou o caminho sem a query string, cortado.
 */
export function rotaParaLog(req: Request): string {
  const padrao = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof padrao === 'string') {
    return padrao;
  }
  // `originalUrl`: dentro de um middleware montado num caminho, `req.path` é relativo.
  const caminho = (req.originalUrl || req.url || '/').split('?')[0];
  return truncar(caminho, 200) ?? '/';
}
