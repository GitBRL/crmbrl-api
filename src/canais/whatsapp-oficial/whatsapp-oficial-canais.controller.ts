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
import { TemplateDoCanalDto } from '../templates-canal.dto';
import { WhatsappOficialCanaisService } from './whatsapp-oficial-canais.service';
import {
  AtualizarCanalOficialDto,
  CanalOficialDto,
  CriarCanalOficialDto,
  SincronizacaoDeTemplatesDto,
  TesteDoCanalOficialDto,
  TokenDeVerificacaoOficialDto,
} from './whatsapp-oficial.dto';

/**
 * Configuração dos canais de WhatsApp oficial (R28): só o Admin (como os demais
 * canais). As mensagens chegam pelo webhook público
 * `/api/v1/publico/meta/webhook`.
 */
@ApiTags('Canais — WhatsApp oficial')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('whatsapp-oficial/canais')
export class WhatsappOficialCanaisController {
  constructor(private readonly canais: WhatsappOficialCanaisService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os canais de WhatsApp oficial' })
  @ApiOkResponse({ type: [CanalOficialDto] })
  listar(): Promise<CanalOficialDto[]> {
    return this.canais.listar();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalha um canal (segredos mascarados, dados do webhook, estado)',
  })
  @ApiOkResponse({ type: CanalOficialDto })
  @ApiRespostasDeErro(404)
  obter(@Param('id', ParseIdPipe) id: string): Promise<CanalOficialDto> {
    return this.canais.obter(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um canal de WhatsApp oficial',
    description:
      'Gera o verify token do webhook. Cole no painel do app da Meta a URL e o token devolvidos em `webhook` e assine os campos listados. O mesmo `phoneNumberId` não pode ter dois canais (409).',
  })
  @ApiCreatedResponse({ type: CanalOficialDto })
  @ApiRespostasDeErro(400, 409)
  criar(
    @Body() dto: CriarCanalOficialDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalOficialDto> {
    return this.canais.criar(dto, usuario.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera o canal (segredos ausentes = mantém os gravados)',
  })
  @ApiOkResponse({ type: CanalOficialDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCanalOficialDto,
  ): Promise<CanalOficialDto> {
    return this.canais.atualizar(id, dto);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testar conexão: lê o número na Graph API',
    description:
      'Sempre 200; `ok=false` traz o motivo em `mensagem` (e o canal passa ao estado `ERRO`).',
  })
  @ApiOkResponse({ type: TesteDoCanalOficialDto })
  @ApiRespostasDeErro(404)
  testar(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TesteDoCanalOficialDto> {
    return this.canais.testar(id);
  }

  @Post(':id/token-verificacao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gera outro verify token do webhook',
    description: 'O token antigo deixa de valer: atualize no painel da Meta.',
  })
  @ApiOkResponse({ type: TokenDeVerificacaoOficialDto })
  @ApiRespostasDeErro(404)
  regenerarToken(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TokenDeVerificacaoOficialDto> {
    return this.canais.regenerarTokenDeVerificacao(id);
  }

  @Get(':id/templates')
  @ApiOperation({
    summary: 'Templates em cache do canal (todos, com a situação na Meta)',
  })
  @ApiOkResponse({ type: [TemplateDoCanalDto] })
  @ApiRespostasDeErro(404)
  templates(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TemplateDoCanalDto[]> {
    return this.canais.listarTemplates(id);
  }

  @Post(':id/templates/sincronizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sincroniza os templates com a conta (WABA) na Meta',
    description:
      'Troca o cache do canal pela lista da Meta. 503 com o motivo se a Meta não respondeu ou o token não vale. Também roda sozinho todo dia às 03:00.',
  })
  @ApiOkResponse({ type: SincronizacaoDeTemplatesDto })
  @ApiRespostasDeErro(404, 503)
  sincronizar(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<SincronizacaoDeTemplatesDto> {
    return this.canais.sincronizarTemplates(id);
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
