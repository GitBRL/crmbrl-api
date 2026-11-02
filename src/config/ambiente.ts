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

/** Porta HTTP interna do gateway de WhatsApp (`WHATSAPP_PORTA`). */
export const PORTA_PADRAO_GATEWAY_WHATSAPP = 3100;

/**
 * Token interno de desenvolvimento entre a API e o gateway de WhatsApp. Só é
 * usado fora de produção quando `WHATSAPP_TOKEN_INTERNO` não vem; em produção,
 * se alguém o configurar de propósito, a inicialização avisa.
 */
export const TOKEN_INTERNO_DESENVOLVIMENTO =
  'crmbrl-token-interno-de-desenvolvimento-nao-use-em-producao';

/** Tamanho mínimo do `WHATSAPP_TOKEN_INTERNO`. */
export const TAMANHO_MINIMO_TOKEN_INTERNO = 32;

/** Endereço e versão padrão da Graph API da Meta (Instagram e Messenger). */
export const META_GRAPH_URL_PADRAO = 'https://graph.facebook.com';
export const META_GRAPH_VERSAO_PADRAO = 'v24.0';

/** Onde ficam os arquivos (R11): MinIO/S3 ou memória (testes). */
export type DriverDeArquivos = 's3' | 'memoria';

export interface ConfiguracaoArquivos {
  /** `s3` (MinIO no compose) ou `memoria` (testes: some quando o processo para). */
  readonly driver: DriverDeArquivos;
  /** Endereço do S3/MinIO (`ARQUIVOS_ENDPOINT`). `null` = o endereço padrão da AWS para a região. */
  readonly endpoint: string | null;
  readonly regiao: string;
  /** Chave de acesso (`ARQUIVOS_CHAVE`). Obrigatória com `s3` em produção. */
  readonly chave: string | null;
  /** Segredo (`ARQUIVOS_SEGREDO`). Nunca vai para log nem resposta. */
  readonly segredo: string | null;
  /** Bucket (`ARQUIVOS_BUCKET`), criado pela API ao subir se ainda não existir. */
  readonly bucket: string;
}

export interface ConfiguracaoWhatsapp {
  /** Endereço interno do gateway, para os comandos síncronos da API (`WHATSAPP_URL_INTERNA`). */
  readonly urlInterna: string;
  /** Token do cabeçalho `X-Token-Interno` entre a API e o gateway (`WHATSAPP_TOKEN_INTERNO`). */
  readonly tokenInterno: string;
  /** Transporte simulado: QR de mentira, envios com status progressivo e `POST /simulador/receber`. */
  readonly simulado: boolean;
  /** Porta HTTP interna do processo do gateway (`WHATSAPP_PORTA`). */
  readonly porta: number;
}

export interface ConfiguracaoMeta {
  /** Base da Graph API, sem barra no fim (`META_GRAPH_URL`; a falsa do ambiente dos agentes, nos testes). */
  readonly graphUrl: string;
  /** Versão da Graph API (`META_GRAPH_VERSAO`, ex.: `v24.0`). */
  readonly graphVersao: string;
}

/**
 * Claude (Anthropic) para a análise do BI (R21). A chave nunca fica aqui: o SDK
 * a lê de `ANTHROPIC_API_KEY` no próprio processo; a API só sabe se ela existe.
 */
export interface ConfiguracaoAnthropic {
  /** `ANTHROPIC_API_KEY` preenchida: a análise por IA pode ser usada. */
  readonly configurada: boolean;
  /** `ANTHROPIC_BASE_URL` (a API falsa do ambiente dos agentes); `null` = a padrão do SDK. */
  readonly urlBase: string | null;
}

/**
 * Notificações push (R26): par de chaves VAPID e o contato (`mailto:` ou https)
 * que o serviço de push do navegador vê. A chave privada fica atrás de uma função.
 */
export interface ConfiguracaoPush {
  /** As três variáveis VAPID preenchidas e válidas (R26). */
  readonly configurada: boolean;
  /** `VAPID_CHAVE_PUBLICA` (base64url; é pública: o front a usa para inscrever). */
  readonly chavePublica: string | null;
  /** `VAPID_ASSUNTO` (`mailto:…` ou endereço https). */
  readonly assunto: string | null;
  /** O valor de `VAPID_CHAVE_PRIVADA` (só para assinar os envios; fora de JSON e logs). */
  chavePrivada(): string | null;
}

