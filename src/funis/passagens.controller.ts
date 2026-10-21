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
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  AtualizarPassagemDto,
  CriarPassagemDto,
  PassagemDto,
} from './dto/passagens.dto';
import { PassagensService } from './passagens.service';

/** Passagens entre funis (R5.7) — configuradas pelo Admin e pelo C-level. */
@ApiTags('Passagens')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN', 'C_LEVEL')
@Controller('passagens')
export class PassagensController {
  constructor(private readonly passagens: PassagensService) {}

  @Get()
  @ApiOperation({ summary: 'Lista as passagens entre funis' })
  @ApiOkResponse({ type: [PassagemDto] })
  listar(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<PassagemDto[]> {
    return this.passagens.listar(usuario);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria uma passagem entre funis (R5.7)',
    description:
      'Liga a etapa-gatilho de um funil a uma etapa aberta de outro funil, com a estratégia de distribuição (R5.8).',
  })
  @ApiCreatedResponse({ type: PassagemDto })
  @ApiRespostasDeErro(400, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarPassagemDto,
  ): Promise<PassagemDto> {
    return this.passagens.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma passagem' })
  @ApiOkResponse({ type: PassagemDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<PassagemDto> {
    return this.passagens.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera, ativa ou desativa uma passagem (R5.7)',
  })
  @ApiOkResponse({ type: PassagemDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarPassagemDto,
  ): Promise<PassagemDto> {
    return this.passagens.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Exclui uma passagem que nunca rodou (as que já rodaram são desativadas)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 404, 422)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.passagens.excluir(usuario, id);
  }
}
