import { createHmac } from 'node:crypto';
import { aplicarMapeamento } from '../entrada/mapeamento';
import {
  adaptadorActiveCampaign,
  normalizarUrlDaConta,
} from './active-campaign';
import { adaptadorElementor } from './elementor';
import { lerFormularioAninhado } from './formulario';
import { adaptadorGreatPages } from './great-pages';
import { adaptadorLeadLovers } from './lead-lovers';
import { adaptadorManyChat } from './manychat';
import { adaptadorRdStation } from './rd-station';
import { catalogoDeAplicativos, adaptadorDe } from './registro';
import { assinaturaDoTypeform } from './seguranca';
import {
  type ContextoHttp,
  CredencialRecusadaError,
  FalhaNoAplicativoError,
} from './tipos';
import {
  adaptadorTypeform,
  normalizarTypeform,
  registrarWebhookDoTypeform,
  removerWebhookDoTypeform,
} from './typeform';
import { adaptadorWebhook, conferirAssinaturaHmac } from './webhook';

/** Aplica o modelo pronto do aplicativo ao primeiro item do corpo. */
function aplicarModelo(
  adaptador: NonNullable<ReturnType<typeof adaptadorDe>>,
  corpo: unknown,
  opcoes?: { exigirNome?: boolean },
) {
  const [item] = adaptador.normalizarCorpo(corpo);
  return aplicarMapeamento(
    adaptador.definicao.modelo!.mapeamento,
    item.corpo,
    [],
    opcoes,
  );
}

interface Chamada {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
  corpo: unknown;
}

/** Um `fetch` falso: responde pelo mapa `"METODO url"` → `{ status, json }` e guarda as chamadas. */
function http(respostas: Record<string, { status: number; json?: unknown }>): {
  contexto: ContextoHttp;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET';
    chamadas.push({
      url,
      metodo,
      cabecalhos: init?.headers as Record<string, string>,
      corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const resposta = respostas[`${metodo} ${url}`] ?? { status: 404 };
    return new Response(
      resposta.json === undefined ? null : JSON.stringify(resposta.json),
      { status: resposta.status },
    );
  }) as unknown as typeof fetch;
  return {
    chamadas,
    contexto: {
      buscar,
      typeformUrl: 'https://typeform.teste',
      manychatUrl: 'https://manychat.teste',
      verificarEndereco: (endereco) => Promise.resolve(endereco),
    },
  };
}

describe('Catálogo de aplicativos (R32.1)', () => {
  it('R32.1 — lista os 12 aplicativos em ordem alfabética, todos disponíveis (a H2 entregou o Facebook e as plataformas de curso)', () => {
    const catalogo = catalogoDeAplicativos();
    expect(catalogo.map(({ nome }) => nome)).toEqual([
      'ActiveCampaign',
      'Eduzz',
      'Elementor',
      'Facebook Lead Ads',
      'Great Pages',
      'Hotmart',
      'Kiwify',
      'Lead Lovers',
      'ManyChat',
      'RD Station',
      'Typeform',
      'Webhook',
    ]);
    expect(
      catalogo
        .filter(({ disponivel }) => !disponivel)
        .map(({ aplicativo }) => aplicativo),
    ).toEqual([]);
    // Cada aplicativo disponível explica o lado da ferramenta e traz um modelo.
    for (const definicao of catalogo.filter(({ disponivel }) => disponivel)) {
      expect(definicao.passoAPasso.passos.length).toBeGreaterThan(0);
      expect(definicao.modelo).not.toBeNull();
    }
  });
});

