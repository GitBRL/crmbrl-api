import type { NextFunction, Response } from 'express';
import type { RequisicaoHttp } from '../http/requisicao-http';
import { idDaRequisicao } from '../../logs/requisicao.middleware';
import { executarComContexto } from './contexto-requisicao';

/**
 * Reabre o contexto da requisição depois do body parser (registrado em
 * `configurarAplicacao`, logo depois dos parsers). O contexto nasce no
 * middleware de requisição, antes de tudo, mas callbacks de stream — como o do
 * body parser ao terminar de ler o corpo — podem continuar fora dele. Aqui o
 * mesmo objeto volta a ser o contexto ativo antes dos guards e do handler.
 */
export function reabrirContexto(
  req: RequisicaoHttp,
  _res: Response,
  next: NextFunction,
): void {
  const contexto = req.contexto ?? {
    requisicaoId: idDaRequisicao(req.headers['x-request-id']),
    ip: req.ip,
    tipoAtor: 'USUARIO' as const,
  };
  req.contexto = contexto;
  executarComContexto(contexto, next);
}
