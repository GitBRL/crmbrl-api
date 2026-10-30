import { Global, Module } from '@nestjs/common';
import { GatilhosService } from './gatilhos/gatilhos.service';
import { ModelosController } from './modelos/modelos.controller';
import { ModelosService } from './modelos/modelos.service';
import { PassosService } from './passos/passos.service';
import { SegmentosController } from './segmentos/segmentos.controller';
import { SegmentosService } from './segmentos/segmentos.service';

/**
 * Peças compartilhadas da Onda B (§2.1), globais: renderizador de modelos,
 * segmentos, executor de passos e gatilhos. Usadas por importação, disparos,
 * chatbot e automações. Rotas: `/modelos/*` e `/segmentos/*` (editor do front).
 */
@Global()
@Module({
  controllers: [ModelosController, SegmentosController],
  providers: [ModelosService, SegmentosService, PassosService, GatilhosService],
  exports: [ModelosService, SegmentosService, PassosService, GatilhosService],
})
export class AutomacaoComumModule {}
