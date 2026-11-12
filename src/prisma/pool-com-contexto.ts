/**
 * R35.2 — pool do `pg` que leva o contexto da RLS a **toda** consulta da API:
 * as do Prisma (modelos, `$queryRaw`, `$executeRaw`), as das transações
 * interativas e as dos jobs, porque o adapter do Prisma só fala com o banco
 * por este pool (`pool.query` nas consultas soltas; `pool.connect` + `BEGIN`
 * nas transações).
 *
 * Antes de cada consulta, o ator do contexto assíncrono (`atorDoBanco`, lido
 * no instante da chamada) é comparado com o que a conexão já tem; se mudou, um
 * `SELECT set_config('crm.ator', …), …` vai na frente, na mesma conexão. As
 * consultas de uma conexão rodam uma por vez (nada se intercala entre o ajuste
 * e a consulta, nem com chamadas em paralelo dentro de uma transação). Cada
 * conexão guarda o último valor posto, então uma sequência de consultas da
 * mesma pessoa não paga nada a mais. Um `ROLLBACK` desfaz o `set_config` feito
 * dentro da transação: depois dele o valor guardado é esquecido e a próxima
 * consulta o põe de novo. Comandos de controle (`BEGIN`, `COMMIT`, `ROLLBACK`,
 * `SAVEPOINT`…) passam direto — numa transação abortada, só o `ROLLBACK` é
 * aceito.
 *
 * Duas folgas de leitura, para os fluxos em que a pessoa grava uma linha que
 * deixa de ver (passar o negócio a um colega, transferir a conversa):
 * - `crm.escrita` = a tabela de um INSERT/UPDATE/DELETE, só durante ele — o
 *   PostgreSQL confere a linha nova contra a política de leitura dela;
 * - `crm.escritos` = os ids que a transação corrente gravou (devolvidos pelo
 *   `RETURNING`, até 500) — o Prisma relê a linha gravada (`update` com
 *   `include`) e a API a devolve a quem gravou.
 * As duas só são ajustadas nas consultas que citam uma tabela protegida.
 */
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { TABELAS_PROTEGIDAS } from './contexto-do-banco';

const LISTA = TABELAS_PROTEGIDAS.join('|');

/** INSERT/UPDATE/DELETE direto numa tabela protegida (do Prisma ou SQL escrito à mão); captura a tabela. */
const ESCRITA_PROTEGIDA = new RegExp(
  `^\\s*(?:insert\\s+into|update|delete\\s+from)\\s+(?:"?public"?\\s*\\.\\s*)?"?(${LISTA})"?(?=[\\s(]|$)`,
  'i',
);

/** A consulta cita alguma tabela protegida (por nome)? */
const CITA_PROTEGIDA = new RegExp(
  `(?:^|[^a-z0-9_])"?(?:${LISTA})"?(?![a-z0-9_])`,
  'i',
);

/** Comandos de controle de transação: passam sem ajuste de contexto. */
const CONTROLE =
  /^\s*(?:begin|commit|rollback|savepoint|release|end|start\s+transaction|set\s+transaction)\b/i;

const ABRE = /^\s*(?:begin|start\s+transaction)\b/i;
const FECHA = /^\s*(?:commit|end|rollback)\b(?!\s+to\b)/i;
const DESFAZ = /^\s*rollback\b/i;

/** Quantos ids gravados uma transação guarda para reler. */
const MAXIMO_DE_ESCRITOS = 500;

const AJUSTE =
  "SELECT set_config('crm.ator', $1, false), set_config('crm.escrita', $2, false), set_config('crm.escritos', $3, false)";

/** O contexto de uma consulta. */
interface Contexto {
  ator: string;
  escrita: string;
  escritos: string;
}

