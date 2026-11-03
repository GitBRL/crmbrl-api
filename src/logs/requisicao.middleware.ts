import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import {
  type ContextoRequisicao,
  executarComContexto,
} from '../comum/contexto/contexto-requisicao';
import {
  type RequisicaoHttp,
  rotaParaLog,
  truncar,
} from '../comum/http/requisicao-http';

/** Cabeçalho do id da requisição (R3.7). */
export const CABECALHO_ID_REQUISICAO = 'X-Request-Id';

/** Id recebido do cliente: aceito só se for curto e sem caracteres estranhos. */
const ID_ACEITAVEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** O `X-Request-Id` recebido (se aceitável) ou um id novo (R3.7). */
export function idDaRequisicao(
  recebido: string | string[] | undefined,
): string {
  const valor = Array.isArray(recebido) ? recebido[0] : recebido;
  return valor && ID_ACEITAVEL.test(valor) ? valor : randomUUID();
}

/**
 * Primeiro middleware de toda requisição (registrado em `configurarAplicacao`):
 *
 * 1. define o id da requisição e devolve `X-Request-Id` em toda resposta, até
 *    nas de erro (R3.7);
 * 2. cria o contexto da requisição (id, IP, user agent) e o pendura em
 *    `req.contexto` — o `ContextoMiddleware` o reabre depois do body parser;
 * 3. ao terminar a resposta, escreve o log HTTP estruturado (R3.6): método,
 *    rota, status, duração, usuário, IP e id da requisição.
 *
 * O healthcheck (`GET /api/saude`) respondendo 200 não entra no log: o Docker o
 * consulta a cada 10 s.
 */
export function criarMiddlewareDeRequisicao(logger = new Logger('HTTP')) {
  return (req: RequisicaoHttp, res: Response, next: NextFunction): void => {
    const requisicaoId = idDaRequisicao(req.headers['x-request-id']);
    res.setHeader(CABECALHO_ID_REQUISICAO, requisicaoId);

    const contexto: ContextoRequisicao = {
      requisicaoId,
      ip: req.ip,
      userAgent: truncar(req.get('user-agent'), 500),
      tipoAtor: 'USUARIO',
    };
    req.contexto = contexto;

    const inicio = performance.now();
    let registrado = false;
    const registrar = (): void => {
      if (registrado) {
        return;
      }
      registrado = true;
      const rota = rotaParaLog(req);
      const status = res.statusCode;
      if (rota.endsWith('/saude') && status === 200) {
        return;
      }
      const registro = {
        metodo: req.method,
        rota,
        status,
        duracaoMs: Math.round(performance.now() - inicio),
        usuarioId: req.contexto?.usuario?.id ?? null,
        // O IP guardado na chegada: com a conexão já destruída (corpo recusado no meio), `req.ip` lança.
        ip: contexto.ip ?? null,
        requisicaoId,
        ...(res.writableFinished ? {} : { interrompida: true }),
      };
      const mensagem = `${req.method} ${rota} ${status}`;
      if (status >= 500) {
        logger.error(mensagem, registro);
      } else if (status >= 400) {
        logger.warn(mensagem, registro);
      } else {
        logger.log(mensagem, registro);
      }
    };
    res.on('finish', registrar);
    res.on('close', registrar);

    executarComContexto(contexto, next);
  };
}
