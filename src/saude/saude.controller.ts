import {
  Controller,
  Get,
  Header,
  HttpStatus,
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
import { type Saude, SaudeService } from './saude.service';

/** `GET /api/saude` — sem versão e sem login (healthcheck do Docker e card do front). */
@ApiTags('Saúde')
@Publico()
@Controller({ path: 'saude', version: VERSION_NEUTRAL })
export class SaudeController {
  constructor(private readonly saude: SaudeService) {}

  /**
   * Estado da API e do banco. HTTP 200 quando tudo responde; HTTP 503, com o
   * mesmo corpo, quando o banco falha — é o que o healthcheck do Docker olha.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Estado da API, do banco e das migrations' })
  @ApiOkResponse({ description: 'API e banco respondendo (`status: "ok"`).' })
  @ApiServiceUnavailableResponse({
    description: 'Banco fora do ar (`status: "degradado"`), com o mesmo corpo.',
  })
  async consultar(
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<Saude> {
    const saude = await this.saude.verificar();
    if (saude.status !== 'ok') {
      resposta.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return saude;
  }
}
