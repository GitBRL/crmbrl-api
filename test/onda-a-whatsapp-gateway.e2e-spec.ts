import { AdaptadorWhatsapp } from '../src/canais/whatsapp/adaptador-whatsapp';
import {
  FILA_EVENTOS_WHATSAPP,
  filaDeEnvio,
  type PedidoDeEnvio,
} from '../src/canais/whatsapp/contrato-gateway';
import { telefoneSimulado } from '../src/whatsapp/transporte/transporte-simulado';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarCanalWhatsapp,
  criarConversa,
  criarContato,
  criarMensagem,
  criarUsuario,
  criarGatewayTeste,
  drenarEventosDoGateway,
  entrarComo,
  esperarEvento,
  fecharSockets,
  type GatewayTeste,
  PNG_DE_TESTE,
  semEvento,
  type SocketDeTeste,
} from './utils';

/**
 * Gateway de WhatsApp em modo simulado (§2.3 do contrato da Onda A): o
 * processo do gateway (`GatewayWhatsappModule`) e a API no mesmo banco de
 * teste, conversando pelo HTTP interno e pelas filas `whatsapp.evento` e
 * `whatsapp.envio.<numeroId>`.
 */
describe('WhatsApp — gateway simulado (e2e)', () => {
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

  it('HTTP interno exige o token (menos a saúde)', async () => {
    const { numero } = await criarCanalWhatsapp(t);
    await gateway
      .pedirSemToken('get', `/numeros/${numero.id}/status`)
      .expect(401);
    await gateway
      .pedirSemToken('get', `/numeros/${numero.id}/status`)
      .set('x-token-interno', 'errado')
      .expect(401);
    const saude = await gateway.pedirSemToken('get', '/saude').expect(200);
    expect(saude.body).toMatchObject({
      status: 'ok',
      simulado: true,
      banco: 'ok',
      fila: 'ok',
    });
    await gateway
      .pedir('get', '/numeros/00000000-0000-4000-8000-000000000000/status')
      .expect(404);
  });

  it('R13 — conectar: QR (data URL) e depois CONECTADO; a API avisa quem gerencia canais', async () => {
    await gateway.fechar();
    // Tempo para ver o QR antes de "conectar" (a primeira publicação cria a fila).
    gateway = await criarGatewayTeste(t, { tempos: { conexao: 2_000 } });
    const { canal, numero } = await criarCanalWhatsapp(t);
    const admin = await conectarTempoReal(
      t,
      await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' })),
    );
    const comercial = await conectarTempoReal(
      t,
      await entrarComo(t, await criarUsuario(t, { papel: 'COMERCIAL' })),
    );
    abertos.push(admin, comercial);
    const avisos: Array<{ status: string; qr?: string | null }> = [];
    admin.on(
      'whatsapp.conexao',
      (dados: { status: string; qr?: string | null }) => avisos.push(dados),
    );
    const naoGerencia = semEvento(comercial, 'whatsapp.conexao', 800);

    const resposta = await gateway
      .pedir('post', `/numeros/${numero.id}/conectar`)
      .expect(202);
    expect(resposta.body).toMatchObject({
      numeroId: numero.id,
      canalId: canal.id,
    });
    await gateway.aguardarStatus(numero.id, 'AGUARDANDO_QR');
    const estado = await gateway
      .pedir('get', `/numeros/${numero.id}/status`)
      .expect(200);
    expect(estado.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(Date.parse(estado.body.qrExpiraEm as string)).toBeGreaterThan(
      Date.now(),
    );

    let chegou = esperarEvento(admin, 'whatsapp.conexao');
    await drenarEventosDoGateway(t);
    await chegou;
    await new Promise((resolver) => setTimeout(resolver, 50));
    const comQr = avisos.find((aviso) => aviso.qr);
    expect(comQr).toMatchObject({
      status: 'AGUARDANDO_QR',
      numeroId: numero.id,
    });
    expect(comQr?.qr).toMatch(/^data:image\/png;base64,/);

    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    chegou = esperarEvento(admin, 'whatsapp.conexao');
    await drenarEventosDoGateway(t);
    await chegou;
    expect(avisos.at(-1)).toMatchObject({
      status: 'CONECTADO',
      qr: null,
      telefone: telefoneSimulado(numero.id),
    });
    await naoGerencia;

    const gravado = await t.prisma.whatsappNumero.findUniqueOrThrow({
      where: { id: numero.id },
    });
    expect(gravado).toMatchObject({
      status: 'CONECTADO',
      telefone: telefoneSimulado(numero.id),
    });
    expect(gravado.conectadoEm).not.toBeNull();
    expect(gravado.aquecimentoInicioEm).not.toBeNull();
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'whatsapp.conectado' },
      }),
    ).toBe(1);

    // Desconectar com logout apaga as chaves e marca DESCONECTADO.
    await t.prisma.whatsappChave.create({
      data: {
        numeroId: numero.id,
        tipo: 'creds',
        chaveId: '',
        valorCifrado: 'x',
      },
    });
    const desligado = await gateway
      .pedir('post', `/numeros/${numero.id}/desconectar`, { sair: true })
      .expect(200);
    expect(desligado.body).toMatchObject({ status: 'DESCONECTADO' });
    expect(await t.prisma.whatsappChave.count()).toBe(0);
  });

  it('R13 — mensagem recebida (simulador, com mídia) vira conversa e mensagem na API', async () => {
    const { canal, numero } = await criarCanalWhatsapp(t);
    await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');

    await gateway
      .pedir('post', '/simulador/receber', {
        numeroId: numero.id,
        de: '11 95555-4444',
        texto: 'Oi',
      })
      .expect(202);
    const comMidia = await gateway
      .pedir('post', '/simulador/receber', {
        numeroId: numero.id,
        de: '11955554444',
        nome: 'Paulo',
        midia: {
          base64: PNG_DE_TESTE.toString('base64'),
          nome: 'foto.png',
          mime: 'image/png',
        },
      })
      .expect(202);
    await drenarEventosDoGateway(t);

    const conversas = await t.prisma.conversa.findMany({
      where: { canalId: canal.id },
      include: {
        mensagens: { orderBy: { criadoEm: 'asc' }, include: { arquivo: true } },
        contato: true,
      },
    });
    expect(conversas).toHaveLength(1);
    expect(conversas[0]).toMatchObject({
      idExterno: '5511955554444@s.whatsapp.net',
      naoLidas: 2,
      contato: { telefone: '5511955554444', primeiraOrigem: 'WHATSAPP' },
    });
    expect(conversas[0].mensagens.map((mensagem) => mensagem.tipo)).toEqual([
      'TEXTO',
      'IMAGEM',
    ]);
    expect(conversas[0].mensagens[1]).toMatchObject({
      idExterno: comMidia.body.idExterno,
      arquivo: {
        mime: 'image/png',
        contexto: 'MENSAGEM',
        tamanho: PNG_DE_TESTE.length,
      },
    });

    // Número desconectado: o simulador recusa (409).
    await gateway
      .pedir('post', `/numeros/${numero.id}/desconectar`, {})
      .expect(200);
    await gateway
      .pedir('post', '/simulador/receber', {
        numeroId: numero.id,
        de: '11955554444',
        texto: 'oi',
      })
      .expect(409);
  });

  it('R13 — envio: adaptador põe na fila do número, o gateway envia e os status voltam até LIDA', async () => {
    const { canal, numero } = await criarCanalWhatsapp(t);
    await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    await drenarEventosDoGateway(t);

    const contato = await criarContato(t, {
      telefone: '11944443333',
      email: null,
    });
    const conversa = await criarConversa(t, {
      canal,
      contato,
      ultimaEntradaEm: new Date(),
    });
    const mensagem = await criarMensagem(t, {
      conversa,
      direcao: 'SAIDA',
      texto: 'Olá!',
    });

    const resultado = await t
      .get(AdaptadorWhatsapp)
      .enviar(mensagem, conversa, canal);
    expect(resultado).toMatchObject({ enfileirado: true });
    expect(resultado.idExterno).toMatch(/^3EB0[0-9A-F]{36}$/);
    await t.prisma.mensagem.update({
      where: { id: mensagem.id },
      data: { idExterno: resultado.idExterno },
    });
    const [job] = await t.fila.listarTrabalhos<PedidoDeEnvio>(
      filaDeEnvio(numero.id),
    );
    expect(job.dados).toMatchObject({
      mensagemId: mensagem.id,
      para: '5511944443333@s.whatsapp.net',
      respostaAoContato: true,
      idExterno: resultado.idExterno,
    });

    expect(await gateway.drenarEnvios(numero.id)).toBe(1);
    await gateway.gerenciador.aguardarAvisos(numero.id);
    await new Promise((resolver) => setTimeout(resolver, 50));
    await gateway.gerenciador.aguardarAvisos(numero.id);
    await drenarEventosDoGateway(t);
    expect(
      await t.prisma.mensagem.findUniqueOrThrow({ where: { id: mensagem.id } }),
    ).toMatchObject({ status: 'LIDA' });
    expect(await t.fila.listarTrabalhos(FILA_EVENTOS_WHATSAPP)).toHaveLength(0);
  });

  it('R13 — número sem WhatsApp: verificação responde que não existe (com cache) e o envio FALHA de vez', async () => {
    const { canal, numero } = await criarCanalWhatsapp(t);
    await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');

    const primeira = await gateway
      .pedir('post', `/numeros/${numero.id}/verificar`, {
        telefone: '11 93333-0000',
      })
      .expect(200);
    expect(primeira.body).toEqual({
      telefone: '5511933330000',
      existe: false,
      jid: null,
      doCache: false,
    });
    const segunda = await gateway
      .pedir('post', `/numeros/${numero.id}/verificar`, {
        telefone: '11933330000',
      })
      .expect(200);
    expect(segunda.body).toMatchObject({ existe: false, doCache: true });

    const contato = await criarContato(t, {
      telefone: '11933330000',
      email: null,
    });
    const conversa = await criarConversa(t, { canal, contato });
    const mensagem = await criarMensagem(t, { conversa, direcao: 'SAIDA' });
    const { idExterno } = await t
      .get(AdaptadorWhatsapp)
      .enviar(mensagem, conversa, canal);
    await t.prisma.mensagem.update({
      where: { id: mensagem.id },
      data: { idExterno },
    });
    await gateway.drenarEnvios(numero.id);
    await drenarEventosDoGateway(t);
    expect(
      await t.prisma.mensagem.findUniqueOrThrow({ where: { id: mensagem.id } }),
    ).toMatchObject({
      status: 'FALHOU',
      erro: 'Este número não tem WhatsApp.',
    });
  });

  it('ao subir, retoma os números que estavam conectados', async () => {
    const { numero } = await criarCanalWhatsapp(t, {
      status: 'CONECTADO',
      telefone: '5511922221111',
    });
    const { numero: pendente } = await criarCanalWhatsapp(t, {
      status: 'AGUARDANDO_QR',
    });
    await gateway.fechar();
    gateway = await criarGatewayTeste(t);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    expect(
      await t.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      }),
    ).toMatchObject({ telefone: '5511922221111' });
    expect(
      await t.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: pendente.id },
      }),
    ).toMatchObject({ status: 'DESCONECTADO' });
  });
});
