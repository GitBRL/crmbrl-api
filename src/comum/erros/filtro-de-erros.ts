import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { contextoAtual, haContexto } from '../contexto/contexto-requisicao';
import { type RequisicaoHttp, rotaParaLog } from '../http/requisicao-http';
import { traduzirErroDoPrisma } from './erros-do-prisma';
import {
  type CodigoErro,
  type CorpoErro,
  ErroApi,
  MuitasTentativasException,
} from './excecoes';

/** Código padrão de cada status HTTP. */
const CODIGO_POR_STATUS: Readonly<Record<number, CodigoErro>> = {
  400: 'dados_invalidos',
  401: 'nao_autenticado',
  403: 'sem_permissao',
  404: 'nao_encontrado',
  405: 'metodo_nao_permitido',
  409: 'conflito',
  410: 'desativado',
  413: 'muito_grande',
  415: 'tipo_nao_suportado',
  422: 'regra_violada',
  429: 'muitas_tentativas',
  503: 'indisponivel',
};

/** Mensagens em português para erros que chegam sem uma (exceções do Nest, do body parser…). */
const MENSAGEM_POR_STATUS: Readonly<Record<number, string>> = {
  400: 'Requisição inválida.',
  401: 'Faça login para continuar.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Recurso não encontrado.',
  405: 'Método não permitido.',
  409: 'Conflito com o estado atual.',
  410: 'Recurso desativado.',
  413: 'O corpo da requisição é grande demais.',
  415: 'Tipo de conteúdo não suportado.',
  422: 'A operação viola uma regra de negócio.',
  429: 'Muitas tentativas. Tente de novo em instantes.',
  503: 'Serviço temporariamente indisponível.',
};

/**
 * Filtro global de erros: toda resposta de erro sai no formato padrão
 * `{ statusCode, erro, mensagem, detalhes?, requisicaoId }`.
 *
 * - `ErroApi` (e subclasses) saem como foram lançadas;
 * - `HttpException` do Nest (rota inexistente, pipes) e erros do body parser
 *   ganham código e mensagem em português;
 * - erros conhecidos do Prisma viram 404/409 (`traduzirErroDoPrisma`);
 * - o resto é 500 `erro_interno`, com a pilha só no log e nos logs técnicos (R3.6).
 */
@Catch()
@Injectable()
export class FiltroDeErros implements ExceptionFilter {
  private readonly logger = new Logger('Erros');

  constructor(
    private readonly adaptador: HttpAdapterHost,
    private readonly logs: LogsTecnicosService,
  ) {}

  catch(excecao: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw excecao;
    }
    const http = host.switchToHttp();
    const requisicao = http.getRequest<RequisicaoHttp>();
    const resposta = http.getResponse<Response>();
    const requisicaoId = idDaRequisicao(requisicao, resposta);
    const corpo = montarCorpo(excecao, requisicaoId);

    if (corpo.statusCode >= 500 && corpo.statusCode !== 503) {
      void this.logs.registrar({
        nivel: 'ERRO',
        contexto: 'HTTP',
        mensagem: excecao instanceof Error ? excecao.message : String(excecao),
        erro: excecao,
        http: {
          metodo: requisicao.method,
          rota: rotaParaLog(requisicao),
          status: corpo.statusCode,
        },
      });
    } else if (corpo.statusCode === 503) {
      this.logger.warn(
        `${requisicao.method} ${rotaParaLog(requisicao)}: ${corpo.mensagem}`,
      );
    }

    if (resposta.headersSent) {
      return;
    }
    if (
      excecao instanceof MuitasTentativasException &&
      excecao.tentarDeNovoEmSegundos
    ) {
      resposta.setHeader('Retry-After', String(excecao.tentarDeNovoEmSegundos));
    }
    this.adaptador.httpAdapter.reply(resposta, corpo, corpo.statusCode);
  }
}

function idDaRequisicao(
  requisicao: RequisicaoHttp,
  resposta: Response,
): string {
  if (haContexto()) {
    return contextoAtual().requisicaoId;
  }
  if (requisicao.contexto) {
    return requisicao.contexto.requisicaoId;
  }
  const cabecalho = resposta.getHeader('X-Request-Id');
  return typeof cabecalho === 'string' ? cabecalho : randomUUID();
}