/**
 * TicketHub (R25): conta de serviço que abre os chamados do assistente.
 * A senha fica atrás de uma função (não entra em `JSON.stringify`, logs ou
 * respostas); a configuração do Admin, quando preenchida, tem prioridade.
 */
export interface ConfiguracaoTicketHub {
  /** `TICKETHUB_URL` (origem do TicketHub, sem barra no fim). */
  readonly url: string | null;
  /** `TICKETHUB_EMAIL`. */
  readonly email: string | null;
  /** `TICKETHUB_SENHA` preenchida. */
  readonly senhaDefinida: boolean;
  /** As três preenchidas. */
  readonly configurado: boolean;
  /** O valor de `TICKETHUB_SENHA` (só para o login do conector). */
  senha(): string | null;
}

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
  /** Armazenamento de arquivos (R11). */
  readonly arquivos: ConfiguracaoArquivos;
  /** Gateway de WhatsApp (R13): processo próprio, comandos por HTTP interno. */
  readonly whatsapp: ConfiguracaoWhatsapp;
  /** Graph API da Meta (Instagram e Messenger, R14). */
  readonly meta: ConfiguracaoMeta;
  readonly anthropic: ConfiguracaoAnthropic;
  readonly ticketHub: ConfiguracaoTicketHub;
  readonly push: ConfiguracaoPush;
  /** Pasta dos backups, montada só para leitura (`BACKUP_DIR`, padrão `/backups`): a saúde lê `ultimo.json`. */
  readonly backupDir: string;
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
  ARQUIVOS_DRIVER?: string;
  ARQUIVOS_ENDPOINT?: string;
  ARQUIVOS_REGIAO?: string;
  ARQUIVOS_CHAVE?: string;
  ARQUIVOS_SEGREDO?: string;
  ARQUIVOS_BUCKET?: string;
  BACKUP_DIR?: string;
  WHATSAPP_URL_INTERNA?: string;
  WHATSAPP_TOKEN_INTERNO?: string;
  WHATSAPP_SIMULADO?: string;
  WHATSAPP_PORTA?: string;
  META_GRAPH_URL?: string;
  META_GRAPH_VERSAO?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  TICKETHUB_URL?: string;
  TICKETHUB_EMAIL?: string;
  TICKETHUB_SENHA?: string;
  VAPID_CHAVE_PUBLICA?: string;
  VAPID_CHAVE_PRIVADA?: string;
  VAPID_ASSUNTO?: string;
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
  'ARQUIVOS_DRIVER',
  'ARQUIVOS_ENDPOINT',
  'ARQUIVOS_REGIAO',
  'ARQUIVOS_CHAVE',
  'ARQUIVOS_SEGREDO',
  'ARQUIVOS_BUCKET',
  'BACKUP_DIR',
  'WHATSAPP_URL_INTERNA',
  'WHATSAPP_TOKEN_INTERNO',
  'WHATSAPP_SIMULADO',
  'WHATSAPP_PORTA',
  'META_GRAPH_URL',
  'META_GRAPH_VERSAO',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'TICKETHUB_URL',
  'TICKETHUB_EMAIL',
  'TICKETHUB_SENHA',
  'VAPID_CHAVE_PUBLICA',
  'VAPID_CHAVE_PRIVADA',
  'VAPID_ASSUNTO',
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
    arquivos: lerArquivos(variaveis, producao, problemas, avisos),
    whatsapp: lerWhatsapp(variaveis, producao, problemas, avisos),
    meta: lerMeta(variaveis, problemas),
    anthropic: lerAnthropic(variaveis, problemas),
    ticketHub: lerTicketHub(variaveis, problemas),
    push: lerPush(variaveis, problemas, avisos),
    backupDir: variaveis.BACKUP_DIR?.trim() || '/backups',
    avisos,
  };

  avisosDeProducao(ambiente, variaveis, avisos);

  if (problemas.length > 0) {
    throw new AmbienteInvalidoError(problemas);
  }
  return Object.freeze(ambiente);
}

/** Segredo público de desenvolvimento do MinIO (o padrão do compose). */
export const ARQUIVOS_SEGREDO_DESENVOLVIMENTO =
  'crmbrl-arquivos-desenvolvimento';

/**
 * Configurações que deixam a produção insegura sem impedir a subida (o compose
 * de desenvolvimento usa os padrões públicos): viram aviso no log da inicialização.
 * Nunca incluem o valor do segredo.
 */
