import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { NaoAutenticadoException } from '../comum/erros/excecoes';
import type { RequisicaoHttp } from '../comum/http/requisicao-http';
import type { Papel } from '../generated/prisma/client';
import type { UsuarioAutenticado } from './usuario-autenticado';

export const CHAVE_PUBLICO = 'crmbrl:publico';
export const CHAVE_PAPEIS = 'crmbrl:papeis';
export const CHAVE_TROCA_PENDENTE = 'crmbrl:permitir-troca-pendente';
export const CHAVE_SEM_ORIGEM = 'crmbrl:sem-verificacao-de-origem';

/**
 * Rota sem login. Se houver sessão válida, o usuário ainda fica disponível
 * (`@UsuarioAtual()` pode vir `undefined`).
 */
export const Publico = () => SetMetadata(CHAVE_PUBLICO, true);

/**
 * Só estes papéis acessam a rota (403 para os demais). Sem `@Papeis`, qualquer
 * usuário autenticado acessa — a regra fina (equipe, área) fica no serviço.
 *
 * ```ts
 * @Papeis('ADMIN', 'C_LEVEL')
 * ```
 */
export const Papeis = (...papeis: Papel[]) => SetMetadata(CHAVE_PAPEIS, papeis);

/** A rota funciona mesmo com troca de senha pendente (R2.7: só `auth/eu`, `auth/senha` e `auth/sair`). */
export const PermitirTrocaDeSenhaPendente = () =>
  SetMetadata(CHAVE_TROCA_PENDENTE, true);

/**
 * Isenta a rota da verificação de origem (CSRF, R2.9). Só para quem se
 * autentica de outro jeito — os webhooks de entrada, pelo token da URL.
 */
export const SemVerificacaoDeOrigem = () => SetMetadata(CHAVE_SEM_ORIGEM, true);

/**
 * O usuário autenticado da requisição.
 *
 * ```ts
 * @Get('eu') eu(@UsuarioAtual() usuario: UsuarioAutenticado) { … }
 * ```
 * Em rota `@Publico()`, use `@UsuarioAtual({ opcional: true })` para receber
 * `undefined` sem sessão; nas demais, a ausência vira 401.
 */
export const UsuarioAtual = createParamDecorator(
  (
    opcoes: { opcional?: boolean } | undefined,
    contexto: ExecutionContext,
  ): UsuarioAutenticado | undefined => {
    const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
    const usuario = requisicao.usuarioAutenticado;
    if (!usuario && !opcoes?.opcional) {
      throw new NaoAutenticadoException();
    }
    return usuario;
  },
);
