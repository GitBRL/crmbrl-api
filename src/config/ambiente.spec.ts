import {
  AmbienteInvalidoError,
  CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO,
  lerAmbiente,
  PORTA_PADRAO,
  URL_PUBLICA_DESENVOLVIMENTO,
  type VariaveisDeAmbiente,
} from './ambiente';

const URL_DO_BANCO =
  'postgresql://crmbrl:senha-secreta@localhost:5434/crmbrl?schema=public';

/** 32 bytes em base64 (só para teste). */
const CHAVE_BASE64 = Buffer.alloc(32, 7).toString('base64');

/** O mínimo para subir em produção. */
const PRODUCAO: VariaveisDeAmbiente = {
  DATABASE_URL: URL_DO_BANCO,
  NODE_ENV: 'production',
  URL_PUBLICA: 'https://crm.brl.com.br',
  CHAVE_CRIPTOGRAFIA: CHAVE_BASE64,
};

function ler(variaveis: VariaveisDeAmbiente) {
  return lerAmbiente({ DATABASE_URL: URL_DO_BANCO, ...variaveis });
}

function problemasDe(variaveis: VariaveisDeAmbiente): readonly string[] {
  try {
    lerAmbiente(variaveis);
  } catch (erro) {
    if (erro instanceof AmbienteInvalidoError) {
      return erro.problemas;
    }
    throw erro;
  }
  throw new Error('lerAmbiente deveria ter falhado');
}

