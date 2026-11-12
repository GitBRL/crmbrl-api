import { Module } from '@nestjs/common';
import { FinanceiroModule } from '../financeiro/financeiro.module';
import { BiController } from './bi.controller';
import { BiService } from './bi.service';
import { ExportacaoBiService } from './exportacao-bi.service';
import { FiltrosBiService } from './filtros-bi.service';
import { PainelAtendimentoService } from './painel-atendimento.service';
import { PainelComercialService } from './painel-comercial.service';
import { PainelCsService } from './painel-cs.service';
import { PainelFinanceiroService } from './painel-financeiro.service';
import { PainelSdrService } from './painel-sdr.service';
import { PainelMarketingService } from './painel-marketing.service';

/**
 * BI (R20, Onda C): API de métricas dos painéis Marketing, Comercial, CS e
 * Atendimento e Financeiro, com período e comparação, filtros comuns, cache curto e
 * exportação CSV/XLSX. Só lê (consultas agregadas em SQL); a única escrita é
 * a auditoria da exportação.  O Financeiro e o risco de churn do CS leem
 * os serviços de `src/financeiro`.
 */
@Module({
  imports: [FinanceiroModule],
  controllers: [BiController],
  providers: [
    BiService,
    FiltrosBiService,
    ExportacaoBiService,
    PainelMarketingService,
    PainelComercialService,
    PainelCsService,
    PainelAtendimentoService,
    PainelSdrService,
    PainelFinanceiroService,
  ],
  exports: [BiService, FiltrosBiService],
})
export class BiModule {}
