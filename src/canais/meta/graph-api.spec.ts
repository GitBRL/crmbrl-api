import { provaDaChaveSecreta } from '../../comum/meta/prova-da-chave';
import type { Ambiente } from '../../config/ambiente';
import { GraphApi } from './graph-api';

const TOKEN = 'EAAG-token-de-teste';
const SEGREDO = 'segredo-do-app-de-teste';
const PROVA = provaDaChaveSecreta(TOKEN, SEGREDO);

describe('GraphApi: appsecret_proof (R14.10)', () => {
  const ambiente = {
    meta: { graphUrl: 'https://graph.teste', graphVersao: 'v24.0' },
  } as Ambiente;
  let pedidos: Array<{ url: string; init: RequestInit }>;
  let original: typeof fetch;

  beforeEach(() => {
    pedidos = [];
    original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      pedidos.push({ url, init });
      return new Response(JSON.stringify({ id: '1' }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('GET: a prova vai na query; o token continua só no cabeçalho', async () => {
    await new GraphApi(ambiente).obter(
      { token: TOKEN, appSecret: SEGREDO },
      'PAGINA',
      ['id', 'name'],
    );
    expect(pedidos[0].url).toBe(
      `https://graph.teste/v24.0/PAGINA?fields=id,name&appsecret_proof=${PROVA}`,
    );
    expect(pedidos[0].url).not.toContain(TOKEN);
    expect(pedidos[0].init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('POST com corpo JSON: a prova vai na query e o corpo não muda', async () => {
    await new GraphApi(ambiente).postar(
      { token: TOKEN, appSecret: SEGREDO },
      'NUMERO/messages',
      { to: '5511' },
    );
    expect(pedidos[0].url).toBe(
      `https://graph.teste/v24.0/NUMERO/messages?appsecret_proof=${PROVA}`,
    );
    expect(pedidos[0].init.body).toBe(JSON.stringify({ to: '5511' }));
  });

  it('POST multipart (mídia): a prova vai na query', async () => {
    await new GraphApi(ambiente).postarArquivo(
      { token: TOKEN, appSecret: SEGREDO },
      'NUMERO/media',
      new FormData(),
    );
    expect(pedidos[0].url).toContain(`?appsecret_proof=${PROVA}`);
  });

  it('chave de outro app gera outra prova', async () => {
    await new GraphApi(ambiente).consultar(
      { token: TOKEN, appSecret: 'outro-app' },
      'X',
    );
    expect(pedidos[0].url).not.toContain(PROVA);
    expect(pedidos[0].url).toContain(provaDaChaveSecreta(TOKEN, 'outro-app'));
  });

  it('sem chave secreta: segue sem a prova (como antes)', async () => {
    const graph = new GraphApi(ambiente);
    await graph.consultar(TOKEN, 'X?fields=id');
    await graph.consultar({ token: TOKEN, appSecret: null }, 'Y');
    expect(pedidos[0].url).toBe('https://graph.teste/v24.0/X?fields=id');
    expect(pedidos[1].url).toBe('https://graph.teste/v24.0/Y');
  });
});
