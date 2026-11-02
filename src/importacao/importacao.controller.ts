import { pipeline } from 'node:stream/promises';
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
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { cabecalhoContentDisposition } from '../arquivos/politica';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  AtualizarImportacaoDto,
  AtualizarModeloDto,
  CampoDeImportacaoDto,
  CriadaImportacaoDto,
  CriarImportacaoDto,
  CriarModeloDto,
  FiltroCamposDto,
  FiltroImportacoesDto,
  FiltroLinhasDto,
  FiltroModelosDto,
  FiltroPreviaDto,
  ImportacaoDto,
  LinhaDeImportacaoDto,
  ModeloDeImportacaoDto,
  PreviaDto,
} from './importacao.dto';
import { ImportacaoService } from './importacao.service';
import { ModelosDeImportacaoService } from './modelos-de-importacao.service';

const TIPO_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Importação de contatos e empresas por planilha (R16). Fluxo: enviar o arquivo
 * (`POST /arquivos?contexto=IMPORTACAO`) → `POST /importacoes` (rascunho com
 * colunas, prévia e sugestão de mapeamento) → `PATCH /importacoes/:id`
 * (mapeamento e opções) → `POST /importacoes/:id/iniciar` → progresso ao vivo
 * (`importacao.progresso`) → relatório. Admin, C-level e líderes (R16.1).
 */
@ApiTags('Importação')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('importacoes')
export class ImportacaoController {
  constructor(
    private readonly importacoes: ImportacaoService,
    private readonly modelos: ModelosDeImportacaoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Histórico de importações',
    description: 'Admin e C-level veem todas; líderes, as próprias.',
  })
  @ApiRespostaPaginada(ImportacaoDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroImportacoesDto,
  ): Promise<Pagina<ImportacaoDto>> {
    return this.importacoes.listar(usuario, filtro);
  }

  @Get('campos')
  @ApiOperation({
    summary: 'Campos de destino do mapeamento',
    description:
      'Além destes, `campos.<chave>` grava num campo personalizado (minúsculas, números e `_`).',
  })
  @ApiOkResponse({ type: [CampoDeImportacaoDto] })
  campos(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroCamposDto,
  ): CampoDeImportacaoDto[] {
    this.importacoes.garantirPodeImportar(usuario);
    return this.modelos.campos(filtro.tipo);
  }

  @Get('modelos')
  @ApiOperation({ summary: 'Modelos de mapeamento salvos' })
  @ApiOkResponse({ type: [ModeloDeImportacaoDto] })
  listarModelos(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroModelosDto,
  ): Promise<ModeloDeImportacaoDto[]> {
    return this.modelos.listar(usuario, filtro.tipo);
  }

  @Post('modelos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Salva um modelo de mapeamento' })
  @ApiCreatedResponse({ type: ModeloDeImportacaoDto })
  @ApiRespostasDeErro(400, 409)
  criarModelo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarModeloDto,
  ): Promise<ModeloDeImportacaoDto> {
    return this.modelos.criar(usuario, dto);
  }

  @Patch('modelos/:id')
  @ApiOperation({ summary: 'Altera um modelo de mapeamento' })
  @ApiOkResponse({ type: ModeloDeImportacaoDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizarModelo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarModeloDto,
  ): Promise<ModeloDeImportacaoDto> {
    return this.modelos.atualizar(usuario, id, dto);
  }

  @Delete('modelos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove um modelo de mapeamento' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  removerModelo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.modelos.remover(usuario, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Cria o rascunho a partir de um arquivo enviado',
    description:
      'Lê o arquivo (até 50 mil linhas, 422 R16.2 acima disso), detecta separador, codificação e colunas, e devolve a prévia com o mapeamento sugerido (já gravado no rascunho).',
  })
  @ApiCreatedResponse({ type: CriadaImportacaoDto })
  @ApiRespostasDeErro(400, 404, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarImportacaoDto,
  ): Promise<CriadaImportacaoDto> {
    return this.importacoes.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma importação (contadores e situação)' })
  @ApiOkResponse({ type: ImportacaoDto })
  @ApiRespostasDeErro(404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ImportacaoDto> {
    return this.importacoes.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Mapeamento e opções (só no rascunho)',
    description:
      'Mapeamento `{ coluna: campo }`, `modeloId` (aplica um modelo salvo), duplicados, etiquetas, responsável (fixo ou rodízio da área), detalhe da origem e `leitura` (separador, aba…).',
  })
  @ApiOkResponse({ type: ImportacaoDto })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarImportacaoDto,
  ): Promise<ImportacaoDto> {
    return this.importacoes.atualizar(usuario, id, dto);
  }

  @Get(':id/previa')
  @ApiOperation({ summary: 'Primeiras linhas do arquivo' })
  @ApiOkResponse({ type: PreviaDto })
  @ApiRespostasDeErro(404)
  previa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroPreviaDto,
  ): Promise<PreviaDto> {
    return this.importacoes.previa(usuario, id, filtro.linhas);
  }

  @Post(':id/iniciar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confere o mapeamento e põe a importação na fila',
    description:
      'Devolve a importação `NA_FILA`; o progresso chega pelo evento `importacao.progresso`.',
  })
  @ApiOkResponse({ type: ImportacaoDto })
  @ApiRespostasDeErro(404, 422)
  iniciar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ImportacaoDto> {
    return this.importacoes.iniciar(usuario, id);
  }

  @Post(':id/retomar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retoma uma importação que falhou, depois da última linha gravada',
  })
  @ApiOkResponse({ type: ImportacaoDto })
  @ApiRespostasDeErro(404, 422)
  retomar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ImportacaoDto> {
    return this.importacoes.retomar(usuario, id);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela (o que já foi importado fica)' })
  @ApiOkResponse({ type: ImportacaoDto })
  @ApiRespostasDeErro(404, 422)
  cancelar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ImportacaoDto> {
    return this.importacoes.cancelar(usuario, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Apaga um rascunho ou uma importação cancelada ou que falhou',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404, 422)
  remover(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.importacoes.remover(usuario, id);
  }

  @Get(':id/linhas')
  @ApiOperation({
    summary: 'Resultado por linha (filtre por `resultado=ERRO`)',
  })
  @ApiRespostaPaginada(LinhaDeImportacaoDto)
  @ApiRespostasDeErro(404)
  linhas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroLinhasDto,
  ): Promise<Pagina<LinhaDeImportacaoDto>> {
    return this.importacoes.linhas(usuario, id, filtro);
  }

  @Get(':id/relatorio')
  @ApiOperation({
    summary:
      'Baixa o relatório em XLSX (resumo e linhas com erro ou ignoradas)',
  })
  @ApiProduces(TIPO_XLSX)
  @ApiOkResponse({ description: 'Arquivo XLSX.' })
  @ApiRespostasDeErro(404)
  async relatorio(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Res() resposta: Response,
  ): Promise<void> {
    const { arquivo, stream } = await this.importacoes.relatorio(usuario, id);
    resposta.setHeader('Content-Type', arquivo.mime);
    resposta.setHeader('Content-Length', String(arquivo.tamanho));
    resposta.setHeader(
      'Content-Disposition',
      cabecalhoContentDisposition(arquivo.nome, 'attachment'),
    );
    resposta.setHeader('Cache-Control', 'private, no-store');
    await pipeline(stream, resposta);
  }
}
