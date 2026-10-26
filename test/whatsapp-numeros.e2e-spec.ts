import { createServer } from 'node:net';
import { AdaptadorWhatsapp } from '../src/canais/whatsapp/adaptador-whatsapp';
import {
  filaDeEnvio,
  type PedidoDeEnvio,
} from '../src/canais/whatsapp/contrato-gateway';
import { DigitandoWhatsappService } from '../src/canais/whatsapp/digitando-whatsapp.service';
import { telefoneSimulado } from '../src/whatsapp/transporte/transporte-simulado';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarArquivo,
  criarCanalWhatsapp,
  criarContato,
  criarConversa,
  criarFila,
  criarGatewayTeste,
  criarMensagem,
  criarUsuario,
  drenarEventosDoGateway,
  entrarComo,
  esperarEvento,
  fecharSockets,
  type GatewayTeste,
  type SocketDeTeste,
} from './utils';

/** Uma porta livre de 127.0.0.1 (o gateway de teste ouve nela; a API fala com ele). */
function portaLivre(): Promise<number> {
  return new Promise((resolver, rejeitar) => {
    const servidor = createServer();
    servidor.once('error', rejeitar);
    servidor.listen(0, '127.0.0.1', () => {
      const endereco = servidor.address();
      servidor.close(() =>
        typeof endereco === 'object' && endereco
          ? resolver(endereco.port)
          : rejeitar(new Error('sem porta')),
      );
    });
  });
}

/**
 * Números de WhatsApp pela API (R13): `/api/v1/whatsapp/numeros`, com o
 * gateway simulado ouvindo de verdade numa porta (os comandos passam pelo
 * HTTP interno com o token, como no compose).
 */
