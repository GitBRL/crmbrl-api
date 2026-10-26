import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { Publico, SemVerificacaoDeOrigem } from '../../auth/decorators';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { NaoEncontradoException } from '../../comum/erros/excecoes';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import {
  ArquivosPublicos,
  responderArquivoPublico,
} from '../comum/arquivos-publicos';
import { LimitadorDeRequisicoes } from '../comum/limitador';
import { WebhookMetaService } from './webhook-meta.service';

/** Limite de chamadas ao webhook por IP (a Meta manda em rajadas). */
const LIMITE_DO_WEBHOOK = { limite: 1200, janelaMs: 60_000 } as const;

/**
 * Rotas públicas da Meta (§2.5, R14): o webhook do Instagram e do Messenger
 * (verificação e eventos) e o download dos anexos que o CRM envia (a Meta
 * busca pela URL assinada).
 */
@ApiTags('Meta (público)')
@Publico()
@SemVerificacaoDeOrigem()
@Controller('publico/meta')
export class WebhookMetaController {
  constructor(
    private readonly webhook: WebhookMetaService,
    private readonly limitador: LimitadorDeRequisicoes,
    private readonly arquivosPublicos: ArquivosPublicos,
    private readonly arquivos: ArquivosService,
  ) {}

  @Get('webhook')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOperation({
    summary: 'Verificação do webhook pela Meta',
    description:
      'A Meta chama com `hub.mode=subscribe`, `hub.verify_token` (o token de verificação do canal) e `hub.challenge`; a resposta é o `hub.challenge`. Token errado: 403.',
  })
  @ApiQuery({ name: 'hub.mode', example: 'subscribe' })
  @ApiQuery({ name: 'hub.verify_token' })
  @ApiQuery({ name: 'hub.challenge' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ description: 'O `hub.challenge`.' })
  @ApiRespostasDeErro(403, 429)
  verificar(
    @Query() consulta: Record<string, unknown>,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<string> {
    this.limitar(requisicao);
    const hub = (consulta.hub ?? {}) as Record<string, unknown>;
    return this.webhook.verificarDesafio(
      consulta['hub.mode'] ?? hub.mode,
      consulta['hub.verify_token'] ?? hub.verify_token,
      consulta['hub.challenge'] ?? hub.challenge,
    );
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Eventos do Instagram e do Messenger (mensagens, entregas, leituras)',
    description:
      'Exige `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo com o app secret>` (401 se não confere). Responde 200 na hora; o processamento é numa fila.',
  })
  @ApiHeader({ name: 'X-Hub-Signature-256', required: true })
  @ApiOkResponse({ description: '`{ recebidas }`' })
  @ApiRespostasDeErro(401, 429)
  receber(
    @Body() corpo: unknown,
    @Req() requisicao: RawBodyRequest<RequisicaoHttp>,
  ): Promise<{ recebidas: number }> {
    this.limitar(requisicao);
    return this.webhook.receber(
      corpo,
      requisicao.rawBody,
      requisicao.get('x-hub-signature-256'),
    );
  }

  @Get('arquivos/:id')
  @ApiExcludeEndpoint()
  async arquivo(
    @Param('id', ParseIdPipe) id: string,
    @Query() consulta: Record<string, unknown>,
    @Res() resposta: Response,
  ): Promise<void> {
    const canal = typeof consulta.c === 'string' ? consulta.c : '';
    if (
      !this.arquivosPublicos.conferir(
        id,
        `meta:${canal}`,
        consulta.e,
        consulta.a,
      )
    ) {
      throw new NaoEncontradoException('Arquivo não encontrado.');
    }
    const { arquivo, stream } = await this.arquivos.abrirLeitura(id);
    await responderArquivoPublico(resposta, arquivo, stream);
  }

  private limitar(requisicao: RequisicaoHttp): void {
    this.limitador.exigir(
      `meta:ip:${requisicao.ip ?? 'desconhecido'}`,
      LIMITE_DO_WEBHOOK,
      'Muitas chamadas ao webhook.',
    );
  }
}