describe('lerAmbiente', () => {
  it('usa os padrões de desenvolvimento quando só a DATABASE_URL está definida', () => {
    expect(ler({})).toEqual({
      databaseUrl: URL_DO_BANCO,
      porta: PORTA_PADRAO,
      nodeEnv: 'development',
      producao: false,
      corsOrigens: [],
      observe: null,
      urlPublica: URL_PUBLICA_DESENVOLVIMENTO,
      origensPermitidas: ['http://localhost:4200'],
      cookieSeguro: false,
      chaveCriptografia: CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO,
      sessao: {
        inatividadeDias: 7,
        duracaoMaximaDias: 30,
        renovacaoMinutos: 5,
      },
      admin: null,
      smtp: null,
      webhooksPermitirRedeInterna: false,
      docsPublicas: true,
      processarFilas: true,
      logFormato: 'texto',
      avisos: [
        'CHAVE_CRIPTOGRAFIA não definida: usando a chave de desenvolvimento (não use em produção).',
      ],
    });
  });

  it('devolve um objeto congelado', () => {
    expect(Object.isFrozen(ler({}))).toBe(true);
  });

  it('exige a DATABASE_URL, com uma mensagem que diz o que fazer', () => {
    expect(() => lerAmbiente({})).toThrow(AmbienteInvalidoError);
    expect(() => lerAmbiente({ DATABASE_URL: '   ' })).toThrow(
      /DATABASE_URL é obrigatória[\s\S]*postgresql:\/\//,
    );
    expect(() => lerAmbiente({})).toThrow(/\.env\.example/);
  });

  it('recusa DATABASE_URL que não é do PostgreSQL sem repetir o valor (ele tem a senha)', () => {
    const problemas = problemasDe({
      DATABASE_URL: 'mysql://root:senha-secreta@localhost/crm',
    });
    expect(problemas).toEqual([
      'DATABASE_URL precisa começar com postgresql://.',
    ]);
    expect(problemasDe({ DATABASE_URL: 'senha-secreta' })).toEqual([
      'DATABASE_URL não é uma URL válida.',
    ]);
  });

  it('aceita o prefixo postgres:// também', () => {
    expect(
      ler({ DATABASE_URL: 'postgres://a:b@banco:5432/c' }).databaseUrl,
    ).toBe('postgres://a:b@banco:5432/c');
  });

  it('lê a PORT e recusa valores fora da faixa', () => {
    expect(ler({ PORT: ' 8081 ' }).porta).toBe(8081);
    for (const porta of ['0', '65536', '3000.5', 'abc', '-1']) {
      expect(problemasDe({ DATABASE_URL: URL_DO_BANCO, PORT: porta })).toEqual([
        `PORT precisa ser um número inteiro entre 1 e 65535 (recebido: "${porta}").`,
      ]);
    }
  });

  it('separa as origens do CORS por vírgula, normalizando e sem repetir', () => {
    expect(
      ler({
        CORS_ORIGENS:
          ' http://localhost:4200 , https://crm.brl.com.br/,,http://localhost:4200',
      }).corsOrigens,
    ).toEqual(['http://localhost:4200', 'https://crm.brl.com.br']);
  });

  it('recusa no CORS o que não é origem', () => {
    expect(
      problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        CORS_ORIGENS: 'localhost:4200,http://localhost:4200/app,*',
      }),
    ).toHaveLength(3);
  });

  it('lista todos os problemas de uma vez', () => {
    expect(problemasDe({ PORT: 'x', CORS_ORIGENS: 'y' })).toHaveLength(3);
  });

  it('liga o Observe só com as duas chaves', () => {
    expect(
      ler({ OBSERVE_APP_KEY: 'chave', OBSERVE_APP_SECRET: 'segredo' }).observe,
    ).toEqual({ appKey: 'chave', appSecret: 'segredo' });
    expect(ler({ OBSERVE_APP_KEY: '', OBSERVE_APP_SECRET: '' }).observe).toBe(
      null,
    );
  });

  it('avisa quando só uma das chaves do Observe foi definida', () => {
    const ambiente = ler({ OBSERVE_APP_KEY: 'chave' });
    expect(ambiente.observe).toBeNull();
    expect(ambiente.avisos).toContain(
      'OBSERVE_APP_SECRET não definida: o @nestjs/observe fica desligado (ele precisa das duas chaves).',
    );
  });

  describe('produção', () => {
    it('sobe com o mínimo e liga os padrões seguros', () => {
      const ambiente = lerAmbiente(PRODUCAO);
      expect(ambiente).toMatchObject({
        producao: true,
        urlPublica: 'https://crm.brl.com.br',
        origensPermitidas: ['https://crm.brl.com.br'],
        cookieSeguro: true,
        docsPublicas: false,
        logFormato: 'json',
        avisos: [],
      });
      expect(ambiente.chaveCriptografia).toEqual(Buffer.alloc(32, 7));
    });

    it('exige URL_PUBLICA e CHAVE_CRIPTOGRAFIA', () => {
      const problemas = problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        NODE_ENV: 'production',
      });
      expect(problemas).toEqual([
        expect.stringContaining('URL_PUBLICA é obrigatória em produção'),
        expect.stringContaining('CHAVE_CRIPTOGRAFIA é obrigatória em produção'),
      ]);
    });

    it('avisa se a chave de criptografia for a pública de desenvolvimento', () => {
      const ambiente = lerAmbiente({
        ...PRODUCAO,
        CHAVE_CRIPTOGRAFIA: CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO.toString('hex'),
      });
      expect(ambiente.avisos).toEqual([
        expect.stringContaining('chave pública de desenvolvimento'),
      ]);
    });

    it('permite COOKIE_SEGURO=false para o compose local em http', () => {
      expect(
        lerAmbiente({ ...PRODUCAO, COOKIE_SEGURO: 'false' }).cookieSeguro,
      ).toBe(false);
    });
  });

  it('aceita a chave em hexadecimal e recusa tamanho errado sem mostrar o valor', () => {
    expect(
      ler({ CHAVE_CRIPTOGRAFIA: 'ab'.repeat(32) }).chaveCriptografia,
    ).toEqual(Buffer.alloc(32, 0xab));
    const problemas = problemasDe({
      DATABASE_URL: URL_DO_BANCO,
      CHAVE_CRIPTOGRAFIA: 'segredo-curto',
    });
    expect(problemas).toEqual([
      expect.stringContaining('CHAVE_CRIPTOGRAFIA precisa ter 32 bytes'),
    ]);
    expect(problemas.join()).not.toContain('segredo-curto');
  });

  it('usa ORIGENS_PERMITIDAS quando definida, normalizando (R2.9)', () => {
    expect(
      ler({
        ORIGENS_PERMITIDAS: 'http://localhost:8080/, http://localhost:4200',
      }).origensPermitidas,
    ).toEqual(['http://localhost:8080', 'http://localhost:4200']);
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, ORIGENS_PERMITIDAS: '*' }),
    ).toEqual([
      expect.stringContaining('ORIGENS_PERMITIDAS: "*" não é uma origem'),
    ]);
  });

  it('tira a barra do fim da URL_PUBLICA e deriva dela a origem permitida', () => {
    const ambiente = ler({ URL_PUBLICA: 'http://localhost:8080/' });
    expect(ambiente.urlPublica).toBe('http://localhost:8080');
    expect(ambiente.origensPermitidas).toEqual(['http://localhost:8080']);
  });

  it('lê os prazos da sessão (R2.2) e recusa inatividade maior que a duração máxima', () => {
    expect(
      ler({
        SESSAO_INATIVIDADE_DIAS: '2',
        SESSAO_DURACAO_MAXIMA_DIAS: '10',
        SESSAO_RENOVACAO_MINUTOS: '1',
      }).sessao,
    ).toEqual({
      inatividadeDias: 2,
      duracaoMaximaDias: 10,
      renovacaoMinutos: 1,
    });
    expect(
      problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        SESSAO_INATIVIDADE_DIAS: '31',
      }),
    ).toEqual([
      expect.stringContaining('SESSAO_INATIVIDADE_DIAS não pode ser maior'),
    ]);
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, SESSAO_INATIVIDADE_DIAS: '0' }),
    ).toHaveLength(1);
  });

  it('lê o Admin inicial (R2.6), normalizando o e-mail e com nome padrão', () => {
    expect(
      ler({
        ADMIN_EMAIL: ' Admin@BRL.com.br ',
        ADMIN_SENHA_INICIAL: 'segredo123',
      }).admin,
    ).toEqual({
      email: 'admin@brl.com.br',
      nome: 'Administrador',
      senhaInicial: 'segredo123',
    });
    expect(
      ler({ ADMIN_EMAIL: 'admin@brl.com.br' }).admin?.senhaInicial,
    ).toBeNull();
    const problemas = problemasDe({
      DATABASE_URL: URL_DO_BANCO,
      ADMIN_EMAIL: 'admin@brl.com.br',
      ADMIN_SENHA_INICIAL: 'curta',
    });
    expect(problemas).toEqual([
      'ADMIN_SENHA_INICIAL precisa ter de 8 a 128 caracteres.',
    ]);
  });

  it('liga o SMTP só com SMTP_HOST e exige o remetente', () => {
    expect(ler({}).smtp).toBeNull();
    expect(
      ler({
        SMTP_HOST: 'smtp.brl.com.br',
        SMTP_PORTA: '465',
        SMTP_USUARIO: 'crm',
        SMTP_SENHA: 'x',
        SMTP_REMETENTE: 'BRL CRM <crm@brl.com.br>',
      }).smtp,
    ).toEqual({
      host: 'smtp.brl.com.br',
      porta: 465,
      seguro: true,
      usuario: 'crm',
      senha: 'x',
      remetente: 'BRL CRM <crm@brl.com.br>',
    });
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, SMTP_HOST: 'smtp.x' }),
    ).toEqual([expect.stringContaining('SMTP_REMETENTE é obrigatório')]);
  });

  it('lê os booleanos e recusa valores estranhos', () => {
    const ambiente = ler({
      WEBHOOKS_PERMITIR_REDE_INTERNA: 'true',
      DOCS_PUBLICAS: 'false',
      PROCESSAR_FILAS: '0',
    });
    expect(ambiente.webhooksPermitirRedeInterna).toBe(true);
    expect(ambiente.docsPublicas).toBe(false);
    expect(ambiente.processarFilas).toBe(false);
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, PROCESSAR_FILAS: 'talvez' }),
    ).toEqual([
      'PROCESSAR_FILAS precisa ser true ou false (recebido: "talvez").',
    ]);
  });

  it('lê o formato do log', () => {
    expect(ler({ LOG_FORMATO: 'JSON' }).logFormato).toBe('json');
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, LOG_FORMATO: 'xml' }),
    ).toHaveLength(1);
  });
});
