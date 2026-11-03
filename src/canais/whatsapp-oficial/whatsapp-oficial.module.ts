import { Module } from '@nestjs/common';
import { AtendimentoModule } from '../../atendimento/atendimento.module';
import { CanaisComumModule } from '../comum/canais-comum.module';
import { GraphApi } from '../meta/graph-api';
import { AdaptadorWhatsappOficial } from './adaptador-whatsapp-oficial';
import { EntradaWhatsappOficialService } from './entrada-whatsapp-oficial.service';
import { GraphWhatsappOficial } from './graph-whatsapp-oficial';
import { TemplatesOficiaisService } from './templates-oficiais.service';
import { WebhookWhatsappOficialService } from './webhook-whatsapp-oficial.service';
import { WhatsappOficialCanaisController } from './whatsapp-oficial-canais.controller';
import { WhatsappOficialCanaisService } from './whatsapp-oficial-canais.service';

/**
 * WhatsApp oficial (Cloud API da Meta, R28), ao lado do WhatsApp pelo Baileys:
 *
 * - adaptador no `RegistroCanais` (texto, mídia, voz, template, janela de 24 h);
 * - recebimento: o `WebhookMetaService` (`publico/meta/webhook`) entrega aqui o
 *   que vem com `object: whatsapp_business_account`; fila
 *   `whatsapp-oficial.webhook`; roteamento por campo extensível;
 * - configuração pelo Admin em `/api/v1/whatsapp-oficial/canais` (credenciais
 *   cifradas), cache dos templates e sincronização diária (fila
 *   `whatsapp-oficial.templates`).
 */
@Module({
  imports: [AtendimentoModule, CanaisComumModule],
  controllers: [WhatsappOficialCanaisController],
  providers: [
    GraphApi,
    GraphWhatsappOficial,
    TemplatesOficiaisService,
    EntradaWhatsappOficialService,
    WebhookWhatsappOficialService,
    WhatsappOficialCanaisService,
    AdaptadorWhatsappOficial,
  ],
  exports: [
    WebhookWhatsappOficialService,
    EntradaWhatsappOficialService,
    GraphWhatsappOficial,
    TemplatesOficiaisService,
  ],
})
export class WhatsappOficialModule {}
