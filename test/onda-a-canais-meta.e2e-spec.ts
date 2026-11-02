import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  AdaptadorMessenger,
  MOTIVO_JANELA_FECHADA,
} from '../src/canais/meta/adaptadores-meta';
import {
  FILA_WEBHOOK_META,
  type TrabalhoDoWebhookMeta,
  WebhookMetaService,
} from '../src/canais/meta/webhook-meta.service';
import { AtendimentoService } from '../src/atendimento/atendimento.service';
import type { Trabalho } from '../src/fila/fila.service';
import { RegistroCanais } from '../src/canais/registro-canais';
import { LimitadorDeRequisicoes } from '../src/canais/comum/limitador';
import {
  type AppTeste,
  criarAppTeste,
  criarArquivo,
  criarUsuario,
  drenarFilas,
  entrarComo,
  PNG_DE_TESTE,
} from './utils';

const APP_SECRET = 'segredo-do-app-de-teste';
const TOKEN_PAGINA = 'EAAG-token-da-pagina-de-teste';
const PAGINA = '109876543210987';
const PSID = '24680135792468013';

interface PedidoRecebido {
  metodo: string;
  caminho: string;
  autorizacao: string | undefined;
  corpo: Record<string, unknown> | null;
}

/** Graph API falsa (como a do ambiente dos agentes), numa porta livre. */
async function subirGraphFalsa(): Promise<{
  url: string;
  pedidos: PedidoRecebido[];
  fechar: () => Promise<void>;
}> {
  const pedidos: PedidoRecebido[] = [];
  let sequencia = 0;
  /** Textos que já falharam uma vez (a próxima tentativa passa). */
  const instaveis = new Set<string>();
  const servidor: Server = createServer((req: IncomingMessage, res) => {
    const partes: Buffer[] = [];
    req.on('data', (parte: Buffer) => partes.push(parte));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://graph');
      const bruto = Buffer.concat(partes).toString('utf8');
      const corpo = bruto
        ? (JSON.parse(bruto) as Record<string, unknown>)
        : null;
      pedidos.push({
        metodo: req.method ?? '',
        caminho: `${url.pathname}${url.search}`,
        autorizacao: req.headers.authorization,
        corpo,
      });
      const responder = (
        status: number,
        dados: unknown,
        tipo = 'application/json',
      ) => {
        res.writeHead(status, { 'content-type': tipo });
        res.end(Buffer.isBuffer(dados) ? dados : JSON.stringify(dados));
      };
      if (url.pathname === '/cdn/foto.png') {
        responder(200, PNG_DE_TESTE, 'image/png');
        return;
      }
      if (url.pathname === '/cdn/redireciona') {
        res.writeHead(302, { location: '/cdn/foto.png' });
        res.end();
        return;
      }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || token === 'token-vencido') {
        responder(400, {
          error: {
            message: 'Invalid OAuth access token',
            type: 'OAuthException',
            code: 190,
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v24.0/me/messages') {
        const destinatario = String(
          (corpo?.recipient as { id?: string } | undefined)?.id ?? '',
        );
        if (destinatario.startsWith('fora-da-janela')) {
          responder(400, {
            error: {
              message: '(#10) This message is sent outside of allowed window.',
              code: 10,
              error_subcode: 2018278,
            },
          });
          return;
        }
        const texto = (corpo?.message as { text?: string } | undefined)?.text;
        if (texto?.startsWith('instavel-uma-vez') && !instaveis.has(texto)) {
          instaveis.add(texto);
          responder(500, {
            error: { message: 'An unexpected error has occurred.', code: 2 },
          });
          return;
        }
        if (destinatario === 'meta-instavel') {
          responder(500, {
            error: { message: 'An unexpected error has occurred.', code: 2 },
          });
          return;
        }
        sequencia++;
        responder(200, {
          recipient_id: destinatario,
          message_id: `m_falso_${sequencia}`,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v24.0/')) {
        const id = url.pathname.split('/')[2];
        responder(
          200,
          id === PAGINA
            ? { id, name: 'Loja Teste' }
            : { id, first_name: 'Joana', last_name: 'Prado' },
        );
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
    fechar: () => new Promise((resolver) => servidor.close(() => resolver())),
  };
}

/**
 * Instagram e Messenger (§2.5, R14): configuração com credenciais cifradas,
 * webhook (verificação e assinatura), entrada pelo Atendimento (perfil,
 * anexo, janela de 24 h), envio pela Graph API configurável (aqui, a falsa) e
 * os status de entrega e leitura.
 */
describe('Canais — Instagram e Messenger (e2e)', () => {
  let t: AppTeste;
  let graph: Awaited<ReturnType<typeof subirGraphFalsa>>;

  beforeAll(async () => {
    graph = await subirGraphFalsa();
    t = await criarAppTeste({ variaveis: { META_GRAPH_URL: graph.url } });
  });
  beforeEach(async () => {
    await t.limparBanco();
    graph.pedidos.length = 0;
    t.get(LimitadorDeRequisicoes).zerar();
  });
  afterAll(async () => {
    await t?.fechar();
    await graph?.fechar();
  });

  async function criarMessenger(corpo: object = {}) {
    const admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    const resposta = await admin
      .post('/api/v1/meta/canais', {
        tipo: 'MESSENGER',
        nome: 'Página da loja',
        appId: '1234567890123456',
        appSecret: APP_SECRET,
        pageId: PAGINA,
        tokenPagina: TOKEN_PAGINA,
        ...corpo,
      })
      .expect(201);
    return {
      admin,
      canal: resposta.body as {
        id: string;
        webhook: { url: string; tokenVerificacao: string; campos: string[] };
        [campo: string]: unknown;
      },
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

  const mensagemDoContato = (
    mensagem: object,
    remetente = PSID,
    timestamp = Date.now(),
  ) => ({
    object: 'page',
    entry: [
      {
        id: PAGINA,
        time: timestamp,
        messaging: [
          {
            sender: { id: remetente },
            recipient: { id: PAGINA },
            timestamp,
            message: mensagem,
          },
        ],
      },
    ],
  });

  describe('configuração (Admin)', () => {
    it('cria com segredos cifrados (mascarados) e os dados do webhook; testa o token', async () => {
      const { admin, canal } = await criarMessenger();
      expect(canal).toMatchObject({
        tipo: 'MESSENGER',
        idExterno: PAGINA,
        pageId: PAGINA,
        instagramId: null,
        appSecret: expect.stringMatching(/^••••••••/),
        tokenPagina: expect.stringMatching(/^••••••••/),
        webhook: {
          url: 'http://localhost:4200/api/v1/publico/meta/webhook',
          tokenVerificacao: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
          campos: expect.arrayContaining(['messages', 'message_reads']),
        },
      });
      expect(JSON.stringify(canal)).not.toContain(APP_SECRET);
      const gravado = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      expect(gravado.segredosCifrados).not.toContain(TOKEN_PAGINA);
      expect(JSON.stringify(gravado.configuracao)).not.toContain(APP_SECRET);

      const teste = await admin
        .post(`/api/v1/meta/canais/${canal.id}/testar`)
        .expect(200);
      expect(teste.body).toEqual({
        ok: true,
        mensagem: 'Conectado à página "Loja Teste".',
        nome: 'Loja Teste',
      });
      expect(graph.pedidos.at(-1)).toMatchObject({
        metodo: 'GET',
        caminho: `/v24.0/${PAGINA}?fields=id,name`,
        autorizacao: `Bearer ${TOKEN_PAGINA}`,
      });

      const novo = await admin
        .post(`/api/v1/meta/canais/${canal.id}/token-verificacao`)
        .expect(200);
      expect(novo.body.tokenVerificacao).not.toBe(
        canal.webhook.tokenVerificacao,
      );
      await admin
        .patch(`/api/v1/meta/canais/${canal.id}`, {
          tokenPagina: 'token-vencido',
        })
        .expect(200);
      const falhou = await admin
        .post(`/api/v1/meta/canais/${canal.id}/testar`)
        .expect(200);
      expect(falhou.body).toMatchObject({
        ok: false,
        mensagem: 'O token da página é inválido ou expirou.',
      });
    });

    it('Instagram exige o id da conta; a página repetida é 409', async () => {
      const { admin } = await criarMessenger();
      const semConta = await admin
        .post('/api/v1/meta/canais', {
          tipo: 'INSTAGRAM',
          nome: 'Insta',
          appId: '1234567890123456',
          appSecret: APP_SECRET,
          pageId: PAGINA,
          tokenPagina: TOKEN_PAGINA,
        })
        .expect(400);
      expect(semConta.body.detalhes.campos[0].campo).toBe('instagramId');
      await admin
        .post('/api/v1/meta/canais', {
          tipo: 'INSTAGRAM',
          nome: 'Insta',
          appId: '1234567890123456',
          appSecret: APP_SECRET,
          pageId: PAGINA,
          tokenPagina: TOKEN_PAGINA,
          instagramId: '17841400000000000',
        })
        .expect(201)
        .expect(({ body }) =>
          expect(body).toMatchObject({ idExterno: '17841400000000000' }),
        );
      await admin
        .post('/api/v1/meta/canais', {
          tipo: 'MESSENGER',
          nome: 'Repetida',
          appId: '1234567890123456',
          appSecret: APP_SECRET,
          pageId: PAGINA,
          tokenPagina: TOKEN_PAGINA,
        })
        .expect(409);
    });
  });

  describe('webhook', () => {
    it('verificação: devolve o hub.challenge com o token do canal; 403 com outro', async () => {
      const { canal } = await criarMessenger();
      const certo = await request(t.servidor)
        .get('/api/v1/publico/meta/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': canal.webhook.tokenVerificacao,
          'hub.challenge': '1158201444',
        })
        .expect(200);
      expect(certo.text).toBe('1158201444');
      expect(certo.headers['content-type']).toMatch(/text\/plain/);
      await request(t.servidor)
        .get('/api/v1/publico/meta/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'outro',
          'hub.challenge': '1',
        })
        .expect(403);
    });

    it('cenário 30 — assinatura: sem ou errada é 401 (e nada entra); canal desconhecido é ignorado', async () => {
      await criarMessenger();
      const corpo = mensagemDoContato({ mid: 'm_1', text: 'Oi' });
      await postarWebhook(corpo, null).expect(401);
      await postarWebhook(corpo, 'outro-segredo').expect(401);
      expect(await drenarFilas(t, FILA_WEBHOOK_META)).toBe(0);
      const desconhecido = await postarWebhook({
        ...corpo,
        entry: [{ ...corpo.entry[0], id: '999999' }],
      });
      expect(desconhecido.status).toBe(200);
      expect(desconhecido.body).toEqual({ recebidas: 0 });
    });

    it('R14 — mensagem: contato pelo PSID com o nome do perfil, janela de 24 h, anexo baixado; eco ignorado; idempotente', async () => {
      const { canal } = await criarMessenger();
      const quando = Date.now();
      const corpo = {
        object: 'page',
        entry: [
          {
            id: PAGINA,
            time: quando,
            messaging: [
              {
                sender: { id: PSID },
                recipient: { id: PAGINA },
                timestamp: quando,
                message: {
                  mid: 'm_contato_1',
                  text: 'Oi! Vocês entregam em Campinas?',
                  attachments: [
                    {
                      type: 'image',
                      payload: { url: `${graph.url}/cdn/foto.png` },
                    },
                  ],
                },
              },
              {
                sender: { id: PAGINA },
                recipient: { id: PSID },
                timestamp: quando,
                message: {
                  mid: 'm_eco',
                  text: 'resposta pelo Business Suite',
                  is_echo: true,
                },
              },
            ],
          },
        ],
      };
      await postarWebhook(corpo).expect(200, { recebidas: 1 });
      expect(await drenarFilas(t, FILA_WEBHOOK_META)).toBe(1);
      // Repetido pela Meta: não duplica.
      await postarWebhook(corpo).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_META);

      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { canalId: canal.id },
        include: {
          contato: { include: { identificadores: true } },
          mensagens: {
            orderBy: { ocorridaEm: 'asc' },
            include: { arquivo: true },
          },
        },
      });
      expect(conversa).toMatchObject({
        idExterno: PSID,
        contato: {
          nome: 'Joana Prado',
          primeiraOrigem: 'MESSENGER',
          email: null,
          telefone: null,
        },
      });
      expect(conversa.contato.identificadores).toEqual([
        expect.objectContaining({
          tipo: 'MESSENGER',
          valor: PSID,
          canalId: canal.id,
        }),
      ]);
      // Janela: a última mensagem do contato (o anexo vem 1 ms depois) + 24 h.
      expect(conversa.janelaAte?.getTime()).toBeGreaterThanOrEqual(
        quando + 24 * 3600 * 1000,
      );
      expect(conversa.janelaAte?.getTime()).toBeLessThan(
        quando + 24 * 3600 * 1000 + 10,
      );
      expect(
        conversa.mensagens.map((m) => [m.tipo, m.idExterno, m.texto]),
      ).toEqual([
        ['TEXTO', 'm_contato_1', 'Oi! Vocês entregam em Campinas?'],
        ['IMAGEM', 'm_contato_1#anexo-1', null],
      ]);
      expect(conversa.mensagens[1].arquivo).toMatchObject({
        mime: 'image/png',
        contexto: 'MENSAGEM',
      });
      expect(
        await t.prisma.mensagem.count({ where: { idExterno: 'm_eco' } }),
      ).toBe(0);
      // O perfil foi lido uma vez só.
      expect(
        graph.pedidos.filter((p) => p.caminho.startsWith(`/v24.0/${PSID}`)),
      ).toHaveLength(1);
    });
  });

  describe('anexos recebidos', () => {
    it('sem texto: o primeiro anexo leva o mid; job refeito depois de falhar no meio não baixa nem duplica; só HTTPS', async () => {
      const { canal } = await criarMessenger();
      const quando = Date.now();
      const entrada = mensagemDoContato(
        {
          mid: 'm_fotos',
          attachments: [
            { type: 'image', payload: { url: `${graph.url}/cdn/redireciona` } },
            { type: 'image', payload: { url: `${graph.url}/cdn/foto.png` } },
            {
              type: 'file',
              payload: { url: 'http://169.254.169.254/latest/meta-data' },
            },
          ],
        },
        PSID,
        quando,
      ).entry[0];
      const trabalho = {
        dados: { canalId: canal.id, entrada },
      } as unknown as Trabalho<TrabalhoDoWebhookMeta>;
      const webhook = t.get(WebhookMetaService);
      const atendimento = t.get(AtendimentoService);
      const original = atendimento.receber.bind(atendimento);
      // A mensagem principal (a última gravada) falha na primeira tentativa.
      const espiao = jest
        .spyOn(atendimento, 'receber')
        .mockImplementation((dados) =>
          dados.mensagem.idExterno === 'm_fotos'
            ? Promise.reject(new Error('banco fora do ar'))
            : original(dados),
        );
      await expect(webhook.processar(trabalho)).rejects.toThrow(
        'banco fora do ar',
      );
      espiao.mockRestore();
      // O arquivo da principal não ficou solto; o do segundo anexo, já entregue, ficou.
      expect(await t.prisma.arquivo.count()).toBe(1);
      const downloads = () =>
        graph.pedidos.filter((p) => p.caminho.startsWith('/cdn/')).length;
      const antes = downloads();

      await webhook.processar(trabalho);
      expect(downloads() - antes).toBe(2); // só o primeiro (redireciona + foto)
      await webhook.processar(trabalho);
      expect(downloads() - antes).toBe(2);

      const mensagens = await t.prisma.mensagem.findMany({
        orderBy: { ocorridaEm: 'asc' },
        include: { arquivo: true },
      });
      expect(
        mensagens.map((m) => [m.tipo, m.idExterno, m.texto, m.arquivo?.mime]),
      ).toEqual([
        [
          'IMAGEM',
          'm_fotos',
          '[Anexo: http://169.254.169.254/latest/meta-data]',
          'image/png',
        ],
        ['IMAGEM', 'm_fotos#anexo-2', null, 'image/png'],
      ]);
      expect(await t.prisma.arquivo.count()).toBe(2);
    });
  });

  describe('envio pela Graph API', () => {
    async function conversaComContato() {
      const { canal, admin } = await criarMessenger();
      await postarWebhook(
        mensagemDoContato({ mid: 'm_entrada', text: 'Olá' }),
      ).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_META);
      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { canalId: canal.id },
      });
      const gravado = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      return { canal: gravado, conversa, admin };
    }

    const saida = (conversaId: string, canalId: string, dados: object = {}) =>
      t.prisma.mensagem.create({
        data: {
          conversaId,
          canalId,
          direcao: 'SAIDA',
          texto: 'Entregamos, sim!',
          status: 'PENDENTE',
          ...dados,
        },
      });

    it('dentro da janela: envia com o token no cabeçalho; entrega e leitura atualizam o status', async () => {
      const { canal, conversa } = await conversaComContato();
      const mensagem = await saida(conversa.id, canal.id);
      expect(t.get(RegistroCanais).podeResponder(conversa, canal)).toEqual({
        pode: true,
      });
      const resultado = await t
        .get(AdaptadorMessenger)
        .enviar(mensagem, conversa, canal);
      expect(resultado).toEqual({
        idExterno: expect.stringMatching(/^m_falso_\d+$/),
        enviadaEm: expect.any(Date),
      });
      expect(graph.pedidos.at(-1)).toEqual({
        metodo: 'POST',
        caminho: '/v24.0/me/messages',
        autorizacao: `Bearer ${TOKEN_PAGINA}`,
        corpo: {
          recipient: { id: PSID },
          messaging_type: 'RESPONSE',
          message: { text: 'Entregamos, sim!' },
        },
      });
      await t.prisma.mensagem.update({
        where: { id: mensagem.id },
        data: {
          idExterno: resultado.idExterno,
          status: 'ENVIADA',
          enviadaEm: new Date(Date.now() - 1000),
        },
      });

      const agora = Date.now();
      await postarWebhook({
        object: 'page',
        entry: [
          {
            id: PAGINA,
            time: agora,
            messaging: [
              {
                sender: { id: PSID },
                recipient: { id: PAGINA },
                timestamp: agora,
                delivery: { mids: [resultado.idExterno], watermark: agora },
              },
            ],
          },
        ],
      }).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_META);
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status,
      ).toBe('ENTREGUE');
      await postarWebhook({
        object: 'page',
        entry: [
          {
            id: PAGINA,
            time: agora,
            messaging: [
              {
                sender: { id: PSID },
                recipient: { id: PAGINA },
                timestamp: agora,
                read: { watermark: agora },
              },
            ],
          },
        ],
      }).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_META);
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status,
      ).toBe('LIDA');
    });

    it('anexo: a Meta recebe um link assinado da API, que baixa o arquivo', async () => {
      const { canal, conversa } = await conversaComContato();
      const arquivo = await criarArquivo(t, {
        conteudo: PNG_DE_TESTE,
        nome: 'cardapio.png',
        mime: 'image/png',
      });
      const mensagem = await saida(conversa.id, canal.id, {
        arquivoId: arquivo.id,
        tipo: 'IMAGEM',
      });
      const resultado = await t
        .get(AdaptadorMessenger)
        .enviar(mensagem, conversa, canal);
      const enviados = graph.pedidos.filter((p) => p.metodo === 'POST');
      expect(enviados).toHaveLength(2);
      const { attachment: anexo } = (enviados[0].corpo ?? {}).message as {
        attachment: { type: string; payload: { url: string } };
      };
      expect(anexo.type).toBe('image');
      expect(anexo.payload.url).toMatch(
        new RegExp(
          `^http://localhost:4200/api/v1/publico/meta/arquivos/${arquivo.id}\\?c=${canal.id}&e=\\d+&a=[0-9a-f]{64}$`,
        ),
      );
      expect(enviados[1].corpo?.message).toEqual({ text: 'Entregamos, sim!' });
      // O id externo é o da última mensagem (o texto).
      expect(resultado.idExterno).toMatch(/^m_falso_\d+$/);
      expect(Number((resultado.idExterno ?? '').split('_')[2])).toBeGreaterThan(
        1,
      );
      const caminho = anexo.payload.url.replace('http://localhost:4200', '');
      const baixado = await request(t.servidor)
        .get(caminho)
        .buffer(true)
        .parse((res, callback) => {
          const partes: Buffer[] = [];
          res.on('data', (parte: Buffer) => partes.push(parte));
          res.on('end', () => callback(null, Buffer.concat(partes)));
        })
        .expect(200);
      expect(Buffer.compare(baixado.body as Buffer, PNG_DE_TESTE)).toBe(0);
      await request(t.servidor)
        .get(caminho.replace(/a=[0-9a-f]{4}/, 'a=ffff'))
        .expect(404);
    });

    it('anexo com texto: se o texto falha, a nova tentativa não reenvia o anexo', async () => {
      const { canal, conversa } = await conversaComContato();
      const arquivo = await criarArquivo(t, {
        conteudo: PNG_DE_TESTE,
        nome: 'foto.png',
        mime: 'image/png',
      });
      const mensagem = await saida(conversa.id, canal.id, {
        arquivoId: arquivo.id,
        tipo: 'IMAGEM',
        texto: 'instavel-uma-vez: segue a foto',
      });
      const posts = () => graph.pedidos.filter((p) => p.metodo === 'POST');
      const antes = posts().length;
      await expect(
        t.get(AdaptadorMessenger).enviar(mensagem, conversa, canal),
      ).rejects.toMatchObject({ name: 'FalhaPassageiraDaMeta' });
      expect(posts().length - antes).toBe(2);

      // O Atendimento tenta de novo com a mensagem relida do banco.
      const relida = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: mensagem.id },
      });
      const resultado = await t
        .get(AdaptadorMessenger)
        .enviar(relida, conversa, canal);
      const novos = posts().slice(antes + 2);
      expect(novos.map((p) => p.corpo?.message)).toEqual([
        { text: 'instavel-uma-vez: segue a foto' },
      ]);
      expect(resultado.idExterno).toMatch(/^m_falso_\d+$/);
    });

    it('cenário 30 — R14: fora da janela de 24 h: não envia (falha definitiva com o motivo)', async () => {
      const { canal, conversa } = await conversaComContato();
      const vencida = await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { janelaAte: new Date(Date.now() - 1000) },
      });
      expect(t.get(RegistroCanais).podeResponder(vencida, canal)).toEqual({
        pode: false,
        motivo: MOTIVO_JANELA_FECHADA,
      });
      const mensagem = await saida(conversa.id, canal.id);
      const antes = graph.pedidos.length;
      await expect(
        t.get(AdaptadorMessenger).enviar(mensagem, vencida, canal),
      ).rejects.toMatchObject({
        name: 'FalhaDefinitivaDeEnvio',
        codigo: 'janela_fechada',
        message: MOTIVO_JANELA_FECHADA,
      });
      expect(graph.pedidos.length).toBe(antes);

      // A Meta também recusa (relógio diferente): mesma falha.
      const outra = await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: {
          janelaAte: new Date(Date.now() + 3600_000),
          idExterno: 'fora-da-janela-1',
        },
      });
      await expect(
        t.get(AdaptadorMessenger).enviar(mensagem, outra, canal),
      ).rejects.toMatchObject({
        codigo: 'janela_fechada',
      });
    });

    it('token inválido vira falha definitiva com o erro no canal; Meta instável é passageira', async () => {
      const { canal, conversa, admin } = await conversaComContato();
      const mensagem = await saida(conversa.id, canal.id);
      await admin
        .patch(`/api/v1/meta/canais/${canal.id}`, {
          tokenPagina: 'token-vencido',
        })
        .expect(200);
      const comTokenVencido = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      await expect(
        t.get(AdaptadorMessenger).enviar(mensagem, conversa, comTokenVencido),
      ).rejects.toMatchObject({
        name: 'FalhaDefinitivaDeEnvio',
        codigo: 'token_invalido',
      });
      expect(
        (await t.prisma.canal.findUniqueOrThrow({ where: { id: canal.id } }))
          .ultimoErro,
      ).toMatch(/token da página do Messenger é inválido/);

      const instavel = await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { idExterno: 'meta-instavel' },
      });
      await expect(
        t.get(AdaptadorMessenger).enviar(mensagem, instavel, canal),
      ).rejects.toMatchObject({
        name: 'FalhaPassageiraDaMeta',
      });
    });
  });
});
