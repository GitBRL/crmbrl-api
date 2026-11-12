import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { lerAmbiente } from '../config/ambiente';
import type { PrismaService } from '../prisma/prisma.service';
import { PRAZO_DA_VERIFICACAO_MS, SaudeService } from './saude.service';

const AMBIENTE_DE_TESTE = lerAmbiente({
  DATABASE_URL: 'postgresql://crmbrl:senha-secreta@banco:5432/crmbrl',
  NODE_ENV: 'test',
});

const VERSAO = (
  JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

/** Responde às consultas da verificação pelo texto do SQL. */
type Banco = (sql: string) => Promise<unknown>;

const bancoSaudavel: Banco = (sql) => {
  if (sql.includes('to_regclass')) {
    return Promise.resolve([{ existe: true }]);
  }
  if (sql.includes('_prisma_migrations')) {
    return Promise.resolve([
      { aplicadas: 1, ultima: '20261020180000_inicial' },
    ]);
  }
  return Promise.resolve([{ '?column?': 1 }]);
};

/** O erro que o Prisma 7 lança com o banco fora do ar (mensagem com host e porta). */
const bancoForaDoAr: Banco = () =>
  Promise.reject(
    Object.assign(
      new Error(
        "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `N/A`. Message: `Can't reach database server at banco:5432`",
      ),
      {
        code: 'P2010',
        meta: {
          driverAdapterError: {
            cause: { kind: 'DatabaseNotReachable', host: 'banco', port: 5432 },
          },
        },
      },
    ),
  );

function criarServico(banco: Banco): SaudeService {
  const prisma = {
    $queryRaw: (partes: TemplateStringsArray) => banco(partes.join('?')),
  };
  return new SaudeService(
    prisma as unknown as PrismaService,
    AMBIENTE_DE_TESTE,
  );
}

describe('SaudeService', () => {
  let logs: jest.SpyInstance;
  let avisos: jest.SpyInstance;

  beforeEach(() => {
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    avisos = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('responde ok com versão, ambiente, banco e migrations', async () => {
    const saude = await criarServico(bancoSaudavel).verificar();

    expect(saude).toEqual({
      status: 'ok',
      versao: VERSAO,
      ambiente: 'test',
      horario: expect.any(String) as string,
      uptimeSegundos: expect.any(Number) as number,
      banco: { status: 'ok', latenciaMs: expect.any(Number) as number },
      migrations: { aplicadas: 1, ultima: '20261020180000_inicial' },
      avisos: expect.any(Array) as string[],
    });
    expect(new Date(saude.horario).toISOString()).toBe(saude.horario);
    expect(Number.isInteger(saude.uptimeSegundos)).toBe(true);
    expect(saude.banco.latenciaMs).toBeGreaterThanOrEqual(0);
  });

  it('fica degradado, sem migrations, quando o SELECT 1 falha', async () => {
    const saude = await criarServico(bancoForaDoAr).verificar();

    expect(saude.status).toBe('degradado');
    expect(saude.banco).toEqual({
      status: 'erro',
      latenciaMs: expect.any(Number) as number,
      erro: 'Não foi possível conectar ao banco.',
    });
    expect(saude.migrations).toBeNull();
  });

  it('não expõe senha, host nem a mensagem do driver na resposta', async () => {
    const corpo = JSON.stringify(await criarServico(bancoForaDoAr).verificar());

    expect(corpo).not.toContain('senha-secreta');
    expect(corpo).not.toContain('banco:5432');
    expect(corpo).not.toContain('prisma');
  });

  it('conta zero migrations num banco que nunca foi migrado', async () => {
    const semTabela: Banco = (sql) =>
      sql.includes('to_regclass')
        ? Promise.resolve([{ existe: false }])
        : bancoSaudavel(sql);

    const saude = await criarServico(semTabela).verificar();

    expect(saude.status).toBe('ok');
    expect(saude.migrations).toEqual({ aplicadas: 0, ultima: null });
  });

  it('fica degradado quando a leitura das migrations falha', async () => {
    const migrationsQuebradas: Banco = (sql) =>
      sql.includes('_prisma_migrations') && !sql.includes('to_regclass')
        ? bancoForaDoAr(sql)
        : bancoSaudavel(sql);

    const saude = await criarServico(migrationsQuebradas).verificar();

    expect(saude.status).toBe('degradado');
    expect(saude.banco.status).toBe('erro');
    expect(saude.migrations).toBeNull();
  });

  it(`desiste do banco depois de ${PRAZO_DA_VERIFICACAO_MS} ms`, async () => {
    jest.useFakeTimers();
    const travado: Banco = () => new Promise<never>(() => undefined);

    const verificacao = criarServico(travado).verificar();
    await jest.advanceTimersByTimeAsync(PRAZO_DA_VERIFICACAO_MS);
    const saude = await verificacao;

    expect(saude.status).toBe('degradado');
    expect(saude.banco.erro).toBe(
      `O banco não respondeu em ${PRAZO_DA_VERIFICACAO_MS} ms.`,
    );
  });

  it('registra no log só quando o estado do banco muda', async () => {
    let foraDoAr = true;
    const servico = criarServico((sql) =>
      foraDoAr ? bancoForaDoAr(sql) : bancoSaudavel(sql),
    );

    await servico.verificar();
    await servico.verificar();
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos).toHaveBeenCalledWith(
      expect.stringContaining('Banco indisponível'),
    );

    foraDoAr = false;
    await servico.verificar();
    await servico.verificar();
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(
      expect.stringContaining('Banco respondendo'),
    );
  });

  it('verifica o banco quando a aplicação sobe', async () => {
    await criarServico(bancoSaudavel).onApplicationBootstrap();

    expect(logs).toHaveBeenCalledWith(
      expect.stringContaining('última: 20261020180000_inicial'),
    );
  });
});
