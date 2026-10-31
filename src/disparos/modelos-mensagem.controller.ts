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
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  AtualizarModeloMensagemDto,
  CriarModeloMensagemDto,
  FiltroModelosMensagemDto,
} from './disparos.dto';
import { ModelosMensagemService } from './modelos-mensagem.service';

/** Modelos de mensagem salvos (disparos, automações e chatbot usam). Variáveis e variações: ver `/modelos/variaveis`. */
@ApiTags('Modelos de mensagem')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('modelos-mensagem')
export class ModelosMensagemController {
  constructor(private readonly modelos: ModelosMensagemService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista os modelos que a pessoa vê (os de todas as áreas e os da sua)',
  })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroModelosMensagemDto,
  ) {
    return this.modelos.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary:
      'Cria um modelo (o texto é validado: variáveis desconhecidas dão 400)',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarModeloMensagemDto,
  ) {
    return this.modelos.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe do modelo' })
  @ApiRespostasDeErro(404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.modelos.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edita o modelo (campanhas já criadas guardam a própria cópia do texto)',
  })
  @ApiRespostasDeErro(400, 403, 404)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarModeloMensagemDto,
  ) {
    return this.modelos.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui o modelo' })
  @ApiRespostasDeErro(403, 404)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.modelos.excluir(usuario, id);
  }
}
