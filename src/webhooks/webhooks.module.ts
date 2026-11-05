import { Module } from '@nestjs/common';
import { ContatosModule } from '../contatos/contatos.module';
import { FunisModule } from '../funis/funis.module';
import { ProcessamentoEntradaService } from './entrada/processamento-entrada.service';
import { RecebimentosService } from './entrada/recebimentos.service';
import { AplicacaoDoRecebimento } from './entrada/aplicacao-do-recebimento';
import { AplicativosService } from './entrada/aplicativos.service';
import {
  AplicativosController,
  HistoricoDeRecebimentosController,
  WebhookEntradaPublicoController,
  WebhooksEntradaController,
} from './entrada/webhooks-entrada.controller';
import { WebhooksEntradaService } from './entrada/webhooks-entrada.service';
import { ConexoesFacebookService } from './facebook/conexoes-facebook.service';
import {
  FacebookController,
  FacebookPublicoController,
} from './facebook/facebook.controller';
import { FacebookLeadAdsService } from './facebook/facebook-lead-ads.service';
import { AppsDeLoginController } from './login/apps-de-login.controller';
import { AppsDeLoginService } from './login/apps-de-login.service';
import {
  ConexoesAplicativoController,
  ConexoesAplicativoPublicoController,
} from './login/conexoes-aplicativo.controller';
import { ConexoesAplicativoService } from './login/conexoes-aplicativo.service';
import { ParseAplicativoDeLoginPipe } from './login/parse-aplicativo.pipe';
import { RdStationService } from './login/rd-station.service';
import { EntregasService } from './saida/entregas.service';
import { WebhooksSaidaController } from './saida/webhooks-saida.controller';
import { WebhooksSaidaService } from './saida/webhooks-saida.service';

/**
 * Webhooks de entrada (captação de leads, R8) e de saída (eventos, R9).
 *
 * - Entrada: o Admin configura os pontos em `/webhooks/entradas`; os leads
 *   chegam em `POST /webhooks/entrada/:token` (sem login nem verificação de
 *   origem, R2.9) e são processados pela fila `webhooks-entrada.processar`
 *   com `ContatosService.encontrarOuCriar` e `NegociosService.criarAutomatico`.
 * - Saída: o Admin cadastra destinos em `/webhooks/saidas`; um manipulador da
 *   outbox cria as entregas e a fila `webhooks-saida.entregar` as envia, com a
 *   agenda de novas tentativas da R9.4.
 */
@Module({
  imports: [ContatosModule, FunisModule],
  controllers: [
    WebhooksEntradaController,
    WebhookEntradaPublicoController,
    AplicativosController,
    HistoricoDeRecebimentosController,
    WebhooksSaidaController,
    FacebookController,
    FacebookPublicoController,
    AppsDeLoginController,
    ConexoesAplicativoController,
    ConexoesAplicativoPublicoController,
  ],
  providers: [
    WebhooksEntradaService,
    AplicativosService,
    AplicacaoDoRecebimento,
    RecebimentosService,
    ProcessamentoEntradaService,
    WebhooksSaidaService,
    EntregasService,
    ConexoesFacebookService,
    FacebookLeadAdsService,
    ParseAplicativoDeLoginPipe,
    AppsDeLoginService,
    ConexoesAplicativoService,
    RdStationService,
  ],
  // Automações (Onda B): a ação "chamar webhook de saída" cria entregas.
  // Meta (R14, R32.14): o roteador do webhook entrega os `leadgen` ao Facebook Lead Ads.
  // Canais Messenger/Instagram (H4): criam sem digitar o app, usando o das Configurações.
  exports: [EntregasService, FacebookLeadAdsService, AppsDeLoginService],
})
export class WebhooksModule {}