/** O que a conexão já tem e a transação em curso. */
interface EstadoDaConexao {
  /** O último contexto posto (`undefined` = desconhecido: põe de novo). */
  posto?: Contexto;
  /** Dentro de BEGIN … COMMIT/ROLLBACK. */
  emTransacao: boolean;
  /** Ids gravados pela transação corrente. */
  escritos: Set<string>;
  /** A vez da próxima consulta (uma por vez na conexão). */
  fila?: Promise<void>;
}

const ESTADO = Symbol('contextoDoBanco');

type ClienteComEstado = pg.PoolClient & { [ESTADO]?: EstadoDaConexao };

export interface OpcoesDoPoolComContexto {
  /** O `crm.ator` da consulta que vai rodar (lido no instante da chamada). */
  ator: () => string;
}

const logger = new Logger('ContextoDoBanco');
/** Avisos de consulta sem contexto já dados (um por começo de SQL). */
const avisados = new Set<string>();

function textoDe(config: unknown): string {
  if (typeof config === 'string') {
    return config;
  }
  const texto = (config as { text?: unknown } | null)?.text;
  return typeof texto === 'string' ? texto : '';
}

function avisarSemContexto(texto: string): void {
  const inicio = texto.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (avisados.has(inicio) || avisados.size > 200) {
    return;
  }
  avisados.add(inicio);
  logger.warn(
    `Consulta a uma tabela protegida sem contexto (o banco não devolve nada): ${inicio}`,
  );
}

/** Os ids (coluna `id`) que um INSERT/UPDATE … RETURNING devolveu. */
function idsDoResultado(resultado: pg.QueryResult | undefined): string[] {
  const indice =
    resultado?.fields?.findIndex(({ name }) => name === 'id') ?? -1;
  if (!resultado || indice < 0) {
    return [];
  }
  return resultado.rows.flatMap((linha: unknown) => {
    const valor = Array.isArray(linha)
      ? (linha[indice] as unknown)
      : (linha as Record<string, unknown>).id;
    return typeof valor === 'string' ? [valor] : [];
  });
}

const iguais = (a: Contexto | undefined, b: Contexto): boolean =>
  !!a &&
  a.ator === b.ator &&
  a.escrita === b.escrita &&
  a.escritos === b.escritos;

/**
 * Põe o contexto em dia antes de cada consulta desta conexão (prepara uma vez
 * por conexão; exportada para os testes de unidade).
 */
