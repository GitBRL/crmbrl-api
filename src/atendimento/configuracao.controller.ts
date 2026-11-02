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
  Put,
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
import { CanaisDoAtendimentoService } from './canais-atendimento.service';
import {
  AtualizarAtendimentoDoCanalDto,
  CanalDoAtendimentoDto,
} from './dto/canal-atendimento.dto';
import {
  AtualizarFilaDto,
  CriarFilaDto,
  DefinirParticipacaoNaFilaDto,
  FilaDto,
  FiltroFilasDto,
} from './dto/fila.dto';
import {
  FiltroMetricasDoAtendimentoDto,
  MetricasDoAtendimentoDto,
} from './dto/metricas.dto';
import {
  AplicarRespostaRapidaDto,
  AtualizarRespostaRapidaDto,
  CriarRespostaRapidaDto,
  FiltroRespostasRapidasDto,
  RespostaAplicadaDto,
  RespostaRapidaDto,
  VariavelDto,
} from './dto/resposta-rapida.dto';
import { FilasService } from './filas.service';
import { MetricasDoAtendimentoService } from './metricas-atendimento.service';
import { RespostasRapidasService } from './respostas-rapidas.service';

/**
 * Filas de atendimento (R12): SLA, estratégia de distribuição e
 * participantes. Listam todos que usam o Atendimento; configuram Admin,
 * C-level e o líder da área.
 */
@ApiTags('Atendimento — filas')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('atendimento/filas')
export class FilasController {
  constructor(private readonly filas: FilasService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista as filas (com participantes, próximo da vez e conversas em aberto)',
  })
  @ApiOkResponse({ type: [FilaDto] })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroFilasDto,
  ): Promise<FilaDto[]> {
    return this.filas.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria uma fila (Comercial ou CS)',
    description:
      'SLA em minutos (nulo = sem SLA); estratégia `RODIZIO`, `MENOR_CARGA` ou `MANUAL`; participantes opcionais (sem lista, vale a área inteira — só quem já ativou o acesso recebe).',
  })
  @ApiCreatedResponse({ type: FilaDto })
  @ApiRespostasDeErro(400, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarFilaDto,
  ): Promise<FilaDto> {
    return this.filas.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma fila' })
  @ApiOkResponse({ type: FilaDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<FilaDto> {
    return this.filas.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera a fila',
    description:
      'A área só muda sem conversas em aberto. `participantes` substitui a lista (vazia = a área inteira).',
  })
  @ApiOkResponse({ type: FilaDto })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarFilaDto,
  ): Promise<FilaDto> {
    return this.filas.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui a fila',
    description:
      '422 com conversas em aberto. Os canais que a usavam ficam sem fila padrão.',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 404, 422)
  excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.filas.excluir(usuario, id);
  }

  @Put(':id/participantes/:usuarioId')
  @ApiOperation({
    summary: 'Põe ou tira alguém da distribuição da fila',
    description:
      'Fila da área inteira: `false` retira a pessoa; `true` devolve um membro retirado ou, para o líder, transforma a área numa lista (os membros de agora + o líder). Fila com lista: entra ou sai da lista.',
  })
  @ApiOkResponse({ type: FilaDto })
  @ApiRespostasDeErro(400, 404, 422)
  definirParticipacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
    @Body() dto: DefinirParticipacaoNaFilaDto,
  ): Promise<FilaDto> {
    return this.filas.definirParticipacao(usuario, id, usuarioId, dto);
  }

  @Delete(':id/participantes/:usuarioId')
  @ApiOperation({ summary: 'Desfaz o ajuste da pessoa na fila' })
  @ApiOkResponse({ type: FilaDto })
  @ApiRespostasDeErro(400, 404)
  removerAjuste(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
  ): Promise<FilaDto> {
    return this.filas.removerAjuste(usuario, id, usuarioId);
  }
}

/**
 * Respostas rápidas (R12): "/atalho" no compositor, com variáveis. Usam todos
 * do Atendimento (as globais e as da área); gerenciam Admin, C-level e o
 * líder (as da área dele).
 */
