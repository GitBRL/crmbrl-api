import type { NestExpressApplication } from '@nestjs/platform-express';
import { marcarBancoComoSistema } from '../comum/contexto/contexto-requisicao';
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
  // R35.2: o gateway só recebe comandos já autorizados pela API (token interno):
  // fala com o banco como sistema.
  app.use((_req: unknown, _res: unknown, proximo: () => void) => {
    marcarBancoComoSistema();
    proximo();
  });
  app.useGlobalPipes(criarValidationPipe());
}
