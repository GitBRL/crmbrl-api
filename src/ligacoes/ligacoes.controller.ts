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
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { exigirAtendimento } from '../atendimento/conversas.service';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { ConfiguracaoDeLigacoesService } from './configuracao-ligacoes.service';
import { HistoricoDeLigacoesService } from './historico-ligacoes.service';
import { LigacoesFeitasService } from './ligacoes-feitas.service';
import { LigacoesRecebidasService } from './ligacoes-recebidas.service';
import {
  AnotarLigacaoDto,
  AtenderLigacaoDto,
  AtualizarConfiguracaoLigacoesDto,
  CanalParaLigarDto,
  ConfiguracaoLigacoesDto,
  ConfiguracaoWebrtcDto,
  ConsultaDePermissaoDto,
  FiltroDeLigacoesDto,
  LigacaoDto,
  LigacoesDoUsuarioDto,
  LigarDto,
  ListaDeLigacoesDto,
  PedirPermissaoDto,
  PermissaoDeLigacaoDto,
} from './ligacoes.dto';
import { LigacoesService } from './ligacoes.service';
import { PermissoesDeLigacaoService } from './permissoes-de-ligacao.service';

/**
 * Ligações do WhatsApp (R29) para quem usa o Atendimento (R12): atender, ligar,
 * encerrar, anotar, pedir permissão e ver o histórico. O áudio vai direto entre
 * o navegador e a Meta; a API só sinaliza (SDP) e conta o que acontece.
 * Os eventos de tempo real `ligacao.*` estão em `src/tempo-real/catalogo.ts`.
 */
@ApiTags('Ligações')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('ligacoes')
export class LigacoesController {
  constructor(
    private readonly ligacoes: LigacoesService,
    private readonly historico: HistoricoDeLigacoesService,
    private readonly recebidas: LigacoesRecebidasService,
    private readonly feitas: LigacoesFeitasService,
    private readonly permissoes: PermissoesDeLigacaoService,
    private readonly config: ConfiguracaoDeLigacoesService,
  ) {}

  @Get('configuracao-webrtc')
  @ApiOperation({
    summary: 'Servidores STUN para o RTCPeerConnection do softphone',
    description:
      'Vazio por padrão (`LIGACOES_STUN_URLS`): o áudio vai direto entre o navegador e a Meta, sem TURN.',
  })
  @ApiOkResponse({ type: ConfiguracaoWebrtcDto })
  webrtc(@UsuarioAtual() usuario: UsuarioAutenticado): ConfiguracaoWebrtcDto {
    exigirAtendimento(usuario);
    return { stunUrls: [...this.ligacoes.stunUrls] };
  }

