import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import { LimitadorDeRequisicoes } from '../src/canais/comum/limitador';
import { FILA_WEBHOOK_WHATSAPP_OFICIAL } from '../src/canais/whatsapp-oficial/entrada-whatsapp-oficial.service';
import {
  FILA_CONEXAO_PERDIDA,
  FILA_FECHAR_ENCERRAMENTO,
  FILA_TOQUE_ESGOTADO,
  FILA_VIGIAR_LIGACAO,
} from '../src/ligacoes/ligacoes.constantes';
import { LigacoesService } from '../src/ligacoes/ligacoes.service';
import { WebhookDeLigacoesService } from '../src/ligacoes/webhook-ligacoes.service';
import { type CenarioDoAtendimento, montarCenario } from './atendimento-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  conectarTempoReal,
  criarAppTeste,
  criarContato,
  drenarFilas,
  drenarTudo,
  entrarComo,
  esperarEvento,
  fecharSockets,
  semEvento,
  type SocketDeTeste,
} from './utils';

const APP_SECRET = 'segredo-do-app-oficial-de-teste';
const TOKEN = 'EAAG-token-oficial-de-teste';
const NUMERO_ID = '100000000000001';
const WABA_ID = '200000000000001';
const TELEFONE = '5511999990001';
const OFERTA = 'v=0\r\no=meta oferta 1 1 IN IP4 127.0.0.1\r\na=ice-lite\r\n';
const RESPOSTA =
  'v=0\r\no=crm resposta 1 1 IN IP4 127.0.0.1\r\na=setup:active\r\n';
const OFERTA_DO_BROWSER =
  'v=0\r\no=browser oferta 1 1 IN IP4 127.0.0.1\r\na=setup:actpass\r\n';
const RESPOSTA_DA_META =
  'v=0\r\no=meta resposta 1 1 IN IP4 127.0.0.1\r\na=ice-lite\r\n';

interface PedidoRecebido {
  metodo: string;
  caminho: string;
  corpo: Record<string, any> | null;
}

interface PermissaoFalsa {
  status: 'no_permission' | 'temporary' | 'permanent';
  expiration?: number;
  pedirPode?: boolean;
  ligarPode?: boolean;
  ligarLibera?: number;
}

