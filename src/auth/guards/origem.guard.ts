import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SemPermissaoException } from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import { AMBIENTE, type Ambiente, comoOrigem } from '../../config/ambiente';
import { CHAVE_SEM_ORIGEM } from '../decorators';

/** Métodos que não alteram dados: a origem não é conferida. */
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteção CSRF (R2.9): requisições que alteram dados precisam vir de uma origem
 * em `ORIGENS_PERMITIDAS` — o cabeçalho `Origin` ou, na falta dele, a origem do
 * `Referer`. Sem nenhum dos dois, a requisição é recusada (403).
 *
 * Rotas marcadas com `@SemVerificacaoDeOrigem()` ficam de fora (webhooks de
 * entrada, que se autenticam pelo token da URL).
 */
@Injectable()
export class OrigemGuard implements CanActivate {
  private readonly permitidas: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(AMBIENTE) ambiente: Ambiente,
  ) {
    this.permitidas = new Set(ambiente.origensPermitidas);
  }

  canActivate(contexto: ExecutionContext): boolean {
    if (contexto.getType() !== 'http') {
      return true;
    }
    const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
    if (METODOS_SEGUROS.has(requisicao.method.toUpperCase())) {
      return true;
    }
    const isenta = this.reflector.getAllAndOverride<boolean | undefined>(
      CHAVE_SEM_ORIGEM,
      [contexto.getHandler(), contexto.getClass()],
    );
    if (isenta) {
      return true;
    }
    const origem = origemDaRequisicao(requisicao);
    if (origem && this.permitidas.has(origem)) {
      return true;
    }
    throw new SemPermissaoException('Origem da requisição não permitida.', {
      regra: 'R2.9',
      origem: origem ?? null,
    });
  }
}

/** A origem declarada pela requisição: `Origin` ou, sem ele, a do `Referer`. `null` se nenhuma. */
export function origemDaRequisicao(requisicao: RequisicaoHttp): string | null {
  const origin = requisicao.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    return comoOrigem(origin) ?? origin;
  }
  const referer = requisicao.headers.referer;
  if (typeof referer === 'string' && URL.canParse(referer)) {
    const url = new URL(referer);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  }
  return null;
}
