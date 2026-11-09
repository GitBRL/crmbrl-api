import {
  assinarState,
  dicasDoState,
  lerState,
  novoNonce,
} from './estado-do-login';

const CHAVE = Buffer.alloc(32, 9);
const CONEXAO = '11111111-2222-4333-8444-555555555555';
const ADMIN = '99999999-8888-4777-8666-555555555555';
const DOMINIO = 'conexao-aplicativo-oauth-state';
const daqui = (segundos: number) => Math.floor(Date.now() / 1000) + segundos;

describe('estado do login (R32.14, R32.23, R32.25)', () => {
  it('R32.25 — o state assinado traz a conexão, o Admin, o modo e o serviço', () => {
    const nonce = novoNonce(ADMIN, 'janela', 'typeform');
    const state = assinarState(CHAVE, DOMINIO, CONEXAO, nonce, daqui(600));
    expect(lerState(CHAVE, DOMINIO, state)).toEqual({
      conexaoId: CONEXAO,
      nonce,
      usuarioId: ADMIN,
      modo: 'janela',
      aplicativo: 'typeform',
    });
    const comoPagina = assinarState(
      CHAVE,
      DOMINIO,
      CONEXAO,
      novoNonce(ADMIN, 'pagina'),
      daqui(600),
    );
    expect(lerState(CHAVE, DOMINIO, comoPagina)).toMatchObject({
      modo: 'pagina',
      aplicativo: null,
    });
  });

  it('R32.25 — vencido, adulterado, de outro domínio, de outra chave e malformado não passam', () => {
    const nonce = novoNonce(ADMIN, 'janela', 'rd-station');
    const state = assinarState(CHAVE, DOMINIO, CONEXAO, nonce, daqui(600));
    expect(
      lerState(
        CHAVE,
        DOMINIO,
        assinarState(CHAVE, DOMINIO, CONEXAO, nonce, daqui(-1)),
      ),
    ).toBe('vencido');
    expect(lerState(CHAVE, DOMINIO, `${state.slice(0, -2)}xx`)).toBe(
      'invalido',
    );
    expect(lerState(CHAVE, 'facebook-oauth-state', state)).toBe('invalido');
    expect(lerState(Buffer.alloc(32, 1), DOMINIO, state)).toBe('invalido');
    // Trocar o Admin dentro do nonce quebra a assinatura.
    expect(lerState(CHAVE, DOMINIO, state.replace(ADMIN, CONEXAO))).toBe(
      'invalido',
    );
    for (const lixo of [
      undefined,
      null,
      42,
      '',
      'a.b.c',
      'a.b.c.d.e',
      'x'.repeat(500),
    ]) {
      expect(lerState(CHAVE, DOMINIO, lixo)).toBe('invalido');
    }
  });

  it('R32.23 — as dicas do modo e do serviço saem do state sem conferir a assinatura, e só aceitam valores conhecidos', () => {
    const nonce = novoNonce(ADMIN, 'janela', 'typeform');
    const state = assinarState(CHAVE, DOMINIO, CONEXAO, nonce, daqui(600));
    expect(dicasDoState(`${state.slice(0, -2)}xx`)).toEqual({
      modo: 'janela',
      aplicativo: 'typeform',
    });
    expect(dicasDoState('lixo')).toEqual({ modo: 'pagina', aplicativo: null });
    expect(dicasDoState(`${CONEXAO}.a~b~j~https://mal.com.x.y`)).toEqual({
      modo: 'janela',
      aplicativo: null,
    });
    expect(dicasDoState(undefined)).toEqual({
      modo: 'pagina',
      aplicativo: null,
    });
  });
});
