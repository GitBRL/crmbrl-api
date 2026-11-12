import request from 'supertest';
import { NOME_COOKIE_SESSAO_SEGURO } from '../src/auth/cookies';
import { NOME_COOKIE_SESSAO } from '../src/auth/cookies';
import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarUsuario,
  ORIGEM_DE_TESTE,
  SENHA_DE_TESTE,
} from './utils';

describe('Cookie de sessão com Secure (R2.2, e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste({ variaveis: { COOKIE_SEGURO: 'true' } });
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  const cookiesDe = (resposta: request.Response): string[] =>
    ([] as string[]).concat(resposta.headers['set-cookie'] ?? []);

  it('R2.2 — com Secure o cookie se chama __Host-crmbrl_sessao (Secure, Path=/, sem Domain) e só ele vale', async () => {
    const usuario = await criarUsuario(t, { email: 'ana@teste.local' });
    const login = await clienteAnonimo(t)
      .post('/api/v1/auth/entrar', {
        email: usuario.email,
        senha: SENHA_DE_TESTE,
      })
      .expect(200);
    const cookie =
      cookiesDe(login).find((c) =>
        c.startsWith(`${NOME_COOKIE_SESSAO_SEGURO}=`),
      ) ?? '';
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(
      cookiesDe(login).some((c) => c.startsWith(`${NOME_COOKIE_SESSAO}=`)),
    ).toBe(false);

    const token = cookie.split(';')[0].split('=')[1];
    const com = (nome: string) =>
      request(t.servidor)
        .get('/api/v1/auth/eu')
        .set('Origin', ORIGEM_DE_TESTE)
        .set('Cookie', `${nome}=${token}`);
    await com(NOME_COOKIE_SESSAO_SEGURO).expect(200);
    // O nome antigo (sem o prefixo) deixa de valer: quem tinha sessão entra de novo uma vez.
    await com(NOME_COOKIE_SESSAO).expect(401);

    const sair = await request(t.servidor)
      .post('/api/v1/auth/sair')
      .set('Origin', ORIGEM_DE_TESTE)
      .set('Cookie', `${NOME_COOKIE_SESSAO_SEGURO}=${token}`)
      .expect(204);
    expect(
      cookiesDe(sair).some((c) =>
        c.startsWith(`${NOME_COOKIE_SESSAO_SEGURO}=`),
      ),
    ).toBe(true);
  });
});
