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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { CampanhasService } from './campanhas.service';
import type { ConfiguracaoDisparos } from './configuracao-disparos';
import { ConfiguracaoDisparosService } from './configuracao-disparos.service';
import {
  AtualizarCampanhaDto,
  AtualizarConfiguracaoDisparosDto,
  CriarCampanhaDto,
  EnvioDeTesteDto,
  EstimativaDto,
  ExportarCampanhaDto,
  FiltroCampanhasDto,
  FiltroDestinatariosDto,
  FiltroRelatorioDto,
  IniciarCampanhaDto,
  PausarCampanhaDto,
  PreviaDaMensagemDto,
  PreviaDoPublicoDto,
  ReprovarCampanhaDto,
} from './disparos.dto';
import { PrismaService } from '../prisma/prisma.service';
import { listarCanaisDeOpcao } from '../comum/dados/opcoes-de-canais';
import { RelatorioDeCampanha } from './relatorio-de-campanha.service';

/**
 * Disparos — campanhas de WhatsApp e e-mail (R17). Admin, C-level, líderes e
 * membros de Marketing/Comercial/CS usam: membros só as próprias campanhas,
 * líderes as da área, Admin e C-level todas (fora do recorte: 404). O progresso
 * chega também em tempo real (`campanha.progresso`).
 */
@ApiTags('Disparos')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('disparos')
export class DisparosController {
  constructor(
    private readonly campanhas: CampanhasService,
    private readonly relatorio: RelatorioDeCampanha,
    private readonly configuracao: ConfiguracaoDisparosService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('canais')
  @ApiOperation({
    summary:
      'Números de WhatsApp e caixas de e-mail para escolher na campanha (sem dados sensíveis)',
  })
  canais() {
    return listarCanaisDeOpcao(this.prisma, ['WHATSAPP', 'EMAIL']);
  }

  @Get('campanhas')
  @ApiOperation({
    summary: 'Lista as campanhas que a pessoa vê, com contadores e progresso',
  })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroCampanhasDto,
  ) {
    return this.campanhas.listar(usuario, filtro);
  }

  @Post('campanhas')
  @ApiOperation({ summary: 'Cria uma campanha em rascunho' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 404)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarCampanhaDto,
  ) {
    return this.campanhas.criar(usuario, dto);
  }