describe('Webhook (R32.2, R8.3)', () => {
  const segredo = 'segredo-de-teste-123';
  const corpo = Buffer.from('{"name":"Ana"}');
  const entrada = (cabecalhos: Record<string, string>, comSegredo = true) => ({
    cabecalhos,
    query: {},
    corpoBruto: corpo,
    segredo: comSegredo ? segredo : null,
    configuracao: {},
  });

  it('R8.3 — sem segredo aceita; com segredo exige X-Assinatura sha256=<hex> do corpo bruto', () => {
    expect(adaptadorWebhook.verificarAutenticidade(entrada({}, false))).toEqual(
      { ok: true },
    );
    const hex = createHmac('sha256', segredo).update(corpo).digest('hex');
    expect(
      adaptadorWebhook.verificarAutenticidade(
        entrada({ 'x-assinatura': `sha256=${hex}` }),
      ),
    ).toEqual({ ok: true });
    expect(
      adaptadorWebhook.verificarAutenticidade(
        entrada({ 'x-assinatura': 'sha256=' + '0'.repeat(64) }),
      ),
    ).toEqual({
      ok: false,
      mensagem: expect.stringContaining('Assinatura inválida') as string,
    });
    expect(adaptadorWebhook.verificarAutenticidade(entrada({}))).toEqual({
      ok: false,
      mensagem: expect.stringContaining('Assinatura ausente') as string,
    });
    expect(conferirAssinaturaHmac(segredo, corpo, 'lixo')).toBe(false);
  });
});

describe('Elementor (R32.2)', () => {
  const comAdvancedData =
    'form[id]=3f8a1c2&form[name]=Contato+do+site' +
    '&fields[name][id]=name&fields[name][type]=text&fields[name][title]=Nome&fields[name][value]=Maria+Souza&fields[name][raw_value]=Maria+Souza&fields[name][required]=1' +
    '&fields[email][id]=email&fields[email][value]=maria%40empresa.com.br' +
    '&fields[field_phone][id]=field_phone&fields[field_phone][value]=%2811%29+98765-4321' +
    '&fields[utm_source][id]=utm_source&fields[utm_source][value]=google' +
    '&fields[utm_campaign][id]=utm_campaign&fields[utm_campaign][value]=black-friday' +
    '&meta[page_url][title]=Page+URL&meta[page_url][value]=https%3A%2F%2Fexemplo.com.br%2Fcontato' +
    '&meta[remote_ip][value]=203.0.113.7';

  it('R32.2 — com Advanced Data (formulário aninhado): o campo vira <id> e as UTMs vêm dos campos ocultos', () => {
    const [item] = adaptadorElementor.normalizarCorpo(
      lerFormularioAninhado(comAdvancedData),
    );
    expect(item.corpo).toMatchObject({
      name: 'Maria Souza',
      email: 'maria@empresa.com.br',
      field_phone: '(11) 98765-4321',
      utm_source: 'google',
      form_id: '3f8a1c2',
      form_name: 'Contato do site',
      meta_page_url: 'https://exemplo.com.br/contato',
    });
    const lead = aplicarModelo(
      adaptadorElementor,
      lerFormularioAninhado(comAdvancedData),
    );
    expect(lead.contato).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@empresa.com.br',
    });
    expect(lead.utm).toEqual({ source: 'google', campaign: 'black-friday' });
  });

  it('R32.2 — sem Advanced Data: chaves simples; em JSON também', () => {
    const lead = aplicarModelo(
      adaptadorElementor,
      lerFormularioAninhado(
        'name=Joao&email=joao%40x.com&phone=11999998888&utm_medium=cpc',
      ),
    );
    expect(lead.contato).toMatchObject({
      nome: 'Joao',
      email: 'joao@x.com',
      telefone: '5511999998888',
    });
    expect(lead.utm).toEqual({ medium: 'cpc' });
    const json = aplicarModelo(adaptadorElementor, {
      form: { id: 'f1', name: 'X' },
      fields: { name: { value: 'Ana' }, email: { value: 'ana@x.com' } },
    });
    expect(json.contato).toMatchObject({ nome: 'Ana', email: 'ana@x.com' });
  });

  it('R32.2 — não exige autenticidade', () => {
    expect(
      adaptadorElementor.verificarAutenticidade({
        cabecalhos: {},
        query: {},
        corpoBruto: Buffer.alloc(0),
        segredo: null,
        configuracao: {},
      }),
    ).toEqual({ ok: true });
  });
});

