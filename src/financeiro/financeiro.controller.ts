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
import { Prisma } from '../generated/prisma/client';
import { ModelosService } from '../comum/modelos/modelos.service';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { SemPermissaoException } from '../comum/erros/excecoes';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { ContratosService } from './contratos.service';
import { VARIAVEIS_DO_TITULO } from './financeiro.constantes';
import {
  AtualizarConfiguracaoReguaDto,
  AtualizarContratoDto,
  AtualizarParcelaDto,
  BaixaDto,
  CancelarContratoDto,
  CriarContratoDto,
  CriarParcelaDto,
  ExportarParcelasDto,
  FiltroContratosDto,
  FiltroEnviosDto,
  FiltroLigacoesDto,
  FiltroParcelasDto,
  FiltroPeriodoDto,
  FiltroRiscoDto,
  GerarParcelasDto,
  PreviaDaEtapaDto,
  ReenviarDto,
  RenegociarParcelaDto,
  ResultadoLigacaoDto,
  SalvarEtapaDto,
} from './financeiro.dto';
import { IndicadoresFinanceirosService } from './indicadores.service';
import { ParcelasService } from './parcelas.service';
import { ReguaConfiguracaoService } from './regua-configuracao.service';
import { ReguaConsultaService } from './regua-consulta.service';
import { ReguaLigacoesService } from './regua-ligacoes.service';
import { ReguaService } from './regua.service';
import { RiscoDeChurnService } from './risco-de-churn.service';
import { variaveisDoTitulo } from './regua-envio.service';
import { podeAtuarNoFinanceiro } from './permissoes-financeiro';

/**
 * Financeiro (Onda C, §2.3). Admin, C-level e Líder de CS gerenciam tudo; membros
 * de CS veem e atuam na própria carteira; o Comercial só consulta os contratos
 * dos negócios que ganhou (R22.1); Marketing não acessa (403). Fora do recorte
 * visível o recurso responde 404.
 */
@ApiTags('Financeiro')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('financeiro')
export class FinanceiroController {
  constructor(
    private readonly contratos: ContratosService,
    private readonly parcelas: ParcelasService,
    private readonly indicadores: IndicadoresFinanceirosService,
    private readonly risco: RiscoDeChurnService,
    private readonly configuracao: ReguaConfiguracaoService,
    private readonly regua: ReguaService,
    private readonly consulta: ReguaConsultaService,
    private readonly ligacoes: ReguaLigacoesService,
    private readonly modelos: ModelosService,
  ) {}

  // ---- contratos ------------------------------------------------------------

  @Get('contratos')
  @ApiOperation({
    summary: 'Lista os contratos visíveis, com filtros e paginação (R22.2)',
  })
  @ApiRespostasDeErro(400)
  listarContratos(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroContratosDto,
  ) {
    return this.contratos.listar(u, f);
  }

