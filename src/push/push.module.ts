import { Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { SERVICO_DE_PUSH, ServicoWebPush } from './servico-de-push';

/**
 * Notificações push (R26): `web-push` com chaves VAPID. Um ouvinte do
 * `NotificacoesService` cria os envios na fila. Nos testes, o provider
 * `SERVICO_DE_PUSH` é trocado por um serviço de push falso.
 */
@Module({
  controllers: [PushController],
  providers: [
    PushService,
    ServicoWebPush,
    { provide: SERVICO_DE_PUSH, useExisting: ServicoWebPush },
  ],
})
export class PushModule {}
