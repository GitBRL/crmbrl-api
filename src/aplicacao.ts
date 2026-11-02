import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { reabrirContexto } from './comum/contexto/contexto.middleware';
import { criarMiddlewareDeCabecalhos } from './comum/http/cabecalhos-de-seguranca';
import { criarValidationPipe } from './comum/validacao/validacao';
import type { Ambiente } from './config/ambiente';
import {
  CABECALHO_ID_REQUISICAO,
  criarMiddlewareDeRequisicao,
} from './logs/requisicao.middleware';

/** Prefixo de todas as rotas (`/api/*`). É esse caminho que o Caddy do front encaminha para a API. */
export const PREFIXO_DAS_ROTAS = 'api';

/** Versão padrão das rotas de negócio: `/api/v1/...`. A saúde (`/api/saude`) fica sem versão. */
export const VERSAO_PADRAO_DA_API = '1';

/** Limite do corpo JSON. Webhooks de entrada conferem os 256 KB deles (R8.2) pelo `rawBody`. */
export const LIMITE_CORPO_JSON = '1mb';

/** Limite do corpo `application/x-www-form-urlencoded` (webhooks de entrada, R8.2). */
export const LIMITE_CORPO_FORMULARIO = '256kb';

/** Opções do `NestFactory.create` — as mesmas no `main.ts` e nos testes. */
export const OPCOES_DA_APLICACAO = {
  // Os parsers são registrados em `configurarAplicacao`, com os limites acima,
  // depois do middleware de requisição. `rawBody` guarda o corpo bruto em
  // `req.rawBody` para conferir o HMAC dos webhooks (R8.3).
  bodyParser: false,
  rawBody: true,
} as const;

/** Configuração HTTP da aplicação — a mesma no `main.ts` e nos testes e2e. */
export function configurarAplicacao(
  app: NestExpressApplication,
  ambiente: Ambiente,
): void {
  // Sem CORS_ORIGENS o CORS fica desligado: em produção o front chega pelo
  // mesmo endereço (Caddy) e em desenvolvimento pelo proxy do `ng serve`.
  if (ambiente.corsOrigens.length > 0) {
    app.enableCors({
      origin: [...ambiente.corsOrigens],
      credentials: true,
      exposedHeaders: [CABECALHO_ID_REQUISICAO, 'Retry-After'],
    });
  }

  app.setGlobalPrefix(PREFIXO_DAS_ROTAS);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSAO_PADRAO_DA_API,
  });

  // A API fica atrás do Caddy: confiar em um salto de proxy faz `req.ip` e
  // `req.protocol` refletirem o cliente (X-Forwarded-For / X-Forwarded-Proto).
  app.set('trust proxy', 1);
  // Não anuncia o framework em toda resposta.
  app.disable('x-powered-by');

  // Primeiro de tudo: X-Request-Id, contexto da requisição e log HTTP (R3.6, R3.7).
  app.use(criarMiddlewareDeRequisicao());
  // Cabeçalhos de segurança; HSTS só com HTTPS de ponta a ponta (produção + cookie seguro).
  app.use(
    criarMiddlewareDeCabecalhos(ambiente.producao && ambiente.cookieSeguro),
  );
  app.useBodyParser('json', { limit: LIMITE_CORPO_JSON });
  app.useBodyParser('urlencoded', {
    extended: true,
    limit: LIMITE_CORPO_FORMULARIO,
  });
  // O body parser termina de ler o corpo num callback de stream: reabre o contexto.
  app.use(reabrirContexto);

  app.useGlobalPipes(criarValidationPipe());
}
