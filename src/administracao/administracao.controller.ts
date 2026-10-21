import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ParseIdSequencialPipe } from '../auditoria/consulta/parse-id-sequencial.pipe';
import { Papeis } from '../auth/decorators';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import {
  ApiRespostaPorCursor,
  type PaginaPorCursor,
} from '../comum/paginacao/paginacao';
import {
  FiltroLogsTecnicosDto,
  FiltroResumoDto,
  LogTecnicoDetalheDto,
  LogTecnicoDto,
  ResumoAdministracaoDto,
} from './administracao.dto';
import { LogsTecnicosConsultaService } from './logs-tecnicos-consulta.service';
import { ResumoAdministracaoService } from './resumo-administracao.service';

/** Administração do sistema: só o Admin (seção 12 das regras: logs técnicos). */
@ApiTags('Administração')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('administracao')
export class AdministracaoController {
  constructor(
    private readonly logs: LogsTecnicosConsultaService,
    private readonly resumos: ResumoAdministracaoService,
  ) {}

  @Get('resumo')
  @ApiOperation({
    summary:
      'Resumo do Admin: auditoria por ação, logs por nível, erros recentes e saúde da outbox, webhooks e retenção',
    description:
      'Janela das últimas `horas` (padrão 24, até 168). Os pendentes da outbox e das entregas e os itens ' +
      'vencidos da retenção são contados no momento, fora da janela.',
  })
  @ApiOkResponse({ type: ResumoAdministracaoDto })
  @ApiRespostasDeErro(400)
  resumo(@Query() filtro: FiltroResumoDto): Promise<ResumoAdministracaoDto> {
    return this.resumos.resumir(filtro.horas);
  }

  @Get('logs-tecnicos')
  @ApiOperation({
    summary: 'Lista os logs técnicos (R3.6), do mais novo para o mais antigo',
    description:
      'Erros 5xx, avisos e falhas de jobs, guardados por 90 dias. Filtros combináveis: nível (um ou vários), ' +
      'período `[de, ate)`, origem (`contexto`, pelo começo), usuário, id da requisição e texto (mensagem, ' +
      'origem e rota, sem diferenciar maiúsculas nem acentos). Paginação por cursor.',
  })
  @ApiRespostaPorCursor(LogTecnicoDto)
  @ApiRespostasDeErro(400)
  listarLogs(
    @Query() filtro: FiltroLogsTecnicosDto,
  ): Promise<PaginaPorCursor<LogTecnicoDto>> {
    return this.logs.listar(filtro);
  }

  @Get('logs-tecnicos/:id')
  @ApiOperation({
    summary: 'Detalha um log técnico, com os dados (e a pilha do erro)',
  })
  @ApiParam({
    name: 'id',
    description: 'Id sequencial do log.',
    example: '512',
  })
  @ApiOkResponse({ type: LogTecnicoDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalharLog(
    @Param('id', ParseIdSequencialPipe) id: bigint,
  ): Promise<LogTecnicoDetalheDto> {
    return this.logs.detalhar(id);
  }
}
