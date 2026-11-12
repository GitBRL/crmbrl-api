import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import {
  AtualizarPainelIndicadoresDto,
  CalcularIndicadoresDto,
  CriarPainelIndicadoresDto,
  DuplicarPainelDto,
  ExportarIndicadoresDto,
  PainelIndicadoresDto,
} from './dto/indicadores.dto';
import { IndicadoresService } from './indicadores.service';
import { PaineisIndicadoresService } from './paineis-indicadores.service';

/**
 * Indicadores configuráveis (R33): catálogo, painéis (criar, editar, duplicar,
 * compartilhar, excluir), cálculo e exportação. Cada número é calculado para
 * quem vê, com os recortes do BI (R20.2).
 */
@ApiTags('Indicadores')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('indicadores')
export class IndicadoresController {
  constructor(
    private readonly indicadores: IndicadoresService,
    private readonly paineis: PaineisIndicadoresService,
  ) {}

  @Get('catalogo')
  @ApiOperation({
    summary: 'Catálogo de indicadores (R33.1)',
    description:
      'Grupos, indicadores (chave, nome, descrição, grupo, unidade, parâmetros, visualizações e dimensões de barras) e os modelos prontos de painel. `DURACAO` é em segundos.',
  })
  @ApiOkResponse({ description: '`{grupos, indicadores, modelos}`.' })
  catalogo() {
    return this.indicadores.catalogo();
  }

  @Get('paineis')
  @ApiOperation({
    summary: 'Lista os painéis que a pessoa vê (R33.6)',
    description:
      'O dono, os compartilhados com ela (por setor, pessoa ou papel) e, para Admin e C-level, todos. Sem os widgets (use o detalhe).',
  })
  @ApiOkResponse({ type: [PainelIndicadoresDto] })
  listar(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.paineis.listar(usuario);
  }

  @Post('paineis')
  @Papeis('ADMIN', 'C_LEVEL', 'LIDER')
  @ApiOperation({
    summary: 'Cria um painel (ou o modelo pronto "Time comercial")',
    description:
      'Só Admin, C-level e líderes. Com `modelo: "time_comercial"` o painel já nasce com os indicadores do modelo. O líder compartilha só com o próprio setor e as pessoas dele (403 R33). Auditado (`indicadores.painel_criado`).',
  })
  @ApiCreatedResponse({ type: PainelIndicadoresDto })
  @ApiRespostasDeErro(400, 403, 404)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarPainelIndicadoresDto,
  ) {
    return this.paineis.criar(usuario, dto);
  }

  @Get('paineis/:id')
  @ApiOperation({
    summary: 'Detalha um painel (com os indicadores e os filtros)',
  })
  @ApiOkResponse({ type: PainelIndicadoresDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paineis.detalhar(usuario, id);
  }

  @Patch('paineis/:id')
  @Papeis('ADMIN', 'C_LEVEL', 'LIDER')
  @ApiOperation({
    summary: 'Edita um painel (nome, filtros, indicadores, compartilhamento)',
    description:
      'Admin e C-level editam todos; o líder, os seus. Auditado (`indicadores.painel_atualizado` e, se mudar com quem se compartilha, `indicadores.painel_compartilhado`).',
  })
  @ApiOkResponse({ type: PainelIndicadoresDto })
  @ApiRespostasDeErro(400, 403, 404)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarPainelIndicadoresDto,
  ) {
    return this.paineis.atualizar(usuario, id, dto);
  }

  @Post('paineis/:id/duplicar')
  @Papeis('ADMIN', 'C_LEVEL', 'LIDER')
  @ApiOperation({
    summary: 'Duplica um painel que a pessoa vê',
    description:
      'A cópia é da pessoa que duplica e nasce sem compartilhamento.',
  })
  @ApiCreatedResponse({ type: PainelIndicadoresDto })
  @ApiRespostasDeErro(400, 403, 404)
  duplicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicarPainelDto,
  ) {
    return this.paineis.duplicar(usuario, id, dto.nome);
  }

  @Delete('paineis/:id')
  @Papeis('ADMIN', 'C_LEVEL', 'LIDER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui um painel (Admin e C-level todos; o líder, os seus)',
  })
  @ApiRespostasDeErro(400, 403, 404)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.paineis.excluir(usuario, id);
  }

  @Post('calcular')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calcula os indicadores de um painel (R33.7)',
    description:
      'Corpo: `{painelId?, widgets?, filtros?}`. Cada widget volta com o próprio `ok`; o erro de um não derruba os outros. Os números são os que a pessoa veria nas listas (R20.2). Cache de 30 s por pessoa e filtros; `Cache-Control: no-cache` recalcula. Filtro escolhido fora do alcance dá 4xx para a chamada toda (R20.3).',
  })
  @ApiOkResponse({
    description:
      '`{painelId, geradoEm, periodo, anterior, filtros, widgets[]}`.',
  })
  @ApiRespostasDeErro(400, 403, 404)
  calcular(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CalcularIndicadoresDto,
    @Headers('cache-control') cacheControl?: string,
  ) {
    return this.indicadores.calcular(
      usuario,
      dto,
      /no-cache|no-store/i.test(cacheControl ?? ''),
    );
  }

  @Post('exportar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta o painel (XLSX ou CSV com `;`)',
    description:
      'Mesmos filtros e números do `calcular`, de quem exporta, sem cache. XLSX: resumo e uma aba por indicador; CSV: o resumo (ou o indicador de `widgetId`). Auditado (`indicadores.exportado`).',
  })
  @ApiOkResponse({ type: ArquivoDto })
  @ApiRespostasDeErro(400, 403, 404)
  exportar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: ExportarIndicadoresDto,
  ): Promise<ArquivoDto> {
    return this.indicadores.exportar(
      usuario,
      dto,
      dto.formato ?? 'xlsx',
      dto.widgetId,
    );
  }
}