function avisosDeProducao(
  ambiente: Ambiente,
  variaveis: VariaveisDeAmbiente,
  avisos: string[],
): void {
  if (!ambiente.producao) {
    return;
  }
  if (ambiente.urlPublica.startsWith('http://')) {
    avisos.push(
      'URL_PUBLICA usa http em produção: a sessão e os dados trafegam sem criptografia (use HTTPS pelo Caddy, veja docs/DEPLOY.md).',
    );
  } else if (!ambiente.cookieSeguro) {
    avisos.push(
      'COOKIE_SEGURO=false com URL_PUBLICA em https: o cookie de sessão pode vazar em http. Use COOKIE_SEGURO=true.',
    );
  }
  if (limpar(variaveis.ARQUIVOS_SEGREDO) === ARQUIVOS_SEGREDO_DESENVOLVIMENTO) {
    avisos.push(
      'ARQUIVOS_SEGREDO é o segredo público de desenvolvimento do MinIO: troque-o antes de usar em produção.',
    );
  }
  if (senhaDoBanco(ambiente.databaseUrl) === 'crmbrl') {
    avisos.push(
      'A senha do banco (DATABASE_URL) é a de desenvolvimento ("crmbrl"): defina BANCO_SENHA com um valor forte.',
    );
  }
}

/** A senha da `DATABASE_URL`, ou `null` quando não dá para ler. */
function senhaDoBanco(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password) || null;
  } catch {
    return null;
  }
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

