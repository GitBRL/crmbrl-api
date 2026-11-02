import { Readable } from 'node:stream';
import { FalhaDefinitivaDeEnvio } from '../src/canais/adaptador-canal';
import {
  codificarAtor,
  type EventoConexao,
  type EventoMensagemRecebida,
  type EventoStatusDeMensagem,
  gerarIdDeMensagemWhatsapp,
  type PedidoDeEnvio,
} from '../src/canais/whatsapp/contrato-gateway';
import {
  dataDoDia,
  diaEmSaoPaulo,
  inicioDoProximoDia,
} from '../src/canais/whatsapp/protecoes';
import type { Conversa, WhatsappNumero } from '../src/generated/prisma/client';
import {
  ConversorIndisponivelError,
  MIME_DA_VOZ,
} from '../src/whatsapp/midia/conversor-de-midia';
import { LimiteDoWhatsapp } from '../src/whatsapp/transporte/transporte';
import { telefoneSimulado } from '../src/whatsapp/transporte/transporte-simulado';
import {
  criarArquivo,
  criarCanalWhatsapp,
  criarContato,
  criarConversa,
  criarMensagem,
  criarUsuario,
  PNG_DE_TESTE,
} from './utils';
import {
  criarGatewayIsolado,
  type GatewayIsolado,
  TransporteRoteirizado,
} from './whatsapp-apoio';

/**
 * O processo do gateway de WhatsApp (§2.3) contra o Postgres de teste, com o
 * transporte roteirizado: ciclo da conexão (QR, conectado, quedas, logout,
 * banimento, erro grave), mídia recebida e as proteções anti-banimento de
 * cada envio (R13).
 */
