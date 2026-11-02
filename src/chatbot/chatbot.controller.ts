import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { CATALOGO_DE_PASSOS } from './catalogo-de-passos';
import {
  AtualizarFluxoChatbotDto,
  CriarFluxoChatbotDto,
  FiltroExecucoesChatbotDto,
  FiltroFluxosChatbotDto,
  IniciarSimulacaoChatbotDto,
  MensagemDaSimulacaoChatbotDto,
  PublicarFluxoChatbotDto,
  SalvarRascunhoChatbotDto,
} from './chatbot.dto';
import { FluxosChatbotService } from './fluxos.service';
import { podeUsarChatbot } from './permissoes-chatbot';
import { SimuladorDoChatbot } from './simulador.service';
import {
  listarCanaisDeOpcao,
  listarFilasDeOpcao,
} from '../comum/dados/opcoes-de-canais';
import { PrismaService } from '../prisma/prisma.service';
import { SemPermissaoException } from '../comum/erros/excecoes';

/**
 * Chatbot — fluxos em passos (R18). Admin e C-level gerenciam todos os fluxos;
 * o líder, os da própria área (vê também os de todas as áreas); membros: 403.
 * Editar grava o **rascunho**; `publicar` cria a próxima versão imutável (as
 * conversas em andamento seguem na versão com que começaram).
 */
@ApiTags('Chatbot')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('chatbot')
export class ChatbotController {
  constructor(
    private readonly fluxos: FluxosChatbotService,
    private readonly simulador: SimuladorDoChatbot,
    private readonly prisma: PrismaService,
  ) {}

  @Get('opcoes')
  @ApiOperation({
    summary: 'Canais e filas para escolher no editor de fluxos',
  })
  async opcoes(@UsuarioAtual() usuario: UsuarioAutenticado) {
    if (!podeUsarChatbot(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes configuram o chatbot.',
      );
    }
    return {
      canais: await listarCanaisDeOpcao(this.prisma),
      filas: await listarFilasDeOpcao(this.prisma),
    };
  }

  @Get('passos')
  @ApiOperation({
    summary: 'Tipos de passo do chatbot (rótulo, ramos, exemplo de config)',
  })
  passos(@UsuarioAtual() usuario: UsuarioAutenticado) {
    if (!podeUsarChatbot(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes configuram o chatbot.',
      );
    }
    return CATALOGO_DE_PASSOS;
  }