describe('RD Station (R32.2)', () => {
  const lead = (email: string, nome: string) => ({
    id: 123,
    email,
    name: nome,
    company: 'Empresa Ltda',
    job_title: 'Diretora',
    personal_phone: '1133334444',
    mobile_phone: '(11) 98765-4321',
    tags: ['ebook', 'black-friday'],
    custom_fields: { nome_escola: 'Colégio Central' },
    cf_cidade: 'Natal',
    last_conversion: {
      content: { identificador: 'ebook-vendas', utm_term: 'crm' },
      conversion_origin: { source: 'google', medium: 'cpc', campaign: 'bf' },
    },
    first_conversion: { conversion_origin: { source: 'facebook' } },
  });

  it('R32.2 — {"leads":[…]}: um item por lead, com entity_type e rótulo "lead i de n"', () => {
    const itens = adaptadorRdStation.normalizarCorpo({
      entity_type: 'WEBHOOK.CONVERTED',
      leads: [lead('a@x.com', 'Ana'), lead('b@x.com', 'Beto')],
    });
    expect(itens.map(({ rotulo }) => rotulo)).toEqual([
      'lead 1 de 2',
      'lead 2 de 2',
    ]);
    expect((itens[1].corpo as { entity_type: string }).entity_type).toBe(
      'WEBHOOK.CONVERTED',
    );
  });

  it('R32.2 — API 2.0: o lead vem em payload e as UTMs em traffic_*', () => {
    const lead2 = aplicarModelo(adaptadorRdStation, {
      event_type: 'CONVERSION',
      event_identifier: 'formulario-contato',
      payload: {
        name: 'Nico',
        email: 'nico@x.com',
        personal_phone: '(11) 98888-7777',
        traffic_source: 'google',
        traffic_medium: 'cpc',
        traffic_campaign: 'matriculas',
      },
    });
    expect(lead2.contato).toMatchObject({
      nome: 'Nico',
      email: 'nico@x.com',
    });
    expect(lead2.utm).toMatchObject({ source: 'google', medium: 'cpc' });
  });

  it('R32.2 — lead único e lista de um item não ganham rótulo', () => {
    expect(
      adaptadorRdStation.normalizarCorpo(lead('a@x.com', 'Ana'))[0].rotulo,
    ).toBeNull();
    expect(
      adaptadorRdStation.normalizarCorpo({ leads: [lead('a@x.com', 'Ana')] })[0]
        .rotulo,
    ).toBeNull();
    expect(adaptadorRdStation.normalizarCorpo({ leads: [] })).toEqual([]);
  });

  it('R32.2 — o modelo lê nome, e-mail, celular, empresa, cargo, etiquetas, personalizados (custom_fields.* e cf_*) e UTMs da última conversão', () => {
    const resultado = aplicarModelo(
      adaptadorRdStation,
      lead('Ana@X.com', 'Ana'),
    );
    expect(resultado.contato).toMatchObject({
      nome: 'Ana',
      email: 'ana@x.com',
      telefone: '5511987654321',
      empresa: 'Empresa Ltda',
      cargo: 'Diretora',
    });
    expect(resultado.etiquetas).toEqual(['ebook', 'black-friday']);
    expect(resultado.camposPersonalizados).toEqual({
      nome_escola: 'Colégio Central',
      cidade: 'Natal',
    });
    expect(resultado.utm).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'bf',
      term: 'crm',
    });
  });

  it('R32.9 — a chave opcional vem num cabeçalho (X-RD-Chave ou o nome configurado), em tempo constante', () => {
    const base = {
      query: {},
      corpoBruto: Buffer.alloc(0),
      segredo: 'chave-do-rd-1234',
    };
    const verificar = (cabecalhos: Record<string, string>, configuracao = {}) =>
      adaptadorRdStation.verificarAutenticidade({
        ...base,
        cabecalhos,
        configuracao,
      });
    expect(verificar({ 'x-rd-chave': 'chave-do-rd-1234' })).toEqual({
      ok: true,
    });
    expect(verificar({ 'x-rd-chave': 'errada' }).ok).toBe(false);
    expect(verificar({}).ok).toBe(false);
    expect(
      verificar(
        { 'x-minha-chave': 'chave-do-rd-1234' },
        { cabecalhoDeAutenticacao: 'X-Minha-Chave' },
      ),
    ).toEqual({ ok: true });
    expect(
      adaptadorRdStation.verificarAutenticidade({
        ...base,
        segredo: null,
        cabecalhos: {},
        configuracao: {},
      }),
    ).toEqual({ ok: true });
  });
});

