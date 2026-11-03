import { Global, Module } from '@nestjs/common';
import { EmailCanalModule } from './email/email-canal.module';
import { MetaModule } from './meta/meta.module';
import { RegistroCanais } from './registro-canais';
import { WebchatModule } from './webchat/webchat.module';
import { WhatsappCanalModule } from './whatsapp/whatsapp-canal.module';
import { WhatsappOficialModule } from './whatsapp-oficial/whatsapp-oficial.module';

/**
 * Registro dos adaptadores de canal, global: cada módulo de canal injeta o
 * `RegistroCanais` para se registrar, e o Atendimento, para enviar.
 */
@Global()
@Module({
  providers: [RegistroCanais],
  exports: [RegistroCanais],
})
export class RegistroCanaisModule {}

/**
 * Canais de atendimento (§2.3–§2.5): o registro e os módulos de cada canal.
 * O `AppModule` importa só este; um canal novo entra na lista abaixo.
 *
 * - `WhatsappCanalModule` — WhatsApp pelo gateway próprio (`src/whatsapp/**`);
 * - `WebchatModule` — chat do site;
 * - `EmailCanalModule` — e-mail (IMAP/SMTP);
 * - `MetaModule` — Instagram e Messenger;
 * - `WhatsappOficialModule` — WhatsApp pela Cloud API da Meta (Onda E, R28).
 */
@Module({
  imports: [
    RegistroCanaisModule,
    WhatsappCanalModule,
    WebchatModule,
    EmailCanalModule,
    MetaModule,
    WhatsappOficialModule,
  ],
  exports: [RegistroCanaisModule, WhatsappCanalModule],
})
export class CanaisModule {}
