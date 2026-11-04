import { Module } from '@nestjs/common';
import { ContatosModule } from '../contatos/contatos.module';
import { DistribuicaoController } from './distribuicao.controller';
import { DistribuicaoService } from './distribuicao.service';
import { FunisController } from './funis.controller';
import { FunisService } from './funis.service';
import { MetricasService } from './metricas.service';
import { MotorDeNegociosService } from './motor-de-negocios.service';
import { NegociosConsultaService } from './negocios-consulta.service';
import { NegociosController } from './negocios.controller';
import { NegociosService } from './negocios.service';
import { PassagensController } from './passagens.controller';
import { PassagensService } from './passagens.service';

/**
 * Funis, etapas, negócios, movimentação, passagens, distribuição por rodízio e
 * métricas (R5).
 *
 * Exporta, para os webhooks de entrada (contrato §5):
 * - `NegociosService.criarAutomatico(tx, entrada)` — cria o negócio com
 *   distribuição ou registra a reconversão (R5.6, R5.8), notifica o
 *   responsável e executa as passagens (R5.7);
 * - `DistribuicaoService.escolherResponsavel(tx, area, estrategia, responsavelFixoId?)`.
 *
 * Os funis-base, etapas, passagens e regras de rodízio nascem na configuração
 * inicial (`src/seeds`). A linha do tempo do negócio (R3.5) usa o
 * `LinhaDoTempoService` do módulo de contatos.
 */
@Module({
  imports: [ContatosModule],
  controllers: [
    FunisController,
    NegociosController,
    PassagensController,
    DistribuicaoController,
  ],
  providers: [
    FunisService,
    NegociosService,
    NegociosConsultaService,
    MotorDeNegociosService,
    PassagensService,
    DistribuicaoService,
    MetricasService,
  ],
  exports: [NegociosService, DistribuicaoService, MotorDeNegociosService],
})
export class FunisModule {}
