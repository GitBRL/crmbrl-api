import {
  CONFIGURACAO_WEBCHAT_PADRAO,
  corDeTextoPara,
  lerConfiguracaoWebchat,
  montarConfiguracaoWebchat,
  normalizarDominio,
  origemPermitida,
  TEXTO_CONSENTIMENTO_PADRAO,
  trechoDeInstalacao,
} from './configuracao-webchat';

describe('configuração do chat do site (R14)', () => {
  describe('normalizarDominio', () => {
    it.each([
      ['www.site.com.br', 'https://www.site.com.br'],
      ['https://www.site.com.br/contato?x=1', 'https://www.site.com.br'],
      ['HTTP://Localhost:8080/', 'http://localhost:8080'],
      ['*.site.com.br', 'https://*.site.com.br'],
      ['https://*.site.com.br:8443', 'https://*.site.com.br:8443'],
      ['http://127.0.0.1:4200', 'http://127.0.0.1:4200'],
    ])('%s → %s', (entrada, esperado) => {
      expect(normalizarDominio(entrada)).toBe(esperado);
    });

    it.each([
      '',
      '   ',
      'ftp://site.com',
      'javascript:alert(1)',
      'https://usuario:senha@site.com',
      'https://si te.com',
      'https://*',
    ])('recusa "%s"', (entrada) => {
      expect(normalizarDominio(entrada)).toBeNull();
    });
  });

  describe('origemPermitida', () => {
    const dominios = [
      'https://www.site.com.br',
      'https://*.loja.com',
      'http://localhost:8080',
    ];

    it('aceita a origem exata (sem diferenciar maiúsculas)', () => {
      expect(origemPermitida('https://www.site.com.br', dominios)).toBe(true);
      expect(origemPermitida('HTTPS://WWW.SITE.COM.BR', dominios)).toBe(true);
      expect(origemPermitida('http://localhost:8080', dominios)).toBe(true);
    });

    it('o curinga vale para subdomínios, não para o domínio puro nem para outro esquema ou porta', () => {
      expect(origemPermitida('https://a.loja.com', dominios)).toBe(true);
      expect(origemPermitida('https://a.b.loja.com', dominios)).toBe(true);
      expect(origemPermitida('https://loja.com', dominios)).toBe(false);
      expect(origemPermitida('http://a.loja.com', dominios)).toBe(false);
      expect(origemPermitida('https://a.loja.com:8443', dominios)).toBe(false);
      expect(origemPermitida('https://maloja.com', dominios)).toBe(false);
    });

    it('recusa outras origens, esquema ou porta diferentes', () => {
      expect(origemPermitida('http://www.site.com.br', dominios)).toBe(false);
      expect(origemPermitida('https://www.site.com.br:444', dominios)).toBe(
        false,
      );
      expect(origemPermitida('https://site.com.br', dominios)).toBe(false);
      expect(
        origemPermitida('https://www.site.com.br.evil.com', dominios),
      ).toBe(false);
      expect(origemPermitida('null', dominios)).toBe(false);
    });
  });

  it('corDeTextoPara escolhe branco em fundo escuro e escuro em fundo claro', () => {
    expect(corDeTextoPara('#2563EB')).toBe('#FFFFFF');
    expect(corDeTextoPara('#000000')).toBe('#FFFFFF');
    expect(corDeTextoPara('#FDE68A')).toBe('#111827');
    expect(corDeTextoPara('#FFFFFF')).toBe('#111827');
  });

  describe('montarConfiguracaoWebchat', () => {
    it('sem nada, devolve a padrão', () => {
      expect(montarConfiguracaoWebchat({})).toEqual({
        configuracao: CONFIGURACAO_WEBCHAT_PADRAO,
      });
    });

    it('normaliza e deduplica os domínios; a cor de texto acompanha a principal', () => {
      const resultado = montarConfiguracaoWebchat({
        dominios: [
          'www.site.com.br',
          'https://www.site.com.br/',
          '*.site.com.br',
        ],
        aparencia: { corPrimaria: '#fde68a', titulo: ' Atendimento ' },
        contato: 'EMAIL',
        urlPrivacidade: 'https://www.site.com.br/privacidade',
      });
      expect(resultado.problemas).toBeUndefined();
      expect(resultado.configuracao).toMatchObject({
        dominios: ['https://www.site.com.br', 'https://*.site.com.br'],
        aparencia: {
          titulo: 'Atendimento',
          corPrimaria: '#FDE68A',
          corTextoPrimaria: '#111827',
        },
        contato: 'EMAIL',
        urlPrivacidade: 'https://www.site.com.br/privacidade',
      });
    });

    it('junta com a atual: o que não veio continua', () => {
      const atual = montarConfiguracaoWebchat({
        dominios: ['https://a.com'],
        permitirAnexos: false,
      }).configuracao!;
      const resultado = montarConfiguracaoWebchat(
        { aparencia: { tema: 'escuro' }, textoConsentimento: null },
        atual,
      );
      expect(resultado.configuracao).toMatchObject({
        dominios: ['https://a.com'],
        permitirAnexos: false,
        aparencia: { tema: 'escuro' },
        textoConsentimento: TEXTO_CONSENTIMENTO_PADRAO,
      });
    });

    it('lista todos os problemas, com o campo', () => {
      const resultado = montarConfiguracaoWebchat({
        dominios: ['https://ok.com', 'ftp://ruim'],
        aparencia: {
          corPrimaria: 'azul',
          tema: 'rosa',
          posicao: 'topo',
          titulo: '  ',
        },
        contato: 'FAX',
        urlPrivacidade: 'javascript:alert(1)',
      });
      expect(resultado.problemas?.map(({ campo }) => campo)).toEqual([
        'dominios.1',
        'aparencia.titulo',
        'aparencia.corPrimaria',
        'aparencia.tema',
        'aparencia.posicao',
        'contato',
        'urlPrivacidade',
      ]);
    });
  });

  it('lerConfiguracaoWebchat completa o que falta e ignora o que está quebrado', () => {
    expect(lerConfiguracaoWebchat(null)).toEqual(CONFIGURACAO_WEBCHAT_PADRAO);
    const lida = lerConfiguracaoWebchat({
      dominios: ['https://a.com', 3],
      aparencia: { corPrimaria: 'verde', tema: 'neon', titulo: '' },
      contato: 'TELEFONE',
      urlPrivacidade: 'javascript:x',
      permitirAnexos: 'sim',
    });
    expect(lida).toMatchObject({
      dominios: ['https://a.com'],
      contato: 'TELEFONE',
      urlPrivacidade: null,
      permitirAnexos: true,
      aparencia: {
        corPrimaria: CONFIGURACAO_WEBCHAT_PADRAO.aparencia.corPrimaria,
        tema: 'automatico',
        titulo: CONFIGURACAO_WEBCHAT_PADRAO.aparencia.titulo,
      },
    });
  });

  it('trechoDeInstalacao monta o <script> com a chave', () => {
    expect(
      trechoDeInstalacao(
        'https://crm.x/api/v1/publico/webchat/widget.js',
        'wc_abc12345',
      ),
    ).toBe(
      '<script src="https://crm.x/api/v1/publico/webchat/widget.js" data-chave="wc_abc12345" async></script>',
    );
  });
});
