import { simpleParser } from 'mailparser';
import {
  dominioDoEndereco,
  lerConfiguracaoEmail,
  lerEstadoEmail,
  senhaDoSmtp,
} from './configuracao-email';
import { traduzirErroDeEmail } from './conexoes-email';
import {
  interpretarEmail,
  lerEmail,
  limparAssunto,
  listaDeIds,
  normalizarIdDeMensagem,
  removerCitacao,
} from './interpretacao-email';
import { montarConfiguracao } from './email-canais.service';
import { contatoDoEmail } from './leitor-de-email.service';

describe('e-mail (R14) — interpretação', () => {
  it('normaliza Message-IDs e listas de References', () => {
    expect(normalizarIdDeMensagem(' <abc.123@ex.com> ')).toBe('abc.123@ex.com');
    expect(normalizarIdDeMensagem('<>')).toBeNull();
    expect(normalizarIdDeMensagem('com espaço@x')).toBeNull();
    expect(listaDeIds('<a@x> <b@x>\r\n <a@x>')).toEqual(['a@x', 'b@x']);
    expect(listaDeIds(['<raiz@x>', '<b@x>'])).toEqual(['raiz@x', 'b@x']);
    expect(listaDeIds(undefined)).toEqual([]);
  });

  it.each([
    ['Re: Orçamento', 'Orçamento'],
    ['RES: RE: Fwd: Orçamento', 'Orçamento'],
    ['ENC: Proposta', 'Proposta'],
    ['Re[2]: Pedido 15', 'Pedido 15'],
    ['AW: TR: Frage', 'Frage'],
    ['Resposta sobre o plano', 'Resposta sobre o plano'],
    ['  Re:   ', null],
  ])('limparAssunto(%j) → %j', (entrada, esperado) => {
    expect(limparAssunto(entrada)).toBe(esperado);
  });

  describe('removerCitacao', () => {
    it('corta no "Em …, Fulano escreveu:" (também quebrado em duas linhas)', () => {
      expect(
        removerCitacao(
          'Pode ser na terça.\n\nEm qua., 22 de out. de 2026 às 10:00, Atendimento\n<atendimento@demo.local> escreveu:\n> Qual dia?\n',
        ),
      ).toBe('Pode ser na terça.');
      expect(
        removerCitacao(
          'Sure.\r\n\r\nOn Wed, Oct 22, 2026 at 10:00 AM Ana <a@x.com> wrote:\r\n> hi',
        ),
      ).toBe('Sure.');
    });

    it('corta no separador "Mensagem original" e no bloco De:/Enviado: do Outlook', () => {
      expect(
        removerCitacao(
          'Segue.\n\n-----Mensagem original-----\nDe: X\nAssunto: Y',
        ),
      ).toBe('Segue.');
      expect(
        removerCitacao(
          'Obrigado!\n\n________________________________\nDe: Atendimento <a@x>\nEnviado: quarta\nPara: eu',
        ),
      ).toBe('Obrigado!');
      expect(
        removerCitacao(
          'Combinado.\n\nDe: Atendimento <a@x>\nEnviado: quarta-feira\nAssunto: Re: Y\n\nTexto antigo',
        ),
      ).toBe('Combinado.');
    });

    it('tira as linhas citadas com ">" no fim, mas mantém as do meio', () => {
      expect(
        removerCitacao('> você perguntou\nResposta aqui\n\n> antigo\n> mais'),
      ).toBe('> você perguntou\nResposta aqui');
    });

    it('sem nada novo, devolve o texto inteiro', () => {
      expect(removerCitacao('> só citação')).toBe('> só citação');
      expect(removerCitacao('Sem citação nenhuma.')).toBe(
        'Sem citação nenhuma.',
      );
    });
  });

  it('interpretarEmail: remetente, Reply-To, encadeamento, texto do HTML sem a citação, automática', async () => {
    const bruto = [
      'From: "Cliente Teste" <Cliente@Ex.com>',
      'To: atendimento@demo.local',
      'Cc: outro@ex.com',
      'Reply-To: respostas@ex.com',
      'Subject: =?UTF-8?Q?Re:_Or=C3=A7amento?=',
      'Message-ID: <abc123@ex.com>',
      'In-Reply-To: <id1@demo.local>',
      'References: <raiz@ex.com> <id1@demo.local>',
      'Auto-Submitted: auto-replied',
      'Date: Thu, 23 Oct 2026 12:00:00 -0300',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Ol&aacute; <b>equipe</b>,</p><p>quero saber mais</p><script>alert(1)</script>',
      '<p>Em qua., 22 de out. de 2026 &agrave;s 10:00, Atendimento escreveu:</p><blockquote>pergunta</blockquote>',
    ].join('\r\n');
    const email = interpretarEmail(await simpleParser(bruto));
    expect(email).toMatchObject({
      messageId: 'abc123@ex.com',
      inReplyTo: 'id1@demo.local',
      references: ['raiz@ex.com', 'id1@demo.local'],
      raiz: 'raiz@ex.com',
      de: { email: 'cliente@ex.com', nome: 'Cliente Teste' },
      responderPara: { email: 'respostas@ex.com', nome: null },
      para: ['atendimento@demo.local'],
      cc: ['outro@ex.com'],
      assunto: 'Re: Orçamento',
      assuntoLimpo: 'Orçamento',
      texto: 'Olá equipe,\n\nquero saber mais',
      automatica: true,
    });
    expect(email.texto).not.toMatch(/alert|<|>/);
    expect(email.textoCompleto).toContain('pergunta');
    expect(email.data?.toISOString()).toBe('2026-10-23T15:00:00.000Z');
  });

  it('lerEmail: multipart só com HTML (e anexo) também vira texto', async () => {
    const bruto = [
      'From: a@x.com',
      'Subject: Com anexo',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Ol&aacute;, <b>tudo bem</b>?</p><style>p{color:red}</style><p>Segue.</p>',
      '--b1',
      'Content-Type: application/pdf; name="p.pdf"',
      'Content-Disposition: attachment; filename="p.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n');
    const lido = await lerEmail(Buffer.from(bruto));
    expect(lido.text).toBe('Olá, tudo bem?\n\nSegue.');
    expect(lido.attachments).toHaveLength(1);
  });

  it('e-mail novo (sem encadeamento): a raiz é o próprio Message-ID', async () => {
    const email = interpretarEmail(
      await simpleParser(
        'From: a@x.com\r\nSubject: Oi\r\nMessage-ID: <novo@x.com>\r\n\r\nTexto puro\r\n',
      ),
    );
    expect(email).toMatchObject({
      raiz: 'novo@x.com',
      inReplyTo: null,
      references: [],
      texto: 'Texto puro',
      textoCompleto: null,
      automatica: false,
    });
  });
});