@ApiTags('Atendimento — respostas rápidas')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('atendimento/respostas-rapidas')
export class RespostasRapidasController {
  constructor(private readonly respostas: RespostasRapidasService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as respostas rápidas que a pessoa pode usar',
  })
  @ApiOkResponse({ type: [RespostaRapidaDto] })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroRespostasRapidasDto,
  ): Promise<RespostaRapidaDto[]> {
    return this.respostas.listar(usuario, filtro);
  }

  @Get('variaveis')
  @ApiOperation({
    summary: 'Variáveis aceitas no texto (`{{contato.primeiroNome}}`…)',
  })
  @ApiOkResponse({ type: [VariavelDto] })
  variaveis(@UsuarioAtual() usuario: UsuarioAutenticado): VariavelDto[] {
    return [...this.respostas.variaveis(usuario)];
  }

  @Post()
  @ApiOperation({
    summary: 'Cria uma resposta rápida',
    description:
      '400 com variável desconhecida ou atalho fora do formato; 409 com o atalho já usado no mesmo escopo (área ou global).',
  })
  @ApiCreatedResponse({ type: RespostaRapidaDto })
  @ApiRespostasDeErro(400, 409)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarRespostaRapidaDto,
  ): Promise<RespostaRapidaDto> {
    return this.respostas.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma resposta rápida' })
  @ApiOkResponse({ type: RespostaRapidaDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<RespostaRapidaDto> {
    return this.respostas.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Altera uma resposta rápida' })
  @ApiOkResponse({ type: RespostaRapidaDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarRespostaRapidaDto,
  ): Promise<RespostaRapidaDto> {
    return this.respostas.atualizar(usuario, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui uma resposta rápida' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 404)
  excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.respostas.excluir(usuario, id);
  }

  @Post(':id/aplicar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'O texto da resposta com as variáveis de uma conversa',
    description:
      'O compositor mostra o resultado para a pessoa revisar antes de enviar (e manda o `arquivo`, se houver, como `arquivoId`).',
  })
  @ApiOkResponse({ type: RespostaAplicadaDto })
  @ApiRespostasDeErro(400, 404)
  aplicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AplicarRespostaRapidaDto,
  ): Promise<RespostaAplicadaDto> {
    return this.respostas.aplicar(usuario, id, dto.conversaId);
  }
}

/**
 * Atendimento nos canais (R12): fila padrão, horário com resposta automática
 * e pesquisa de satisfação. Criar canais e credenciais fica nas telas de cada
 * canal.
 */
@ApiTags('Atendimento — canais')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('atendimento/canais')
export class CanaisDoAtendimentoController {
  constructor(private readonly canais: CanaisDoAtendimentoService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os canais com a configuração de atendimento',
    description: 'Para filtros e para a tela de configuração.',
  })
  @ApiOkResponse({ type: [CanalDoAtendimentoDto] })
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalDoAtendimentoDto[]> {
    return this.canais.listar(usuario);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha a configuração de atendimento do canal' })
  @ApiOkResponse({ type: CanalDoAtendimentoDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<CanalDoAtendimentoDto> {
    return this.canais.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Altera fila padrão, horário, resposta fora do horário e pesquisa de satisfação',
    description:
      'Admin e C-level. Horário: `{ fusoHorario, dias: { "1": [{ inicio: "08:00", fim: "18:00" }] } }` (0 = domingo); `null` = 24 horas.',
  })
  @ApiOkResponse({ type: CanalDoAtendimentoDto })
  @ApiRespostasDeErro(400, 404)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarAtendimentoDoCanalDto,
  ): Promise<CanalDoAtendimentoDto> {
    return this.canais.atualizar(usuario, id, dto);
  }
}

/** Métricas do Atendimento para o BI (R12). */
@ApiTags('Atendimento — métricas')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('atendimento/metricas')
export class MetricasDoAtendimentoController {
  constructor(private readonly metricas: MetricasDoAtendimentoService) {}

  @Get()
  @ApiOperation({
    summary: 'Indicadores por fila, por canal e por pessoa',
    description:
      'Período padrão: últimos 30 dias (máximo 1 ano). Conversas novas e primeira resposta contam pela chegada; resolução e SLA de resolução, pela data da resolução; satisfação, pela data do pedido/resposta. Admin e C-level veem tudo; o líder, a área dele.',
  })
  @ApiOkResponse({ type: MetricasDoAtendimentoDto })
  @ApiRespostasDeErro(400)
  calcular(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroMetricasDoAtendimentoDto,
  ): Promise<MetricasDoAtendimentoDto> {
    return this.metricas.calcular(usuario, filtro);
  }
}
