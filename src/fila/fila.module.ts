import { Global, Module } from '@nestjs/common';
import { FilaService } from './fila.service';

/** Fila de jobs e agendamentos (pg-boss), para todos os módulos. */
@Global()
@Module({
  providers: [FilaService],
  exports: [FilaService],
})
export class FilaModule {}
