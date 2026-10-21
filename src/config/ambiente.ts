/**
 * Variáveis de ambiente da API: leitura e validação num lugar só, sem
 * bibliotecas.
 *
 * O `main.ts` chama `lerAmbiente()` uma vez, depois de carregar o `.env` (quando
 * ele existe). O resultado circula pela injeção de dependência com o token
 * `AMBIENTE` — nenhum outro arquivo de `src/` lê `process.env`.
 */
import { createHash } from 'node:crypto';

/** Token de injeção do ambiente já validado. */
export const AMBIENTE = Symbol('AMBIENTE');

export const PORTA_PADRAO = 3000;

/** URL do front em desenvolvimento (`ng serve`), quando `URL_PUBLICA` não vem. */
export const URL_PUBLICA_DESENVOLVIMENTO = 'http://localhost:4200';

/**
 * Chave de criptografia de desenvolvimento, derivada de um texto fixo e público.
 * Só é usada fora de produção quando `CHAVE_CRIPTOGRAFIA` não vem — e em
 * produção ela gera aviso, porque qualquer um pode recalculá-la.
 */
export const CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO = createHash('sha256')
  .update('crmbrl-chave-de-desenvolvimento-nao-use-em-producao')
  .digest();

export interface ConfiguracaoSessao {
  /** Sem uso por tanto tempo, a sessão expira (R2.2, padrão 7 dias). */
  readonly inatividadeDias: number;
  /** Em qualquer caso, a sessão expira tanto tempo depois do login (R2.2, padrão 30 dias). */
  readonly duracaoMaximaDias: number;
  /** A renovação da validade é gravada no máximo uma vez neste intervalo (R2.2, padrão 5 min). */
  readonly renovacaoMinutos: number;
}

export interface ConfiguracaoAdminInicial {
  readonly email: string;
  readonly nome: string;
  /** `null`: a API gera uma senha aleatória e a mostra uma vez no log. */
  readonly senhaInicial: string | null;
}

export interface ConfiguracaoSmtp {
  readonly host: string;
  readonly porta: number;
  /** TLS desde a conexão (porta 465). Com `false`, usa STARTTLS quando o servidor oferece. */
  readonly seguro: boolean;
  readonly usuario: string | null;
  readonly senha: string | null;
  /** Remetente, ex.: `BRL CRM <crm@brl.com.br>`. */
  readonly remetente: string;
}

export interface Ambiente {
  /** Conexão com o PostgreSQL (`DATABASE_URL`). Carrega a senha: nunca vai para log nem resposta. */
  readonly databaseUrl: string;
  /** Porta HTTP (`PORT`, padrão 3000). */
  readonly porta: number;
  /** `NODE_ENV` (padrão `development`). Aparece no campo `ambiente` de `GET /api/saude`. */
  readonly nodeEnv: string;
  /** `NODE_ENV=production`. */
  readonly producao: boolean;
  /** Origens liberadas no CORS (`CORS_ORIGENS`). Lista vazia: CORS desligado. */
  readonly corsOrigens: readonly string[];
  /** Chaves do `@nestjs/observe`; `null` quando falta alguma (observabilidade desligada). */
  readonly observe: {
    readonly appKey: string;
    readonly appSecret: string;
  } | null;
  /** Endereço público do CRM (`URL_PUBLICA`), base dos links de e-mail e dos endereços de webhook. */
  readonly urlPublica: string;
  /** Origens aceitas em requisições que alteram dados (`ORIGENS_PERMITIDAS`, R2.9). */
  readonly origensPermitidas: readonly string[];
  /** Cookie de sessão com `Secure` (`COOKIE_SEGURO`; padrão: só em produção). */
  readonly cookieSeguro: boolean;
  /** Chave AES-256-GCM dos segredos (`CHAVE_CRIPTOGRAFIA`, 32 bytes, R10.3). */
  readonly chaveCriptografia: Buffer;
  readonly sessao: ConfiguracaoSessao;
  /** Admin criado quando o banco não tem nenhum usuário (R2.6); `null` sem `ADMIN_EMAIL`. */
  readonly admin: ConfiguracaoAdminInicial | null;
  /** Servidor de e-mail; `null` sem `SMTP_HOST` (convite e "esqueci a senha" ficam indisponíveis, R2.8). */
  readonly smtp: ConfiguracaoSmtp | null;
  /** Webhooks de saída podem chamar endereços de rede interna (`WEBHOOKS_PERMITIR_REDE_INTERNA`, R9.1). */
  readonly webhooksPermitirRedeInterna: boolean;
  /** Documentação em `/api/docs` aberta a todos (`DOCS_PUBLICAS`; padrão: fora de produção). */
  readonly docsPublicas: boolean;
  /** Trabalhadores da fila, agendamentos e despachante de eventos ligados (`PROCESSAR_FILAS`). */
  readonly processarFilas: boolean;
  /** Formato do log no console (`LOG_FORMATO`: `json` ou `texto`; padrão `json` em produção). */
  readonly logFormato: 'json' | 'texto';
  /** Problemas que não impedem a API de subir, para o log da inicialização. */
  readonly avisos: readonly string[];
}

