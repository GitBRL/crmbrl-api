import { Module } from '@nestjs/common';
import { AuditoriaConsultaController } from './auditoria-consulta.controller';
import { AuditoriaConsultaService } from './auditoria-consulta.service';

/**
 * Consulta da auditoria com filtros e cursor (R3.4), para Admin e C-level.
 * A gravação fica no `AuditoriaService` (`src/auditoria`, da base).
 */
@Module({
  controllers: [AuditoriaConsultaController],
  providers: [AuditoriaConsultaService],
  exports: [AuditoriaConsultaService],
})
export class AuditoriaConsultaModule {}
