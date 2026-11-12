/**
 * R35.1 — o papel próprio da aplicação no PostgreSQL.
 *
 * O dono do banco (quem roda as migrations, `DATABASE_URL_MIGRACAO`) cria — ou
 * acerta, se já existe — o papel da aplicação (`BANCO_APP_USUARIO`, padrão
 * `crmbrl_app`) com a senha `BANCO_APP_SENHA`:
 * - `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`;
 * - só DML nas tabelas (`SELECT, INSERT, UPDATE, DELETE`), uso das sequências e
 *   das funções; na auditoria, **só `SELECT` e `INSERT`** (R3.3); nas migrations
 *   do Prisma, só leitura (a Saúde as consulta);
 * - privilégios padrão para as tabelas, sequências e funções que as próximas
 *   migrations criarem;
 * - dono do esquema `pgboss` (o pg-boss cria tabelas e partições nele).
 *
 * Tudo idempotente: roda a cada subida (`docker-entrypoint.sh`, depois do
 * `prisma migrate deploy`) e nos testes de integração. A senha vai ao banco já
 * no formato SCRAM-SHA-256 (o texto da senha nunca chega ao servidor nem a log).
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** Nome padrão do papel da aplicação. */
export const PAPEL_DA_APLICACAO_PADRAO = 'crmbrl_app';

/** Esquema do pg-boss (o mesmo de `fila.service.ts`). */
const ESQUEMA_DA_FILA = 'pgboss';

/** Tabela imutável (R3.3): o papel da aplicação só lê e insere. */
const TABELA_DA_AUDITORIA = 'eventos_auditoria';

const NOME_VALIDO = /^[a-z_][a-z0-9_]{0,62}$/;

export interface OpcoesDoPapel {
  /** Nome do papel (minúsculas, dígitos e `_`). */
  readonly nome: string;
  /** Senha do papel (`BANCO_APP_SENHA`). */
  readonly senha: string;
}

export interface ResultadoDoPapel {
  readonly criado: boolean;
  readonly donoDoBanco: string;
}

/** O verificador SCRAM-SHA-256 da senha (o que o PostgreSQL guarda em `pg_authid`). */
export function verificadorScram(
  senha: string,
  sal: Buffer = randomBytes(16),
  iteracoes = 4096,
): string {
  const salgada = pbkdf2Sync(
    senha.normalize('NFKC'),
    sal,
    iteracoes,
    32,
    'sha256',
  );
  const chaveDoCliente = createHmac('sha256', salgada)
    .update('Client Key')
    .digest();
  const chaveGuardada = createHash('sha256').update(chaveDoCliente).digest();
  const chaveDoServidor = createHmac('sha256', salgada)
    .update('Server Key')
    .digest();
  return `SCRAM-SHA-256$${iteracoes}:${sal.toString('base64')}$${chaveGuardada.toString('base64')}:${chaveDoServidor.toString('base64')}`;
}

/** A senha pública do dono nos composes e no `.env.example` (a de desenvolvimento). */
export const SENHA_DE_DESENVOLVIMENTO_DO_BANCO = 'crmbrl';

/**
 * Produção com a senha de desenvolvimento no dono do banco
 * (`DATABASE_URL_MIGRACAO`)? O entrypoint não repassa essa URL à API, então a
 * conferência que a API faz na `DATABASE_URL` (`ambiente.ts`) não a vê: quem
 * confere é a preparação do papel. Recusa (texto em `problema`) ou, com
 * `PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true`, só avisa — como a API. Nunca
 * inclui a senha.
 */
