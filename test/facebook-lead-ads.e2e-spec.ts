import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Usuario } from '../src/generated/prisma/client';
import { FacebookLeadAdsService as FacebookLeadAdsServiceParaTeste } from '../src/webhooks/facebook/facebook-lead-ads.service';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarUsuario,
  drenarFilas,
  entrarComo,
  funilBase,
} from './utils';

const FILA_LEAD = 'facebook.lead';
const FILA_PROCESSAR = 'webhooks-entrada.processar';
const APP_ID = '1234567890123456';
const APP_SECRET = 'segredo-do-app-facebook-123456';
const PAGINA_1 = '300000000000001';
const PAGINA_2 = '300000000000002';
const FORM_1 = '400000000000001';
const FORM_2 = '400000000000002';
const FORM_3 = '400000000000003';
const API = '/api/v1/webhooks/facebook';

interface LeadFalso {
  id: string;
  form_id: string;
  created_time: string;
  ad_id: string;
  ad_name: string;
  campaign_name: string;
  platform: string;
  field_data: { name: string; values: string[] }[];
}

const PERGUNTAS = [
  { key: 'full_name', label: 'Nome completo', type: 'FULL_NAME', id: '1' },
  { key: 'email', label: 'E-mail', type: 'EMAIL', id: '2' },
  { key: 'phone_number', label: 'Telefone', type: 'PHONE', id: '3' },
  { key: 'serie_de_interesse', label: 'Série', type: 'CUSTOM', id: '4' },
];

const iso = (data: Date) => data.toISOString().replace(/\.\d+Z$/, '+0000');

/**
 * Graph API e diálogo do Facebook falsos, em processo (porta livre): login com
 * `code` de uso único, token longo, páginas com token próprio, formulários,
 * perguntas, `subscribed_apps` e leads. Guarda os pedidos (sem tokens no corpo).
 */
class GraphDoFacebook {
  url = '';
  pedidos: { metodo: string; caminho: string; autorizacao?: string }[] = [];
  assinadas = new Map<string, string[]>();
  leads: LeadFalso[] = [];
  revogados = new Set<string>();
  /** Código de erro programado para a leitura de leads (ex.: 200 = sem permissão). */
  erroNosLeads: number | null = null;
  private codigos = new Map<string, string>();
  private sequencia = 0;
  private servidor?: Server;

  async iniciar(): Promise<void> {
    this.servidor = createServer((req, res) => this.tratar(req, res));
    await new Promise<void>((resolver) =>
      this.servidor?.listen(0, '127.0.0.1', resolver),
    );
    this.url = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }

  async parar(): Promise<void> {
    this.servidor?.closeAllConnections();
    await new Promise<void>((resolver) =>
      this.servidor ? this.servidor.close(() => resolver()) : resolver(),
    );
  }

  limpar(): void {
    this.pedidos = [];
    this.assinadas.clear();
    this.leads = [];
    this.revogados.clear();
    this.erroNosLeads = null;
    this.codigos.clear();
  }

  /** O que o diálogo faz ao clicar em "Continuar": um `code` de uso único para o `redirect_uri`. */
  novoCodigo(redirectUri: string): string {
    const codigo = `code-${++this.sequencia}`;
    this.codigos.set(codigo, redirectUri);
    return codigo;
  }

  novoLead(
    formId: string,
    dados: Record<string, string>,
    criadoEm = new Date(),
  ): LeadFalso {
    const lead: LeadFalso = {
      id: `55500000000${String(++this.sequencia).padStart(4, '0')}`,
      form_id: formId,
      created_time: iso(criadoEm),
      ad_id: '700000000000001',
      ad_name: 'Anúncio matrícula',
      campaign_name: 'Matrículas 2027',
      platform: 'fb',
      field_data: Object.entries(dados).map(([name, valor]) => ({
        name,
        values: [valor],
      })),
    };
    this.leads.push(lead);
    return lead;
  }

  private formularios() {
    return [
      { id: FORM_1, pagina: PAGINA_1, nome: 'Interesse em matrícula' },
      { id: FORM_2, pagina: PAGINA_1, nome: 'Aula experimental' },
      { id: FORM_3, pagina: PAGINA_2, nome: 'Avaliação gratuita' },
    ];
  }

  private tratar(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://graph');
    const partes = url.pathname
      .replace(/^\/v\d+\.\d+/, '')
      .split('/')
      .filter(Boolean);
    const metodo = req.method ?? 'GET';
    const autorizacao = req.headers.authorization;
    this.pedidos.push({
      metodo,
      caminho: `${url.pathname}${url.search}`,
      autorizacao,
    });
    const responder = (status: number, corpo: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    const erro = (codigo: number, mensagem: string, subcodigo?: number) =>
      responder(400, {
        error: {
          message: mensagem,
          type: 'OAuthException',
          code: codigo,
          error_subcode: subcodigo,
        },
      });
    const [a, b] = partes;
    if (a === 'oauth' && b === 'access_token') {
      if (
        url.searchParams.get('client_id') !== APP_ID ||
        url.searchParams.get('client_secret') !== APP_SECRET
      ) {
        return erro(1, 'Invalid client_id or client_secret');
      }
      if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
        const curto = url.searchParams.get('fb_exchange_token') ?? '';
        return curto.startsWith('curto-')
          ? responder(200, {
              access_token: `longo-${++this.sequencia}`,
              token_type: 'bearer',
              expires_in: 5183944,
            })
          : erro(190, 'Invalid OAuth access token');
      }
      const codigo = url.searchParams.get('code') ?? '';
      const esperado = this.codigos.get(codigo);
      if (!esperado || esperado !== url.searchParams.get('redirect_uri')) {
        return erro(100, 'Error validating verification code', 36008);
      }
      this.codigos.delete(codigo);
      return responder(200, {
        access_token: `curto-${++this.sequencia}`,
        token_type: 'bearer',
        expires_in: 5400,
      });
    }
    const token = /^Bearer (.+)$/.exec(autorizacao ?? '')?.[1];
    if (!token || this.revogados.has(token)) {
      return erro(
        190,
        'Invalid OAuth access token - Cannot parse access token',
      );
    }
    if (a === 'me' && !b) {
      const doTipoPagina = /^pg-(\d+)$/.exec(token);
      return doTipoPagina
        ? responder(200, {
            id: doTipoPagina[1],
            name: doTipoPagina[1] === PAGINA_1 ? 'Escola Demo' : 'Clínica Demo',
          })
        : responder(200, { id: 'u-1', name: 'Maria Gestora' });
    }
    if (a === 'me' && b === 'accounts') {
      return responder(200, {
        data: [
          {
            id: PAGINA_1,
            name: 'Escola Demo',
            category: 'Education',
            access_token: `pg-${PAGINA_1}`,
          },
          {
            id: PAGINA_2,
            name: 'Clínica Demo',
            category: 'Health',
            access_token: `pg-${PAGINA_2}`,
          },
        ],
      });
    }
    const pagina = [PAGINA_1, PAGINA_2].includes(a) ? a : null;
    if (pagina && !b) {
      return responder(200, {
        id: pagina,
        name: pagina === PAGINA_1 ? 'Escola Demo' : 'Clínica Demo',
        category: 'Education',
      });
    }
    if (pagina && b === 'leadgen_forms') {
      return responder(200, {
        data: this.formularios()
          .filter((f) => f.pagina === pagina)
          .map((f) => ({
            id: f.id,
            name: f.nome,
            status: 'ACTIVE',
            locale: 'pt_BR',
            created_time: '2026-09-15T12:00:00+0000',
            leads_count: this.leads.filter((l) => l.form_id === f.id).length,
          })),
      });
    }
    if (pagina && b === 'subscribed_apps') {
      if (metodo === 'POST') {
        this.assinadas.set(
          pagina,
          (url.searchParams.get('subscribed_fields') ?? '')
            .split(',')
            .filter(Boolean),
        );
        return responder(200, { success: true });
      }
      if (metodo === 'DELETE') {
        this.assinadas.delete(pagina);
        return responder(200, { success: true });
      }
      const campos = this.assinadas.get(pagina);
      return responder(200, {
        data: campos ? [{ id: APP_ID, subscribed_fields: campos }] : [],
      });
    }
    const formulario = this.formularios().find((f) => f.id === a);
    if (formulario && !b) {
      return responder(200, { id: formulario.id, questions: PERGUNTAS });
    }
    if (formulario && b === 'leads') {
      if (this.erroNosLeads) {
        return erro(
          this.erroNosLeads,
          '(#200) Requires leads_retrieval permission',
        );
      }
      const desde = Number(url.searchParams.get('since') ?? 0);
      return responder(200, {
        data: this.leads.filter(
          (l) =>
            l.form_id === formulario.id &&
            Date.parse(l.created_time.replace(/\+0000$/, 'Z')) / 1000 >= desde,
        ),
      });
    }
    const lead = this.leads.find((l) => l.id === a);
    if (lead && !b) {
      if (this.erroNosLeads) {
        return erro(
          this.erroNosLeads,
          '(#200) Requires leads_retrieval permission',
        );
      }
      return responder(200, lead);
    }
    return erro(100, 'Object does not exist', 33);
  }
}

