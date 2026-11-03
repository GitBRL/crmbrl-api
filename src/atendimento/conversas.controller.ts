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
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { NegocioDto } from '../funis/dto/negocios.dto';
import { ConversasService } from './conversas.service';
import {
  AtendenteDto,
  AtribuicaoDto,
  AtualizarConversaDto,
  ConversaDetalheDto,
  CriarNegocioDaConversaDto,
  FiltroAtendentesDto,
  FiltroConversasDto,
  IniciarConversaDto,
  NaoLidasDoAtendimentoDto,
  PaginaConversasDto,
  ResolverConversaDto,
  TransferirConversaDto,
} from './dto/conversa.dto';
import {
  CriarNotaDto,
  EnviarMensagemDto,
  FiltroMensagensDto,
  MensagemDaConversaDto,
  PaginaMensagensDto,
} from './dto/mensagem.dto';
import { TemplatesDaConversaDto } from '../canais/templates-canal.dto';
import { MensagensService } from './mensagens.service';

/**
 * Caixa de entrada do Atendimento (R12). Marketing não usa (403); conversa
 * fora do recorte de visibilidade responde 404. As mudanças chegam também em
 * tempo real (`conversa.nova`, `conversa.atualizada`, `mensagem.nova`,
 * `mensagem.status`, `nao-lidas`).
 */
@ApiTags('Atendimento')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('atendimento')
export class ConversasController {
  constructor(
    private readonly conversas: ConversasService,
    private readonly mensagens: MensagensService,
  ) {}

