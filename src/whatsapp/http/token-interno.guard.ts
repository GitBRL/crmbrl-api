import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CABECALHO_TOKEN_INTERNO } from '../../canais/whatsapp/contrato-gateway';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { NaoAutenticadoException } from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';

const SEM_TOKEN = 'gateway:sem-token';

/** Libera a rota do token interno (só o `GET /saude`, para o healthcheck). */
export const SemTokenInterno = () => SetMetadata(SEM_TOKEN, true);

/**
 * Guard global do HTTP interno do gateway: toda rota exige o cabeçalho
 * `X-Token-Interno` igual a `WHATSAPP_TOKEN_INTERNO` (comparação em tempo
 * constante). O gateway não publica porta no host; o token protege a rede
 * interna do compose.
 */
@Injectable()
export class TokenInternoGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cripto: CriptografiaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    const liberada = this.reflector.getAllAndOverride<boolean>(SEM_TOKEN, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (liberada) {
      return true;
    }
    const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
    const recebido = requisicao.headers[CABECALHO_TOKEN_INTERNO];
    if (
      typeof recebido !== 'string' ||
      !this.cripto.compararSeguro(recebido, this.ambiente.whatsapp.tokenInterno)
    ) {
      throw new NaoAutenticadoException('Token interno inválido.');
    }
    return true;
  }
}