export function prepararConexao(
  cliente: ClienteComEstado,
  opcoes: OpcoesDoPoolComContexto,
): pg.PoolClient {
  if (cliente[ESTADO]) {
    return cliente;
  }
  const estado: EstadoDaConexao = { emTransacao: false, escritos: new Set() };
  cliente[ESTADO] = estado;
  const original = cliente.query.bind(cliente) as (
    config: unknown,
    valores?: unknown,
  ) => Promise<pg.QueryResult>;

  /** Ajusta o contexto (se mudou) e roda a consulta — sem nada da mesma conexão no meio. */
  const rodar = async (
    texto: string,
    ator: string | null,
    config: unknown,
    valores: unknown,
  ): Promise<pg.QueryResult> => {
    const tabelaEscrita =
      ESCRITA_PROTEGIDA.exec(texto)?.[1]?.toLowerCase() ?? '';
    try {
      if (ator !== null) {
        // As folgas só importam (e só mudam) nas consultas que citam tabela protegida.
        const citaProtegida = CITA_PROTEGIDA.test(texto);
        const desejado: Contexto = {
          ator,
          escrita: citaProtegida
            ? tabelaEscrita
            : (estado.posto?.escrita ?? ''),
          escritos: citaProtegida
            ? estado.emTransacao
              ? [...estado.escritos].join(',')
              : ''
            : (estado.posto?.escritos ?? ''),
        };
        if (!iguais(estado.posto, desejado)) {
          estado.posto = undefined;
          await original(AJUSTE, [
            desejado.ator,
            desejado.escrita,
            desejado.escritos,
          ]);
          estado.posto = desejado;
        }
      }
      const resultado = await original(config, valores);
      if (tabelaEscrita && estado.emTransacao) {
        for (const id of idsDoResultado(resultado)) {
          if (estado.escritos.size >= MAXIMO_DE_ESCRITOS) {
            break;
          }
          estado.escritos.add(id);
        }
      }
      if (ABRE.test(texto)) {
        estado.emTransacao = true;
        estado.escritos.clear();
      }
      return resultado;
    } finally {
      if (DESFAZ.test(texto)) {
        estado.posto = undefined;
      }
      if (FECHA.test(texto)) {
        estado.emTransacao = false;
        estado.escritos.clear();
      }
    }
  };

  const consultar = (
    config: unknown,
    valores?: unknown,
  ): Promise<pg.QueryResult> => {
    const texto = textoDe(config);
    // O ator é lido agora, no contexto assíncrono de quem chamou.
    const ator = CONTROLE.test(texto) ? null : opcoes.ator();
    if (ator === '' && CITA_PROTEGIDA.test(texto)) {
      avisarSemContexto(texto);
    }
    // Uma consulta por vez nesta conexão.
    const vez = (estado.fila ?? Promise.resolve()).then(() =>
      rodar(texto, ator, config, valores),
    );
    estado.fila = vez.then(
      () => undefined,
      () => undefined,
    );
    return vez;
  };

  (cliente as unknown as { query: unknown }).query = (
    config: unknown,
    valores?: unknown,
    retorno?: unknown,
  ): Promise<pg.QueryResult> | undefined => {
    const callback =
      typeof retorno === 'function'
        ? retorno
        : typeof valores === 'function'
          ? valores
          : undefined;
    const promessa = consultar(
      config,
      typeof valores === 'function' ? undefined : valores,
    );
    if (!callback) {
      return promessa;
    }
    promessa.then(
      (resultado) =>
        (callback as (e: unknown, r?: unknown) => void)(null, resultado),
      (erro: unknown) => (callback as (e: unknown) => void)(erro),
    );
    return undefined;
  };
  return cliente;
}

/**
 * Um `pg.Pool` comum (o adapter do Prisma exige `instanceof pg.Pool`) com
 * `connect` e `query` que põem o contexto da RLS em cada consulta.
 */
export function criarPoolComContexto(
  config: pg.PoolConfig,
  opcoes: OpcoesDoPoolComContexto,
): pg.Pool {
  const pool = new pg.Pool(config);
  const conectarOriginal = pool.connect.bind(
    pool,
  ) as () => Promise<pg.PoolClient>;

  const conectar = async (): Promise<pg.PoolClient> =>
    prepararConexao(await conectarOriginal(), opcoes);

  (pool as unknown as { connect: unknown }).connect = (
    retorno?: (
      erro: Error | undefined,
      cliente?: pg.PoolClient,
      liberar?: () => void,
    ) => void,
  ): Promise<pg.PoolClient> | undefined => {
    if (!retorno) {
      return conectar();
    }
    conectar().then(
      (cliente) => retorno(undefined, cliente, () => cliente.release()),
      (erro: Error) => retorno(erro),
    );
    return undefined;
  };

  // Como o `pool.query` do `pg`: pega uma conexão, consulta e devolve — e, se
  // a consulta falhar, descarta a conexão (o mesmo `release(erro)` do original).
  (pool as unknown as { query: unknown }).query = async (
    config: unknown,
    valores?: unknown,
  ): Promise<pg.QueryResult> => {
    if (typeof valores === 'function' || typeof config === 'function') {
      throw new Error('pool.query com callback não é suportado aqui.');
    }
    const cliente = await conectar();
    try {
      const resultado = await (
        cliente.query as (c: unknown, v?: unknown) => Promise<pg.QueryResult>
      )(config, valores);
      cliente.release();
      return resultado;
    } catch (erro) {
      cliente.release(erro as Error);
      throw erro;
    }
  };
  return pool;
}