describe('ActiveCampaign (R32.2, R32.8)', () => {
  const corpoDoAc =
    'type=automation&date_time=2026-11-04T10%3A00%3A00-03%3A00&initiated_by=admin' +
    '&contact[id]=17&contact[email]=maria%40empresa.com.br&contact[first_name]=Maria&contact[last_name]=Souza' +
    '&contact[phone]=11987654321&contact[orgname]=Empresa+Ltda&contact[tags]=lead-quente%2Cwebinar' +
    '&contact[fields][3]=S%C3%A3o+Paulo&contact[fields][12]=ana%40brl.com.br&contact[fields][13]=Proposta' +
    '&deal[title]=Plano+Pro&deal[value]=1500.00';

  it('R32.2 — form-urlencoded contact[...] com nome completo derivado e campos personalizados por id', () => {
    const corpo = lerFormularioAninhado(corpoDoAc);
    const [item] = adaptadorActiveCampaign.normalizarCorpo(corpo);
    expect(
      (item.corpo as { contact: { full_name: string; fields: unknown } })
        .contact.full_name,
    ).toBe('Maria Souza');
    const lead = aplicarModelo(adaptadorActiveCampaign, corpo);
    expect(lead.contato).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@empresa.com.br',
      telefone: '5511987654321',
      empresa: 'Empresa Ltda',
    });
    expect(lead.etiquetas).toEqual(['lead-quente', 'webinar']);
    expect(lead.negocio).toMatchObject({
      titulo: 'Plano Pro',
      valor: '1500.00',
    });
  });

  it('R32.2 — o modelo pronto já mapeia "Dono do negócio", etapa_funil e status', () => {
    const lead3 = aplicarModelo(
      adaptadorActiveCampaign,
      lerFormularioAninhado(
        'contact[email]=a%40x.com&contact[first_name]=Ana&contact[fields][Dono+do+neg%C3%B3cio]=v%40x.com&contact[fields][etapa_funil]=Proposta&contact[fields][status]=ganho',
      ),
    );
    expect(lead3.atualizacoes).toMatchObject({
      dono: 'v@x.com',
      etapa: 'Proposta',
      status: 'ganho',
    });
  });

  it('R32.2 — "Dono do negócio", etapa_funil e status chegam como contact[fields][<id>] e se mapeiam para dono, etapa e status', () => {
    const resultado = aplicarMapeamento(
      {
        campos: [
          { caminho: 'contact.email', destino: 'email' },
          { caminho: 'contact[fields][12]', destino: 'dono' },
          { caminho: 'contact.fields.13', destino: 'etapa' },
        ],
        ignorarQuando: [],
      },
      lerFormularioAninhado(corpoDoAc),
      [],
      { exigirNome: false },
    );
    expect(resultado.problemas).toEqual([]);
    expect(resultado.atualizacoes).toMatchObject({
      dono: 'ana@brl.com.br',
      etapa: 'Proposta',
    });
  });

  it('R32.8 — a URL da conta perde a barra final e o /api/3 colado; usuário e senha na URL são recusados', () => {
    expect(normalizarUrlDaConta('https://conta.api-us1.com/')).toBe(
      'https://conta.api-us1.com',
    );
    expect(normalizarUrlDaConta('https://conta.api-us1.com/api/3')).toBe(
      'https://conta.api-us1.com',
    );
    expect(normalizarUrlDaConta('https://u:s@conta.api-us1.com')).toBeNull();
    expect(normalizarUrlDaConta('ftp://x')).toBeNull();
    expect(normalizarUrlDaConta('lixo')).toBeNull();
    expect(
      adaptadorActiveCampaign.lerCredencial!({
        urlConta: 'https://c.com/',
        chaveApi: ' k ',
      }),
    ).toEqual({
      credencial: { urlConta: 'https://c.com', chaveApi: 'k' },
    });
    expect(adaptadorActiveCampaign.lerCredencial!({})).toEqual({
      problemas: [
        { campo: 'credencial.urlConta', mensagem: 'é obrigatória' },
        { campo: 'credencial.chaveApi', mensagem: 'é obrigatória' },
      ],
    });
  });

  it('R32.8 — "Buscar campos" chama GET {conta}/api/3/fields com Api-Token e nomeia contact.fields.<id>', async () => {
    const { contexto, chamadas } = http({
      'GET https://conta.api-us1.com/api/3/fields?limit=100&offset=0': {
        status: 200,
        json: {
          fields: [
            { id: '3', title: 'Cidade', type: 'text' },
            { id: '12', title: 'Dono do negócio', type: 'text' },
          ],
          meta: { total: '2' },
        },
      },
    });
    const campos = await adaptadorActiveCampaign.buscarCampos!(
      { urlConta: 'https://conta.api-us1.com', chaveApi: 'ac-secreta' },
      {},
      contexto,
    );
    expect(campos).toEqual(
      expect.arrayContaining([
        { caminho: 'contact.fields.3', rotulo: 'Cidade', tipo: 'text' },
        {
          caminho: 'contact.fields.12',
          rotulo: 'Dono do negócio',
          tipo: 'text',
        },
        { caminho: 'contact.email', rotulo: 'E-mail', tipo: 'text' },
      ]),
    );
    expect(chamadas[0].cabecalhos['Api-Token']).toBe('ac-secreta');
  });

  it('R32.9 — chave inválida (403) é credencial recusada; 500 é falha do aplicativo', async () => {
    const credencial = {
      urlConta: 'https://conta.api-us1.com',
      chaveApi: 'ac-invalida',
    };
    const recusada = http({
      'GET https://conta.api-us1.com/api/3/fields?limit=1&offset=0': {
        status: 403,
      },
    });
    await expect(
      adaptadorActiveCampaign.testarCredencial!(credencial, recusada.contexto),
    ).rejects.toBeInstanceOf(CredencialRecusadaError);
    const fora = http({
      'GET https://conta.api-us1.com/api/3/fields?limit=1&offset=0': {
        status: 500,
      },
    });
    await expect(
      adaptadorActiveCampaign.testarCredencial!(credencial, fora.contexto),
    ).rejects.toBeInstanceOf(FalhaNoAplicativoError);
  });

  it('R32.8 — o endereço da conta passa pela proteção SSRF antes da chamada', async () => {
    const { contexto, chamadas } = http({});
    const bloqueado: ContextoHttp = {
      ...contexto,
      verificarEndereco: () =>
        Promise.reject(
          new FalhaNoAplicativoError(
            'Endereço da conta recusado: rede interna.',
          ),
        ),
    };
    await expect(
      adaptadorActiveCampaign.testarCredencial!(
        { urlConta: 'http://10.0.0.5', chaveApi: 'k' },
        bloqueado,
      ),
    ).rejects.toThrow('rede interna');
    expect(chamadas).toHaveLength(0);
  });
});