describe('e-mail (R14) — configuração', () => {
  it('montarConfiguracao usa as portas padrão e o host/usuário do IMAP no SMTP', () => {
    expect(
      montarConfiguracao({
        endereco: ' Atendimento@Empresa.com.br ',
        imap: { host: 'mail.empresa.com.br' },
      }),
    ).toEqual({
      endereco: 'atendimento@empresa.com.br',
      nomeRemetente: null,
      imap: {
        host: 'mail.empresa.com.br',
        porta: 993,
        tls: true,
        usuario: 'atendimento@empresa.com.br',
        pasta: 'INBOX',
      },
      smtp: {
        host: 'mail.empresa.com.br',
        porta: 465,
        seguranca: 'TLS',
        usuario: 'atendimento@empresa.com.br',
      },
      ignorarCertificado: false,
      assinatura: null,
    });
    expect(
      montarConfiguracao({
        endereco: 'a@b.com',
        imap: { host: 'imap.b.com', tls: false },
        smtp: { host: 'smtp.b.com', seguranca: 'STARTTLS', usuario: 'envio' },
      }),
    ).toMatchObject({
      imap: { porta: 143 },
      smtp: { host: 'smtp.b.com', porta: 587, usuario: 'envio' },
    });
    expect(() => montarConfiguracao({ endereco: 'a@b.com', imap: {} })).toThrow(
      expect.objectContaining({ mensagem: 'Informe o servidor IMAP.' }),
    );
  });

  it('lerConfiguracaoEmail é tolerante e lerEstadoEmail ignora valores quebrados', () => {
    expect(lerConfiguracaoEmail(null, 'a@b.com')).toMatchObject({
      endereco: 'a@b.com',
      imap: { porta: 993, tls: true, pasta: 'INBOX', usuario: 'a@b.com' },
      smtp: { seguranca: 'TLS', porta: 465 },
    });
    expect(lerEstadoEmail({ ultimoUid: '3', uidValidity: 9 })).toEqual({
      uidValidity: undefined,
      ultimoUid: undefined,
      ultimaVarreduraEm: undefined,
    });
    expect(lerEstadoEmail({ ultimoUid: 7, uidValidity: '123' })).toMatchObject({
      ultimoUid: 7,
      uidValidity: '123',
    });
  });

  it('senha do SMTP cai na do IMAP; domínio do Message-ID', () => {
    expect(senhaDoSmtp({ senhaImap: 'a' })).toBe('a');
    expect(senhaDoSmtp({ senhaImap: 'a', senhaSmtp: 'b' })).toBe('b');
    expect(dominioDoEndereco('x@Empresa.com.br')).toBe('empresa.com.br');
    expect(dominioDoEndereco('sem-arroba')).toBe('crmbrl.local');
  });

  it('traduz os erros de IMAP/SMTP para a tela', () => {
    expect(traduzirErroDeEmail({ authenticationFailed: true }, 'IMAP')).toEqual(
      {
        mensagem: 'O servidor IMAP recusou o usuário ou a senha do canal.',
        definitivo: true,
      },
    );
    expect(
      traduzirErroDeEmail({ code: 'ECONNREFUSED' }, 'SMTP').definitivo,
    ).toBe(false);
    expect(
      traduzirErroDeEmail(
        { code: 'EENVELOPE', response: '550 mailbox unavailable' },
        'SMTP',
      ),
    ).toEqual({
      mensagem: 'O servidor SMTP recusou o e-mail: 550 mailbox unavailable',
      definitivo: true,
    });
    expect(traduzirErroDeEmail({ responseCode: 421 }, 'SMTP').definitivo).toBe(
      false,
    );
    expect(
      traduzirErroDeEmail({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'IMAP')
        .mensagem,
    ).toMatch(/certificado/);
  });

  it('contatoDoEmail: quem recebe a resposta — o Reply-To, ou o remetente', () => {
    const de = { email: 'nao-responda@site.test', nome: 'Formulário do site' };
    expect(contatoDoEmail({ de, responderPara: null })).toEqual(de);
    expect(
      contatoDoEmail({
        de,
        responderPara: { email: 'carla@cliente.test', nome: null },
      }),
    ).toEqual({ email: 'carla@cliente.test', nome: null });
    // Reply-To igual ao remetente: fica o nome do remetente.
    expect(
      contatoDoEmail({
        de,
        responderPara: { email: 'nao-responda@site.test', nome: null },
      }),
    ).toEqual(de);
    expect(contatoDoEmail({ de: null, responderPara: null })).toBeNull();
  });
});