export function conferirSenhaDoDono(
  urlDoDono: string,
  opcoes: { readonly producao: boolean; readonly permitir: boolean },
): { problema?: string; aviso?: string } {
  if (!opcoes.producao) {
    return {};
  }
  let senha: string | null = null;
  try {
    senha = decodeURIComponent(new URL(urlDoDono).password) || null;
  } catch {
    return {};
  }
  if (senha !== SENHA_DE_DESENVOLVIMENTO_DO_BANCO) {
    return {};
  }
  const descricao = `A senha do dono do banco (DATABASE_URL_MIGRACAO) é a de desenvolvimento ("${SENHA_DE_DESENVOLVIMENTO_DO_BANCO}"): defina BANCO_SENHA com um valor forte`;
  return opcoes.permitir
    ? {
        aviso: `ATENÇÃO: ${descricao} (permitido por PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true: nunca use com dados reais).`,
      }
    : {
        problema: `${descricao}. Corrija, ou (só em teste local) defina PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true.`,
      };
}

/** Confere nome e senha antes de falar com o banco (mensagens sem o valor da senha). */
export function validarOpcoesDoPapel(opcoes: OpcoesDoPapel): string[] {
  const problemas: string[] = [];
  if (!NOME_VALIDO.test(opcoes.nome)) {
    problemas.push(
      'BANCO_APP_USUARIO precisa ter só letras minúsculas, dígitos e _ (até 63 caracteres).',
    );
  }
  if (opcoes.senha.length < 16 || !/^[A-Za-z0-9._~-]+$/.test(opcoes.senha)) {
    problemas.push(
      'BANCO_APP_SENHA precisa ter pelo menos 16 caracteres, só letras, dígitos e . _ ~ - (vai na URL do banco; ex.: openssl rand -hex 32).',
    );
  }
  return problemas;
}

/** Aspas de identificador do PostgreSQL. */
function id(nome: string): string {
  return `"${nome.replace(/"/g, '""')}"`;
}

