import {
  CredencialRecusadaError,
  FalhaNoAplicativoError,
} from '../aplicativos/tipos';
import {
  type BasesDoOAuth,
  nomeDaConta,
  renovarToken,
  revogarNoRdStation,
  trocarCodigo,
  urlDoDialogo,
} from './clientes-oauth';

const BASES: BasesDoOAuth = {
  typeformDialogoUrl: 'https://dialogo.typeform.teste',
  typeformApiUrl: 'https://api.typeform.teste',
  rdStationDialogoUrl: 'https://dialogo.rd.teste',
  rdStationApiUrl: 'https://api.rd.teste',
};
const APP = { clientId: 'cliente-1', segredo: 'segredo-super-secreto' };

interface Chamada {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
  corpo: string | undefined;
}

function falso(status: number, json?: unknown) {
  const chamadas: Chamada[] = [];
  const buscar = ((url: string, init?: RequestInit) => {
    chamadas.push({
      url,
      metodo: init?.method ?? 'GET',
      cabecalhos: init?.headers as Record<string, string>,
      corpo: typeof init?.body === 'string' ? init.body : undefined,
    });
    return Promise.resolve(
      new Response(json === undefined ? null : JSON.stringify(json), {
        status,
      }),
    );
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

describe('clientes OAuth do Typeform e do RD Station (R32.25, R32.26)', () => {
  it('R32.25 — o diálogo do Typeform leva client_id, redirect_uri, os escopos com %20 e o state', () => {
    const url = urlDoDialogo('TYPEFORM', BASES, {
      clientId: 'cliente-1',
      redirectUri: 'https://crm.teste/api/v1/publico/conexoes/oauth/retorno',
      state: 'estado',
    });
    expect(
      url.startsWith('https://dialogo.typeform.teste/oauth/authorize?'),
    ).toBe(true);
    expect(url).toContain(
      'scope=accounts%3Aread%20forms%3Aread%20webhooks%3Aread%20webhooks%3Awrite%20offline',
    );
    const parametros = new URL(url).searchParams;
    expect(parametros.get('client_id')).toBe('cliente-1');
    expect(parametros.get('state')).toBe('estado');
    expect(parametros.get('redirect_uri')).toBe(
      'https://crm.teste/api/v1/publico/conexoes/oauth/retorno',
    );
  });

  it('R32.26 — o diálogo do RD Station é /auth/dialog com client_id, redirect_uri e state (sem escopos)', () => {
    const url = new URL(
      urlDoDialogo('RD_STATION', BASES, {
        clientId: 'cliente-2',
        redirectUri: 'https://crm.teste/retorno',
        state: 'estado',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://dialogo.rd.teste/auth/dialog',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cliente-2',
      redirect_uri: 'https://crm.teste/retorno',
      state: 'estado',
    });
  });

  it('R32.25 — Typeform: a troca do code e a renovação são POST /oauth/token em form-urlencoded e leem access, refresh e validade', async () => {
    const { buscar, chamadas } = falso(200, {
      token_type: 'Bearer',
      access_token: 'acesso-1',
      expires_in: 604800,
      refresh_token: 'refresh-1',
    });
    const troca = await trocarCodigo(
      'TYPEFORM',
      BASES,
      buscar,
      APP,
      'https://crm.teste/retorno',
      'codigo-1',
    );
    expect(troca).toEqual({
      access: 'acesso-1',
      refresh: 'refresh-1',
      expiraEmSegundos: 604800,
    });
    expect(chamadas[0]).toMatchObject({
      url: 'https://api.typeform.teste/oauth/token',
      metodo: 'POST',
    });
    expect(chamadas[0].cabecalhos['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(new URLSearchParams(chamadas[0].corpo))).toEqual({
      grant_type: 'authorization_code',
      code: 'codigo-1',
      client_id: 'cliente-1',
      client_secret: 'segredo-super-secreto',
      redirect_uri: 'https://crm.teste/retorno',
    });
    await renovarToken('TYPEFORM', BASES, buscar, APP, 'refresh-0');
    expect(Object.fromEntries(new URLSearchParams(chamadas[1].corpo))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-0',
      client_id: 'cliente-1',
      client_secret: 'segredo-super-secreto',
    });
  });

  it('R32.26 — RD Station: a troca é POST /auth/token?token_by=code e a renovação POST /auth/token, em JSON', async () => {
    const { buscar, chamadas } = falso(200, {
      access_token: 'a',
      expires_in: 86400,
      refresh_token: 'r',
    });
    await trocarCodigo(
      'RD_STATION',
      BASES,
      buscar,
      APP,
      'https://x',
      'codigo-2',
    );
    expect(chamadas[0].url).toBe(
      'https://api.rd.teste/auth/token?token_by=code',
    );
    expect(JSON.parse(chamadas[0].corpo ?? '')).toEqual({
      client_id: 'cliente-1',
      client_secret: 'segredo-super-secreto',
      code: 'codigo-2',
    });
    expect(chamadas[0].cabecalhos['Content-Type']).toBe('application/json');
    await renovarToken('RD_STATION', BASES, buscar, APP, 'refresh-9');
    expect(chamadas[1].url).toBe('https://api.rd.teste/auth/token');
    expect(JSON.parse(chamadas[1].corpo ?? '')).toEqual({
      client_id: 'cliente-1',
      client_secret: 'segredo-super-secreto',
      refresh_token: 'refresh-9',
    });
    // Sem `refresh_token` ou sem validade na resposta: nulos.
    const { buscar: semRefresh } = falso(200, { access_token: 'so-acesso' });
    expect(
      await renovarToken('RD_STATION', BASES, semRefresh, APP, 'r'),
    ).toEqual({ access: 'so-acesso', refresh: null, expiraEmSegundos: null });
  });

  it('R32.25 — 4xx do token é credencial recusada; 5xx, resposta sem token e rede caída são falha passageira; nenhum erro leva o segredo nem o token', async () => {
    for (const status of [400, 401, 403]) {
      const { buscar } = falso(status, {
        error: 'invalid_grant',
        segredo: APP.segredo,
      });
      const erro = await trocarCodigo(
        'TYPEFORM',
        BASES,
        buscar,
        APP,
        'x',
        'y',
      ).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(CredencialRecusadaError);
      expect((erro as Error).message).not.toContain(APP.segredo);
    }
    for (const status of [429, 500, 503]) {
      const { buscar } = falso(status);
      expect(
        await renovarToken('RD_STATION', BASES, buscar, APP, 'r').catch(
          (e: unknown) => e,
        ),
      ).toBeInstanceOf(FalhaNoAplicativoError);
    }
    const { buscar: vazio } = falso(200, { token_type: 'Bearer' });
    await expect(
      trocarCodigo('TYPEFORM', BASES, vazio, APP, 'x', 'y'),
    ).rejects.toThrow(/não devolveu o token de acesso/);
    const rede = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const erroDeRede = await trocarCodigo(
      'TYPEFORM',
      BASES,
      rede,
      APP,
      'x',
      'y',
    ).catch((e: unknown) => e as Error);
    expect(erroDeRede).toBeInstanceOf(FalhaNoAplicativoError);
    expect((erroDeRede as Error).message).toMatch(/falha de conexão/);
    // Redirecionamento não é seguido (não vira sucesso).
    const { buscar: redireciona } = falso(302);
    await expect(
      trocarCodigo('TYPEFORM', BASES, redireciona, APP, 'x', 'y'),
    ).rejects.toThrow(FalhaNoAplicativoError);
  });

  it('R32.25 — o nome da conta: e-mail (ou apelido) no Typeform, nome no RD; qualquer falha devolve nulo', async () => {
    const tf = falso(200, { alias: 'maria', email: 'maria@x.com' });
    expect(await nomeDaConta('TYPEFORM', BASES, tf.buscar, 'acesso')).toBe(
      'maria@x.com',
    );
    expect(tf.chamadas[0].url).toBe('https://api.typeform.teste/me');
    expect(tf.chamadas[0].cabecalhos.Authorization).toBe('Bearer acesso');
    expect(
      await nomeDaConta(
        'TYPEFORM',
        BASES,
        falso(200, { alias: 'maria' }).buscar,
        'a',
      ),
    ).toBe('maria');
    const rd = falso(200, { name: 'Escola Demo' });
    expect(await nomeDaConta('RD_STATION', BASES, rd.buscar, 'a')).toBe(
      'Escola Demo',
    );
    expect(rd.chamadas[0].url).toBe(
      'https://api.rd.teste/marketing/account_info',
    );
    expect(
      await nomeDaConta('RD_STATION', BASES, falso(404).buscar, 'a'),
    ).toBeNull();
    expect(
      await nomeDaConta('RD_STATION', BASES, falso(401).buscar, 'a'),
    ).toBeNull();
  });

  it('R32.26 — a revogação do RD é POST /auth/revoke (form, com o refresh) e nunca lança', async () => {
    const { buscar, chamadas } = falso(200, {});
    await revogarNoRdStation(BASES, buscar, { access: 'a', refresh: 'r' });
    expect(chamadas[0].url).toBe('https://api.rd.teste/auth/revoke');
    expect(chamadas[0].cabecalhos.Authorization).toBe('Bearer a');
    expect(Object.fromEntries(new URLSearchParams(chamadas[0].corpo))).toEqual({
      token: 'r',
      token_type_hint: 'refresh_token',
    });
    await expect(
      revogarNoRdStation(BASES, falso(500).buscar, {
        access: 'a',
        refresh: null,
      }),
    ).resolves.toBeUndefined();
  });
});
