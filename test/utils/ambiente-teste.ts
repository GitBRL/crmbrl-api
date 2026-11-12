import {
  type Ambiente,
  lerAmbiente,
  type VariaveisDeAmbiente,
} from '../../src/config/ambiente';

/** Origem do front nos testes: vai no `Origin` de toda requisição (R2.9). */
export const ORIGEM_DE_TESTE = 'http://localhost:4200';

/** Chave de criptografia fixa dos testes (32 bytes em hexadecimal). */
export const CHAVE_DE_TESTE = '0f'.repeat(32);

/** Token interno API ↔ gateway de WhatsApp nos testes (o gateway de teste exige o mesmo). */
export const TOKEN_INTERNO_DE_TESTE =
  'token-interno-dos-testes-de-integracao-0123456789';

/** R35.1: o papel da aplicação nos testes (criado pelo `global-setup` no banco de teste). */
export const PAPEL_DA_APLICACAO_DE_TESTE = 'crmbrl_app';
export const SENHA_DO_PAPEL_DE_TESTE =
  'papel-da-aplicacao-dos-testes-0123456789';

/** Porta do banco do docker compose (ambiente do usuário): os testes nunca a usam. */
const PORTA_DO_BANCO_DO_COMPOSE = '5434';

/**
 * URL do banco dos testes de integração: `DATABASE_URL_TESTE`, obrigatória. Os
 * testes APAGAM tudo nesse banco — use um Postgres descartável, por exemplo:
 *
 * ```bash
 * docker run -d --name crmbrl-teste -e POSTGRES_USER=crmbrl -e POSTGRES_PASSWORD=crmbrl \
 *   -e POSTGRES_DB=crmbrl -p 127.0.0.1:55432:5432 postgres:17-alpine
 * DATABASE_URL_TESTE=postgresql://crmbrl:crmbrl@localhost:55432/crmbrl npm run test:e2e
 * ```
 */
export function urlDoBancoDeTeste(): string {
  const url = process.env.DATABASE_URL_TESTE?.trim();
  if (!url) {
    throw new Error(
      'Defina DATABASE_URL_TESTE com um PostgreSQL descartável: os testes de integração apagam todos os dados dele.',
    );
  }
  if (!URL.canParse(url)) {
    throw new Error('DATABASE_URL_TESTE não é uma URL válida.');
  }
  const destino = new URL(url);
  const mesmoQueAplicacao =
    process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL.trim() === url;
  if (destino.port === PORTA_DO_BANCO_DO_COMPOSE || mesmoQueAplicacao) {
    throw new Error(
      'DATABASE_URL_TESTE aponta para o banco da aplicação (docker compose): use um banco só para testes.',
    );
  }
  return url;
}

/**
 * R35.1: a URL do banco de teste com o papel da aplicação (sem superusuário,
 * com a RLS valendo) — a que a API dos testes usa. `DATABASE_URL_TESTE` é a do
 * dono: migrations, preparação de dados e conferências (`t.prisma`).
 */
export function urlDaAplicacaoDeTeste(): string {
  const url = new URL(urlDoBancoDeTeste());
  url.username = PAPEL_DA_APLICACAO_DE_TESTE;
  url.password = SENHA_DO_PAPEL_DE_TESTE;
  return url.toString();
}

/**
 * Ambiente dos testes: banco de teste (pelo papel da aplicação, R35), origem e URL pública `http://localhost:4200`,
 * cookie sem `Secure`, chave fixa e `PROCESSAR_FILAS=false` (filas e eventos
 * só rodam quando o teste drena). Arquivos na memória (`ARQUIVOS_DRIVER=memoria`,
 * sem MinIO) e WhatsApp simulado com token interno fixo. `variaveis`
 * sobrescreve qualquer valor.
 */
export function ambienteDeTeste(variaveis: VariaveisDeAmbiente = {}): Ambiente {
  return lerAmbiente({
    DATABASE_URL: urlDaAplicacaoDeTeste(),
    NODE_ENV: 'test',
    URL_PUBLICA: ORIGEM_DE_TESTE,
    ORIGENS_PERMITIDAS: ORIGEM_DE_TESTE,
    CHAVE_CRIPTOGRAFIA: CHAVE_DE_TESTE,
    PROCESSAR_FILAS: 'false',
    LOG_FORMATO: 'texto',
    ARQUIVOS_DRIVER: 'memoria',
    WHATSAPP_SIMULADO: 'true',
    WHATSAPP_TOKEN_INTERNO: TOKEN_INTERNO_DE_TESTE,
    ...variaveis,
  });
}
