import { destinoDoRetorno } from './retorno-de-login';

const BASE = 'https://crm.exemplo.com.br';

describe('destino do retorno do login (R32.23)', () => {
  it('R32.23 — em janela vai para /retorno-login com app, resultado e conexão; o motivo e a mensagem só quando há', () => {
    const url = new URL(
      destinoDoRetorno(BASE, 'janela', {
        aplicativo: 'rd-station',
        resultado: 'erro',
        conexaoId: 'abc',
        motivo: 'servico_recusou',
        mensagem: 'Recusado & <b>x</b>',
      }),
    );
    expect(url.origin + url.pathname).toBe(`${BASE}/retorno-login`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app: 'rd-station',
      resultado: 'erro',
      conexao: 'abc',
      motivo: 'servico_recusou',
      mensagem: 'Recusado & <b>x</b>',
    });
    expect(
      destinoDoRetorno(BASE, 'janela', {
        aplicativo: 'facebook',
        resultado: 'cancelado',
        conexaoId: null,
        motivo: null,
        mensagem: null,
      }),
    ).toBe(`${BASE}/retorno-login?app=facebook&resultado=cancelado`);
  });

  it('R32.23 — em página vai para /integracoes com o serviço como parâmetro, como antes', () => {
    expect(
      destinoDoRetorno(BASE, 'pagina', {
        aplicativo: 'facebook',
        resultado: 'conectado',
        conexaoId: 'abc',
        motivo: null,
        mensagem: null,
      }),
    ).toBe(`${BASE}/integracoes?facebook=conectado&conexao=abc`);
    expect(
      destinoDoRetorno(BASE, 'pagina', {
        aplicativo: 'typeform',
        resultado: 'cancelado',
        conexaoId: 'abc',
        motivo: 'access_denied',
        mensagem: null,
      }),
    ).toBe(
      `${BASE}/integracoes?typeform=cancelado&conexao=abc&motivo=access_denied`,
    );
  });
});