describe('Great Pages e Lead Lovers (R32.2)', () => {
  it('R32.2 — formulário ou JSON com as variáveis digitadas pelo usuário', () => {
    const gp = aplicarModelo(
      adaptadorGreatPages,
      lerFormularioAninhado(
        'nome=Ana+Lima&email=ana%40x.com&telefone=11987654321&utm_source=facebook',
      ),
    );
    expect(gp.contato).toMatchObject({
      nome: 'Ana Lima',
      email: 'ana@x.com',
      telefone: '5511987654321',
    });
    expect(gp.utm).toEqual({ source: 'facebook' });
    const ll = aplicarModelo(adaptadorLeadLovers, {
      Nome: 'Beto',
      Email: 'beto@x.com',
      tags: 'lead-quente',
    });
    expect(ll.contato).toMatchObject({ nome: 'Beto', email: 'beto@x.com' });
    expect(ll.etiquetas).toEqual(['lead-quente']);
  });
});

describe('ManyChat (R32.2, R32.8)', () => {
  const fullContactData = {
    id: '4812345678',
    key: 'user:4812345678',
    page_id: '99',
    status: 'active',
    first_name: 'Maria',
    last_name: 'Souza',
    name: 'Maria Souza',
    gender: 'female',
    email: 'maria@empresa.com.br',
    phone: '+5511987654321',
    whatsapp_phone: '5511987654321',
    ig_username: 'maria.souza',
    tags: [
      { id: 1, name: 'lead-quente' },
      { id: 2, name: 'webinar' },
    ],
    custom_fields: [
      { id: 10, name: 'cidade', type: 'text', value: 'São Paulo' },
      { id: 11, name: 'renda', type: 'number', value: 5000 },
    ],
  };

  it('R32.2 — Full Contact Data: nome, e-mail, telefone, etiquetas e custom_fields (lista {name,value} vira objeto)', () => {
    const lead = aplicarModelo(adaptadorManyChat, fullContactData);
    expect(lead.contato).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@empresa.com.br',
      telefone: '5511987654321',
    });
    expect(lead.etiquetas).toEqual(['lead-quente', 'webinar']);
    expect(lead.camposPersonalizados).toEqual({
      cidade: 'São Paulo',
      renda: 5000,
    });
  });

  it('R32.2 — custom_fields como objeto e o contato dentro de "data" também valem', () => {
    const lead = aplicarModelo(adaptadorManyChat, {
      data: {
        name: 'Beto',
        phone: '11999998888',
        custom_fields: { cidade: 'Natal' },
      },
    });
    expect(lead.contato).toMatchObject({
      nome: 'Beto',
      telefone: '5511999998888',
    });
    expect(lead.camposPersonalizados).toEqual({ cidade: 'Natal' });
  });

  it('R32.2 — contato do Instagram sem e-mail e telefone: o adaptador explica como coletar', () => {
    const [item] = adaptadorManyChat.normalizarCorpo({
      id: '1',
      name: 'Maria',
      ig_username: 'maria.souza',
    });
    const lead = aplicarMapeamento(
      adaptadorManyChat.definicao.modelo!.mapeamento,
      item.corpo,
    );
    expect(lead.problemas[0]).toMatch(/^Sem e-mail nem telefone/);
    expect(
      adaptadorManyChat.explicarFaltaDeContato!(
        item.corpo as Record<string, unknown>,
      ),
    ).toMatch(/colete e-mail ou telefone no fluxo/);
  });

  it('R32.8 — chave da API: GET /fb/page/getCustomFields com Bearer; 401 é credencial recusada; campos viram custom_fields.<nome>', async () => {
    const certo = http({
      'GET https://manychat.teste/fb/page/getCustomFields': {
        status: 200,
        json: {
          status: 'success',
          data: [
            { id: 1, name: 'cidade', type: 'text' },
            { id: 2, name: 'renda', type: 'number' },
          ],
        },
      },
    });
    const campos = await adaptadorManyChat.buscarCampos!(
      { chaveApi: 'mc-chave' },
      {},
      certo.contexto,
    );
    expect(campos).toEqual(
      expect.arrayContaining([
        { caminho: 'custom_fields.cidade', rotulo: 'cidade', tipo: 'text' },
        { caminho: 'custom_fields.renda', rotulo: 'renda', tipo: 'number' },
      ]),
    );
    expect(certo.chamadas[0].cabecalhos.Authorization).toBe('Bearer mc-chave');
    const errado = http({
      'GET https://manychat.teste/fb/page/getCustomFields': { status: 401 },
    });
    await expect(
      adaptadorManyChat.testarCredencial!(
        { chaveApi: 'mc-invalida' },
        errado.contexto,
      ),
    ).rejects.toBeInstanceOf(CredencialRecusadaError);
  });
});

