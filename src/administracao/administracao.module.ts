import { Module } from '@nestjs/common';
import { AdministracaoController } from './administracao.controller';
import { LogsTecnicosConsultaService } from './logs-tecnicos-consulta.service';
import { ResumoAdministracaoService } from './resumo-administracao.service';
import { RetencaoService } from './retencao.service';

/**
 * Administração (só Admin): consulta dos logs técnicos (R3.6), resumo do
 * sistema e o job diário de retenção de 90 dias dos logs técnicos e dos
 * recebimentos de webhook (R3.6, R8.6), pela fila (pg-boss).
 */
@Module({
  controllers: [AdministracaoController],
  providers: [
    LogsTecnicosConsultaService,
    ResumoAdministracaoService,
    RetencaoService,
  ],
  exports: [RetencaoService],
})
export class AdministracaoModule {}
