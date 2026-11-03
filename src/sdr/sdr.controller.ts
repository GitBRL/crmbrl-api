import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { ConfiguracaoSdrService } from './configuracao-sdr.service';
import { ConversasSdrService } from './conversas-sdr.service';
import {
  AtualizarArtigoSdrDto,
  AtualizarConfiguracaoSdrDto,
  AtualizarCriterioSdrDto,
  CriarArtigoSdrDto,
  CriarCriterioSdrDto,
  DefinirModoDoCanalSdrDto,
  AprovarSugestaoSdrDto,
  FiltroDecisoesSdrDto,
  ReordenarCriteriosSdrDto,
  TurnoDoSimuladorSdrDto,
} from './dto/sdr.dto';
import { OrcamentoSdrService } from './orcamento-sdr.service';
import { SimuladorSdrService } from './simulador-sdr.service';

/**
 * Configuração do SDR com IA (R31), só Admin: geral, canais, base de
 * conhecimento versionada, critérios de qualificação, uso e orçamento,
 * registro de decisões e o simulador.
 */
@ApiTags('SDR com IA — Configuração')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('sdr')
export class SdrConfiguracaoController {
  constructor(
    private readonly configuracao: ConfiguracaoSdrService,
    private readonly orcamento: OrcamentoSdrService,
    private readonly simulador: SimuladorSdrService,
    private readonly conversas: ConversasSdrService,
  ) {}

  @Get('configuracao')
  @ApiOperation({
    summary:
      'Configuração geral (persona, modelo, limites, faixas, regras de passagem), modelos aceitos e se a chave da IA existe',
  })
  geral() {
    return this.configuracao.geral();
  }

  @Put('configuracao')
  @ApiOperation({ summary: 'Altera a configuração geral (parcial; auditado)' })
  @ApiRespostasDeErro(400)
  atualizar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: AtualizarConfiguracaoSdrDto,
  ) {
    return this.configuracao.atualizar(u, dto);
  }

  @Get('canais')
  @ApiOperation({
    summary: 'Canais em que o SDR pode atuar, com o modo de cada um',
  })
  canais() {
    return this.configuracao.canais();
  }

  @Put('canais/:canalId')
  @ApiOperation({
    summary: 'Modo do SDR no canal: DESLIGADO, AUTOMATICO ou SUGESTAO',
  })
  @ApiRespostasDeErro(400, 404, 422)
  modo(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('canalId', ParseIdPipe) canalId: string,
    @Body() dto: DefinirModoDoCanalSdrDto,
  ) {
    return this.configuracao.definirModo(u, canalId, dto.modo);
  }

  // Base de conhecimento ------------------------------------------------------

  @Get('artigos')
  @ApiOperation({ summary: 'Artigos da base de conhecimento do SDR' })
  artigos() {
    return this.configuracao.artigos();
  }

  @Post('artigos')
  @ApiOperation({ summary: 'Cria um artigo (versão 1)' })
  @ApiRespostasDeErro(400, 422)
  criarArtigo(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: CriarArtigoSdrDto,
  ) {
    return this.configuracao.criarArtigo(u, dto);
  }

  @Put('artigos/:id')
  @ApiOperation({
    summary: 'Altera um artigo (cada mudança de conteúdo é uma versão nova)',
  })
  @ApiRespostasDeErro(400, 404)
  atualizarArtigo(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarArtigoSdrDto,
  ) {
    return this.configuracao.atualizarArtigo(u, id, dto);
  }

  @Delete('artigos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui um artigo (o histórico de versões fica)' })
  @ApiRespostasDeErro(404)
  async excluirArtigo(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.configuracao.excluirArtigo(u, id);
  }

  @Get('artigos/:id/versoes')
  @ApiOperation({ summary: 'Histórico de versões de um artigo' })
  @ApiRespostasDeErro(404)
  versoes(@Param('id', ParseIdPipe) id: string) {
    return this.configuracao.versoesDoArtigo(id);
  }

  @Post('artigos/:id/versoes/:numero/restaurar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Volta o artigo ao conteúdo de uma versão antiga (cria versão nova)',
  })
  @ApiRespostasDeErro(404)
  restaurar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.configuracao.restaurarVersao(u, id, numero);
  }

  // Critérios -----------------------------------------------------------------

  @Get('criterios')
  @ApiOperation({ summary: 'Critérios de qualificação' })
  criterios() {
    return this.configuracao.criterios();
  }

  @Post('criterios')
  @ApiOperation({ summary: 'Cria um critério' })
  @ApiRespostasDeErro(400, 409, 422)
  criarCriterio(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: CriarCriterioSdrDto,
  ) {
    return this.configuracao.criarCriterio(u, dto);
  }

  @Put('criterios/ordem')
  @ApiOperation({
    summary: 'Reordena os critérios (lista de ids na nova ordem)',
  })
  @ApiRespostasDeErro(400)
  reordenar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: ReordenarCriteriosSdrDto,
  ) {
    return this.configuracao.reordenarCriterios(u, dto.ids);
  }

  @Post('criterios/modelo-captacao')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aplica de novo o modelo de captação de alunos (acrescenta só o que falta, não sobrescreve)',
  })
  aplicarModelo(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.configuracao.aplicarModelo(u);
  }

  @Put('criterios/:id')
  @ApiOperation({ summary: 'Altera um critério (a chave não muda)' })
  @ApiRespostasDeErro(400, 404)
  atualizarCriterio(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCriterioSdrDto,
  ) {
    return this.configuracao.atualizarCriterio(u, id, dto);
  }

  @Delete('criterios/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui um critério' })
  @ApiRespostasDeErro(404)
  async excluirCriterio(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<void> {
    await this.configuracao.excluirCriterio(u, id);
  }

  @Get('campos-disponiveis')
  @ApiOperation({
    summary:
      'Campos onde um critério pode gravar: fixos do contato e os personalizados que já existem (contato e negócio)',
  })
  campos() {
    return this.configuracao.camposDisponiveis();
  }

  // Uso, decisões e simulador ----------------------------------------------------

  @Get('uso')
  @ApiOperation({ summary: 'Tokens do mês, orçamento e conversas atendidas' })
  uso() {
    return this.orcamento.uso();
  }

  @Get('decisoes')
  @ApiOperation({
    summary: 'Registro de decisões e de tokens (filtros: conversa e tipo)',
  })
  decisoes(@Query() filtro: FiltroDecisoesSdrDto) {
    return this.conversas.decisoes(filtro);
  }

  @Post('simulador/turno')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Um turno do simulador: a conversa até aqui → resposta da IA, critérios, nota, temperatura e ação (sem canal, nada é gravado no contato)',
  })
  @ApiRespostasDeErro(400, 422, 503)
  simular(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: TurnoDoSimuladorSdrDto,
  ) {
    return this.simulador.turno(u, dto);
  }
}