/** As variáveis que a API lê. Ficam todas aqui para ser fácil saber o que é usado. */
export interface VariaveisDeAmbiente {
  DATABASE_URL?: string;
  PORT?: string;
  NODE_ENV?: string;
  CORS_ORIGENS?: string;
  OBSERVE_APP_KEY?: string;
  OBSERVE_APP_SECRET?: string;
  URL_PUBLICA?: string;
  ORIGENS_PERMITIDAS?: string;
  COOKIE_SEGURO?: string;
  CHAVE_CRIPTOGRAFIA?: string;
  SESSAO_INATIVIDADE_DIAS?: string;
  SESSAO_DURACAO_MAXIMA_DIAS?: string;
  SESSAO_RENOVACAO_MINUTOS?: string;
  ADMIN_EMAIL?: string;
  ADMIN_NOME?: string;
  ADMIN_SENHA_INICIAL?: string;
  SMTP_HOST?: string;
  SMTP_PORTA?: string;
  SMTP_SEGURO?: string;
  SMTP_USUARIO?: string;
  SMTP_SENHA?: string;
  SMTP_REMETENTE?: string;
  WEBHOOKS_PERMITIR_REDE_INTERNA?: string;
  DOCS_PUBLICAS?: string;
  PROCESSAR_FILAS?: string;
  LOG_FORMATO?: string;
}

const NOMES_DAS_VARIAVEIS: readonly (keyof VariaveisDeAmbiente)[] = [
  'DATABASE_URL',
  'PORT',
  'NODE_ENV',
  'CORS_ORIGENS',
  'OBSERVE_APP_KEY',
  'OBSERVE_APP_SECRET',
  'URL_PUBLICA',
  'ORIGENS_PERMITIDAS',
  'COOKIE_SEGURO',
  'CHAVE_CRIPTOGRAFIA',
  'SESSAO_INATIVIDADE_DIAS',
  'SESSAO_DURACAO_MAXIMA_DIAS',
  'SESSAO_RENOVACAO_MINUTOS',
  'ADMIN_EMAIL',
  'ADMIN_NOME',
  'ADMIN_SENHA_INICIAL',
  'SMTP_HOST',
  'SMTP_PORTA',
  'SMTP_SEGURO',
  'SMTP_USUARIO',
  'SMTP_SENHA',
  'SMTP_REMETENTE',
  'WEBHOOKS_PERMITIR_REDE_INTERNA',
  'DOCS_PUBLICAS',
  'PROCESSAR_FILAS',
  'LOG_FORMATO',
];

export function variaveisDoProcesso(): VariaveisDeAmbiente {
  const variaveis: VariaveisDeAmbiente = {};
  for (const nome of NOMES_DAS_VARIAVEIS) {
    variaveis[nome] = process.env[nome];
  }
  return variaveis;
}

/** Configuração que impede a API de subir. A mensagem lista todos os problemas de uma vez. */
export class AmbienteInvalidoError extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(
      [
        'Variáveis de ambiente inválidas (veja o modelo em .env.example):',
        ...problemas.map((problema) => `  - ${problema}`),
      ].join('\n'),
    );
    this.name = 'AmbienteInvalidoError';
  }
}

