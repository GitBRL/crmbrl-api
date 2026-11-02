import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import type { StorageEngine } from 'multer';
import {
  decodificarNome,
  type ArquivoRecebido,
} from '../../arquivos/armazenamento-multer';
import { ArquivosService } from '../../arquivos/arquivos.service';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import { CABECALHO_ID_REQUISICAO } from '../../logs/requisicao.middleware';
import type { WebchatVisitante } from '../../generated/prisma/client';
import { type CanalWebchat, WebchatService } from './webchat.service';

/** Requisição de uma rota pública do widget, depois do guard. */
export interface RequisicaoDoWidget extends RequisicaoHttp {
  chatDoSite?: CanalWebchat;
  /** Visitante autenticado pelo token do multipart (anexos). */
  visitanteDoUpload?: WebchatVisitante;
}

/**
 * Guard das rotas públicas do widget com `:chave` (§2.5):
 *
 * 1. limite de requisições por IP (429 com `Retry-After`);
 * 2. o canal ativo da chave (404);
 * 3. a origem do navegador nos domínios do canal (403) — e então o CORS da
 *    resposta (`Access-Control-Allow-Origin` = a origem, sem credenciais).
 *
 * O widget só faz pedidos "simples" (sem preflight), então basta responder com
 * a origem permitida. O canal fica em `req.chatDoSite` (`@ChatDoSite()`).
 */
@Injectable()
export class AcessoDoWidgetGuard implements CanActivate {
  constructor(private readonly webchat: WebchatService) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const http = contexto.switchToHttp();
    const requisicao = http.getRequest<RequisicaoDoWidget>();
    const resposta = http.getResponse<Response>();
    this.webchat.limitarIp(requisicao.ip);
    const chave = requisicao.params?.chave;
    const canal = await this.webchat.canalPelaChave(
      typeof chave === 'string' ? chave : '',
    );
    const origem =
      typeof requisicao.headers.origin === 'string'
        ? requisicao.headers.origin
        : undefined;
    this.webchat.exigirOrigem(canal, origem);
    if (origem) {
      liberarOrigem(resposta, origem);
    }
    requisicao.chatDoSite = canal;
    return true;
  }
}

/** CORS da resposta para uma origem já conferida. */
export function liberarOrigem(resposta: Response, origem: string): void {
  resposta.setHeader('Access-Control-Allow-Origin', origem);
  resposta.setHeader(
    'Access-Control-Expose-Headers',
    `Retry-After, ${CABECALHO_ID_REQUISICAO}`,
  );
  resposta.vary('Origin');
}

/** O canal do chat do site resolvido pelo `AcessoDoWidgetGuard`. */
export const ChatDoSite = createParamDecorator(
  (_dados: unknown, contexto: ExecutionContext): CanalWebchat => {
    const canal = contexto
      .switchToHttp()
      .getRequest<RequisicaoDoWidget>().chatDoSite;
    if (!canal) {
      throw new NaoEncontradoException('Este chat não está disponível.');
    }
    return canal;
  },
);

/**
 * Armazenamento do multer para os anexos do visitante: confere o token (que
 * vem antes do arquivo no formulário), o limite de anexos e se o canal aceita
 * arquivos — só então entrega o conteúdo em streaming ao `ArquivosService`
 * (contexto `MENSAGEM`, mesma política de tipos e tamanhos, R11).
 */
export class ArmazenamentoDoVisitante implements StorageEngine {
  constructor(
    private readonly arquivos: ArquivosService,
    private readonly webchat: WebchatService,
  ) {}

  _handleFile(
    req: RequisicaoDoWidget,
    file: Express.Multer.File,
    callback: (erro?: unknown, info?: Partial<ArquivoRecebido>) => void,
  ): void {
    this.receber(req, file)
      .then((arquivo) =>
        callback(null, { arquivoSalvo: arquivo, size: arquivo.tamanho }),
      )
      .catch((erro: unknown) => {
        file.stream.resume();
        callback(erro);
      });
  }

  _removeFile(
    _req: RequisicaoDoWidget,
    file: Express.Multer.File,
    callback: (erro: Error | null) => void,
  ): void {
    const salvo = (file as Partial<ArquivoRecebido>).arquivoSalvo;
    if (!salvo) {
      callback(null);
      return;
    }
    this.arquivos
      .descartarNovo(salvo.id)
      .then(() => callback(null))
      .catch(() => callback(null));
  }

  private async receber(req: RequisicaoDoWidget, file: Express.Multer.File) {
    const canal = req.chatDoSite;
    if (!canal) {
      throw new NaoEncontradoException('Este chat não está disponível.');
    }
    if (!canal.configuracao.permitirAnexos) {
      throw new SemPermissaoException('Este chat não aceita arquivos.');
    }
    const token = (req.body as Record<string, unknown> | undefined)?.token;
    if (typeof token !== 'string' || token === '') {
      throw new DadosInvalidosException(
        'Envie o token do visitante antes do arquivo.',
        { campos: [{ campo: 'token', mensagens: ['é obrigatório'] }] },
      );
    }
    const visitante = await this.webchat.autenticar(canal.canal, token);
    this.webchat.limitarAnexos(visitante);
    req.visitanteDoUpload = visitante;
    return this.arquivos.salvar(file.stream, {
      nome: decodificarNome(file.originalname),
      mime: file.mimetype,
      contexto: 'MENSAGEM',
      criadoPorId: null,
    });
  }
}
