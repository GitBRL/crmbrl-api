import { HttpException } from '@nestjs/common';

/**
 * Códigos do campo `erro` da resposta de erro padrão (contrato da API):
 * `{ statusCode, erro, mensagem, detalhes?, requisicaoId }`. A mesma lista vai
 * para o Swagger (`RespostaErroDto`).
 */
export const CODIGOS_ERRO = [
  'dados_invalidos',
  'nao_autenticado',
  'sem_permissao',
  'nao_encontrado',
  'metodo_nao_permitido',
  'conflito',
  'desativado',
  'muito_grande',
  'tipo_nao_suportado',
  'regra_violada',
  'muitas_tentativas',
  'erro_interno',
  'indisponivel',
  'erro_http',
] as const;

export type CodigoErro = (typeof CODIGOS_ERRO)[number];

/** Corpo de toda resposta de erro da API. */
export interface CorpoErro {
  statusCode: number;
  erro: CodigoErro;
  /** Em português, pronta para mostrar a quem usa. */
  mensagem: string;
  detalhes?: Record<string, unknown>;
  /** O mesmo valor do cabeçalho `X-Request-Id` (R3.7). */
  requisicaoId: string;
}

/**
 * Erro da API com código e mensagem já definidos. O filtro global
 * (`FiltroDeErros`) transforma em `CorpoErro`. Prefira as subclasses abaixo.
 */
export class ErroApi extends HttpException {
  constructor(
    status: number,
    readonly codigo: CodigoErro,
    readonly mensagem: string,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super({ erro: codigo, mensagem, detalhes }, status);
    this.name = new.target.name;
  }
}

/** 400 — entrada inválida. `detalhes.campos` lista os problemas por campo. */
export class DadosInvalidosException extends ErroApi {
  constructor(
    mensagem = 'Dados inválidos.',
    detalhes?: Record<string, unknown>,
  ) {
    super(400, 'dados_invalidos', mensagem, detalhes);
  }
}

/** 401 — sem sessão válida. */
export class NaoAutenticadoException extends ErroApi {
  constructor(
    mensagem = 'Faça login para continuar.',
    detalhes?: Record<string, unknown>,
  ) {
    super(401, 'nao_autenticado', mensagem, detalhes);
  }
}

/** 403 — autenticado, mas sem permissão. */
export class SemPermissaoException extends ErroApi {
  constructor(
    mensagem = 'Você não tem permissão para esta ação.',
    detalhes?: Record<string, unknown>,
  ) {
    super(403, 'sem_permissao', mensagem, detalhes);
  }
}

/** 404 — o registro não existe (ou a pessoa não pode saber que existe). */
export class NaoEncontradoException extends ErroApi {
  constructor(
    mensagem = 'Registro não encontrado.',
    detalhes?: Record<string, unknown>,
  ) {
    super(404, 'nao_encontrado', mensagem, detalhes);
  }
}

/** 409 — conflito com o estado atual (duplicado, já desligado, concorrência…). */
export class ConflitoException extends ErroApi {
  constructor(mensagem: string, detalhes?: Record<string, unknown>) {
    super(409, 'conflito', mensagem, detalhes);
  }
}

/** 410 — o recurso existe, mas foi desativado (ex.: webhook de entrada, R8.7). */
export class RecursoDesativadoException extends ErroApi {
  constructor(mensagem: string, detalhes?: Record<string, unknown>) {
    super(410, 'desativado', mensagem, detalhes);
  }
}

/** 413 — corpo grande demais (ex.: webhook acima de 256 KB, R8.2). */
export class CorpoMuitoGrandeException extends ErroApi {
  constructor(
    mensagem = 'O corpo da requisição é grande demais.',
    detalhes?: Record<string, unknown>,
  ) {
    super(413, 'muito_grande', mensagem, detalhes);
  }
}

/**
 * 422 — a operação viola uma regra de negócio. `regra` é o código da regra
 * (ex.: `'R1.2'`) e vai em `detalhes.regra`.
 *
 * ```ts
 * throw new RegraVioladaException('R5.5', 'Informe o motivo da perda.');
 * ```
 */
export class RegraVioladaException extends ErroApi {
  constructor(
    readonly regra: string,
    mensagem: string,
    detalhes?: Record<string, unknown>,
  ) {
    super(422, 'regra_violada', mensagem, { regra, ...detalhes });
  }
}

/** 429 — limite de tentativas. `tentarDeNovoEmSegundos` vira o cabeçalho `Retry-After`. */
export class MuitasTentativasException extends ErroApi {
  constructor(
    mensagem: string,
    readonly tentarDeNovoEmSegundos?: number,
    detalhes?: Record<string, unknown>,
  ) {
    super(429, 'muitas_tentativas', mensagem, detalhes);
  }
}

/** 503 — dependência fora do ar (ex.: SMTP recusou o envio). */
export class ServicoIndisponivelException extends ErroApi {
  constructor(mensagem: string, detalhes?: Record<string, unknown>) {
    super(503, 'indisponivel', mensagem, detalhes);
  }
}