export function lerAmbiente(
  variaveis: VariaveisDeAmbiente = variaveisDoProcesso(),
): Ambiente {
  const problemas: string[] = [];
  const avisos: string[] = [];

  const nodeEnv = limpar(variaveis.NODE_ENV) ?? 'development';
  const producao = nodeEnv === 'production';
  const urlPublica = lerUrlPublica(variaveis.URL_PUBLICA, producao, problemas);
  const origemPublica = comoOrigem(urlPublica);

  const ambiente: Ambiente = {
    databaseUrl: lerDatabaseUrl(variaveis.DATABASE_URL, problemas),
    porta: lerPorta(variaveis.PORT, problemas),
    nodeEnv,
    producao,
    corsOrigens: lerOrigens('CORS_ORIGENS', variaveis.CORS_ORIGENS, problemas),
    observe: lerChavesDoObserve(variaveis, avisos),
    urlPublica,
    origensPermitidas: lerOrigensPermitidas(
      variaveis.ORIGENS_PERMITIDAS,
      origemPublica,
      problemas,
    ),
    cookieSeguro: lerBooleano(
      'COOKIE_SEGURO',
      variaveis.COOKIE_SEGURO,
      producao,
      problemas,
    ),
    chaveCriptografia: lerChaveCriptografia(
      variaveis.CHAVE_CRIPTOGRAFIA,
      producao,
      problemas,
      avisos,
    ),
    sessao: lerSessao(variaveis, problemas),
    admin: lerAdmin(variaveis, problemas),
    smtp: lerSmtp(variaveis, problemas),
    webhooksPermitirRedeInterna: lerBooleano(
      'WEBHOOKS_PERMITIR_REDE_INTERNA',
      variaveis.WEBHOOKS_PERMITIR_REDE_INTERNA,
      false,
      problemas,
    ),
    docsPublicas: lerBooleano(
      'DOCS_PUBLICAS',
      variaveis.DOCS_PUBLICAS,
      !producao,
      problemas,
    ),
    processarFilas: lerBooleano(
      'PROCESSAR_FILAS',
      variaveis.PROCESSAR_FILAS,
      true,
      problemas,
    ),
    logFormato: lerLogFormato(variaveis.LOG_FORMATO, producao, problemas),
    avisos,
  };

  if (problemas.length > 0) {
    throw new AmbienteInvalidoError(problemas);
  }
  return Object.freeze(ambiente);
}

/** Texto sem espaços nas pontas; vazio vira `undefined`. */
function limpar(valor: string | undefined): string | undefined {
  const texto = valor?.trim();
  return texto ? texto : undefined;
}

function lerDatabaseUrl(
  valor: string | undefined,
  problemas: string[],
): string {
  const url = limpar(valor);
  if (!url) {
    problemas.push(
      'DATABASE_URL é obrigatória (ex.: postgresql://crmbrl:crmbrl@localhost:5434/crmbrl?schema=public).',
    );
    return '';
  }
  // O valor nunca entra na mensagem: ele carrega a senha do banco.
  if (!URL.canParse(url)) {
    problemas.push('DATABASE_URL não é uma URL válida.');
  } else if (!['postgresql:', 'postgres:'].includes(new URL(url).protocol)) {
    problemas.push('DATABASE_URL precisa começar com postgresql://.');
  }
  return url;
}

function lerPorta(valor: string | undefined, problemas: string[]): number {
  const texto = limpar(valor);
  if (texto === undefined) {
    return PORTA_PADRAO;
  }
  const porta = Number(texto);
  if (!/^\d+$/.test(texto) || porta < 1 || porta > 65535) {
    problemas.push(
      `PORT precisa ser um número inteiro entre 1 e 65535 (recebido: "${texto}").`,
    );
    return PORTA_PADRAO;
  }
  return porta;
}

/** Lista de origens separadas por vírgula, como `http://localhost:4200`. */
function lerOrigens(
  nome: string,
  valor: string | undefined,
  problemas: string[],
): string[] {
  const origens = new Set<string>();
  for (const item of (valor ?? '').split(',')) {
    const texto = item.trim();
    if (!texto) {
      continue;
    }
    const origem = comoOrigem(texto);
    if (origem) {
      origens.add(origem);
    } else {
      problemas.push(
        `${nome}: "${texto}" não é uma origem (use protocolo://host[:porta], como http://localhost:4200).`,
      );
    }
  }
  return [...origens];
}

/** A origem normalizada (`http://host:porta`), ou `null` se o texto não for uma. */
export function comoOrigem(texto: string): string | null {
  if (!URL.canParse(texto)) {
    return null;
  }
  const url = new URL(texto);
  const ehOrigem =
    ['http:', 'https:'].includes(url.protocol) &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  return ehOrigem ? url.origin : null;
}

