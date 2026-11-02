import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configurarAplicacao, OPCOES_DA_APLICACAO } from './aplicacao';
import { AppModule } from './app.module';
import { lerAmbiente } from './config/ambiente';
import { configurarDocumentacao } from './documentacao';
import { criarLogger } from './logs/logger';
import { carregarObservabilidade } from './observabilidade';
import { lerVersao } from './saude/saude.service';
import { configurarTempoReal } from './tempo-real/adaptador-socket-io';

const logger = new Logger('Inicialização');

async function iniciar(): Promise<void> {
  // Em desenvolvimento as variáveis vêm do .env; no container, do ambiente.
  // O que já está definido no ambiente tem prioridade sobre o arquivo.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const ambiente = lerAmbiente();
  const loggerDaAplicacao = criarLogger(ambiente);
  Logger.overrideLogger(loggerDaAplicacao);
  for (const aviso of ambiente.avisos) {
    logger.warn(aviso);
  }

  const observabilidade = await carregarObservabilidade(ambiente);
  if (!observabilidade) {
    logger.log(
      '@nestjs/observe desligado (defina OBSERVE_APP_KEY e OBSERVE_APP_SECRET para ligar).',
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(ambiente, observabilidade?.modulo),
    {
      ...OPCOES_DA_APLICACAO,
      instrument: observabilidade?.instrumento,
      logger: loggerDaAplicacao,
    },
  );
  configurarAplicacao(app, ambiente);
  configurarTempoReal(app, ambiente);
  configurarDocumentacao(app, ambiente, lerVersao());
  app.enableShutdownHooks();

  await app.listen(ambiente.porta);
  logger.log(
    `API ouvindo na porta ${ambiente.porta} — saúde em /api/saude, rotas em /api/v1, ` +
      `tempo real em /api/socket.io, ` +
      `documentação em /api/docs${ambiente.docsPublicas ? '' : ' (só Admin)'} (ambiente: ${ambiente.nodeEnv}).`,
  );
}

iniciar().catch((erro: unknown) => {
  logger.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
});