describe('WhatsApp — gateway: conexão e proteções (e2e)', () => {
  let gateway: GatewayIsolado;

  beforeEach(async () => {
    gateway = await criarGatewayIsolado();
    await gateway.limpar();
  });
  afterEach(async () => {
    await gateway.limpar();
    await gateway.fechar();
  });

  const conexoes = async () =>
    (await gateway.eventos()).filter(
      (evento): evento is EventoConexao => evento.tipo === 'conexao',
    );
  const statusPublicados = async () =>
    (await gateway.eventos()).filter(
      (evento): evento is EventoStatusDeMensagem => evento.tipo === 'status',
    );

  /** Número conectado pelo transporte roteirizado. */
  const numeroConectado = async (
    dados: Parameters<typeof criarCanalWhatsapp>[1] = {},
  ) => {
    const criado = await criarCanalWhatsapp(gateway.t, dados);
    await gateway
      .pedir('post', `/numeros/${criado.numero.id}/conectar`)
      .expect(202);
    await gateway.aguardarStatus(criado.numero.id, 'CONECTADO');
    return criado;
  };

  /** Uma mensagem de saída pendente e o pedido de envio dela. */
  const pedidoDe = async (
    numero: WhatsappNumero,
    opcoes: {
      conversa?: Conversa;
      telefone?: string;
      respostaAoContato?: boolean;
      optOut?: boolean;
      tipo?: PedidoDeEnvio['tipo'];
      texto?: string | null;
      arquivoId?: string | null;
      voz?: boolean;
    } = {},
  ): Promise<PedidoDeEnvio> => {
    const telefone = opcoes.telefone ?? '5511944443333';
    const contato = await criarContato(gateway.t, {
      telefone,
      email: null,
    });
    if (opcoes.optOut) {
      await gateway.prisma.contato.update({
        where: { id: contato.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
    }
    const conversa =
      opcoes.conversa ??
      (await criarConversa(gateway.t, { canal: numero.canalId, contato }));
    const mensagem = await criarMensagem(gateway.t, {
      conversa,
      direcao: 'SAIDA',
      tipo: opcoes.tipo ?? 'TEXTO',
      texto: opcoes.texto === undefined ? 'Olá!' : opcoes.texto,
      idExterno: gerarIdDeMensagemWhatsapp(),
    });
    return {
      mensagemId: mensagem.id,
      conversaId: conversa.id,
      canalId: numero.canalId,
      numeroId: numero.id,
      idExterno: mensagem.idExterno as string,
      para: `${telefone}@s.whatsapp.net`,
      tipo: mensagem.tipo,
      texto: mensagem.texto,
      arquivoId: opcoes.arquivoId ?? null,
      voz: opcoes.voz,
      respostaAoContato: opcoes.respostaAoContato ?? true,
      contatoId: contato.id,
    };
  };

  describe('conexão', () => {
    it('QR → AGUARDANDO_QR com a imagem; conectado grava telefone, canal e aquecimento', async () => {
      gateway.transporte.aoIniciar = (sessao) => sessao.qr('QR-1');
      const { canal, numero } = await criarCanalWhatsapp(gateway.t);
      await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
      await gateway.aguardarStatus(numero.id, 'AGUARDANDO_QR');
      const estado = await gateway
        .pedir('get', `/numeros/${numero.id}/status`)
        .expect(200);
      expect(estado.body.qr).toMatch(/^data:image\/png;base64,/);

      gateway.transporte.sessao(numero.id).conectar('5511912345678');
      await gateway.aguardarStatus(numero.id, 'CONECTADO');
      const gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
        include: { canal: true },
      });
      expect(gravado).toMatchObject({
        telefone: '5511912345678',
        jid: '5511912345678@s.whatsapp.net',
        canal: { idExterno: '5511912345678' },
      });
      expect(gravado.aquecimentoInicioEm).not.toBeNull();
      expect((await conexoes()).map((evento) => evento.status)).toEqual([
        'CONECTANDO',
        'AGUARDANDO_QR',
        'CONECTADO',
      ]);
      expect(canal.id).toBe(gravado.canalId);
    });

    it('o mesmo celular em outro canal: ERRO, desvincula a sessão e apaga as chaves', async () => {
      const { canal: primeiro } = await numeroConectado({
        telefone: '5511900001111',
      });
      await gateway.prisma.canal.update({
        where: { id: primeiro.id },
        data: { nome: 'Vendas' },
      });
      const { numero: segundo } = await criarCanalWhatsapp(gateway.t);
      gateway.transporte.aoIniciar = (sessao) =>
        sessao.conectar('5511900001111');
      await gateway
        .pedir('post', `/numeros/${segundo.id}/conectar`)
        .expect(202);
      await gateway.aguardarStatus(segundo.id, 'ERRO');
      const gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: segundo.id },
        include: { canal: true },
      });
      expect(gravado.motivo).toContain('"Vendas"');
      expect(gravado.canal.idExterno).toBeNull();
      expect(gateway.transporte.sessao(segundo.id).encerramentos).toEqual([
        { sair: true },
      ]);
    });

    it('QR sem leitura volta a DESCONECTADO e apaga as credenciais incompletas, sem reconectar', async () => {
      gateway.transporte.aoIniciar = (sessao) => sessao.qr();
      const { numero } = await criarCanalWhatsapp(gateway.t);
      await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
      await gateway.aguardarStatus(numero.id, 'AGUARDANDO_QR');
      await gateway.prisma.whatsappChave.create({
        data: {
          numeroId: numero.id,
          tipo: 'creds',
          chaveId: '',
          valorCifrado: 'x',
        },
      });
      gateway.transporte.sessao(numero.id).cair({
        motivo: 'O QR expirou sem ser lido. Peça um novo para conectar.',
        semLeituraDoQr: true,
      });
      await gateway.aguardarStatus(numero.id, 'DESCONECTADO');
      expect(await gateway.prisma.whatsappChave.count()).toBe(0);
      expect(gateway.transporte.sessoes).toHaveLength(1);
      expect(
        await gateway.prisma.eventoAuditoria.count({
          where: { entidadeId: numero.id, acao: 'whatsapp.desconectado' },
        }),
      ).toBe(0);
    });

    it('erro grave e banimento pausam o número; reconectar pelo CRM tira a pausa automática', async () => {
      const { numero } = await numeroConectado();
      gateway.transporte.sessao(numero.id).cair({
        motivo: 'A sessão deste número foi aberta em outro lugar.',
        erroGrave: true,
      });
      await gateway.aguardarStatus(numero.id, 'ERRO');
      let gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(gravado.pausadoEm).not.toBeNull();
      expect(gravado.pausaMotivo).toBe(
        'A sessão deste número foi aberta em outro lugar.',
      );
      expect(gravado.configuracao).toMatchObject({ pausaAutomatica: true });

      await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
      await gateway.aguardarStatus(numero.id, 'CONECTADO');
      gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(gravado.pausadoEm).toBeNull();
      expect(
        await gateway.prisma.eventoAuditoria.count({
          where: { entidadeId: numero.id, acao: 'whatsapp.retomado' },
        }),
      ).toBe(1);

      gateway.transporte.sessao(numero.id).cair({
        motivo: 'O WhatsApp bloqueou este número.',
        banido: true,
      });
      await gateway.aguardarStatus(numero.id, 'BANIDO');
      expect(
        (
          await gateway.prisma.whatsappNumero.findUniqueOrThrow({
            where: { id: numero.id },
          })
        ).pausadoEm,
      ).not.toBeNull();
      expect(
        await gateway.prisma.eventoAuditoria.count({
          where: { entidadeId: numero.id, acao: 'whatsapp.banido' },
        }),
      ).toBe(1);
    });

    it('logout pelo celular apaga as chaves; queda comum reconecta com espera crescente', async () => {
      const { numero } = await numeroConectado();
      gateway.transporte.sessao(numero.id).cair({ motivo: 'A conexão caiu.' });
      await gateway.aguardarStatus(numero.id, 'CONECTANDO');
      const caindo = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(caindo).toMatchObject({
        motivo: 'A conexão caiu. Reconectando em 2 s.',
        tentativasReconexao: 1,
      });
      // A reconexão abre outra sessão depois da espera (2 s).
      await new Promise((resolver) => setTimeout(resolver, 2_200));
      await gateway.aguardarStatus(numero.id, 'CONECTADO');
      expect(gateway.transporte.sessoes).toHaveLength(2);

      await gateway.prisma.whatsappChave.create({
        data: {
          numeroId: numero.id,
          tipo: 'creds',
          chaveId: '',
          valorCifrado: 'x',
        },
      });
      gateway.transporte.sessao(numero.id).cair({
        motivo: 'O aparelho foi desconectado pelo celular.',
        logout: true,
      });
      await gateway.aguardarStatus(numero.id, 'DESCONECTADO');
      expect(await gateway.prisma.whatsappChave.count()).toBe(0);
    });

    it('desconectar grava a auditoria em nome de quem pediu na API (x-ator)', async () => {
      const admin = await criarUsuario(gateway.t, { papel: 'ADMIN' });
      const { numero } = await numeroConectado();
      await gateway
        .pedir('post', `/numeros/${numero.id}/desconectar`, {})
        .set(
          'x-ator',
          codificarAtor({ id: admin.id, nome: admin.nome, papel: 'ADMIN' }),
        )
        .expect(200);
      const evento = await gateway.prisma.eventoAuditoria.findFirstOrThrow({
        where: { entidadeId: numero.id, acao: 'whatsapp.desconectado' },
      });
      expect(evento).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: admin.id,
      });
    });

    it('"digitando…" do atendente vai à sessão; desconectado não faz nada; JID inválido é 400', async () => {
      const { numero } = await numeroConectado();
      const para = '5511955554444@s.whatsapp.net';
      await gateway
        .pedir('post', `/numeros/${numero.id}/digitando`, { para, ativo: true })
        .expect(204);
      expect(gateway.transporte.sessao(numero.id).digitandos).toEqual([
        [para, true, false],
      ]);
      await gateway
        .pedir('post', `/numeros/${numero.id}/digitando`, {
          para: '120363@g.us',
          ativo: true,
        })
        .expect(400);
      await gateway
        .pedir('post', `/numeros/${numero.id}/desconectar`, {})
        .expect(200);
      await gateway
        .pedir('post', `/numeros/${numero.id}/digitando`, {
          para,
          ativo: false,
        })
        .expect(204);
      expect(gateway.transporte.sessao(numero.id).digitandos).toHaveLength(1);
    });
  });

  describe('mídia recebida (R11)', () => {
    it('guarda a aceita; recusa tipo e tamanho sem baixar; download que falha não perde a mensagem', async () => {
      const { numero } = await numeroConectado();
      const sessao = gateway.transporte.sessao(numero.id);
      const baixarRecusada = jest.fn();
      sessao.receber({
        tipo: 'IMAGEM',
        texto: 'Foto',
        midia: {
          nome: 'foto.png',
          mime: 'image/png',
          tamanho: PNG_DE_TESTE.length,
          baixar: () => Promise.resolve(Readable.from([PNG_DE_TESTE])),
        },
      });
      sessao.receber({
        tipo: 'DOCUMENTO',
        midia: {
          nome: 'pagina.html',
          mime: 'text/html',
          baixar: baixarRecusada,
        },
      });
      sessao.receber({
        tipo: 'VIDEO',
        midia: {
          nome: 'video.mp4',
          mime: 'video/mp4',
          tamanho: 200 * 1024 * 1024,
          baixar: baixarRecusada,
        },
      });
      sessao.receber({
        tipo: 'AUDIO',
        midia: {
          nome: 'audio.ogg',
          mime: 'audio/ogg; codecs=opus',
          baixar: () => Promise.reject(new Error('rede')),
        },
      });
      const mensagens = (await gateway.eventos()).filter(
        (evento): evento is EventoMensagemRecebida =>
          evento.tipo === 'mensagem',
      );
      expect(mensagens).toHaveLength(4);
      expect(baixarRecusada).not.toHaveBeenCalled();

      const arquivo = await gateway.prisma.arquivo.findUniqueOrThrow({
        where: { id: mensagens[0].arquivoId as string },
      });
      expect(arquivo).toMatchObject({
        contexto: 'MENSAGEM',
        mime: 'image/png',
        tamanho: PNG_DE_TESTE.length,
      });
      expect(gateway.arquivos.quantidade).toBe(1);
      expect(mensagens[1]).toMatchObject({
        arquivoId: null,
        metadados: { midiaNome: 'pagina.html' },
      });
      expect(mensagens[1].metadados?.midiaRecusada).toMatch(/HTML/);
      expect(mensagens[2].metadados?.midiaRecusada).toMatch(/limite de 25 MB/);
      expect(mensagens[3]).toMatchObject({
        arquivoId: null,
        metadados: { midiaNome: 'audio.ogg' },
      });
      expect(mensagens[3].metadados?.midiaFalhou).toMatch(/baixar/);
    });
  });

  describe('envio com as proteções (R13)', () => {
    it('ritmo aleatório entre envios e "digitando…" antes de cada um', async () => {
      const { numero } = await numeroConectado();
      const primeiro = await pedidoDe(numero);
      const segundo = await pedidoDe(numero, { telefone: '5511944442222' });
      await gateway.processar(primeiro);
      await gateway.processar(segundo);
      // "Olá!" → 1 s + 4 × 40 ms de "digitando…"; entre os dois, 4 s (sorteio
      // 0,5 entre 2 s e 6 s) menos o que já passou.
      expect(gateway.relogio.esperas).toEqual([0, 1_160, 4_000, 1_160]);
      const sessao = gateway.transporte.sessao(numero.id);
      expect(sessao.digitandos).toEqual([
        ['5511944443333@s.whatsapp.net', true, false],
        ['5511944442222@s.whatsapp.net', true, false],
      ]);
      expect(sessao.enviados.map((envio) => envio.idExterno)).toEqual([
        primeiro.idExterno,
        segundo.idExterno,
      ]);
      expect((await statusPublicados()).map((evento) => evento.status)).toEqual(
        ['ENVIADA', 'ENVIADA'],
      );
      expect(
        await gateway.prisma.whatsappEnvioDiario.findUniqueOrThrow({
          where: {
            numeroId_dia: {
              numeroId: numero.id,
              dia: dataDoDia(diaEmSaoPaulo(new Date(gateway.relogio.agora()))),
            },
          },
        }),
      ).toMatchObject({ enviados: 2, falhas: 0 });
    });

    it('sem "digitando…" quando desligado; mensagem já enviada não sai de novo', async () => {
      const { numero } = await numeroConectado();
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: { configuracao: { digitando: false } },
      });
      const pedido = await pedidoDe(numero);
      await gateway.processar(pedido);
      await gateway.prisma.mensagem.update({
        where: { id: pedido.mensagemId },
        data: { status: 'ENTREGUE' },
      });
      await gateway.processar(pedido);
      const sessao = gateway.transporte.sessao(numero.id);
      expect(sessao.enviados).toHaveLength(1);
      expect(sessao.digitandos).toHaveLength(0);
    });

    it('job repetido antes de a API gravar o ENVIADA só republica o status; job de tentativa anterior não sai', async () => {
      const { numero } = await numeroConectado();
      const pedido = await pedidoDe(numero);
      await gateway.processar(pedido);
      // A mensagem continua PENDENTE (a API ainda não leu o ENVIADA) e o job vem de novo.
      await gateway.processar(pedido);
      const sessao = gateway.transporte.sessao(numero.id);
      expect(sessao.enviados).toHaveLength(1);
      expect(
        (await statusPublicados()).map((evento) => [
          evento.idExterno,
          evento.status,
        ]),
      ).toEqual([
        [pedido.idExterno, 'ENVIADA'],
        [pedido.idExterno, 'ENVIADA'],
      ]);
      const dia = dataDoDia(diaEmSaoPaulo(new Date(gateway.relogio.agora())));
      expect(
        await gateway.prisma.whatsappEnvioDiario.findUniqueOrThrow({
          where: { numeroId_dia: { numeroId: numero.id, dia } },
        }),
      ).toMatchObject({ enviados: 1 });

      // "Tentar de novo" deu outro id à mensagem: o job antigo fica sem efeito.
      const outro = await pedidoDe(numero, { telefone: '5511944442222' });
      await gateway.prisma.mensagem.update({
        where: { id: outro.mensagemId },
        data: { idExterno: gerarIdDeMensagemWhatsapp() },
      });
      await gateway.processar(outro);
      expect(sessao.enviados).toHaveLength(1);
      expect(await statusPublicados()).toHaveLength(2);
    });

    it('cenário 27 — opt-out (R4.6): mensagem ativa falha; resposta ao contato sai', async () => {
      const { numero } = await numeroConectado();
      const ativa = await pedidoDe(numero, {
        optOut: true,
        respostaAoContato: false,
      });
      await gateway.processar(ativa);
      expect(await statusPublicados()).toEqual([
        expect.objectContaining({
          idExterno: ativa.idExterno,
          status: 'FALHOU',
          erro: expect.stringMatching(/opt-out/),
        }),
      ]);
      const resposta = await pedidoDe(numero, {
        optOut: true,
        respostaAoContato: true,
        telefone: '5511944441111',
      });
      await gateway.processar(resposta);
      expect(gateway.transporte.sessao(numero.id).enviados).toHaveLength(1);
    });

    it('verificação na mensagem ativa: usa o JID devolvido e falha sem WhatsApp', async () => {
      const { numero } = await numeroConectado();
      const sessao = gateway.transporte.sessao(numero.id);
      sessao.verificacoes.set('5511944443333', {
        existe: true,
        jid: '551144443333@s.whatsapp.net',
      });
      sessao.verificacoes.set('5511944440000', { existe: false, jid: null });
      await gateway.processar(
        await pedidoDe(numero, { respostaAoContato: false }),
      );
      expect(sessao.enviados[0].para).toBe('551144443333@s.whatsapp.net');
      const semWhatsapp = await pedidoDe(numero, {
        respostaAoContato: false,
        telefone: '5511944440000',
      });
      await gateway.processar(semWhatsapp);
      expect((await statusPublicados()).at(-1)).toMatchObject({
        idExterno: semWhatsapp.idExterno,
        status: 'FALHOU',
        erro: 'Este número não tem WhatsApp.',
      });
      expect(
        await gateway.prisma.whatsappVerificacao.count({
          where: { telefone: { in: ['5511944443333', '5511944440000'] } },
        }),
      ).toBe(2);
    });

    it('cenário 27 — limite diário (com aquecimento): a mensagem ativa fica para amanhã; a resposta sai', async () => {
      const { numero } = await numeroConectado({ limiteDiario: 30 });
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: { aquecimentoDias: 0 },
      });
      const agora = new Date(gateway.relogio.agora());
      await gateway.prisma.whatsappEnvioDiario.create({
        data: {
          numeroId: numero.id,
          dia: dataDoDia(diaEmSaoPaulo(agora)),
          enviados: 30,
        },
      });
      const ativa = await pedidoDe(numero, { respostaAoContato: false });
      await gateway.processar(ativa);
      const sessao = gateway.transporte.sessao(numero.id);
      expect(sessao.enviados).toHaveLength(0);
      const [adiado] = await gateway.envios(numero.id);
      expect(adiado.dados.mensagemId).toBe(ativa.mensagemId);
      const amanha = inicioDoProximoDia(agora).getTime();
      expect(adiado.executarEm.getTime()).toBeGreaterThanOrEqual(amanha);
      expect(adiado.executarEm.getTime()).toBeLessThanOrEqual(
        amanha + 30 * 60_000,
      );
      expect(await statusPublicados()).toHaveLength(0);

      await gateway.processar(
        await pedidoDe(numero, { telefone: '5511944441111' }),
      );
      expect(sessao.enviados).toHaveLength(1);

      // No aquecimento, o limite do dia é menor que o cheio.
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: { aquecimentoDias: 14, limiteDiario: 1000 },
      });
      await gateway.processar(
        await pedidoDe(numero, {
          respostaAoContato: false,
          telefone: '5511944442222',
        }),
      );
      expect(sessao.enviados).toHaveLength(2); // 31 enviados < 72 do dia 1
    });

    it('número pausado: o envio volta para a fila a cada 5 min e, depois de 24 h, falha', async () => {
      const { numero } = await numeroConectado({ pausadoEm: new Date() });
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: { pausaMotivo: 'Troca de chip' },
      });
      const pedido = await pedidoDe(numero);
      await gateway.processar(pedido);
      const [adiado] = await gateway.envios(numero.id);
      const agora = gateway.relogio.agora();
      expect(adiado.dados).toMatchObject({
        mensagemId: pedido.mensagemId,
        adiadoDesde: new Date(agora).toISOString(),
      });
      expect(adiado.executarEm.getTime()).toBeGreaterThanOrEqual(
        agora + 5 * 60_000 - 1_000,
      );
      expect(await statusPublicados()).toHaveLength(0);

      await gateway.processar({
        ...pedido,
        adiadoDesde: new Date(agora - 25 * 60 * 60_000).toISOString(),
      });
      expect(await statusPublicados()).toEqual([
        expect.objectContaining({
          status: 'FALHOU',
          erro: 'O número de WhatsApp ficou pausado por mais de 24 horas (Troca de chip). Retome o número e tente de novo.',
        }),
      ]);
      expect(gateway.transporte.sessao(numero.id).enviados).toHaveLength(0);
    });

    it('ordem da conversa: a mensagem posterior espera a anterior pendente e volta à fila sem gastar tentativa', async () => {
      const { numero } = await numeroConectado();
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: { configuracao: { digitando: false } },
      });
      const primeiro = await pedidoDe(numero);
      const conversa = await gateway.prisma.conversa.findUniqueOrThrow({
        where: { id: primeiro.conversaId },
      });
      const segundo = await pedidoDe(numero, {
        conversa,
        telefone: '5511944442222',
      });
      await gateway.prisma.mensagem.update({
        where: { id: primeiro.mensagemId },
        data: { status: 'PENDENTE' },
      });
      await gateway.prisma.mensagem.update({
        where: { id: segundo.mensagemId },
        data: { status: 'PENDENTE' },
      });
      const sessao = gateway.transporte.sessao(numero.id);

      // O segundo chega primeiro: não sai, volta à fila.
      await gateway.processar(segundo);
      expect(sessao.enviados).toHaveLength(0);
      const [volta] = await gateway.envios(numero.id);
      expect(volta.dados).toMatchObject({
        mensagemId: segundo.mensagemId,
        esperaDesde: expect.any(String),
      });

      await gateway.processar(primeiro);
      expect(sessao.enviados).toHaveLength(1);
      // O primeiro já saiu por este processo: o segundo não espera o evento.
      await gateway.processar(segundo);
      expect(sessao.enviados).toHaveLength(2);
    });

    it('número desconectado: o envio volta à fila sem lançar erro e, passado o prazo, falha', async () => {
      const { numero } = await numeroConectado();
      await gateway
        .pedir('post', `/numeros/${numero.id}/desconectar`, {})
        .expect(200);
      const pedido = await pedidoDe(numero);
      await expect(gateway.processar(pedido)).resolves.toBeUndefined();
      const [volta] = await gateway.envios(numero.id);
      expect(volta.dados).toMatchObject({ mensagemId: pedido.mensagemId });
      expect(await statusPublicados()).toHaveLength(0);

      await gateway.processar({
        ...pedido,
        esperaDesde: new Date(
          gateway.relogio.agora() - 31 * 60_000,
        ).toISOString(),
      });
      expect(await statusPublicados()).toEqual([
        expect.objectContaining({
          status: 'FALHOU',
          erro: 'O número de WhatsApp está desconectado.',
        }),
      ]);
    });

    it('pausa automática depois de mensagens seguidas que não saem', async () => {
      const { numero } = await numeroConectado();
      await gateway.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: {
          configuracao: { pausarAposFalhasSeguidas: 3, digitando: false },
        },
      });
      const sessao = gateway.transporte.sessao(numero.id);
      sessao.falharEnvio = () => new Error('timed out');
      const pedidos = [
        await pedidoDe(numero),
        await pedidoDe(numero, { telefone: '5511944442222' }),
        await pedidoDe(numero, { telefone: '5511944441111' }),
      ];
      // A mesma mensagem falhando de novo não conta duas vezes.
      await expect(gateway.processar(pedidos[0])).rejects.toThrow('timed out');
      await expect(gateway.processar(pedidos[0])).rejects.toThrow('timed out');
      await expect(gateway.processar(pedidos[1])).rejects.toThrow('timed out');
      let gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(gravado.pausadoEm).toBeNull();
      await expect(gateway.processar(pedidos[2])).rejects.toThrow('timed out');
      gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(gravado.pausadoEm).not.toBeNull();
      expect(gravado.pausaMotivo).toMatch(/3 mensagens seguidas/);
      expect(gravado.configuracao).toMatchObject({ pausaAutomatica: true });
      expect(
        await gateway.prisma.eventoAuditoria.count({
          where: { entidadeId: numero.id, acao: 'whatsapp.pausado' },
        }),
      ).toBe(1);
      // A tela fica sabendo (evento de conexão com o status atual).
      expect((await conexoes()).at(-1)).toMatchObject({ status: 'CONECTADO' });
    });

    it('limite imposto pelo WhatsApp pausa na hora; falha definitiva vira FALHOU sem pausar', async () => {
      const { numero } = await numeroConectado();
      const sessao = gateway.transporte.sessao(numero.id);
      sessao.falharEnvio = (envio) =>
        envio.texto === 'definitiva'
          ? new FalhaDefinitivaDeEnvio('Destino inválido.', 'destino')
          : undefined;
      await gateway.processar(await pedidoDe(numero, { texto: 'definitiva' }));
      expect((await statusPublicados()).at(-1)).toMatchObject({
        status: 'FALHOU',
        erro: 'Destino inválido.',
      });
      sessao.falharEnvio = () => new LimiteDoWhatsapp();
      await expect(
        gateway.processar(
          await pedidoDe(numero, { telefone: '5511944442222' }),
        ),
      ).rejects.toBeInstanceOf(LimiteDoWhatsapp);
      const gravado = await gateway.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numero.id },
      });
      expect(gravado.pausaMotivo).toMatch(/limitou os envios/);
    });

    it('voz gravada no navegador vira ogg/opus; imagem leva miniatura; arquivo sumido falha de vez', async () => {
      const { numero } = await numeroConectado();
      const audio = await criarArquivo(gateway.t, {
        nome: 'gravacao.webm',
        mime: 'audio/webm',
        conteudo: Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          Buffer.alloc(64, 1),
        ]),
      });
      await gateway.processar(
        await pedidoDe(numero, {
          tipo: 'AUDIO',
          texto: null,
          arquivoId: audio.id,
          voz: true,
        }),
      );
      const imagem = await criarArquivo(gateway.t, {
        nome: 'foto.png',
        mime: 'image/png',
        conteudo: PNG_DE_TESTE,
      });
      await gateway.processar(
        await pedidoDe(numero, {
          tipo: 'IMAGEM',
          texto: 'Veja',
          arquivoId: imagem.id,
          telefone: '5511944442222',
        }),
      );
      const sessao = gateway.transporte.sessao(numero.id);
      expect(sessao.enviados[0]).toMatchObject({
        tipo: 'AUDIO',
        voz: true,
        midia: { nome: 'gravacao.ogg', mime: MIME_DA_VOZ },
      });
      expect(sessao.enviados[0].midia?.conteudo.toString()).toBe(
        'OggS-convertido',
      );
      expect(sessao.digitandos[0][2]).toBe(true); // "gravando…"
      expect(sessao.enviados[1].midia?.miniatura).toBe('MINI');

      // Sem ffmpeg no transporte real: falha definitiva (o celular não tocaria webm).
      gateway.conversor.falharVoz = new ConversorIndisponivelError();
      const semFfmpeg = await pedidoDe(numero, {
        tipo: 'AUDIO',
        texto: null,
        arquivoId: audio.id,
        voz: true,
        telefone: '5511944441111',
      });
      await gateway.processar(semFfmpeg);
      expect((await statusPublicados()).at(-1)).toMatchObject({
        idExterno: semFfmpeg.idExterno,
        status: 'FALHOU',
        erro: 'Não foi possível converter o áudio para mensagem de voz.',
      });

      const sumido = await pedidoDe(numero, {
        tipo: 'DOCUMENTO',
        arquivoId: '00000000-0000-4000-8000-000000000000',
        telefone: '5511944449999',
      });
      await gateway.processar(sumido);
      expect((await statusPublicados()).at(-1)).toMatchObject({
        idExterno: sumido.idExterno,
        status: 'FALHOU',
        erro: 'O arquivo da mensagem não foi encontrado.',
      });
    });
  });
});