function lerUrlPublica(
  valor: string | undefined,
  producao: boolean,
  problemas: string[],
): string {
  const texto = limpar(valor);
  if (!texto) {
    if (producao) {
      problemas.push(
        'URL_PUBLICA é obrigatória em produção (o endereço do CRM, ex.: https://crm.brl.com.br).',
      );
    }
    return URL_PUBLICA_DESENVOLVIMENTO;
  }
  if (!URL.canParse(texto) || !/^https?:$/.test(new URL(texto).protocol)) {
    problemas.push(
      `URL_PUBLICA precisa ser um endereço http(s) (recebido: "${texto}").`,
    );
    return URL_PUBLICA_DESENVOLVIMENTO;
  }
  const url = new URL(texto);
  // Sem barra no fim: os links são montados como `${urlPublica}/caminho`.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function lerOrigensPermitidas(
  valor: string | undefined,
  origemPublica: string | null,
  problemas: string[],
): string[] {
  const origens = lerOrigens('ORIGENS_PERMITIDAS', valor, problemas);
  if (origens.length > 0) {
    return origens;
  }
  return origemPublica ? [origemPublica] : [];
}

const VERDADEIROS = new Set(['true', '1', 'sim', 'yes']);
const FALSOS = new Set(['false', '0', 'nao', 'não', 'no']);

function lerBooleano(
  nome: string,
  valor: string | undefined,
  padrao: boolean,
  problemas: string[],
): boolean {
  const texto = limpar(valor)?.toLowerCase();
  if (texto === undefined) {
    return padrao;
  }
  if (VERDADEIROS.has(texto)) {
    return true;
  }
  if (FALSOS.has(texto)) {
    return false;
  }
  problemas.push(`${nome} precisa ser true ou false (recebido: "${valor}").`);
  return padrao;
}

function lerInteiroPositivo(
  nome: string,
  valor: string | undefined,
  padrao: number,
  problemas: string[],
): number {
  const texto = limpar(valor);
  if (texto === undefined) {
    return padrao;
  }
  const numero = Number(texto);
  if (!/^\d+$/.test(texto) || numero < 1) {
    problemas.push(
      `${nome} precisa ser um número inteiro maior que zero (recebido: "${texto}").`,
    );
    return padrao;
  }
  return numero;
}

/**
 * `CHAVE_CRIPTOGRAFIA`: 32 bytes em base64 (44 caracteres) ou hexadecimal (64).
 * Gere com `openssl rand -base64 32`.
 */
function lerChaveCriptografia(
  valor: string | undefined,
  producao: boolean,
  problemas: string[],
  avisos: string[],
): Buffer {
  const texto = limpar(valor);
  if (!texto) {
    if (producao) {
      problemas.push(
        'CHAVE_CRIPTOGRAFIA é obrigatória em produção: 32 bytes em base64 (gere com `openssl rand -base64 32`).',
      );
    } else {
      avisos.push(
        'CHAVE_CRIPTOGRAFIA não definida: usando a chave de desenvolvimento (não use em produção).',
      );
    }
    return CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO;
  }
  const chave = /^[0-9a-fA-F]{64}$/.test(texto)
    ? Buffer.from(texto, 'hex')
    : /^[A-Za-z0-9+/]{43}=?$/.test(texto)
      ? Buffer.from(texto, 'base64')
      : null;
  if (!chave || chave.length !== 32) {
    // O valor não entra na mensagem: é um segredo.
    problemas.push(
      'CHAVE_CRIPTOGRAFIA precisa ter 32 bytes, em base64 (44 caracteres) ou hexadecimal (64 caracteres).',
    );
    return CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO;
  }
  if (producao && chave.equals(CHAVE_CRIPTOGRAFIA_DESENVOLVIMENTO)) {
    avisos.push(
      'CHAVE_CRIPTOGRAFIA é a chave pública de desenvolvimento: troque-a antes de usar em produção.',
    );
  }
  return chave;
}

