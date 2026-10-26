import { randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import { AdaptadorEmail } from '../src/canais/email/adaptador-email';
import { LeitorDeEmail } from '../src/canais/email/leitor-de-email.service';
import {
  type AppTeste,
  criarAppTeste,
  criarUsuario,
  entrarComo,
  PDF_DE_TESTE,
} from './utils';

/**
 * Canal de e-mail de ponta a ponta (§2.5, R14) contra um GreenMail de
 * verdade (SMTP + IMAP). Só roda com `EMAIL_TESTE_SMTP_PORTA` e
 * `EMAIL_TESTE_IMAP_PORTA` (e `EMAIL_TESTE_HOST`, padrão 127.0.0.1) — por
 * exemplo, com um GreenMail descartável:
 *
 * ```bash
 * docker run -d --rm --name greenmail-teste -p 127.0.0.1:55466:3025 -p 127.0.0.1:55467:3143 \
 *   -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0" \
 *   greenmail/standalone:2.1.8
 * EMAIL_TESTE_SMTP_PORTA=55466 EMAIL_TESTE_IMAP_PORTA=55467 npm run test:e2e -- test/onda-a-canais-email
 * ```
 *
 * O GreenMail cria a caixa de qualquer destinatário no primeiro e-mail, com a
 * senha igual ao endereço: cada teste usa caixas novas.
 */
const HOST = process.env.EMAIL_TESTE_HOST ?? '127.0.0.1';
const PORTA_SMTP = Number(process.env.EMAIL_TESTE_SMTP_PORTA);
const PORTA_IMAP = Number(process.env.EMAIL_TESTE_IMAP_PORTA);
const descrever = PORTA_SMTP && PORTA_IMAP ? describe : describe.skip;

descrever('Canais — e-mail com GreenMail (e2e)', () => {
  let t: AppTeste;
  const smtp = createTransport({
    host: HOST,
    port: PORTA_SMTP || 25,
    secure: false,
    ignoreTLS: true,
  });

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(async () => {
    smtp.close();
    await t?.fechar();
  });

  const caixaNova = (prefixo: string) =>
    `${prefixo}-${randomBytes(4).toString('hex')}@demo.local`;

  async function enviar(dados: {
    de: string;
    para: string;
    assunto: string;
    texto?: string;
    html?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    anexos?: Array<{ filename: string; content: Buffer; contentType: string }>;
  }): Promise<string> {
    const info = await smtp.sendMail({
      from: dados.de,
      to: dados.para,
      subject: dados.assunto,
      text: dados.texto,
      html: dados.html,
      messageId: dados.messageId,
      inReplyTo: dados.inReplyTo,
      references: dados.references,
      attachments: dados.anexos,
    });
    return info.messageId.replace(/^<|>$/g, '');
  }

  /** Os e-mails de uma caixa do GreenMail (senha = endereço). */
  async function lerCaixa(endereco: string) {
    const cliente = new ImapFlow({
      host: HOST,
      port: PORTA_IMAP,
      secure: false,
      auth: { user: endereco, pass: endereco },
      logger: false,
    });
    cliente.on('error', () => undefined);
    await cliente.connect();
    const lidos = [];
    const trava = await cliente.getMailboxLock('INBOX');
    try {
      for await (const mensagem of cliente.fetch('1:*', { source: true })) {
        lidos.push(await simpleParser(mensagem.source as Buffer));
      }
    } finally {
      trava.release();
      await cliente.logout();
    }
    return lidos;
  }

  async function criarCanal(endereco: string, senha = endereco) {
    const admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    const resposta = await admin
      .post('/api/v1/email/canais', {
        nome: 'Atendimento por e-mail',
        endereco,
        nomeRemetente: 'Atendimento BRL',
        imap: { host: HOST, porta: PORTA_IMAP, tls: false },
        smtp: { porta: PORTA_SMTP, seguranca: 'NENHUMA' },
        senha,
        assinatura: 'Equipe BRL',
      })
      .expect(201);
    return {
      admin,
      canal: resposta.body as { id: string; [campo: string]: unknown },
    };
  }

  async function varrer(canalId: string) {
    const canal = await t.prisma.canal.findUniqueOrThrow({
      where: { id: canalId },
    });
    return t.get(LeitorDeEmail).varrerCanal(canal);
  }

  it('teste de conexão: credenciais certas e erradas', async () => {
    const caixa = caixaNova('teste');
    await enviar({
      de: 'alguem@externo.test',
      para: caixa,
      assunto: 'cria a caixa',
      texto: 'x',
    });
    const admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    const corpo = {
      endereco: caixa,
      imap: { host: HOST, porta: PORTA_IMAP, tls: false },
      smtp: { porta: PORTA_SMTP, seguranca: 'NENHUMA' },
    };
    const certo = await admin
      .post('/api/v1/email/canais/testar', { ...corpo, senha: caixa })
      .expect(200);
    expect(certo.body).toEqual({
      imap: {
        ok: true,
        mensagem: expect.stringMatching(
          /^Conectado\. A pasta INBOX tem 1 mensagem/,
        ),
      },
      smtp: {
        ok: true,
        mensagem: 'Conectado: o envio das respostas está pronto.',
      },
    });
    const errado = await admin
      .post('/api/v1/email/canais/testar', { ...corpo, senha: 'senha-errada' })
      .expect(200);
    expect(errado.body).toEqual({
      imap: {
        ok: false,
        mensagem: 'O servidor IMAP recusou o usuário ou a senha do canal.',
      },
      smtp: {
        ok: false,
        mensagem: 'O servidor SMTP recusou o usuário ou a senha do canal.',
      },
    });
    const semServidor = await admin
      .post('/api/v1/email/canais/testar', {
        ...corpo,
        imap: { host: HOST, porta: 1, tls: false },
        smtp: { porta: 1, seguranca: 'NENHUMA' },
        senha: caixa,
      })
      .expect(200);
    expect(semServidor.body.imap).toMatchObject({
      ok: false,
      mensagem: expect.stringMatching(/recusou a conexão/),
    });
  });

  it('cenário 29 — R14: só mensagens novas; texto sem HTML nem citação; anexos; encadeamento na resposta e na volta', async () => {
    const caixa = caixaNova('atendimento');
    const cliente = caixaNova('cliente');
    // Antes do canal existir: não entra.
    await enviar({
      de: cliente,
      para: caixa,
      assunto: 'Antiga',
      texto: 'mensagem antiga',
    });
    const { admin, canal } = await criarCanal(caixa);
    expect(canal).toMatchObject({
      tipo: 'EMAIL',
      idExterno: caixa,
      endereco: caixa,
      senha: expect.stringMatching(/^••••••••/),
      senhaSmtp: null,
      imap: {
        host: HOST,
        porta: PORTA_IMAP,
        tls: false,
        usuario: caixa,
        pasta: 'INBOX',
      },
      smtp: {
        host: HOST,
        porta: PORTA_SMTP,
        seguranca: 'NENHUMA',
        usuario: caixa,
      },
    });
    expect(JSON.stringify(canal)).not.toContain(`"${caixa}","senha`);
    const gravado = await t.prisma.canal.findUniqueOrThrow({
      where: { id: canal.id },
    });
    expect(gravado.segredosCifrados).not.toContain(caixa);
    expect(gravado.estado).toMatchObject({ ultimoUid: 1 });

    const idDoContato = await enviar({
      de: `Maria Cliente <${cliente}>`,
      para: caixa,
      assunto: 'Orçamento do plano anual',
      html: '<p>Olá, <b>tudo bem</b>?</p><p>Quero o orçamento.</p><script>alert(1)</script>',
      anexos: [
        {
          filename: 'pedido.pdf',
          content: PDF_DE_TESTE,
          contentType: 'application/pdf',
        },
      ],
    });
    expect(await varrer(canal.id)).toEqual({
      importadas: 1,
      ignoradas: 0,
      erro: null,
    });
    // De novo: nada novo.
    expect(await varrer(canal.id)).toEqual({
      importadas: 0,
      ignoradas: 0,
      erro: null,
    });

    const conversa = await t.prisma.conversa.findFirstOrThrow({
      where: { canalId: canal.id },
      include: {
        contato: true,
        mensagens: {
          orderBy: { ocorridaEm: 'asc' },
          include: { arquivo: true },
        },
      },
    });
    expect(conversa).toMatchObject({
      assunto: 'Orçamento do plano anual',
      idExterno: idDoContato,
      contato: {
        email: cliente,
        nome: 'Maria Cliente',
        primeiraOrigem: 'EMAIL',
      },
    });
    expect(conversa.mensagens).toHaveLength(2);
    const [texto, anexo] = conversa.mensagens;
    expect(texto).toMatchObject({
      direcao: 'ENTRADA',
      tipo: 'TEXTO',
      idExterno: idDoContato,
      texto: 'Olá, tudo bem?\n\nQuero o orçamento.',
      metadados: {
        email: expect.objectContaining({
          messageId: idDoContato,
          de: cliente,
          assunto: 'Orçamento do plano anual',
        }),
      },
    });
    expect(anexo).toMatchObject({
      tipo: 'DOCUMENTO',
      idExterno: `${idDoContato}#anexo-1`,
      arquivo: {
        nome: 'pedido.pdf',
        mime: 'application/pdf',
        contexto: 'MENSAGEM',
      },
    });
    expect(
      await t.prisma.mensagem.count({
        where: { texto: { contains: 'antiga' } },
      }),
    ).toBe(0);

    // Resposta da equipe: SMTP do canal, com o encadeamento.
    const atendente = await criarUsuario(t, { papel: 'ADMIN' });
    const saida = await t.prisma.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: canal.id,
        direcao: 'SAIDA',
        texto: 'Olá, Maria! Segue o orçamento.',
        autorId: atendente.id,
        autorTipo: 'USUARIO',
        status: 'PENDENTE',
      },
    });
    const resultado = await t
      .get(AdaptadorEmail)
      .enviar(saida, conversa, gravado);
    expect(resultado.idExterno).toMatch(/^[0-9a-f-]{36}@demo\.local$/);
    await t.prisma.mensagem.update({
      where: { id: saida.id },
      data: { idExterno: resultado.idExterno, status: 'ENVIADA' },
    });
    const recebidos = await lerCaixa(cliente);
    expect(recebidos).toHaveLength(1);
    const resposta = recebidos[0];
    expect(resposta.subject).toBe('Re: Orçamento do plano anual');
    expect(resposta.messageId).toBe(`<${resultado.idExterno}>`);
    expect(resposta.inReplyTo).toBe(`<${idDoContato}>`);
    expect([resposta.references].flat()).toEqual([`<${idDoContato}>`]);
    expect(resposta.from?.value[0]).toMatchObject({
      address: caixa,
      name: 'Atendimento BRL',
    });
    expect(resposta.text?.trim()).toBe(
      'Olá, Maria! Segue o orçamento.\n\n-- \nEquipe BRL',
    );
    expect(resposta.html).toBe(false);

    // O contato responde à nossa resposta: mesma conversa, citação ligada.
    const volta = await enviar({
      de: cliente,
      para: caixa,
      assunto: 'Re: Orçamento do plano anual',
      texto: `Perfeito, obrigada!\n\nEm qui., 23 de out. de 2026, Atendimento BRL <${caixa}> escreveu:\n> Olá, Maria! Segue o orçamento.\n`,
      inReplyTo: `<${resultado.idExterno}>`,
      references: [`<${idDoContato}>`, `<${resultado.idExterno}>`],
    });
    expect((await varrer(canal.id)).importadas).toBe(1);
    const ultima = await t.prisma.mensagem.findFirstOrThrow({
      where: { idExterno: volta },
    });
    expect(ultima).toMatchObject({
      conversaId: conversa.id,
      texto: 'Perfeito, obrigada!',
      respostaAId: saida.id,
    });
    expect(ultima.metadados).toMatchObject({
      email: expect.objectContaining({
        inReplyTo: resultado.idExterno,
        textoCompleto: expect.stringContaining('> Olá, Maria!'),
      }),
    });

    // Auditoria da criação e o canal na lista.
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'canal.criado', entidadeId: canal.id },
      }),
    ).toBe(1);
    const lista = await admin.get('/api/v1/email/canais').expect(200);
    expect(lista.body[0]).toMatchObject({
      id: canal.id,
      ultimaVarreduraEm: expect.any(String),
    });
  });

  it('R14 — o Reply-To é o contato e o destino da resposta; reimportar o mesmo e-mail não duplica nada', async () => {
    const caixa = caixaNova('formulario');
    const cliente = caixaNova('carla');
    await enviar({
      de: 'x@externo.test',
      para: caixa,
      assunto: 'cria',
      texto: 'x',
    });
    const { canal } = await criarCanal(caixa);
    const gravado = await t.prisma.canal.findUniqueOrThrow({
      where: { id: canal.id },
    });
    // O formulário do site envia de um "não responda" com o Reply-To do cliente.
    const montado = await createTransport({
      streamTransport: true,
      buffer: true,
    }).sendMail({
      from: 'Formulário do site <nao-responda@site.test>',
      replyTo: `Carla Cliente <${cliente}>`,
      to: caixa,
      subject: 'Pedido de orçamento',
      text: 'Quero um orçamento para 10 pessoas.',
      attachments: [
        {
          filename: 'briefing.pdf',
          content: PDF_DE_TESTE,
          contentType: 'application/pdf',
        },
      ],
    });
    const bruto = montado.message as Buffer;
    await smtp.sendMail({
      envelope: { from: 'nao-responda@site.test', to: [caixa] },
      raw: bruto,
    });
    expect(await varrer(canal.id)).toMatchObject({ importadas: 1, erro: null });

    const identificadores = await t.prisma.contatoIdentificador.findMany({
      where: { tipo: 'EMAIL' },
      include: { contato: true },
    });
    expect(identificadores).toHaveLength(1);
    expect(identificadores[0]).toMatchObject({
      valor: cliente,
      contato: { nome: 'Carla Cliente', email: cliente },
    });
    const contagem = async () => ({
      mensagens: await t.prisma.mensagem.count(),
      arquivos: await t.prisma.arquivo.count(),
    });
    const antes = await contagem();
    expect(antes).toEqual({ mensagens: 2, arquivos: 1 });

    // A varredura caiu antes de gravar o cursor: o mesmo e-mail volta.
    expect(await t.get(LeitorDeEmail).processar(gravado, bruto)).toBe(false);
    expect(await contagem()).toEqual(antes);

    const conversa = await t.prisma.conversa.findFirstOrThrow({
      where: { canalId: canal.id },
    });
    const saida = await t.prisma.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: canal.id,
        direcao: 'SAIDA',
        texto: 'Olá, Carla! Segue o orçamento.',
        status: 'PENDENTE',
      },
    });
    await t.get(AdaptadorEmail).enviar(saida, conversa, gravado);
    const [resposta] = await lerCaixa(cliente);
    expect(resposta.to).toMatchObject({
      value: [{ address: cliente, name: 'Carla Cliente' }],
    });
    expect(resposta.subject).toBe('Re: Pedido de orçamento');
  });

  it('senha errada: a varredura não lança e o erro fica no canal; a correção limpa', async () => {
    const caixa = caixaNova('errada');
    await enviar({
      de: 'x@externo.test',
      para: caixa,
      assunto: 'cria',
      texto: 'x',
    });
    const { admin, canal } = await criarCanal(caixa, 'senha-errada');
    const resultado = await varrer(canal.id);
    expect(resultado).toEqual({
      importadas: 0,
      ignoradas: 0,
      erro: 'O servidor IMAP recusou o usuário ou a senha do canal.',
    });
    const comErro = await admin
      .get(`/api/v1/email/canais/${canal.id}`)
      .expect(200);
    expect(comErro.body).toMatchObject({
      ultimoErro: 'O servidor IMAP recusou o usuário ou a senha do canal.',
      ultimoErroEm: expect.any(String),
    });
    await admin
      .patch(`/api/v1/email/canais/${canal.id}`, { senha: caixa })
      .expect(200);
    expect((await varrer(canal.id)).erro).toBeNull();
    const corrigido = await admin
      .get(`/api/v1/email/canais/${canal.id}`)
      .expect(200);
    expect(corrigido.body.ultimoErro).toBeNull();
    const teste = await admin
      .post(`/api/v1/email/canais/${canal.id}/testar`, {})
      .expect(200);
    expect(teste.body.imap.ok && teste.body.smtp.ok).toBe(true);
  });

  it('endereço repetido entre canais de e-mail: 409', async () => {
    const caixa = caixaNova('repetida');
    await enviar({
      de: 'x@externo.test',
      para: caixa,
      assunto: 'cria',
      texto: 'x',
    });
    const { admin } = await criarCanal(caixa);
    await admin
      .post('/api/v1/email/canais', {
        nome: 'Outro',
        endereco: caixa,
        imap: { host: HOST, porta: PORTA_IMAP, tls: false },
        senha: caixa,
      })
      .expect(409);
  });
});
