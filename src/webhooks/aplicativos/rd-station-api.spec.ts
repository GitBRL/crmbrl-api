import { FalhaNoAplicativoError, CredencialRecusadaError } from './tipos';
import {
  buscarCamposDoRd,
  camposDoRd,
  criarWebhookDoRd,
  removerWebhookDoRd,
} from './rd-station-api';
import { normalizarRdStation } from './rd-station';

const BASE = 'https://api.rd.teste';

function falso(status: number, json?: unknown) {
  const chamadas: {
    url: string;
    metodo: string;
    corpo?: unknown;
    auth?: string;
  }[] = [];
  const buscar = ((url: string, init?: RequestInit) => {
    chamadas.push({
      url,
      metodo: init?.method ?? 'GET',
      corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)
        ?.Authorization,
    });
    return Promise.resolve(
      new Response(json === undefined ? null : JSON.stringify(json), {
        status,
      }),
    );
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

describe('RD Station: webhooks e campos pela API (R32.26)', () => {
  it('R32.26 — cria o webhook de conversão com identificadores, relações e o cabeçalho de autenticação, e devolve o uuid', async () => {
    const { buscar, chamadas } = falso(201, { uuid: 'wh-1' });
    const uuid = await criarWebhookDoRd(buscar, BASE, 'tok', {
      gatilho: 'CONVERSAO',
      conversoes: ['newsletter'],
      url: 'https://crm.teste/api/v1/webhooks/entrada/abc',
      autenticacao: { cabecalho: 'X-RD-Chave', chave: 'chave-1' },
    });
    expect(uuid).toBe('wh-1');
    expect(chamadas[0]).toMatchObject({
      url: `${BASE}/integrations/webhooks`,
      metodo: 'POST',
      auth: 'Bearer tok',
    });
    expect(chamadas[0].corpo).toEqual({
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_identifiers: ['newsletter'],
      url: 'https://crm.teste/api/v1/webhooks/entrada/abc',
      http_method: 'POST',
      include_relations: ['COMPANY', 'CONTACT_FUNNEL'],
      auth_header: 'X-RD-Chave',
      auth_key: 'chave-1',
    });
  });

  it('R32.26 — oportunidade não leva identificadores; conversão sem lista = todas; sem chave, sem cabeçalho', async () => {
    const { buscar, chamadas } = falso(201, { uuid: 'wh-2' });
    await criarWebhookDoRd(buscar, BASE, 't', {
      gatilho: 'OPORTUNIDADE',
      conversoes: ['ignorada'],
      url: 'https://x/y',
      autenticacao: null,
    });
    await criarWebhookDoRd(buscar, BASE, 't', {
      gatilho: 'CONVERSAO',
      conversoes: [],
      url: 'https://x/y',
      autenticacao: null,
    });
    expect(chamadas[0].corpo).toEqual({
      event_type: 'WEBHOOK.MARKED_OPPORTUNITY',
      entity_type: 'CONTACT',
      url: 'https://x/y',
      http_method: 'POST',
      include_relations: ['COMPANY', 'CONTACT_FUNNEL'],
    });
    expect(chamadas[1].corpo).not.toHaveProperty('event_identifiers');
  });

  it('R32.26 — 401 na criação é credencial recusada; resposta sem uuid é falha', async () => {
    const pedido = {
      gatilho: 'CONVERSAO' as const,
      conversoes: [],
      url: 'https://x/y',
      autenticacao: null,
    };
    await expect(
      criarWebhookDoRd(falso(401, {}).buscar, BASE, 't', pedido),
    ).rejects.toBeInstanceOf(CredencialRecusadaError);
    await expect(
      criarWebhookDoRd(falso(201, {}).buscar, BASE, 't', pedido),
    ).rejects.toBeInstanceOf(FalhaNoAplicativoError);
  });

  it('R32.26 — remover: 204 e 404 valem como removido; outro erro falha', async () => {
    const ok = falso(204);
    await removerWebhookDoRd(ok.buscar, BASE, 't', 'u/1');
    expect(ok.chamadas[0]).toMatchObject({
      url: `${BASE}/integrations/webhooks/u%2F1`,
      metodo: 'DELETE',
    });
    await expect(
      removerWebhookDoRd(falso(404).buscar, BASE, 't', 'u'),
    ).resolves.toBeUndefined();
    await expect(
      removerWebhookDoRd(falso(500).buscar, BASE, 't', 'u'),
    ).rejects.toBeInstanceOf(FalhaNoAplicativoError);
  });

  it('R32.26 — os campos de contato viram campos do mapeamento (rótulo pt-BR, company_name como company, sem repetir)', async () => {
    const dados = {
      fields: [
        {
          api_identifier: 'name',
          label: { default: 'Name', 'pt-BR': 'Nome' },
          presentation_type: 'TEXT_INPUT',
          data_type: 'STRING',
        },
        {
          api_identifier: 'company_name',
          label: { default: 'Company' },
          data_type: 'STRING',
        },
        { api_identifier: 'company', label: 'Empresa' },
        {
          api_identifier: 'cf_serie',
          label: 'Série',
          presentation_type: 'COMBO_BOX',
        },
        { api_identifier: '  ' },
        { sem: 'identificador' },
        'lixo',
      ],
    };
    expect(camposDoRd(dados)).toEqual([
      { caminho: 'name', rotulo: 'Nome', tipo: 'text_input' },
      { caminho: 'company', rotulo: 'Company', tipo: 'string' },
      { caminho: 'cf_serie', rotulo: 'Série', tipo: 'combo_box' },
    ]);
    expect(camposDoRd(null)).toEqual([]);
    expect(camposDoRd({ fields: 'x' })).toEqual([]);
    const { buscar, chamadas } = falso(200, dados);
    expect((await buscarCamposDoRd(buscar, BASE, 'tok')).length).toBe(3);
    expect(chamadas[0]).toMatchObject({
      url: `${BASE}/platform/contacts/fields`,
      auth: 'Bearer tok',
    });
  });
});

describe('RD Station: corpo do webhook criado pela API (R32.26)', () => {
  const corpo = {
    event_type: 'WEBHOOK.CONVERTED',
    entity_type: 'CONTACT',
    event_identifier: 'newsletter',
    timestamp: '2018-03-13T14:09:02.724-03:00',
    event_timestamp: '2018-03-13T14:07:04.254-03:00',
    contact: {
      uuid: 'c2f3d2b3',
      email: 'x@y.com',
      name: 'Contact Name',
      cf_custom_field_example: ['Option1', 'Option2'],
      tags: ['tag 1'],
      company: { name: 'Company Example 0' },
      funnel: { name: 'default', lifecycle_stage: 'Lead', opportunity: false },
    },
  };

  it('R32.26 — o contato vira o item: campos na raiz, empresa reduzida ao nome, funil e dados do evento preservados', () => {
    const itens = normalizarRdStation(corpo);
    expect(itens).toHaveLength(1);
    expect(itens[0].rotulo).toBeNull();
    expect(itens[0].corpo).toMatchObject({
      email: 'x@y.com',
      name: 'Contact Name',
      cf_custom_field_example: ['Option1', 'Option2'],
      tags: ['tag 1'],
      company: 'Company Example 0',
      funnel: { lifecycle_stage: 'Lead' },
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_identifier: 'newsletter',
    });
    expect(itens[0].corpo).not.toHaveProperty('contact');
  });

  it('R32.26 — empresa sem nome some; os formatos antigos (leads[], payload, lead único) seguem como antes', () => {
    const semNome = normalizarRdStation({
      ...corpo,
      contact: { ...corpo.contact, company: { size: 10 } },
    });
    expect(semNome[0].corpo).not.toHaveProperty('company');
    expect(
      normalizarRdStation({
        leads: [{ email: 'a@a.com' }, { email: 'b@b.com' }],
      }),
    ).toHaveLength(2);
    expect(
      normalizarRdStation({ event_type: 'X', payload: { email: 'p@p.com' } })[0]
        .corpo,
    ).toMatchObject({ email: 'p@p.com', entity_type: 'X' });
    expect(normalizarRdStation({ email: 'u@u.com' })[0].corpo).toEqual({
      email: 'u@u.com',
    });
    expect(normalizarRdStation('texto')[0].corpo).toBe('texto');
  });
});
