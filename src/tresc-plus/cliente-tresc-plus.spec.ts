import {
  ClienteTrescPlus,
  desembrulhar,
  esperaDoBackoff,
  esperaDoRetryAfter,
  listaDe,
} from './cliente-tresc-plus';
import { ErroTrescPlus, traduzirErroHttp } from './erros-tresc-plus';

type Resposta = {
  status: number;
  corpo?: unknown;
  cabecalhos?: Record<string, string>;
};

/** `fetch` falso: responde em ordem e guarda os pedidos. */
function fetchFalso(respostas: Array<Resposta | Error>) {
  const pedidos: Array<{
    url: string;
    metodo: string;
    cabecalhos: Record<string, string>;
    corpo?: string;
  }> = [];
  const fn = ((url: URL, init: RequestInit) => {
    pedidos.push({
      url: String(url),
      metodo: init.method ?? 'GET',
      cabecalhos: init.headers as Record<string, string>,
      corpo: init.body as string | undefined,
    });
    const proxima = respostas.shift();
    if (!proxima) return Promise.reject(new Error('sem resposta'));
    if (proxima instanceof Error) return Promise.reject(proxima);
    const texto =
      proxima.corpo === undefined ? '' : JSON.stringify(proxima.corpo);
    return Promise.resolve(
      new Response(proxima.status === 204 ? null : texto, {
        status: proxima.status,
        headers: { 'content-type': 'application/json', ...proxima.cabecalhos },
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, pedidos };
}

function cliente(
  respostas: Array<Resposta | Error>,
  extra: { tentativas?: number } = {},
) {
  const falso = fetchFalso(respostas);
  const esperas: number[] = [];
  const c = new ClienteTrescPlus({
    baseUrl: 'https://3c.exemplo/api/v1/',
    token: 'segredo-do-token',
    fetchImpl: falso.fn,
    esperaBaseMs: 100,
    aleatorio: () => 0,
    dormir: (ms) => {
      esperas.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { c, esperas, pedidos: falso.pedidos };
}

describe('cliente HTTP do 3C+ (R34.1, R34.5)', () => {
  it('manda o Bearer, o corpo em formulário e tira a barra final da base', async () => {
    const { c, pedidos } = cliente([{ status: 204 }]);
    await c.entrarNaCampanha(12, 'manual');
    expect(pedidos[0].url).toBe('https://3c.exemplo/api/v1/agent/login');
    expect(pedidos[0].metodo).toBe('POST');
    expect(pedidos[0].cabecalhos.Authorization).toBe('Bearer segredo-do-token');
    expect(pedidos[0].corpo).toBe('campaign=12&mode=manual');
  });

  it('authenticate não manda o token da empresa', async () => {
    const { c, pedidos } = cliente([{ status: 200, corpo: { id: 1 } }]);
    await c.authenticate('ana@x.com', 'senha');
    expect(pedidos[0].cabecalhos.Authorization).toBeUndefined();
    expect(pedidos[0].corpo).toBe('user=ana%40x.com&password=senha');
  });

  it('mailing.json vai em JSON com return_data', async () => {
    const { c, pedidos } = cliente([{ status: 200, corpo: {} }]);
    await c.enviarMailing(1, 2, [
      { phone: '11987654321', identifier: 'x', data: { nome: 'A' } },
    ]);
    expect(pedidos[0].url).toBe(
      'https://3c.exemplo/api/v1/campaigns/1/lists/2/mailing.json?return_data=true',
    );
    expect(pedidos[0].cabecalhos['Content-Type']).toBe('application/json');
    expect(JSON.parse(pedidos[0].corpo ?? '')).toEqual([
      { phone: '11987654321', identifier: 'x', data: { nome: 'A' } },
    ]);
  });

  describe('backoff', () => {
    it('GET repete em 5xx com espera exponencial e conclui', async () => {
      const { c, esperas, pedidos } = cliente([
        { status: 503 },
        { status: 502 },
        { status: 200, corpo: { ok: true } },
      ]);
      await expect(c.me()).resolves.toEqual({ ok: true });
      expect(pedidos).toHaveLength(3);
      expect(esperas).toEqual([100, 200]);
    });

    it('GET desiste depois das tentativas e devolve o erro traduzido', async () => {
      const { c, pedidos } = cliente([
        { status: 500 },
        { status: 500 },
        { status: 500 },
      ]);
      await expect(c.me()).rejects.toMatchObject({
        codigo: 'indisponivel',
        status: 500,
      });
      expect(pedidos).toHaveLength(3);
    });

    it('POST não repete em 5xx (podia já ter discado), mas repete em 429 respeitando Retry-After', async () => {
      const a = cliente([{ status: 500 }]);
      await expect(a.c.discar('11987654321')).rejects.toMatchObject({
        codigo: 'indisponivel',
      });
      expect(a.pedidos).toHaveLength(1);

      const b = cliente([
        { status: 429, cabecalhos: { 'retry-after': '2' } },
        { status: 200, corpo: { call: { id: 1 } } },
      ]);
      await expect(b.c.discar('11987654321')).resolves.toEqual({
        call: { id: 1 },
      });
      expect(b.esperas).toEqual([2000]);
    });

    it('falha de rede: GET repete, POST não', async () => {
      const a = cliente([
        new Error('ECONNRESET'),
        { status: 200, corpo: { ok: 1 } },
      ]);
      await expect(a.c.me()).resolves.toEqual({ ok: 1 });
      const b = cliente([new Error('ECONNRESET')]);
      await expect(b.c.sairDaCampanha()).rejects.toMatchObject({
        codigo: 'rede',
        status: 0,
      });
    });

    it('a função do backoff dobra a cada tentativa e o Retry-After tem teto de 10 s', () => {
      expect([0, 1, 2, 3].map((t) => esperaDoBackoff(t, 400, () => 0))).toEqual(
        [400, 800, 1600, 3200],
      );
      expect(esperaDoBackoff(1, 400, () => 1)).toBe(1000);
      expect(esperaDoRetryAfter('3')).toBe(3000);
      expect(esperaDoRetryAfter('120')).toBe(10_000);
      expect(esperaDoRetryAfter(null)).toBeNull();
      expect(esperaDoRetryAfter('amanhã')).toBeNull();
    });
  });

  describe('erros em português', () => {
    it('traduz os status para mensagens claras, sem o token', async () => {
      const casos: Array<[number, unknown, string]> = [
        [401, {}, 'token_invalido'],
        [403, {}, 'sem_permissao'],
        [404, {}, 'nao_encontrado'],
        [429, {}, 'limite'],
        [503, {}, 'indisponivel'],
        [422, { message: 'Agent is not idle' }, 'agente_nao_ocioso'],
        [
          422,
          { message: 'The agent must be logged in a campaign.' },
          'sem_campanha',
        ],
        [
          422,
          { errors: { phone: ['O telefone é inválido.'] } },
          'dados_recusados',
        ],
      ];
      for (const [status, corpo, codigo] of casos) {
        const erro = traduzirErroHttp(status, corpo);
        expect(erro).toBeInstanceOf(ErroTrescPlus);
        expect(erro.codigo).toBe(codigo);
        expect(erro.message).not.toMatch(/segredo/);
        expect(erro.message.length).toBeGreaterThan(20);
      }
      expect(
        traduzirErroHttp(422, { errors: { phone: ['O telefone é inválido.'] } })
          .message,
      ).toContain('O telefone é inválido.');
      const { c } = cliente([
        { status: 401, corpo: { message: 'Unauthenticated.' } },
      ]);
      await expect(c.me()).rejects.toThrow(/token/i);
    });

    it('para a API do CRM nunca vira 401 (o front deslogaria a pessoa)', () => {
      expect(traduzirErroHttp(401, {}).paraErroApi().getStatus()).toBe(422);
      expect(traduzirErroHttp(503, {}).paraErroApi().getStatus()).toBe(503);
      expect(new ErroTrescPlus('rede', 'x', 0).paraErroApi().getStatus()).toBe(
        503,
      );
    });
  });

  it('gravação: 404 vira null e o corpo vem em streaming com o tipo', async () => {
    const a = cliente([{ status: 404 }]);
    await expect(a.c.gravacao('c1')).resolves.toBeNull();
    const falso = fetchFalso([]);
    const c = new ClienteTrescPlus({
      baseUrl: 'https://x/api',
      token: 't',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(Buffer.from('abc'), {
            status: 200,
            headers: {
              'content-type': 'audio/mpeg; charset=x',
              'content-length': '3',
            },
          }),
        )) as unknown as typeof fetch,
    });
    void falso;
    const audio = await c.gravacao('c1');
    expect(audio?.mime).toBe('audio/mpeg');
    expect(audio?.tamanho).toBe(3);
  });

  it('leitura tolerante das respostas', () => {
    expect(desembrulhar({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(desembrulhar({ a: 1 })).toEqual({ a: 1 });
    expect(listaDe([1, 2])).toEqual([1, 2]);
    expect(listaDe({ data: [1] })).toEqual([1]);
    expect(listaDe({ data: { data: [3] } })).toEqual([3]);
    expect(listaDe(null)).toEqual([]);
  });
});