function lerSessao(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoSessao {
  const inatividadeDias = lerInteiroPositivo(
    'SESSAO_INATIVIDADE_DIAS',
    variaveis.SESSAO_INATIVIDADE_DIAS,
    7,
    problemas,
  );
  const duracaoMaximaDias = lerInteiroPositivo(
    'SESSAO_DURACAO_MAXIMA_DIAS',
    variaveis.SESSAO_DURACAO_MAXIMA_DIAS,
    30,
    problemas,
  );
  const renovacaoMinutos = lerInteiroPositivo(
    'SESSAO_RENOVACAO_MINUTOS',
    variaveis.SESSAO_RENOVACAO_MINUTOS,
    5,
    problemas,
  );
  if (inatividadeDias > duracaoMaximaDias) {
    problemas.push(
      'SESSAO_INATIVIDADE_DIAS não pode ser maior que SESSAO_DURACAO_MAXIMA_DIAS.',
    );
  }
  return { inatividadeDias, duracaoMaximaDias, renovacaoMinutos };
}

const EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function lerAdmin(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoAdminInicial | null {
  const email = limpar(variaveis.ADMIN_EMAIL)?.toLowerCase();
  const senhaInicial = variaveis.ADMIN_SENHA_INICIAL?.trim()
    ? variaveis.ADMIN_SENHA_INICIAL
    : null;
  if (!email) {
    if (senhaInicial) {
      problemas.push('ADMIN_SENHA_INICIAL sem ADMIN_EMAIL: defina os dois.');
    }
    return null;
  }
  if (!EMAIL_SIMPLES.test(email)) {
    problemas.push(
      `ADMIN_EMAIL não é um e-mail válido (recebido: "${email}").`,
    );
  }
  if (senhaInicial && (senhaInicial.length < 8 || senhaInicial.length > 128)) {
    // A senha não entra na mensagem.
    problemas.push('ADMIN_SENHA_INICIAL precisa ter de 8 a 128 caracteres.');
  }
  return {
    email,
    nome: limpar(variaveis.ADMIN_NOME) ?? 'Administrador',
    senhaInicial,
  };
}

function lerSmtp(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoSmtp | null {
  const host = limpar(variaveis.SMTP_HOST);
  if (!host) {
    return null;
  }
  const portaTexto = limpar(variaveis.SMTP_PORTA);
  let porta = 587;
  if (portaTexto !== undefined) {
    porta = Number(portaTexto);
    if (!/^\d+$/.test(portaTexto) || porta < 1 || porta > 65535) {
      problemas.push(
        `SMTP_PORTA precisa ser um número inteiro entre 1 e 65535 (recebido: "${portaTexto}").`,
      );
      porta = 587;
    }
  }
  const remetente = limpar(variaveis.SMTP_REMETENTE);
  if (!remetente) {
    problemas.push(
      'SMTP_REMETENTE é obrigatório com SMTP_HOST (ex.: BRL CRM <crm@brl.com.br>).',
    );
  }
  return {
    host,
    porta,
    seguro: lerBooleano(
      'SMTP_SEGURO',
      variaveis.SMTP_SEGURO,
      porta === 465,
      problemas,
    ),
    usuario: limpar(variaveis.SMTP_USUARIO) ?? null,
    senha: variaveis.SMTP_SENHA ? variaveis.SMTP_SENHA : null,
    remetente: remetente ?? '',
  };
}

function lerLogFormato(
  valor: string | undefined,
  producao: boolean,
  problemas: string[],
): 'json' | 'texto' {
  const texto = limpar(valor)?.toLowerCase();
  if (texto === undefined) {
    return producao ? 'json' : 'texto';
  }
  if (texto === 'json' || texto === 'texto') {
    return texto;
  }
  problemas.push(
    `LOG_FORMATO precisa ser json ou texto (recebido: "${valor}").`,
  );
  return producao ? 'json' : 'texto';
}

function lerChavesDoObserve(
  variaveis: VariaveisDeAmbiente,
  avisos: string[],
): Ambiente['observe'] {
  const appKey = limpar(variaveis.OBSERVE_APP_KEY);
  const appSecret = limpar(variaveis.OBSERVE_APP_SECRET);
  if (appKey && appSecret) {
    return { appKey, appSecret };
  }
  if (appKey || appSecret) {
    const faltando = appKey ? 'OBSERVE_APP_SECRET' : 'OBSERVE_APP_KEY';
    avisos.push(
      `${faltando} não definida: o @nestjs/observe fica desligado (ele precisa das duas chaves).`,
    );
  }
  return null;
}