function lerPorta(
  valor: string | undefined,
  problemas: string[],
  nome = 'PORT',
  padrao = PORTA_PADRAO,
): number {
  const texto = limpar(valor);
  if (texto === undefined) {
    return padrao;
  }
  const porta = Number(texto);
  if (!/^\d+$/.test(texto) || porta < 1 || porta > 65535) {
    problemas.push(
      `${nome} precisa ser um número inteiro entre 1 e 65535 (recebido: "${texto}").`,
    );
    return padrao;
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

/** Endereço http(s) sem barra no fim, ou `null` (com o problema registrado) se não for um. */
function lerEnderecoHttp(
  nome: string,
  valor: string | undefined,
  padrao: string | null,
  problemas: string[],
): string | null {
  const texto = limpar(valor);
  if (texto === undefined) {
    return padrao;
  }
  if (!URL.canParse(texto) || !/^https?:$/.test(new URL(texto).protocol)) {
    problemas.push(
      `${nome} precisa ser um endereço http(s) (recebido: "${texto}").`,
    );
    return padrao;
  }
  const url = new URL(texto);
  if (url.username || url.password) {
    problemas.push(
      `${nome} não pode levar usuário e senha no endereço (use as variáveis próprias).`,
    );
    return padrao;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * `TICKETHUB_*` (R25): endereço, e-mail e senha da conta de serviço. A senha
 * nunca entra no objeto serializável (só pela função `senha()`).
 */
function lerTicketHub(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoTicketHub {
  const url = lerEnderecoHttp(
    'TICKETHUB_URL',
    variaveis.TICKETHUB_URL,
    null,
    problemas,
  );
  const email = limpar(variaveis.TICKETHUB_EMAIL)?.toLowerCase() ?? null;
  const senha = variaveis.TICKETHUB_SENHA?.length
    ? variaveis.TICKETHUB_SENHA
    : null;
  return {
    url,
    email,
    senhaDefinida: senha !== null,
    configurado: url !== null && email !== null && senha !== null,
    senha: () => senha,
  };
}

/** Chave pública VAPID: ponto P-256 não comprimido (65 bytes) em base64url. */
const CHAVE_PUBLICA_VAPID = /^[A-Za-z0-9_-]{87}$/;
/** Chave privada VAPID: 32 bytes em base64url. */
const CHAVE_PRIVADA_VAPID = /^[A-Za-z0-9_-]{43}$/;

/**
 * `VAPID_*` (R26). Sem as três, o push fica desligado (a API sobe; só avisa se faltar parte);
 * valores malformados impedem a subida, sem repetir o valor na mensagem.
 */
function lerPush(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
  avisos: string[],
): ConfiguracaoPush {
  const publica = limpar(variaveis.VAPID_CHAVE_PUBLICA) ?? null;
  const privada = limpar(variaveis.VAPID_CHAVE_PRIVADA) ?? null;
  const assunto = limpar(variaveis.VAPID_ASSUNTO) ?? null;
  const desligada: ConfiguracaoPush = {
    configurada: false,
    chavePublica: null,
    assunto: null,
    chavePrivada: () => null,
  };
  if (!publica && !privada && !assunto) {
    return desligada;
  }
  const faltam = [
    ['VAPID_CHAVE_PUBLICA', publica],
    ['VAPID_CHAVE_PRIVADA', privada],
    ['VAPID_ASSUNTO', assunto],
  ]
    .filter(([, valor]) => !valor)
    .map(([nome]) => nome);
  if (faltam.length > 0) {
    avisos.push(
      `${faltam.join(', ')} não definida(s): as notificações push ficam desligadas (elas precisam das três variáveis VAPID).`,
    );
    return desligada;
  }
  let validas = true;
  if (!CHAVE_PUBLICA_VAPID.test(publica as string)) {
    problemas.push(
      'VAPID_CHAVE_PUBLICA inválida: use a chave pública gerada com `web-push generate-vapid-keys` (base64url, 87 caracteres).',
    );
    validas = false;
  }
  if (!CHAVE_PRIVADA_VAPID.test(privada as string)) {
    problemas.push(
      'VAPID_CHAVE_PRIVADA inválida: use a chave privada gerada com `web-push generate-vapid-keys` (base64url, 43 caracteres).',
    );
    validas = false;
  }
  if (
    !(assunto as string).startsWith('mailto:') &&
    !(assunto as string).startsWith('https://')
  ) {
    problemas.push(
      'VAPID_ASSUNTO precisa começar com mailto: (ou ser um endereço https).',
    );
    validas = false;
  }
  if (!validas) {
    return desligada;
  }
  return {
    configurada: true,
    chavePublica: publica,
    assunto,
    chavePrivada: () => privada,
  };
}

/** Regras de nome de bucket do S3: 3 a 63 caracteres, minúsculas, dígitos, ponto e hífen. */
const NOME_DE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * `ARQUIVOS_*` (R11). Com `s3` (padrão) a API fala com o MinIO do compose; com
 * `memoria` (testes) os arquivos ficam no processo e somem ao reiniciar. Em
 * produção, o driver `s3` exige chave e segredo.
 */
function lerArquivos(
  variaveis: VariaveisDeAmbiente,
  producao: boolean,
  problemas: string[],
  avisos: string[],
): ConfiguracaoArquivos {
  const driverTexto = limpar(variaveis.ARQUIVOS_DRIVER)?.toLowerCase() ?? 's3';
  let driver: DriverDeArquivos = 's3';
  if (driverTexto === 's3' || driverTexto === 'memoria') {
    driver = driverTexto;
  } else {
    problemas.push(
      `ARQUIVOS_DRIVER precisa ser s3 ou memoria (recebido: "${variaveis.ARQUIVOS_DRIVER}").`,
    );
  }
  const endpoint = lerEnderecoHttp(
    'ARQUIVOS_ENDPOINT',
    variaveis.ARQUIVOS_ENDPOINT,
    producao ? null : 'http://localhost:9000',
    problemas,
  );
  const chave = limpar(variaveis.ARQUIVOS_CHAVE) ?? null;
  const segredo = variaveis.ARQUIVOS_SEGREDO?.trim()
    ? variaveis.ARQUIVOS_SEGREDO.trim()
    : null;
  const bucket = limpar(variaveis.ARQUIVOS_BUCKET) ?? 'crmbrl';
  if (!NOME_DE_BUCKET.test(bucket)) {
    problemas.push(
      `ARQUIVOS_BUCKET precisa ter de 3 a 63 caracteres: letras minúsculas, dígitos, ponto ou hífen (recebido: "${bucket}").`,
    );
  }
  if (driver === 's3' && (!chave || !segredo)) {
    const faltando = [
      chave ? null : 'ARQUIVOS_CHAVE',
      segredo ? null : 'ARQUIVOS_SEGREDO',
    ]
      .filter(Boolean)
      .join(' e ');
    if (producao) {
      problemas.push(
        `${faltando}: obrigatória(s) em produção com ARQUIVOS_DRIVER=s3 (as credenciais do MinIO).`,
      );
    } else {
      avisos.push(
        `${faltando} não definida(s): o envio e o download de arquivos vão falhar até configurar o MinIO (ou use ARQUIVOS_DRIVER=memoria).`,
      );
    }
  }
  if (driver === 'memoria' && producao) {
    avisos.push(
      'ARQUIVOS_DRIVER=memoria em produção: os arquivos somem quando o processo reinicia.',
    );
  }
  return {
    driver,
    endpoint,
    regiao: limpar(variaveis.ARQUIVOS_REGIAO) ?? 'us-east-1',
    chave,
    segredo,
    bucket,
  };
}

/**
 * `WHATSAPP_*` (R13): o gateway é outro processo da mesma imagem. A API manda
 * comandos para `WHATSAPP_URL_INTERNA` com o token interno; o gateway exige o
 * mesmo token. Em produção o token é obrigatório.
 */
function lerWhatsapp(
  variaveis: VariaveisDeAmbiente,
  producao: boolean,
  problemas: string[],
  avisos: string[],
): ConfiguracaoWhatsapp {
  const porta = lerPorta(
    variaveis.WHATSAPP_PORTA,
    problemas,
    'WHATSAPP_PORTA',
    PORTA_PADRAO_GATEWAY_WHATSAPP,
  );
  const urlInterna =
    lerEnderecoHttp(
      'WHATSAPP_URL_INTERNA',
      variaveis.WHATSAPP_URL_INTERNA,
      null,
      problemas,
    ) ?? `http://localhost:${porta}`;
  let tokenInterno = variaveis.WHATSAPP_TOKEN_INTERNO?.trim() ?? '';
  if (!tokenInterno) {
    if (producao) {
      problemas.push(
        `WHATSAPP_TOKEN_INTERNO é obrigatório em produção: um segredo de pelo menos ${TAMANHO_MINIMO_TOKEN_INTERNO} caracteres, o mesmo na API e no gateway (gere com \`openssl rand -base64 32\`).`,
      );
    } else {
      avisos.push(
        'WHATSAPP_TOKEN_INTERNO não definido: usando o token interno de desenvolvimento (não use em produção).',
      );
    }
    tokenInterno = TOKEN_INTERNO_DESENVOLVIMENTO;
  } else if (tokenInterno.length < TAMANHO_MINIMO_TOKEN_INTERNO) {
    // O valor não entra na mensagem: é um segredo.
    problemas.push(
      `WHATSAPP_TOKEN_INTERNO precisa ter pelo menos ${TAMANHO_MINIMO_TOKEN_INTERNO} caracteres.`,
    );
  } else if (producao && tokenInterno === TOKEN_INTERNO_DESENVOLVIMENTO) {
    avisos.push(
      'WHATSAPP_TOKEN_INTERNO é o token público de desenvolvimento: troque-o antes de usar em produção.',
    );
  }
  return {
    urlInterna,
    tokenInterno,
    simulado: lerBooleano(
      'WHATSAPP_SIMULADO',
      variaveis.WHATSAPP_SIMULADO,
      false,
      problemas,
    ),
    porta,
  };
}

/** `META_GRAPH_*` (R14): onde fica a Graph API (a falsa do ambiente dos agentes, nos testes). */
function lerMeta(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoMeta {
  const graphUrl =
    lerEnderecoHttp(
      'META_GRAPH_URL',
      variaveis.META_GRAPH_URL,
      META_GRAPH_URL_PADRAO,
      problemas,
    ) ?? META_GRAPH_URL_PADRAO;
  const versao =
    limpar(variaveis.META_GRAPH_VERSAO) ?? META_GRAPH_VERSAO_PADRAO;
  if (!/^v\d+\.\d+$/.test(versao)) {
    problemas.push(
      `META_GRAPH_VERSAO precisa ter o formato vNN.N, como ${META_GRAPH_VERSAO_PADRAO} (recebido: "${versao}").`,
    );
  }
  return { graphUrl, graphVersao: versao };
}

/**
 * `ANTHROPIC_*` (R21): só a presença da chave (o valor nunca sai do processo
 * nem vai para log) e a base opcional da API.
 */
function lerAnthropic(
  variaveis: VariaveisDeAmbiente,
  problemas: string[],
): ConfiguracaoAnthropic {
  return {
    configurada: limpar(variaveis.ANTHROPIC_API_KEY) !== undefined,
    urlBase: lerEnderecoHttp(
      'ANTHROPIC_BASE_URL',
      variaveis.ANTHROPIC_BASE_URL,
      null,
      problemas,
    ),
  };
}
