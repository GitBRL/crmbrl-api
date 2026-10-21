import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { Area } from '../generated/prisma/client';
import { DistribuicaoService } from './distribuicao.service';
import {
  AtualizarRegraDistribuicaoDto,
  DefinirParticipacaoDto,
  RegraDistribuicaoDto,
} from './dto/distribuicao.dto';
import { ParseAreaPipe } from './parse-area.pipe';

/**
 * Rodízio de distribuição por área (R5.8). Matriz: Admin e C-level configuram
 * todos; o líder, o da sua área.
 */
@ApiTags('Distribuição')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('regras-distribuicao')
export class DistribuicaoController {
  constructor(private readonly distribuicao: DistribuicaoService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os rodízios que o usuário configura',
    description:
      'Cada um com a ordem de quem recebe, os ajustes manuais e o próximo da vez.',
  })
  @ApiOkResponse({ type: [RegraDistribuicaoDto] })
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RegraDistribuicaoDto[]> {
    return this.distribuicao.listar(usuario);
  }

  @Get(':area')
  @ApiOperation({ summary: 'Detalha o rodízio de uma área' })
  @ApiParam({ name: 'area', enum: Area, enumName: 'Area' })
  @ApiOkResponse({ type: RegraDistribuicaoDto })
  @ApiRespostasDeErro(400)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('area', ParseAreaPipe) area: Area,
  ): Promise<RegraDistribuicaoDto> {
    return this.distribuicao.detalhar(usuario, area);
  }

  @Patch(':area')
  @ApiOperation({
    summary: 'Define se o líder da área entra no rodízio (R5.8)',
  })
  @ApiParam({ name: 'area', enum: Area, enumName: 'Area' })
  @ApiOkResponse({ type: RegraDistribuicaoDto })
  @ApiRespostasDeErro(400)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('area', ParseAreaPipe) area: Area,
    @Body() dto: AtualizarRegraDistribuicaoDto,
  ): Promise<RegraDistribuicaoDto> {
    return this.distribuicao.atualizar(usuario, area, dto);
  }

  @Put(':area/participantes/:usuarioId')
  @ApiOperation({
    summary: 'Inclui ou tira alguém da área do rodízio (ajuste manual)',
  })
  @ApiParam({ name: 'area', enum: Area, enumName: 'Area' })
  @ApiOkResponse({ type: RegraDistribuicaoDto })
  @ApiRespostasDeErro(400, 404, 422)
  definirParticipacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('area', ParseAreaPipe) area: Area,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
    @Body() dto: DefinirParticipacaoDto,
  ): Promise<RegraDistribuicaoDto> {
    return this.distribuicao.definirParticipacao(usuario, area, usuarioId, dto);
  }

  @Delete(':area/participantes/:usuarioId')
  @ApiOperation({
    summary: 'Desfaz o ajuste manual (a pessoa volta a seguir a regra)',
  })
  @ApiParam({ name: 'area', enum: Area, enumName: 'Area' })
  @ApiOkResponse({ type: RegraDistribuicaoDto })
  @ApiRespostasDeErro(400, 404)
  removerAjuste(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('area', ParseAreaPipe) area: Area,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
  ): Promise<RegraDistribuicaoDto> {
    return this.distribuicao.removerAjuste(usuario, area, usuarioId);
  }
}
