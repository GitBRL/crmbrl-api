import { Global, Module } from '@nestjs/common';
import { NotificacoesController } from './notificacoes.controller';
import { OuvintesDeNotificacao } from './ouvintes-notificacao';
import { NotificacoesService } from './notificacoes.service';

/** Notificações internas (R10.2): `NotificacoesService` para todos os módulos e os endpoints do usuário. */
@Global()
@Module({
  controllers: [NotificacoesController],
  providers: [NotificacoesService, OuvintesDeNotificacao],
  exports: [NotificacoesService, OuvintesDeNotificacao],
})
export class NotificacoesModule {}
