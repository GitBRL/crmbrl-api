import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AdaptadorWhatsappOficial } from '../src/canais/whatsapp-oficial/adaptador-whatsapp-oficial';
import { FILA_WEBHOOK_WHATSAPP_OFICIAL } from '../src/canais/whatsapp-oficial/entrada-whatsapp-oficial.service';
import {
  FILA_TEMPLATES_OFICIAIS,
  TemplatesOficiaisService,
} from '../src/canais/whatsapp-oficial/templates-oficiais.service';
import { LimitadorDeRequisicoes } from '../src/canais/comum/limitador';
import { RegistroCanais } from '../src/canais/registro-canais';
import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import { type CenarioDoAtendimento, montarCenario } from './atendimento-apoio';
import { caminhoSemProva, ConferenciaDeProva } from './utils/prova-da-chave';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarArquivo,
  criarContato,
  criarCanal,
  criarIdentificador,
  drenarFilas,
  entrarComo,
  PNG_DE_TESTE,
} from './utils';

const APP_SECRET = 'segredo-do-app-oficial-de-teste';
const TOKEN = 'EAAG-token-oficial-de-teste';
const NUMERO_ID = '100000000000001';
const WABA_ID = '200000000000001';
const NUMERO_EXIBIDO = '+55 11 4000-1000';
const TELEFONE = '5511999990000';

interface PedidoRecebido {
  metodo: string;
  caminho: string;
  autorizacao: string | undefined;
  tipo: string | undefined;
  corpo: Record<string, unknown> | null;
  /** Corpo multipart (texto, até 3 KB), para conferir os campos do upload. */
  bruto: string;
}

interface TemplateFalso {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown[];
}

/** Graph API falsa (Cloud API do WhatsApp), numa porta livre. */
async function subirGraphFalsa() {
  const pedidos: PedidoRecebido[] = [];
  const prova = new ConferenciaDeProva(APP_SECRET);
  const estado = {
    sequencia: 0,
    /** Respostas de erro por destinatário (`to`). */
    erroPara: new Map<
      string,
      { status: number; erro: Record<string, unknown> }
    >(),
    /** Textos que falham uma vez com 500. */
    instaveis: new Set<string>(),
    templates: [] as TemplateFalso[],
    /** Quebra a listagem de templates. */
    templatesComErro: false,
  };
  const servidor: Server = createServer((req: IncomingMessage, res) => {
    const partes: Buffer[] = [];
    req.on('data', (parte: Buffer) => partes.push(parte));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://graph');
      const bruto = Buffer.concat(partes);
      const tipo = req.headers['content-type'];
      const corpo =
        tipo?.startsWith('application/json') && bruto.length > 0
          ? (JSON.parse(bruto.toString('utf8')) as Record<string, unknown>)
          : null;
      pedidos.push({
        metodo: req.method ?? '',
        caminho: caminhoSemProva(url),
        autorizacao: req.headers.authorization,
        tipo,
        corpo,
        bruto: tipo?.startsWith('multipart/')
          ? bruto.toString('latin1').slice(0, 3000)
          : '',
      });
      const responder = (
        status: number,
        dados: unknown,
        mime = 'application/json',
      ) => {
        res.writeHead(status, { 'content-type': mime });
        res.end(Buffer.isBuffer(dados) ? dados : JSON.stringify(dados));
      };
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) {
        responder(401, { error: { message: 'Sem token', code: 190 } });
        return;
      }
      if (token === 'token-vencido') {
        responder(400, {
          error: {
            message: 'Invalid OAuth access token',
            type: 'OAuthException',
            code: 190,
          },
        });
        return;
      }
      // "Exigir chave secreta do aplicativo" ligado: toda chamada com token traz o appsecret_proof (a CDN não).
      const recusa = url.pathname.startsWith('/cdn/')
        ? null
        : prova.conferir(url, token);
      if (recusa) {
        responder(recusa.status, { error: recusa.erro });
        return;
      }
      if (url.pathname === '/cdn/foto.png') {
        responder(200, PNG_DE_TESTE, 'image/png');
        return;
      }
      if (url.pathname === '/v24.0/MEDIA_FOTO') {
        responder(200, {
          url: `http://${req.headers.host}/cdn/foto.png`,
          mime_type: 'image/png',
          id: 'MEDIA_FOTO',
        });
        return;
      }
      if (url.pathname === '/v24.0/MEDIA_EXPIRADA') {
        responder(404, { error: { message: 'Media not found', code: 100 } });
        return;
      }
      const caminho = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && caminho[2] === 'messages') {
        const para = String((corpo?.to ?? corpo?.recipient ?? '') as string);
        const falha = estado.erroPara.get(para);
        if (falha) {
          responder(falha.status, { error: falha.erro });
          return;
        }
        const texto = (corpo?.text as { body?: string } | undefined)?.body;
        if (
          texto?.startsWith('instavel-uma-vez') &&
          !estado.instaveis.has(texto)
        ) {
          estado.instaveis.add(texto);
          responder(500, { error: { message: 'Unexpected', code: 2 } });
          return;
        }
        estado.sequencia++;
        responder(200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: para, wa_id: para }],
          messages: [{ id: `wamid.FALSO${estado.sequencia}` }],
        });
        return;
      }
      if (req.method === 'POST' && caminho[2] === 'media') {
        estado.sequencia++;
        responder(200, { id: `MEDIA_ENVIADA_${estado.sequencia}` });
        return;
      }
      if (req.method === 'GET' && caminho[2] === 'message_templates') {
        if (estado.templatesComErro) {
          responder(500, { error: { message: 'Falha na Meta', code: 2 } });
          return;
        }
        const depois = url.searchParams.get('after');
        const metade = Math.ceil(estado.templates.length / 2);
        const pagina = depois
          ? estado.templates.slice(metade)
          : estado.templates.slice(0, metade);
        responder(200, {
          data: pagina,
          paging:
            !depois && estado.templates.length > 1
              ? { cursors: { after: 'CURSOR2' }, next: 'http://x/proxima' }
              : { cursors: { after: 'FIM' } },
        });
        return;
      }
      if (req.method === 'GET' && caminho.length === 2) {
        responder(200, {
          id: caminho[1],
          display_phone_number: NUMERO_EXIBIDO,
          verified_name: 'Loja BRL',
          quality_rating: 'GREEN',
        });
        return;
      }
      responder(404, { error: { message: 'Unknown path', code: 803 } });
    });
  });
  await new Promise<void>((resolver) =>
    servidor.listen(0, '127.0.0.1', resolver),
  );
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pedidos,
    estado,
    prova,
    fechar: () =>
      new Promise<void>((resolver) => servidor.close(() => resolver())),
  };
}

const TEMPLATE_PEDIDO: TemplateFalso = {
  id: 'T1',
  name: 'pedido_enviado',
  language: 'pt_BR',
  category: 'UTILITY',
  status: 'APPROVED',
  components: [
    { type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} saiu para entrega.' },
    { type: 'FOOTER', text: 'Equipe BRL' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Rastrear', url: 'https://brl.com/r/{{1}}' },
      ],
    },
  ],
};
const TEMPLATE_PROMO: TemplateFalso = {
  id: 'T2',
  name: 'promocao',
  language: 'pt_BR',
  category: 'MARKETING',
  status: 'APPROVED',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Promoção de novembro!' },
  ],
};
const TEMPLATE_PENDENTE: TemplateFalso = {
  id: 'T3',
  name: 'novo_modelo',
  language: 'pt_BR',
  category: 'UTILITY',
  status: 'PENDING',
  components: [{ type: 'BODY', text: 'Em análise.' }],
};

/**
 * Canal WhatsApp oficial (Onda E, R28): configuração, webhook (verificação,
 * assinatura por canal, campos), entrada (texto, mídia, localização, contatos,
 * botões, reações, BSUID), status, envio (janela de 24 h, texto, mídia, voz,
 * template) e templates (sincronização manual e diária), contra uma Graph falsa.
 */
