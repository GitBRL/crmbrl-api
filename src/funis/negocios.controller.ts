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
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from '../contatos/dto/linha-do-tempo.dto';
import {
  AtualizarNegocioDto,
  CriarNegocioDto,
  FiltroNegociosDto,
  MoverNegocioDto,
  MovimentacaoDto,
  NegocioDto,
  ReabrirNegocioDto,
  ResultadoMovimentacaoDto,
} from './dto/negocios.dto';
import { NegociosConsultaService } from './negocios-consulta.service';
import { NegociosService } from './negocios.service';

/**
 * Negócios (R5.3–R5.9). A pessoa só vê (e edita e move) os negócios que o
 * papel dela alcança (R5.9); os demais respondem 404.
 */
@ApiTags('Negócios')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('negocios')
export class NegociosController {
  constructor(
    private readonly negocios: NegociosService,
    private readonly consulta: NegociosConsultaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os negócios visíveis, com filtros e paginação',
    description:
      'Também serve para carregar mais cartões de uma coluna do kanban (`funilId`, `etapaId`, `ordenarPor=posicao`, `direcao=asc`).',
  })
  @ApiRespostaPaginada(NegocioDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroNegociosDto,
  ): Promise<Pagina<NegocioDto>> {
    return this.consulta.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um negócio (R5.3)',
    description:
      'Criação manual, sem deduplicação (R5.6). Padrões: primeira etapa aberta, título = nome do contato, ' +
      'empresa = a do contato, responsável = quem cria. Etapa de perda exige `motivoPerda` (R5.5).',
  })
  @ApiCreatedResponse({ type: NegocioDto })
  @ApiRespostasDeErro(400, 404, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarNegocioDto,
  ): Promise<NegocioDto> {
    return this.negocios.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um negócio' })
  @ApiOkResponse({ type: NegocioDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<NegocioDto> {
    return this.negocios.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita os dados do negócio (a etapa muda por `mover`)',
  })
  @ApiOkResponse({ type: NegocioDto })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarNegocioDto,
  ): Promise<NegocioDto> {
    return this.negocios.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o negócio (lógico; líder da área, C-level ou Admin)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 403, 404)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.negocios.excluir(usuario, id);
  }

  @Post(':id/mover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Move o negócio para outra etapa do mesmo funil (R5.4)',
    description:
      'Grava o histórico com o tempo na etapa anterior e executa as passagens disparadas na mesma transação (R5.7). ' +
      'Etapa de perda exige `motivoPerda` (400, R5.5); tirar um negócio ganho ou perdido da etapa é reabrir (403 para quem não pode, R5.5). ' +
      'A mesma etapa só reposiciona o cartão (`depoisDeId`/`antesDeId`).',
  })
  @ApiOkResponse({ type: ResultadoMovimentacaoDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  mover(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: MoverNegocioDto,
  ): Promise<ResultadoMovimentacaoDto> {
    return this.negocios.mover(usuario, id, dto);
  }

  @Post(':id/reabrir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reabre um negócio ganho ou perdido (R5.5)',
    description:
      'Só o líder da área, o C-level e o Admin. Sem `etapaId`, volta para a etapa aberta em que estava antes de fechar.',
  })
  @ApiOkResponse({ type: ResultadoMovimentacaoDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  reabrir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ReabrirNegocioDto,
  ): Promise<ResultadoMovimentacaoDto> {
    return this.negocios.reabrir(usuario, id, dto);
  }

  @Post(':id/assumir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assume um negócio sem responsável (R5.9)',
  })
  @ApiOkResponse({ type: NegocioDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  assumir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<NegocioDto> {
    return this.negocios.assumir(usuario, id);
  }

  @Get(':id/movimentacoes')
  @ApiOperation({
    summary: 'Histórico de movimentação do negócio (R5.4)',
  })
  @ApiOkResponse({ type: [MovimentacaoDto] })
  @ApiRespostasDeErro(400, 404)
  movimentacoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<MovimentacaoDto[]> {
    return this.consulta.movimentacoes(usuario, id);
  }

  @Get(':id/linha-do-tempo')
  @ApiOperation({
    summary: 'Linha do tempo do negócio: auditoria e atividades (R3.5)',
    description:
      'Eventos de auditoria ligados ao negócio e as atividades dele, dos mais recentes para os mais antigos. ' +
      'Atividades seguem a R6.4 e eventos de outros negócios, a R5.9. `incluir` = `tudo` (padrão), `eventos` ou `atividades`.',
  })
  @ApiRespostaPaginada(RegistroDaLinhaDoTempoDto)
  @ApiRespostasDeErro(400, 404)
  linhaDoTempo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    return this.consulta.linhaDoTempo(usuario, id, filtro);
  }
}
