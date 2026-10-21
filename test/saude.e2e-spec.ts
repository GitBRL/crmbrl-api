import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configurarAplicacao, OPCOES_DA_APLICACAO } from '../src/aplicacao';
import { ComumModule } from '../src/comum/comum.module';
import { type Ambiente, lerAmbiente } from '../src/config/ambiente';
import { AmbienteModule } from '../src/config/ambiente.module';
import { LogsModule } from '../src/logs/logs.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SaudeModule } from '../src/saude/saude.module';

const AMBIENTE_DE_TESTE = lerAmbiente({
  DATABASE_URL: 'postgresql://crmbrl:senha-secreta@banco:5432/crmbrl',
  NODE_ENV: 'test',
});

/**
 * Substitui o PrismaService: responde às consultas da verificação de saúde
 * sem banco nenhum. `foraDoAr` simula o PostgreSQL desligado.
 */
class PrismaFalso {
  foraDoAr = false;

  $queryRaw(partes: TemplateStringsArray): Promise<unknown> {
    const sql = partes.join('?');
    if (this.foraDoAr) {
      return Promise.reject(
        Object.assign(new Error("Can't reach database server at banco:5432"), {
          code: 'P2010',
          meta: {
            driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } },
          },
        }),
      );
    }
    if (sql.includes('to_regclass')) {
      return Promise.resolve([{ existe: true }]);
    }
    if (sql.includes('_prisma_migrations')) {
      return Promise.resolve([
        { aplicadas: 1, ultima: '20261020180000_inicial' },
      ]);
    }
    return Promise.resolve([{ '?column?': 1 }]);
  }

  $connect(): Promise<void> {
    return Promise.resolve();
  }

  $disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Só o necessário para a saúde (sem fila, seeds nem autenticação, que precisam
 * de banco): o mesmo `configurarAplicacao` do `main.ts` e o filtro de erros.
 */
async function criarAplicacao(
  prisma: PrismaFalso,
  ambiente: Ambiente = AMBIENTE_DE_TESTE,
): Promise<INestApplication<App>> {
  const modulo = await Test.createTestingModule({
    imports: [
      AmbienteModule.forRoot(ambiente),
      PrismaModule,
      LogsModule,
      ComumModule,
      SaudeModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = modulo.createNestApplication<NestExpressApplication>({
    ...OPCOES_DA_APLICACAO,
    logger: false,
  });
  configurarAplicacao(app, ambiente);
  await app.init();
  return app;
}

describe('GET /api/saude (e2e)', () => {
  const prisma = new PrismaFalso();
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await criarAplicacao(prisma);
  });

  afterEach(() => {
    prisma.foraDoAr = false;
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde 200 com o contrato completo quando o banco responde', async () => {
    const resposta = await request(app.getHttpServer())
      .get('/api/saude')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Cache-Control', 'no-store');

    expect(resposta.body).toEqual({
      status: 'ok',
      versao: '0.0.1',
      ambiente: 'test',
      horario: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) as string,
      uptimeSegundos: expect.any(Number) as number,
      banco: { status: 'ok', latenciaMs: expect.any(Number) as number },
      migrations: { aplicadas: 1, ultima: '20261020180000_inicial' },
    });
    expect(Object.keys(resposta.body as object)).toEqual([
      'status',
      'versao',
      'ambiente',
      'horario',
      'uptimeSegundos',
      'banco',
      'migrations',
    ]);
  });

  it('responde 503 com o mesmo corpo, degradado, quando o banco falha', async () => {
    prisma.foraDoAr = true;

    const resposta = await request(app.getHttpServer())
      .get('/api/saude')
      .expect(503);

    expect(resposta.body).toMatchObject({
      status: 'degradado',
      versao: '0.0.1',
      banco: { status: 'erro', erro: 'Não foi possível conectar ao banco.' },
      migrations: null,
    });
    expect(resposta.text).not.toContain('senha-secreta');
    expect(resposta.text).not.toContain('banco:5432');
  });

  it('fica fora do versionamento: /api/saude, e não /api/v1/saude', async () => {
    await request(app.getHttpServer()).get('/api/saude').expect(200);
    await request(app.getHttpServer()).get('/api/v1/saude').expect(404);
  });

  it('só atende com o prefixo /api, e o 404 sai no formato padrão de erro', async () => {
    await request(app.getHttpServer()).get('/saude').expect(404);
    const resposta = await request(app.getHttpServer())
      .get('/api/nao-existe')
      .expect(404);
    expect(resposta.body).toEqual({
      statusCode: 404,
      erro: 'nao_encontrado',
      mensagem: 'Rota não encontrada.',
      requisicaoId: resposta.headers['x-request-id'],
    });
  });

  it('R3.7 — devolve X-Request-Id: o recebido, quando aceitável, ou um novo', async () => {
    const recebido = await request(app.getHttpServer())
      .get('/api/saude')
      .set('X-Request-Id', 'req-123.abc')
      .expect(200);
    expect(recebido.headers['x-request-id']).toBe('req-123.abc');

    const gerado = await request(app.getHttpServer())
      .get('/api/saude')
      .expect(200);
    expect(gerado.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const recusado = await request(app.getHttpServer())
      .get('/api/saude')
      .set('X-Request-Id', 'tem espaço e <script>')
      .expect(200);
    expect(recusado.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('confia em um salto de proxy e não anuncia o Express', async () => {
    const express = app.getHttpAdapter().getInstance() as {
      get(chave: string): unknown;
    };
    expect(express.get('trust proxy')).toBe(1);

    const resposta = await request(app.getHttpServer()).get('/api/saude');
    expect(resposta.headers['x-powered-by']).toBeUndefined();
  });

  it('deixa o CORS desligado sem CORS_ORIGENS', async () => {
    const resposta = await request(app.getHttpServer())
      .get('/api/saude')
      .set('Origin', 'http://localhost:4200');
    expect(resposta.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS com CORS_ORIGENS (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await criarAplicacao(new PrismaFalso(), {
      ...AMBIENTE_DE_TESTE,
      corsOrigens: ['http://localhost:4200'],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('libera só as origens configuradas, com credenciais (cookie de sessão)', async () => {
    const liberada = await request(app.getHttpServer())
      .get('/api/saude')
      .set('Origin', 'http://localhost:4200')
      .expect(200);
    expect(liberada.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(liberada.headers['access-control-allow-credentials']).toBe('true');

    const outra = await request(app.getHttpServer())
      .get('/api/saude')
      .set('Origin', 'https://outro.exemplo');
    expect(outra.headers['access-control-allow-origin']).toBeUndefined();
  });
});
