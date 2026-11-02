import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { lerAmbiente } from '../config/ambiente';
import { criarLogger } from '../logs/logger';
import { configurarGateway } from './aplicacao-gateway';
import { GatewayWhatsappModule } from './gateway-whatsapp.module';

/**
 * Processo do gateway de WhatsApp (§2.3): `node dist/whatsapp/main.js`, na
 * mesma imagem da API (serviço `whatsapp` do compose, sem porta no host).
 * Lê as mesmas variáveis da API; usa `WHATSAPP_PORTA` (padrão 3100),
 * `WHATSAPP_TOKEN_INTERNO` e `WHATSAPP_SIMULADO`. Não aplica migrations: sobe
 * depois da API.
 */
const logger = new Logger('Gateway');

async function iniciar(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const ambiente = lerAmbiente();
  const loggerDoProcesso = criarLogger(ambiente);
  Logger.overrideLogger(loggerDoProcesso);
  for (const aviso of ambiente.avisos) {
    logger.warn(aviso);
  }

  const app = await NestFactory.create<NestExpressApplication>(
    GatewayWhatsappModule.forRoot(ambiente),
    { bodyParser: false, logger: loggerDoProcesso },
  );
  configurarGateway(app);
  app.enableShutdownHooks();
  await app.listen(ambiente.whatsapp.porta);
  logger.log(
    `Gateway de WhatsApp ouvindo na porta ${ambiente.whatsapp.porta} ` +
      `(${ambiente.whatsapp.simulado ? 'modo simulado' : 'Baileys'}; ambiente: ${ambiente.nodeEnv}).`,
  );
}

iniciar().catch((erro: unknown) => {
  logger.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
});