  @Get('canais')
  @ApiOperation({
    summary: 'Canais em que dá para ligar (ligações ativas e botão visível)',
  })
  @ApiOkResponse({ type: [CanalParaLigarDto] })
  canais(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalParaLigarDto[]> {
    exigirAtendimento(usuario);
    return this.config.canaisParaLigar();
  }

  @Get('ativas')
  @ApiOperation({
    summary: 'Ligação em curso do usuário e ligações que ainda tocam para ele',
    description:
      'Para o softphone retomar o estado ao carregar a página ou reconectar o socket.',
  })
  @ApiOkResponse({ type: LigacoesDoUsuarioDto })
  ativas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacoesDoUsuarioDto> {
    return this.ligacoes.doUsuario(usuario);
  }

  @Get('permissoes')
  @ApiOperation({
    summary:
      'Situação da permissão do cliente para ligar, com os limites de pedido',
    description:
      'Com `atualizar=true` consulta a Meta (`GET call_permissions`) antes de responder.',
  })
  @ApiOkResponse({ type: PermissaoDeLigacaoDto })
  @ApiRespostasDeErro(404, 422, 503)
  permissao(
    @Query() consulta: ConsultaDePermissaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<PermissaoDeLigacaoDto> {
    return this.permissoes.situacao(usuario, consulta);
  }

  @Post('permissoes/pedir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pede ao cliente permissão para ligar',
    description:
      'Mensagem interativa dentro da janela de 24 h; fora dela, o template aprovado com o componente de permissão. Respeita 1 pedido por 24 h e 2 por 7 dias por cliente (422 `limite_de_pedidos`).',
  })
  @ApiOkResponse({ type: PermissaoDeLigacaoDto })
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  pedir(
    @Body() dto: PedirPermissaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<PermissaoDeLigacaoDto> {
    return this.permissoes.pedir(usuario, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Histórico de ligações (do que o usuário vê)',
    description:
      'Filtros: `de`/`ate` (período), `direcao`, `situacao` (lista), `atendenteId` (ou `sem`), `filaId`, `canalId`, `contatoId`, `conversaId` e `busca` (full text no texto das transcrições; devolve `trechosEncontrados`). Só entram as ligações que o usuário vê (R12). Paginação por cursor, da mais recente para a mais antiga.',
  })
  @ApiOkResponse({ type: ListaDeLigacoesDto })
  listar(
    @Query() filtro: FiltroDeLigacoesDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ListaDeLigacoesDto> {
    return this.historico.listar(usuario, filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Liga para o cliente (oferta SDP do navegador)',
    description:
      'Confere a permissão e os limites na Meta, cria a ligação (CHAMANDO) e manda o `connect`. A resposta SDP chega pelo evento `ligacao.resposta_sdp`; os estados, por `ligacao.estado`.',
  })
  @ApiCreatedResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  ligar(
    @Body() dto: LigarDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.feitas.ligar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma ligação' })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(404)
  obter(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.ligacoes.obter(usuario, id);
  }

  @Post(':id/atender')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Atende a ligação recebida (resposta SDP do navegador)',
    description:
      'O primeiro POST leva a ligação; os outros recebem 409 `atendida_por_outro`. A API manda `pre_accept` e `accept` com o mesmo SDP.',
  })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 503)
  atender(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtenderLigacaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.recebidas.atender(usuario, id, dto);
  }

  @Post(':id/recusar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recusa a ligação recebida que toca para o usuário',
    description:
      'A ligação deixa de tocar só para quem recusou (`ligacao.deixou_de_tocar` com `recusada_por_voce`); os outros continuam ouvindo. Quando todos os chamados recusam, a API rejeita a ligação na Meta na hora e ela vira PERDIDA (`recusada_pelos_atendentes`, com `recusada_por_todos` para todos). Repetir a chamada não faz nada.',
  })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(403, 404, 409)
  recusar(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.recebidas.recusar(usuario, id);
  }

  @Post(':id/encerrar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Encerra (ou cancela) a ligação',
    description:
      'Sempre manda `terminate` à Meta. O webhook da Meta fecha com a duração e o motivo; o evento `ligacao.encerrada` avisa o softphone.',
  })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(403, 404, 409)
  encerrar(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.ligacoes.encerrar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Anotação rápida da ligação' })
  @ApiOkResponse({ type: LigacaoDto })
  @ApiRespostasDeErro(400, 403, 404)
  anotar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AnotarLigacaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<LigacaoDto> {
    return this.ligacoes.anotar(usuario, id, dto);
  }
}

/** Aba "Ligações" do canal de WhatsApp oficial: só quem configura canais (Admin). */
@ApiTags('Canais — WhatsApp oficial')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('whatsapp-oficial/canais/:canalId/ligacoes')
export class ConfiguracaoLigacoesController {
  constructor(private readonly config: ConfiguracaoDeLigacoesService) {}

  @Get()
  @ApiOperation({ summary: 'Configuração das ligações do canal' })
  @ApiOkResponse({ type: ConfiguracaoLigacoesDto })
  @ApiRespostasDeErro(404)
  obter(
    @Param('canalId', ParseIdPipe) canalId: string,
  ): Promise<ConfiguracaoLigacoesDto> {
    return this.config.obter(canalId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Altera a configuração das ligações do canal',
    description:
      '`ativa` liga ou desliga as chamadas no número (`POST /{phone_number_id}/settings` na Meta): se a Meta recusar, nada é gravado (422 com o motivo em português).',
  })
  @ApiOkResponse({ type: ConfiguracaoLigacoesDto })
  @ApiRespostasDeErro(400, 404, 422, 503)
  atualizar(
    @Param('canalId', ParseIdPipe) canalId: string,
    @Body() dto: AtualizarConfiguracaoLigacoesDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ConfiguracaoLigacoesDto> {
    return this.config.atualizar(canalId, dto, usuario.id);
  }
}
