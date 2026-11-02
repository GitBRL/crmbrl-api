import { Global, Module } from '@nestjs/common';
import { EventosDominioService } from './eventos-dominio.service';

/** Eventos de domínio com outbox (R10.1), para todos os módulos. */
@Global()
@Module({
  providers: [EventosDominioService],
  exports: [EventosDominioService],
})
export class EventosModule {}
