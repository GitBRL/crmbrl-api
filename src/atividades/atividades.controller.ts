import {
  Body,
  Controller,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { AtividadesService } from './atividades.service';
import { AtividadeDto, AtividadesAgrupadasDto } from './dto/atividade.dto';
import { AtualizarAtividadeDto } from './dto/atualizar-atividade.dto';
import { ConcluirAtividadeDto } from './dto/concluir-atividade.dto';
import { CriarAtividadeDto } from './dto/criar-atividade.dto';
import {
  FiltroAgrupadasDto,
  FiltroAtividadesDto,
} from './dto/filtro-atividades.dto';

/**
 * Atividades (R6): tarefas, ligações, reuniões, e-mails, WhatsApp e notas.
 * Cada um vê o que a R6.4 permite — o responsável, quem criou, o líder do
 * responsável, o C-level e o Admin —, e quem vê também pode alterar.
 */
@ApiTags('Atividades')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('atividades')
export class AtividadesController {
  constructor(private readonly atividades: AtividadesService) {}

  @Post()
  @ApiOperation({
    summary: 'Cria uma atividade',
    description:
      'R6.1: título obrigatório; reunião com início e fim; os demais tipos com vencimento opcional; vínculo com contato, empresa e/ou negócio. ' +
      'R6.2: responsável ativo (padrão: quem cria); a nota já nasce concluída. Publica `atividade.criada` (e `atividade.concluida`, se criada concluída).',
  })
  @ApiCreatedResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarAtividadeDto,
  ): Promise<AtividadeDto> {
    return this.atividades.criar(usuario, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista as atividades que o usuário pode ver (R6.4)',
    description:
      'Filtros por escopo (minhas, equipe, todas), pessoa, tipo, status, prioridade, vínculo, período, atrasadas (R6.3), agrupamento e texto. ' +
      'As notas só aparecem com `tipo=NOTA` (R6.2).',
  })
  @ApiRespostaPaginada(AtividadeDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroAtividadesDto,
  ): Promise<Pagina<AtividadeDto>> {
    return this.atividades.listar(usuario, filtro);
  }

  @Get('agrupadas')
  @ApiOperation({
    summary:
      'Agenda: atrasadas, hoje, próximos 7 dias, mais tarde, sem data e concluídas',
    description:
      'Total e primeiras atividades de cada grupo, no fuso pedido (padrão America/Sao_Paulo). Os mesmos filtros da lista, menos status e período.',
  })
  @ApiOkResponse({ type: AtividadesAgrupadasDto })
  @ApiRespostasDeErro(400)
  agrupar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroAgrupadasDto,
  ): Promise<AtividadesAgrupadasDto> {
    return this.atividades.agrupar(usuario, filtro);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Mostra uma atividade' })
  @ApiOkResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<AtividadeDto> {
    return this.atividades.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera uma atividade',
    description:
      'Só os campos enviados mudam; `null` limpa os opcionais. Reagendar para o futuro ou trocar o responsável rearma os lembretes (R6.5).',
  })
  @ApiOkResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarAtividadeDto,
  ): Promise<AtividadeDto> {
    return this.atividades.atualizar(usuario, id, dto);
  }

  @Post(':id/concluir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conclui uma atividade pendente',
    description:
      'R6.2: grava quando e quem concluiu e publica `atividade.concluida`. Já concluída ou cancelada: 409. R6.6: a reunião exige `resultadoReuniao` (`COMPARECEU`, `NAO_COMPARECEU` ou `REMARCADA` com `novaData` futura, que cria a nova reunião pendente); nos outros tipos o campo é recusado (400).',
  })
  @ApiOkResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  concluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ConcluirAtividadeDto,
  ): Promise<AtividadeDto> {
    return this.atividades.concluir(usuario, id, dto);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela uma atividade pendente',
    description:
      'Já concluída ou cancelada: 409. A nota não muda de status (422).',
  })
  @ApiOkResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  cancelar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<AtividadeDto> {
    return this.atividades.cancelar(usuario, id);
  }

  @Post(':id/reabrir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reabre uma atividade concluída ou cancelada',
    description:
      'Volta para pendente e limpa a conclusão/cancelamento. Já pendente: 409. A nota não muda de status (422).',
  })
  @ApiOkResponse({ type: AtividadeDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  reabrir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<AtividadeDto> {
    return this.atividades.reabrir(usuario, id);
  }
}
