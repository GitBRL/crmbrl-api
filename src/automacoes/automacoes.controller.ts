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
  AtualizarAutomacaoDto,
  CriarAutomacaoDto,
  CriarDeModeloProntoDto,
  FiltroAutomacoesDto,
  FiltroExecucoesDto,
  PausarAutomacaoDto,
  TestarAutomacaoDto,
} from './automacoes.dto';
import {
  listarCanaisDeOpcao,
  listarFilasDeOpcao,
} from '../comum/dados/opcoes-de-canais';
import { SemPermissaoException } from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import { podeUsarAutomacoes } from './permissoes-automacoes';
import { AutomacoesService } from './automacoes.service';
import { ExecucoesDeAutomacao } from './execucoes-de-automacao.service';

/**
 * Automações e cadências (R19). Admin e C-level veem e gerenciam todas; líderes,
 * as da própria área; membros não usam (403). Rotas fixas (`catalogo`,
 * `modelos-prontos`, `execucoes`, `validar`) vêm antes de `:id`.
 */
@ApiTags('Automações')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('automacoes')
export class AutomacoesController {
  constructor(
    private readonly automacoes: AutomacoesService,
    private readonly execucoes: ExecucoesDeAutomacao,
    private readonly prisma: PrismaService,
  ) {}

  @Get('opcoes')
  @ApiOperation({
    summary: 'Canais e filas para escolher no editor de automações',
  })
  async opcoes(@UsuarioAtual() usuario: UsuarioAutenticado) {
    if (!podeUsarAutomacoes(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes usam as automações.',
      );
    }
    return {
      canais: await listarCanaisDeOpcao(this.prisma),
      filas: await listarFilasDeOpcao(this.prisma),
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Lista as automações com a contagem de execuções por status',
  })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroAutomacoesDto,
  ) {
    return this.automacoes.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria uma automação (sempre pausada; ative depois)',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarAutomacaoDto,
  ) {
    return this.automacoes.criar(usuario, dto);
  }

  @Get('catalogo')
  @ApiOperation({
    summary: 'Gatilhos, campos de data, tipos de passo e opções do editor',
  })
  catalogo(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.automacoes.catalogo(usuario);
  }

  @Get('modelos-prontos')
  @ApiOperation({
    summary: 'Modelos prontos (boas-vindas, follow-up, renovação, reativação)',
  })
  modelosProntos(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.automacoes.modelosProntos(usuario);
  }

  @Post('modelos-prontos/:chave')
  @ApiOperation({
    summary: 'Cria uma automação pausada a partir de um modelo pronto',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 404)
  criarDeModelo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('chave') chave: string,
    @Body() dto: CriarDeModeloProntoDto,
  ) {
    return this.automacoes.criarDeModelo(usuario, chave, dto);
  }

  @Post('validar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confere uma automação sem salvar: erros e pendências',
  })
  validar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarAutomacaoDto,
  ) {
    return this.automacoes.validar(usuario, dto);
  }

  @Get('execucoes')
  @ApiOperation({
    summary: 'Histórico de execuções, por automação e/ou por entidade',
    description:
      'Filtros: `automacaoId`, `entidade` + `entidadeId`, `contatoId`, `status`, `teste`.',
  })
  @ApiRespostasDeErro(400, 404)
  listarExecucoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroExecucoesDto,
  ) {
    return this.execucoes.listar(usuario, filtro);
  }

  @Get('execucoes/:execucaoId')
  @ApiOperation({ summary: 'Uma execução com o histórico por passo' })
  @ApiRespostasDeErro(404)
  detalharExecucao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('execucaoId', ParseIdPipe) id: string,
  ) {
    return this.execucoes.detalhar(usuario, id);
  }

  @Post('execucoes/:execucaoId/reexecutar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reexecuta o passo com erro de uma execução que falhou',
  })
  @ApiRespostasDeErro(404, 422)
  reexecutar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('execucaoId', ParseIdPipe) id: string,
  ) {
    return this.execucoes.reexecutar(usuario, id);
  }

  @Post('execucoes/:execucaoId/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela uma execução em andamento ou aguardando' })
  @ApiRespostasDeErro(404, 422)
  cancelar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('execucaoId', ParseIdPipe) id: string,
  ) {
    return this.execucoes.cancelar(usuario, id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Uma automação, com as pendências para ativar' })
  @ApiRespostasDeErro(404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automacoes.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edita a automação (nova versão quando gatilho, condições ou passos mudam)',
  })
  @ApiOkResponse()
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarAutomacaoDto,
  ) {
    return this.automacoes.atualizar(usuario, id, dto);
  }

  @Post(':id/ativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ativa a automação (422 com `detalhes.pendencias` se faltar algo)',
  })
  @ApiRespostasDeErro(404, 422)
  ativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automacoes.ativar(usuario, id);
  }

  @Post(':id/pausar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pausa a automação',
    description:
      'Não inicia novas execuções. As em andamento ficam suspensas (voltam ao reativar); `cancelarExecucoes` as cancela.',
  })
  @ApiRespostasDeErro(404)
  pausar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PausarAutomacaoDto,
  ) {
    return this.automacoes.pausar(usuario, id, dto);
  }

  @Post(':id/duplicar')
  @ApiOperation({ summary: 'Duplica a automação (a cópia nasce pausada)' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(404)
  duplicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automacoes.duplicar(usuario, id);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Modo teste: roda sobre uma entidade, sem efeitos externos',
    description:
      'Mensagens e ações são simuladas (a saída de cada passo mostra o que seria feito) e as esperas são puladas.',
  })
  @ApiRespostasDeErro(400, 404)
  testar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: TestarAutomacaoDto,
  ) {
    return this.execucoes.testar(usuario, id, dto.entidadeId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui a automação e cancela as execuções em andamento',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.automacoes.excluir(usuario, id);
  }
}