  @Get('conversas')
  @ApiOperation({
    summary: 'Lista as conversas que a pessoa vê, com filtros e contadores',
    description:
      'Padrão: as em aberto (`ABERTA`, `PENDENTE`), da mais recente para a mais antiga. Visibilidade (R12): Admin e C-level todas; líder as das filas da área e as suas; membro as suas e as sem responsável das filas da área. `contadores` alimenta as pílulas (minhas, sem responsável, todas) e o número do menu.',
  })
  @ApiOkResponse({ type: PaginaConversasDto })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroConversasDto,
  ): Promise<PaginaConversasDto> {
    return this.conversas.listar(usuario, filtro);
  }

  @Post('conversas')
  @ApiOperation({
    summary: 'Começa uma conversa com um contato e envia a primeira mensagem',
    description:
      'Se o contato já tem conversa em aberto no canal (e você a vê), continua nela. A conversa nova fica com você, na fila padrão do canal. WhatsApp exige telefone; e-mail exige e-mail; o chat do site e a Meta (janela de 24 h) só respondem a quem escreveu antes (422).',
  })
  @ApiCreatedResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  iniciar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: IniciarConversaDto,
  ): Promise<ConversaDetalheDto> {
    return this.mensagens.iniciar(usuario, dto);
  }

  @Get('nao-lidas')
  @ApiOperation({
    summary: 'O número do menu do Atendimento',
    description:
      'O mesmo valor do evento `nao-lidas` (campo `atendimento`), para a primeira carga.',
  })
  @ApiOkResponse({ type: NaoLidasDoAtendimentoDto })
  naoLidas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<NaoLidasDoAtendimentoDto> {
    return this.conversas.naoLidas(usuario);
  }

  @Get('etiquetas')
  @ApiOperation({ summary: 'Etiquetas em uso nas conversas que a pessoa vê' })
  @ApiOkResponse({ type: [String] })
  etiquetas(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<string[]> {
    return this.conversas.etiquetas(usuario);
  }

  @Get('atendentes')
  @ApiOperation({
    summary: 'Pessoas que podem receber conversas (para transferir)',
    description:
      'Ativas, das áreas que atendem (e Admin/C-level), com as conversas em aberto de cada uma e se estão com o CRM aberto.',
  })
  @ApiOkResponse({ type: [AtendenteDto] })
  @ApiRespostasDeErro(400)
  atendentes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroAtendentesDto,
  ): Promise<AtendenteDto[]> {
    return this.conversas.atendentes(usuario, filtro);
  }

  @Get('conversas/:id')
  @ApiOperation({
    summary: 'Detalha uma conversa',
    description:
      'Com a satisfação, o negócio ligado, se o canal aceita resposta agora (`podeResponder`, ex.: janela de 24 h da Meta) e as ações que a pessoa pode fazer.',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.detalhar(usuario, id);
  }

  @Get('conversas/:id/templates')
  @ApiOperation({
    summary: 'Templates que dá para enviar na conversa (WhatsApp oficial)',
    description:
      'Só os aprovados, com cabeçalho, corpo, botões e as variáveis de cada um, mais a situação da janela de 24 h (`janelaAberta`, `janelaAte`, `aviso`). Canal sem templates: `suportado=false`. O envio é `POST …/mensagens` com `template`.',
  })
  @ApiOkResponse({ type: TemplatesDaConversaDto })
  @ApiRespostasDeErro(404)
  templates(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TemplatesDaConversaDto> {
    return this.conversas.templates(usuario, id);
  }

  @Patch('conversas/:id')
  @ApiOperation({
    summary:
      'Altera status (aberta/pendente), prioridade, assunto, etiquetas ou o negócio ligado',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarConversaDto,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.atualizar(usuario, id, dto);
  }

  @Post('conversas/:id/assumir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assume uma conversa sem responsável (R12)',
    description: '409 se alguém já assumiu.',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  assumir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.assumir(usuario, id);
  }

  @Post('conversas/:id/transferir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfere para uma pessoa e/ou outra fila, com nota (R12)',
    description:
      'Só para a fila: a conversa entra na distribuição dela. Para alguém de outra área, informe também uma fila dessa área. Fica no histórico, na conversa (aviso) e na auditoria; quem recebe é notificado.',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  transferir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: TransferirConversaDto,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.transferir(usuario, id, dto);
  }

  @Post('conversas/:id/resolver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a conversa (R12)',
    description:
      'Com a pesquisa de satisfação ligada no canal, o contato recebe a pergunta da nota de 1 a 5 (vale por 24 h; a resposta fica nesta conversa).',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 409)
  resolver(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ResolverConversaDto,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.resolver(usuario, id, dto);
  }

  @Post('conversas/:id/reabrir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reabre uma conversa resolvida (R12)',
    description:
      '409 se o contato já tem outra conversa em aberto no canal. Sem responsável ativo, fica com quem reabriu.',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404, 409)
  reabrir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.reabrir(usuario, id);
  }

  @Post('conversas/:id/lida')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marca as mensagens do contato como lidas',
    description:
      'Vale para o responsável (ou para quem vê, se a conversa está sem responsável): o líder que só olha não apaga o aviso de quem atende.',
  })
  @ApiOkResponse({ type: ConversaDetalheDto })
  @ApiRespostasDeErro(400, 404)
  marcarLida(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConversaDetalheDto> {
    return this.conversas.marcarLida(usuario, id);
  }

  @Post('conversas/:id/negocio')
  @ApiOperation({
    summary: 'Cria um negócio para o contato da conversa e o liga a ela',
    description:
      'Padrão: o funil-base da área da fila (ou da sua) e a primeira etapa aberta; origem = o canal. As regras são as dos negócios (R5).',
  })
  @ApiCreatedResponse({ type: NegocioDto })
  @ApiRespostasDeErro(400, 404, 422)
  criarNegocio(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CriarNegocioDaConversaDto,
  ): Promise<NegocioDto> {
    return this.conversas.criarNegocio(usuario, id, dto);
  }

  @Get('conversas/:id/atribuicoes')
  @ApiOperation({
    summary: 'Histórico de quem cuidou da conversa',
    description:
      'Distribuição, assumir, transferências (com nota), desligamento e reabertura.',
  })
  @ApiOkResponse({ type: [AtribuicaoDto] })
  @ApiRespostasDeErro(400, 404)
  atribuicoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<AtribuicaoDto[]> {
    return this.conversas.atribuicoes(usuario, id);
  }

  @Get('conversas/:id/mensagens')
  @ApiOperation({
    summary:
      'Mensagens da conversa (das mais novas para as mais antigas, por cursor)',
    description:
      'Cada página vem em ordem cronológica; `proximoCursor` traz as mais antigas. Inclui notas internas (`INTERNA`) e avisos (`SISTEMA`).',
  })
  @ApiOkResponse({ type: PaginaMensagensDto })
  @ApiRespostasDeErro(400, 404)
  listarMensagens(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroMensagensDto,
  ): Promise<PaginaMensagensDto> {
    return this.mensagens.listar(usuario, id, filtro);
  }

  @Post('conversas/:id/mensagens')
  @ApiOperation({
    summary: 'Envia uma mensagem ao contato',
    description:
      'Nasce `PENDENTE` e vai para a fila de envio do canal; o status muda por `mensagem.status`. Conversa sem responsável passa a ser de quem respondeu. 422 com a conversa resolvida ou o canal sem aceitar resposta (ex.: janela de 24 h da Meta, `detalhes.regra` R14).',
  })
  @ApiCreatedResponse({ type: MensagemDaConversaDto })
  @ApiRespostasDeErro(400, 404, 422, 503)
  enviar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: EnviarMensagemDto,
  ): Promise<MensagemDaConversaDto> {
    return this.mensagens.enviar(usuario, id, dto);
  }

  @Post('conversas/:id/notas')
  @ApiOperation({
    summary: 'Escreve uma nota interna (só a equipe vê; nunca vai ao contato)',
  })
  @ApiCreatedResponse({ type: MensagemDaConversaDto })
  @ApiRespostasDeErro(400, 404)
  criarNota(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CriarNotaDto,
  ): Promise<MensagemDaConversaDto> {
    return this.mensagens.criarNota(usuario, id, dto);
  }

  @Post('conversas/:id/mensagens/:mensagemId/reenviar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tenta de novo uma mensagem que falhou',
    description: '409 se a mensagem não está `FALHOU`.',
  })
  @ApiOkResponse({ type: MensagemDaConversaDto })
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  reenviar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('mensagemId', ParseIdPipe) mensagemId: string,
  ): Promise<MensagemDaConversaDto> {
    return this.mensagens.reenviar(usuario, id, mensagemId);
  }
}