const assinar = (corpo: string, segredo = APP_SECRET) =>
  `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;

describe('Facebook Lead Ads (e2e, R32.14)', () => {
  let t: AppTeste;
  let adminUsuario: Usuario;
  let admin: ClienteHttp;
  const graph = new GraphDoFacebook();

  beforeAll(async () => {
    await graph.iniciar();
    t = await criarAppTeste({
      variaveis: {
        META_GRAPH_URL: graph.url,
        META_DIALOGO_URL: 'http://127.0.0.1:3296',
      },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    graph.limpar();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    await t.fechar();
    await graph.parar();
  });

  /** "Entrar com o Facebook" completo: iniciar, diálogo (o `code` falso) e retorno. */
  const conectar = async (
    corpo: Record<string, unknown> = { appId: APP_ID, appSecret: APP_SECRET },
  ) => {
    const { body } = await admin
      .post(`${API}/oauth/iniciar`, corpo)
      .expect(201);
    const inicio = body as { conexaoId: string; urlDialogo: string };
    const dialogo = new URL(inicio.urlDialogo);
    const state = dialogo.searchParams.get('state') ?? '';
    const code = graph.novoCodigo(
      dialogo.searchParams.get('redirect_uri') ?? '',
    );
    const retorno = await request(t.servidor)
      .get('/api/v1/publico/facebook/oauth/retorno')
      .query({ code, state })
      .expect(302);
    return {
      conexaoId: inicio.conexaoId,
      state,
      dialogo,
      location: retorno.headers.location as string,
    };
  };

  const criarIntegracao = async (
    conexaoId: string,
    configuracao: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const resposta = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: `Facebook ${Math.random().toString(36).slice(2, 8)}`,
        aplicativo: 'FACEBOOK_LEAD_ADS',
        funilId: comercial.id,
        etapaId: comercial.etapas[0].id,
        configuracao: {
          conexaoId,
          paginaId: PAGINA_1,
          formularioId: FORM_1,
          ...configuracao,
        },
        ...extra,
      })
      .expect(201);
    return (
      resposta.body as { webhook: { id: string } & Record<string, unknown> }
    ).webhook;
  };

  /** O que a Meta faz: `POST` assinado no roteador do webhook. */
  const enviarLeadgen = (
    lead: LeadFalso,
    opcoes: {
      pagina?: string;
      segredo?: string;
      assinatura?: string | null;
    } = {},
  ) => {
    const pagina = opcoes.pagina ?? PAGINA_1;
    const corpo = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pagina,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: lead.id,
                page_id: pagina,
                form_id: lead.form_id,
                adgroup_id: '700000000000002',
                ad_id: lead.ad_id,
                created_time: Math.floor(
                  Date.parse(lead.created_time.replace(/\+0000$/, 'Z')) / 1000,
                ),
              },
            },
          ],
        },
      ],
    });
    let pedido = request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('content-type', 'application/json');
    const assinatura =
      opcoes.assinatura === undefined
        ? assinar(corpo, opcoes.segredo)
        : opcoes.assinatura;
    if (assinatura) {
      pedido = pedido.set('x-hub-signature-256', assinatura);
    }
    return pedido.send(corpo);
  };

  const processar = async () => {
    await drenarFilas(t, FILA_LEAD, { incluirAgendados: true });
    await drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });
  };

  const recebimentosDe = (integracaoId: string) =>
    t.prisma.webhookRecebimento.findMany({
      where: { webhookId: integracaoId },
      orderBy: { recebidoEm: 'asc' },
    });

  const configuracaoDe = async (id: string) =>
    (await t.prisma.webhookEntrada.findUniqueOrThrow({ where: { id } }))
      .configuracao as Record<string, unknown>;

  const avisosDeAtencao = () =>
    t.prisma.notificacao.findMany({
      where: { tipo: 'integracao.precisa_atencao' },
    });

  // -------------------------------------------------------------------------
  // Catálogo e conexão
  // -------------------------------------------------------------------------

  it('cenário 343 (R32.14) — o catálogo traz o Facebook Lead Ads disponível, entrega por API, sem credencial por integração e com o passo a passo', async () => {
    const { aplicativos } = (
      await admin.get('/api/v1/webhooks/aplicativos').expect(200)
    ).body as {
      aplicativos: {
        aplicativo: string;
        disponivel: boolean;
        entrega: string;
        credencial: unknown;
        buscaCampos: boolean;
        escolheFormulario: boolean;
        passoAPasso: { passos: string[] };
        modelo: {
          mapeamento: { campos: { caminho: string; destino: string }[] };
        };
      }[];
    };
    const facebook = aplicativos.find(
      ({ aplicativo }) => aplicativo === 'FACEBOOK_LEAD_ADS',
    );
    expect(facebook).toMatchObject({
      disponivel: true,
      entrega: 'API',
      credencial: null,
      buscaCampos: true,
      escolheFormulario: true,
    });
    expect(facebook?.passoAPasso.passos.join(' ')).toMatch(/Leads Access/);
    expect(facebook?.modelo.mapeamento.campos).toEqual(
      expect.arrayContaining([
        { caminho: 'full_name', destino: 'nome' },
        { caminho: 'phone_number', destino: 'telefone' },
      ]),
    );
    const configuracao = (await admin.get(`${API}/configuracao`).expect(200))
      .body as {
      enderecoDeRetorno: string;
      escopos: string[];
    };
    expect(configuracao.enderecoDeRetorno).toBe(
      'http://localhost:4200/api/v1/publico/facebook/oauth/retorno',
    );
    expect(configuracao.escopos).toEqual(
      expect.arrayContaining([
        'leads_retrieval',
        'pages_manage_metadata',
        'business_management',
      ]),
    );
    const { membros } = {
      membros: [await criarUsuario(t, { papel: 'COMERCIAL' })],
    };
    await (await entrarComo(t, membros[0])).get(`${API}/conexoes`).expect(403);
    await request(t.servidor).get(`${API}/conexoes`).expect(401);
  });

  it('cenário 344 (R32.14) — o app da Meta pode ser reaproveitado de um canal Messenger; o segredo é copiado e nunca devolvido', async () => {
    await admin
      .post('/api/v1/meta/canais', {
        tipo: 'MESSENGER',
        nome: 'Página da escola',
        appId: APP_ID,
        appSecret: APP_SECRET,
        pageId: PAGINA_1,
        tokenPagina: `pg-${PAGINA_1}`,
      })
      .expect(201);
    const canais = (await admin.get(`${API}/canais`).expect(200)).body as {
      id: string;
      tipo: string;
      appId: string;
    }[];
    expect(canais).toHaveLength(1);
    expect(canais[0]).toMatchObject({ tipo: 'MESSENGER', appId: APP_ID });
    expect(JSON.stringify(canais)).not.toContain(APP_SECRET);
    const { conexaoId, location } = await conectar({ canalId: canais[0].id });
    expect(location).toContain('facebook=conectado');
    const conexao = (
      await admin.get(`${API}/conexoes/${conexaoId}`).expect(200)
    ).body as Record<string, unknown>;
    expect(conexao).toMatchObject({
      tipo: 'USUARIO',
      appId: APP_ID,
      conectada: true,
      canalOrigemId: canais[0].id,
    });
    expect(JSON.stringify(conexao)).not.toContain(APP_SECRET);
    await admin
      .post(`${API}/oauth/iniciar`, { canalId: canais[0].id, appId: APP_ID })
      .expect(400);
  });

  it('cenário 345 (R32.14) — "Entrar com o Facebook": URL do diálogo com state assinado, troca do code por token longo, páginas guardadas e retorno à tela de Integrações', async () => {
    const { body } = await admin
      .post(`${API}/oauth/iniciar`, { appId: APP_ID, appSecret: APP_SECRET })
      .expect(201);
    const inicio = body as {
      conexaoId: string;
      urlDialogo: string;
      expiraEm: string;
      enderecoDeRetorno: string;
    };
    const dialogo = new URL(inicio.urlDialogo);
    expect(`${dialogo.origin}${dialogo.pathname}`).toBe(
      'http://127.0.0.1:3296/v24.0/dialog/oauth',
    );
    expect(dialogo.searchParams.get('client_id')).toBe(APP_ID);
    expect(dialogo.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4200/api/v1/publico/facebook/oauth/retorno',
    );
    expect(dialogo.searchParams.get('scope')).toContain('leads_retrieval');
    expect(dialogo.searchParams.get('state')?.split('.')).toHaveLength(4);
    expect(inicio.urlDialogo).not.toContain(APP_SECRET);
    const antes = (
      await admin.get(`${API}/conexoes/${inicio.conexaoId}`).expect(200)
    ).body as { conectada: boolean };
    expect(antes.conectada).toBe(false);

    const code = graph.novoCodigo(
      dialogo.searchParams.get('redirect_uri') ?? '',
    );
    const retorno = await request(t.servidor)
      .get('/api/v1/publico/facebook/oauth/retorno')
      .query({ code, state: dialogo.searchParams.get('state') })
      .expect(302);
    expect(retorno.headers.location).toBe(
      `http://localhost:4200/integracoes?facebook=conectado&conexao=${inicio.conexaoId}`,
    );
    const conexao = (
      await admin.get(`${API}/conexoes/${inicio.conexaoId}`).expect(200)
    ).body as {
      conectada: boolean;
      nome: string;
      usuarioFacebook: { nome: string };
      expiraEm: string;
      paginas: { id: string; nome: string }[];
      appSecretMascarado: string;
    };
    expect(conexao).toMatchObject({
      conectada: true,
      nome: 'Facebook de Maria Gestora',
      usuarioFacebook: { nome: 'Maria Gestora' },
    });
    expect(conexao.paginas.map(({ id }) => id)).toEqual([PAGINA_1, PAGINA_2]);
    expect(Date.parse(conexao.expiraEm)).toBeGreaterThan(
      Date.now() + 50 * 24 * 3600_000,
    );
    expect(conexao.appSecretMascarado).toMatch(/^••••••••/);
    // O token curto virou longo: a troca por `fb_exchange_token` aconteceu, e o segredo foi no pedido (nunca no diálogo).
    expect(
      graph.pedidos.some((p) =>
        p.caminho.includes('grant_type=fb_exchange_token'),
      ),
    ).toBe(true);
    // Nada de segredo ou token nas respostas, na auditoria e no banco legível.
    const auditoria = JSON.stringify(
      await t.prisma.eventoAuditoria.findMany(),
      (_chave, valor: unknown) =>
        typeof valor === 'bigint' ? valor.toString() : valor,
    );
    for (const segredo of [APP_SECRET, 'longo-', 'curto-', 'pg-300']) {
      expect(JSON.stringify(conexao)).not.toContain(segredo);
      expect(auditoria).not.toContain(segredo);
    }
    const linha = await t.prisma.conexaoFacebook.findUniqueOrThrow({
      where: { id: inicio.conexaoId },
    });
    expect(JSON.stringify(linha)).not.toContain(APP_SECRET);
    expect(linha.tokenCifrado).not.toContain('longo-');
    // Listagem e exclusão.
    expect((await admin.get(`${API}/conexoes`).expect(200)).body).toHaveLength(
      1,
    );
  });

  it('R32.14 — reconexão: o ator do retorno é o Admin que iniciou o login (vai no state assinado), não o criador da conexão', async () => {
    const primeira = await conectar();
    const outro = await criarUsuario(t, {
      papel: 'ADMIN',
      nome: 'Outro Admin',
    });
    const clienteOutro = await entrarComo(t, outro);
    const { body } = await clienteOutro
      .post(`${API}/oauth/iniciar`, { conexaoId: primeira.conexaoId })
      .expect(201);
    const dialogo = new URL((body as { urlDialogo: string }).urlDialogo);
    const code = graph.novoCodigo(
      dialogo.searchParams.get('redirect_uri') ?? '',
    );
    await request(t.servidor)
      .get('/api/v1/publico/facebook/oauth/retorno')
      .query({ code, state: dialogo.searchParams.get('state') })
      .expect(302);
    const eventos = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'conexao_facebook.conectada' },
      orderBy: { id: 'asc' },
    });
    expect(eventos.map(({ usuarioId }) => usuarioId)).toEqual([
      adminUsuario.id,
      outro.id,
    ]);
    // Admin desligado depois de iniciar: o retorno é recusado.
    const { body: segundo } = await clienteOutro
      .post(`${API}/oauth/iniciar`, { conexaoId: primeira.conexaoId })
      .expect(201);
    const dialogo2 = new URL((segundo as { urlDialogo: string }).urlDialogo);
    await t.prisma.usuario.update({
      where: { id: outro.id },
      data: { ativo: false },
    });
    const recusado = await request(t.servidor)
      .get('/api/v1/publico/facebook/oauth/retorno')
      .query({
        code: graph.novoCodigo(dialogo2.searchParams.get('redirect_uri') ?? ''),
        state: dialogo2.searchParams.get('state'),
      })
      .expect(302);
    expect(recusado.headers.location as string).toContain(
      'motivo=state_invalido',
    );
  });

  it('cenário 346 (R32.14) — state vencido, repetido, adulterado e login cancelado: nada é trocado e o navegador volta com o motivo', async () => {
    const iniciar = async () => {
      const { body } = await admin
        .post(`${API}/oauth/iniciar`, { appId: APP_ID, appSecret: APP_SECRET })
        .expect(201);
      const { conexaoId, urlDialogo } = body as {
        conexaoId: string;
        urlDialogo: string;
      };
      const dialogo = new URL(urlDialogo);
      return {
        conexaoId,
        state: dialogo.searchParams.get('state') ?? '',
        code: graph.novoCodigo(dialogo.searchParams.get('redirect_uri') ?? ''),
      };
    };
    const retorno = (consulta: Record<string, string>) =>
      request(t.servidor)
        .get('/api/v1/publico/facebook/oauth/retorno')
        .query(consulta)
        .expect(302)
        .then((r) => new URL(r.headers.location as string));

    // Repetido (uso único): o segundo retorno com o mesmo state é recusado.
    const a = await iniciar();
    expect(
      (await retorno({ code: a.code, state: a.state })).searchParams.get(
        'facebook',
      ),
    ).toBe('conectado');
    const trocasAntes = graph.pedidos.filter((p) =>
      p.caminho.startsWith('/v24.0/oauth/access_token'),
    ).length;
    const repetido = await retorno({
      code: graph.novoCodigo('x'),
      state: a.state,
    });
    expect(repetido.searchParams.get('facebook')).toBe('erro');
    expect(repetido.searchParams.get('motivo')).toBe('state_usado');
    expect(
      graph.pedidos.filter((p) =>
        p.caminho.startsWith('/v24.0/oauth/access_token'),
      ).length,
    ).toBe(trocasAntes);

    // Vencido (mais de 10 minutos depois).
    const b = await iniciar();
    const agora = Date.now();
    const relogio = jest
      .spyOn(Date, 'now')
      .mockReturnValue(agora + 11 * 60_000);
    let vencido: URL;
    try {
      vencido = await retorno({ code: b.code, state: b.state });
    } finally {
      relogio.mockRestore();
    }
    expect(vencido.searchParams.get('motivo')).toBe('state_vencido');
    expect(
      (
        await t.prisma.conexaoFacebook.findUniqueOrThrow({
          where: { id: b.conexaoId },
        })
      ).tokenCifrado,
    ).toBeNull();

    // Validade do banco: o state é válido na assinatura, mas o registro já venceu.
    const c = await iniciar();
    await t.prisma.conexaoFacebook.update({
      where: { id: c.conexaoId },
      data: { estadoExpiraEm: new Date(Date.now() - 1000) },
    });
    expect(
      (await retorno({ code: c.code, state: c.state })).searchParams.get(
        'motivo',
      ),
    ).toBe('state_usado');

    // Adulterado: assinatura trocada, partes faltando, state de outra conexão.
    const d = await iniciar();
    const partes = d.state.split('.');
    const adulterado = [
      ...partes.slice(0, 3),
      `${partes[3].slice(0, -2)}AA`,
    ].join('.');
    for (const state of [
      adulterado,
      'qualquer-coisa',
      '',
      `${a.conexaoId}.${partes[1]}.${partes[2]}.${partes[3]}`,
    ]) {
      const r = await retorno({ code: d.code, state });
      expect(r.searchParams.get('facebook')).toBe('erro');
      expect(r.searchParams.get('motivo')).toBe('state_invalido');
    }
    expect((await retorno({ code: d.code })).searchParams.get('motivo')).toBe(
      'state_invalido',
    );
    expect(
      (
        await t.prisma.conexaoFacebook.findUniqueOrThrow({
          where: { id: d.conexaoId },
        })
      ).tokenCifrado,
    ).toBeNull();

    // Cancelado no diálogo.
    const e = await iniciar();
    const cancelado = await retorno({ error: 'access_denied', state: e.state });
    expect(cancelado.searchParams.get('facebook')).toBe('cancelado');
    expect(cancelado.searchParams.get('conexao')).toBe(e.conexaoId);
    expect(cancelado.searchParams.get('motivo')).toBe('access_denied');

    // A Meta recusa o code (já usado): erro com a mensagem dela, sem segredo.
    const f = await iniciar();
    const recusado = await retorno({
      code: 'code-inexistente',
      state: f.state,
    });
    expect(recusado.searchParams.get('facebook')).toBe('erro');
    expect(recusado.searchParams.get('motivo')).toBe('meta_recusou');
    expect(recusado.search).not.toContain(APP_SECRET);
  });

  it('cenário 347 (R32.14) — alternativa sem OAuth: token de página colado (conferido na Meta, guardado cifrado, token recusado dá 422)', async () => {
    const corpo = {
      appId: APP_ID,
      appSecret: APP_SECRET,
      tokenPagina: `pg-${PAGINA_1}`,
    };
    const conexao = (
      await admin.post(`${API}/conexoes/token-de-pagina`, corpo).expect(201)
    ).body as {
      id: string;
      tipo: string;
      conectada: boolean;
      nome: string;
      paginas: { id: string; nome: string }[];
    };
    expect(conexao).toMatchObject({
      tipo: 'PAGINA',
      conectada: true,
      nome: 'Página Escola Demo',
      paginas: [{ id: PAGINA_1, nome: 'Escola Demo' }],
    });
    expect(JSON.stringify(conexao)).not.toContain(`pg-${PAGINA_1}`);
    // Com `paginaId`, a Meta é consultada pela página.
    await admin
      .post(`${API}/conexoes/token-de-pagina`, {
        ...corpo,
        paginaId: PAGINA_1,
        nome: 'Outra',
      })
      .expect(201);
    graph.revogados.add('pg-revogado');
    const recusado = await admin
      .post(`${API}/conexoes/token-de-pagina`, {
        ...corpo,
        tokenPagina: 'pg-revogado',
      })
      .expect(422);
    expect((recusado.body as { mensagem: string }).mensagem).toMatch(
      /recusou o token/,
    );
    await admin
      .post(`${API}/conexoes/token-de-pagina`, { tokenPagina: 'x' })
      .expect(400);
    // Reconectar uma conexão por token de página não faz sentido.
    await admin
      .post(`${API}/oauth/iniciar`, { conexaoId: conexao.id })
      .expect(422);
    // As páginas vêm da conexão (sem pedir à Meta de novo).
    const paginas = (
      await admin.get(`${API}/conexoes/${conexao.id}/paginas`).expect(200)
    ).body as { id: string }[];
    expect(paginas.map(({ id }) => id)).toEqual([PAGINA_1]);
  });

  // -------------------------------------------------------------------------
  // Páginas, formulários, perguntas
  // -------------------------------------------------------------------------

  it('cenário 348 (R32.14) — lista páginas, formulários e perguntas (chaves e metadados do lead); token recusado vira atenção', async () => {
    const { conexaoId } = await conectar();
    const paginas = (
      await admin
        .get(`${API}/conexoes/${conexaoId}/paginas?atualizar=true`)
        .expect(200)
    ).body as {
      id: string;
      nome: string;
      categoria: string;
    }[];
    expect(paginas).toEqual([
      { id: PAGINA_1, nome: 'Escola Demo', categoria: 'Education' },
      { id: PAGINA_2, nome: 'Clínica Demo', categoria: 'Health' },
    ]);
    const formularios = (
      await admin
        .get(`${API}/conexoes/${conexaoId}/paginas/${PAGINA_1}/formularios`)
        .expect(200)
    ).body as {
      id: string;
      nome: string;
      status: string;
    }[];
    expect(formularios.map(({ id }) => id)).toEqual([FORM_1, FORM_2]);
    expect(formularios[0]).toMatchObject({
      nome: 'Interesse em matrícula',
      status: 'ACTIVE',
    });
    expect(
      (
        await admin
          .get(
            `${API}/conexoes/${conexaoId}/paginas/${PAGINA_1}/formularios?busca=aula`,
          )
          .expect(200)
      ).body,
    ).toHaveLength(1);
    const perguntas = (
      await admin
        .get(
          `${API}/conexoes/${conexaoId}/paginas/${PAGINA_1}/formularios/${FORM_1}/perguntas`,
        )
        .expect(200)
    ).body as { caminho: string; rotulo: string; tipo: string }[];
    expect(perguntas.slice(0, 4)).toEqual([
      { caminho: 'full_name', rotulo: 'Nome completo', tipo: 'full_name' },
      { caminho: 'email', rotulo: 'E-mail', tipo: 'email' },
      { caminho: 'phone_number', rotulo: 'Telefone', tipo: 'phone' },
      { caminho: 'serie_de_interesse', rotulo: 'Série', tipo: 'custom' },
    ]);
    expect(perguntas.map(({ caminho }) => caminho)).toEqual(
      expect.arrayContaining([
        'ad_id',
        'campaign_name',
        'form_id',
        'leadgen_id',
      ]),
    );
    // Página que não é da conexão e ids malformados.
    await admin
      .get(`${API}/conexoes/${conexaoId}/paginas/999/formularios`)
      .expect(422);
    await admin
      .get(`${API}/conexoes/${conexaoId}/paginas/abc/formularios`)
      .expect(400);
    await admin
      .get(
        `${API}/conexoes/${conexaoId}/paginas/${PAGINA_1}/formularios/xx/perguntas`,
      )
      .expect(400);
    // Token da página recusado: 422, conexão com atenção.
    graph.revogados.add(`pg-${PAGINA_1}`);
    const recusado = await admin
      .get(`${API}/conexoes/${conexaoId}/paginas/${PAGINA_1}/formularios`)
      .expect(422);
    expect(recusado.body.detalhes).toMatchObject({ precisaAtencao: true });
    const conexao = (
      await admin.get(`${API}/conexoes/${conexaoId}`).expect(200)
    ).body as {
      precisaAtencao: boolean;
      atencaoMotivo: string;
    };
    expect(conexao.precisaAtencao).toBe(true);
    expect(conexao.atencaoMotivo).toMatch(/entre com o Facebook/i);
  });

  // -------------------------------------------------------------------------
  // Integração e assinatura da página
  // -------------------------------------------------------------------------

  it('cenário 349 (R32.14) — a integração exige conexão, página e formulário válidos, assina o campo leadgen da página e guarda os nomes', async () => {
    const { conexaoId } = await conectar();
    const comercial = await funilBase(t, 'COMERCIAL');
    const base = {
      nome: 'Facebook matrículas',
      aplicativo: 'FACEBOOK_LEAD_ADS',
      funilId: comercial.id,
      etapaId: comercial.etapas[0].id,
    };
    // Faltando a escolha.
    const faltando = await admin
      .post('/api/v1/webhooks/entradas', base)
      .expect(422);
    expect(
      faltando.body.detalhes.campos.map((c: { campo: string }) => c.campo),
    ).toEqual(
      expect.arrayContaining([
        'configuracao.conexaoId',
        'configuracao.paginaId',
        'configuracao.formularioId',
      ]),
    );
    // Formulário de outra página.
    const outra = await admin
      .post('/api/v1/webhooks/entradas', {
        ...base,
        configuracao: { conexaoId, paginaId: PAGINA_1, formularioId: FORM_3 },
      })
      .expect(422);
    expect((outra.body as { mensagem: string }).mensagem).toMatch(
      /não existe nesta página/,
    );
    // Formatos e conexão inexistente.
    await admin
      .post('/api/v1/webhooks/entradas', {
        ...base,
        configuracao: {
          conexaoId: 'x',
          paginaId: PAGINA_1,
          formularioId: FORM_1,
        },
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/entradas', {
        ...base,
        configuracao: {
          conexaoId: '00000000-0000-4000-8000-000000000000',
          paginaId: PAGINA_1,
          formularioId: FORM_1,
        },
      })
      .expect(404);
    expect(graph.assinadas.size).toBe(0);
    // Credencial não vale (a conexão é separada).
    await admin
      .post('/api/v1/webhooks/entradas', {
        ...base,
        credencial: { token: 'x' },
        configuracao: { conexaoId, paginaId: PAGINA_1, formularioId: FORM_1 },
      })
      .expect(400);

    const integracao = await criarIntegracao(
      conexaoId,
      {},
      { nome: 'Facebook matrículas' },
    );
    expect(graph.assinadas.get(PAGINA_1)).toEqual(['leadgen']);
    const post = graph.pedidos.find(
      (p) => p.metodo === 'POST' && p.caminho.includes('subscribed_apps'),
    );
    expect(post?.autorizacao).toBe(`Bearer pg-${PAGINA_1}`);
    expect(post?.caminho).toContain('subscribed_fields=leadgen');
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      aplicativo: string;
      situacao: string;
      credencial: { configurada: boolean };
      configuracao: Record<string, unknown>;
    };
    expect(dto).toMatchObject({
      aplicativo: 'FACEBOOK_LEAD_ADS',
      situacao: 'ATIVA',
      credencial: { configurada: false },
      configuracao: {
        conexaoId,
        paginaId: PAGINA_1,
        formularioId: FORM_1,
        paginaNome: 'Escola Demo',
        formularioNome: 'Interesse em matrícula',
        assinatura: { conexaoId, paginaId: PAGINA_1 },
      },
    });
    expect(dto.configuracao.assinaturaErro).toBeUndefined();
    // Trocar só a página deixaria o formulário de outra página: recusado, e nada muda.
    const trocaRuim = await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, {
        configuracao: { paginaId: PAGINA_2 },
      })
      .expect(422);
    expect((trocaRuim.body as { mensagem: string }).mensagem).toMatch(
      /não existe nesta página/,
    );
    expect((await configuracaoDe(integracao.id)).paginaId).toBe(PAGINA_1);
    // Buscar campos e formulários pela integração (o assistente de edição).
    const campos = (
      await admin
        .post(`/api/v1/webhooks/entradas/${integracao.id}/buscar-campos`)
        .expect(200)
    ).body as {
      campos: { caminho: string }[];
    };
    expect(campos.campos.map(({ caminho }) => caminho)).toEqual(
      expect.arrayContaining(['full_name', 'serie_de_interesse', 'ad_id']),
    );
    const formularios = (
      await admin
        .get(`/api/v1/webhooks/entradas/${integracao.id}/formularios`)
        .expect(200)
    ).body as { id: string; titulo: string }[];
    expect(formularios.map(({ id }) => id)).toEqual([FORM_1, FORM_2]);
    const doFormulario = (
      await admin
        .get(
          `/api/v1/webhooks/entradas/${integracao.id}/formularios/${FORM_2}/campos`,
        )
        .expect(200)
    ).body as unknown[];
    expect(doFormulario.length).toBeGreaterThan(4);
  });

  it('cenário 350 (R32.14) — a assinatura acompanha a integração: preserva os campos já assinados, só sai quando nenhuma outra integração ativa usa a página', async () => {
    const { conexaoId } = await conectar();
    // O app já assinava mensagens do Messenger na página: não pode se perder.
    graph.assinadas.set(PAGINA_1, ['messages', 'messaging_postbacks']);
    const primeira = await criarIntegracao(conexaoId);
    expect(graph.assinadas.get(PAGINA_1)).toEqual([
      'messages',
      'messaging_postbacks',
      'leadgen',
    ]);
    const segunda = await criarIntegracao(conexaoId, { formularioId: FORM_2 });
    const posts = () =>
      graph.pedidos.filter(
        (p) => p.metodo === 'POST' && p.caminho.includes('subscribed_apps'),
      ).length;
    expect(posts()).toBe(1); // já assinada: não assina de novo

    // Desativar uma não solta a página (a outra segue ativa).
    await admin
      .patch(`/api/v1/webhooks/entradas/${primeira.id}`, { ativo: false })
      .expect(200);
    expect(graph.assinadas.get(PAGINA_1)).toContain('leadgen');
    // Desativar a última solta o leadgen, mantendo as mensagens.
    await admin
      .patch(`/api/v1/webhooks/entradas/${segunda.id}`, { ativo: false })
      .expect(200);
    expect(graph.assinadas.get(PAGINA_1)).toEqual([
      'messages',
      'messaging_postbacks',
    ]);
    // Reativar assina de novo.
    await admin
      .patch(`/api/v1/webhooks/entradas/${primeira.id}`, { ativo: true })
      .expect(200);
    expect(graph.assinadas.get(PAGINA_1)).toContain('leadgen');
    // Trocar de página: a antiga é solta e a nova assinada.
    await admin
      .patch(`/api/v1/webhooks/entradas/${primeira.id}`, {
        configuracao: { paginaId: PAGINA_2, formularioId: FORM_3 },
      })
      .expect(200);
    expect(graph.assinadas.get(PAGINA_1)).toEqual([
      'messages',
      'messaging_postbacks',
    ]);
    expect(graph.assinadas.get(PAGINA_2)).toEqual(['leadgen']);
    expect((await configuracaoDe(primeira.id)).paginaNome).toBe('Clínica Demo');
    // Excluir remove a assinatura; sem mais nada assinado, o app sai da página.
    await admin.delete(`/api/v1/webhooks/entradas/${primeira.id}`).expect(204);
    expect(graph.assinadas.has(PAGINA_2)).toBe(false);
    // Excluir a que estava inativa não mexe em nada.
    const pedidos = graph.pedidos.length;
    await admin.delete(`/api/v1/webhooks/entradas/${segunda.id}`).expect(204);
    expect(graph.pedidos.length).toBe(pedidos);
  });

  it('R32.14 — duas conexões do mesmo app dividem a assinatura da página: soltar a integração de uma não desassina enquanto a outra usa a página', async () => {
    const a = await conectar();
    const b = await conectar();
    expect(b.conexaoId).not.toBe(a.conexaoId);
    const primeira = await criarIntegracao(a.conexaoId);
    await criarIntegracao(b.conexaoId, { formularioId: FORM_2 });
    expect(graph.assinadas.get(PAGINA_1)).toContain('leadgen');
    await admin
      .patch(`/api/v1/webhooks/entradas/${primeira.id}`, { ativo: false })
      .expect(200);
    expect(graph.assinadas.get(PAGINA_1)).toContain('leadgen');
  });

  // -------------------------------------------------------------------------
  // Webhook leadgen
  // -------------------------------------------------------------------------

  it('cenário 351 (R32.14) — leadgen assinado: busca o lead na Graph e cria o contato e o negócio pelo mesmo caminho das outras integrações, com UTMs e a campanha', async () => {
    const { conexaoId } = await conectar();
    const mapeamento = {
      modeloMapeamento: 'PERSONALIZADO',
      mapeamento: {
        campos: [
          { caminho: 'full_name', destino: 'nome' },
          { caminho: 'email', destino: 'email' },
          { caminho: 'phone_number', destino: 'telefone' },
          {
            caminho: 'serie_de_interesse',
            destino: 'camposPersonalizados.serie',
          },
          { caminho: 'campaign_name', destino: 'utm.campaign' },
          { caminho: 'ad_name', destino: 'utm.content' },
          { caminho: 'platform', destino: 'utm.source' },
        ],
      },
    };
    const comercial = await funilBase(t, 'COMERCIAL');
    const integracao = await criarIntegracao(conexaoId, {}, { ...mapeamento });
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Maria Souza',
      email: 'Maria.Souza@Exemplo.com.br',
      phone_number: '+5511988887777',
      serie_de_interesse: '6º ano',
    });
    const resposta = await enviarLeadgen(lead).expect(200);
    expect(resposta.body).toEqual({ recebidas: 1 });
    await processar();

    const [recebimento] = await recebimentosDe(integracao.id);
    expect(recebimento).toMatchObject({
      status: 'PROCESSADO',
      tipoConteudo: 'application/json',
    });
    expect(recebimento.corpo).toMatchObject({
      leadgen_id: lead.id,
      page_id: PAGINA_1,
      form_id: FORM_1,
      ad_id: '700000000000001',
      campaign_name: 'Matrículas 2027',
      full_name: 'Maria Souza',
      serie_de_interesse: '6º ano',
    });
    const contato = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'maria.souza@exemplo.com.br' },
    });
    expect(contato.nome).toBe('Maria Souza');
    expect(contato.telefone).toBe('5511988887777');
    expect(contato.camposPersonalizados).toEqual({ serie: '6º ano' });
    const negocio = await t.prisma.negocio.findFirstOrThrow({
      where: { contatoId: contato.id },
      include: { etapa: true },
    });
    expect(negocio.funilId).toBe(comercial.id);
    expect(negocio.utm).toMatchObject({
      campaign: 'Matrículas 2027',
      content: 'Anúncio matrícula',
      source: 'fb',
    });
    // O lead foi buscado com o token da página, no cabeçalho (nunca na URL).
    const busca = graph.pedidos.find((p) =>
      p.caminho.startsWith(`/v24.0/${lead.id}`),
    );
    expect(busca?.autorizacao).toBe(`Bearer pg-${PAGINA_1}`);
    expect(busca?.caminho).not.toContain('pg-');
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as { ultimoRecebimentoEm: string | null };
    expect(dto.ultimoRecebimentoEm).not.toBeNull();
    // Aparece no histórico de recebimentos do Admin.
    const historico = (
      await admin
        .get(`/api/v1/webhooks/recebimentos?integracaoId=${integracao.id}`)
        .expect(200)
    ).body as { itens?: unknown[]; dados?: unknown[] };
    expect((historico.itens ?? historico.dados ?? []).length).toBe(1);
  });

  it('cenário 352 (R32.14) — leadgen sem assinatura ou com assinatura errada é recusado (401); evento de página ou formulário sem integração é ignorado (200)', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Ana',
      email: 'ana@exemplo.com.br',
    });
    await enviarLeadgen(lead, { assinatura: null }).expect(401);
    await enviarLeadgen(lead, { segredo: 'outro-segredo-qualquer' }).expect(
      401,
    );
    await enviarLeadgen(lead, { assinatura: 'sha256=zzz' }).expect(401);
    await processar();
    expect(await recebimentosDe(integracao.id)).toHaveLength(0);
    expect(
      graph.pedidos.some((p) => p.caminho.startsWith(`/v24.0/${lead.id}`)),
    ).toBe(false);
    // Formulário que nenhuma integração usa: 200 sem fazer nada.
    const outro = graph.novoLead(FORM_2, {
      full_name: 'Bia',
      email: 'bia@exemplo.com.br',
    });
    expect((await enviarLeadgen(outro).expect(200)).body).toEqual({
      recebidas: 0,
    });
    const deOutraPagina = graph.novoLead(FORM_3, {
      full_name: 'Caio',
      email: 'caio@exemplo.com.br',
    });
    expect(
      (await enviarLeadgen(deOutraPagina, { pagina: PAGINA_2 }).expect(200))
        .body,
    ).toEqual({ recebidas: 0 });
    // Integração inativa: também ignorada.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, { ativo: false })
      .expect(200);
    expect((await enviarLeadgen(lead).expect(200)).body).toEqual({
      recebidas: 0,
    });
    await processar();
    expect(await recebimentosDe(integracao.id)).toHaveLength(0);
  });

  it('cenário 353 (R32.14) — o mesmo leadgen_id não se repete: webhook duplicado, webhook e reconciliação, e dois funis recebem cada um o seu', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Duda',
      email: 'duda@exemplo.com.br',
    });
    await enviarLeadgen(lead).expect(200);
    await enviarLeadgen(lead).expect(200);
    await processar();
    await enviarLeadgen(lead).expect(200);
    await processar();
    expect(await recebimentosDe(integracao.id)).toHaveLength(1);
    expect(
      await t.prisma.leadFacebook.count({
        where: { webhookId: integracao.id },
      }),
    ).toBe(1);
    // A reconciliação encontra o mesmo lead e não o repete.
    expect(await t.get(FacebookLeadAdsServiceParaTeste).reconciliar()).toBe(0);
    await processar();
    expect(await recebimentosDe(integracao.id)).toHaveLength(1);
    expect(
      await t.prisma.contato.count({ where: { email: 'duda@exemplo.com.br' } }),
    ).toBe(1);

    // Duas integrações no mesmo formulário (funis diferentes): cada uma recebe o lead uma vez.
    const marketing = await funilBase(t, 'MARKETING');
    const segunda = await criarIntegracao(
      conexaoId,
      {},
      {
        funilId: marketing.id,
        etapaId: marketing.etapas[0].id,
      },
    );
    const lead2 = graph.novoLead(FORM_1, {
      full_name: 'Edu',
      email: 'edu@exemplo.com.br',
    });
    expect((await enviarLeadgen(lead2).expect(200)).body).toEqual({
      recebidas: 2,
    });
    await processar();
    expect(await recebimentosDe(integracao.id)).toHaveLength(2);
    expect(await recebimentosDe(segunda.id)).toHaveLength(1);
    // Formulário diferente: só a integração dele.
    const terceira = await criarIntegracao(conexaoId, { formularioId: FORM_2 });
    const lead3 = graph.novoLead(FORM_2, {
      full_name: 'Fê',
      email: 'fe@exemplo.com.br',
    });
    expect((await enviarLeadgen(lead3).expect(200)).body).toEqual({
      recebidas: 1,
    });
    await processar();
    expect(await recebimentosDe(terceira.id)).toHaveLength(1);
    expect(await recebimentosDe(integracao.id)).toHaveLength(2);
  });

  it('cenário 354 (R32.14) — a reconciliação (15 min) traz o lead que o webhook perdeu e não olha para trás da integração', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const servico = t.get(FacebookLeadAdsServiceParaTeste);
    // Lead de antes da integração: não entra.
    graph.novoLead(
      FORM_1,
      { full_name: 'Antigo', email: 'antigo@exemplo.com.br' },
      new Date(Date.now() - 3 * 24 * 3600_000),
    );
    // Lead perdido: o webhook nunca chegou.
    const perdido = graph.novoLead(FORM_1, {
      full_name: 'Gabi',
      email: 'gabi@exemplo.com.br',
      phone_number: '+5511977776666',
    });
    // Lead do formulário de outra integração (outro formulário): ignorado.
    graph.novoLead(FORM_2, {
      full_name: 'Outro',
      email: 'outro@exemplo.com.br',
    });
    expect(await servico.reconciliar()).toBe(1);
    await processar();
    const [recebimento] = await recebimentosDe(integracao.id);
    expect(recebimento.status).toBe('PROCESSADO');
    expect(recebimento.mensagem).toMatch(
      /Lead do Facebook|criado|Negócio|contato/i,
    );
    expect((recebimento.corpo as Record<string, unknown>).leadgen_id).toBe(
      perdido.id,
    );
    expect(
      await t.prisma.contato.count({ where: { email: 'gabi@exemplo.com.br' } }),
    ).toBe(1);
    expect(
      await t.prisma.contato.count({
        where: { email: 'antigo@exemplo.com.br' },
      }),
    ).toBe(0);
    expect(
      await t.prisma.leadFacebook.findFirstOrThrow({
        where: { webhookId: integracao.id },
      }),
    ).toMatchObject({
      origem: 'RECONCILIACAO',
      leadgenId: perdido.id,
    });
    expect((await configuracaoDe(integracao.id)).reconciliadoAte).toEqual(
      expect.any(String),
    );
    // Segunda rodada sem novidade; novo lead perdido entra.
    expect(await servico.reconciliar()).toBe(0);
    graph.novoLead(FORM_1, { full_name: 'Hugo', email: 'hugo@exemplo.com.br' });
    expect(await servico.reconciliar()).toBe(1);
    // Integração inativa não é reconciliada.
    await admin
      .patch(`/api/v1/webhooks/entradas/${integracao.id}`, { ativo: false })
      .expect(200);
    graph.novoLead(FORM_1, { full_name: 'Iva', email: 'iva@exemplo.com.br' });
    const pedidos = graph.pedidos.length;
    expect(await servico.reconciliar()).toBe(0);
    expect(graph.pedidos.length).toBe(pedidos);
  });

  it('cenário 355 (R32.14) — token recusado (no webhook ou na reconciliação): a integração precisa de atenção, o Admin é avisado uma vez, e o lead entra depois do novo login', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const servico = t.get(FacebookLeadAdsServiceParaTeste);
    graph.revogados.add(`pg-${PAGINA_1}`);
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Jota',
      email: 'jota@exemplo.com.br',
    });
    await enviarLeadgen(lead).expect(200);
    await processar();
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      situacao: string;
      atencaoMotivo: string;
    };
    expect(dto.situacao).toBe('PRECISA_ATENCAO');
    expect(dto.atencaoMotivo).toMatch(/Facebook recusou o token/);
    expect(await recebimentosDe(integracao.id)).toHaveLength(0);
    const avisos = await avisosDeAtencao();
    expect(avisos).toHaveLength(1);
    expect(avisos[0].link).toBe(`/integracoes?integracao=${integracao.id}`);
    // A reconciliação também falha, sem novo aviso.
    expect(await servico.reconciliar()).toBe(0);
    expect(await avisosDeAtencao()).toHaveLength(1);
    expect(
      (
        (await admin.get(`${API}/conexoes/${conexaoId}`).expect(200)).body as {
          precisaAtencao: boolean;
        }
      ).precisaAtencao,
    ).toBe(true);

    // O Admin entra com o Facebook de novo (mesma conexão): tokens novos, atenção limpa.
    graph.revogados.clear();
    graph.revogados.add(`pg-${PAGINA_1}-antigo`);
    const novo = await admin
      .post(`${API}/oauth/iniciar`, { conexaoId })
      .expect(201);
    const dialogo = new URL((novo.body as { urlDialogo: string }).urlDialogo);
    const code = graph.novoCodigo(
      dialogo.searchParams.get('redirect_uri') ?? '',
    );
    await request(t.servidor)
      .get('/api/v1/publico/facebook/oauth/retorno')
      .query({ code, state: dialogo.searchParams.get('state') })
      .expect(302);
    const depois = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as { situacao: string };
    expect(depois.situacao).toBe('ATIVA');
    // O lead que ficou para trás entra pela reconciliação.
    expect(await servico.reconciliar()).toBe(1);
    await processar();
    expect(
      await t.prisma.contato.count({ where: { email: 'jota@exemplo.com.br' } }),
    ).toBe(1);
  });

  it('cenário 356 (R32.14) — a Meta nega a permissão de leads (leads_retrieval / Leads Access): atenção com a orientação, e volta sozinha quando a Meta libera', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const servico = t.get(FacebookLeadAdsServiceParaTeste);
    graph.erroNosLeads = 200;
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Kaká',
      email: 'kaka@exemplo.com.br',
    });
    await enviarLeadgen(lead).expect(200);
    await processar();
    const dto = (
      await admin.get(`/api/v1/webhooks/entradas/${integracao.id}`).expect(200)
    ).body as {
      situacao: string;
      atencaoMotivo: string;
    };
    expect(dto.situacao).toBe('PRECISA_ATENCAO');
    expect(dto.atencaoMotivo).toMatch(/leads_retrieval/);
    expect(dto.atencaoMotivo).toMatch(/Leads Access/);
    graph.erroNosLeads = null;
    expect(await servico.reconciliar()).toBe(1);
    await processar();
    expect(
      (
        (
          await admin
            .get(`/api/v1/webhooks/entradas/${integracao.id}`)
            .expect(200)
        ).body as { situacao: string }
      ).situacao,
    ).toBe('ATIVA');
  });

  it('cenário 357 (R32.14) — o endereço público da integração não recebe leads direto; só o roteador da Meta, com a assinatura do app', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const dto = (
      await admin
        .get(`/api/v1/webhooks/entradas/${integracao.id}/endereco`)
        .expect(200)
    ).body as { url: string };
    const token = dto.url.slice(dto.url.lastIndexOf('/') + 1);
    const resposta = await request(t.servidor)
      .post(`/api/v1/webhooks/entrada/${token}`)
      .send({ full_name: 'Intruso', email: 'intruso@exemplo.com.br' })
      .expect(401);
    expect((resposta.body as { mensagem: string }).mensagem).toMatch(
      /Facebook Lead Ads não envia/,
    );
    await processar();
    expect(
      await t.prisma.contato.count({
        where: { email: 'intruso@exemplo.com.br' },
      }),
    ).toBe(0);
  });

  it('cenário 358 (R32.14, R14) — o roteador continua tratando o Messenger: eventos de mensagem sem leadgen seguem o caminho de antes e o desafio de verificação não muda', async () => {
    const { conexaoId } = await conectar();
    await criarIntegracao(conexaoId);
    // Evento de Messenger de uma página sem canal: ignorado como sempre (recebidas 0), sem tentar ler lead.
    const corpo = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGINA_1,
          time: 1,
          messaging: [
            {
              sender: { id: '1' },
              recipient: { id: PAGINA_1 },
              timestamp: 1,
              message: { mid: 'm_1', text: 'oi' },
            },
          ],
        },
      ],
    });
    const resposta = await request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', assinar(corpo))
      .send(corpo)
      .expect(200);
    expect(resposta.body).toEqual({ recebidas: 0 });
    await request(t.servidor)
      .get('/api/v1/publico/meta/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'inexistente',
        'hub.challenge': 'x',
      })
      .expect(403);
  });

  it('R32.14, R14 — leadgen com assinatura que não confere não derruba as entradas de Messenger do mesmo POST assinadas pelo app do canal', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const SEGREDO_DO_CANAL = 'segredo-do-app-do-canal-00000000';
    await admin
      .post('/api/v1/meta/canais', {
        tipo: 'MESSENGER',
        nome: 'Página do Messenger',
        appId: '9876543210123456',
        appSecret: SEGREDO_DO_CANAL,
        pageId: PAGINA_1,
        tokenPagina: 'EAAB-token-da-pagina-1',
      })
      .expect(201);
    const lead = graph.novoLead(FORM_1, {
      full_name: 'Ana',
      email: 'ana@exemplo.com.br',
    });
    const corpo = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGINA_1,
          time: 1,
          messaging: [
            {
              sender: { id: '1' },
              recipient: { id: PAGINA_1 },
              timestamp: 1,
              message: { mid: 'm_9', text: 'oi' },
            },
          ],
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: lead.id,
                page_id: PAGINA_1,
                form_id: FORM_1,
                created_time: 1,
              },
            },
          ],
        },
      ],
    });
    const resposta = await request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', assinar(corpo, SEGREDO_DO_CANAL))
      .send(corpo)
      .expect(200);
    expect(resposta.body).toEqual({ recebidas: 1 });
    await processar();
    // O lead não foi lido (assinatura do app do Lead Ads não confere).
    expect(await recebimentosDe(integracao.id)).toHaveLength(0);
    // Sem nenhum ramo autêntico: 401.
    await request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('content-type', 'application/json')
      .set(
        'x-hub-signature-256',
        assinar(corpo, 'segredo-qualquer-xxxxxxxxxxxxxxx'),
      )
      .send(corpo)
      .expect(401);
  });

  it('cenário 359 (R32.14) — excluir a conexão: 409 enquanto há integração, 204 depois, com os tokens apagados e a conexão fora da lista', async () => {
    const { conexaoId } = await conectar();
    const integracao = await criarIntegracao(conexaoId);
    const conflito = await admin
      .delete(`${API}/conexoes/${conexaoId}`)
      .expect(409);
    expect((conflito.body as { mensagem: string }).mensagem).toMatch(
      /1 integração/,
    );
    await admin
      .delete(`/api/v1/webhooks/entradas/${integracao.id}`)
      .expect(204);
    await admin.delete(`${API}/conexoes/${conexaoId}`).expect(204);
    const linha = await t.prisma.conexaoFacebook.findUniqueOrThrow({
      where: { id: conexaoId },
    });
    expect(linha.tokenCifrado).toBeNull();
    expect(linha.paginasCifradas).toBeNull();
    expect(linha.excluidoEm).not.toBeNull();
    expect((await admin.get(`${API}/conexoes`).expect(200)).body).toEqual([]);
    await admin.get(`${API}/conexoes/${conexaoId}`).expect(404);
    await admin.delete(`${API}/conexoes/${conexaoId}`).expect(404);
  });
});
