import { Global, Module } from '@nestjs/common';
import { OuvinteDoBanco } from './ouvinte-do-banco';
import { TempoRealGateway } from './tempo-real.gateway';
import { TempoRealPublicador } from './tempo-real.publicador';
import { TempoRealService } from './tempo-real.service';

/**
 * Tempo real (§2.2), global: Socket.IO em `/api/socket.io`, namespace
 * `/tempo-real`, autenticado pelo cookie de sessão e pela origem.
 *
 * - `TempoRealService`: emissões diretas (efêmeros), salas, autorizadores.
 * - `TempoRealPublicador`: emissões depois do commit, pela outbox.
 * - `OuvinteDoBanco`: avisos do banco (sessão revogada, notificação nova).
 *
 * Catálogo de salas e eventos: `src/tempo-real/catalogo.ts`.
 */
@Global()
@Module({
  providers: [
    TempoRealService,
    TempoRealPublicador,
    TempoRealGateway,
    OuvinteDoBanco,
  ],
  exports: [TempoRealService, TempoRealPublicador, OuvinteDoBanco],
})
export class TempoRealModule {}
