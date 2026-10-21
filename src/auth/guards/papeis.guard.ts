import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  NaoAutenticadoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import type { Papel } from '../../generated/prisma/client';
import { CHAVE_PAPEIS } from '../decorators';

/** Confere `@Papeis(...)` (guard global, depois do `SessaoGuard`). */
@Injectable()
export class PapeisGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    if (contexto.getType() !== 'http') {
      return true;
    }
    const papeis = this.reflector.getAllAndOverride<Papel[] | undefined>(
      CHAVE_PAPEIS,
      [contexto.getHandler(), contexto.getClass()],
    );
    if (!papeis || papeis.length === 0) {
      return true;
    }
    const usuario = contexto
      .switchToHttp()
      .getRequest<RequisicaoHttp>().usuarioAutenticado;
    if (!usuario) {
      throw new NaoAutenticadoException();
    }
    if (!papeis.includes(usuario.papel)) {
      throw new SemPermissaoException();
    }
    return true;
  }
}