/** Graph/Calling API falsa, numa porta livre: ações de chamada, settings, permissões, mensagens e templates. */
async function subirGraphFalsa() {
  const pedidos: PedidoRecebido[] = [];
  const estado = {
    sequencia: 0,
    permissoes: new Map<string, PermissaoFalsa>(),
    /** Erro de uma ação (`connect`, `accept`…, `settings`, `permissoes`, `mensagem`): vale uma vez. */
    falhas: new Map<
      string,
      { status: number; erro: Record<string, unknown> }
    >(),
    templates: [] as Array<Record<string, unknown>>,
  };
  const servidor: Server = createServer((req: IncomingMessage, res) => {
    const partes: Buffer[] = [];
    req.on('data', (parte: Buffer) => partes.push(parte));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://graph');
      const bruto = Buffer.concat(partes);
      const corpo =
        req.headers['content-type']?.startsWith('application/json') &&
        bruto.length > 0
          ? (JSON.parse(bruto.toString('utf8')) as Record<string, any>)
          : null;
      pedidos.push({
        metodo: req.method ?? '',
        caminho: `${url.pathname}${url.search}`,
        corpo,
      });
      const responder = (status: number, dados: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(dados));
      };
      const falhar = (chave: string): boolean => {
        const falha = estado.falhas.get(chave);
        if (!falha) return false;
        estado.falhas.delete(chave);
        responder(falha.status, { error: falha.erro });
        return true;
      };
      if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
        responder(401, { error: { message: 'Sem token', code: 190 } });
        return;
      }
      const caminho = url.pathname.split('/').filter(Boolean);
      const acao = caminho[2];
      if (req.method === 'POST' && acao === 'calls') {
        const tipo = String(corpo?.action);
        if (falhar(tipo)) return;
        if (tipo === 'connect') {
          estado.sequencia++;
          responder(200, {
            messaging_product: 'whatsapp',
            calls: [{ id: `wacid.FEITA${estado.sequencia}` }],
          });
          return;
        }
        responder(200, { messaging_product: 'whatsapp', success: true });
        return;
      }
      if (req.method === 'POST' && acao === 'settings') {
        if (falhar('settings')) return;
        responder(200, { success: true });
        return;
      }
      if (req.method === 'GET' && acao === 'call_permissions') {
        if (falhar('permissoes')) return;
        const quem = url.searchParams.get('user_wa_id') ?? '';
        const p = estado.permissoes.get(quem) ?? { status: 'no_permission' };
        responder(200, {
          messaging_product: 'whatsapp',
          permission: {
            status: p.status,
            ...(p.expiration ? { expiration_time: p.expiration } : {}),
          },
          actions: [
            {
              action_name: 'send_call_permission_request',
              can_perform_action: p.pedirPode ?? true,
              limits: [
                { time_period: 'PT24H', max_allowed: 1, current_usage: 0 },
              ],
            },
            {
              action_name: 'start_call',
              can_perform_action: p.ligarPode ?? true,
              limits: [
                {
                  time_period: 'PT24H',
                  max_allowed: 5,
                  current_usage: p.ligarPode === false ? 5 : 0,
                  ...(p.ligarLibera
                    ? { limit_expiration_time: p.ligarLibera }
                    : {}),
                },
              ],
            },
          ],
        });
        return;
      }
      if (req.method === 'POST' && acao === 'messages') {
        if (falhar('mensagem')) return;
        estado.sequencia++;
        responder(200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: corpo?.to, wa_id: corpo?.to }],
          messages: [{ id: `wamid.FALSO${estado.sequencia}` }],
        });
        return;
      }
      if (req.method === 'GET' && acao === 'message_templates') {
        responder(200, {
          data: estado.templates,
          paging: { cursors: { after: 'FIM' } },
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
    fechar: () =>
      new Promise<void>((resolver) => servidor.close(() => resolver())),
  };
}

const TEMPLATE_PERMISSAO = {
  id: 'TP1',
  name: 'pedido_de_permissao',
  language: 'pt_BR',
  category: 'UTILITY',
  status: 'APPROVED',
  components: [
    { type: 'BODY', text: 'Olá {{1}}, podemos ligar para você?' },
    { type: 'call_permission_request' },
  ],
};

/**
 * Ligações pelo WhatsApp oficial (Onda E, R29): configuração, recebida (atendida,
 * perdida por tempo, disputa, fora do horário), feita (com e sem permissão),
 * pedido de permissão e limites, webhooks repetidos e fora de ordem, uma ligação
 * por atendente e queda do navegador, contra uma Calling API falsa em processo.
 */
describe('Ligações pelo WhatsApp oficial (e2e)', () => {
  let t: AppTeste;
  let graph: Awaited<ReturnType<typeof subirGraphFalsa>>;
  let cenario: CenarioDoAtendimento;
  let admin: ClienteHttp;
  let ana: ClienteHttp;
  let bruno: ClienteHttp;
  let canalId: string;
  const sockets: SocketDeTeste[] = [];

  beforeAll(async () => {
    graph = await subirGraphFalsa();
    t = await criarAppTeste({
      variaveis: {
        META_GRAPH_URL: graph.url,
        LIGACOES_ESPERA_PRE_ACEITE_MS: '0',
      },
    });
  });
  beforeEach(async () => {
    await t.limparBanco();
    graph.pedidos.length = 0;
    graph.estado.sequencia = 0;
    graph.estado.permissoes.clear();
    graph.estado.falhas.clear();
    graph.estado.templates = [TEMPLATE_PERMISSAO];
    t.get(LimitadorDeRequisicoes).zerar();
    cenario = await montarCenario(t, { membros: 2 });
    admin = await entrarComo(t, cenario.admin);
    ana = await entrarComo(t, cenario.comercial.membros[0]!);
    bruno = await entrarComo(t, cenario.comercial.membros[1]!);
    const criado = await admin
      .post('/api/v1/whatsapp-oficial/canais', {
        nome: 'WhatsApp oficial',
        phoneNumberId: NUMERO_ID,
        wabaId: WABA_ID,
        token: TOKEN,
        appSecret: APP_SECRET,
        filaPadraoId: cenario.fila.id,
      })
      .expect(201);
    canalId = (criado.body as { id: string }).id;
    await admin
      .post(`/api/v1/whatsapp-oficial/canais/${canalId}/templates/sincronizar`)
      .expect(200);
    graph.pedidos.length = 0;
  });
  afterEach(() => {
    fecharSockets(...sockets.splice(0));
  });
  afterAll(async () => {
    await t?.fechar();
    await graph?.fechar();
  });

  // ---- apoio ---------------------------------------------------------------

  async function ativarLigacoes(corpo: object = {}) {
    return admin
      .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
        ativa: true,
        ...corpo,
      })
      .expect(200);
  }

  async function conectar(cliente: ClienteHttp): Promise<SocketDeTeste> {
    const socket = await conectarTempoReal(t, cliente);
    sockets.push(socket);
    return socket;
  }

  function postarWebhook(corpo: object, segredo = APP_SECRET) {
    const bruto = JSON.stringify(corpo);
    return request(t.servidor)
      .post('/api/v1/publico/meta/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature-256',
        `sha256=${createHmac('sha256', segredo).update(bruto).digest('hex')}`,
      )
      .send(bruto);
  }

  const agoraEmSegundos = (deslocamento = 0) =>
    String(Math.floor(Date.now() / 1000) + deslocamento);

  const envelope = (campo: string, valor: object) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: campo,
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '551140001000',
                phone_number_id: NUMERO_ID,
              },
              ...valor,
            },
          },
        ],
      },
    ],
  });

  const connectRecebido = (
    id: string,
    opcoes: { de?: string; sdp?: string; timestamp?: string } = {},
  ) =>
    envelope('calls', {
      contacts: [{ profile: { name: 'Maria' }, wa_id: opcoes.de ?? TELEFONE }],
      calls: [
        {
          id,
          to: '551140001000',
          from: opcoes.de ?? TELEFONE,
          event: 'connect',
          timestamp: opcoes.timestamp ?? agoraEmSegundos(),
          session: { sdp_type: 'offer', sdp: opcoes.sdp ?? OFERTA },
        },
      ],
    });

  const terminar = (
    id: string,
    opcoes: {
      direcao?: 'USER_INITIATED' | 'BUSINESS_INITIATED';
      status?: string;
      duracao?: number;
      erros?: object[];
    } = {},
  ) =>
    envelope('calls', {
      contacts: [{ wa_id: TELEFONE }],
      calls: [
        {
          id,
          event: 'terminate',
          direction: opcoes.direcao ?? 'USER_INITIATED',
          timestamp: agoraEmSegundos(),
          status: opcoes.status ?? 'COMPLETED',
          ...(opcoes.duracao !== undefined
            ? {
                start_time: agoraEmSegundos(-opcoes.duracao),
                end_time: agoraEmSegundos(),
                duration: opcoes.duracao,
              }
            : {}),
          ...(opcoes.erros ? { errors: opcoes.erros } : {}),
        },
      ],
    });

  const statusDeChamada = (id: string, status: string) =>
    envelope('calls', {
      statuses: [
        {
          id,
          type: 'call',
          status,
          timestamp: agoraEmSegundos(),
          recipient_id: TELEFONE,
        },
      ],
    });

  const respostaSdpDaMeta = (id: string, opaco: string) =>
    envelope('calls', {
      contacts: [{ wa_id: TELEFONE }],
      calls: [
        {
          id,
          to: TELEFONE,
          event: 'connect',
          direction: 'BUSINESS_INITIATED',
          timestamp: agoraEmSegundos(),
          session: { sdp_type: 'answer', sdp: RESPOSTA_DA_META },
          biz_opaque_callback_data: opaco,
        },
      ],
    });

  const respostaDePermissao = (opcoes: {
    id: string;
    resposta?: 'accept' | 'reject';
    permanente?: boolean;
    expira?: number;
    de?: string;
  }) =>
    envelope('messages', {
      contacts: [{ profile: { name: 'Maria' }, wa_id: opcoes.de ?? TELEFONE }],
      messages: [
        {
          from: opcoes.de ?? TELEFONE,
          id: opcoes.id,
          timestamp: agoraEmSegundos(),
          type: 'interactive',
          context: { from: opcoes.de ?? TELEFONE, id: 'wamid.PEDIDO' },
          interactive: {
            type: 'call_permission_reply',
            call_permission_reply: {
              response: opcoes.resposta ?? 'accept',
              is_permanent: opcoes.permanente ?? false,
              ...(opcoes.expira
                ? { expiration_timestamp: String(opcoes.expira) }
                : {}),
              response_source: 'user_action',
            },
          },
        },
      ],
    });

  /** Entrega o webhook e processa o job. */
  async function entregar(
    corpo: object,
    opcoes: { incluirAgendados?: boolean } = {},
  ) {
    await postarWebhook(corpo).expect(200);
    await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL, opcoes);
  }

  const chamadasNaMeta = (acao?: string) =>
    graph.pedidos.filter(
      (p) =>
        p.metodo === 'POST' &&
        p.caminho === `/v24.0/${NUMERO_ID}/calls` &&
        (!acao || p.corpo?.action === acao),
    );

  const ligacaoPorMeta = (idMeta: string) =>
    t.prisma.ligacao.findFirstOrThrow({ where: { idMeta } });

  async function contatoDaMaria(responsavel?: { id: string }) {
    return criarContato(t, {
      nome: 'Maria da Silva',
      telefone: TELEFONE,
      responsavel: responsavel?.id,
    });
  }

  /** Recebe a ligação e a atende com o atendente informado. Devolve o id da ligação. */
  async function receberEAtender(
    id: string,
    atendente: ClienteHttp,
    socket: SocketDeTeste,
  ): Promise<string> {
    const tocando = esperarEvento(socket, 'ligacao.tocando');
    await entregar(connectRecebido(id));
    const { ligacaoId } = await tocando;
    await atendente
      .post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA })
      .expect(200);
    return ligacaoId;
  }

  // =========================================================================

  describe('R29.6 — configuração (só o Admin) e liga/desliga na Meta', () => {
    it('cenário 195 — R29.6 — Admin liga as chamadas: settings na Meta e padrões do canal', async () => {
      const antes = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`)
        .expect(200);
      expect(antes.body).toMatchObject({
        ativa: false,
        botaoVisivel: true,
        gravar: true,
        tempoDeToqueSegundos: 25,
        mensagemPerdidaAtiva: false,
        campoDoWebhook: 'calls',
        filaEfetivaId: cenario.fila.id,
      });
      const depois = await ativarLigacoes({
        tempoDeToqueSegundos: 20,
        gravar: false,
      });
      expect(depois.body).toMatchObject({
        ativa: true,
        tempoDeToqueSegundos: 20,
        gravar: false,
      });
      const [settings] = graph.pedidos.filter(
        (p) => p.caminho === `/v24.0/${NUMERO_ID}/settings`,
      );
      expect(settings?.corpo).toEqual({
        calling: {
          status: 'ENABLED',
          call_icon_visibility: 'DEFAULT',
          sip: { status: 'DISABLED' },
        },
      });
      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          ativa: false,
        })
        .expect(200);
      expect(
        graph.pedidos
          .filter((p) => p.caminho === `/v24.0/${NUMERO_ID}/settings`)
          .at(-1)?.corpo,
      ).toMatchObject({ calling: { status: 'DISABLED' } });
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: { startsWith: 'canal.ligacoes' } },
      });
      expect(auditoria.map((e) => e.acao)).toEqual(
        expect.arrayContaining([
          'canal.ligacoes_ativadas',
          'canal.ligacoes_desativadas',
        ]),
      );
    });

    it('cenário 196 — R29.6 — só o Admin configura; o resto usa o Atendimento (Marketing não)', async () => {
      await ana
        .get(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`)
        .expect(403);
      await ana
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          ativa: true,
        })
        .expect(403);
      const marketing = await entrarComo(t, cenario.marketing);
      await marketing.get('/api/v1/ligacoes/ativas').expect(403);
      await ana.get('/api/v1/ligacoes/ativas').expect(200);
    });

    it('cenário 197 — R29.6 — a Meta recusa ativar (limite de mensagens): nada é gravado e o motivo vem em português', async () => {
      graph.estado.falhas.set('settings', {
        status: 400,
        erro: { message: 'limit', code: 138015 },
      });
      const resposta = await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          ativa: true,
        })
        .expect(422);
      expect(resposta.body).toMatchObject({
        detalhes: { motivo: 'limite_de_mensagens_baixo', codigoDaMeta: 138015 },
      });
      expect(resposta.body.mensagem).toContain('2.000');
      const config = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`)
        .expect(200);
      expect(config.body).toMatchObject({ ativa: false });
      expect(config.body.ultimoErroMeta).toContain('2.000');
    });

    it('cenário 198 — R29.6 — valida tempo de toque, horário e mensagem de perdida', async () => {
      const rota = `/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`;
      await admin.patch(rota, { tempoDeToqueSegundos: 5 }).expect(400);
      await admin.patch(rota, { tempoDeToqueSegundos: 90 }).expect(400);
      await admin
        .patch(rota, { horario: { fusoHorario: 'Marte/Olimpo', dias: {} } })
        .expect(400);
      await admin.patch(rota, { mensagemPerdidaAtiva: true }).expect(400);
      const ok = await admin
        .patch(rota, {
          mensagemPerdidaAtiva: true,
          mensagemPerdida: 'Vimos sua ligação e já retornamos.',
          botaoVisivel: false,
        })
        .expect(200);
      expect(ok.body).toMatchObject({
        mensagemPerdidaAtiva: true,
        botaoVisivel: false,
      });
    });
  });

  describe('R29.2 — ligação recebida', () => {
    it('cenário 199 — R29.2 — atendida: toca para o responsável, pre_accept e accept com o MESMO SDP, termina com duração, atividade e evento na conversa', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      const tocandoAna = esperarEvento(socketAna, 'ligacao.tocando');
      const semToque = semEvento(socketBruno, 'ligacao.tocando', 600);
      await entregar(connectRecebido('wacid.R1'));

      const toque = await tocandoAna;
      await semToque;
      expect(toque).toMatchObject({
        contato: { id: contato.id, nome: 'Maria da Silva' },
        canal: { id: canalId },
        ofertaSdp: OFERTA,
      });
      expect(Date.parse(toque.expiraEm)).toBeGreaterThan(Date.now());
      const tocando = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: toque.ligacaoId },
      });
      expect(tocando).toMatchObject({
        estado: 'TOCANDO',
        direcao: 'RECEBIDA',
        idMeta: 'wacid.R1',
        ofertaSdp: OFERTA,
      });
      expect(tocando.tocouPara).toEqual([cenario.comercial.membros[0]!.id]);
      // O toque também vira notificação (e push, se configurado) com a rota para abrir a ligação.
      const notificacao = await t.prisma.notificacao.findFirstOrThrow({
        where: {
          usuarioId: cenario.comercial.membros[0]!.id,
          tipo: 'ligacao.tocando',
        },
      });
      expect(notificacao.link).toBe(`/atendimento?ligacao=${toque.ligacaoId}`);
      // Quem recarrega a página recupera o toque.
      const ativas = await ana.get('/api/v1/ligacoes/ativas').expect(200);
      expect(ativas.body.tocando).toHaveLength(1);
      expect(ativas.body.tocando[0].ofertaSdp).toBe(OFERTA);
      expect(
        (await bruno.get('/api/v1/ligacoes/ativas').expect(200)).body.tocando,
      ).toHaveLength(0);

      const estadoEmAndamento = esperarEvento(socketAna, 'ligacao.estado');
      const atendida = await ana
        .post(`/api/v1/ligacoes/${toque.ligacaoId}/atender`, { sdp: RESPOSTA })
        .expect(200);
      expect(atendida.body).toMatchObject({
        estado: 'EM_ANDAMENTO',
        atendente: { id: cenario.comercial.membros[0]!.id },
        ofertaSdp: null,
      });
      expect(await estadoEmAndamento).toMatchObject({ estado: 'EM_ANDAMENTO' });
      const [preAceite, aceite] = [
        chamadasNaMeta('pre_accept'),
        chamadasNaMeta('accept'),
      ];
      expect(preAceite).toHaveLength(1);
      expect(aceite).toHaveLength(1);
      expect(preAceite[0]!.corpo).toMatchObject({
        call_id: 'wacid.R1',
        session: { sdp_type: 'answer', sdp: RESPOSTA },
      });
      expect(aceite[0]!.corpo?.session).toEqual(preAceite[0]!.corpo?.session);
      // O sino da notificação de toque foi marcado como lido.
      expect(
        (
          await t.prisma.notificacao.findUniqueOrThrow({
            where: { id: notificacao.id },
          })
        ).lidaEm,
      ).not.toBeNull();

      const encerrada = esperarEvento(socketAna, 'ligacao.encerrada');
      await entregar(terminar('wacid.R1', { duracao: 125 }));
      expect(await encerrada).toMatchObject({
        ligacaoId: toque.ligacaoId,
        estado: 'ENCERRADA',
        duracaoSegundos: 125,
        motivo: 'encerrada_pelo_cliente',
      });
      const fim = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: toque.ligacaoId },
      });
      expect(fim).toMatchObject({
        estado: 'ENCERRADA',
        duracaoSegundos: 125,
        ofertaSdp: null,
        respostaSdp: null,
      });
      // Atividade LIGACAO concluída, com quem atendeu, e evento na conversa.
      const atividade = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: fim.atividadeId! },
      });
      expect(atividade).toMatchObject({
        tipo: 'LIGACAO',
        status: 'CONCLUIDA',
        contatoId: contato.id,
        responsavelId: cenario.comercial.membros[0]!.id,
      });
      expect(atividade.descricao).toContain('Duração: 2:05');
      const aviso = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId: fim.conversaId!, direcao: 'SISTEMA' },
      });
      expect(aviso.texto).toContain('atendida por');
      expect(aviso.texto).toContain('2:05');
      // A ligação abriu a janela de 24 h do canal (R28.4).
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: fim.conversaId! },
      });
      expect(conversa.janelaAte!.getTime()).toBeGreaterThan(
        Date.now() + 23 * 3_600_000,
      );
      // A ligação não virou "mensagem do cliente" na conversa.
      expect(
        await t.prisma.mensagem.count({ where: { direcao: 'ENTRADA' } }),
      ).toBe(0);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: {
              in: ['ligacao.recebida', 'ligacao.atendida', 'ligacao.encerrada'],
            },
          },
        }),
      ).toBe(3);
    });

    it('cenário 200 — R29.2 — contato novo: cria contato e conversa na fila do canal e toca para os atendentes livres da fila', async () => {
      await ativarLigacoes();
      // Sem responsável (fila manual): a ligação toca para todos os atendentes livres da fila.
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { estrategia: 'MANUAL' },
      });
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      const tocandoAna = esperarEvento(socketAna, 'ligacao.tocando');
      const tocandoBruno = esperarEvento(socketBruno, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.R2', { de: '5511977776666' }));
      const [a, b] = await Promise.all([tocandoAna, tocandoBruno]);
      expect(a.ligacaoId).toBe(b.ligacaoId);
      const ligacao = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: a.ligacaoId },
      });
      expect(ligacao.tocouPara.sort()).toEqual(
        [
          cenario.comercial.membros[0]!.id,
          cenario.comercial.membros[1]!.id,
        ].sort(),
      );
      const contato = await t.prisma.contato.findFirstOrThrow({
        where: { telefone: '5511977776666' },
      });
      expect(contato.nome).toBe('Maria');
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: ligacao.conversaId! },
      });
      expect(conversa).toMatchObject({
        canalId,
        contatoId: contato.id,
        filaId: cenario.fila.id,
      });
    });

    it('cenário 201 — R29.2 — disputa de dois atendentes: só um leva (409 para o outro) e o outro recebe deixou_de_tocar', async () => {
      await ativarLigacoes();
      // Sem responsável (fila manual): a ligação toca para todos os atendentes livres da fila.
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { estrategia: 'MANUAL' },
      });
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      await esperarEvento(socketBruno, 'ligacao.tocando', 50).catch(
        () => undefined,
      );
      const tocandoBruno = esperarEvento(socketBruno, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.R3', { de: '5511977776666' }));
      const { ligacaoId } = await tocando;
      await tocandoBruno;
      const deixouAna = esperarEvento(
        socketAna,
        'ligacao.deixou_de_tocar',
      ).catch(() => null);
      const deixouBruno = esperarEvento(
        socketBruno,
        'ligacao.deixou_de_tocar',
      ).catch(() => null);
      const [r1, r2] = await Promise.all([
        ana.post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA }),
        bruno.post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA }),
      ]);
      const status = [r1.status, r2.status].sort((a, b) => a - b);
      expect(status).toEqual([200, 409]);
      const perdedor = r1.status === 409 ? r1 : r2;
      expect(perdedor.body).toMatchObject({
        detalhes: { motivo: 'atendida_por_outro' },
      });
      expect(perdedor.body.mensagem).toContain('já foi atendida por');
      const ganhouAna = r1.status === 200;
      const evento = await (ganhouAna ? deixouBruno : deixouAna);
      expect(evento).toMatchObject({
        ligacaoId,
        motivo: 'atendida_por_outro',
        atendidaPor: {
          id: (ganhouAna
            ? cenario.comercial.membros[0]!
            : cenario.comercial.membros[1]!
          ).id,
        },
      });
      // Um único pre_accept e um único accept foram à Meta.
      expect(chamadasNaMeta('pre_accept')).toHaveLength(1);
      expect(chamadasNaMeta('accept')).toHaveLength(1);
      // Quem não foi chamado não atende.
      const marketing = await entrarComo(t, cenario.marketing);
      await marketing
        .post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA })
        .expect(403);
    });

    it('cenário 202 — R29.2 — perdida por tempo de toque: reject na Meta, atividade "Retornar ligação", notificação e mensagem automática', async () => {
      await ativarLigacoes({
        mensagemPerdidaAtiva: true,
        mensagemPerdida: 'Vimos sua ligação e já retornamos.',
      });
      const contato = await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.R4'));
      const { ligacaoId } = await tocando;
      const deixou = esperarEvento(socketAna, 'ligacao.deixou_de_tocar');
      // O job do tempo de toque (agendado para expira_em) roda agora.
      expect(await t.fila.listarTrabalhos(FILA_TOQUE_ESGOTADO)).toHaveLength(1);
      await drenarFilas(t, FILA_TOQUE_ESGOTADO, { incluirAgendados: true });
      expect(await deixou).toMatchObject({
        ligacaoId,
        motivo: 'tempo_esgotado',
      });
      const ligacao = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
      });
      expect(ligacao).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'tempo_esgotado',
        duracaoSegundos: 0,
        ofertaSdp: null,
      });
      expect(chamadasNaMeta('reject')).toHaveLength(1);
      expect(chamadasNaMeta('reject')[0]!.corpo).toMatchObject({
        call_id: 'wacid.R4',
      });
      const atividade = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: ligacao.atividadeId! },
      });
      expect(atividade).toMatchObject({
        tipo: 'LIGACAO',
        status: 'PENDENTE',
        titulo: 'Retornar ligação: Maria da Silva',
        responsavelId: cenario.comercial.membros[0]!.id,
        contatoId: contato.id,
      });
      expect(
        await t.prisma.notificacao.count({
          where: {
            usuarioId: cenario.comercial.membros[0]!.id,
            tipo: 'ligacao.perdida',
          },
        }),
      ).toBe(1);
      // Evento na conversa e mensagem automática (a ligação abriu a janela de 24 h).
      const mensagens = await t.prisma.mensagem.findMany({
        where: { conversaId: ligacao.conversaId! },
        orderBy: { ocorridaEm: 'asc' },
      });
      expect(mensagens.map((m) => m.direcao)).toEqual(['SISTEMA', 'SAIDA']);
      expect(mensagens[0]!.texto).toContain('Ligação perdida');
      expect(mensagens[1]!.texto).toBe('Vimos sua ligação e já retornamos.');
      await drenarFilas(t, FILA_ENVIO_ATENDIMENTO);
      expect(
        graph.pedidos.filter(
          (p) =>
            p.caminho === `/v24.0/${NUMERO_ID}/messages` &&
            p.corpo?.type === 'text',
        ),
      ).toHaveLength(1);
      // O terminate que a Meta manda depois do reject não muda nada.
      await entregar(terminar('wacid.R4'));
      expect((await ligacaoPorMeta('wacid.R4')).estado).toBe('PERDIDA');
      // Quem tentar atender depois leva 409.
      await ana
        .post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA })
        .expect(409);
    });

    it('cenário 203 — R29.2 — fora do horário de ligações: PERDIDA na hora, reject na Meta e atividade de retorno; sem ninguém online também', async () => {
      const fechado = {
        fusoHorario: 'America/Sao_Paulo',
        dias: { '1': [{ inicio: '00:00', fim: '00:01' }] },
      };
      await ativarLigacoes({ horario: fechado });
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      await semEvento(socketAna, 'ligacao.tocando', 10);
      await entregar(connectRecebido('wacid.R5'));
      const fora = await ligacaoPorMeta('wacid.R5');
      expect(fora).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'fora_do_horario',
        tocouPara: [],
      });
      expect(chamadasNaMeta('reject')).toHaveLength(1);
      expect(
        await t.prisma.atividade.count({
          where: { titulo: { startsWith: 'Retornar ligação' } },
        }),
      ).toBe(1);

      // Sem horário próprio e sem ninguém online: sem_atendente.
      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          horario: null,
        })
        .expect(200);
      fecharSockets(...sockets.splice(0));
      await new Promise((r) => setTimeout(r, 100));
      await entregar(connectRecebido('wacid.R6'));
      expect(await ligacaoPorMeta('wacid.R6')).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'sem_atendente',
      });
      expect(chamadasNaMeta('reject')).toHaveLength(2);
    });

    it('cenário 204 — R29.2 — "livre" = sem ligação em andamento: o responsável ocupado deixa a ligação para a fila', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      await receberEAtender('wacid.R7', ana, socketAna);
      const tocandoBruno = esperarEvento(socketBruno, 'ligacao.tocando');
      const semAna = semEvento(socketAna, 'ligacao.tocando', 600);
      await entregar(connectRecebido('wacid.R8', { de: '5511977776666' }));
      await tocandoBruno;
      await semAna;
      const segunda = await ligacaoPorMeta('wacid.R8');
      expect(segunda.tocouPara).toEqual([cenario.comercial.membros[1]!.id]);
    });

    it('cenário 205 — R29.2 — uma ligação por atendente: atender outra com uma em andamento é 409', async () => {
      await ativarLigacoes();
      const socketAna = await conectar(ana);
      await conectar(bruno);
      await receberEAtender('wacid.R9', ana, socketAna);
      // A segunda ligação toca só para o Bruno; forço o Ana na lista para provar a trava do banco.
      await entregar(connectRecebido('wacid.R10', { de: '5511977776666' }));
      const segunda = await ligacaoPorMeta('wacid.R10');
      await t.prisma.ligacao.update({
        where: { id: segunda.id },
        data: {
          tocouPara: [
            cenario.comercial.membros[0]!.id,
            cenario.comercial.membros[1]!.id,
          ],
        },
      });
      const resposta = await ana
        .post(`/api/v1/ligacoes/${segunda.id}/atender`, { sdp: RESPOSTA })
        .expect(409);
      expect(resposta.body).toMatchObject({
        detalhes: { motivo: 'ja_em_ligacao' },
      });
      expect(
        (
          await t.prisma.ligacao.findUniqueOrThrow({
            where: { id: segunda.id },
          })
        ).atendenteId,
      ).toBeNull();
    });

    it('cenário 206 — R29.2 — a Meta recusa o accept: a ligação falha (FALHOU) e o atendente recebe o motivo', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.R11'));
      const { ligacaoId } = await tocando;
      graph.estado.falhas.set('accept', {
        status: 400,
        erro: { message: 'call ended', code: 100 },
      });
      const resposta = await ana
        .post(`/api/v1/ligacoes/${ligacaoId}/atender`, { sdp: RESPOSTA })
        .expect(409);
      expect(resposta.body).toMatchObject({
        detalhes: { motivo: 'meta_recusou', codigoDaMeta: 100 },
      });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        estado: 'FALHOU',
        motivo: 'falha_ao_atender',
        erroCodigo: 100,
      });
      // O cliente ficou sem atendimento: há uma atividade de retorno.
      expect(
        await t.prisma.atividade.count({
          where: {
            titulo: { startsWith: 'Retornar ligação' },
            status: 'PENDENTE',
          },
        }),
      ).toBe(1);
    });

    it('cenário 207 — R29.2 — o cliente desliga antes de alguém atender: PERDIDA (cliente_desligou) e os outros param de tocar', async () => {
      await ativarLigacoes();
      // Sem responsável (fila manual): a ligação toca para todos os atendentes livres da fila.
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { estrategia: 'MANUAL' },
      });
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.R12', { de: '5511977776666' }));
      const { ligacaoId } = await tocando;
      const deixou = esperarEvento(socketBruno, 'ligacao.deixou_de_tocar');
      await entregar(terminar('wacid.R12'));
      expect(await deixou).toMatchObject({
        ligacaoId,
        motivo: 'cliente_desligou',
      });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'cliente_desligou',
      });
    });

    it('cenário 208 — R29.2 — encerrar chama terminate sempre; o webhook fecha com a duração; sem webhook, o job fecha sozinho', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const ligacaoId = await receberEAtender('wacid.R13', ana, socketAna);
      const encerrada = esperarEvento(socketAna, 'ligacao.encerrada');
      const resposta = await ana
        .post(`/api/v1/ligacoes/${ligacaoId}/encerrar`)
        .expect(200);
      expect(resposta.body.estado).toBe('EM_ANDAMENTO');
      expect(chamadasNaMeta('terminate')).toHaveLength(1);
      expect(chamadasNaMeta('terminate')[0]!.corpo).toMatchObject({
        call_id: 'wacid.R13',
      });
      await entregar(terminar('wacid.R13', { duracao: 40 }));
      expect(await encerrada).toMatchObject({
        motivo: 'encerrada_pelo_atendente',
        duracaoSegundos: 40,
      });
      // De novo: idempotente (e o job de fechamento, agendado antes, não muda o que o webhook fechou).
      await drenarFilas(t, FILA_FECHAR_ENCERRAMENTO, {
        incluirAgendados: true,
      });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        duracaoSegundos: 40,
        motivo: 'encerrada_pelo_atendente',
      });
      await ana.post(`/api/v1/ligacoes/${ligacaoId}/encerrar`).expect(200);

      // Sem o webhook: o job de fechamento encerra com o que o CRM sabe.
      const outra = await receberEAtender('wacid.R14', ana, socketAna);
      await ana.post(`/api/v1/ligacoes/${outra}/encerrar`).expect(200);
      // O job da primeira ligação (já fechada pelo webhook) não faz nada.
      await drenarFilas(t, FILA_FECHAR_ENCERRAMENTO, {
        incluirAgendados: true,
      });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: outra } }),
      ).toMatchObject({
        estado: 'ENCERRADA',
        motivo: 'encerrada_pelo_atendente',
      });
      // O terminate com a duração real, chegando depois, só completa a duração.
      await entregar(terminar('wacid.R14', { duracao: 77 }));
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: outra } }),
      ).toMatchObject({
        estado: 'ENCERRADA',
        duracaoSegundos: 77,
      });
    });

    it('cenário 209 — R29.2 — anotação rápida vai para a atividade; só quem atendeu anota', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const ligacaoId = await receberEAtender('wacid.R15', ana, socketAna);
      await bruno
        .patch(`/api/v1/ligacoes/${ligacaoId}`, { anotacao: 'invasor' })
        .expect(404);
      await ana
        .patch(`/api/v1/ligacoes/${ligacaoId}`, {
          anotacao: 'Quer proposta até sexta.',
        })
        .expect(200);
      await entregar(terminar('wacid.R15', { duracao: 30 }));
      const ligacao = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
      });
      const atividade = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: ligacao.atividadeId! },
      });
      expect(atividade.descricao).toContain(
        'Anotação: Quer proposta até sexta.',
      );
      await ana
        .patch(`/api/v1/ligacoes/${ligacaoId}`, { anotacao: 'Mudou: sábado.' })
        .expect(200);
      expect(
        (
          await t.prisma.atividade.findUniqueOrThrow({
            where: { id: ligacao.atividadeId! },
          })
        ).descricao,
      ).toContain('Anotação: Mudou: sábado.');
      const historico = await ana
        .get(`/api/v1/ligacoes?contatoId=${ligacao.contatoId}`)
        .expect(200);
      expect(historico.body.itens).toHaveLength(1);
      expect(historico.body.itens[0]).toMatchObject({
        id: ligacaoId,
        anotacao: 'Mudou: sábado.',
      });
    });

    it('cenário 210 — R29.2 — queda do navegador durante a ligação: tolerância curta e depois encerra (terminate + ENCERRADA)', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const ligacaoId = await receberEAtender('wacid.R16', ana, socketAna);
      socketAna.close();
      await new Promise((r) => setTimeout(r, 300));
      expect(await t.fila.listarTrabalhos(FILA_CONEXAO_PERDIDA)).toHaveLength(
        1,
      );
      expect(
        (await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }))
          .desconectadoEm,
      ).not.toBeNull();
      // Reconectou dentro da tolerância: a ligação continua.
      const socketNovo = await conectar(ana);
      await drenarFilas(t, FILA_CONEXAO_PERDIDA, { incluirAgendados: true });
      expect(
        (await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }))
          .estado,
      ).toBe('EM_ANDAMENTO');
      // Caiu de novo e não voltou: encerra.
      socketNovo.close();
      await new Promise((r) => setTimeout(r, 300));
      await drenarFilas(t, FILA_CONEXAO_PERDIDA, { incluirAgendados: true });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        estado: 'ENCERRADA',
        motivo: 'conexao_perdida',
      });
      expect(chamadasNaMeta('terminate')).toHaveLength(1);
    });
  });

  describe('R29.3 — ligação feita pelo CRM e R29.4 — permissão', () => {
    const OFERTA_FEITA = OFERTA_DO_BROWSER;

    function pedidoDeLigacao(contatoId: string, extra: object = {}) {
      return ana.post('/api/v1/ligacoes', {
        contatoId,
        sdp: OFERTA_FEITA,
        ...extra,
      });
    }

    it('cenário 211 — R29.3 — sem permissão: 422 com o que o front precisa para oferecer o pedido e nada é enviado à Meta', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      const resposta = await pedidoDeLigacao(contato.id).expect(422);
      expect(resposta.body).toMatchObject({
        detalhes: {
          motivo: 'sem_permissao',
          situacao: 'NENHUMA',
          podePedir: true,
          janelaAberta: false,
          temTemplateDePermissao: true,
        },
      });
      expect(resposta.body.mensagem).toContain('peça permissão');
      expect(chamadasNaMeta('connect')).toHaveLength(0);
      expect(await t.prisma.ligacao.count()).toBe(0);
    });

    it('R29.2 — o cliente atende no instante em que o atendente cancela: o job de fechamento é agendado mesmo assim', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, {
        status: 'temporary',
        expiration: Math.floor(Date.now() / 1000) + 3 * 86_400,
      });
      const socketAna = await conectar(ana);
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      const idMeta = 'wacid.FEITA1';
      const tocando = esperarEvento(socketAna, 'ligacao.estado');
      await entregar(statusDeChamada(idMeta, 'RINGING'));
      expect(await tocando).toMatchObject({ estado: 'TOCANDO' });
      // O webhook ACCEPTED aplica EM_ANDAMENTO entre a leitura do "Encerrar" e a transição.
      const servico = t.get(LigacoesService);
      const original = servico.agirNaMeta.bind(servico);
      const espiao = jest
        .spyOn(servico, 'agirNaMeta')
        .mockImplementation(async (canalId, acao, id, sdp) => {
          if (acao === 'terminate') {
            await t.prisma.ligacao.update({
              where: { id: criada.body.id },
              data: { estado: 'EM_ANDAMENTO', atendidaEm: new Date() },
            });
          }
          await original(canalId, acao, id, sdp);
        });
      await ana.post(`/api/v1/ligacoes/${criada.body.id}/encerrar`).expect(200);
      espiao.mockRestore();
      expect(
        (
          await t.prisma.ligacao.findUniqueOrThrow({
            where: { id: criada.body.id },
          })
        ).estado,
      ).toBe('EM_ANDAMENTO');
      // O terminate da Meta não veio: o job fecha com o que o CRM sabe.
      await drenarFilas(t, FILA_FECHAR_ENCERRAMENTO, {
        incluirAgendados: true,
      });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({
        estado: 'ENCERRADA',
        motivo: 'encerrada_pelo_atendente',
      });
    });

    it('cenário 212 — R29.3 — com permissão: connect com a oferta, resposta SDP pelo tempo real, RINGING → TOCANDO, ACCEPTED → EM_ANDAMENTO, encerrar e atividade', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, {
        status: 'temporary',
        expiration: Math.floor(Date.now() / 1000) + 3 * 86_400,
      });
      const socketAna = await conectar(ana);
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      expect(criada.body).toMatchObject({
        direcao: 'FEITA',
        estado: 'CHAMANDO',
        atendente: { id: cenario.comercial.membros[0]!.id },
      });
      const [connect] = chamadasNaMeta('connect');
      expect(connect!.corpo).toMatchObject({
        to: TELEFONE,
        session: { sdp_type: 'offer', sdp: OFERTA_FEITA },
        biz_opaque_callback_data: criada.body.id,
      });
      // A permissão foi conferida na Meta antes (GET call_permissions).
      expect(
        graph.pedidos.some(
          (p) =>
            p.metodo === 'GET' &&
            p.caminho.includes(`call_permissions?user_wa_id=${TELEFONE}`),
        ),
      ).toBe(true);
      const idMeta = 'wacid.FEITA1';
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({ idMeta });

      const resposta = esperarEvento(socketAna, 'ligacao.resposta_sdp');
      await entregar(respostaSdpDaMeta(idMeta, criada.body.id));
      expect(await resposta).toEqual({
        ligacaoId: criada.body.id,
        sdp: RESPOSTA_DA_META,
      });
      // Quem recarrega a página recebe a resposta SDP pelo detalhe.
      expect(
        (await ana.get(`/api/v1/ligacoes/${criada.body.id}`).expect(200)).body
          .respostaSdp,
      ).toBe(RESPOSTA_DA_META);

      const tocando = esperarEvento(socketAna, 'ligacao.estado');
      await entregar(statusDeChamada(idMeta, 'RINGING'));
      expect(await tocando).toMatchObject({ estado: 'TOCANDO' });
      const aceita = esperarEvento(socketAna, 'ligacao.estado');
      await entregar(statusDeChamada(idMeta, 'ACCEPTED'));
      expect(await aceita).toMatchObject({ estado: 'EM_ANDAMENTO' });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({
        respostaSdp: null,
        ofertaSdp: null,
      });

      await ana.post(`/api/v1/ligacoes/${criada.body.id}/encerrar`).expect(200);
      expect(chamadasNaMeta('terminate')).toHaveLength(1);
      await entregar(
        terminar(idMeta, { direcao: 'BUSINESS_INITIATED', duracao: 90 }),
      );
      const fim = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: criada.body.id },
      });
      expect(fim).toMatchObject({
        estado: 'ENCERRADA',
        duracaoSegundos: 90,
        motivo: 'encerrada_pelo_atendente',
      });
      const atividade = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: fim.atividadeId! },
      });
      expect(atividade).toMatchObject({
        tipo: 'LIGACAO',
        status: 'CONCLUIDA',
        contatoId: contato.id,
      });
      expect(atividade.titulo).toBe('Ligação feita para Maria da Silva');
      // Atendida: o cliente atendeu uma ligação nossa e a janela de 24 h abriu (conversa criada).
      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { contatoId: contato.id, canalId },
      });
      expect(conversa.janelaAte!.getTime()).toBeGreaterThan(
        Date.now() + 23 * 3_600_000,
      );
      expect(
        (
          await t.prisma.mensagem.findFirstOrThrow({
            where: { conversaId: conversa.id, direcao: 'SISTEMA' },
          })
        ).texto,
      ).toContain('Ligação feita por');
    });

    it('cenário 213 — R29.3 — a permissão expirou na Meta (ela não avisa): o CRM confere antes de ligar e atualiza o registro', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      await t.prisma.permissaoDeLigacao.create({
        data: {
          canalId,
          contatoId: contato.id,
          situacao: 'CONCEDIDA',
          tipo: 'TEMPORARIA',
          validaAte: new Date(Date.now() + 86_400_000),
        },
      });
      // O registro local diz "concedida", mas a Meta diz que não há mais permissão.
      const resposta = await pedidoDeLigacao(contato.id).expect(422);
      expect(resposta.body.detalhes.motivo).toBe('sem_permissao');
      expect(
        await t.prisma.permissaoDeLigacao.findUniqueOrThrow({
          where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        }),
      ).toMatchObject({ situacao: 'NENHUMA', tipo: null });
    });

    it('cenário 214 — R29.3 — limite de ligações feitas lido da Meta: 422 com quando libera', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      const libera = Math.floor(Date.now() / 1000) + 7200;
      graph.estado.permissoes.set(TELEFONE, {
        status: 'permanent',
        ligarPode: false,
        ligarLibera: libera,
      });
      const resposta = await pedidoDeLigacao(contato.id).expect(422);
      expect(resposta.body.detalhes).toMatchObject({
        motivo: 'limite_diario',
        liberaEm: new Date(libera * 1000).toISOString(),
      });
      expect(chamadasNaMeta('connect')).toHaveLength(0);
    });

    it('cenário 215 — R29.3 — a Meta recusa o connect (138006): ligação FALHOU, motivo em português; e o cliente recusa/não atende', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      graph.estado.falhas.set('connect', {
        status: 401,
        erro: { message: 'no perm', code: 138006 },
      });
      const resposta = await pedidoDeLigacao(contato.id).expect(422);
      expect(resposta.body).toMatchObject({
        detalhes: { motivo: 'sem_permissao', codigoDaMeta: 138006 },
      });
      expect(await t.prisma.ligacao.findFirstOrThrow()).toMatchObject({
        estado: 'FALHOU',
        motivo: 'falha_ao_ligar',
        erroCodigo: 138006,
      });

      // Cliente recusa.
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      const idMeta = (
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        })
      ).idMeta!;
      await entregar(statusDeChamada(idMeta, 'RINGING'));
      await entregar(statusDeChamada(idMeta, 'REJECTED'));
      await entregar(terminar(idMeta, { direcao: 'BUSINESS_INITIATED' }));
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({
        estado: 'RECUSADA',
        motivo: 'recusada_pelo_cliente',
      });
      // Cliente não atende (terminate COMPLETED sem duração).
      const outra = await pedidoDeLigacao(contato.id).expect(201);
      const idOutra = (
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: outra.body.id },
        })
      ).idMeta!;
      await entregar(statusDeChamada(idOutra, 'RINGING'));
      await entregar(terminar(idOutra, { direcao: 'BUSINESS_INITIATED' }));
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: outra.body.id },
        }),
      ).toMatchObject({
        estado: 'SEM_RESPOSTA',
        motivo: 'sem_resposta',
      });
    });

    it('cenário 216 — R29.3 — cancelar enquanto chama: terminate na Meta e SEM_RESPOSTA (cancelada pelo atendente); e o botão desligado bloqueia', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      await ana.post(`/api/v1/ligacoes/${criada.body.id}/encerrar`).expect(200);
      expect(chamadasNaMeta('terminate')).toHaveLength(1);
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({
        estado: 'SEM_RESPOSTA',
        motivo: 'cancelada_pelo_atendente',
      });
      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canalId}/ligacoes`, {
          botaoVisivel: false,
        })
        .expect(200);
      const bloqueada = await pedidoDeLigacao(contato.id).expect(422);
      expect(bloqueada.body.detalhes.motivo).toBe('botao_desligado');
    });

    it('cenário 217 — R29.3 — uma ligação por atendente e por cliente: ligar de novo é 409', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      const outro = await criarContato(t, {
        nome: 'João',
        telefone: '5511966665555',
      });
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      graph.estado.permissoes.set('5511966665555', { status: 'permanent' });
      await pedidoDeLigacao(contato.id).expect(201);
      const mesmo = await bruno
        .post('/api/v1/ligacoes', { contatoId: contato.id, sdp: OFERTA_FEITA })
        .expect(409);
      expect(mesmo.body.detalhes.motivo).toBe('ligacao_duplicada');
      const ja = await pedidoDeLigacao(outro.id).expect(409);
      expect(ja.body.detalhes.motivo).toBe('ja_em_ligacao');
      // Contato sem WhatsApp não liga.
      const semTelefone = await criarContato(t, { nome: 'Sem fone' });
      await bruno
        .post('/api/v1/ligacoes', {
          contatoId: semTelefone.id,
          sdp: OFERTA_FEITA,
        })
        .expect(422);
    });

    it('cenário 218 — R29.3 — ligação feita a partir de uma atividade de ligação: concluída se atendida', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      const atividade = await t.prisma.atividade.create({
        data: {
          tipo: 'LIGACAO',
          titulo: 'Ligar para a Maria',
          responsavelId: cenario.comercial.membros[0]!.id,
          contatoId: contato.id,
        },
      });
      const criada = await pedidoDeLigacao(contato.id, {
        atividadeId: atividade.id,
      }).expect(201);
      const idMeta = (
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        })
      ).idMeta!;
      await entregar(statusDeChamada(idMeta, 'ACCEPTED'));
      await entregar(
        terminar(idMeta, { direcao: 'BUSINESS_INITIATED', duracao: 20 }),
      );
      const depois = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: atividade.id },
      });
      expect(depois).toMatchObject({
        status: 'CONCLUIDA',
        concluidaPorId: cenario.comercial.membros[0]!.id,
      });
      expect(depois.descricao).toContain('Duração: 0:20');
      expect(
        await t.prisma.atividade.count({ where: { tipo: 'LIGACAO' } }),
      ).toBe(1);
    });

    it('cenário 219 — R29.4 — pedido de permissão dentro da janela: mensagem interativa; a resposta do cliente atualiza o registro', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      // Janela aberta: uma ligação perdida (ou mensagem) acabou de chegar.
      await entregar(connectRecebido('wacid.P0', { sdp: OFERTA }));
      graph.pedidos.length = 0;
      const pedido = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', {
          contatoId: contato.id,
          texto: 'Posso ligar?',
        })
        .expect(200);
      expect(pedido.body).toMatchObject({
        situacao: 'PEDIDA',
        janelaAberta: true,
        pedido: { pode: false, motivo: 'limite_24h', usoNas24h: 1 },
      });
      const [envio] = graph.pedidos.filter(
        (p) => p.caminho === `/v24.0/${NUMERO_ID}/messages`,
      );
      expect(envio!.corpo).toMatchObject({
        to: TELEFONE,
        type: 'interactive',
        interactive: {
          type: 'call_permission_request',
          body: { text: 'Posso ligar?' },
        },
      });
      const expira = Math.floor(Date.now() / 1000) + 7 * 86_400;
      await entregar(respostaDePermissao({ id: 'wamid.RESP1', expira }));
      const registro = await t.prisma.permissaoDeLigacao.findUniqueOrThrow({
        where: { canalId_contatoId: { canalId, contatoId: contato.id } },
      });
      expect(registro).toMatchObject({
        situacao: 'CONCEDIDA',
        tipo: 'TEMPORARIA',
      });
      expect(registro.validaAte!.getTime()).toBe(expira * 1000);
      // A resposta não virou mensagem do cliente; virou aviso na conversa.
      expect(
        await t.prisma.mensagem.count({ where: { direcao: 'ENTRADA' } }),
      ).toBe(0);
      expect(
        (await t.prisma.mensagem.findMany({ where: { direcao: 'SISTEMA' } }))
          .map((m) => m.texto)
          .join('|'),
      ).toContain('autorizou ligações');
      // Resposta repetida não duplica o aviso.
      const avisos = await t.prisma.mensagem.count({
        where: { direcao: 'SISTEMA' },
      });
      await entregar(respostaDePermissao({ id: 'wamid.RESP1', expira }));
      expect(
        await t.prisma.mensagem.count({ where: { direcao: 'SISTEMA' } }),
      ).toBe(avisos);
      const situacao = await ana
        .get(`/api/v1/ligacoes/permissoes?contatoId=${contato.id}`)
        .expect(200);
      expect(situacao.body).toMatchObject({
        situacao: 'CONCEDIDA',
        tipo: 'TEMPORARIA',
        podeLigar: true,
      });

      // Permanente e recusa.
      await entregar(
        respostaDePermissao({ id: 'wamid.RESP2', permanente: true }),
      );
      expect(
        await t.prisma.permissaoDeLigacao.findUniqueOrThrow({
          where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        }),
      ).toMatchObject({ tipo: 'PERMANENTE', validaAte: null });
      await entregar(
        respostaDePermissao({ id: 'wamid.RESP3', resposta: 'reject' }),
      );
      expect(
        (
          await ana
            .get(`/api/v1/ligacoes/permissoes?contatoId=${contato.id}`)
            .expect(200)
        ).body,
      ).toMatchObject({ situacao: 'NEGADA', podeLigar: false });
    });

    it('cenário 232 — R29.4 — os status (enviada, entregue, lida) do pedido de permissão são reconhecidos, sem job em erro', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      await entregar(connectRecebido('wacid.P232', { sdp: OFERTA }));
      await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(200);
      const registro = await t.prisma.permissaoDeLigacao.findUniqueOrThrow({
        where: { canalId_contatoId: { canalId, contatoId: contato.id } },
      });
      for (const status of ['sent', 'delivered', 'read']) {
        await entregar(
          envelope('messages', {
            statuses: [
              {
                id: registro.ultimoPedidoMensagemId,
                status,
                timestamp: agoraEmSegundos(),
                recipient_id: TELEFONE,
              },
            ],
          }),
        );
      }
      expect(
        await t.prisma.$queryRaw<{ n: bigint }[]>`
          select count(*)::bigint as n from pgboss.job
          where name = 'whatsapp-oficial.webhook' and state in ('retry', 'failed')`,
      ).toEqual([{ n: 0n }]);
    });

    it('cenário 220 — R29.4 — fora da janela: template com o componente de permissão; sem template, 422', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      const pedido = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(200);
      expect(pedido.body).toMatchObject({
        situacao: 'PEDIDA',
        janelaAberta: false,
      });
      const [envio] = graph.pedidos.filter(
        (p) => p.caminho === `/v24.0/${NUMERO_ID}/messages`,
      );
      expect(envio!.corpo).toMatchObject({
        type: 'template',
        template: {
          name: 'pedido_de_permissao',
          language: { code: 'pt_BR' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
          ],
        },
      });
      // Sem template aprovado com o componente.
      graph.estado.templates = [];
      await admin
        .post(
          `/api/v1/whatsapp-oficial/canais/${canalId}/templates/sincronizar`,
        )
        .expect(200);
      const outro = await criarContato(t, {
        nome: 'João',
        telefone: '5511966665555',
      });
      const sem = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: outro.id })
        .expect(422);
      expect(sem.body.detalhes.motivo).toBe('sem_template_de_permissao');
    });

    it('cenário 221 — R29.4 — limites de pedido: 1 por 24 h e 2 por 7 dias por cliente (e o que a Meta informar)', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(200);
      const segundo = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(422);
      expect(segundo.body.detalhes).toMatchObject({
        motivo: 'limite_de_pedidos',
        limite: 'limite_24h',
        origem: 'crm',
      });
      expect(segundo.body.detalhes.liberaEm).toBeTruthy();
      // Passadas 24 h, o segundo pedido da semana passa; o terceiro, não.
      const registro = () =>
        t.prisma.permissaoDeLigacao.findUniqueOrThrow({
          where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        });
      await t.prisma.permissaoDeLigacao.update({
        where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        data: { pedidosEm: [new Date(Date.now() - 30 * 3_600_000)] },
      });
      await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(200);
      expect((await registro()).pedidosEm).toHaveLength(2);
      await t.prisma.permissaoDeLigacao.update({
        where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        data: {
          pedidosEm: [
            new Date(Date.now() - 30 * 3_600_000),
            new Date(Date.now() - 50 * 3_600_000),
          ],
        },
      });
      const terceiro = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: contato.id })
        .expect(422);
      expect(terceiro.body.detalhes).toMatchObject({
        limite: 'limite_7d',
        origem: 'crm',
      });
      const dto = await ana
        .get(`/api/v1/ligacoes/permissoes?contatoId=${contato.id}`)
        .expect(200);
      expect(dto.body.pedido).toMatchObject({
        pode: false,
        motivo: 'limite_7d',
        usoNos7d: 2,
        maximo7d: 2,
      });
      // A Meta também pode barrar (can_perform_action=false), mesmo que o CRM ache que dá.
      const outro = await criarContato(t, {
        nome: 'João',
        telefone: '5511966665555',
      });
      graph.estado.permissoes.set('5511966665555', {
        status: 'no_permission',
        pedirPode: false,
      });
      const daMeta = await ana
        .post('/api/v1/ligacoes/permissoes/pedir', { contatoId: outro.id })
        .expect(422);
      expect(daMeta.body.detalhes).toMatchObject({
        motivo: 'limite_de_pedidos',
        origem: 'meta',
      });
      // Permissão que já existe na Meta: 409 e o registro é atualizado.
      const terceiroContato = await criarContato(t, {
        nome: 'Joana',
        telefone: '5511955554444',
      });
      graph.estado.permissoes.set('5511955554444', { status: 'permanent' });
      await ana
        .post('/api/v1/ligacoes/permissoes/pedir', {
          contatoId: terceiroContato.id,
        })
        .expect(409);
      expect(
        (
          await ana
            .get(
              `/api/v1/ligacoes/permissoes?contatoId=${terceiroContato.id}&atualizar=true`,
            )
            .expect(200)
        ).body,
      ).toMatchObject({
        situacao: 'CONCEDIDA',
        tipo: 'PERMANENTE',
        podeLigar: true,
      });
    });

    it('cenário 222 — R29.4 — 4 ligações seguidas sem resposta revogam a permissão (refletido no registro); atender zera a contagem', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      await t.prisma.permissaoDeLigacao.create({
        data: {
          canalId,
          contatoId: contato.id,
          situacao: 'CONCEDIDA',
          tipo: 'PERMANENTE',
        },
      });
      const semResposta = async () => {
        const criada = await pedidoDeLigacao(contato.id).expect(201);
        const idMeta = (
          await t.prisma.ligacao.findUniqueOrThrow({
            where: { id: criada.body.id },
          })
        ).idMeta!;
        await entregar(statusDeChamada(idMeta, 'RINGING'));
        await entregar(terminar(idMeta, { direcao: 'BUSINESS_INITIATED' }));
      };
      const registro = () =>
        t.prisma.permissaoDeLigacao.findUniqueOrThrow({
          where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        });
      for (let i = 0; i < 3; i++) await semResposta();
      expect(await registro()).toMatchObject({
        semRespostaSeguidas: 3,
        situacao: 'CONCEDIDA',
      });
      await semResposta();
      expect(await registro()).toMatchObject({
        semRespostaSeguidas: 4,
        situacao: 'REVOGADA',
        tipo: null,
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'ligacao.permissao_revogada' },
        }),
      ).toBe(1);
      // Com a permissão de volta e uma ligação atendida, a contagem zera.
      await t.prisma.permissaoDeLigacao.update({
        where: { canalId_contatoId: { canalId, contatoId: contato.id } },
        data: {
          situacao: 'CONCEDIDA',
          tipo: 'PERMANENTE',
          semRespostaSeguidas: 3,
        },
      });
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      const idMeta = (
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        })
      ).idMeta!;
      await entregar(statusDeChamada(idMeta, 'ACCEPTED'));
      expect(await registro()).toMatchObject({ semRespostaSeguidas: 0 });
    });

    it('cenário 223 — R29.3 — vigia: ligação feita presa em CHAMANDO é fechada (terminate + FALHOU)', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      const criada = await pedidoDeLigacao(contato.id).expect(201);
      expect(await t.fila.listarTrabalhos(FILA_VIGIAR_LIGACAO)).toHaveLength(1);
      await drenarFilas(t, FILA_VIGIAR_LIGACAO, { incluirAgendados: true });
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        }),
      ).toMatchObject({
        estado: 'FALHOU',
        motivo: 'sem_resposta_da_meta',
      });
      expect(chamadasNaMeta('terminate')).toHaveLength(1);
    });
  });

  describe('R29.2 — webhooks repetidos, fora de ordem e atrasados', () => {
    it('cenário 224 — R29.2 — connect repetido (reentrega da Meta) não duplica a ligação nem o toque', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      const corpo = connectRecebido('wacid.D1');
      await entregar(corpo);
      await tocando;
      const repetido = semEvento(socketAna, 'ligacao.tocando', 500);
      await entregar(corpo);
      await entregar(corpo);
      await repetido;
      expect(await t.prisma.ligacao.count()).toBe(1);
      expect(
        await t.prisma.notificacao.count({
          where: { tipo: 'ligacao.tocando' },
        }),
      ).toBe(1);
      expect(await t.prisma.ligacaoWebhookEvento.count()).toBe(1);
    });

    it('cenário 225 — R29.2 — terminate repetido e status repetido não mudam nada; RINGING depois de ACCEPTED não regride', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      const criada = await ana
        .post('/api/v1/ligacoes', {
          contatoId: contato.id,
          sdp: OFERTA_DO_BROWSER,
        })
        .expect(201);
      const idMeta = (
        await t.prisma.ligacao.findUniqueOrThrow({
          where: { id: criada.body.id },
        })
      ).idMeta!;
      await entregar(statusDeChamada(idMeta, 'ACCEPTED'));
      await entregar(statusDeChamada(idMeta, 'RINGING'));
      expect((await ligacaoPorMeta(idMeta)).estado).toBe('EM_ANDAMENTO');
      const terminate = terminar(idMeta, {
        direcao: 'BUSINESS_INITIATED',
        duracao: 15,
      });
      await entregar(terminate);
      await entregar(terminate);
      const fim = await ligacaoPorMeta(idMeta);
      expect(fim).toMatchObject({ estado: 'ENCERRADA', duracaoSegundos: 15 });
      // Status atrasado depois do fim, e um terminate "falho" tardio: nada regride.
      await entregar(statusDeChamada(idMeta, 'RINGING'));
      await entregar(statusDeChamada(idMeta, 'REJECTED'));
      await entregar(
        terminar(idMeta, { direcao: 'BUSINESS_INITIATED', status: 'FAILED' }),
      );
      expect(await ligacaoPorMeta(idMeta)).toMatchObject({
        estado: 'ENCERRADA',
        motivo: fim.motivo,
      });
      expect(
        await t.prisma.atividade.count({ where: { tipo: 'LIGACAO' } }),
      ).toBe(1);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'ligacao.encerrada' },
        }),
      ).toBe(1);
    });

    it('cenário 226 — R29.2 — terminate que chega antes do connect espera a ligação existir (o job tenta de novo)', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      await conectar(bruno);
      // O terminate chega primeiro: o job falha e fica para tentar de novo.
      await postarWebhook(terminar('wacid.D2')).expect(200);
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);
      expect(await t.prisma.ligacao.count()).toBe(0);
      expect(await t.prisma.ligacaoWebhookEvento.count()).toBe(0);
      const tocando = esperarEvento(socketAna, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.D2'));
      await tocando;
      expect((await ligacaoPorMeta('wacid.D2')).estado).toBe('TOCANDO');
      // A retentativa do terminate aplica o desligamento do cliente.
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL, {
        incluirAgendados: true,
      });
      expect((await ligacaoPorMeta('wacid.D2')).estado).toBe('PERDIDA');
    });

    it('cenário 227 — R29.2 — connect atrasado (a Meta já desistiu): PERDIDA "atrasada", sem toque e sem reject', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const semToque = semEvento(socketAna, 'ligacao.tocando', 400);
      await entregar(
        connectRecebido('wacid.D3', { timestamp: agoraEmSegundos(-120) }),
      );
      await semToque;
      expect(await ligacaoPorMeta('wacid.D3')).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'atrasada',
      });
      expect(chamadasNaMeta('reject')).toHaveLength(0);
    });

    it('cenário 228 — R29.2 — o webhook de calls só vale assinado com o app secret do canal; as chaves de dedupe vencem em 7 dias', async () => {
      await ativarLigacoes();
      await postarWebhook(
        connectRecebido('wacid.D4'),
        'segredo-de-outro-app',
      ).expect(401);
      await entregar(connectRecebido('wacid.D5', { de: '5511977776666' }));
      expect(await t.prisma.ligacao.count()).toBe(1);
      await t.prisma.ligacaoWebhookEvento.updateMany({
        data: { recebidoEm: new Date(Date.now() - 8 * 86_400_000) },
      });
      await entregar(statusDeChamada('wacid.D5', 'RINGING')).catch(
        () => undefined,
      );
      const removidas = await t.get(WebhookDeLigacoesService).limparChaves();
      expect(removidas).toBeGreaterThanOrEqual(1);
      expect(
        await t.prisma.ligacaoWebhookEvento.count({
          where: { recebidoEm: { lt: new Date(Date.now() - 7 * 86_400_000) } },
        }),
      ).toBe(0);
    });
  });

  describe('R29.2 — sobras: recusar, corrida cancelar x atender e espera curta', () => {
    it('cenário 271 — R29.2 — recusar: some só para quem recusou; quando todos recusam, reject na Meta na hora e PERDIDA', async () => {
      await ativarLigacoes();
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { estrategia: 'MANUAL' },
      });
      const socketAna = await conectar(ana);
      const socketBruno = await conectar(bruno);
      const tocandoAna = esperarEvento(socketAna, 'ligacao.tocando');
      const tocandoBruno = esperarEvento(socketBruno, 'ligacao.tocando');
      await entregar(connectRecebido('wacid.REC1', { de: '5511977776666' }));
      const { ligacaoId } = await tocandoAna;
      await tocandoBruno;
      const deixouAna = esperarEvento(socketAna, 'ligacao.deixou_de_tocar');
      await ana.post(`/api/v1/ligacoes/${ligacaoId}/recusar`).expect(200);
      expect(await deixouAna).toMatchObject({
        ligacaoId,
        motivo: 'recusada_por_voce',
      });
      // Repetir não faz nada; Ana não vê mais a ligação tocando; ainda toca para o Bruno.
      await ana.post(`/api/v1/ligacoes/${ligacaoId}/recusar`).expect(200);
      expect(
        (await ana.get('/api/v1/ligacoes/ativas').expect(200)).body.tocando,
      ).toHaveLength(0);
      expect(
        (await bruno.get('/api/v1/ligacoes/ativas').expect(200)).body.tocando,
      ).toHaveLength(1);
      expect(chamadasNaMeta('reject')).toHaveLength(0);
      expect(
        (await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }))
          .estado,
      ).toBe('TOCANDO');
      // Quem não foi chamado não recusa.
      const marketing = await entrarComo(t, cenario.marketing);
      await marketing.post(`/api/v1/ligacoes/${ligacaoId}/recusar`).expect(403);
      // O último recusa: rejeita na Meta já e a ligação vira PERDIDA.
      const deixouBruno = esperarEvento(socketBruno, 'ligacao.deixou_de_tocar');
      await bruno.post(`/api/v1/ligacoes/${ligacaoId}/recusar`).expect(200);
      expect(await deixouBruno).toMatchObject({ motivo: 'recusada_por_todos' });
      expect(chamadasNaMeta('reject')).toHaveLength(1);
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        estado: 'PERDIDA',
        motivo: 'recusada_pelos_atendentes',
        duracaoSegundos: 0,
      });
      // Terminada: recusar de novo é 409.
      await ana.post(`/api/v1/ligacoes/${ligacaoId}/recusar`).expect(409);
    });

    it('cenário 272 — R29.1 — corrida cancelar x atender: o terminate com duração que chega depois do cancelamento não dá duração à SEM_RESPOSTA', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      graph.estado.permissoes.set(TELEFONE, { status: 'permanent' });
      const criada = await ana
        .post('/api/v1/ligacoes', {
          contatoId: contato.id,
          sdp: OFERTA_DO_BROWSER,
        })
        .expect(201);
      const ligacao = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: criada.body.id },
      });
      await ana.post(`/api/v1/ligacoes/${criada.body.id}/encerrar`).expect(200);
      expect(
        (
          await t.prisma.ligacao.findUniqueOrThrow({
            where: { id: ligacao.id },
          })
        ).estado,
      ).toBe('SEM_RESPOSTA');
      // O cliente tinha atendido um instante antes: a Meta fecha com duração.
      await entregar(
        terminar(ligacao.idMeta!, {
          direcao: 'BUSINESS_INITIATED',
          duracao: 7,
        }),
      );
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacao.id } }),
      ).toMatchObject({
        estado: 'SEM_RESPOSTA',
        duracaoSegundos: 0,
        atendidaEm: null,
      });
    });

    it('cenário 273 — R29.2 — status RINGING que chega antes de o POST gravar o id da Meta espera um instante e é aplicado sem retentativa do job', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria();
      const ligacao = await t.prisma.ligacao.create({
        data: {
          canalId,
          contatoId: contato.id,
          direcao: 'FEITA',
          estado: 'CHAMANDO',
          atendenteId: cenario.comercial.membros[0]!.id,
          telefone: TELEFONE,
        },
      });
      await postarWebhook(statusDeChamada('wacid.CRIANDO', 'RINGING')).expect(
        200,
      );
      const gravar = new Promise<void>((resolver) =>
        setTimeout(() => {
          void t.prisma.ligacao
            .update({
              where: { id: ligacao.id },
              data: { idMeta: 'wacid.CRIANDO' },
            })
            .then(() => resolver());
        }, 500),
      );
      await drenarFilas(t, FILA_WEBHOOK_WHATSAPP_OFICIAL);
      await gravar;
      expect(
        (
          await t.prisma.ligacao.findUniqueOrThrow({
            where: { id: ligacao.id },
          })
        ).estado,
      ).toBe('TOCANDO');
      expect(await t.prisma.ligacaoWebhookEvento.count()).toBe(1);
    });
  });

  describe('R29 — histórico e acesso', () => {
    it('cenário 229 — R29.2 — o histórico respeita a visibilidade do Atendimento (R12)', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const ligacaoId = await receberEAtender('wacid.H1', ana, socketAna);
      await entregar(terminar('wacid.H1', { duracao: 10 }));
      expect(
        (await ana.get(`/api/v1/ligacoes/${ligacaoId}`).expect(200)).body,
      ).toMatchObject({
        estado: 'ENCERRADA',
        contato: { id: contato.id },
        motivoTexto: 'Encerrada pelo cliente.',
      });
      // O líder da área vê (a conversa é da fila dele); outra área não.
      const lider = await entrarComo(t, cenario.comercial.lider);
      await lider.get(`/api/v1/ligacoes/${ligacaoId}`).expect(200);
      const cs = await entrarComo(t, cenario.cs.membros[0]!);
      await cs.get(`/api/v1/ligacoes/${ligacaoId}`).expect(404);
      expect(
        (await cs.get(`/api/v1/ligacoes?contatoId=${contato.id}`).expect(200))
          .body.itens,
      ).toHaveLength(0);
      await admin.get(`/api/v1/ligacoes/${ligacaoId}`).expect(200);
      expect(
        (await ana.get('/api/v1/ligacoes/configuracao-webrtc').expect(200))
          .body,
      ).toEqual({ stunUrls: [] });
      expect(
        (await ana.get('/api/v1/ligacoes/canais').expect(200)).body,
      ).toEqual([
        { id: canalId, nome: 'WhatsApp oficial', botaoVisivel: true },
      ]);
    });

    it('cenário 231 — R29.8 — a anonimização do contato (LGPD, R4.6) limpa telefone, anotação e permissão das ligações e mantém o registro', async () => {
      await ativarLigacoes();
      const contato = await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      const ligacaoId = await receberEAtender('wacid.H3', ana, socketAna);
      await ana
        .patch(`/api/v1/ligacoes/${ligacaoId}`, { anotacao: 'CPF 123' })
        .expect(200);
      await entregar(terminar('wacid.H3', { duracao: 12 }));
      await t.prisma.permissaoDeLigacao.create({
        data: {
          canalId,
          contatoId: contato.id,
          situacao: 'CONCEDIDA',
          tipo: 'PERMANENTE',
        },
      });
      await admin
        .post(`/api/v1/contatos/${contato.id}/anonimizar`, {})
        .expect(204);
      expect(
        await t.prisma.ligacao.findUniqueOrThrow({ where: { id: ligacaoId } }),
      ).toMatchObject({
        telefone: null,
        anotacao: null,
        estado: 'ENCERRADA',
        duracaoSegundos: 12,
      });
      expect(await t.prisma.permissaoDeLigacao.count()).toBe(0);
    });

    it('cenário 230 — R29 — o processamento completo termina sem jobs pendentes de erro (drenar tudo)', async () => {
      await ativarLigacoes();
      await contatoDaMaria(cenario.comercial.membros[0]!);
      const socketAna = await conectar(ana);
      await receberEAtender('wacid.H2', ana, socketAna);
      await entregar(terminar('wacid.H2', { duracao: 5 }));
      await drenarTudo(t);
      const logs = await t.prisma.logTecnico.count({
        where: { nivel: 'ERRO' },
      });
      expect(logs).toBe(0);
    });
  });
});
