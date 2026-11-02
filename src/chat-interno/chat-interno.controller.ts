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
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { CanaisChatService } from './canais-chat.service';
import {
  AdicionarMembrosChatDto,
  AtualizarCanalChatDto,
  AtualizarMembroChatDto,
  BuscaMensagensChatDto,
  CriarGrupoChatDto,
  EditarMensagemChatDto,
  EnviarMensagemChatDto,
  FiltroCanaisChatDto,
  FiltroMensagensChatDto,
  FiltroPessoasChatDto,
  IniciarDiretaChatDto,
  MarcarLeituraChatDto,
  PreferenciasDoCanalChatDto,
} from './dto/requisicoes.dto';
import {
  ChatCanalDto,
  ChatMembroDto,
  ChatMensagemDto,
  ChatNaoLidasDto,
  ChatPessoaDto,
  PaginaChatMensagensDto,
  ResultadoBuscaChatDto,
  ResultadoDiretaChatDto,
} from './dto/respostas.dto';
import { MensagensChatService } from './mensagens-chat.service';

/**
 * Chat interno da equipe (§2.6, R15). Todo usuário logado usa; cada um só
 * enxerga os canais de que é membro (os outros respondem 404 — inclusive para
 * o Admin: as conversas diretas são privadas).
 *
 * Tempo real (namespace `/tempo-real`): `chat.mensagem` na sala
 * `chat:<canalId>` (entre com `chat.entrar`), `chat.atualizado` e
 * `nao-lidas.chat` na sala do usuário, `digitando` com `{ canalId }`.
 */
@ApiTags('Chat interno')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('chat')
export class ChatInternoController {
  constructor(
    private readonly canais: CanaisChatService,
    private readonly mensagens: MensagensChatService,
  ) {}

  // -------------------------------------------------------------------------
  // Canais
  // -------------------------------------------------------------------------

  @Get('canais')
  @ApiOperation({
    summary: 'Lista os canais da pessoa',
    description:
      'Geral, os canais das áreas (membros automáticos pelo papel), os grupos e as conversas diretas de que a pessoa é membro, com não lidas, menções não lidas e a prévia da última mensagem. Ordem: Geral, áreas, depois grupos e diretas do mais recente ao mais antigo.',
  })
  @ApiOkResponse({ type: [ChatCanalDto] })
  @ApiRespostasDeErro(400)
  listarCanais(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroCanaisChatDto,
  ): Promise<ChatCanalDto[]> {
    return this.canais.listar(usuario, filtro);
  }

