import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis } from '../../auth/decorators';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import {
  ApiRespostaPorCursor,
  type PaginaPorCursor,
} from '../../comum/paginacao/paginacao';
import {
  EventoAuditoriaDetalheDto,
  EventoAuditoriaDto,
  FiltroAuditoriaDto,
  FiltrosDaAuditoriaDto,
} from './auditoria-consulta.dto';
import { AuditoriaConsultaService } from './auditoria-consulta.service';
import { ParseIdSequencialPipe } from './parse-id-sequencial.pipe';

/**
 * Consulta da auditoria (R3.4): só Admin e C-level (seção 12 das regras).
 * Não há rota de edição nem de exclusão — a auditoria é somente inclusão (R3.3).
 */
@ApiTags('Auditoria')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN', 'C_LEVEL')
@Controller('auditoria')
export class AuditoriaConsultaController {
  constructor(private readonly consulta: AuditoriaConsultaService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os eventos de auditoria, do mais novo para o mais antigo',
    description:
      'Filtros combináveis (todos precisam valer): período `[de, ate)`, usuário, ação (uma ou várias), ' +
      'entidade, id da entidade (com `incluirRelacionados`, também os eventos ligados a ela), tipo de ator, ' +
      'id da requisição e texto (sem diferenciar maiúsculas nem acentos). Paginação por cursor: envie o ' +
      '`proximoCursor` recebido para a página seguinte; eventos novos não deslocam as páginas.',
  })
  @ApiRespostaPorCursor(EventoAuditoriaDto)
  @ApiRespostasDeErro(400)
  listar(
    @Query() filtro: FiltroAuditoriaDto,
  ): Promise<PaginaPorCursor<EventoAuditoriaDto>> {
    return this.consulta.listar(filtro);
  }

  @Get('filtros')
  @ApiOperation({
    summary: 'Ações, entidades e tipos de ator para montar os filtros',
  })
  @ApiOkResponse({ type: FiltrosDaAuditoriaDto })
  filtros(): Promise<FiltrosDaAuditoriaDto> {
    return this.consulta.filtrosDisponiveis();
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalha um evento: campos alterados (antes/depois), dados, relacionados, IP e user agent',
  })
  @ApiParam({
    name: 'id',
    description: 'Id sequencial do evento.',
    example: '1024',
  })
  @ApiOkResponse({ type: EventoAuditoriaDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @Param('id', ParseIdSequencialPipe) id: bigint,
  ): Promise<EventoAuditoriaDetalheDto> {
    return this.consulta.detalhar(id);
  }
}
