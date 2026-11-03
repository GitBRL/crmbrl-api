import { Global, Module } from '@nestjs/common';
import { LogsTecnicosService } from './logs-tecnicos.service';

/**
 * Logs técnicos no banco (R3.6). O log HTTP e o `X-Request-Id` (R3.7) ficam no
 * middleware de requisição, registrado em `configurarAplicacao`.
 */
@Global()
@Module({
  providers: [LogsTecnicosService],
  exports: [LogsTecnicosService],
})
export class LogsModule {}
