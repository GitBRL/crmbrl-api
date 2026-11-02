import { Module } from '@nestjs/common';
import { BiModule } from '../bi.module';
import { AnaliseController } from './analise.controller';
import { AnaliseService } from './analise.service';
import {
  ChamadaClaudeService,
  OPCOES_CHAMADA_CLAUDE,
  OPCOES_CHAMADA_PADRAO,
} from './chamada-claude.service';
import { PROVIDER_CLIENTE_ANTHROPIC } from './cliente-anthropic';

/**
 * Análise do BI por IA (R21, só Admin): Claude (`@anthropic-ai/sdk`) sobre os
 * números agregados do painel, em streaming (SSE), com limite diário,
 * histórico e auditoria. O cliente da Anthropic é o provider
 * `CLIENTE_ANTHROPIC` (falso nos testes).
 */
@Module({
  imports: [BiModule],
  controllers: [AnaliseController],
  providers: [
    AnaliseService,
    ChamadaClaudeService,
    PROVIDER_CLIENTE_ANTHROPIC,
    { provide: OPCOES_CHAMADA_CLAUDE, useValue: OPCOES_CHAMADA_PADRAO },
  ],
})
export class AnaliseModule {}
