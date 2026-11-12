import type pg from 'pg';
import { prepararConexao } from './pool-com-contexto';

/** Uma conexão falsa: grava o que chega ao banco. */
function conexaoFalsa() {
  const enviados: Array<{ texto: string; valores?: unknown }> = [];
  const cliente = {
    query: jest.fn((config: unknown, valores?: unknown) => {
      const texto =
        typeof config === 'string' ? config : (config as { text: string }).text;
      enviados.push({ texto, valores });
      // O RETURNING devolve o id gravado (como o Prisma pede).
      const gravou = /returning/i.test(texto);
      return Promise.resolve({
        rows: gravou ? [['n1', 'Título']] : [],
        fields: gravou ? [{ name: 'id' }, { name: 'titulo' }] : [],
        rowCount: gravou ? 1 : 0,
      } as unknown as pg.QueryResult);
    }),
  };
  return { cliente: cliente as unknown as pg.PoolClient, enviados };
}

const ajustes = (enviados: Array<{ texto: string; valores?: unknown }>) =>
  enviados
    .filter(({ texto }) => texto.includes("set_config('crm.ator'"))
    .map(({ valores }) => (valores as string[]).slice(0, 2));

describe('pool com contexto (R35.2)', () => {
  it('põe o ator antes da primeira consulta e só de novo quando ele muda', async () => {
    let ator = 'u1';
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => ator });
    await cliente.query('SELECT 1');
    await cliente.query('SELECT * FROM "public"."negocios"');
    expect(ajustes(enviados)).toEqual([['u1', '']]);
    ator = 'sistema';
    await cliente.query({
      text: 'SELECT * FROM "public"."contatos"',
    } as unknown as string);
    expect(ajustes(enviados)).toEqual([
      ['u1', ''],
      ['sistema', ''],
    ]);
  });

  it('a folga de escrita vale só no INSERT/UPDATE/DELETE de tabela protegida, com o nome dela', async () => {
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => 'u1' });
    await cliente.query(
      'UPDATE "public"."negocios" SET "titulo" = $1 WHERE "id" = $2',
      ['x', 'y'],
    );
    await cliente.query(
      'INSERT INTO "public"."eventos_auditoria" ("id") VALUES ($1)',
      ['a'],
    );
    await cliente.query('SELECT * FROM "public"."negocios"');
    await cliente.query('delete from mensagens where id = $1', ['m']);
    await cliente.query('UPDATE negocios_tmp SET x = 1');
    expect(ajustes(enviados)).toEqual([
      ['u1', 'negocios'],
      ['u1', ''],
      ['u1', 'mensagens'],
    ]);
  });

  it('comandos de controle passam direto; o ROLLBACK faz pôr o contexto de novo', async () => {
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => 'u1' });
    await cliente.query('BEGIN');
    await cliente.query('SELECT * FROM conversas');
    await cliente.query('ROLLBACK');
    await cliente.query('SELECT * FROM conversas');
    await cliente.query('COMMIT');
    expect(enviados.map(({ texto }) => texto.slice(0, 20))).toEqual([
      'BEGIN',
      "SELECT set_config('c",
      'SELECT * FROM conver',
      'ROLLBACK',
      "SELECT set_config('c",
      'SELECT * FROM conver',
      'COMMIT',
    ]);
  });

  it('sem contexto, o ator vai vazio (o banco nega)', async () => {
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => '' });
    await cliente.query('SELECT * FROM arquivos');
    expect(ajustes(enviados)).toEqual([['', '']]);
  });

  it('chamadas em paralelo rodam uma por vez, cada uma com o seu ator', async () => {
    const { cliente, enviados } = conexaoFalsa();
    let ator = 'u1';
    prepararConexao(cliente, { ator: () => ator });
    const primeira = cliente.query('SELECT * FROM negocios');
    ator = 'u2';
    const segunda = cliente.query('SELECT * FROM negocios');
    await Promise.all([primeira, segunda]);
    expect(
      enviados.map(({ texto, valores }) => [texto.slice(0, 14), valores]),
    ).toEqual([
      ['SELECT set_con', ['u1', '', '']],
      ['SELECT * FROM ', undefined],
      ['SELECT set_con', ['u2', '', '']],
      ['SELECT * FROM ', undefined],
    ]);
  });

  it('prepara a conexão uma vez só (o pool a reutiliza)', async () => {
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => 'u1' });
    prepararConexao(cliente, { ator: () => 'outro' });
    await cliente.query('SELECT * FROM negocios');
    expect(ajustes(enviados)).toEqual([['u1', '']]);
  });

  it('dentro da transação, a linha gravada pode ser relida (crm.escritos); fora dela, não', async () => {
    const { cliente, enviados } = conexaoFalsa();
    prepararConexao(cliente, { ator: () => 'u1' });
    await cliente.query('BEGIN');
    await cliente.query(
      'UPDATE "public"."negocios" SET "responsavel_id" = $1 WHERE "id" = $2 RETURNING "id", "titulo"',
      ['u2', 'n1'],
    );
    await cliente.query('SELECT * FROM "public"."negocios" WHERE "id" = $1', [
      'n1',
    ]);
    await cliente.query('COMMIT');
    await cliente.query('SELECT * FROM "public"."negocios"');
    const valores = enviados
      .filter(({ texto }) => texto.includes("set_config('crm.ator'"))
      .map(({ valores }) => valores);
    expect(valores).toEqual([
      ['u1', 'negocios', ''],
      ['u1', '', 'n1'],
      ['u1', '', ''],
    ]);
  });
});
