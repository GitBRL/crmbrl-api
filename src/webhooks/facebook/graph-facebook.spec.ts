import { ClienteDaGraphFacebook, ErroDaGraph } from './graph-facebook';

interface Pedido {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
}

function cliente(
  respostas: Array<{ status?: number; corpo: unknown } | Error>,
) {
  const pedidos: Pedido[] = [];
  const buscar = (async (url: string, init?: RequestInit) => {
    pedidos.push({
      url,
      metodo: init?.method ?? 'GET',
      cabecalhos: (init?.headers ?? {}) as Record<string, string>,
    });
    const proxima = respostas.shift();
    if (!proxima) {
      throw new Error('sem resposta programada');
    }
    if (proxima instanceof Error) {
      throw proxima;
    }
    return new Response(JSON.stringify(proxima.corpo), {
      status: proxima.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return {
    pedidos,
    graph: new ClienteDaGraphFacebook({
      buscar,
      graphUrl: 'https://graph.teste',
      versao: 'v24.0',
    }),
  };
}

describe('Cliente da Graph do Facebook (R32.14)', () => {
  it('R32.14 — o token vai no cabeçalho Authorization, nunca na URL', async () => {
    const { graph, pedidos } = cliente([
      { corpo: { data: [{ id: '1', name: 'Pág', access_token: 'pg-1' }] } },
    ]);
    const paginas = await graph.paginas('token-do-usuario');
    expect(paginas).toEqual([
      { id: '1', nome: 'Pág', categoria: null, token: 'pg-1' },
    ]);
    expect(pedidos[0].cabecalhos.Authorization).toBe('Bearer token-do-usuario');
    expect(pedidos[0].url).not.toContain('token-do-usuario');
    expect(pedidos[0].url).toMatch(
      /^https:\/\/graph\.teste\/v24\.0\/me\/accounts\?/,
    );
  });

  it('R32.14 — a lista segue o cursor `after` (nunca o paging.next com token) e para quando não há próxima', async () => {
    const { graph, pedidos } = cliente([
      {
        corpo: {
          data: [{ id: '1', name: 'A' }],
          paging: {
            cursors: { after: 'c1' },
            next: 'https://graph.teste/vazou?access_token=SEGREDO',
          },
        },
      },
      {
        corpo: {
          data: [{ id: '2', name: 'B' }],
          paging: { cursors: { after: 'c2' } },
        },
      },
    ]);
    const formularios = await graph.formularios('pg', '300');
    expect(formularios.map(({ id }) => id)).toEqual(['1', '2']);
    expect(pedidos).toHaveLength(2);
    expect(pedidos[1].url).toContain('after=c1');
    expect(pedidos[1].url).not.toContain('SEGREDO');
  });

  it('R32.14 — erro da Meta vira ErroDaGraph com código; 190 é token inválido; falha de rede é passageira', async () => {
    const { graph } = cliente([
      {
        status: 400,
        corpo: { error: { message: 'Invalid OAuth access token', code: 190 } },
      },
      new Error('ECONNREFUSED'),
      {
        status: 400,
        corpo: { error: { message: '(#200) sem permissão', code: 200 } },
      },
    ]);
    const token = await graph.lead('x', '1').catch((e: unknown) => e);
    expect(token).toBeInstanceOf(ErroDaGraph);
    expect((token as ErroDaGraph).tokenInvalido).toBe(true);
    const rede = (await graph
      .lead('x', '1')
      .catch((e: unknown) => e)) as ErroDaGraph;
    expect(rede.passageiro).toBe(true);
    expect(rede.message).not.toContain('ECONNREFUSED');
    const permissao = (await graph
      .lead('x', '1')
      .catch((e: unknown) => e)) as ErroDaGraph;
    expect(permissao.codigo).toBe(200);
    expect(permissao.tokenInvalido).toBe(false);
  });

  it('R32.14 — a troca do code pede o redirect_uri e devolve o token com a validade; sem token na resposta é erro', async () => {
    const { graph, pedidos } = cliente([
      { corpo: { access_token: 'curto-1', expires_in: 5400 } },
      { corpo: {} },
    ]);
    expect(
      await graph.trocarCodigo('app', 'segredo', 'https://crm/retorno', 'abc'),
    ).toEqual({
      token: 'curto-1',
      expiraEmSegundos: 5400,
    });
    const url = new URL(pedidos[0].url);
    expect(url.pathname).toBe('/v24.0/oauth/access_token');
    expect(url.searchParams.get('redirect_uri')).toBe('https://crm/retorno');
    expect(pedidos[0].cabecalhos.Authorization).toBeUndefined();
    await expect(
      graph.tokenDeLongaDuracao('app', 'segredo', 'curto-1'),
    ).rejects.toBeInstanceOf(ErroDaGraph);
  });

  it('R32.14 — a reconciliação pede os leads com filtro de data e descarta no cliente os anteriores', async () => {
    const { graph, pedidos } = cliente([
      {
        corpo: {
          data: [
            {
              id: '1',
              created_time: '2026-11-04T09:00:00+0000',
              field_data: [],
            },
            {
              id: '2',
              created_time: '2026-11-04T11:00:00+0000',
              field_data: [],
            },
            { id: '', created_time: '2026-11-04T12:00:00+0000' },
          ],
        },
      },
    ]);
    const leads = await graph.leadsDoFormulario(
      'pg',
      '400',
      new Date('2026-11-04T10:00:00Z'),
    );
    expect(leads.map(({ id }) => id)).toEqual(['2']);
    const url = new URL(pedidos[0].url);
    expect(url.pathname).toBe('/v24.0/400/leads');
    expect(JSON.parse(url.searchParams.get('filtering') ?? '[]')).toEqual([
      {
        field: 'time_created',
        operator: 'GREATER_THAN',
        value: Date.parse('2026-11-04T10:00:00Z') / 1000,
      },
    ]);
  });

  it('R32.14 — os campos assinados pelo app são lidos pelo id do app; assinar e desassinar usam POST e DELETE', async () => {
    const { graph, pedidos } = cliente([
      {
        corpo: {
          data: [
            { id: '999', subscribed_fields: ['feed'] },
            { id: '123', subscribed_fields: ['messages', 'leadgen'] },
          ],
        },
      },
      { corpo: { success: true } },
      { corpo: { success: true } },
    ]);
    expect(await graph.camposAssinados('pg', '300', '123')).toEqual([
      'messages',
      'leadgen',
    ]);
    await graph.assinar('pg', '300', ['messages', 'leadgen']);
    await graph.desassinar('pg', '300');
    expect(pedidos.map(({ metodo }) => metodo)).toEqual([
      'GET',
      'POST',
      'DELETE',
    ]);
    expect(new URL(pedidos[1].url).searchParams.get('subscribed_fields')).toBe(
      'messages,leadgen',
    );
  });
});
