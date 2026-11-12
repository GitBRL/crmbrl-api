import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { CHAVE_PUBLICO } from '../auth/decorators';
import { marcarBancoComoSistema } from '../comum/contexto/contexto-requisicao';

/**
 * R35.2: rota pública (`@Publico()`: webhooks de entrada, chat do site, Meta,
 * Facebook, conexões de aplicativos, login, saúde) fala com o banco como
 * sistema — quem a chama não é um usuário do CRM, e a própria rota confere
 * token, assinatura ou link. As demais rotas usam o usuário da sessão; antes
 * do login (sem usuário), o banco não devolve nada das tabelas protegidas.
 */
@Injectable()
export class BancoDaRotaPublicaInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    contexto: ExecutionContext,
    proximo: CallHandler,
  ): Observable<unknown> {
    if (
      contexto.getType() === 'http' &&
      this.reflector.getAllAndOverride<boolean | undefined>(CHAVE_PUBLICO, [
        contexto.getHandler(),
        contexto.getClass(),
      ])
    ) {
      marcarBancoComoSistema();
    }
    return proximo.handle();
  }
}
