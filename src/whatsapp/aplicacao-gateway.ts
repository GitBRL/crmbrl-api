import type { NestExpressApplication } from '@nestjs/platform-express';
import { reabrirContexto } from '../comum/contexto/contexto.middleware';
import { criarValidationPipe } from '../comum/validacao/validacao';
import { criarMiddlewareDeRequisicao } from '../logs/requisicao.middleware';

/** Limite do corpo JSON do HTTP interno (o simulador recebe mídia em base64). */
export const LIMITE_CORPO_DO_GATEWAY = '40mb';

/** Configuração HTTP do gateway — a mesma no `main.ts` dele e nos testes. */
export function configurarGateway(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use(criarMiddlewareDeRequisicao());
  app.useBodyParser('json', { limit: LIMITE_CORPO_DO_GATEWAY });
  app.use(reabrirContexto);
  app.useGlobalPipes(criarValidationPipe());
}