describe('WhatsApp — números pela API (e2e)', () => {
  let t: AppTeste;
  let gateway: GatewayTeste;
  let porta: number;
  const abertos: SocketDeTeste[] = [];

  beforeAll(async () => {
    porta = await portaLivre();
    t = await criarAppTeste({
      variaveis: { WHATSAPP_URL_INTERNA: `http://127.0.0.1:${porta}` },
    });
  });
  beforeEach(async () => {
    await t.limparBanco();
    gateway = await criarGatewayTeste(t, { tempos: { conexao: 1_500 } });
    await gateway.app.listen(porta, '127.0.0.1');
  });
  afterEach(async () => {
    fecharSockets(...abertos.splice(0));
    await gateway.fechar();
  });
  afterAll(() => t.fechar());

  const admin = async () =>
    entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));

  it('só o Admin gerencia números', async () => {
    const comercial = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'COMERCIAL' }),
    );
    await comercial.get('/api/v1/whatsapp/numeros').expect(403);
    await comercial.post('/api/v1/whatsapp/numeros', { nome: 'X' }).expect(403);
  });

  it('cadastra, valida, edita e lista (canal WHATSAPP + configuração do número)', async () => {
    const cliente = await admin();
    const fila = await criarFila(t, { area: 'COMERCIAL' });
    const criado = await cliente
      .post('/api/v1/whatsapp/numeros', {
        nome: '  Comercial principal ',
        filaPadraoId: fila.id,
        protecoes: { digitandoMaximoSegundos: 6 },
      })
      .expect(201);
    expect(criado.body).toMatchObject({
      nome: 'Comercial principal',
      ativo: true,
      status: 'DESCONECTADO',
      telefone: null,
      filaPadrao: { id: fila.id, area: 'COMERCIAL' },
      limiteDiario: 1000,
      intervaloMinimoSegundos: 2,
      intervaloMaximoSegundos: 6,
      aquecimento: { ativo: false, dia: null, dias: 14, inicioEm: null },
      hoje: { enviados: 0, falhas: 0, limite: 1000 },
      protecoes: {
        digitando: true,
        digitandoMaximoSegundos: 6,
        verificarNumero: true,
        pausarAposFalhasSeguidas: 5,
        limitarRespostas: false,
      },
      pausa: null,
    });
    const canal = await t.prisma.canal.findUniqueOrThrow({
      where: { id: criado.body.canalId as string },
    });
    expect(canal).toMatchObject({
      tipo: 'WHATSAPP',
      nome: 'Comercial principal',
      filaPadraoId: fila.id,
    });

    // Validação: intervalo invertido, nome repetido, fila que não existe, campo desconhecido.
    const invertido = await cliente
      .post('/api/v1/whatsapp/numeros', {
        nome: 'Outro',
        intervaloMinimoSegundos: 10,
        intervaloMaximoSegundos: 5,
      })
      .expect(400);
    expect(invertido.body.detalhes.campos[0].campo).toBe(
      'intervaloMaximoSegundos',
    );
    await cliente
      .post('/api/v1/whatsapp/numeros', { nome: 'comercial PRINCIPAL' })
      .expect(409);
    await cliente
      .post('/api/v1/whatsapp/numeros', {
        nome: 'Outro',
        filaPadraoId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(400);
    await cliente
      .post('/api/v1/whatsapp/numeros', { nome: 'Outro', limiteDiario: 0 })
      .expect(400);
    await cliente
      .post('/api/v1/whatsapp/numeros', { nome: 'Outro', senha: 'x' })
      .expect(400);

    const id = criado.body.id as string;
    const editado = await cliente
      .patch(`/api/v1/whatsapp/numeros/${id}`, {
        limiteDiario: 300,
        intervaloMaximoSegundos: 10,
        ativo: false,
        filaPadraoId: null,
        protecoes: { digitando: false },
      })
      .expect(200);
    expect(editado.body).toMatchObject({
      limiteDiario: 300,
      intervaloMaximoSegundos: 10,
      ativo: false,
      filaPadrao: null,
      protecoes: { digitando: false, digitandoMaximoSegundos: 6 },
    });
    await cliente
      .patch(`/api/v1/whatsapp/numeros/${id}`, { intervaloMinimoSegundos: 11 })
      .expect(400);
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { entidadeId: id, acao: 'whatsapp.numero_atualizado' },
    });
    expect(auditoria.dados).toMatchObject({
      alteracoes: {
        limiteDiario: { antes: 1000, depois: 300 },
        ativo: { antes: true, depois: false },
        digitando: { antes: true, depois: false },
      },
    });

    const lista = await cliente.get('/api/v1/whatsapp/numeros').expect(200);
    expect(lista.body).toHaveLength(1);
    await cliente
      .get('/api/v1/whatsapp/numeros/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('conecta pelo gateway: QR ao vivo, CONECTADO, verificação e desvincular em nome do Admin', async () => {
    const usuario = await criarUsuario(t, { papel: 'ADMIN' });
    const cliente = await entrarComo(t, usuario);
    const socket = await conectarTempoReal(t, cliente);
    abertos.push(socket);
    const { numero } = await criarCanalWhatsapp(t);

    await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/verificar`, {
        telefone: '11988887777',
      })
      .expect(409);

    const conectando = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/conectar`)
      .expect(202);
    expect(conectando.body).toMatchObject({ numeroId: numero.id });
    await gateway.aguardarStatus(numero.id, 'AGUARDANDO_QR');
    const status = await cliente
      .get(`/api/v1/whatsapp/numeros/${numero.id}/status`)
      .expect(200);
    expect(status.body.qr).toMatch(/^data:image\/png;base64,/);
    const chegou = esperarEvento<{ status: string; qr?: string }>(
      socket,
      'whatsapp.conexao',
    );
    await drenarEventosDoGateway(t);
    expect(await chegou).toMatchObject({ numeroId: numero.id });

    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    await drenarEventosDoGateway(t);
    const detalhe = await cliente
      .get(`/api/v1/whatsapp/numeros/${numero.id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      status: 'CONECTADO',
      telefone: telefoneSimulado(numero.id),
      aquecimento: { ativo: true, dia: 1 },
      hoje: { limite: 72 },
    });

    const verificado = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/verificar`, {
        telefone: '(11) 98888-7777',
      })
      .expect(200);
    expect(verificado.body).toEqual({
      telefone: '5511988887777',
      existe: true,
      jid: '5511988887777@s.whatsapp.net',
      doCache: false,
    });

    const desvinculado = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/desconectar`, {
        sair: true,
      })
      .expect(200);
    expect(desvinculado.body).toMatchObject({ status: 'DESCONECTADO' });
    const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { entidadeId: numero.id, acao: 'whatsapp.desconectado' },
    });
    expect(evento).toMatchObject({
      tipoAtor: 'USUARIO',
      usuarioId: usuario.id,
    });
  });

  it('pausa e retoma; envios por dia com o limite de cada dia', async () => {
    const cliente = await admin();
    const { numero } = await criarCanalWhatsapp(t);
    const pausado = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/pausar`, {
        motivo: 'Troca de chip',
      })
      .expect(200);
    expect(pausado.body.pausa).toMatchObject({
      motivo: 'Troca de chip',
      automatica: false,
    });
    await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/pausar`, {})
      .expect(409);
    const retomado = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/retomar`)
      .expect(200);
    expect(retomado.body.pausa).toBeNull();
    await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/retomar`)
      .expect(409);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          entidadeId: numero.id,
          acao: { in: ['whatsapp.pausado', 'whatsapp.retomado'] },
        },
      }),
    ).toBe(2);

    const envios = await cliente
      .get(`/api/v1/whatsapp/numeros/${numero.id}/envios?dias=3`)
      .expect(200);
    expect(envios.body).toHaveLength(3);
    expect(envios.body[0]).toMatchObject({
      enviados: 0,
      falhas: 0,
      limite: 1000,
    });
    await cliente
      .get(`/api/v1/whatsapp/numeros/${numero.id}/envios?dias=0`)
      .expect(400);
  });

  it('exclui: desvincula no gateway, apaga as chaves e some da lista', async () => {
    const cliente = await admin();
    const { numero, canal } = await criarCanalWhatsapp(t);
    await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/conectar`)
      .expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    await t.prisma.whatsappChave.create({
      data: {
        numeroId: numero.id,
        tipo: 'creds',
        chaveId: '',
        valorCifrado: 'x',
      },
    });
    await cliente.delete(`/api/v1/whatsapp/numeros/${numero.id}`).expect(204);
    expect(
      await t.prisma.canal.findUniqueOrThrow({ where: { id: canal.id } }),
    ).toMatchObject({ ativo: false, excluidoEm: expect.any(Date) });
    expect(await t.prisma.whatsappChave.count()).toBe(0);
    expect((await gateway.gerenciador.saude()).numeros.CONECTADO ?? 0).toBe(0);
    await cliente.get(`/api/v1/whatsapp/numeros/${numero.id}`).expect(404);
    expect(
      (await cliente.get('/api/v1/whatsapp/numeros').expect(200)).body,
    ).toEqual([]);
  });

  it('gateway fora do ar: 503 com mensagem clara', async () => {
    const cliente = await admin();
    const { numero } = await criarCanalWhatsapp(t);
    await gateway.fechar();
    const resposta = await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/conectar`)
      .expect(503);
    expect(resposta.body.mensagem).toMatch(/serviço de WhatsApp/);
    gateway = await criarGatewayTeste(t);
  });

  it('"digitando…" do atendente chega ao gateway (uma vez por estado, só com número conectado)', async () => {
    const { canal, numero } = await criarCanalWhatsapp(t);
    const contato = await criarContato(t, {
      telefone: '11955554444',
      email: null,
    });
    const conversa = await criarConversa(t, {
      canal,
      contato,
      idExterno: '5511955554444@s.whatsapp.net',
    });
    const espiao = jest.spyOn(gateway.gerenciador, 'digitando');
    const servico = t.get(DigitandoWhatsappService);
    const usuario = { id: 'u', nome: 'Ana' } as never;
    await servico.repassar({
      usuario,
      tipo: 'conversa',
      id: conversa.id,
      ativo: true,
    });
    expect(espiao).not.toHaveBeenCalled(); // número desconectado

    await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
    await gateway.aguardarStatus(numero.id, 'CONECTADO');
    await servico.repassar({
      usuario,
      tipo: 'conversa',
      id: conversa.id,
      ativo: true,
    });
    await servico.repassar({
      usuario,
      tipo: 'conversa',
      id: conversa.id,
      ativo: true,
    });
    await servico.repassar({
      usuario,
      tipo: 'conversa',
      id: conversa.id,
      ativo: false,
    });
    await servico.repassar({
      usuario,
      tipo: 'chat',
      id: conversa.id,
      ativo: true,
    });
    expect(espiao.mock.calls).toEqual([
      [numero.id, '5511955554444@s.whatsapp.net', true],
      [numero.id, '5511955554444@s.whatsapp.net', false],
    ]);
  });

  it('adaptador: voz pelo tipo do arquivo ou pela marca, e os metadados vão no pedido', async () => {
    const { canal, numero } = await criarCanalWhatsapp(t);
    const contato = await criarContato(t, {
      telefone: '11944443333',
      email: null,
    });
    const conversa = await criarConversa(t, { canal, contato });
    const gravado = await criarArquivo(t, {
      nome: 'gravacao.webm',
      mime: 'audio/webm',
      conteudo: Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.alloc(16, 1),
      ]),
    });
    const adaptador = t.get(AdaptadorWhatsapp);
    const voz = await criarMensagem(t, {
      conversa,
      direcao: 'SAIDA',
      tipo: 'AUDIO',
      texto: null,
      arquivo: gravado,
    });
    await adaptador.enviar(voz, conversa, canal);
    const comoArquivo = await criarMensagem(t, {
      conversa,
      direcao: 'SAIDA',
      tipo: 'AUDIO',
      texto: null,
      arquivo: gravado,
    });
    const comMarca = await t.prisma.mensagem.update({
      where: { id: comoArquivo.id },
      data: { metadados: { voz: false } },
    });
    await adaptador.enviar(comMarca, conversa, canal);
    const local = await criarMensagem(t, {
      conversa,
      direcao: 'SAIDA',
      tipo: 'LOCALIZACAO',
      texto: 'Sede',
    });
    const comLocal = await t.prisma.mensagem.update({
      where: { id: local.id },
      data: { metadados: { latitude: -23.5, longitude: -46.6 } },
    });
    await adaptador.enviar(comLocal, conversa, canal);

    const jobs = await t.fila.listarTrabalhos<PedidoDeEnvio>(
      filaDeEnvio(numero.id),
    );
    const porMensagem = new Map(
      jobs.map((job) => [job.dados.mensagemId, job.dados]),
    );
    expect(porMensagem.get(voz.id)).toMatchObject({
      voz: true,
      respostaAoContato: false,
      para: '5511944443333@s.whatsapp.net',
    });
    expect(porMensagem.get(comoArquivo.id)?.voz).toBe(false);
    expect(porMensagem.get(local.id)).toMatchObject({
      voz: false,
      metadados: { latitude: -23.5, longitude: -46.6 },
    });
  });
});