/** Literal de texto do PostgreSQL. */
function literal(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

/**
 * Cria ou acerta o papel da aplicação e as permissões dele. `cliente` é uma
 * conexão do dono do banco (o papel que roda as migrations).
 */
export async function prepararPapelDaAplicacao(
  cliente: pg.ClientBase,
  opcoes: OpcoesDoPapel,
): Promise<ResultadoDoPapel> {
  const problemas = validarOpcoesDoPapel(opcoes);
  if (problemas.length > 0) {
    throw new Error(problemas.join(' '));
  }
  const papel = id(opcoes.nome);
  const { rows: donos } = await cliente.query<{ dono: string; banco: string }>(
    'SELECT current_user AS dono, current_database() AS banco',
  );
  const { dono, banco } = donos[0];
  if (dono === opcoes.nome) {
    throw new Error(
      'BANCO_APP_USUARIO é o próprio dono do banco: use outro nome para o papel da aplicação.',
    );
  }
  const { rows: existentes } = await cliente.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [opcoes.nome],
  );
  const criado = existentes.length === 0;
  const atributos =
    'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT';
  const senha = literal(verificadorScram(opcoes.senha));

  await cliente.query('BEGIN');
  try {
    await cliente.query(
      criado
        ? `CREATE ROLE ${papel} WITH ${atributos} PASSWORD ${senha}`
        : `ALTER ROLE ${papel} WITH ${atributos} PASSWORD ${senha}`,
    );
    // Sem contexto por padrão: a API põe o dela em cada consulta (R35.2).
    await cliente.query(`ALTER ROLE ${papel} RESET ALL`);
    // Sem JIT: as políticas da RLS encarecem a estimativa das agregações do BI
    // e o JIT passaria a compilar (≈100 ms) consultas que rodam em dezenas de ms.
    await cliente.query(`ALTER ROLE ${papel} SET jit = off`);
    await cliente.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${id(banco)} TO ${papel}`,
    );
    await cliente.query(`REVOKE CREATE ON DATABASE ${id(banco)} FROM ${papel}`);

    // Esquema public: só DML.
    await cliente.query(`GRANT USAGE ON SCHEMA public TO ${papel}`);
    await cliente.query(`REVOKE CREATE ON SCHEMA public FROM ${papel}`);
    await cliente.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${papel}`,
    );
    await cliente.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${papel}`,
    );
    await cliente.query(
      `REVOKE INSERT, UPDATE, DELETE ON TABLE public.${id(TABELA_DA_AUDITORIA)} FROM ${papel}`,
    );
    await cliente.query(
      `GRANT SELECT, INSERT ON TABLE public.${id(TABELA_DA_AUDITORIA)} TO ${papel}`,
    );
    await cliente.query(
      `DO $$ BEGIN
         IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
           REVOKE INSERT, UPDATE, DELETE ON TABLE public._prisma_migrations FROM ${papel};
         END IF;
       END $$`,
    );
    await cliente.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${papel}`,
    );
    await cliente.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${papel}`,
    );
    await cliente.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${papel}`,
    );
    await cliente.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${papel}`,
    );
    await cliente.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${papel}`,
    );

    // Funções da RLS (migration u1_rls).
    await cliente.query(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'rls') THEN
           GRANT USAGE ON SCHEMA rls TO ${papel};
           REVOKE CREATE ON SCHEMA rls FROM ${papel};
           GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rls TO ${papel};
           ALTER DEFAULT PRIVILEGES IN SCHEMA rls GRANT EXECUTE ON FUNCTIONS TO ${papel};
         END IF;
       END $$`,
    );

    // pg-boss: o papel da aplicação é o dono do esquema dele (cria filas e partições).
    await cliente.query(
      `CREATE SCHEMA IF NOT EXISTS ${id(ESQUEMA_DA_FILA)} AUTHORIZATION ${papel}`,
    );
    await passarEsquemaDaFila(cliente, opcoes.nome);
    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  }
  return { criado, donoDoBanco: dono };
}

/** Passa o esquema do pg-boss e tudo o que há nele para o papel da aplicação. */
async function passarEsquemaDaFila(
  cliente: pg.ClientBase,
  nome: string,
): Promise<void> {
  const papel = id(nome);
  const esquema = id(ESQUEMA_DA_FILA);
  await cliente.query(`ALTER SCHEMA ${esquema} OWNER TO ${papel}`);
  const { rows: tabelas } = await cliente.query<{ nome: string }>(
    `SELECT c.relname AS nome
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_get_userbyid(c.relowner) <> $2`,
    [ESQUEMA_DA_FILA, nome],
  );
  for (const { nome: tabela } of tabelas) {
    await cliente.query(
      `ALTER TABLE ${esquema}.${id(tabela)} OWNER TO ${papel}`,
    );
  }
  const { rows: sequencias } = await cliente.query<{ nome: string }>(
    `SELECT c.relname AS nome
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'S'
        AND pg_get_userbyid(c.relowner) <> $2
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                         WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))`,
    [ESQUEMA_DA_FILA, nome],
  );
  for (const { nome: sequencia } of sequencias) {
    await cliente.query(
      `ALTER SEQUENCE ${esquema}.${id(sequencia)} OWNER TO ${papel}`,
    );
  }
  const { rows: funcoes } = await cliente.query<{ assinatura: string }>(
    `SELECT p.oid::regprocedure::text AS assinatura
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner) <> $2`,
    [ESQUEMA_DA_FILA, nome],
  );
  for (const { assinatura } of funcoes) {
    await cliente.query(`ALTER ROUTINE ${assinatura} OWNER TO ${papel}`);
  }
  const { rows: tipos } = await cliente.query<{ nome: string }>(
    `SELECT t.typname AS nome
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'c')
        AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
        AND pg_get_userbyid(t.typowner) <> $2`,
    [ESQUEMA_DA_FILA, nome],
  );
  for (const { nome: tipo } of tipos) {
    await cliente.query(`ALTER TYPE ${esquema}.${id(tipo)} OWNER TO ${papel}`);
  }
}

/** Situação do papel com que uma conexão fala com o banco (Saúde e aviso na subida). */
export interface PapelDaConexao {
  readonly usuario: string;
  /** Superusuário ou com BYPASSRLS: a RLS não vale para ele. */
  readonly ignoraRls: boolean;
}
