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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  AtualizarEtapaDto,
  AtualizarFunilDto,
  CriarEtapaDto,
  CriarFunilDto,
  EtapaDto,
  FiltroFunisDto,
  FunilDto,
  ReordenarEtapasDto,
} from './dto/funis.dto';
import { FiltroMetricasDto, MetricasDoFunilDto } from './dto/metricas.dto';
import { FiltroQuadroDto, QuadroDto } from './dto/quadro.dto';
import { FunisService } from './funis.service';
import { MetricasService } from './metricas.service';
import { NegociosConsultaService } from './negocios-consulta.service';

/** Funis, etapas, quadro kanban e métricas (R5.1, R5.2, R5.9, R5.10). */
@ApiTags('Funis')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('funis')
export class FunisController {
  constructor(
    private readonly funis: FunisService,
    private readonly consulta: NegociosConsultaService,
    private readonly metricas: MetricasService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os funis que o usuário vê, com as etapas em ordem',
    description:
      'Admin e C-level veem todos; as demais pessoas, os da sua área (R5.9). Arquivados só com `incluirArquivados`.',
  })
  @ApiOkResponse({ type: [FunilDto] })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroFunisDto,
  ): Promise<FunilDto[]> {
    return this.funis.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um funil extra com as etapas (R5.1, R5.2)',
    description:
      'Admin e C-level em qualquer área; o líder, na sua. As etapas precisam de ao menos uma aberta, exatamente uma de ganho e uma de perda.',
  })
  @ApiCreatedResponse({ type: FunilDto })
  @ApiRespostasDeErro(400, 403, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarFunilDto,
  ): Promise<FunilDto> {
    return this.funis.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um funil com as etapas' })
  @ApiOkResponse({ type: FunilDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<FunilDto> {
    return this.funis.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Renomeia, reordena, arquiva ou reativa um funil (R5.1)',
  })
  @ApiOkResponse({ type: FunilDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarFunilDto,
  ): Promise<FunilDto> {
    return this.funis.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui um funil extra (os funis-base não são excluídos, R5.1)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 403, 404, 422)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.funis.excluir(usuario, id);
  }

  @Post(':id/etapas')
  @ApiOperation({
    summary: 'Cria uma etapa aberta no funil (R5.2)',
    description:
      'Sem `ordem`, entra depois da última etapa aberta. Devolve o funil com as etapas renumeradas.',
  })
  @ApiCreatedResponse({ type: FunilDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  criarEtapa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CriarEtapaDto,
  ): Promise<FunilDto> {
    return this.funis.criarEtapa(usuario, id, dto);
  }

  @Post(':id/etapas/reordenar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reordena as etapas do funil (R5.1)' })
  @ApiOkResponse({ type: FunilDto })
  @ApiRespostasDeErro(400, 403, 404)
  reordenarEtapas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ReordenarEtapasDto,
  ): Promise<FunilDto> {
    return this.funis.reordenarEtapas(usuario, id, dto);
  }

  @Patch(':id/etapas/:etapaId')
  @ApiOperation({
    summary: 'Renomeia a etapa ou muda prazo-alvo e probabilidade (R5.2)',
  })
  @ApiOkResponse({ type: EtapaDto })
  @ApiRespostasDeErro(400, 403, 404, 409)
  atualizarEtapa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('etapaId', ParseIdPipe) etapaId: string,
    @Body() dto: AtualizarEtapaDto,
  ): Promise<EtapaDto> {
    return this.funis.atualizarEtapa(usuario, id, etapaId, dto);
  }

  @Delete(':id/etapas/:etapaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui uma etapa aberta sem negócios (R5.2)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 403, 404, 422)
  async excluirEtapa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('etapaId', ParseIdPipe) etapaId: string,
  ): Promise<void> {
    await this.funis.excluirEtapa(usuario, id, etapaId);
  }

  @Get(':id/quadro')
  @ApiOperation({
    summary: 'Quadro kanban do funil',
    description:
      'Etapas em ordem, cada uma com total, soma dos valores, parados e os cartões em ordem de posição. ' +
      'Filtros: `visao` (TODOS, MEUS, EQUIPE), `busca`, `etiqueta`, `responsavelId`, `semResponsavel` (R5.9).',
  })
  @ApiOkResponse({ type: QuadroDto })
  @ApiRespostasDeErro(400, 404)
  quadro(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroQuadroDto,
  ): Promise<QuadroDto> {
    return this.consulta.quadro(usuario, id, filtro);
  }

  @Get(':id/metricas')
  @ApiOperation({
    summary: 'Métricas base do funil no período (R5.10)',
    description:
      'Contagem e valor por etapa, conversão entre etapas, tempo médio por etapa, ciclo médio (criação → ganho) e negócios parados. ' +
      'Período padrão: os últimos 30 dias.',
  })
  @ApiOkResponse({ type: MetricasDoFunilDto })
  @ApiRespostasDeErro(400, 404)
  metricasDoFunil(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroMetricasDto,
  ): Promise<MetricasDoFunilDto> {
    return this.metricas.doFunil(usuario, id, filtro);
  }
}
