import { Module } from '@nestjs/common';
import { BiModule } from '../bi/bi.module';
import { CalculoIndicadoresService } from './calculo-indicadores.service';
import { FiltrosIndicadoresService } from './filtros-indicadores.service';
import { IndicadoresController } from './indicadores.controller';
import { IndicadoresService } from './indicadores.service';
import { PaineisIndicadoresService } from './paineis-indicadores.service';

/**
 * Indicadores configuráveis (R33, Onda T): painéis montados com indicadores do
 * catálogo, calculados para quem vê com os recortes do BI. Reaproveita do BI
 * a validação de filtros, o cache e a exportação.
 */
@Module({
  imports: [BiModule],
  controllers: [IndicadoresController],
  providers: [
    IndicadoresService,
    PaineisIndicadoresService,
    FiltrosIndicadoresService,
    CalculoIndicadoresService,
  ],
})
export class IndicadoresModule {}
