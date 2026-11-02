import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../../atendimento/atendimento.module';
import { CanaisComumModule } from '../comum/canais-comum.module';
import { WhatsappOficialModule } from '../whatsapp-oficial/whatsapp-oficial.module';
import { AdaptadorInstagram, AdaptadorMessenger } from './adaptadores-meta';
import { GraphApi } from './graph-api';
import { MetaCanaisController } from './meta-canais.controller';
import { MetaCanaisService } from './meta-canais.service';
import { WebhookMetaController } from './webhook-meta.controller';
import { WebhookMetaService } from './webhook-meta.service';

/**
 * Instagram e Messenger (Graph API da Meta, §2.5, R14):
 *
 * - webhook público `GET|POST /api/v1/publico/meta/webhook` (desafio de
 *   verificação, assinatura `X-Hub-Signature-256`, fila `meta.webhook`);
 * - adaptadores com o envio pela Graph API (`META_GRAPH_URL`/`META_GRAPH_VERSAO`)
 *   e a janela de 24 h;
 * - configuração pelo Admin em `/api/v1/meta/canais` (credenciais cifradas);
 * - o que vem com `object: whatsapp_business_account` é do WhatsApp oficial
 *   (`WhatsappOficialModule`, R28).
 */
@Module({
  imports: [AtendimentoModule, CanaisComumModule, WhatsappOficialModule],
  controllers: [WebhookMetaController, MetaCanaisController],
  providers: [
    GraphApi,
    WebhookMetaService,
    MetaCanaisService,
    AdaptadorInstagram,
    AdaptadorMessenger,
  ],
})
export class MetaModule {}
