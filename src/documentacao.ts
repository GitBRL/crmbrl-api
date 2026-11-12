import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import { lerCookie, nomeDoCookieDeSessao } from './auth/cookies';
import { SessoesService } from './auth/sessoes.service';
import {
  NaoAutenticadoException,
  SemPermissaoException,
} from './comum/erros/excecoes';
import { montarCorpo } from './comum/erros/filtro-de-erros';
import type { RequisicaoHttp } from './comum/http/requisicao-http';
import type { Ambiente } from './config/ambiente';

/** Interface do Swagger. */
export const CAMINHO_DA_DOCUMENTACAO = '/api/docs';
/** Documento OpenAPI em JSON. */
export const CAMINHO_DO_JSON_DA_DOCUMENTACAO = '/api/docs-json';

/**
 * Documentação OpenAPI (Swagger) em `/api/docs` e `/api/docs-json`: aberta com
 * `DOCS_PUBLICAS=true` (padrão fora de produção) e restrita ao Admin em
 * produção (R11) — o middleware confere a sessão antes da interface e do JSON.
 */
export function configurarDocumentacao(
  app: NestExpressApplication,
  ambiente: Ambiente,
  versao: string,
): void {
  const configuracao = new DocumentBuilder()
    .setTitle('BRL CRM — API')
    .setDescription(
      'API do BRL CRM. Rotas de negócio em `/api/v1`, autenticação por cookie de sessão ' +
        '(`POST /api/v1/auth/entrar`). Requisições que alteram dados precisam do cabeçalho ' +
        '`Origin` de uma origem permitida (R2.9). Erros no formato ' +
        '`{ statusCode, erro, mensagem, detalhes?, requisicaoId }`.',
    )
    .setVersion(versao)
    .addCookieAuth(nomeDoCookieDeSessao(ambiente))
    .build();

  if (!ambiente.docsPublicas) {
    const sessoes = app.get(SessoesService);
    app.use(
      [CAMINHO_DA_DOCUMENTACAO, CAMINHO_DO_JSON_DA_DOCUMENTACAO],
      (
        requisicao: RequisicaoHttp,
        resposta: Response,
        proximo: NextFunction,
      ) => {
        void exigirAdmin(sessoes, requisicao, nomeDoCookieDeSessao(ambiente))
          .then(() => proximo())
          .catch((erro: unknown) => {
            const corpo = montarCorpo(
              erro,
              requisicao.contexto?.requisicaoId ?? '',
            );
            resposta.status(corpo.statusCode).json(corpo);
          });
      },
    );
  }

  SwaggerModule.setup(
    CAMINHO_DA_DOCUMENTACAO.slice(1),
    app,
    () => SwaggerModule.createDocument(app, configuracao),
    {
      jsonDocumentUrl: CAMINHO_DO_JSON_DA_DOCUMENTACAO.slice(1),
      customSiteTitle: 'BRL CRM — API',
      swaggerOptions: { persistAuthorization: true, withCredentials: true },
    },
  );
}

async function exigirAdmin(
  sessoes: SessoesService,
  requisicao: RequisicaoHttp,
  nomeDoCookie: string,
): Promise<void> {
  const token = lerCookie(requisicao, nomeDoCookie);
  const validada = token ? await sessoes.validar(token) : null;
  if (!validada) {
    throw new NaoAutenticadoException(
      'Entre como Admin para ver a documentação da API.',
    );
  }
  if (validada.usuario.papel !== 'ADMIN' || validada.usuario.deveTrocarSenha) {
    throw new SemPermissaoException(
      'A documentação da API é restrita ao Admin.',
    );
  }
}