  @Post('contratos')
  @ApiOperation({
    summary: 'Cria um contrato (e gera as parcelas)',
    description:
      'Com `negocioId` (negócio ganho), completa cliente. MRR e movimento “novo” são gravados.',
  })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 404, 422)
  criarContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: CriarContratoDto,
  ) {
    return this.contratos.criar(u, dto);
  }

  @Get('contratos/:id')
  @ApiOperation({ summary: 'Detalhe do contrato, com o resumo das parcelas' })
  @ApiRespostasDeErro(404)
  detalharContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.contratos.detalhar(u, id);
  }

  @Patch('contratos/:id')
  @ApiOperation({
    summary:
      'Altera o contrato (valor e periodicidade geram expansão ou contração do MRR)',
  })
  @ApiRespostasDeErro(400, 404, 422)
  atualizarContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarContratoDto,
  ) {
    return this.contratos.atualizar(u, id, dto);
  }

  @Post('contratos/:id/suspender')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspende o contrato (continua no MRR)' })
  @ApiRespostasDeErro(404, 422)
  suspenderContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.contratos.suspender(u, id);
  }

  @Post('contratos/:id/reativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reativa um contrato suspenso (cancelado ou encerrado: só a gestão)',
  })
  @ApiRespostasDeErro(404, 409)
  reativarContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.contratos.reativar(u, id);
  }

  @Post('contratos/:id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela o contrato com o motivo (churn no MRR)' })
  @ApiRespostasDeErro(400, 404, 409)
  cancelarContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CancelarContratoDto,
  ) {
    return this.contratos.cancelar(u, id, dto);
  }

  @Post('contratos/:id/parcelas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Gera mais parcelas, continuando depois da última' })
  @ApiRespostasDeErro(400, 404, 422)
  gerarParcelas(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: GerarParcelasDto,
  ) {
    return this.contratos.gerarMaisParcelas(u, id, dto.quantidade);
  }

  @Get('negocios/sem-contrato')
  @ApiOperation({
    summary: 'Negócios ganhos ainda sem contrato (sugestão ao ganhar, R22.6)',
  })
  negociosSemContrato(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.contratos.negociosSemContrato(u);
  }

  @Get('negocios/:id/sugestao-de-contrato')
  @ApiOperation({
    summary: 'Dados para pré-preencher o contrato de um negócio ganho',
  })
  @ApiRespostasDeErro(404)
  sugestaoDeContrato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.contratos.sugestaoDoNegocio(u, id);
  }

  // ---- parcelas ---------------------------------------------------------------

  @Get('parcelas')
  @ApiOperation({
    summary:
      'Parcelas a receber, com filtros (status, contrato, cliente, vencimento, faixa de atraso, busca)',
    description:
      '`status=ATRASADO` inclui as abertas já vencidas; `status` aceita vários separados por vírgula.',
  })
  @ApiRespostasDeErro(400)
  listarParcelas(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroParcelasDto,
  ) {
    return this.parcelas.listar(u, f);
  }

  @Get('parcelas/totais')
  @ApiOperation({
    summary:
      'Quantidade e valor por status, com os mesmos filtros (sem `status`)',
  })
  totaisDeParcelas(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroParcelasDto,
  ) {
    return this.parcelas.totais(u, f);
  }

  @Post('parcelas/exportar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exporta a situação dos títulos visíveis (XLSX ou CSV com `;`)',
    description:
      'Os filtros da lista vão na query; devolve o arquivo salvo (`url` para baixar com a sessão).',
  })
  @ApiOkResponse({ type: ArquivoDto })
  exportarParcelas(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: ExportarParcelasDto,
  ): Promise<ArquivoDto> {
    const { formato, ...filtro } = f;
    return this.parcelas.exportar(u, filtro as FiltroParcelasDto, formato);
  }

  @Post('parcelas')
  @ApiOperation({ summary: 'Cria um título (parcela) manualmente' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 404, 409)
  criarParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: CriarParcelaDto,
  ) {
    return this.parcelas.criar(u, dto);
  }

  @Get('parcelas/:id')
  @ApiOperation({ summary: 'Detalhe da parcela' })
  @ApiRespostasDeErro(404)
  detalharParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.parcelas.detalhar(u, id);
  }

  @Patch('parcelas/:id')
  @ApiOperation({
    summary:
      'Altera a parcela em aberto; mudar o vencimento reinicia a régua (R24.3)',
  })
  @ApiRespostasDeErro(400, 404, 422)
  atualizarParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarParcelaDto,
  ) {
    return this.parcelas.atualizar(u, id, dto);
  }

  @Post('parcelas/:id/baixa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Baixa manual (marcar como pago): encerra a régua do título (R22.4, R24.6)',
  })
  @ApiRespostasDeErro(400, 404, 422)
  baixarParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: BaixaDto,
  ) {
    return this.parcelas.baixar(u, id, dto);
  }

  @Post('parcelas/:id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancela a parcela em aberto' })
  @ApiRespostasDeErro(404, 422)
  cancelarParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.parcelas.cancelar(u, id);
  }

  @Post('parcelas/:id/renegociar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Renegocia: a parcela vira RENEGOCIADO e nasce outra, com a régua do zero',
  })
  @ApiRespostasDeErro(400, 404, 422)
  renegociarParcela(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: RenegociarParcelaDto,
  ) {
    return this.parcelas.renegociar(u, id, dto);
  }

  @Get('parcelas/:id/linha-do-tempo')
  @ApiOperation({
    summary:
      'Linha do tempo do título: etapas e envios da régua, ligações e histórico (R24.9)',
  })
  @ApiRespostasDeErro(404)
  linhaDoTempo(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.parcelas.linhaDoTempo(u, id);
  }

  // ---- indicadores ---------------------------------------------------------------

  private exigirAcesso(u: UsuarioAutenticado): void {
    this.parcelas.exigirAcesso(u);
  }

  @Get('indicadores/resumo')
  @ApiOperation({
    summary:
      'Cartões do topo: MRR, inadimplência e previsto × realizado do mês (R23)',
  })
  resumoDosIndicadores(@UsuarioAtual() u: UsuarioAutenticado) {
    this.exigirAcesso(u);
    return this.indicadores.resumo(u);
  }

  @Get('indicadores/mrr')
  @ApiOperation({
    summary: 'MRR por mês: novo, expansão, contração e churn (R23.1)',
    description: '`de` e `ate` em AAAA-MM (padrão: últimos 12 meses).',
  })
  @ApiRespostasDeErro(400)
  mrr(@UsuarioAtual() u: UsuarioAutenticado, @Query() f: FiltroPeriodoDto) {
    this.exigirAcesso(u);
    return this.indicadores.mrr(u, f);
  }

  @Get('indicadores/inadimplencia')
  @ApiOperation({
    summary:
      'Inadimplência por faixa de atraso: 0–30, 31–60, 61–90 e 90+ (R23.2)',
  })
  inadimplencia(@UsuarioAtual() u: UsuarioAutenticado) {
    this.exigirAcesso(u);
    return this.indicadores.inadimplencia(u);
  }

  @Get('indicadores/previsto-realizado')
  @ApiOperation({ summary: 'Receita prevista × realizada por mês (R23.3)' })
  @ApiRespostasDeErro(400)
  previstoRealizado(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroPeriodoDto,
  ) {
    this.exigirAcesso(u);
    return this.indicadores.previstoRealizado(u, f);
  }

  @Get('risco-churn')
  @ApiOperation({
    summary: 'Clientes em risco de churn, do maior ao menor (R23.4)',
  })
  @ApiRespostasDeErro(400)
  rankingDeRisco(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroRiscoDto,
  ) {
    this.exigirAcesso(u);
    return this.risco.ranking(u, f);
  }

  @Get('risco-churn/contatos/:id')
  @ApiOperation({
    summary: 'Risco de churn de um contato (para a tela do contato)',
    description:
      '`{ risco: null }` quando o contato não tem contrato ou título visível para quem pergunta.',
  })
  async riscoDoContato(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return { risco: await this.risco.doContato(u, id) };
  }

  @Get('risco-churn/negocios/:id')
  @ApiOperation({
    summary: 'Risco de churn do cliente de um negócio (para o negócio de CS)',
  })
  async riscoDoNegocio(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return { risco: await this.risco.doNegocio(u, id) };
  }

  // ---- régua ----------------------------------------------------------------------

  @Get('regua/configuracao')
  @ApiOperation({
    summary:
      'Configuração da régua: horário, tolerância, número do financeiro, pausa (R24.2)',
  })
  configuracaoDaRegua(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.configuracao.obter(u);
  }

  @Patch('regua/configuracao')
  @ApiOperation({ summary: 'Altera a configuração da régua (gestão)' })
  @ApiRespostasDeErro(400)
  atualizarConfiguracao(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: AtualizarConfiguracaoReguaDto,
  ) {
    return this.configuracao.atualizar(u, dto);
  }

  @Post('regua/pausar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pausa os envios da régua (gestão)' })
  pausar(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.configuracao.atualizar(u, { pausada: true });
  }

  @Post('regua/retomar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retoma os envios da régua (gestão)' })
  retomar(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.configuracao.atualizar(u, { pausada: false });
  }

  @Get('regua/etapas')
  @ApiOperation({
    summary: 'Etapas da régua, ordenadas pelo marco (D-7 … D+60)',
  })
  etapas(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.configuracao.etapas(u);
  }

  @Post('regua/etapas')
  @ApiOperation({ summary: 'Cria uma etapa (gestão)' })
  @ApiCreatedResponse()
  @ApiRespostasDeErro(400, 409)
  criarEtapa(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: SalvarEtapaDto,
  ) {
    return this.configuracao.criarEtapa(u, dto);
  }

  @Put('regua/etapas/:id')
  @ApiOperation({ summary: 'Altera uma etapa (gestão)' })
  @ApiRespostasDeErro(400, 404, 409)
  atualizarEtapa(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: SalvarEtapaDto,
  ) {
    return this.configuracao.atualizarEtapa(u, id, dto);
  }

  @Delete('regua/etapas/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove uma etapa (gestão)' })
  @ApiRespostasDeErro(404)
  async removerEtapa(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ) {
    await this.configuracao.removerEtapa(u, id);
  }

  @Post('regua/previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prévia de um texto da etapa com dados de exemplo' })
  async previa(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: PreviaDaEtapaDto,
  ) {
    if (!podeAtuarNoFinanceiro(u)) {
      throw new SemPermissaoException(
        'Você não tem acesso à régua de cobrança.',
        { regra: 'R22.1' },
      );
    }
    const extras = variaveisDoTitulo(
      {
        numero: 'C-000012-03',
        valor: new Prisma.Decimal('299.90'),
        vencimento: new Date('2026-11-10T00:00:00.000Z'),
        descricao: 'Plano Pro — parcela 3',
        linkBoleto: 'https://exemplo.com/boleto/123',
        linkPagamento: 'https://exemplo.com/pagar/123',
        pix: '00020126...',
        promessaAte: null,
      },
      'Plano Pro',
      '2026-11-13',
      '2026-11-20',
    );
    return this.modelos.renderizarPara(
      dto.texto,
      {},
      {
        extras,
        variaveisExtras: VARIAVEIS_DO_TITULO,
        permitirVariaveisDaExecucao: false,
      },
    );
  }

  @Post('regua/executar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Executar agora (gestão): roda a régua do dia sob demanda',
    description:
      'Idempotente por título e etapa: não reenvia o que já foi registrado.',
  })
  @ApiRespostasDeErro(403)
  executar(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.regua.executarAgora(u);
  }

  @Get('regua/execucoes')
  @ApiOperation({
    summary: 'Histórico das execuções da régua (automáticas e manuais)',
  })
  execucoes(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.consulta.execucoes(u);
  }

  @Get('regua/resumo')
  @ApiOperation({
    summary:
      'Acompanhamento do dia: WhatsApp, e-mails, ligações e próximo envio (R24.4)',
  })
  resumoDoDia(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroEnviosDto,
  ) {
    return this.consulta.resumoDoDia(u, f.dia);
  }

  @Get('regua/envios')
  @ApiOperation({
    summary: 'Envios da régua (por dia ou por título), com situação e erro',
  })
  @ApiRespostasDeErro(400)
  envios(@UsuarioAtual() u: UsuarioAutenticado, @Query() f: FiltroEnviosDto) {
    return this.consulta.listarEnvios(u, f);
  }

  @Post('regua/reenviar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenvia as falhas do dia (WhatsApp e/ou e-mail) — gestão',
  })
  reenviar(@UsuarioAtual() u: UsuarioAutenticado, @Body() dto: ReenviarDto) {
    return this.consulta.reenviarFalhas(u, dto);
  }

  @Get('regua/ligacoes')
  @ApiOperation({
    summary: 'Ligações pendentes (ou todas, com `pendentes=false`) da carteira',
  })
  listarLigacoes(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Query() f: FiltroLigacoesDto,
  ) {
    return this.ligacoes.listar(u, f);
  }

  @Post('regua/ligacoes/:id/resultado')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registra o resultado da ligação (R24.5)',
    description:
      '`PROMESSA` (com `promessaAte`) suspende a régua e confirma; `SEM_ACORDO` e `NAO_ATENDEU` liberam a mensagem da etapa; `JA_PAGOU` dá baixa.',
  })
  @ApiRespostasDeErro(400, 404, 409)
  resultadoDaLigacao(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ResultadoLigacaoDto,
  ) {
    return this.ligacoes.registrarResultado(u, id, dto);
  }
}