  @Get('fluxos')
  @ApiOperation({
    summary:
      'Lista os fluxos com versão publicada, contadores e se podem ser editados',
  })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroFluxosChatbotDto,
  ) {
    return this.fluxos.listar(usuario, filtro);
  }

  @Post('fluxos')
  @ApiOperation({ summary: 'Cria um fluxo (rascunho, inativo)' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarFluxoChatbotDto,
  ) {
    return this.fluxos.criar(usuario, dto);
  }

  @Get('fluxos/:id')
  @ApiOperation({
    summary: 'Detalhe do fluxo: rascunho, definição publicada e contadores',
  })
  @ApiRespostasDeErro(404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.detalhar(usuario, id);
  }

  @Patch('fluxos/:id')
  @ApiOperation({
    summary: 'Altera nome, canais, gatilho, palavras-chave e prioridade',
  })
  @ApiRespostasDeErro(400, 404)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarFluxoChatbotDto,
  ) {
    return this.fluxos.atualizar(usuario, id, dto);
  }

  @Put('fluxos/:id/rascunho')
  @ApiOperation({
    summary:
      'Salva o rascunho (estrutura conferida; a configuração só na publicação)',
  })
  @ApiRespostasDeErro(400, 404)
  salvarRascunho(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: SalvarRascunhoChatbotDto,
  ) {
    return this.fluxos.salvarRascunho(usuario, id, dto.definicao);
  }

  @Post('fluxos/:id/validar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confere o rascunho como na publicação: `{ valido, problemas[{caminho, mensagem, passoId}] }`',
  })
  @ApiRespostasDeErro(404)
  validar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.validar(usuario, id);
  }

  @Post('fluxos/:id/publicar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Publica o rascunho como a próxima versão (imutável); `ativar` também liga o fluxo',
  })
  @ApiRespostasDeErro(400, 404)
  publicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PublicarFluxoChatbotDto,
  ) {
    return this.fluxos.publicar(usuario, id, dto.ativar);
  }

  @Post('fluxos/:id/ativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ativa o fluxo (exige versão publicada)' })
  @ApiRespostasDeErro(404, 422)
  ativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.ativar(usuario, id);
  }

  @Post('fluxos/:id/desativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desativa: não atende conversas novas; as em andamento terminam',
  })
  @ApiRespostasDeErro(404)
  desativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.desativar(usuario, id);
  }

  @Post('fluxos/:id/duplicar')
  @ApiOperation({ summary: 'Cria uma cópia inativa (só o rascunho)' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(404)
  duplicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.duplicar(usuario, id);
  }

  @Delete('fluxos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o fluxo e cancela as execuções em andamento',
  })
  @ApiRespostasDeErro(404)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.fluxos.excluir(usuario, id);
  }

  @Get('fluxos/:id/versoes')
  @ApiOperation({
    summary: 'Versões publicadas (da mais nova), com a que está em uso',
  })
  @ApiRespostasDeErro(404)
  versoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.fluxos.versoes(usuario, id);
  }

  @Get('fluxos/:id/versoes/:numero')
  @ApiOperation({ summary: 'Uma versão publicada, com a definição' })
  @ApiRespostasDeErro(404)
  versao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.fluxos.versao(usuario, id, numero);
  }

  @Post('fluxos/:id/versoes/:numero/restaurar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Copia a versão para o rascunho (não publica)' })
  @ApiRespostasDeErro(404)
  restaurar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.fluxos.restaurar(usuario, id, numero);
  }

  @Get('fluxos/:id/execucoes')
  @ApiOperation({
    summary:
      'Execuções reais do fluxo (uma por conversa), com status e motivo do fim',
  })
  @ApiRespostasDeErro(404)
  execucoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroExecucoesChatbotDto,
  ) {
    return this.fluxos.execucoes(usuario, id, filtro);
  }

  @Get('fluxos/:id/execucoes/:execucaoId')
  @ApiOperation({ summary: 'Histórico passo a passo de uma execução' })
  @ApiRespostasDeErro(404)
  execucao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('execucaoId', ParseIdPipe) execucaoId: string,
  ) {
    return this.fluxos.execucao(usuario, id, execucaoId);
  }

  // -------------------------------------------------------------------------
  // Simulador
  // -------------------------------------------------------------------------

  @Post('fluxos/:id/simulador')
  @ApiOperation({
    summary:
      'Começa uma conversa de teste (rascunho ou publicada), sem efeitos reais',
    description:
      'Devolve o estado: `transcricao[{de: bot|contato|sistema, texto, opcoes?}]`, `aguardando` (opcoes|texto) e `status`.',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 404, 422)
  iniciarSimulacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: IniciarSimulacaoChatbotDto,
  ) {
    return this.simulador.iniciar(usuario, id, dto);
  }

  @Get('fluxos/:id/simulador/:execucaoId')
  @ApiOperation({ summary: 'Estado da simulação' })
  @ApiOkResponse()
  @ApiRespostasDeErro(404)
  estadoDaSimulacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('execucaoId', ParseIdPipe) execucaoId: string,
  ) {
    return this.simulador.estado(usuario, id, execucaoId);
  }

  @Post('fluxos/:id/simulador/:execucaoId/mensagens')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A pessoa responde ao bot na simulação' })
  @ApiRespostasDeErro(400, 404, 409)
  responderNaSimulacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('execucaoId', ParseIdPipe) execucaoId: string,
    @Body() dto: MensagemDaSimulacaoChatbotDto,
  ) {
    return this.simulador.responder(usuario, id, execucaoId, dto.texto);
  }

  @Post('fluxos/:id/simulador/:execucaoId/silencio')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deixa o tempo passar na simulação (lembrete ou "sem resposta")',
  })
  @ApiRespostasDeErro(404, 409)
  silencioNaSimulacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('execucaoId', ParseIdPipe) execucaoId: string,
  ) {
    return this.simulador.silencio(usuario, id, execucaoId);
  }

  @Delete('fluxos/:id/simulador/:execucaoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Encerra a simulação' })
  @ApiRespostasDeErro(404)
  async encerrarSimulacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('execucaoId', ParseIdPipe) execucaoId: string,
  ): Promise<void> {
    await this.simulador.encerrar(usuario, id, execucaoId);
  }
}
