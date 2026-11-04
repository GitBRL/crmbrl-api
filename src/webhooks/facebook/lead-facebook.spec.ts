import { adaptadorFacebookLeadAds } from '../aplicativos/facebook-lead-ads';
import { aplicarMapeamento } from '../entrada/mapeamento';
import { instanteDaMeta, lerLead } from './graph-facebook';
import {
  camposDasPerguntas,
  extrairLeadgens,
  normalizarLead,
} from './lead-facebook';

const webhook = (mudancas: unknown[], extra: object = {}) => ({
  object: 'page',
  entry: [{ id: '300', time: 1761230000, changes: mudancas, ...extra }],
});

const leadgen = (valor: Record<string, unknown>) => ({
  field: 'leadgen',
  value: {
    leadgen_id: '555',
    page_id: '300',
    form_id: '400',
    adgroup_id: '700',
    ad_id: '701',
    created_time: 1761230000,
    ...valor,
  },
});

describe('Facebook Lead Ads — webhook leadgen (R32.14)', () => {
  it('R32.14 — extrai página, formulário, lead e anúncio de cada mudança leadgen', () => {
    expect(extrairLeadgens(webhook([leadgen({})]))).toEqual([
      {
        paginaId: '300',
        leadgenId: '555',
        formularioId: '400',
        anuncioId: '701',
        criadoEm: new Date(1761230000 * 1000),
      },
    ]);
  });

  it('R32.14 — ignora outros campos, outros objetos, valores sem id e lixo; números viram texto; página vem do entry se faltar', () => {
    expect(
      extrairLeadgens(
        webhook([
          { field: 'feed', value: { leadgen_id: '1' } },
          leadgen({ leadgen_id: undefined }),
          leadgen({ form_id: undefined }),
          leadgen({ leadgen_id: 999, page_id: undefined, created_time: 'x' }),
        ]),
      ),
    ).toEqual([
      {
        paginaId: '300',
        leadgenId: '999',
        formularioId: '400',
        anuncioId: '701',
        criadoEm: null,
      },
    ]);
    expect(extrairLeadgens({ object: 'instagram', entry: [] })).toEqual([]);
    expect(extrairLeadgens(null)).toEqual([]);
    expect(extrairLeadgens({ object: 'page', entry: 'x' })).toEqual([]);
    expect(
      extrairLeadgens({ object: 'page', entry: [{ id: '1', messaging: [] }] }),
    ).toEqual([]);
  });
});

describe('Facebook Lead Ads — lead → corpo (R32.14)', () => {
  const bruto = {
    id: '555',
    created_time: '2026-11-04T10:00:00+0000',
    form_id: '400',
    ad_id: '701',
    ad_name: 'Anúncio A',
    campaign_name: 'Campanha X',
    platform: 'ig',
    is_organic: false,
    field_data: [
      { name: 'full_name', values: ['Maria Souza'] },
      { name: 'email', values: ['p:maria@exemplo.com.br'] },
      { name: 'phone_number', values: ['p:+5511988887777'] },
      { name: 'interesses', values: ['Inglês', 'Música'] },
      { name: 'vazio', values: [] },
    ],
  };

  it('R32.14 — uma chave por pergunta, mais os metadados do lead; várias opções viram texto com vírgula; prefixo "p:" sai', () => {
    const corpo = normalizarLead(lerLead(bruto), {
      paginaId: '300',
      formularioId: '400',
    });
    expect(corpo).toEqual({
      leadgen_id: '555',
      page_id: '300',
      form_id: '400',
      ad_id: '701',
      ad_name: 'Anúncio A',
      campaign_name: 'Campanha X',
      platform: 'ig',
      is_organic: false,
      created_time: '2026-11-04T10:00:00+0000',
      full_name: 'Maria Souza',
      email: 'maria@exemplo.com.br',
      phone_number: '+5511988887777',
      interesses: 'Inglês, Música',
    });
  });

  it('R32.14 — sem full_name, junta first_name e last_name; ad_id do webhook vale quando a Graph não traz', () => {
    const corpo = normalizarLead(
      lerLead({
        id: '9',
        field_data: [
          { name: 'first_name', values: ['Ana'] },
          { name: 'last_name', values: ['Lima'] },
        ],
      }),
      { paginaId: '300', formularioId: '400', anuncioId: '12' },
    );
    expect(corpo).toMatchObject({
      full_name: 'Ana Lima',
      ad_id: '12',
      form_id: '400',
    });
    expect(corpo).not.toHaveProperty('campaign_name');
  });

  it('R32.14 — o modelo do aplicativo mapeia nome, e-mail, telefone e UTMs do corpo normalizado', () => {
    const corpo = normalizarLead(lerLead(bruto), {
      paginaId: '300',
      formularioId: '400',
    });
    const modelo = adaptadorFacebookLeadAds.definicao.modelo;
    expect(modelo).not.toBeNull();
    const lead = aplicarMapeamento(modelo!.mapeamento, corpo, []);
    expect(lead.problemas).toEqual([]);
    expect(lead.contato).toMatchObject({
      nome: 'Maria Souza',
      email: 'maria@exemplo.com.br',
      telefone: '5511988887777',
    });
    expect(lead.utm).toMatchObject({
      campaign: 'Campanha X',
      content: 'Anúncio A',
      source: 'ig',
    });
  });

  it('R32.14 — as perguntas viram campos do assistente (chave, rótulo, tipo) mais os metadados que ainda não existem', () => {
    const campos = camposDasPerguntas([
      { chave: 'full_name', rotulo: 'Nome', tipo: 'FULL_NAME' },
      { chave: 'ad_id', rotulo: 'Minha pergunta', tipo: null },
    ]);
    expect(campos.slice(0, 2)).toEqual([
      { caminho: 'full_name', rotulo: 'Nome', tipo: 'full_name' },
      { caminho: 'ad_id', rotulo: 'Minha pergunta', tipo: null },
    ]);
    expect(campos.filter(({ caminho }) => caminho === 'ad_id')).toHaveLength(1);
    expect(campos.map(({ caminho }) => caminho)).toContain('campaign_name');
  });

  it('R32.14 — o endereço da integração recusa lead direto (a Meta fala pelo roteador)', () => {
    const resultado = adaptadorFacebookLeadAds.verificarAutenticidade({
      cabecalhos: {},
      query: {},
      corpoBruto: Buffer.from('{}'),
      segredo: null,
      configuracao: {},
    });
    expect(resultado).toMatchObject({ ok: false });
    expect(adaptadorFacebookLeadAds.normalizarCorpo({ a: 1 })).toEqual([
      { corpo: { a: 1 }, rotulo: null },
    ]);
  });

  it('R32.14 — a data da Meta (+0000 sem dois-pontos) vira Date', () => {
    expect(instanteDaMeta('2026-11-04T10:00:00+0000')?.toISOString()).toBe(
      '2026-11-04T10:00:00.000Z',
    );
    expect(instanteDaMeta('2026-11-04T10:00:00-0300')?.toISOString()).toBe(
      '2026-11-04T13:00:00.000Z',
    );
    expect(instanteDaMeta('lixo')).toBeNull();
    expect(instanteDaMeta(null)).toBeNull();
  });
});