  @Get('canais/:id')
  @ApiOperation({ summary: 'Um canal do ponto de vista da pessoa' })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 404)
  obterCanal(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChatCanalDto> {
    return this.canais.obter(usuario, id);
  }

  @Patch('canais/:id')
  @ApiOperation({
    summary: 'Renomeia o grupo ou muda a descrição',
    description:
      'Só quem administra o grupo. O Geral, as áreas e as diretas não mudam (422).',
  })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  atualizarCanal(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCanalChatDto,
  ): Promise<ChatCanalDto> {
    return this.canais.atualizar(usuario, id, dto);
  }

  @Post('canais/:id/arquivar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Arquiva o grupo (as mensagens ficam só para leitura)',
  })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  arquivar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChatCanalDto> {
    return this.canais.arquivar(usuario, id, true);
  }

  @Post('canais/:id/desarquivar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desarquiva o grupo' })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  desarquivar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChatCanalDto> {
    return this.canais.arquivar(usuario, id, false);
  }

  @Post('canais/:id/sair')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sai do grupo',
    description:
      'Só grupos (do Geral, das áreas e das diretas não se sai: silencie). Sem administrador, o membro mais antigo assume; vazio, o grupo é arquivado.',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 404, 422)
  sair(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.canais.sair(usuario, id);
  }

  @Put('canais/:id/preferencias')
  @ApiOperation({
    summary: 'Silencia (ou não) o canal para a pessoa',
    description:
      'Silenciado, o canal não conta no menu; as menções continuam contando e notificando.',
  })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 404)
  definirPreferencias(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PreferenciasDoCanalChatDto,
  ): Promise<ChatCanalDto> {
    return this.canais.definirPreferencias(usuario, id, dto);
  }

  @Post('canais/:id/leitura')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marca o canal como lido (até uma mensagem ou até agora)',
    description:
      'Nunca volta atrás. Atualiza as não lidas nas outras abas da pessoa (`chat.atualizado` e `nao-lidas`).',
  })
  @ApiOkResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 404)
  marcarLeitura(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: MarcarLeituraChatDto,
  ): Promise<ChatCanalDto> {
    return this.canais.marcarLeitura(usuario, id, dto);
  }

  // -------------------------------------------------------------------------
  // Membros
  // -------------------------------------------------------------------------

  @Get('canais/:id/membros')
  @ApiOperation({
    summary: 'Pessoas do canal (para a lista de membros e as menções)',
  })
  @ApiOkResponse({ type: [ChatMembroDto] })
  @ApiRespostasDeErro(400, 404)
  membros(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChatMembroDto[]> {
    return this.canais.membros(usuario, id);
  }

  @Post('canais/:id/membros')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Adiciona pessoas ao grupo',
    description:
      'Só quem administra o grupo; só pessoas ativas (409 lista quem não está); até 200 pessoas (422).',
  })
  @ApiOkResponse({ type: [ChatMembroDto] })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  adicionarMembros(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AdicionarMembrosChatDto,
  ): Promise<ChatMembroDto[]> {
    return this.canais.adicionarMembros(usuario, id, dto);
  }

  @Patch('canais/:id/membros/:usuarioId')
  @ApiOperation({
    summary: 'Dá ou tira a administração do grupo',
    description: 'O grupo precisa ter sempre alguém administrando (422).',
  })
  @ApiOkResponse({ type: ChatMembroDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  alterarMembro(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
    @Body() dto: AtualizarMembroChatDto,
  ): Promise<ChatMembroDto> {
    return this.canais.alterarMembro(usuario, id, usuarioId, dto);
  }

  @Delete('canais/:id/membros/:usuarioId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Tira uma pessoa do grupo' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 403, 404, 422)
  removerMembro(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('usuarioId', ParseIdPipe) usuarioId: string,
  ): Promise<void> {
    return this.canais.removerMembro(usuario, id, usuarioId);
  }

  // -------------------------------------------------------------------------
  // Grupos e diretas
  // -------------------------------------------------------------------------

  @Post('grupos')
  @ApiOperation({
    summary: 'Cria um grupo',
    description:
      'Qualquer pessoa cria; quem cria entra como administrador. As pessoas escolhidas precisam estar ativas.',
  })
  @ApiCreatedResponse({ type: ChatCanalDto })
  @ApiRespostasDeErro(400, 409)
  criarGrupo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarGrupoChatDto,
  ): Promise<ChatCanalDto> {
    return this.canais.criarGrupo(usuario, dto);
  }

  @Post('diretas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Abre a conversa direta com uma pessoa (cria se ainda não existe)',
    description:
      'Uma conversa por par de pessoas, privada (só as duas leem). `criada: false` quando já existia.',
  })
  @ApiOkResponse({ type: ResultadoDiretaChatDto })
  @ApiRespostasDeErro(400, 404, 422)
  iniciarDireta(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: IniciarDiretaChatDto,
  ): Promise<ResultadoDiretaChatDto> {
    return this.canais.iniciarDireta(usuario, dto);
  }

  // -------------------------------------------------------------------------
  // Mensagens
  // -------------------------------------------------------------------------

  @Get('canais/:id/mensagens')
  @ApiOperation({
    summary: 'Mensagens do canal (da mais antiga para a mais nova)',
    description:
      'Sem cursor, as últimas. `antesDe` rola para cima, `depoisDe` busca o que chegou depois (ao reconectar) e `aoRedorDe` abre uma mensagem no meio (menção, busca). Excluídas aparecem como "Mensagem excluída".',
  })
  @ApiOkResponse({ type: PaginaChatMensagensDto })
  @ApiRespostasDeErro(400, 404)
  listarMensagens(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroMensagensChatDto,
  ): Promise<PaginaChatMensagensDto> {
    return this.mensagens.listar(usuario, id, filtro);
  }

  @Post('canais/:id/mensagens')
  @ApiOperation({
    summary: 'Envia uma mensagem',
    description:
      'Texto (com menções `<@usuarioId>` e referências `<negocio:id>`, `<contato:id>`, `<empresa:id>`) e/ou um anexo enviado antes em `POST /api/v1/arquivos?contexto=CHAT`. Menções notificam quem foi mencionado. Grupo arquivado e direta com pessoa desligada não aceitam mensagens (422).',
  })
  @ApiCreatedResponse({ type: ChatMensagemDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  enviar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: EnviarMensagemChatDto,
  ): Promise<ChatMensagemDto> {
    return this.mensagens.enviar(usuario, id, dto);
  }

  @Get('mensagens/busca')
  @ApiOperation({
    summary: 'Busca nas mensagens dos canais da pessoa',
    description:
      'Sem diferenciar acentos nem maiúsculas; cada termo precisa aparecer. Mais novas primeiro. Não busca nas excluídas nem dentro das marcações.',
  })
  @ApiRespostaPaginada(ResultadoBuscaChatDto)
  @ApiRespostasDeErro(400)
  buscar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: BuscaMensagensChatDto,
  ): Promise<Pagina<ResultadoBuscaChatDto>> {
    return this.mensagens.buscar(usuario, filtro);
  }

  @Patch('mensagens/:id')
  @ApiOperation({
    summary: 'Edita a própria mensagem',
    description:
      'Só quem escreveu (403). Menções novas notificam. Excluída, de grupo arquivado ou de direta com pessoa desligada: 422.',
  })
  @ApiOkResponse({ type: ChatMensagemDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  editar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: EditarMensagemChatDto,
  ): Promise<ChatMensagemDto> {
    return this.mensagens.editar(usuario, id, dto);
  }

  @Delete('mensagens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui a própria mensagem',
    description:
      'Só quem escreveu (403). O texto e o anexo somem para todos; fica o aviso "Mensagem excluída".',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 403, 404)
  excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    return this.mensagens.excluir(usuario, id);
  }

  // -------------------------------------------------------------------------
  // Menu e diretório
  // -------------------------------------------------------------------------

  @Get('nao-lidas')
  @ApiOperation({
    summary: 'Não lidas do chat (número do menu e por canal)',
    description:
      'O mesmo `chat` do evento `nao-lidas` — busque ao abrir o CRM e ao reconectar o tempo real.',
  })
  @ApiOkResponse({ type: ChatNaoLidasDto })
  naoLidas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ChatNaoLidasDto> {
    return this.canais.naoLidas(usuario);
  }

  @Get('pessoas')
  @ApiOperation({
    summary: 'Pessoas ativas do CRM (para criar grupo e iniciar direta)',
  })
  @ApiRespostaPaginada(ChatPessoaDto)
  @ApiRespostasDeErro(400)
  pessoas(
    @Query() filtro: FiltroPessoasChatDto,
  ): Promise<Pagina<ChatPessoaDto>> {
    return this.canais.pessoas(filtro);
  }
}
