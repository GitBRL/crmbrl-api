import { Module } from '@nestjs/common';
import { AlertasDeSaudeService } from './alertas-de-saude.service';
import { SaudeDoSistemaController } from './saude-do-sistema.controller';
import { SaudeDoSistemaService } from './saude-do-sistema.service';

/** Painel "Saúde do sistema" e alertas por e-mail ao Admin (R27). */
@Module({
  controllers: [SaudeDoSistemaController],
  providers: [SaudeDoSistemaService, AlertasDeSaudeService],
  exports: [SaudeDoSistemaService],
})
export class MonitoramentoModule {}
