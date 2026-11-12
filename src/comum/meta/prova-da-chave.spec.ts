import {
  parametrosComProva,
  provaDaChaveSecreta,
  provaDoAcesso,
  semChaveSecreta,
  urlComProva,
} from './prova-da-chave';

// Vetores calculados à parte: printf '<token>' | openssl dgst -sha256 -hmac '<chave>' -hex
const TOKEN = 'token-de-exemplo';
const SEGREDO = 'segredo-de-exemplo';
const PROVA =
  'cd5f518995e6b32f3c378234cc81e7167a6401f57dc086e3260b98d1f219dd24';

describe('prova da chave secreta da Meta (R14.10)', () => {
  it('calcula o HMAC-SHA256 do token com a chave do app, em hexadecimal', () => {
    expect(provaDaChaveSecreta(TOKEN, SEGREDO)).toBe(PROVA);
    expect(provaDaChaveSecreta('EAAG-abc', 'chave')).toBe(
      '234c04ccb95b269847e3ebd53e7e176508f1c5236fb713db021ebdcf57040b19',
    );
  });

  it('chave ou token diferente muda a prova', () => {
    expect(provaDaChaveSecreta(TOKEN, 'outra')).not.toBe(PROVA);
    expect(provaDaChaveSecreta('outro', SEGREDO)).not.toBe(PROVA);
  });

  it('GET: acrescenta appsecret_proof à query, com ou sem query prévia', () => {
    const acesso = { token: TOKEN, appSecret: SEGREDO };
    expect(urlComProva('https://g/v24.0/me', acesso)).toBe(
      `https://g/v24.0/me?appsecret_proof=${PROVA}`,
    );
    expect(urlComProva('https://g/v24.0/me?fields=id,name', acesso)).toBe(
      `https://g/v24.0/me?fields=id,name&appsecret_proof=${PROVA}`,
    );
  });

  it('formulário/query: devolve cópia com a prova, sem mexer no original', () => {
    const original = { fields: 'id' };
    expect(
      parametrosComProva(original, { token: TOKEN, appSecret: SEGREDO }),
    ).toEqual({ fields: 'id', appsecret_proof: PROVA });
    expect(original).toEqual({ fields: 'id' });
  });

  it('sem chave secreta (ou só o token), não há prova e a URL segue igual', () => {
    for (const acesso of [
      TOKEN,
      { token: TOKEN, appSecret: null },
      { token: TOKEN },
    ]) {
      expect(provaDoAcesso(acesso)).toBeNull();
      expect(urlComProva('https://g/x?a=1', acesso)).toBe('https://g/x?a=1');
      expect(semChaveSecreta(acesso)).toBe(true);
    }
    expect(semChaveSecreta({ token: TOKEN, appSecret: SEGREDO })).toBe(false);
  });
});
