import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { configurarAplicacao, OPCOES_DA_APLICACAO } from '../../src/aplicacao';
import { AppModule } from '../../src/app.module';
import type { Ambiente, VariaveisDeAmbiente } from '../../src/config/ambiente';
import { configurarDocumentacao } from '../../src/documentacao';
import { EmailService } from '../../src/email/email.service';
import { EventosDominioService } from '../../src/eventos/eventos-dominio.service';
import { FilaService } from '../../src/fila/fila.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ambienteDeTeste } from './ambiente-teste';
import { limparBanco } from './banco';
import { EmailFalso } from './email-falso';

export interface OpcoesAppTeste {
  /** Sobrescreve variáveis de ambiente (ex.: `{ ADMIN_EMAIL: '…' }`, `{ DOCS_PUBLICAS: 'false' }`). */
  variaveis?: VariaveisDeAmbiente;
  /** Módulos extras (ex.: um controller só de teste). */
  importar?: Array<Type<unknown> | DynamicModule>;
  /** Ajustes no módulo antes de compilar (ex.: `overrideProvider`). */
  ajustar?: (construtor: TestingModuleBuilder) => TestingModuleBuilder;
  /** Mostra os logs da aplicação (padrão: só erros não tratados somem também). */
  logs?: boolean;
  /** Limpa o banco e refaz a configuração inicial ao criar (padrão: `true`). */
  limpar?: boolean;
}

/** A aplicação Nest real, ligada ao banco de teste, pronta para o supertest. */
export interface AppTeste {
  readonly app: INestApplication<App>;
  readonly ambiente: Ambiente;
  readonly prisma: PrismaService;
  readonly fila: FilaService;
  readonly eventos: EventosDominioService;
  /** O `EmailService` falso: `email.enviados`, `email.tokenDoUltimo(para)`. */
  readonly email: EmailFalso;
  /** Servidor HTTP para o `supertest` (`request(t.servidor)`); prefira `clienteAnonimo`/`entrarComo`. */
  readonly servidor: App;
  /** Atalho para `app.get(...)`. */
  get<T>(token: Type<T> | string | symbol): T;
  /** TRUNCATE de tudo (menos `_prisma_migrations`), jobs apagados e configuração inicial refeita. */
  limparBanco(): Promise<void>;
  fechar(): Promise<void>;
}

/**
 * Sobe a API inteira (o mesmo `AppModule`, `configurarAplicacao` e Swagger do
 * `main.ts`) contra o banco de `DATABASE_URL_TESTE`, com o e-mail falso e
 * `PROCESSAR_FILAS=false`.
 *
 * ```ts
 * let t: AppTeste;
 * beforeAll(async () => { t = await criarAppTeste(); });
 * beforeEach(() => t.limparBanco());
 * afterAll(() => t.fechar());
 * ```
 */
export async function criarAppTeste(
  opcoes: OpcoesAppTeste = {},
): Promise<AppTeste> {
  const ambiente = ambienteDeTeste(opcoes.variaveis);
  const email = new EmailFalso();
  let construtor = Test.createTestingModule({
    imports: [AppModule.forRoot(ambiente), ...(opcoes.importar ?? [])],
  })
    .overrideProvider(EmailService)
    .useValue(email);
  if (opcoes.ajustar) {
    construtor = opcoes.ajustar(construtor);
  }
  const modulo = await construtor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>({
    ...OPCOES_DA_APLICACAO,
    logger: opcoes.logs ? ['log', 'error', 'warn', 'fatal'] : false,
  });
  configurarAplicacao(app, ambiente);
  configurarDocumentacao(app, ambiente, '0.0.0-teste');
  await app.init();

  const appTeste: AppTeste = {
    app: app as INestApplication<App>,
    ambiente,
    prisma: app.get(PrismaService),
    fila: app.get(FilaService),
    eventos: app.get(EventosDominioService),
    email,
    servidor: app.getHttpServer() as App,
    get: <T>(token: Type<T> | string | symbol) =>
      app.get<T>(token, { strict: false }),
    limparBanco: () => limparBanco(appTeste),
    fechar: () => app.close(),
  };
  if (opcoes.limpar ?? true) {
    await appTeste.limparBanco();
  }
  return appTeste;
}