describe('Typeform (R32.2, R32.9, R32.10)', () => {
  const formResponse = {
    event_id: '01HZX7Y2K9',
    event_type: 'form_response',
    form_response: {
      form_id: 'lT9uwa',
      token: 'a3a12ec67a1365927098a606107fac15',
      landed_at: '2026-11-04T12:00:00Z',
      submitted_at: '2026-11-04T12:01:00Z',
      hidden: { utm_source: 'instagram', utm_campaign: 'bf' },
      variables: [
        { key: 'etapa', type: 'text', text: 'Qualificação' },
        { key: 'score', type: 'number', number: 4 },
      ],
      definition: {
        id: 'lT9uwa',
        title: 'Contato do site',
        fields: [
          {
            id: 'f1',
            title: 'Qual é o seu nome?',
            type: 'short_text',
            ref: 'nome_completo',
          },
          { id: 'f2', title: 'E-mail', type: 'email', ref: 'email_contato' },
          { id: 'f3', title: 'Telefone', type: 'phone_number', ref: 'fone' },
          {
            id: 'f4',
            title: 'Interesse',
            type: 'multiple_choice',
            ref: 'interesse',
          },
          {
            id: 'f5',
            title: 'Produtos',
            type: 'multiple_choice',
            ref: 'produtos',
          },
        ],
      },
      answers: [
        {
          type: 'text',
          text: 'Maria Souza',
          field: { id: 'f1', type: 'short_text', ref: 'nome_completo' },
        },
        {
          type: 'email',
          email: 'maria@empresa.com.br',
          field: { id: 'f2', type: 'email', ref: 'email_contato' },
        },
        {
          type: 'phone_number',
          phone_number: '+5511987654321',
          field: { id: 'f3', type: 'phone_number', ref: 'fone' },
        },
        {
          type: 'choice',
          choice: { label: 'Consultoria' },
          field: { id: 'f4', type: 'multiple_choice', ref: 'interesse' },
        },
        {
          type: 'choices',
          choices: { labels: ['CRM', 'BI'] },
          field: { id: 'f5', type: 'multiple_choice', ref: 'produtos' },
        },
      ],
    },
  };

  it('R32.2 — o item tem uma chave por ref, hidden.*, variables.*, apelidos e o id do evento', () => {
    const [item] = normalizarTypeform(formResponse);
    expect(item.chaveDoEvento).toBe('01HZX7Y2K9');
    expect(item.corpo).toMatchObject({
      nome_completo: 'Maria Souza',
      email_contato: 'maria@empresa.com.br',
      fone: '+5511987654321',
      interesse: 'Consultoria',
      produtos: 'CRM, BI',
      email: 'maria@empresa.com.br',
      telefone: '+5511987654321',
      nome: 'Maria Souza',
      hidden: { utm_source: 'instagram', utm_campaign: 'bf' },
      variables: { etapa: 'Qualificação', score: 4 },
      form_id: 'lT9uwa',
      form_title: 'Contato do site',
    });
  });

  it('R32.2 — o modelo pronto mapeia apelidos, UTMs dos campos ocultos e a variável etapa', () => {
    const lead = aplicarModelo(adaptadorTypeform, formResponse);
    expect(lead.contato).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@empresa.com.br',
      telefone: '5511987654321',
    });
    expect(lead.utm).toEqual({ source: 'instagram', campaign: 'bf' });
    expect(lead.atualizacoes.etapa).toBe('Qualificação');
  });

  it('R32.9 — Typeform-Signature: sha256=<base64 HMAC-SHA256 do corpo bruto>; inválida, ausente ou sem segredo recusa', () => {
    const segredo = 'segredo-do-webhook';
    const corpoBruto = Buffer.from(JSON.stringify(formResponse));
    const esperada = `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('base64')}`;
    expect(esperada).toBe(assinaturaDoTypeform(segredo, corpoBruto));
    const verificar = (
      cabecalhos: Record<string, string>,
      comSegredo: string | null = segredo,
    ) =>
      adaptadorTypeform.verificarAutenticidade({
        cabecalhos,
        query: {},
        corpoBruto,
        segredo: comSegredo,
        configuracao: {},
      });
    expect(verificar({ 'typeform-signature': esperada })).toEqual({ ok: true });
    expect(
      verificar({
        'typeform-signature': `sha256=${Buffer.from('x').toString('base64')}`,
      }),
    ).toEqual({
      ok: false,
      mensagem: expect.stringContaining('Assinatura inválida') as string,
    });
    expect(verificar({})).toEqual({
      ok: false,
      mensagem: expect.stringContaining('ausente') as string,
    });
    expect(verificar({ 'typeform-signature': esperada }, null).ok).toBe(false);
    // O corpo adulterado não confere com a assinatura do original.
    expect(
      adaptadorTypeform.verificarAutenticidade({
        cabecalhos: { 'typeform-signature': esperada },
        query: {},
        corpoBruto: Buffer.from('{"adulterado":true}'),
        segredo,
        configuracao: {},
      }).ok,
    ).toBe(false);
  });

  it('R32.10 — lista formulários, busca as perguntas (inclusive de grupos), hidden e variables', async () => {
    const { contexto, chamadas } = http({
      'GET https://typeform.teste/forms?page_size=1': {
        status: 200,
        json: { items: [] },
      },
      'GET https://typeform.teste/forms/lT9uwa': {
        status: 200,
        json: {
          id: 'lT9uwa',
          hidden: ['utm_source'],
          variables: { etapa: 'x' },
          fields: [
            {
              id: 'a',
              ref: 'nome_completo',
              title: 'Nome',
              type: 'short_text',
            },
            {
              id: 'g',
              type: 'group',
              properties: {
                fields: [
                  {
                    id: 'b',
                    ref: 'cidade',
                    title: 'Cidade',
                    type: 'short_text',
                  },
                ],
              },
            },
            { id: 'c', ref: 'intro', title: 'Bem-vindo', type: 'statement' },
          ],
        },
      },
    });
    await adaptadorTypeform.testarCredencial!({ token: 'tf-token' }, contexto);
    expect(chamadas[0].cabecalhos.Authorization).toBe('Bearer tf-token');
    const campos = await adaptadorTypeform.buscarCampos!(
      { token: 'tf-token' },
      { formularioId: 'lT9uwa' },
      contexto,
    );
    expect(campos.map(({ caminho }) => caminho)).toEqual(
      expect.arrayContaining([
        'nome_completo',
        'cidade',
        'hidden.utm_source',
        'variables.etapa',
        'email',
      ]),
    );
    expect(campos.map(({ caminho }) => caminho)).not.toContain('intro');
    expect(
      await adaptadorTypeform.buscarCampos!({ token: 't' }, {}, contexto),
    ).toEqual([]);
  });

  it('R32.9 — token expirado (401) é credencial recusada', async () => {
    const { contexto } = http({
      'GET https://typeform.teste/forms?page_size=1': { status: 401 },
    });
    await expect(
      adaptadorTypeform.testarCredencial!({ token: 'tf-expirado' }, contexto),
    ).rejects.toBeInstanceOf(CredencialRecusadaError);
  });

  it('R32.9 — registra o webhook com PUT /forms/{id}/webhooks/{tag} (url, enabled, secret) e remove com DELETE (404 vale como removido)', async () => {
    const { contexto, chamadas } = http({
      'PUT https://typeform.teste/forms/lT9uwa/webhooks/crmbrl-abc': {
        status: 200,
        json: {},
      },
      'DELETE https://typeform.teste/forms/lT9uwa/webhooks/crmbrl-abc': {
        status: 404,
      },
    });
    await registrarWebhookDoTypeform({ token: 't' }, contexto, {
      formularioId: 'lT9uwa',
      tag: 'crmbrl-abc',
      url: 'https://crm.teste/api/v1/webhooks/entrada/tok',
      segredo: 'seg',
      ativo: true,
    });
    expect(chamadas[0]).toMatchObject({
      metodo: 'PUT',
      corpo: {
        url: 'https://crm.teste/api/v1/webhooks/entrada/tok',
        enabled: true,
        secret: 'seg',
        verify_ssl: true,
      },
    });
    await expect(
      removerWebhookDoTypeform(
        { token: 't' },
        contexto,
        'lT9uwa',
        'crmbrl-abc',
      ),
    ).resolves.toBeUndefined();
  });
});
