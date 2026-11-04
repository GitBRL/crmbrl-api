import { generateVAPIDKeys } from 'web-push';
import {
  AmbienteInvalidoError,
  CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO,
  lerAmbiente,
  META_GRAPH_URL_PADRAO,
  META_GRAPH_VERSAO_PADRAO,
  PORTA_PADRAO,
  PORTA_PADRAO_GATEWAY_WHATSAPP,
  TOKEN_INTERNO_DESENVOLVIMENTO,
  URL_PUBLICA_DESENVOLVIMENTO,
  type VariaveisDeAmbiente,
} from './ambiente';

const URL_DO_BANCO =
  'postgresql://crmbrl:senha-secreta@localhost:5434/crmbrl?schema=public';

/** 32 bytes em base64 (só para teste). */
const CHAVE_BASE64 = Buffer.alloc(32, 7).toString('base64');

/** Token interno de teste (32+ caracteres). */
const TOKEN_INTERNO = 't'.repeat(40);

/** O mínimo para subir em produção. */
const PRODUCAO: VariaveisDeAmbiente = {
  DATABASE_URL: URL_DO_BANCO,
  NODE_ENV: 'production',
  URL_PUBLICA: 'https://crm.brl.com.br',
  CHAVE_CRIPTOGRAFIA: CHAVE_BASE64,
  ARQUIVOS_ENDPOINT: 'http://arquivos:9000',
  ARQUIVOS_CHAVE: 'crmbrl',
  ARQUIVOS_SEGREDO: 'segredo-do-minio',
  WHATSAPP_TOKEN_INTERNO: TOKEN_INTERNO,
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
  it('R27 — BACKUP_DIR troca a pasta dos backups lida pela saúde', () => {
    expect(ler({ BACKUP_DIR: ' /dados/backups ' }).backupDir).toBe(
      '/dados/backups',
    );
  });

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
      arquivos: {
        driver: 's3',
        endpoint: 'http://localhost:9000',
        regiao: 'us-east-1',
        chave: null,
        segredo: null,
        bucket: 'crmbrl',
      },
      whatsapp: {
        urlInterna: `http://localhost:${PORTA_PADRAO_GATEWAY_WHATSAPP}`,
        tokenInterno: TOKEN_INTERNO_DESENVOLVIMENTO,
        simulado: false,
        porta: PORTA_PADRAO_GATEWAY_WHATSAPP,
      },
      meta: {
        graphUrl: META_GRAPH_URL_PADRAO,
        graphVersao: META_GRAPH_VERSAO_PADRAO,
        dialogoUrl: 'https://www.facebook.com',
      },
      integracoes: {
        typeformUrl: 'https://api.typeform.com',
        manychatUrl: 'https://api.manychat.com',
      },
      ligacoes: { stunUrls: [], esperaPreAceiteMs: 800 },
      transcricao: {
        url: null,
        modelo: 'small',
        tempoLimiteSegundos: 1800,
        gravacaoMaxBytes: 200 * 1024 * 1024,
        gravacaoMaxMinutos: 180,
        resumoModelo: 'claude-sonnet-5-5',
      },
      anthropic: { configurada: false, urlBase: null },
      ticketHub: {
        url: null,
        email: null,
        senhaDefinida: false,
        configurado: false,
        senha: expect.any(Function),
      },
      push: {
        configurada: false,
        chavePublica: null,
        assunto: null,
        chavePrivada: expect.any(Function),
      },
      backupDir: '/backups',
      avisos: [
        'CHAVE_CRIPTOGRAFIA não definida: usando a chave de desenvolvimento (não use em produção).',
        expect.stringContaining(
          'ARQUIVOS_CHAVE e ARQUIVOS_SEGREDO não definida',
        ),
        expect.stringContaining('WHATSAPP_TOKEN_INTERNO não definido'),
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

    it('exige URL_PUBLICA, CHAVE_CRIPTOGRAFIA, as credenciais do MinIO e o token interno', () => {
      const problemas = problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        NODE_ENV: 'production',
      });
      expect(problemas).toEqual([
        expect.stringContaining('URL_PUBLICA é obrigatória em produção'),
        expect.stringContaining('CHAVE_CRIPTOGRAFIA é obrigatória em produção'),
        expect.stringContaining(
          'ARQUIVOS_CHAVE e ARQUIVOS_SEGREDO: obrigatória(s) em produção',
        ),
        expect.stringContaining(
          'WHATSAPP_TOKEN_INTERNO é obrigatório em produção',
        ),
      ]);
    });

    it('em produção, sem ARQUIVOS_ENDPOINT, usa o endereço padrão da AWS', () => {
      const { ARQUIVOS_ENDPOINT: _, ...semEndpoint } = PRODUCAO;
      expect(lerAmbiente(semEndpoint).arquivos.endpoint).toBeNull();
    });

    it('avisa do driver de arquivos em memória e do token interno de desenvolvimento', () => {
      const ambiente = lerAmbiente({
        ...PRODUCAO,
        ARQUIVOS_DRIVER: 'memoria',
        WHATSAPP_TOKEN_INTERNO: TOKEN_INTERNO_DESENVOLVIMENTO,
      });
      expect(ambiente.avisos).toEqual([
        expect.stringContaining('ARQUIVOS_DRIVER=memoria em produção'),
        expect.stringContaining('token público de desenvolvimento'),
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

  describe('Onda A: arquivos, WhatsApp e Meta', () => {
    it('lê o armazenamento de arquivos (R11), sem barra no fim do endereço', () => {
      const ambiente = ler({
        ARQUIVOS_DRIVER: 'S3',
        ARQUIVOS_ENDPOINT: 'http://arquivos:9000/',
        ARQUIVOS_REGIAO: 'sa-east-1',
        ARQUIVOS_CHAVE: 'crmbrl',
        ARQUIVOS_SEGREDO: ' segredo ',
        ARQUIVOS_BUCKET: 'crmbrl-arquivos',
      });
      expect(ambiente.arquivos).toEqual({
        driver: 's3',
        endpoint: 'http://arquivos:9000',
        regiao: 'sa-east-1',
        chave: 'crmbrl',
        segredo: 'segredo',
        bucket: 'crmbrl-arquivos',
      });
      expect(ambiente.avisos).not.toContainEqual(
        expect.stringContaining('ARQUIVOS_'),
      );
    });

    it('aceita o driver em memória sem credenciais e recusa driver e bucket inválidos', () => {
      expect(ler({ ARQUIVOS_DRIVER: 'memoria' }).arquivos.driver).toBe(
        'memoria',
      );
      expect(
        problemasDe({
          DATABASE_URL: URL_DO_BANCO,
          ARQUIVOS_DRIVER: 'disco',
          ARQUIVOS_BUCKET: 'Bucket_Errado',
          ARQUIVOS_ENDPOINT: 'ftp://arquivos',
        }),
      ).toEqual([
        'ARQUIVOS_DRIVER precisa ser s3 ou memoria (recebido: "disco").',
        'ARQUIVOS_ENDPOINT precisa ser um endereço http(s) (recebido: "ftp://arquivos").',
        expect.stringContaining('ARQUIVOS_BUCKET precisa ter de 3 a 63'),
      ]);
    });

    it('recusa credenciais dentro do endereço do MinIO', () => {
      expect(
        problemasDe({
          DATABASE_URL: URL_DO_BANCO,
          ARQUIVOS_ENDPOINT: 'http://usuario:senha@arquivos:9000',
        }),
      ).toEqual([expect.stringContaining('não pode levar usuário e senha')]);
    });

    it('lê o gateway de WhatsApp (R13)', () => {
      const ambiente = ler({
        WHATSAPP_URL_INTERNA: 'http://whatsapp:3100/',
        WHATSAPP_TOKEN_INTERNO: TOKEN_INTERNO,
        WHATSAPP_SIMULADO: 'true',
        WHATSAPP_PORTA: '3999',
      });
      expect(ambiente.whatsapp).toEqual({
        urlInterna: 'http://whatsapp:3100',
        tokenInterno: TOKEN_INTERNO,
        simulado: true,
        porta: 3999,
      });
      expect(ler({ WHATSAPP_PORTA: '3999' }).whatsapp.urlInterna).toBe(
        'http://localhost:3999',
      );
    });

    it('recusa token interno curto sem mostrar o valor, e porta inválida', () => {
      const problemas = problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        WHATSAPP_TOKEN_INTERNO: 'curto-demais',
        WHATSAPP_PORTA: '70000',
      });
      expect(problemas).toEqual([
        expect.stringContaining('WHATSAPP_PORTA precisa ser um número inteiro'),
        expect.stringContaining(
          'WHATSAPP_TOKEN_INTERNO precisa ter pelo menos 32 caracteres',
        ),
      ]);
      expect(problemas.join(' ')).not.toContain('curto-demais');
    });

    it('lê a Graph API da Meta (R14) e recusa versão fora do formato', () => {
      expect(
        ler({
          META_GRAPH_URL: 'http://apoio:8091/',
          META_GRAPH_VERSAO: 'v23.0',
          META_DIALOGO_URL: 'http://127.0.0.1:3296/',
        }).meta,
      ).toEqual({
        graphUrl: 'http://apoio:8091',
        graphVersao: 'v23.0',
        dialogoUrl: 'http://127.0.0.1:3296',
      });
      expect(
        problemasDe({ DATABASE_URL: URL_DO_BANCO, META_GRAPH_VERSAO: '24' }),
      ).toEqual([expect.stringContaining('META_GRAPH_VERSAO precisa ter')]);
    });
  });

  it('R30 — transcrição: URL vazia desliga; limites e modelos validados', () => {
    expect(ler({ TRANSCRICAO_URL: '  ' }).transcricao.url).toBeNull();
    const ligada = ler({
      TRANSCRICAO_URL: 'http://transcricao:8080/',
      WHISPER_MODELO: 'large-v3-turbo-q5_0',
      TRANSCRICAO_TEMPO_LIMITE_S: '600',
      LIGACOES_GRAVACAO_MAX_MB: '50',
      LIGACOES_GRAVACAO_MAX_MIN: '60',
      LIGACOES_RESUMO_MODELO: 'claude-haiku-5-5',
    }).transcricao;
    expect(ligada).toEqual({
      url: 'http://transcricao:8080',
      modelo: 'large-v3-turbo-q5_0',
      tempoLimiteSegundos: 600,
      gravacaoMaxBytes: 50 * 1024 * 1024,
      gravacaoMaxMinutos: 60,
      resumoModelo: 'claude-haiku-5-5',
    });
    expect(
      problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        TRANSCRICAO_URL: 'ftp://x',
        WHISPER_MODELO: '../etc/passwd',
        TRANSCRICAO_TEMPO_LIMITE_S: '5',
        LIGACOES_GRAVACAO_MAX_MB: '0',
        LIGACOES_GRAVACAO_MAX_MIN: 'muito',
        LIGACOES_RESUMO_MODELO: 'a b',
      }),
    ).toEqual([
      expect.stringContaining('TRANSCRICAO_URL precisa ser'),
      expect.stringContaining('WHISPER_MODELO precisa ter'),
      expect.stringContaining('TRANSCRICAO_TEMPO_LIMITE_S precisa ser'),
      expect.stringContaining('LIGACOES_GRAVACAO_MAX_MB precisa ser'),
      expect.stringContaining('LIGACOES_GRAVACAO_MAX_MIN precisa ser'),
      expect.stringContaining('LIGACOES_RESUMO_MODELO precisa ter'),
    ]);
  });

  it('R21 — Anthropic: só a presença da chave, nunca o valor; base opcional', () => {
    const ambiente = ler({
      ANTHROPIC_API_KEY: '  chave-de-teste-que-nao-pode-vazar  ',
      ANTHROPIC_BASE_URL: 'http://apoio:8092/',
    });
    expect(ambiente.anthropic).toEqual({
      configurada: true,
      urlBase: 'http://apoio:8092',
    });
    expect(JSON.stringify(ambiente)).not.toContain('nao-pode-vazar');
    expect(ler({ ANTHROPIC_API_KEY: '   ' }).anthropic.configurada).toBe(false);
    expect(
      problemasDe({
        DATABASE_URL: URL_DO_BANCO,
        ANTHROPIC_BASE_URL: 'ftp://x',
      }),
    ).toEqual([expect.stringContaining('ANTHROPIC_BASE_URL precisa ser')]);
  });

  it('R25 — TicketHub: senha só pela função (fora do JSON), URL normalizada', () => {
    const ambiente = ler({
      TICKETHUB_URL: 'http://apoio:8093/',
      TICKETHUB_EMAIL: ' Conta@TicketHub.local ',
      TICKETHUB_SENHA: 'senha-que-nao-pode-vazar',
    });
    expect(ambiente.ticketHub).toMatchObject({
      url: 'http://apoio:8093',
      email: 'conta@tickethub.local',
      senhaDefinida: true,
      configurado: true,
    });
    expect(ambiente.ticketHub.senha()).toBe('senha-que-nao-pode-vazar');
    expect(JSON.stringify(ambiente)).not.toContain('nao-pode-vazar');
    expect(ler({ TICKETHUB_URL: 'http://x' }).ticketHub.configurado).toBe(
      false,
    );
  });

  it('R26 — VAPID: as três variáveis ligam o push; a chave privada só sai pela função', () => {
    const chaves = generateVAPIDKeys();
    const ambiente = ler({
      VAPID_CHAVE_PUBLICA: chaves.publicKey,
      VAPID_CHAVE_PRIVADA: chaves.privateKey,
      VAPID_ASSUNTO: 'mailto:ti@brl.com.br',
    });
    expect(ambiente.push).toMatchObject({
      configurada: true,
      chavePublica: chaves.publicKey,
      assunto: 'mailto:ti@brl.com.br',
    });
    expect(ambiente.push.chavePrivada()).toBe(chaves.privateKey);
    expect(JSON.stringify(ambiente)).not.toContain(chaves.privateKey);
  });

  it('R26 — VAPID incompleta desliga o push com aviso; malformada impede a subida sem repetir o valor', () => {
    const chaves = generateVAPIDKeys();
    const parcial = ler({ VAPID_CHAVE_PUBLICA: chaves.publicKey });
    expect(parcial.push.configurada).toBe(false);
    expect(parcial.avisos.join(' ')).toContain('VAPID_CHAVE_PRIVADA');
    const problemas = problemasDe({
      DATABASE_URL: URL_DO_BANCO,
      VAPID_CHAVE_PUBLICA: 'curta',
      VAPID_CHAVE_PRIVADA: 'segredo-invalido',
      VAPID_ASSUNTO: 'ti@brl.com.br',
    });
    expect(problemas).toHaveLength(3);
    expect(problemas.join(' ')).not.toContain('segredo-invalido');
  });

  it('lê o formato do log', () => {
    expect(ler({ LOG_FORMATO: 'JSON' }).logFormato).toBe('json');
    expect(
      problemasDe({ DATABASE_URL: URL_DO_BANCO, LOG_FORMATO: 'xml' }),
    ).toHaveLength(1);
  });
});