/**
 * O SDR nas telas do Atendimento, do contato e do negócio (R31). Qualquer
 * usuário autenticado; cada rota confere o que a pessoa pode ver (conversa:
 * regras do Atendimento R12; contato e negócio: as das próprias telas).
 */
@ApiTags('SDR com IA — Conversas')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 404)
@Controller('sdr')
export class SdrConversasController {
  constructor(private readonly conversas: ConversasSdrService) {}

  @Get('conversas/:id')
  @ApiOperation({
    summary:
      'Estado do SDR na conversa: situação, qualificação, sugestão pendente, linha do tempo das decisões e ações permitidas',
  })
  detalhe(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.detalhe(u, id);
  }

  @Post('conversas/:id/assumir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assumir: a pessoa fica com a conversa e a IA para',
  })
  @ApiRespostasDeErro(409, 422)
  assumir(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.assumir(u, id);
  }

  @Post('conversas/:id/devolver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Devolver para a IA: a IA retoma a conversa' })
  @ApiRespostasDeErro(409, 422)
  devolver(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.devolver(u, id);
  }

  @Post('sugestoes/:id/aprovar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aprova a sugestão (com `texto` editado, se quiser): envia ao lead como a pessoa e aplica o que a IA propôs',
  })
  @ApiRespostasDeErro(400, 409, 422)
  aprovar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AprovarSugestaoSdrDto,
  ) {
    return this.conversas.aprovar(u, id, dto);
  }

  @Post('sugestoes/:id/descartar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descarta a sugestão (nada é enviado)' })
  @ApiRespostasDeErro(409)
  descartar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.descartar(u, id);
  }

  @Get('contatos/:id/qualificacao')
  @ApiOperation({
    summary:
      'Cartão de qualificação do contato (a conversa do SDR mais recente dele); `qualificacao: null` se a IA nunca atendeu',
  })
  doContato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.qualificacaoDoContato(u, id);
  }

  @Get('negocios/:id/qualificacao')
  @ApiOperation({
    summary:
      'Cartão de qualificação do negócio (o da conversa que o gerou, senão o do contato)',
  })
  doNegocio(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.conversas.qualificacaoDoNegocio(u, id);
  }
}
