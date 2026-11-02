import { Global, Module } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';

/**
 * Gravação da auditoria (R3.1–R3.3), disponível para todos os módulos.
 * A consulta (R3.4) fica em `auditoria/consulta` (`AuditoriaConsultaModule`).
 */
@Global()
@Module({
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}
