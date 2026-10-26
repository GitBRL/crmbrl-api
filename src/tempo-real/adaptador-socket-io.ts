import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import type { Ambiente } from '../config/ambiente';

/**
 * Adapter do Socket.IO da API. Só acrescenta o que depende do ambiente: o CORS
 * do polling, ligado apenas com `CORS_ORIGENS` (o mesmo do HTTP). Sem ele, o
 * front fala com o Socket.IO pela mesma origem (Caddy, `ng serve`), como no HTTP.
 * A origem e a sessão são conferidas no handshake de cada namespace.
 */
export class AdaptadorSocketIo extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly ambiente: Ambiente,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const cors =
      this.ambiente.corsOrigens.length > 0
        ? {
            cors: {
              origin: [...this.ambiente.corsOrigens],
              credentials: true,
            },
          }
        : {};
    return super.createIOServer(port, {
      ...options,
      ...cors,
    } as ServerOptions) as Server;
  }
}

/** Liga o tempo real na aplicação (no `main.ts` e nos testes), antes do `init`/`listen`. */
export function configurarTempoReal(
  app: INestApplication,
  ambiente: Ambiente,
): void {
  app.useWebSocketAdapter(new AdaptadorSocketIo(app, ambiente));
}
