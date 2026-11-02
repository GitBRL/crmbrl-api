import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  AlterarPreferenciasPushDto,
  ChavePublicaPushDto,
  InscreverPushDto,
  InscricaoCriadaDto,
  InscricaoPushDto,
  PreferenciasPushDto,
  ResultadoDoTestePushDto,
} from './push.dto';
import { PushService } from './push.service';

/** Notificações push do próprio usuário (R26). */
@ApiTags('Notificações push')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('chave-publica')
  @ApiOperation({
    summary: 'Chave pública VAPID para inscrever o aparelho',
    description:
      '503 com `detalhes.motivo = "nao_configurado"` quando o servidor não tem as chaves VAPID.',
  })
  @ApiOkResponse({ type: ChavePublicaPushDto })
  @ApiRespostasDeErro(503)
  chavePublica(): ChavePublicaPushDto {
    return { chavePublica: this.push.chavePublica() };
  }

  @Post('inscricoes')
  @ApiOperation({
    summary: 'Inscreve este aparelho (idempotente por endpoint)',
    description: '201 na primeira vez; 200 se o endpoint já estava inscrito.',
  })
  @ApiCreatedResponse({ type: InscricaoCriadaDto })
  @ApiOkResponse({ type: InscricaoCriadaDto })
  @ApiRespostasDeErro(400, 503)
  async inscrever(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: InscreverPushDto,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<InscricaoCriadaDto> {
    const { id, nova } = await this.push.inscrever(usuario.id, dto);
    resposta.status(nova ? HttpStatus.CREATED : HttpStatus.OK);
    return { id };
  }

  @Get('inscricoes')
  @ApiOperation({ summary: 'Os aparelhos inscritos da própria pessoa' })
  @ApiOkResponse({ type: InscricaoPushDto, isArray: true })
  async inscricoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<InscricaoPushDto[]> {
    return (await this.push.listarInscricoes(usuario.id)).map((i) =>
      InscricaoPushDto.de(i),
    );
  }

  @Delete('inscricoes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove um aparelho da própria pessoa' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async remover(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.push.remover(usuario.id, id);
  }

  @Get('preferencias')
  @ApiOperation({
    summary: 'Preferências de push por tipo (tudo ligado por padrão)',
  })
  @ApiOkResponse({ type: PreferenciasPushDto })
  async preferencias(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<PreferenciasPushDto> {
    return { tipos: await this.push.preferencias(usuario.id) };
  }

  @Put('preferencias')
  @ApiOperation({
    summary:
      'Liga ou desliga tipos de push (os tipos omitidos ficam como estão)',
  })
  @ApiOkResponse({ type: PreferenciasPushDto })
  @ApiRespostasDeErro(400)
  async alterarPreferencias(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: AlterarPreferenciasPushDto,
  ): Promise<PreferenciasPushDto> {
    return { tipos: await this.push.alterarPreferencias(usuario.id, dto) };
  }

  @Post('teste')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Envia um push de teste para os meus aparelhos' })
  @ApiOkResponse({ type: ResultadoDoTestePushDto })
  @ApiRespostasDeErro(422, 503)
  testar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ResultadoDoTestePushDto> {
    return this.push.testar(usuario.id);
  }
}
