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
import {
  AtualizarCanalWebchatDto,
  CanalWebchatDto,
  CriarCanalWebchatDto,
} from './webchat.dto';
import { WebchatCanaisService } from './webchat-canais.service';

/**
 * Configuração dos canais de chat do site (R14): só o Admin, como os outros
 * canais. O widget usa as rotas públicas `/publico/webchat/...`.
 */
@ApiTags('Canais — chat do site')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webchat/canais')
export class WebchatCanaisController {
  constructor(private readonly canais: WebchatCanaisService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os canais de chat do site' })
  @ApiOkResponse({ type: [CanalWebchatDto] })
  listar(): Promise<CanalWebchatDto[]> {
    return this.canais.listar();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um canal (com o trecho de instalação)' })
  @ApiOkResponse({ type: CanalWebchatDto })
  @ApiRespostasDeErro(404)
  obter(@Param('id', ParseIdPipe) id: string): Promise<CanalWebchatDto> {
    return this.canais.obter(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um canal de chat do site',
    description:
      'Gera a chave pública e o trecho de instalação. Informe os domínios do site: o widget só funciona neles (e no próprio CRM, para a prévia).',
  })
  @ApiCreatedResponse({ type: CanalWebchatDto })
  @ApiRespostasDeErro(400)
  criar(
    @Body() dto: CriarCanalWebchatDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalWebchatDto> {
    return this.canais.criar(dto, usuario.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Altera o canal (só os campos enviados)' })
  @ApiOkResponse({ type: CanalWebchatDto })
  @ApiRespostasDeErro(400, 404)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCanalWebchatDto,
  ): Promise<CanalWebchatDto> {
    return this.canais.atualizar(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o canal (o widget para de funcionar; as conversas ficam)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.canais.excluir(id);
  }
}
