import type { IncomingHttpHeaders } from 'node:http';
import type { Request } from 'express';
import { lerCookie, NOME_COOKIE_SESSAO } from '../auth/cookies';
import { origemDaRequisicao } from '../auth/guards/origem.guard';
import type { SessoesService } from '../auth/sessoes.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { areaDoPapel } from '../comum/dominio/papeis';
import type { RequisicaoHttp } from '../comum/http/requisicao-http';

/** Por que a conexão foi recusada — vai em `connect_error` (`erro.message` e `erro.data.erro`). */
export type MotivoDeRecusa =
  'origem_nao_permitida' | 'nao_autenticado' | 'troca_de_senha_pendente';

export type ResultadoDaAutenticacao =
  | { aceito: true; usuario: UsuarioAutenticado }
  | { aceito: false; erro: MotivoDeRecusa; mensagem: string };

/**
 * Autentica o handshake do Socket.IO como o HTTP faz (§2.2):
 *
 * 1. origem (`Origin`, ou a do `Referer`) em `ORIGENS_PERMITIDAS` — o mesmo
 *    critério do `OrigemGuard` (R2.9), aqui exigido sempre;
 * 2. cookie `crmbrl_sessao` com sessão válida de usuário ativo — a mesma
 *    validação do `SessaoGuard` (`SessoesService.validar`, R2.2/R2.4);
 * 3. sem troca de senha pendente (R2.7: até trocar, só as rotas de senha).
 */
export async function autenticarHandshake(
  cabecalhos: IncomingHttpHeaders,
  origensPermitidas: ReadonlySet<string>,
  sessoes: Pick<SessoesService, 'validar'>,
): Promise<ResultadoDaAutenticacao> {
  const origem = origemDaRequisicao({ headers: cabecalhos } as RequisicaoHttp);
  if (!origem || !origensPermitidas.has(origem)) {
    return {
      aceito: false,
      erro: 'origem_nao_permitida',
      mensagem: 'Origem da conexão não permitida.',
    };
  }
  const token = lerCookie(
    { headers: cabecalhos } as Request,
    NOME_COOKIE_SESSAO,
  );
  if (!token) {
    return {
      aceito: false,
      erro: 'nao_autenticado',
      mensagem: 'Faça login para continuar.',
    };
  }
  const validada = await sessoes.validar(token);
  if (!validada) {
    return {
      aceito: false,
      erro: 'nao_autenticado',
      mensagem: 'Sua sessão expirou ou foi encerrada. Entre novamente.',
    };
  }
  const { usuario, sessao } = validada;
  if (usuario.deveTrocarSenha) {
    return {
      aceito: false,
      erro: 'troca_de_senha_pendente',
      mensagem: 'Troque sua senha para continuar.',
    };
  }
  return {
    aceito: true,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      area: areaDoPapel(usuario.papel),
      liderId: usuario.liderId,
      deveTrocarSenha: usuario.deveTrocarSenha,
      sessaoId: sessao.id,
    },
  };
}

/** Erro de `next(erro)` do middleware do Socket.IO: o cliente recebe `message` e `data`. */
export class RecusaDeConexao extends Error {
  readonly data: { erro: MotivoDeRecusa; mensagem: string };

  constructor(erro: MotivoDeRecusa, mensagem: string) {
    super(erro);
    this.name = 'RecusaDeConexao';
    this.data = { erro, mensagem };
  }
}
