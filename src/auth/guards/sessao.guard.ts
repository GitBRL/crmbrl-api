import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { definirUsuarioDoContexto } from '../../comum/contexto/contexto-requisicao';
import { areaDoPapel } from '../../comum/dominio/papeis';
import {
  NaoAutenticadoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  lerCookie,
  NOME_COOKIE_SESSAO,
  opcoesDoCookieDeSessao,
} from '../cookies';
import { CHAVE_PUBLICO, CHAVE_TROCA_PENDENTE } from '../decorators';
import { SessoesService } from '../sessoes.service';
import type { UsuarioAutenticado } from '../usuario-autenticado';

/**
 * Autenticação de toda rota (guard global). Lê o cookie `crmbrl_sessao`, valida
 * a sessão no banco (R2.2, R2.4 — usuário desligado perde o acesso na hora) e
 * deixa o usuário em `@UsuarioAtual()` e no contexto da requisição.
 *
 * - Rota `@Publico()`: passa sem sessão (e com sessão válida, o usuário fica disponível).
 * - Sessão inválida ou expirada: 401 e o cookie é apagado.
 * - Troca de senha pendente (R2.7): só passam as rotas com
 *   `@PermitirTrocaDeSenhaPendente()` (`auth/eu`, `auth/senha`, `auth/sair`); as
 *   demais devolvem 403 com `detalhes.motivo = 'troca_de_senha_pendente'`.
 */
@Injectable()
export class SessaoGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessoes: SessoesService,
    private readonly adaptador: HttpAdapterHost,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    if (contexto.getType() !== 'http') {
      return true;
    }
    const alvos = [contexto.getHandler(), contexto.getClass()];
    const publico = this.reflector.getAllAndOverride<boolean | undefined>(
      CHAVE_PUBLICO,
      alvos,
    );
    const http = contexto.switchToHttp();
    const requisicao = http.getRequest<RequisicaoHttp>();

    const token = lerCookie(requisicao, NOME_COOKIE_SESSAO);
    if (!token) {
      if (publico) {
        return true;
      }
      throw new NaoAutenticadoException('Faça login para continuar.');
    }

    const validada = await this.sessoes.validar(token);
    if (!validada) {
      this.adaptador.httpAdapter.clearCookie?.(
        http.getResponse<Response>(),
        NOME_COOKIE_SESSAO,
        opcoesDoCookieDeSessao(this.ambiente),
      );
      if (publico) {
        return true;
      }
      throw new NaoAutenticadoException(
        'Sua sessão expirou ou foi encerrada. Entre novamente.',
      );
    }

    const { usuario, sessao } = validada;
    const autenticado: UsuarioAutenticado = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      area: areaDoPapel(usuario.papel),
      liderId: usuario.liderId,
      deveTrocarSenha: usuario.deveTrocarSenha,
      sessaoId: sessao.id,
    };
    requisicao.usuarioAutenticado = autenticado;
    definirUsuarioDoContexto(
      { id: usuario.id, papel: usuario.papel, nome: usuario.nome },
      sessao.id,
    );

    if (publico || !usuario.deveTrocarSenha) {
      return true;
    }
    const permitida = this.reflector.getAllAndOverride<boolean | undefined>(
      CHAVE_TROCA_PENDENTE,
      alvos,
    );
    if (permitida) {
      return true;
    }
    throw new SemPermissaoException('Troque sua senha para continuar.', {
      regra: 'R2.7',
      motivo: 'troca_de_senha_pendente',
    });
  }
}
