import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { MetaCanaisService } from './meta-canais.service';
import {
  AtualizarCanalMetaDto,
  CanalMetaDto,
  CriarCanalMetaDto,
  TesteDoCanalMetaDto,
  TokenDeVerificacaoDto,
} from './meta.dto';

/**
 * Configuração dos canais de Instagram e Messenger (R14): só o Admin. As
 * mensagens chegam pelo webhook público `/api/v1/publico/meta/webhook`.
 */
@ApiTags('Canais — Instagram e Messenger')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('meta/canais')
export class MetaCanaisController {
  constructor(private readonly canais: MetaCanaisService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os canais de Instagram e Messenger' })
  @ApiOkResponse({ type: [CanalMetaDto] })
  listar(): Promise<CanalMetaDto[]> {
    return this.canais.listar();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalha um canal (segredos mascarados, dados do webhook)',
  })
  @ApiOkResponse({ type: CanalMetaDto })
  @ApiRespostasDeErro(404)
  obter(@Param('id', ParseIdPipe) id: string): Promise<CanalMetaDto> {
    return this.canais.obter(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um canal de Instagram ou Messenger',
    description:
      'Gera o token de verificação do webhook. Configure no painel do app da Meta a URL e o token devolvidos em `webhook`, assinando os campos listados.',
  })
  @ApiCreatedResponse({ type: CanalMetaDto })
  @ApiRespostasDeErro(400, 409)
  criar(
    @Body() dto: CriarCanalMetaDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalMetaDto> {
    return this.canais.criar(dto, usuario.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera o canal (segredos ausentes = mantém os gravados)',
  })
  @ApiOkResponse({ type: CanalMetaDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCanalMetaDto,
  ): Promise<CanalMetaDto> {
    return this.canais.atualizar(id, dto);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confere o token da página pela Graph API' })
  @ApiOkResponse({ type: TesteDoCanalMetaDto })
  @ApiRespostasDeErro(404)
  testar(@Param('id', ParseIdPipe) id: string): Promise<TesteDoCanalMetaDto> {
    return this.canais.testar(id);
  }

  @Post(':id/token-verificacao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gera outro token de verificação do webhook',
    description: 'O token antigo deixa de valer: atualize no painel da Meta.',
  })
  @ApiOkResponse({ type: TokenDeVerificacaoDto })
  @ApiRespostasDeErro(404)
  regenerarToken(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TokenDeVerificacaoDto> {
    return this.canais.regenerarTokenDeVerificacao(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o canal (o webhook passa a ignorá-lo; as conversas ficam)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.canais.excluir(id);
  }
}
