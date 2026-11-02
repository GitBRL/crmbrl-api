import request from 'supertest';
import { NOME_COOKIE_SESSAO } from '../../src/auth/cookies';
import { SessoesService } from '../../src/auth/sessoes.service';
import type { Usuario } from '../../src/generated/prisma/client';
import type { AppTeste } from './app-teste';
import { ORIGEM_DE_TESTE } from './ambiente-teste';
import { SENHA_DE_TESTE } from './fabricas';

/**
 * Cliente HTTP dos testes: todo pedido já vai com `Origin` permitido (R2.9) e,
 * se logado, com o cookie da sessão. Os métodos devolvem o `request.Test` do
 * supertest, para continuar com `.send()`, `.query()`, `.expect()`…
 *
 * ```ts
 * const comercial = await entrarComo(t, usuario);
 * await comercial.post('/api/v1/negocios', { titulo: 'X', … }).expect(201);
 * ```
 */
export interface ClienteHttp {
  /** Quem está logado (`undefined` no cliente anônimo). */
  readonly usuario?: Usuario;
  /** Valor do cabeçalho `Cookie` (`crmbrl_sessao=…`). */
  readonly cookie?: string;
  get(url: string): request.Test;
  post(url: string, corpo?: string | object): request.Test;
  put(url: string, corpo?: string | object): request.Test;
  patch(url: string, corpo?: string | object): request.Test;
  delete(url: string, corpo?: string | object): request.Test;
}

type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';

function montarCliente(
  t: AppTeste,
  usuario?: Usuario,
  cookie?: string,
): ClienteHttp {
  const pedir = (
    metodo: Metodo,
    url: string,
    corpo?: string | object,
  ): request.Test => {
    let pedido = request(t.servidor)
      [metodo](url)
      .set('Origin', ORIGEM_DE_TESTE);
    if (cookie) {
      pedido = pedido.set('Cookie', cookie);
    }
    return corpo === undefined ? pedido : pedido.send(corpo);
  };
  return {
    usuario,
    cookie,
    get: (url) => pedir('get', url),
    post: (url, corpo) => pedir('post', url, corpo),
    put: (url, corpo) => pedir('put', url, corpo),
    patch: (url, corpo) => pedir('patch', url, corpo),
    delete: (url, corpo) => pedir('delete', url, corpo),
  };
}

/** Cliente sem sessão (com `Origin` permitido). */
export function clienteAnonimo(t: AppTeste): ClienteHttp {
  return montarCliente(t);
}

/**
 * Cliente logado como `usuario`: abre a sessão direto no serviço (sem passar
 * pelo login, então sem tentativa nem auditoria de login).
 */
export async function entrarComo(
  t: AppTeste,
  usuario: Usuario,
): Promise<ClienteHttp> {
  const { token } = await t.get(SessoesService).criar(t.prisma, usuario.id, {
    ip: '127.0.0.1',
    userAgent: 'teste',
  });
  return montarCliente(t, usuario, `${NOME_COOKIE_SESSAO}=${token}`);
}

/** Faz o login de verdade (`POST /api/v1/auth/entrar`) e devolve o cliente com o cookie recebido. */
export async function entrarPeloLogin(
  t: AppTeste,
  email: string,
  senha: string = SENHA_DE_TESTE,
): Promise<{ cliente: ClienteHttp; resposta: request.Response }> {
  const resposta = await clienteAnonimo(t).post('/api/v1/auth/entrar', {
    email,
    senha,
  });
  const cookie = cookieDaSessao(resposta);
  const usuario = cookie
    ? ((await t.prisma.usuario.findUnique({
        where: { email: email.trim().toLowerCase() },
      })) ?? undefined)
    : undefined;
  return { cliente: montarCliente(t, usuario, cookie), resposta };
}

/** `crmbrl_sessao=<token>` do `Set-Cookie` da resposta, se houver. */
export function cookieDaSessao(resposta: request.Response): string | undefined {
  const cabecalho = resposta.headers['set-cookie'] as
    string[] | string | undefined;
  const cookies = Array.isArray(cabecalho)
    ? cabecalho
    : cabecalho
      ? [cabecalho]
      : [];
  const sessao = cookies.find((cookie) =>
    cookie.startsWith(`${NOME_COOKIE_SESSAO}=`),
  );
  if (!sessao) {
    return undefined;
  }
  const valor = sessao.split(';')[0];
  return valor === `${NOME_COOKIE_SESSAO}=` ? undefined : valor;
}