/** Monta o corpo padrão de erro para qualquer exceção. Exportado para testes. */
export function montarCorpo(excecao: unknown, requisicaoId: string): CorpoErro {
  if (excecao instanceof ErroApi) {
    return {
      statusCode: excecao.getStatus(),
      erro: excecao.codigo,
      mensagem: excecao.mensagem,
      ...(excecao.detalhes ? { detalhes: excecao.detalhes } : {}),
      requisicaoId,
    };
  }

  // Erro de um serviço externo que sabe virar erro da API (ex.: `ErroTrescPlus`): o `.status` dele é o do
  // serviço externo (401, 404, 429) e nunca pode virar o status do CRM (um 401 desloga a pessoa).
  const convertido = comoErroApi(excecao);
  if (convertido) {
    return montarCorpo(convertido, requisicaoId);
  }

  const doPrisma = traduzirErroDoPrisma(excecao);
  if (doPrisma) {
    return montarCorpo(doPrisma, requisicaoId);
  }

  const status = statusDe(excecao);
  if (status !== null && status < 500) {
    return {
      statusCode: status,
      erro: CODIGO_POR_STATUS[status] ?? 'erro_http',
      mensagem: mensagemPara(excecao, status),
      requisicaoId,
    };
  }
  if (status === 503) {
    return {
      statusCode: 503,
      erro: 'indisponivel',
      mensagem: MENSAGEM_POR_STATUS[503],
      requisicaoId,
    };
  }
  return {
    statusCode: 500,
    erro: 'erro_interno',
    mensagem: `Erro interno. Tente de novo; se persistir, informe o código ${requisicaoId}.`,
    requisicaoId,
  };
}

/** Erro de serviço externo com `paraErroApi()` (duck typing: a camada comum não conhece os módulos). */
function comoErroApi(excecao: unknown): ErroApi | null {
  if (
    excecao instanceof Error &&
    !(excecao instanceof HttpException) &&
    typeof (excecao as { paraErroApi?: unknown }).paraErroApi === 'function'
  ) {
    const erro = (
      excecao as unknown as { paraErroApi: () => unknown }
    ).paraErroApi();
    return erro instanceof ErroApi ? erro : null;
  }
  return null;
}

/** Status HTTP de uma `HttpException` ou de um erro do body parser (`http-errors`). */
function statusDe(excecao: unknown): number | null {
  if (excecao instanceof HttpException) {
    return excecao.getStatus();
  }
  if (typeof excecao === 'object' && excecao !== null) {
    const { status, statusCode, expose } = excecao as {
      status?: unknown;
      statusCode?: unknown;
      expose?: unknown;
    };
    const valor = typeof status === 'number' ? status : statusCode;
    if (
      typeof valor === 'number' &&
      valor >= 400 &&
      valor < 600 &&
      expose !== false
    ) {
      return valor;
    }
  }
  return null;
}

/** Mensagens do `JSON.parse` que o adaptador Express do Nest repassa como `BadRequestException`. */
const ERRO_DE_JSON =
  /JSON|Unexpected (token|end|non-whitespace)|Expected .* after/i;

function mensagemPara(excecao: unknown, status: number): string {
  const tipo = (excecao as { type?: unknown } | null)?.type;
  if (tipo === 'entity.parse.failed') {
    return 'O corpo da requisição não é um JSON válido.';
  }
  if (status === 400 && excecao instanceof HttpException) {
    if (ERRO_DE_JSON.test(excecao.message)) {
      return 'O corpo da requisição não é um JSON válido.';
    }
    if (/URI/.test(excecao.message)) {
      return 'O endereço tem caracteres com codificação inválida.';
    }
  }
  if (tipo === 'entity.too.large') {
    return MENSAGEM_POR_STATUS[413];
  }
  if (status === 404 && excecao instanceof HttpException) {
    return 'Rota não encontrada.';
  }
  return MENSAGEM_POR_STATUS[status] ?? 'Erro na requisição.';
}
