import { LIMITES_DE_SENHA } from '../src/auth/auth.controller';
import { type AppTeste, clienteAnonimo, criarAppTeste } from './utils';

describe('Produção — limites das rotas públicas de senha (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  afterAll(async () => {
    await t.fechar();
  });

  it('R2.8 — o pedido de link passa de 3 por e-mail em 15 min: 429 com Retry-After, igual exista o e-mail ou não', async () => {
    const email = 'ninguem@teste.local';
    for (let i = 0; i < LIMITES_DE_SENHA.esqueciPorEmail.limite; i += 1) {
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/esqueci', { email })
        .expect(202);
    }
    const resposta = await clienteAnonimo(t)
      .post('/api/v1/auth/senha/esqueci', { email })
      .expect(429);
    expect(resposta.body.erro).toBe('muitas_tentativas');
    expect(Number(resposta.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('R2.8 — a consulta de token passa de 30 por IP em 15 min: 429', async () => {
    for (let i = 0; i < LIMITES_DE_SENHA.tokenPorIp.limite; i += 1) {
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/token', { token: `invalido-${i}` })
        .expect((r) => expect(r.status).not.toBe(429));
    }
    await clienteAnonimo(t)
      .post('/api/v1/auth/senha/token', { token: 'invalido-final' })
      .expect(429);
    await clienteAnonimo(t)
      .post('/api/v1/auth/senha/redefinir', {
        token: 'invalido-final',
        novaSenha: 'senha-qualquer-123',
      })
      .expect(429);
  });
});

describe('Produção — cabeçalhos de segurança da API (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  afterAll(async () => {
    await t.fechar();
  });

  it('toda resposta leva nosniff, X-Frame-Options e Referrer-Policy; sem X-Powered-By e sem HSTS fora de produção', async () => {
    const resposta = await clienteAnonimo(t).get('/api/saude');
    expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    expect(resposta.headers['x-frame-options']).toBe('DENY');
    expect(resposta.headers['referrer-policy']).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(resposta.headers['x-powered-by']).toBeUndefined();
    expect(resposta.headers['strict-transport-security']).toBeUndefined();
  });
});
