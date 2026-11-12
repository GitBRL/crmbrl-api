import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Publico } from '../auth/decorators';
import type { RequisicaoHttp } from '../comum/http/requisicao-http';
import { type Saude, type SaudePublica, SaudeService } from './saude.service';

/** `GET /api/saude` — sem versão e sem login (healthcheck do Docker e card do front). */
@ApiTags('Saúde')
@Publico()
@Controller({ path: 'saude', version: VERSION_NEUTRAL })
export class SaudeController {
  constructor(private readonly saude: SaudeService) {}

  /**
   * Healthcheck público: só `{ status }` (HTTP 200 quando o banco responde; 503, com o mesmo
   * corpo, quando falha — é o que o healthcheck do Docker e do Railway olham). Versão, ambiente,
   * uptime, banco, migrations e avisos de configuração só saem para o **Admin** logado: não
   * ajudam quem está de fora a escolher um ataque.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Estado da API: `{status}` para todos; o detalhe só para o Admin',
  })
  @ApiOkResponse({ description: 'API e banco respondendo (`status: "ok"`).' })
  @ApiServiceUnavailableResponse({
    description: 'Banco fora do ar (`status: "degradado"`), com o mesmo corpo.',
  })
  async consultar(
    @Req() requisicao: RequisicaoHttp,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<Saude | SaudePublica> {
    const saude = await this.saude.verificar();
    if (saude.status !== 'ok') {
      resposta.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return requisicao.usuarioAutenticado?.papel === 'ADMIN'
      ? saude
      : { status: saude.status };
  }
}
