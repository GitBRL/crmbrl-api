import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import {
  AGRADECIMENTO_DA_AVALIACAO,
  PERGUNTA_PADRAO_DA_PESQUISA,
} from '../src/atendimento/satisfacao';
import {
  marcarMencao,
  marcarReferencia,
} from '../src/chat-interno/regras-chat';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarCanalWhatsapp,
  criarEquipe,
  criarGatewayTeste,
  criarUsuario,
  drenarEventosDoGateway,
  drenarFilas,
  entrarComo,
  esperarEvento,
  fecharSockets,
  type GatewayTeste,
  processarEventos,
  type SocketDeTeste,
} from './utils';

const ATENDIMENTO = '/api/v1/atendimento';

/**
 * Integração da Onda A: o que só aparece com os módulos juntos — gateway de
 * WhatsApp (simulado), Atendimento, tempo real, funis e chat interno.
 */
describe('Integração da Onda A (e2e)', () => {
  let t: AppTeste;
  let gateway: GatewayTeste;
  const abertos: SocketDeTeste[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    gateway = await criarGatewayTeste(t);
  });
  afterEach(async () => {
    fecharSockets(...abertos.splice(0));
    await gateway.fechar();
  });
  afterAll(() => t.fechar());

  /** Os envios do Atendimento → fila do número → gateway → status de volta na API. */
  async function entregarPeloWhatsapp(numeroId: string): Promise<void> {
    await drenarFilas(t, FILA_ENVIO_ATENDIMENTO);
    await gateway.drenarEnvios(numeroId);
    await gateway.gerenciador.aguardarAvisos(numeroId);
    await new Promise((resolver) => setTimeout(resolver, 50));
    await gateway.gerenciador.aguardarAvisos(numeroId);
    await drenarEventosDoGateway(t);
  }

  /** O contato escreve pelo WhatsApp (simulador do gateway) e a API processa. */
  async function contatoEscreve(
    numeroId: string,
    de: string,
    texto: string,
    nome?: string,
  ): Promise<void> {
    await gateway
      .pedir('post', '/simulador/receber', { numeroId, de, texto, nome })
      .expect(202);
    await drenarEventosDoGateway(t);
  }

  it('cenário 33 — jornada do atendimento: WhatsApp simulado → conversa distribuída e avisada ao vivo → resposta rápida até LIDA → negócio citado no chat → nota 5 → métricas', async () => {
    // Equipe comercial (C-level → líder → 2 membros) e o Admin.
    const admin = await criarUsuario(t, { papel: 'ADMIN' });
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const [ana, bruno] = comercial.membros;
    const clienteLider = await entrarComo(t, comercial.lider);
    const clienteAdmin = await entrarComo(t, admin);

    // O líder cria a fila da área, com SLA e rodízio (R12.1).
    const fila = await clienteLider
      .post(`${ATENDIMENTO}/filas`, {
        nome: 'Comercial — WhatsApp',
        area: 'COMERCIAL',
        estrategia: 'RODIZIO',
        slaPrimeiraRespostaMinutos: 15,
        slaResolucaoMinutos: 240,
      })
      .expect(201);

    // Número de WhatsApp (gateway simulado) ligado à fila, com a pesquisa de satisfação.
    const { canal, numero } = await criarCanalWhatsapp(t, {
      nome: 'WhatsApp Comercial',
    });
    // Sem a espera entre envios e o "digitando…" (R13.6), para o teste não esperar segundos.
    await t.prisma.whatsappNumero.update({
      where: { id: numero.id },
      data: {
        intervaloMinimoSegundos: 0,
        intervaloMaximoSegundos: 0,
        configuracao: { digitando: false },
      },
    });
    await clienteAdmin
      .patch(`${ATENDIMENTO}/canais/${canal.id}`, {
        filaPadraoId: fila.body.id,
        pesquisaSatisfacao: true,
      })
      .expect(200);
    await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    await drenarEventosDoGateway(t);

    // As duas pessoas da fila estão no CRM, com o tempo real ligado.
    const clienteAna = await entrarComo(t, ana);
    const clienteBruno = await entrarComo(t, bruno);
    const socketAna = await conectarTempoReal(t, clienteAna);
    const socketBruno = await conectarTempoReal(t, clienteBruno);
    abertos.push(socketAna, socketBruno);
    const novaAna = esperarEvento(socketAna, 'conversa.nova');
    const novaBruno = esperarEvento(socketBruno, 'conversa.nova');

    // Dois contatos escrevem: o rodízio alterna entre Ana e Bruno (R12.4).
    await contatoEscreve(
      numero.id,
      '11 97777-1234',
      'Olá! Quero saber do plano anual.',
      'Bianca Prado',
    );
    await contatoEscreve(numero.id, '11 96666-4321', 'Bom dia', 'Caio Nunes');
    await processarEventos(t);
    const [conversaBianca, conversaCaio] = await Promise.all(
      ['5511977771234', '5511966664321'].map((telefone) =>
        t.prisma.conversa.findFirstOrThrow({
          where: { canalId: canal.id, contato: { telefone } },
          include: { contato: true },
        }),
      ),
    );
    expect(conversaBianca).toMatchObject({
      filaId: fila.body.id,
      status: 'ABERTA',
      contato: { nome: 'Bianca Prado', primeiraOrigem: 'WHATSAPP' },
    });
    expect(
      new Set([conversaBianca.responsavelId, conversaCaio.responsavelId]),
    ).toEqual(new Set([ana.id, bruno.id]));
    expect(conversaBianca.slaPrimeiraRespostaAte).not.toBeNull();

    // Quem recebeu a conversa da Bianca foi avisado ao vivo e notificado.
    const atendente = conversaBianca.responsavelId === ana.id ? ana : bruno;
    const clienteAtendente =
      atendente.id === ana.id ? clienteAna : clienteBruno;
    const nova = await (atendente.id === ana.id ? novaAna : novaBruno);
    expect(nova.conversa).toMatchObject({ id: expect.any(String) });
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: atendente.id, tipo: 'conversa.atribuida' },
      }),
    ).toBe(1);

    // Resposta rápida da área com variáveis, aplicada à conversa (R12.15).
    const resposta = await clienteLider
      .post(`${ATENDIMENTO}/respostas-rapidas`, {
        atalho: 'plano-anual',
        titulo: 'Plano anual',
        texto:
          'Oi, {{contato.primeiroNome}}! Sou {{usuario.primeiroNome}} e vou te ajudar com o plano anual.',
        area: 'COMERCIAL',
      })
      .expect(201);
    const aplicada = await clienteAtendente
      .post(`${ATENDIMENTO}/respostas-rapidas/${resposta.body.id}/aplicar`, {
        conversaId: conversaBianca.id,
      })
      .expect(200);
    expect(aplicada.body.texto).toBe(
      `Oi, Bianca! Sou ${atendente.nome.split(' ')[0]} e vou te ajudar com o plano anual.`,
    );

    // Quem está na conversa recebe a mensagem e os status ao vivo.
    const sala = await new Promise<unknown>((resolver) =>
      (atendente.id === ana.id ? socketAna : socketBruno).emit(
        'conversa.entrar',
        { conversaId: conversaBianca.id },
        resolver,
      ),
    );
    expect(sala).toEqual({ ok: true });
    const socketAtendente = atendente.id === ana.id ? socketAna : socketBruno;
    const lida = new Promise<void>((resolver) => {
      socketAtendente.on(
        'mensagem.status',
        (dados: { status: string; conversaId: string }) => {
          if (
            dados.conversaId === conversaBianca.id &&
            dados.status === 'LIDA'
          ) {
            resolver();
          }
        },
      );
    });

    const enviada = await clienteAtendente
      .post(`${ATENDIMENTO}/conversas/${conversaBianca.id}/mensagens`, {
        texto: aplicada.body.texto,
      })
      .expect(201);
    expect(enviada.body).toMatchObject({ status: 'PENDENTE' });
    await entregarPeloWhatsapp(numero.id);
    await processarEventos(t);
    await lida;
    const mensagem = await t.prisma.mensagem.findUniqueOrThrow({
      where: { id: enviada.body.id },
    });
    expect(mensagem).toMatchObject({ status: 'LIDA', direcao: 'SAIDA' });
    expect(mensagem.idExterno).toMatch(/^3EB0/);
    expect(
      await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaBianca.id },
      }),
    ).toMatchObject({ primeiraRespostaEm: expect.any(Date) });

    // Negócio criado da conversa (funil-base do Comercial, origem WhatsApp).
    const negocio = await clienteAtendente
      .post(`${ATENDIMENTO}/conversas/${conversaBianca.id}/negocio`, {
        valor: '4800.00',
      })
      .expect(201);
    expect(negocio.body).toMatchObject({
      contato: { id: conversaBianca.contatoId },
      funil: { area: 'COMERCIAL' },
      origem: 'WHATSAPP',
      responsavel: { id: atendente.id },
    });

    // No canal do Comercial do chat interno, o atendente avisa o líder com o negócio (R15).
    const canaisDoChat = await clienteAtendente
      .get('/api/v1/chat/canais')
      .expect(200);
    const canalDaArea = (
      canaisDoChat.body as Array<{ id: string; tipo: string; area: string }>
    ).find((item) => item.tipo === 'AREA' && item.area === 'COMERCIAL');
    expect(canalDaArea).toBeDefined();
    const recado = await clienteAtendente
      .post(`/api/v1/chat/canais/${canalDaArea!.id}/mensagens`, {
        texto: `${marcarMencao(comercial.lider.id)} a Bianca quer fechar ${marcarReferencia('negocio', negocio.body.id as string)}`,
      })
      .expect(201);
    expect(recado.body.partes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tipo: 'mencao',
          usuarioId: comercial.lider.id,
        }),
        expect.objectContaining({
          tipo: 'referencia',
          texto: 'Bianca Prado',
          referencia: expect.objectContaining({
            tipo: 'negocio',
            id: negocio.body.id,
            disponivel: true,
            link: expect.stringContaining(`negocio=${negocio.body.id}`),
          }),
        }),
      ]),
    );
    expect(
      await t.prisma.notificacao.findFirst({
        where: { usuarioId: comercial.lider.id, tipo: 'chat.mencao' },
      }),
    ).toMatchObject({
      link: `/chat/${canalDaArea!.id}?mensagem=${recado.body.id}`,
    });

    // Resolve: a pesquisa vai pelo WhatsApp; o "5" da Bianca fica na conversa resolvida (R12.13).
    await clienteAtendente
      .post(`${ATENDIMENTO}/conversas/${conversaBianca.id}/resolver`, {})
      .expect(200);
    await entregarPeloWhatsapp(numero.id);
    await contatoEscreve(numero.id, '5511977771234', '5');
    await entregarPeloWhatsapp(numero.id);
    const avaliada = await t.prisma.conversa.findUniqueOrThrow({
      where: { id: conversaBianca.id },
      include: { mensagens: { orderBy: { criadoEm: 'asc' } } },
    });
    expect(avaliada).toMatchObject({ status: 'RESOLVIDA', satisfacaoNota: 5 });
    const saidas = avaliada.mensagens.filter(
      (item) => item.direcao === 'SAIDA',
    );
    expect(saidas.map((item) => item.texto)).toEqual([
      aplicada.body.texto,
      PERGUNTA_PADRAO_DA_PESQUISA,
      AGRADECIMENTO_DA_AVALIACAO,
    ]);
    expect(saidas.every((item) => item.status === 'LIDA')).toBe(true);
    expect(
      await t.prisma.conversa.count({ where: { canalId: canal.id } }),
    ).toBe(2);

    // Métricas da área para o BI (R12.18): o líder vê a fila com a nota e a primeira resposta.
    const metricas = await clienteLider
      .get(`${ATENDIMENTO}/metricas`)
      .expect(200);
    expect(metricas.body.geral).toMatchObject({
      conversas: 2,
      respondidas: 1,
      resolvidas: 1,
      satisfacao: { respondidas: 1, media: 5, csat: 100 },
      slaPrimeiraResposta: { cumpridos: 1, estourados: 0 },
    });
    const linhaDaFila = (
      metricas.body.porFila as Array<{
        fila: { id: string };
        conversas: number;
      }>
    ).find((linha) => linha.fila.id === fila.body.id);
    expect(linhaDaFila).toMatchObject({ conversas: 2 });

    // A auditoria registrou a jornada: conversa criada, resolvida e avaliada; negócio criado.
    const acoes = (
      await t.prisma.eventoAuditoria.findMany({
        where: {
          OR: [
            { entidadeId: conversaBianca.id },
            { entidadeId: negocio.body.id as string },
          ],
        },
        select: { acao: true },
      })
    ).map(({ acao }) => acao);
    expect(acoes).toEqual(
      expect.arrayContaining([
        'conversa.criada',
        'conversa.resolvida',
        'conversa.avaliada',
        'negocio.criado',
      ]),
    );
  });
});
