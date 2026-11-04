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
  ],
  providers: [
    WebhooksEntradaService,
    AplicativosService,
    AplicacaoDoRecebimento,
    RecebimentosService,
    ProcessamentoEntradaService,
    WebhooksSaidaService,
    EntregasService,
  ],
  // Automações (Onda B): a ação "chamar webhook de saída" cria entregas.
  exports: [EntregasService],
})
export class WebhooksModule {}