describe('WhatsApp — gateway simulado sem ffmpeg (e2e)', () => {
  it('no modo simulado, a voz segue sem conversão quando não há ffmpeg', async () => {
    const gateway = await criarGatewayIsolado({
      transporte: new TransporteRoteirizado('simulado'),
    });
    try {
      await gateway.limpar();
      gateway.conversor.falharVoz = new ConversorIndisponivelError();
      const { numero } = await criarCanalWhatsapp(gateway.t);
      await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
      await gateway.aguardarStatus(numero.id, 'CONECTADO');
      const audio = await criarArquivo(gateway.t, {
        nome: 'gravacao.webm',
        mime: 'audio/webm',
        conteudo: Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          Buffer.alloc(16, 1),
        ]),
      });
      const contato = await criarContato(gateway.t, {
        telefone: '5511944443333',
        email: null,
      });
      const conversa = await criarConversa(gateway.t, {
        canal: numero.canalId,
        contato,
      });
      const mensagem = await criarMensagem(gateway.t, {
        conversa,
        direcao: 'SAIDA',
        tipo: 'AUDIO',
        texto: null,
        arquivo: audio,
        idExterno: gerarIdDeMensagemWhatsapp(),
      });
      await gateway.processar({
        mensagemId: mensagem.id,
        conversaId: conversa.id,
        canalId: numero.canalId,
        numeroId: numero.id,
        idExterno: mensagem.idExterno as string,
        para: '5511944443333@s.whatsapp.net',
        tipo: 'AUDIO',
        arquivoId: audio.id,
        voz: true,
        respostaAoContato: true,
        contatoId: contato.id,
      });
      expect(
        gateway.transporte.sessao(numero.id).enviados[0].midia,
      ).toMatchObject({
        nome: 'gravacao.webm',
        mime: 'audio/webm',
      });
      expect(telefoneSimulado(numero.id)).toMatch(/^55119\d{8}$/);
    } finally {
      await gateway.limpar();
      await gateway.fechar();
    }
  });
});