  @Post('previa-publico')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Contagem e amostra do público (segmento ou importação), sem criar nada',
    description:
      'Opt-out já fora. `elegiveis` = com telefone (WhatsApp) ou e-mail (e-mail).',
  })
  @ApiRespostasDeErro(400, 404)
  previaDoPublico(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: PreviaDoPublicoDto,
  ) {
    return this.campanhas.previaDoPublico(usuario, dto);
  }

  @Post('estimativa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Estima a duração do envio para um total, números e ritmo',
    description:
      'Considera o intervalo (mínimo do número incluso), a pausa dos lotes, a janela de envio e o limite diário com aquecimento.',
  })
  @ApiRespostasDeErro(400)
  estimativa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: EstimativaDto,
  ) {
    return this.campanhas.estimativa(usuario, dto);
  }

  @Get('configuracao')
  @ApiOperation({
    summary:
      'Configuração dos disparos: aprovação do líder, palavras de saída, confirmação',
  })
  obterConfiguracao(): Promise<ConfiguracaoDisparos> {
    return this.configuracao.obter();
  }

  @Put('configuracao')
  @ApiOperation({ summary: 'Altera a configuração (Admin e C-level)' })
  @ApiRespostasDeErro(400)
  atualizarConfiguracao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: AtualizarConfiguracaoDisparosDto,
  ): Promise<ConfiguracaoDisparos> {
    return this.configuracao.atualizar(usuario, dto);
  }

  @Get('campanhas/:id')
  @ApiOperation({
    summary:
      'Detalhe da campanha: conteúdo, ritmo, canais, contadores e ações permitidas',
  })
  @ApiRespostasDeErro(404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.detalhar(usuario, id);
  }

  @Patch('campanhas/:id')
  @ApiOperation({
    summary: 'Edita a campanha',
    description:
      'Rascunho: tudo. Agendada, em andamento ou pausada: nome, descrição, ritmo, janela e números. Aguardando aprovação, concluída e cancelada: 422.',
  })
  @ApiRespostasDeErro(400, 404, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCampanhaDto,
  ) {
    return this.campanhas.atualizar(usuario, id, dto);
  }

  @Delete('campanhas/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui (rascunho, cancelada ou concluída)' })
  @ApiRespostasDeErro(404, 422)
  async excluir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.campanhas.excluir(usuario, id);
  }

  @Post('campanhas/:id/duplicar')
  @ApiOperation({
    summary: 'Copia a campanha como novo rascunho (sem destinatários)',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(404)
  duplicar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.duplicar(usuario, id);
  }

  @Get('campanhas/:id/revisao')
  @ApiOperation({
    summary:
      'Revisão antes de iniciar: público, prévia, estimativa de duração e problemas',
    description:
      '`problemas` com gravidade `erro` impedem o início (`podeIniciar = false`); `aviso` só informa.',
  })
  @ApiRespostasDeErro(404)
  revisar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.revisar(usuario, id);
  }

  @Post('campanhas/:id/previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Prévia da mensagem para um contato (variações sorteadas pela semente do contato)',
  })
  @ApiRespostasDeErro(400, 404)
  previa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PreviaDaMensagemDto,
  ) {
    return this.campanhas.previaDaMensagem(usuario, id, dto);
  }

  @Post('campanhas/:id/teste')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envia a mensagem uma vez para o próprio número (ou o informado)',
    description:
      'Cria/usa um contato de teste (etiqueta `teste-de-campanha`) e envia pelo primeiro canal disponível, sem entrar nos contadores.',
  })
  @ApiRespostasDeErro(400, 404, 422)
  teste(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: EnvioDeTesteDto,
  ) {
    return this.campanhas.enviarTeste(usuario, id, dto);
  }

  @Post('campanhas/:id/iniciar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inicia (ou agenda) a campanha',
    description:
      'Rascunho → em andamento ou agendada. Com aprovação do líder ligada, o membro vai para `AGUARDANDO_APROVACAO`. 422 se a revisão tem erros.',
  })
  @ApiRespostasDeErro(400, 404, 422)
  iniciar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: IniciarCampanhaDto,
  ) {
    return this.campanhas.iniciar(usuario, id, dto);
  }

  @Post('campanhas/:id/aprovar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Líder da área, C-level ou Admin aprovam: a campanha começa (ou fica agendada)',
  })
  @ApiRespostasDeErro(403, 404, 422)
  aprovar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.aprovar(usuario, id);
  }

  @Post('campanhas/:id/reprovar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reprova com motivo: volta a rascunho e o criador é avisado',
  })
  @ApiRespostasDeErro(400, 403, 404, 422)
  reprovar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ReprovarCampanhaDto,
  ) {
    return this.campanhas.reprovar(usuario, id, dto.motivo);
  }

  @Post('campanhas/:id/pausar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pausa a campanha em andamento' })
  @ApiRespostasDeErro(404, 422)
  pausar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PausarCampanhaDto,
  ) {
    return this.campanhas.pausar(usuario, id, dto.motivo);
  }

  @Post('campanhas/:id/retomar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Retoma a campanha pausada (inclusive as pausadas automaticamente)',
  })
  @ApiRespostasDeErro(404, 422)
  retomar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.retomar(usuario, id);
  }

  @Post('campanhas/:id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela; o que não saiu fica como excluído' })
  @ApiRespostasDeErro(404, 422)
  cancelar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.cancelar(usuario, id);
  }

  @Post('campanhas/:id/reenviar-falhas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Devolve os destinatários com falha para a fila e reabre a campanha',
  })
  @ApiRespostasDeErro(404, 422)
  reenviarFalhas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.campanhas.reenviarFalhas(usuario, id);
  }

  @Get('campanhas/:id/destinatarios')
  @ApiOperation({
    summary:
      'Destinatários com situação, motivo e datas (enviado, entregue, lido, respondeu, opt-out)',
  })
  @ApiRespostasDeErro(400, 404)
  destinatarios(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroDestinatariosDto,
  ) {
    return this.campanhas.destinatarios(usuario, id, filtro);
  }

  @Get('campanhas/:id/relatorio')
  @ApiOperation({
    summary:
      'Relatório: contadores, taxas, por número, ao longo do tempo e motivos de falha',
  })
  @ApiRespostasDeErro(404)
  gerarRelatorio(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroRelatorioDto,
  ) {
    return this.relatorio.gerar(usuario, id, filtro.agrupar);
  }

  @Post('campanhas/:id/exportar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta o relatório (XLSX ou CSV com `;`)',
    description: 'Devolve o arquivo salvo (`url` para baixar com a sessão).',
  })
  @ApiOkResponse({ type: ArquivoDto })
  @ApiRespostasDeErro(404)
  exportar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ExportarCampanhaDto,
  ): Promise<ArquivoDto> {
    return this.relatorio.exportar(usuario, id, dto.formato);
  }
}