describe('Canal WhatsApp oficial (e2e)', () => {
  let t: AppTeste;
  let graph: Awaited<ReturnType<typeof subirGraphFalsa>>;
  let cenario: CenarioDoAtendimento;
  let admin: ClienteHttp;

  beforeAll(async () => {
    graph = await subirGraphFalsa();
    t = await criarAppTeste({ variaveis: { META_GRAPH_URL: graph.url } });
  });
  beforeEach(async () => {
    await t.limparBanco();
    graph.pedidos.length = 0;
    graph.prova.limpar();
    graph.estado.sequencia = 0;
    graph.estado.erroPara.clear();
    graph.estado.instaveis.clear();
    graph.estado.templatesComErro = false;
    graph.estado.templates = [
      TEMPLATE_PEDIDO,
      TEMPLATE_PROMO,
      TEMPLATE_PENDENTE,
    ];
    t.get(LimitadorDeRequisicoes).zerar();
    cenario = await montarCenario(t);
    admin = await entrarComo(t, cenario.admin);
  });
  afterEach(() => {
    // R14.10 — nenhuma chamada com token saiu sem o appsecret_proof certo.
    expect(graph.prova.recusadas).toEqual([]);
  });
  afterAll(async () => {
    await t?.fechar();
    await graph?.fechar();
    // R14.10 — a conferência da prova rodou de verdade (não passou em branco).
    expect(graph.prova.totalAceitas).toBeGreaterThan(0);
  });

  async function criarOficial(corpo: object = {}) {
    const resposta = await admin
      .post('/api/v1/whatsapp-oficial/canais', {
        nome: 'WhatsApp oficial',
        phoneNumberId: NUMERO_ID,
        wabaId: WABA_ID,
        token: TOKEN,
        appSecret: APP_SECRET,
        filaPadraoId: cenario.fila.id,
        ...corpo,
      })
      .expect(201);
    return resposta.body as {
      id: string;
      webhook: { url: string; tokenVerificacao: string; campos: string[] };
      [campo: string]: unknown;
    };
  }

  function postarWebhook(corpo: object, segredo: string | null = APP_SECRET) {
    const bruto = JSON.stringify(corpo);
    const pedido = request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('Content-Type', 'application/json');
    if (segredo) {
      pedido.set(
        'X-Hub-Signature-256',
        `sha256=${createHmac('sha256', segredo).update(bruto).digest('hex')}`,
      );
    }
    return pedido.send(bruto);
  }

  const agoraEmSegundos = () => String(Math.floor(Date.now() / 1000));

  /** Corpo do webhook do WhatsApp com `messages` e/ou `statuses` de um número. */
  const mudanca = (
    valor: { messages?: object[]; statuses?: object[]; contacts?: object[] },
    opcoes: { numeroId?: string; campo?: string } = {},
  ) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: opcoes.campo ?? 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '551140001000',
                phone_number_id: opcoes.numeroId ?? NUMERO_ID,
              },
              contacts: valor.contacts ?? [
                { profile: { name: 'Maria Souza' }, wa_id: TELEFONE },
              ],
              messages: valor.messages,
              statuses: valor.statuses,
            },
          },
        ],
      },
    ],
  });

  const textoDoContato = (id: string, corpo: string, extra: object = {}) =>
    mudanca({
      messages: [
        {
          from: TELEFONE,
          id,
          timestamp: agoraEmSegundos(),
          type: 'text',
          text: { body: corpo },
          ...extra,
        },
      ],
    });

  async function receber(corpo: object) {
    await postarWebhook(corpo).expect(200);
    await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);
  }

  /** Canal + uma conversa aberta com a janela de 24 h aberta (o contato escreveu agora). */
  async function conversaComJanela() {
    const canal = await criarOficial();
    await receber(textoDoContato('wamid.ENTRADA1', 'Olá, quero saber mais'));
    const conversa = await t.prisma.conversa.findFirstOrThrow({
      where: { canalId: canal.id },
    });
    return { canal, conversa };
  }

  async function fecharJanela(conversaId: string) {
    await t.prisma.conversa.update({
      where: { id: conversaId },
      data: { janelaAte: new Date(Date.now() - 1000) },
    });
  }

  const enviarMensagem = (conversaId: string, corpo: object) =>
    admin.post(`/api/v1/atendimento/conversas/${conversaId}/mensagens`, corpo);

  const drenarEnvios = (incluirAgendados = false) =>
    drenarFilas(t, FILA_ENVIO_ATENDIMENTO, { incluirAgendados });

  const postsDeMensagem = () =>
    graph.pedidos.filter(
      (p) =>
        p.metodo === 'POST' && p.caminho === `/v24.0/${NUMERO_ID}/messages`,
    );

  // -------------------------------------------------------------------------

  describe('R28.1 — configuração (Admin)', () => {
    it('cenário 154 — R28.1 — cria com segredos cifrados e mascarados, gera o verify token e mostra a URL do webhook', async () => {
      const canal = await criarOficial({ numeroExibido: NUMERO_EXIBIDO });
      expect(canal).toMatchObject({
        tipo: 'WHATSAPP_OFICIAL',
        idExterno: NUMERO_ID,
        phoneNumberId: NUMERO_ID,
        wabaId: WABA_ID,
        numeroExibido: NUMERO_EXIBIDO,
        token: expect.stringMatching(/^••••••••/),
        appSecret: expect.stringMatching(/^••••••••/),
        webhook: {
          url: 'http://localhost:4200/api/v1/publico/meta/webhook',
          tokenVerificacao: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
          campos: ['messages', 'calls'],
        },
        estado: { situacao: 'NAO_TESTADO', motivo: null },
        templates: { total: 0, aprovados: 0, sincronizadoEm: null },
      });
      expect(JSON.stringify(canal)).not.toContain(APP_SECRET);
      expect(JSON.stringify(canal)).not.toContain(TOKEN);
      const gravado = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      expect(gravado.segredosCifrados).not.toContain(TOKEN);
      expect(JSON.stringify(gravado.configuracao)).not.toContain(APP_SECRET);
      expect(gravado.filaPadraoId).toBe(cenario.fila.id);

      const lista = await admin
        .get('/api/v1/whatsapp-oficial/canais')
        .expect(200);
      expect(lista.body).toHaveLength(1);
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'canal.criado', entidadeId: canal.id },
      });
      expect(auditoria).toHaveLength(1);
      expect(JSON.stringify(auditoria[0].dados)).not.toContain(TOKEN);
      expect(JSON.stringify(auditoria[0].dados)).not.toContain(APP_SECRET);
    });

    it('cenário 155 — R28.1 — só o Admin configura (403); o mesmo número em dois canais é 409; ids inválidos 400', async () => {
      const comercial = await entrarComo(t, cenario.comercial.membros[0]);
      await comercial.get('/api/v1/whatsapp-oficial/canais').expect(403);
      await comercial.post('/api/v1/whatsapp-oficial/canais', {}).expect(403);
      await criarOficial();
      await admin
        .post('/api/v1/whatsapp-oficial/canais', {
          nome: 'Outro',
          phoneNumberId: NUMERO_ID,
          wabaId: WABA_ID,
          token: TOKEN,
          appSecret: APP_SECRET,
        })
        .expect(409);
      const invalido = await admin
        .post('/api/v1/whatsapp-oficial/canais', {
          nome: 'Ruim',
          phoneNumberId: 'abc',
          wabaId: WABA_ID,
          token: TOKEN,
          appSecret: APP_SECRET,
        })
        .expect(400);
      expect(invalido.body.detalhes.campos[0].campo).toBe('phoneNumberId');
    });

    it('cenário 156 — R28.1 — "Testar conexão": lê o número na Graph; token vencido vira estado ERRO com o motivo', async () => {
      const canal = await criarOficial();
      const teste = await admin
        .post(`/api/v1/whatsapp-oficial/canais/${canal.id}/testar`)
        .expect(200);
      expect(teste.body).toEqual({
        ok: true,
        mensagem: `Conectado ao número ${NUMERO_EXIBIDO} (Loja BRL).`,
        numeroExibido: NUMERO_EXIBIDO,
        nomeVerificado: 'Loja BRL',
        qualidade: 'GREEN',
      });
      expect(graph.pedidos.at(-1)).toMatchObject({
        metodo: 'GET',
        caminho: `/v24.0/${NUMERO_ID}?fields=display_phone_number,verified_name,quality_rating`,
        autorizacao: `Bearer ${TOKEN}`,
      });
      const conectado = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}`)
        .expect(200);
      expect(conectado.body).toMatchObject({
        numeroExibido: NUMERO_EXIBIDO,
        estado: {
          situacao: 'CONECTADO',
          nomeVerificado: 'Loja BRL',
          qualidade: 'GREEN',
        },
      });

      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canal.id}`, {
          token: 'token-vencido',
        })
        .expect(200);
      const falhou = await admin
        .post(`/api/v1/whatsapp-oficial/canais/${canal.id}/testar`)
        .expect(200);
      expect(falhou.body).toMatchObject({
        ok: false,
        mensagem: 'O token do canal é inválido ou expirou.',
      });
      const comErro = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}`)
        .expect(200);
      expect(comErro.body.estado).toMatchObject({
        situacao: 'ERRO',
        motivo: 'O token do canal é inválido ou expirou.',
      });
      // Trocar o token limpa o erro.
      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canal.id}`, { token: TOKEN })
        .expect(200)
        .expect(({ body }) => expect(body.estado.motivo).toBeNull());
    });

    it('cenário 157 — R28.1 — gera outro verify token (o antigo deixa de valer) e exclui o canal', async () => {
      const canal = await criarOficial();
      const antigo = canal.webhook.tokenVerificacao;
      const novo = await admin
        .post(`/api/v1/whatsapp-oficial/canais/${canal.id}/token-verificacao`)
        .expect(200);
      expect(novo.body.tokenVerificacao).not.toBe(antigo);
      await request(t.servidor)
        .get('/api/v1/publico/meta/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': antigo,
          'hub.challenge': 'x',
        })
        .expect(403);
      await admin
        .delete(`/api/v1/whatsapp-oficial/canais/${canal.id}`)
        .expect(204);
      await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}`)
        .expect(404);
    });
  });

  describe('R28.2 — webhook', () => {
    it('cenário 158 — R28.2 — a verificação GET aceita o verify token do canal oficial e recusa o errado', async () => {
      const canal = await criarOficial();
      const desafio = await request(t.servidor)
        .get('/api/v1/publico/meta/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': canal.webhook.tokenVerificacao,
          'hub.challenge': 'desafio-123',
        })
        .expect(200);
      expect(desafio.text).toBe('desafio-123');
      await request(t.servidor)
        .get('/api/v1/publico/meta/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'errado',
          'hub.challenge': 'x',
        })
        .expect(403);
    });

    it('cenário 159 — R28.2 — exige a assinatura do app secret DO canal (401 sem ela ou com a de outro)', async () => {
      await criarOficial();
      const corpo = textoDoContato('wamid.X1', 'oi');
      await postarWebhook(corpo, null).expect(401);
      await postarWebhook(corpo, 'segredo-de-outro-app').expect(401);
      expect(await t.prisma.mensagem.count()).toBe(0);
      await postarWebhook(corpo).expect(200, { recebidas: 1 });
    });

    it('cenário 160 — R28.2 — número desconhecido e campos sem tratador (account_update) são ignorados com 200', async () => {
      await criarOficial();
      await postarWebhook(
        mudanca({ messages: [] }, { numeroId: '999' }),
        'qualquer',
      ).expect(200, { recebidas: 0 });
      await postarWebhook(
        mudanca({ messages: [] }, { campo: 'account_update' }),
        'qualquer',
      ).expect(200, { recebidas: 0 });
      expect(
        await t.fila.listarTrabalhos(FILA_WEBHOOK_WHATSAPP_OFICIAL),
      ).toHaveLength(0);
    });

    it('cenário 161 — R28.2 — cada número usa o seu app secret: uma mudança assinada com o segredo errado de outro canal não entra', async () => {
      await criarOficial();
      await criarOficial({
        nome: 'Segundo número',
        phoneNumberId: '100000000000002',
        appSecret: 'segredo-do-segundo-app',
      });
      const corpo = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA_ID,
            changes: ['100000000000001', '100000000000002'].map((id, i) => ({
              field: 'messages',
              value: {
                metadata: { phone_number_id: id },
                contacts: [{ profile: { name: 'M' }, wa_id: TELEFONE }],
                messages: [
                  {
                    from: TELEFONE,
                    id: `wamid.DOIS${i}`,
                    timestamp: agoraEmSegundos(),
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              },
            })),
          },
        ],
      };
      // Assinado com o segredo do primeiro: só a mudança do primeiro entra.
      await postarWebhook(corpo, APP_SECRET).expect(200, { recebidas: 1 });
    });
  });

  describe('R28.3 / R28.5 — entrada', () => {
    it('cenário 162 — R28.3 — texto: contato pelo telefone (E.164), conversa na fila do canal, janela de 24 h e idempotência', async () => {
      const canal = await criarOficial();
      const existente = await criarContato(t, {
        nome: 'Maria (CRM)',
        telefone: TELEFONE,
      });
      const corpo = textoDoContato('wamid.T1', 'Quero um orçamento');
      await postarWebhook(corpo).expect(200, { recebidas: 1 });
      expect(await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL)).toBe(1);
      // A Meta reentrega: não duplica.
      await postarWebhook(corpo).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);

      const conversas = await t.prisma.conversa.findMany({
        where: { canalId: canal.id },
        include: { mensagens: true },
      });
      expect(conversas).toHaveLength(1);
      expect(conversas[0]).toMatchObject({
        contatoId: existente.id, // a mesma pessoa do Baileys / do cadastro
        filaId: cenario.fila.id,
        idExterno: TELEFONE,
      });
      expect(conversas[0].mensagens).toHaveLength(1);
      expect(conversas[0].mensagens[0]).toMatchObject({
        idExterno: 'wamid.T1',
        tipo: 'TEXTO',
        texto: 'Quero um orçamento',
        direcao: 'ENTRADA',
      });
      const janela = conversas[0].janelaAte?.getTime() ?? 0;
      expect(janela - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
      expect(janela - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
      expect(await t.prisma.contato.count()).toBe(1);
      expect(
        await t.prisma.contatoIdentificador.findMany({
          where: { contatoId: existente.id },
        }),
      ).toEqual([
        expect.objectContaining({ tipo: 'WHATSAPP', valor: TELEFONE }),
      ]);
    });

    it('cenário 163 — R28.3 — contato novo: nome do perfil, origem WhatsApp, telefone só com dígitos', async () => {
      await criarOficial();
      await receber(
        mudanca({
          contacts: [
            { profile: { name: 'Joana Prado' }, wa_id: '+55 (11) 98888-7777' },
          ],
          messages: [
            {
              from: '+55 (11) 98888-7777',
              id: 'wamid.N1',
              timestamp: agoraEmSegundos(),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      );
      const contato = await t.prisma.contato.findFirstOrThrow();
      expect(contato).toMatchObject({
        nome: 'Joana Prado',
        telefone: '5511988887777',
        primeiraOrigem: 'WHATSAPP',
      });
    });

    it('cenário 164 — R28.5 — mídia: baixada com o token (2 passos) e guardada; mídia expirada vira aviso', async () => {
      const canal = await criarOficial();
      await receber(
        mudanca({
          messages: [
            {
              from: TELEFONE,
              id: 'wamid.M1',
              timestamp: agoraEmSegundos(),
              type: 'image',
              image: {
                id: 'MEDIA_FOTO',
                mime_type: 'image/png',
                caption: 'Veja a foto',
              },
            },
            {
              from: TELEFONE,
              id: 'wamid.M2',
              timestamp: agoraEmSegundos(),
              type: 'image',
              image: { id: 'MEDIA_EXPIRADA', mime_type: 'image/jpeg' },
            },
          ],
        }),
      );
      const mensagens = await t.prisma.mensagem.findMany({
        where: { canalId: canal.id },
        include: { arquivo: true },
        orderBy: { idExterno: 'asc' },
      });
      expect(mensagens[0]).toMatchObject({
        idExterno: 'wamid.M1',
        tipo: 'IMAGEM',
        texto: 'Veja a foto',
        arquivo: {
          mime: 'image/png',
          contexto: 'MENSAGEM',
          nome: expect.stringMatching(/\.png$/),
        },
      });
      expect(mensagens[1]).toMatchObject({
        idExterno: 'wamid.M2',
        tipo: 'TEXTO',
        texto: '[Mídia não disponível]',
        arquivoId: null,
      });
      const downloads = graph.pedidos.filter(
        (p) => p.caminho === '/cdn/foto.png',
      );
      expect(downloads).toHaveLength(1);
      expect(downloads[0].autorizacao).toBe(`Bearer ${TOKEN}`);
      expect(
        graph.pedidos.some(
          (p) =>
            p.caminho === '/v24.0/MEDIA_FOTO' &&
            p.autorizacao === `Bearer ${TOKEN}`,
        ),
      ).toBe(true);
    });

    it('cenário 165 — R28.5 — localização, contatos, resposta de botão e de lista e reação', async () => {
      const canal = await criarOficial();
      const base = { from: TELEFONE, timestamp: agoraEmSegundos() };
      await receber(
        mudanca({
          messages: [
            {
              ...base,
              id: 'wamid.L1',
              type: 'location',
              location: {
                latitude: -23.55,
                longitude: -46.63,
                name: 'Loja Paulista',
                address: 'Av. Paulista, 1000',
              },
            },
            {
              ...base,
              id: 'wamid.C1',
              type: 'contacts',
              contacts: [
                {
                  name: { formatted_name: 'João Silva' },
                  phones: [{ phone: '+5511977776666' }],
                },
              ],
            },
            {
              ...base,
              id: 'wamid.B1',
              type: 'interactive',
              interactive: {
                type: 'button_reply',
                button_reply: { id: 'sim', title: 'Sim, quero' },
              },
              context: { id: 'wamid.ENVIADA' },
            },
            {
              ...base,
              id: 'wamid.S1',
              type: 'interactive',
              interactive: {
                type: 'list_reply',
                list_reply: {
                  id: 'plano-a',
                  title: 'Plano A',
                  description: 'Mensal',
                },
              },
            },
            {
              ...base,
              id: 'wamid.R1',
              type: 'reaction',
              reaction: { message_id: 'wamid.L1', emoji: '👍' },
            },
            { ...base, id: 'wamid.U1', type: 'order' },
          ],
        }),
      );
      const m = async (id: string) =>
        t.prisma.mensagem.findUniqueOrThrow({
          where: { canalId_idExterno: { canalId: canal.id, idExterno: id } },
        });
      expect(await m('wamid.L1')).toMatchObject({
        tipo: 'LOCALIZACAO',
        texto: 'Loja Paulista — Av. Paulista, 1000',
        metadados: {
          latitude: -23.55,
          longitude: -46.63,
          nome: 'Loja Paulista',
        },
      });
      expect(await m('wamid.C1')).toMatchObject({
        tipo: 'CONTATO',
        texto: 'João Silva',
        metadados: {
          nome: 'João Silva',
          vcard: expect.stringContaining('TEL:+5511977776666'),
        },
      });
      expect(await m('wamid.B1')).toMatchObject({
        tipo: 'TEXTO',
        texto: 'Sim, quero',
        metadados: {
          interativo: {
            origem: 'button_reply',
            id: 'sim',
            titulo: 'Sim, quero',
          },
        },
      });
      expect(await m('wamid.S1')).toMatchObject({
        texto: 'Plano A',
        metadados: {
          interativo: { origem: 'list_reply', descricao: 'Mensal' },
        },
      });
      expect(await m('wamid.R1')).toMatchObject({
        tipo: 'REACAO',
        texto: '👍',
        metadados: { emoji: '👍', alvoIdExterno: 'wamid.L1' },
      });
      expect(await m('wamid.U1')).toMatchObject({
        tipo: 'TEXTO',
        texto: '(mensagem não suportada pelo CRM)',
      });
    });

    it('cenário 166 — R28.3 — entra pelas mesmas regras: SLA da fila, notificação e evento de mensagem recebida', async () => {
      await criarOficial();
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { slaPrimeiraRespostaMinutos: 10 },
      });
      await receber(textoDoContato('wamid.SLA', 'Preciso de ajuda'));
      const conversa = await t.prisma.conversa.findFirstOrThrow();
      expect(conversa.slaPrimeiraRespostaAte).not.toBeNull();
      expect(conversa.naoLidas).toBe(1);
      const eventos = await t.prisma.eventoDominio.findMany({
        where: { tipo: 'mensagem.recebida' },
      });
      expect(eventos.length).toBeGreaterThan(0);
    });
  });

  describe('R28.6 — BSUID', () => {
    const bsuid = 'BR.13491208655302741918';

    it('cenário 167 — R28.6 — sem telefone, o contato é identificado pelo BSUID; quando o telefone aparece, é o mesmo contato', async () => {
      const canal = await criarOficial();
      await receber(
        mudanca({
          contacts: [{ profile: { username: 'maria.s' }, user_id: bsuid }],
          messages: [
            {
              from_user_id: bsuid,
              id: 'wamid.B1',
              timestamp: agoraEmSegundos(),
              type: 'text',
              text: { body: 'oi, sem telefone' },
            },
          ],
        }),
      );
      const contato = await t.prisma.contato.findFirstOrThrow({
        include: { identificadores: true },
      });
      expect(contato).toMatchObject({ nome: 'maria.s', telefone: null });
      expect(contato.identificadores).toEqual([
        expect.objectContaining({
          tipo: 'WHATSAPP_BSUID',
          valor: bsuid,
          canalId: canal.id,
        }),
      ]);

      // Depois o telefone aparece (mesmo BSUID): os dois identificadores no mesmo contato.
      await receber(
        mudanca({
          contacts: [
            {
              profile: { name: 'Maria Souza' },
              wa_id: TELEFONE,
              user_id: bsuid,
            },
          ],
          messages: [
            {
              from: TELEFONE,
              from_user_id: bsuid,
              id: 'wamid.B2',
              timestamp: agoraEmSegundos(),
              type: 'text',
              text: { body: 'agora com telefone' },
            },
          ],
        }),
      );
      expect(await t.prisma.contato.count()).toBe(1);
      const depois = await t.prisma.contato.findFirstOrThrow({
        include: { identificadores: true },
      });
      expect(depois.telefone).toBe(TELEFONE);
      expect(depois.identificadores.map((i) => `${i.tipo}:${i.valor}`)).toEqual(
        expect.arrayContaining([
          `WHATSAPP:${TELEFONE}`,
          `WHATSAPP_BSUID:${bsuid}`,
        ]),
      );
      expect(depois.identificadores).toHaveLength(2);
      expect(await t.prisma.conversa.count()).toBe(1);
      expect(
        await t.prisma.mensagem.count({ where: { direcao: 'ENTRADA' } }),
      ).toBe(2);
    });

    it('cenário 168 — R28.6 — telefone e BSUID desde a primeira mensagem ficam no mesmo contato', async () => {
      await criarOficial();
      await receber(
        mudanca({
          contacts: [
            { profile: { name: 'Maria' }, wa_id: TELEFONE, user_id: bsuid },
          ],
          messages: [
            {
              from: TELEFONE,
              from_user_id: bsuid,
              id: 'wamid.B3',
              timestamp: agoraEmSegundos(),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      );
      const contato = await t.prisma.contato.findFirstOrThrow({
        include: { identificadores: true },
      });
      expect(contato.identificadores).toHaveLength(2);
    });

    it('cenário 169 — R28.6 — envia para o BSUID quando o contato não tem telefone', async () => {
      await criarOficial();
      await receber(
        mudanca({
          contacts: [{ profile: { username: 'maria.s' }, user_id: bsuid }],
          messages: [
            {
              from_user_id: bsuid,
              id: 'wamid.B4',
              timestamp: agoraEmSegundos(),
              type: 'text',
              text: { body: 'oi' },
            },
          ],
        }),
      );
      const conversa = await t.prisma.conversa.findFirstOrThrow();
      await enviarMensagem(conversa.id, { texto: 'Olá!' }).expect(201);
      await drenarEnvios();
      expect(postsDeMensagem().at(-1)?.corpo).toMatchObject({
        recipient: bsuid,
        type: 'text',
      });
      expect(postsDeMensagem().at(-1)?.corpo).not.toHaveProperty('to');
    });
  });

  describe('R28.7 — status das mensagens', () => {
    async function enviada() {
      const { conversa } = await conversaComJanela();
      const resposta = await enviarMensagem(conversa.id, {
        texto: 'Já saiu!',
      }).expect(201);
      await drenarEnvios();
      const mensagem = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: resposta.body.id },
      });
      return { conversa, mensagem };
    }

    it('cenário 170 — R28.7 — enviada → entregue → lida pelos webhooks; um status atrasado não desfaz', async () => {
      const { mensagem } = await enviada();
      expect(mensagem).toMatchObject({
        status: 'ENVIADA',
        idExterno: 'wamid.FALSO1',
      });
      const status = (valor: string) =>
        receber(
          mudanca({
            statuses: [
              {
                id: 'wamid.FALSO1',
                status: valor,
                timestamp: agoraEmSegundos(),
                recipient_id: TELEFONE,
              },
            ],
          }),
        );
      await status('delivered');
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status,
      ).toBe('ENTREGUE');
      await status('read');
      const lida = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: mensagem.id },
      });
      expect(lida).toMatchObject({ status: 'LIDA' });
      expect(lida.lidaEm).not.toBeNull();
      await status('delivered');
      await status('sent');
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status,
      ).toBe('LIDA');
    });

    it('cenário 171 — R28.7 — falhou: o motivo do erro em português vai para a mensagem', async () => {
      const { mensagem } = await enviada();
      await receber(
        mudanca({
          statuses: [
            {
              id: 'wamid.FALSO1',
              status: 'failed',
              timestamp: agoraEmSegundos(),
              errors: [{ code: 131026, title: 'Message undeliverable' }],
            },
          ],
        }),
      );
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({
          where: { id: mensagem.id },
        }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('não tem WhatsApp'),
      });
    });

    it('cenário 172 — R28.7 — status de mensagem ainda não gravada tenta de novo; o antigo é ignorado', async () => {
      const { conversa, canal } = await conversaComJanela();
      await postarWebhook(
        mudanca({
          statuses: [
            {
              id: 'wamid.AINDA_NAO',
              status: 'delivered',
              timestamp: agoraEmSegundos(),
            },
          ],
        }),
      ).expect(200);
      // Recém-chegado e sem mensagem: o job falha e a fila repete (o envio pode estar gravando o id).
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);
      const saida = await t.prisma.mensagem.create({
        data: {
          conversaId: conversa.id,
          canalId: canal.id,
          direcao: 'SAIDA',
          texto: 'x',
          status: 'ENVIADA',
          idExterno: 'wamid.AINDA_NAO',
        },
      });
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL, {
        incluirAgendados: true,
      });
      expect(
        (await t.prisma.mensagem.findUniqueOrThrow({ where: { id: saida.id } }))
          .status,
      ).toBe('ENTREGUE');
      // Antigo (1 h) e desconhecido: ignorado, sem repetir.
      await t.fila.limparTrabalhos();
      await postarWebhook(
        mudanca({
          statuses: [
            {
              id: 'wamid.ANTIGA',
              status: 'delivered',
              timestamp: String(Math.floor(Date.now() / 1000) - 3600),
            },
          ],
        }),
      ).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);
      expect(
        await t.fila.listarTrabalhos(FILA_WEBHOOK_WHATSAPP_OFICIAL),
      ).toHaveLength(0);
    });
  });

  describe('R28.4 — envio e janela de 24 h', () => {
    it('cenário 173 — R28.4 — dentro da janela: texto pela Cloud API com o token, ENVIADA com o wamid', async () => {
      const { conversa } = await conversaComJanela();
      const detalhe = await admin
        .get(`/api/v1/atendimento/conversas/${conversa.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({
        podeResponder: { pode: true, motivo: null, apenasTemplate: false },
        acoes: { responder: true, enviarTemplate: true },
        janelaAte: expect.any(String),
      });
      const resposta = await enviarMensagem(conversa.id, {
        texto: 'Claro, vamos lá!',
      }).expect(201);
      expect(resposta.body).toMatchObject({ status: 'PENDENTE' });
      await drenarEnvios();
      const enviada = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: resposta.body.id },
      });
      expect(enviada).toMatchObject({
        status: 'ENVIADA',
        idExterno: 'wamid.FALSO1',
      });
      expect(postsDeMensagem().at(-1)).toEqual({
        metodo: 'POST',
        caminho: `/v24.0/${NUMERO_ID}/messages`,
        autorizacao: `Bearer ${TOKEN}`,
        tipo: 'application/json',
        bruto: '',
        corpo: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: TELEFONE,
          type: 'text',
          text: { preview_url: true, body: 'Claro, vamos lá!' },
        },
      });
    });

    it('cenário 174 — R28.4 — resposta citada leva o wamid da mensagem citada', async () => {
      const { conversa } = await conversaComJanela();
      const entrada = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId: conversa.id },
      });
      await enviarMensagem(conversa.id, {
        texto: 'Sobre isso…',
        respostaAId: entrada.id,
      }).expect(201);
      await drenarEnvios();
      expect(postsDeMensagem().at(-1)?.corpo).toMatchObject({
        context: { message_id: 'wamid.ENTRADA1' },
      });
    });

    it('cenário 175 — R28.4 — fora da janela: texto livre é 422 com o motivo em português e a indicação de só template', async () => {
      const { conversa } = await conversaComJanela();
      await fecharJanela(conversa.id);
      const detalhe = await admin
        .get(`/api/v1/atendimento/conversas/${conversa.id}`)
        .expect(200);
      expect(detalhe.body.podeResponder).toMatchObject({
        pode: false,
        apenasTemplate: true,
        motivo: expect.stringContaining('24 horas'),
      });
      expect(detalhe.body.acoes).toMatchObject({
        responder: false,
        enviarTemplate: true,
      });
      const recusa = await enviarMensagem(conversa.id, { texto: 'Oi?' }).expect(
        422,
      );
      expect(recusa.body).toMatchObject({
        mensagem: expect.stringContaining('template'),
        detalhes: {
          regra: 'R28',
          motivo: 'canal_nao_aceita_resposta',
          apenasTemplate: true,
        },
      });
      expect(postsDeMensagem()).toHaveLength(0);
      // O adaptador também recusa (a janela pode fechar entre o envio e o job).
      const canal = await t.prisma.canal.findFirstOrThrow({
        where: { tipo: 'WHATSAPP_OFICIAL' },
      });
      expect(
        t.get(RegistroCanais).podeResponder(
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: conversa.id },
          }),
          canal,
        ),
      ).toMatchObject({ pode: false, apenasTemplate: true });
    });

    it('cenário 176 — R28.4 — a janela fecha entre o envio e o job: a mensagem falha com o motivo (sem chamar a Meta)', async () => {
      const { conversa } = await conversaComJanela();
      const resposta = await enviarMensagem(conversa.id, {
        texto: 'Chegou tarde',
      }).expect(201);
      await fecharJanela(conversa.id);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({
          where: { id: resposta.body.id },
        }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('24 horas'),
      });
      expect(postsDeMensagem()).toHaveLength(0);
    });

    it('cenário 177 — R28.4 — a Meta recusa por janela (131047): FALHOU com o motivo; token inválido: FALHOU e o canal fica com erro', async () => {
      const { conversa, canal } = await conversaComJanela();
      graph.estado.erroPara.set(TELEFONE, {
        status: 400,
        erro: { message: 'Re-engagement message', code: 131047 },
      });
      const a = await enviarMensagem(conversa.id, { texto: 'a' }).expect(201);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: a.body.id } }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('24 horas'),
      });
      graph.estado.erroPara.set(TELEFONE, {
        status: 400,
        erro: { message: 'Invalid OAuth access token', code: 190 },
      });
      const b = await enviarMensagem(conversa.id, { texto: 'b' }).expect(201);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: b.body.id } }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('token do canal'),
      });
      const gravado = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      expect(gravado.ultimoErro).toContain('token do canal');
      // Outro erro: tradução do código; "tentar de novo" volta a enviar.
      graph.estado.erroPara.set(TELEFONE, {
        status: 400,
        erro: { message: 'Undeliverable', code: 131026 },
      });
      const c = await enviarMensagem(conversa.id, { texto: 'c' }).expect(201);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: c.body.id } }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('não tem WhatsApp'),
      });
      graph.estado.erroPara.clear();
      await admin
        .post(
          `/api/v1/atendimento/conversas/${conversa.id}/mensagens/${c.body.id}/reenviar`,
        )
        .expect(200);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: c.body.id } }),
      ).toMatchObject({
        status: 'ENVIADA',
      });
    });

    it('cenário 178 — R28.4 — falha passageira da Meta (500) é tentada de novo sem duplicar', async () => {
      const { conversa } = await conversaComJanela();
      const r = await enviarMensagem(conversa.id, {
        texto: 'instavel-uma-vez',
      }).expect(201);
      await drenarEnvios();
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: r.body.id },
          })
        ).status,
      ).toBe('PENDENTE');
      await drenarEnvios(true);
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: r.body.id },
          })
        ).status,
      ).toBe('ENVIADA');
      expect(
        postsDeMensagem().filter(
          (p) =>
            (p.corpo?.text as { body: string } | undefined)?.body ===
            'instavel-uma-vez',
        ),
      ).toHaveLength(2);
    });

    it('cenário 179 — R28.4 — mídia: upload em /media e envio por id, com a legenda; documento leva o nome', async () => {
      const { conversa } = await conversaComJanela();
      const foto = await criarArquivo(t, {
        criadoPor: cenario.admin,
        nome: 'foto.png',
        mime: 'image/png',
      });
      const documento = await criarArquivo(t, {
        criadoPor: cenario.admin,
        nome: 'proposta.pdf',
        mime: 'application/pdf',
      });
      await enviarMensagem(conversa.id, {
        texto: 'Segue a foto',
        arquivoId: foto.id,
      }).expect(201);
      await enviarMensagem(conversa.id, { arquivoId: documento.id }).expect(
        201,
      );
      await drenarEnvios();
      const uploads = graph.pedidos.filter(
        (p) => p.caminho === `/v24.0/${NUMERO_ID}/media`,
      );
      expect(uploads).toHaveLength(2);
      expect(uploads[0].tipo).toMatch(/^multipart\/form-data/);
      expect(uploads[0].autorizacao).toBe(`Bearer ${TOKEN}`);
      expect(uploads[0].bruto).toContain('messaging_product');
      expect(uploads[0].bruto).toContain('image/png');
      const envios = postsDeMensagem();
      expect(envios[0].corpo).toMatchObject({
        type: 'image',
        image: {
          id: expect.stringMatching(/^MEDIA_ENVIADA_/),
          caption: 'Segue a foto',
        },
      });
      expect(envios[1].corpo).toMatchObject({
        type: 'document',
        document: {
          id: expect.stringMatching(/^MEDIA_ENVIADA_/),
          filename: 'proposta.pdf',
        },
      });
    });

    it('cenário 180 — R28.4 — áudio gravado no navegador (webm/opus) é convertido para ogg/opus e vai como áudio', async () => {
      const { conversa } = await conversaComJanela();
      const convertidos: Buffer[] = [];
      const adaptador = t.get(AdaptadorWhatsappOficial);
      const original = adaptador.conversor;
      adaptador.conversor = {
        paraVoz: (conteudo: Buffer) => {
          convertidos.push(conteudo);
          return Promise.resolve(Buffer.from('OggS-de-teste'));
        },
      } as unknown as typeof adaptador.conversor;
      try {
        const audio = await criarArquivo(t, {
          criadoPor: cenario.admin,
          nome: 'voz.webm',
          mime: 'audio/webm',
          conteudo: 'webm-de-teste',
        });
        await enviarMensagem(conversa.id, { arquivoId: audio.id }).expect(201);
        await drenarEnvios();
      } finally {
        adaptador.conversor = original;
      }
      expect(convertidos).toHaveLength(1);
      const upload = graph.pedidos.find(
        (p) => p.caminho === `/v24.0/${NUMERO_ID}/media`,
      );
      expect(upload?.bruto).toContain('audio/ogg');
      expect(upload?.bruto).toContain('voz.ogg');
      expect(postsDeMensagem().at(-1)?.corpo).toMatchObject({
        type: 'audio',
        audio: { id: expect.any(String) },
      });
    });

    it('cenário 181 — R28.4 — áudio que não dá para converter (sem ffmpeg e não é ogg) falha com motivo em português', async () => {
      const { conversa } = await conversaComJanela();
      const adaptador = t.get(AdaptadorWhatsappOficial);
      const original = adaptador.conversor;
      adaptador.conversor = {
        paraVoz: () => Promise.reject(new Error('sem ffmpeg')),
      } as unknown as typeof adaptador.conversor;
      try {
        const audio = await criarArquivo(t, {
          criadoPor: cenario.admin,
          nome: 'voz.webm',
          mime: 'audio/webm',
        });
        const r = await enviarMensagem(conversa.id, {
          arquivoId: audio.id,
        }).expect(201);
        await drenarEnvios();
        expect(
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: r.body.id },
          }),
        ).toMatchObject({
          status: 'FALHOU',
          erro: 'Não foi possível converter o áudio para mensagem de voz.',
        });
      } finally {
        adaptador.conversor = original;
      }
    });
  });

  describe('R28.8 — templates', () => {
    it('cenário 182 — R28.8 — sincronização manual: troca o cache, segue a paginação e mostra o que não está aprovado', async () => {
      const canal = await criarOficial();
      const resultado = await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      expect(resultado.body).toMatchObject({ total: 3, aprovados: 2 });
      expect(
        resultado.body.itens.map((i: { nome: string }) => i.nome).sort(),
      ).toEqual(['novo_modelo', 'pedido_enviado', 'promocao']);
      expect(
        graph.pedidos
          .filter((p) => p.caminho.includes('/message_templates'))
          .map((p) => p.caminho)[0],
      ).toContain(
        `/v24.0/${WABA_ID}/message_templates?fields=id,name,language,category,status,components&limit=200`,
      );
      expect(
        graph.pedidos.filter((p) => p.caminho.includes('after=CURSOR2')),
      ).toHaveLength(1);
      const pedido = resultado.body.itens.find(
        (i: { nome: string }) => i.nome === 'pedido_enviado',
      );
      expect(pedido).toMatchObject({
        categoria: 'UTILITY',
        status: 'APPROVED',
        usavel: true,
        corpo: {
          texto: 'Olá {{1}}, seu pedido {{2}} saiu para entrega.',
          variaveis: ['1', '2'],
        },
        rodape: 'Equipe BRL',
        botoes: [{ tipo: 'URL', texto: 'Rastrear', variaveis: ['1'] }],
      });
      const pendente = resultado.body.itens.find(
        (i: { nome: string }) => i.nome === 'novo_modelo',
      );
      expect(pendente).toMatchObject({
        usavel: false,
        motivoIndisponivel: expect.stringContaining('PENDING'),
      });

      // O que sumiu da Meta sai do cache; o canal mostra o resumo.
      graph.estado.templates = [TEMPLATE_PEDIDO];
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      const lista = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}/templates`)
        .expect(200);
      expect(lista.body).toHaveLength(1);
      const detalhe = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}`)
        .expect(200);
      expect(detalhe.body.templates).toMatchObject({
        total: 1,
        aprovados: 1,
        sincronizadoEm: expect.any(String),
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'canal.templates_sincronizados' },
        }),
      ).toBe(2);
    });

    it('cenário 183 — R28.8 — falha da Meta na sincronização: 503 com o motivo, o cache fica e o canal registra o erro', async () => {
      const canal = await criarOficial();
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      graph.estado.templatesComErro = true;
      const falha = await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(503);
      expect(falha.body.mensagem).toContain(
        'Não foi possível ler os templates',
      );
      expect(await t.prisma.whatsappOficialTemplate.count()).toBe(3);
      expect(
        (await t.prisma.canal.findUniqueOrThrow({ where: { id: canal.id } }))
          .ultimoErro,
      ).toContain('templates');
    });

    it('cenário 184 — R28.8 — sincronização diária pela fila: todos os canais ativos, um erro não para os outros', async () => {
      const a = await criarOficial();
      const b = await criarOficial({
        nome: 'Quebrado',
        phoneNumberId: '100000000000009',
        wabaId: '200000000000009',
        token: 'token-vencido',
      });
      await criarCanal(t, {
        tipo: 'WHATSAPP_OFICIAL',
        nome: 'Desligado',
        ativo: false,
        idExterno: '5',
      });
      await t.fila.enviar(FILA_TEMPLATES_OFICIAIS, {});
      await drenarFilas(t, FILA_TEMPLATES_OFICIAIS);
      expect(
        await t.prisma.whatsappOficialTemplate.count({
          where: { canalId: a.id },
        }),
      ).toBe(3);
      expect(
        await t.prisma.whatsappOficialTemplate.count({
          where: { canalId: b.id },
        }),
      ).toBe(0);
      expect(t.get(TemplatesOficiaisService)).toBeDefined();
    });

    it('cenário 185 — R28.4 — o compositor lista os templates aprovados da conversa e o aviso da janela fechada', async () => {
      const { canal, conversa } = await conversaComJanela();
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      const aberta = await admin
        .get(`/api/v1/atendimento/conversas/${conversa.id}/templates`)
        .expect(200);
      expect(aberta.body).toMatchObject({
        suportado: true,
        janelaAberta: true,
        aviso: null,
      });
      expect(
        aberta.body.itens.map((i: { nome: string }) => i.nome).sort(),
      ).toEqual(['pedido_enviado', 'promocao']);
      await fecharJanela(conversa.id);
      const fechada = await admin
        .get(`/api/v1/atendimento/conversas/${conversa.id}/templates`)
        .expect(200);
      expect(fechada.body).toMatchObject({
        janelaAberta: false,
        aviso: expect.stringContaining('24 horas'),
      });
      // Canal sem templates.
      const web = await t.prisma.conversa.create({
        data: {
          canalId: cenario.canal.id,
          contatoId: (await criarContato(t)).id,
          filaId: cenario.fila.id,
        },
      });
      await admin
        .get(`/api/v1/atendimento/conversas/${web.id}/templates`)
        .expect(200, {
          suportado: false,
          janelaAberta: true,
          janelaAte: null,
          aviso: null,
          sincronizadoEm: null,
          itens: [],
        });
    });

    async function comTemplates() {
      const { canal, conversa } = await conversaComJanela();
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      const ids = Object.fromEntries(
        (await t.prisma.whatsappOficialTemplate.findMany()).map((x) => [
          x.nome,
          x.id,
        ]),
      );
      return { canal, conversa, ids };
    }

    it('cenário 186 — R28.4 — template com variáveis fora da janela: grava o texto preenchido e envia os components', async () => {
      const { conversa, ids } = await comTemplates();
      await fecharJanela(conversa.id);
      const r = await enviarMensagem(conversa.id, {
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['Maria', '#1522'], botoes: ['abc123'] },
        },
      }).expect(201);
      expect(r.body).toMatchObject({
        tipo: 'TEXTO',
        texto: 'Olá Maria, seu pedido #1522 saiu para entrega.\n\nEquipe BRL',
        metadados: {
          template: {
            nome: 'pedido_enviado',
            idioma: 'pt_BR',
            categoria: 'UTILITY',
          },
        },
      });
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: r.body.id } }),
      ).toMatchObject({
        status: 'ENVIADA',
        idExterno: 'wamid.FALSO1',
      });
      expect(postsDeMensagem().at(-1)?.corpo).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TELEFONE,
        type: 'template',
        template: {
          name: 'pedido_enviado',
          language: { code: 'pt_BR' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Maria' },
                { type: 'text', text: '#1522' },
              ],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: 'abc123' }],
            },
          ],
        },
      });
    });

    it('cenário 187 — R28.4 — variável faltando, template pendente, texto junto e canal sem templates são recusados', async () => {
      const { conversa, ids } = await comTemplates();
      const faltando = await enviarMensagem(conversa.id, {
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['Maria'] },
        },
      }).expect(400);
      expect(faltando.body.mensagem).toContain('corpo {{2}}');
      await enviarMensagem(conversa.id, {
        template: { templateId: ids.novo_modelo },
      })
        .expect(400)
        .expect(({ body }) =>
          expect(body.mensagem).toContain('não está aprovado'),
        );
      await enviarMensagem(conversa.id, {
        texto: 'oi',
        template: { templateId: ids.novo_modelo },
      }).expect(400);
      await enviarMensagem(conversa.id, {
        template: { templateId: '00000000-0000-4000-8000-000000000000' },
      }).expect(404);
      const web = await t.prisma.conversa.create({
        data: {
          canalId: cenario.canal.id,
          contatoId: (await criarContato(t)).id,
          filaId: cenario.fila.id,
          responsavelId: cenario.admin.id,
        },
      });
      await enviarMensagem(web.id, {
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['a', 'b'], botoes: ['c'] },
        },
      })
        .expect(422)
        .expect(({ body }) =>
          expect(body.detalhes.motivo).toBe('canal_sem_templates'),
        );
      expect(postsDeMensagem()).toHaveLength(0);
    });

    it('cenário 188 — R28.4 — template com mídia no cabeçalho exige o arquivo e o envia como cabeçalho', async () => {
      const { conversa, ids } = await comTemplates();
      await enviarMensagem(conversa.id, {
        template: { templateId: ids.promocao },
      })
        .expect(400)
        .expect(({ body }) =>
          expect(body.mensagem).toContain('mídia no cabeçalho'),
        );
      const foto = await criarArquivo(t, {
        criadoPor: cenario.admin,
        nome: 'promo.png',
        mime: 'image/png',
      });
      const r = await enviarMensagem(conversa.id, {
        template: { templateId: ids.promocao },
        arquivoId: foto.id,
      }).expect(201);
      expect(r.body).toMatchObject({
        tipo: 'IMAGEM',
        texto: 'Promoção de novembro!',
      });
      await drenarEnvios();
      expect(postsDeMensagem().at(-1)?.corpo).toMatchObject({
        type: 'template',
        template: {
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'image',
                  image: { id: expect.stringMatching(/^MEDIA_ENVIADA_/) },
                },
              ],
            },
          ],
        },
      });
    });

    it('cenário 189 — R28.4 — começar a conversa pela equipe exige template (não há janela); com template envia', async () => {
      const canal = await criarOficial();
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      const ids = Object.fromEntries(
        (await t.prisma.whatsappOficialTemplate.findMany()).map((x) => [
          x.nome,
          x.id,
        ]),
      );
      const contato = await criarContato(t, {
        nome: 'Carlos',
        telefone: '5511977770000',
      });
      const semTemplate = await admin
        .post('/api/v1/atendimento/conversas', {
          canalId: canal.id,
          contatoId: contato.id,
          texto: 'Oi!',
        })
        .expect(422);
      expect(semTemplate.body.detalhes).toMatchObject({
        regra: 'R28',
        apenasTemplate: true,
      });
      expect(await t.prisma.conversa.count()).toBe(0);
      const semTelefone = await criarContato(t, { nome: 'Sem telefone' });
      await admin
        .post('/api/v1/atendimento/conversas', {
          canalId: canal.id,
          contatoId: semTelefone.id,
          template: { templateId: ids.novo_modelo },
        })
        .expect(422);
      const iniciada = await admin
        .post('/api/v1/atendimento/conversas', {
          canalId: canal.id,
          contatoId: contato.id,
          template: {
            templateId: ids.pedido_enviado,
            variaveis: { corpo: ['Carlos', '#9'], botoes: ['x'] },
          },
        })
        .expect(201);
      expect(iniciada.body).toMatchObject({
        podeResponder: { pode: false, apenasTemplate: true },
      });
      await drenarEnvios();
      expect(postsDeMensagem().at(-1)?.corpo).toMatchObject({
        to: '5511977770000',
        type: 'template',
      });
    });

    it('cenário 190 — R28.4 — "tentar de novo" de um template funciona fora da janela', async () => {
      const { conversa, ids } = await comTemplates();
      await fecharJanela(conversa.id);
      graph.estado.erroPara.set(TELEFONE, {
        status: 400,
        erro: { message: 'Template paused', code: 132015 },
      });
      const r = await enviarMensagem(conversa.id, {
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['M', '1'], botoes: ['a'] },
        },
      }).expect(201);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: r.body.id } }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('pausado'),
      });
      graph.estado.erroPara.clear();
      await admin
        .post(
          `/api/v1/atendimento/conversas/${conversa.id}/mensagens/${r.body.id}/reenviar`,
        )
        .expect(200);
      await drenarEnvios();
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: r.body.id },
          })
        ).status,
      ).toBe('ENVIADA');
    });
  });

  describe('R28.9 — "não contatar por WhatsApp" e opt-out', () => {
    async function comTemplateParaFalar(
      etiquetas: string[],
      opcoes: { optOutMarketing?: boolean } = {},
    ) {
      const canal = await criarOficial();
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canal.id}/templates/sincronizar`,
        )
        .expect(200);
      const ids = Object.fromEntries(
        (await t.prisma.whatsappOficialTemplate.findMany()).map((x) => [
          x.nome,
          x.id,
        ]),
      );
      const contato = await criarContato(t, {
        nome: 'Pedro',
        telefone: TELEFONE,
        etiquetas,
      });
      if (opcoes.optOutMarketing) {
        await t.prisma.contato.update({
          where: { id: contato.id },
          data: { optOutMarketing: true, optOutEm: new Date() },
        });
      }
      return { canal, contato, ids };
    }

    it('cenário 191 — R28.9 — a marca bloqueia a mensagem ativa (template fora da janela), mas não a resposta dentro dela', async () => {
      const { canal, contato, ids } = await comTemplateParaFalar([
        'nao-contatar-whatsapp',
      ]);
      const corpo = {
        canalId: canal.id,
        contatoId: contato.id,
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['P', '1'], botoes: ['a'] },
        },
      };
      const iniciada = await admin
        .post('/api/v1/atendimento/conversas', corpo)
        .expect(201);
      await drenarEnvios();
      const mensagem = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId: iniciada.body.id, direcao: 'SAIDA' },
      });
      expect(mensagem).toMatchObject({
        status: 'FALHOU',
        erro: 'O contato pediu para não ser contatado por WhatsApp.',
      });
      expect(postsDeMensagem()).toHaveLength(0);
      // O contato escreve: a janela abre e dá para responder.
      await receber(textoDoContato('wamid.PEDRO', 'Pode falar'));
      await enviarMensagem(iniciada.body.id, { texto: 'Olá, Pedro' }).expect(
        201,
      );
      await drenarEnvios();
      expect(postsDeMensagem()).toHaveLength(1);
    });

    it('cenário 192 — R28.9 — template de marketing respeita o opt-out de marketing do contato', async () => {
      const { canal, contato, ids } = await comTemplateParaFalar([], {
        optOutMarketing: true,
      });
      const foto = await criarArquivo(t, {
        criadoPor: cenario.admin,
        mime: 'image/png',
        nome: 'p.png',
      });
      const iniciada = await admin
        .post('/api/v1/atendimento/conversas', {
          canalId: canal.id,
          contatoId: contato.id,
          template: { templateId: ids.promocao },
          arquivoId: foto.id,
        })
        .expect(201);
      await drenarEnvios();
      expect(
        await t.prisma.mensagem.findFirstOrThrow({
          where: { conversaId: iniciada.body.id, direcao: 'SAIDA' },
        }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: expect.stringContaining('marketing'),
      });
      // Utilidade passa.
      await enviarMensagem(iniciada.body.id, {
        template: {
          templateId: ids.pedido_enviado,
          variaveis: { corpo: ['P', '1'], botoes: ['a'] },
        },
      }).expect(201);
      await drenarEnvios();
      expect(postsDeMensagem()).toHaveLength(1);
    });

    it('cenário 193 — R28.9 — a mesma pessoa pode falar pelos dois canais (identificador WHATSAPP compartilhado)', async () => {
      await criarOficial();
      const contato = await criarContato(t, { telefone: TELEFONE });
      await criarIdentificador(t, {
        contato,
        tipo: 'WHATSAPP',
        valor: TELEFONE,
      });
      await receber(textoDoContato('wamid.DOIS', 'oi pelo oficial'));
      expect(await t.prisma.contato.count()).toBe(1);
      expect((await t.prisma.conversa.findFirstOrThrow()).contatoId).toBe(
        contato.id,
      );
    });

    it('cenário 194 — R28.9 — o wa_id sem o nono dígito casa com o contato cadastrado com ele (e vice-versa)', async () => {
      await criarOficial();
      const contato = await criarContato(t, { telefone: '5511988887777' });
      await criarIdentificador(t, {
        contato,
        tipo: 'WHATSAPP',
        valor: '5511988887777',
      });
      await receber(
        textoDoContato('wamid.NONO1', 'oi sem o nono dígito', {
          from: '551188887777',
        }),
      );
      expect(await t.prisma.contato.count()).toBe(1);
      expect((await t.prisma.conversa.findFirstOrThrow()).contatoId).toBe(
        contato.id,
      );
      // o inverso: cadastrado sem o nono, a Meta manda com ele
      const outro = await criarContato(t, { telefone: '551177776666' });
      await criarIdentificador(t, {
        contato: outro,
        tipo: 'WHATSAPP',
        valor: '551177776666',
      });
      await receber(
        textoDoContato('wamid.NONO2', 'oi com o nono dígito', {
          from: '5511977776666',
        }),
      );
      expect(await t.prisma.contato.count()).toBe(2);
    });
  });
});
