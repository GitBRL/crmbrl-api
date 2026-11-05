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
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  Papeis,
  Publico,
  SemVerificacaoDeOrigem,
  UsuarioAtual,
} from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import type { RequisicaoHttp } from '../../comum/http/requisicao-http';
import {
  ApiRespostaPaginada,
  type Pagina,
} from '../../comum/paginacao/paginacao';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { AplicativosService } from './aplicativos.service';
import {
  CamposBuscadosDto,
  CamposRecebidosDto,
  CatalogoDeAplicativosDto,
  EnderecoDaIntegracaoDto,
  FiltroCamposRecebidosDto,
  FiltroFormulariosDto,
  FormularioDto,
  ResultadoDoTesteDaCredencialDto,
  SincronizacaoDto,
  TestarCredencialDto,
} from './dto/integracao.dto';
import { PreviaDeMapeamentoDto, ResultadoDaPreviaDto } from './dto/previa.dto';
import {
  FiltroHistoricoDto,
  FiltroRecebimentosDto,
  PreviaDoWebhookDto,
  RecebimentoAceitoDto,
  RecebimentoDetalheDto,
  RecebimentoDto,
} from './dto/recebimento.dto';
import {
  AtualizarWebhookEntradaDto,
  CampoBuscadoDto,
  CriarWebhookEntradaDto,
  DefinirSegredoEntradaDto,
  FiltroIntegracoesDto,
  MapeamentoDto,
  ModelosDeMapeamentoDto,
  SegredoDefinidoDto,
  TokenRegeneradoDto,
  WebhookEntradaCriadoDto,
  WebhookEntradaDto,
} from './dto/webhook-entrada.dto';
import { RecebimentosService } from './recebimentos.service';
import { WebhooksEntradaService } from './webhooks-entrada.service';

/**
 * Integrações de entrada (R8.1–R8.3, R8.6, R32): o ponto de entrada de leads
 * de um aplicativo (Webhook, Elementor, RD Station, ActiveCampaign, Great
 * Pages, Lead Lovers, ManyChat, Typeform), só para o Admin (§12). O endereço
 * que recebe os leads é o `POST /webhooks/entrada/:token`
 * (`WebhookEntradaPublicoController`).
 */
@ApiTags('Webhooks de entrada')
@ApiCookieAuth()
@ApiExtraModels(MapeamentoDto)
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webhooks/entradas')
export class WebhooksEntradaController {
  constructor(
    private readonly webhooks: WebhooksEntradaService,
    private readonly recebimentos: RecebimentosService,
    private readonly aplicativos: AplicativosService,
  ) {}

  @Get('modelos')
  @ApiOperation({
    summary:
      'Modelos de mapeamento prontos do aplicativo Webhook (Genérico e Disparos BRL) e os destinos aceitos',
  })
  @ApiOkResponse({ type: ModelosDeMapeamentoDto })
  modelos(): ModelosDeMapeamentoDto {
    return this.webhooks.modelos();
  }

  @Post('previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Prévia do mapeamento sobre um corpo de exemplo (não grava nada)',
    description:
      'Mostra o contato e o negócio que o processamento criaria (R8.5), já normalizados, os problemas que dariam erro e os valores descartados.',
  })
  @ApiOkResponse({ type: ResultadoDaPreviaDto })
  @ApiRespostasDeErro(400)
  previa(@Body() dto: PreviaDeMapeamentoDto): ResultadoDaPreviaDto {
    return this.webhooks.previa(dto);
  }

  @Post('testar-credencial')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Testa uma credencial antes de criar a integração (não grava nada)',
    description:
      'Chama o aplicativo (Typeform, ActiveCampaign, ManyChat) com a credencial digitada. `valida: false` traz o motivo (token expirado, chave recusada, aplicativo fora do ar). A URL da conta do ActiveCampaign passa pela proteção contra SSRF (R9.1).',
  })
  @ApiOkResponse({ type: ResultadoDoTesteDaCredencialDto })
  @ApiRespostasDeErro(400, 422)
  testarCredencialNova(
    @Body() dto: TestarCredencialDto,
  ): Promise<ResultadoDoTesteDaCredencialDto> {
    return this.aplicativos.testarSemGuardar(dto.aplicativo, dto.credencial);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista as integrações de entrada',
    description:
      'Filtros: busca por nome, ativo, aplicativo (vários), funil e precisaAtencao. Cada item traz o aplicativo, a ação (alvo e modo), a `situacao` (ATIVA, INATIVA ou PRECISA_ATENCAO) e o último recebimento.',
  })
  @ApiRespostaPaginada(WebhookEntradaDto)
  @ApiRespostasDeErro(400)
  listar(
    @Query() filtro: FiltroIntegracoesDto,
  ): Promise<Pagina<WebhookEntradaDto>> {
    return this.webhooks.listar(filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria uma integração de entrada',
    description:
      'Padrões: aplicativo Webhook, alvo NEGOCIO, modo CRIAR_OU_ATUALIZAR (o comportamento de sempre, R8.5), funil Marketing, etapa "Novo lead", rodízio, modelo Genérico (Webhook) ou DO_APLICATIVO (os demais). ' +
      'Aplicativos com credencial (ActiveCampaign, ManyChat, Typeform) exigem `credencial`. No Typeform, `configuracao.formularioId` faz o CRM registrar o webhook no formulário, com um segredo gerado por ele. ' +
      'A resposta traz a `url` com o token (R8.2) — também reaberta depois por `GET /webhooks/entradas/{id}/endereco` — e, com `gerarSegredo`, o segredo HMAC (copie agora). Aplicativos ainda indisponíveis (Facebook Lead Ads, Hotmart, Kiwify, Eduzz): 422.',
  })
  @ApiCreatedResponse({ type: WebhookEntradaCriadoDto })
  @ApiRespostasDeErro(400, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarWebhookEntradaDto,
  ): Promise<WebhookEntradaCriadoDto> {
    return this.webhooks.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um ponto de entrada' })
  @ApiOkResponse({ type: WebhookEntradaDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(@Param('id', ParseIdPipe) id: string): Promise<WebhookEntradaDto> {
    return this.webhooks.detalhar(id);
  }

  @Get(':id/endereco')
  @ApiOperation({
    summary:
      'O endereço completo da integração (passo "Endereço" do assistente)',
    description:
      'Só o Admin. As integrações criadas antes da Onda H não guardam o token cifrado: 422, e a saída é regenerar o token.',
  })
  @ApiOkResponse({ type: EnderecoDaIntegracaoDto })
  @ApiRespostasDeErro(400, 404, 422)
  endereco(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<EnderecoDaIntegracaoDto> {
    return this.webhooks.enderecoCompleto(id);
  }

  @Post(':id/testar-credencial')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testa a credencial guardada da integração',
    description:
      'Credencial recusada: `valida: false` e a integração passa a "precisa de atenção" (os Admins são avisados, R32.9). Aceita: a atenção é limpa.',
  })
  @ApiOkResponse({ type: ResultadoDoTesteDaCredencialDto })
  @ApiRespostasDeErro(400, 404, 422)
  testarCredencial(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ResultadoDoTesteDaCredencialDto> {
    return this.aplicativos.testarDaIntegracao(id);
  }

  @Post(':id/buscar-campos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '"Buscar campos da integração": os campos do aplicativo, pela credencial',
    description:
      'ActiveCampaign: `GET {conta}/api/3/fields` (`contact.fields.<id>` com o título). ManyChat: campos personalizados (`custom_fields.<nome>`). Typeform: as perguntas do formulário escolhido (`<ref>`), `hidden.*` e `variables.*`. O resultado também fica em `camposBuscados` da integração. Credencial recusada: 422 e a integração passa a "precisa de atenção".',
  })
  @ApiOkResponse({ type: CamposBuscadosDto })
  @ApiRespostasDeErro(400, 404, 422)
  buscarCampos(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<CamposBuscadosDto> {
    return this.aplicativos.buscarCampos(id);
  }

  @Get(':id/campos-recebidos')
  @ApiOperation({
    summary: '"Atualizar campos recebidos": os campos dos últimos recebimentos',
    description:
      'Lê os últimos recebimentos aceitos (padrão 20), passa cada corpo pelo adaptador do aplicativo e lista os caminhos de campo com um valor de exemplo mascarado (e-mails, telefones e valores longos). Os recusados na chegada não entram.',
  })
  @ApiOkResponse({ type: CamposRecebidosDto })
  @ApiRespostasDeErro(400, 404)
  camposRecebidos(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroCamposRecebidosDto,
  ): Promise<CamposRecebidosDto> {
    return this.recebimentos.camposRecebidos(id, filtro.limite);
  }

  @Get(':id/formularios')
  @ApiOperation({
    summary: 'Formulários do aplicativo (Typeform), para o passo de escolha',
    description:
      'Usa a credencial guardada. Escolher um formulário é `PATCH` com `configuracao: { formularioId }`: o CRM registra o webhook nele.',
  })
  @ApiOkResponse({ type: [FormularioDto] })
  @ApiRespostasDeErro(400, 404, 422)
  formularios(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroFormulariosDto,
  ): Promise<FormularioDto[]> {
    return this.aplicativos.listarFormularios(id, filtro.busca);
  }

  @Get(':id/formularios/:formularioId/campos')
  @ApiOperation({
    summary: 'As perguntas de um formulário (Typeform), `hidden` e `variables`',
  })
  @ApiOkResponse({ type: [CampoBuscadoDto] })
  @ApiRespostasDeErro(400, 404, 422)
  camposDoFormulario(
    @Param('id', ParseIdPipe) id: string,
    @Param('formularioId') formularioId: string,
  ): Promise<CampoBuscadoDto[]> {
    return this.aplicativos.camposDoFormulario(id, formularioId);
  }

  @Post(':id/sincronizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Registra de novo o webhook na ferramenta (Typeform, RD Station com conexão e Facebook)',
    description:
      'Typeform: repete o registro (`PUT /forms/{id}/webhooks/{tag}`) com o segredo e o endereço atuais. RD Station com conexão (R32.26): cria (ou recria) o webhook no RD. `registrado: false` traz o motivo em `erro`.',
  })
  @ApiOkResponse({ type: SincronizacaoDto })
  @ApiRespostasDeErro(400, 404)
  sincronizar(@Param('id', ParseIdPipe) id: string): Promise<SincronizacaoDto> {
    return this.aplicativos.sincronizarComAFerramenta(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edita uma integração (nome, funil, etapa, ação, status inicial, credencial, configuração, mapeamento, etiquetas, ativo)',
    description:
      'Enviar só `mapeamento` passa o modelo para `PERSONALIZADO`; trocar para `PERSONALIZADO` sem `mapeamento` parte do mapeamento que valia. Desativado, o endereço responde 410.',
  })
  @ApiOkResponse({ type: WebhookEntradaDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarWebhookEntradaDto,
  ): Promise<WebhookEntradaDto> {
    return this.webhooks.atualizar(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui um ponto de entrada (o endereço passa a responder 404)',
  })
  @ApiNoContentResponse({ description: 'Excluído.' })
  @ApiRespostasDeErro(400, 404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.webhooks.excluir(id);
  }

  @Post(':id/regenerar-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gera um endereço novo (R8.2); o anterior para de funcionar na hora',
  })
  @ApiOkResponse({ type: TokenRegeneradoDto })
  @ApiRespostasDeErro(400, 404)
  regenerarToken(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<TokenRegeneradoDto> {
    return this.webhooks.regenerarToken(id);
  }

  @Post(':id/segredo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Define ou gera o segredo HMAC (R8.3); com ele, toda chamada exige X-Assinatura',
    description:
      'Sem `segredo` no corpo, a API gera um e o mostra só nesta resposta. Depois ele só aparece mascarado (R10.3).',
  })
  @ApiOkResponse({ type: SegredoDefinidoDto })
  @ApiRespostasDeErro(400, 404)
  definirSegredo(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DefinirSegredoEntradaDto,
  ): Promise<SegredoDefinidoDto> {
    return this.webhooks.definirSegredo(id, dto);
  }

  @Delete(':id/segredo')
  @ApiOperation({
    summary: 'Remove o segredo HMAC: as chamadas deixam de exigir assinatura',
  })
  @ApiOkResponse({ type: WebhookEntradaDto })
  @ApiRespostasDeErro(400, 404)
  removerSegredo(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<WebhookEntradaDto> {
    return this.webhooks.removerSegredo(id);
  }

  @Post(':id/previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Prévia com a configuração salva, sobre um exemplo ou um recebimento guardado',
  })
  @ApiOkResponse({ type: ResultadoDaPreviaDto })
  @ApiRespostasDeErro(400, 404, 422)
  previaDoWebhook(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PreviaDoWebhookDto,
  ): Promise<ResultadoDaPreviaDto> {
    return this.webhooks.previaDoWebhook(id, dto);
  }

  @Get(':id/recebimentos')
  @ApiOperation({
    summary: 'Recebimentos do ponto (R8.6), dos mais novos aos mais antigos',
    description: 'Sem o corpo (veja o detalhe). Guardados por 90 dias.',
  })
  @ApiRespostaPaginada(RecebimentoDto)
  @ApiRespostasDeErro(400, 404)
  listarRecebimentos(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroRecebimentosDto,
  ): Promise<Pagina<RecebimentoDto>> {
    return this.recebimentos.listar(id, filtro);
  }

  @Get(':id/recebimentos/:recebimentoId')
  @ApiOperation({
    summary: 'Detalha um recebimento, com o corpo e os cabeçalhos guardados',
  })
  @ApiOkResponse({ type: RecebimentoDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalharRecebimento(
    @Param('id', ParseIdPipe) id: string,
    @Param('recebimentoId', ParseIdPipe) recebimentoId: string,
  ): Promise<RecebimentoDetalheDto> {
    return this.recebimentos.detalhar(id, recebimentoId);
  }

  @Post(':id/recebimentos/:recebimentoId/reprocessar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reprocessa um recebimento com a configuração atual (R8.6)',
    description:
      'Para os com erro, ignorados ou ainda na fila. Um já processado (409) criaria uma reconversão a mais; um recusado na chegada (422), como o de assinatura inválida, nunca foi aceito.',
  })
  @ApiAcceptedResponse({ type: RecebimentoDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  reprocessar(
    @Param('id', ParseIdPipe) id: string,
    @Param('recebimentoId', ParseIdPipe) recebimentoId: string,
  ): Promise<RecebimentoDto> {
    return this.recebimentos.reprocessar(id, recebimentoId);
  }
}

/**
 * O endereço público que recebe os leads (R8.2–R8.4, R8.7). Sem login e sem
 * verificação de origem (R2.9): autentica pelo token da URL e, se o ponto
 * tiver segredo, pela assinatura HMAC do corpo bruto.
 */
@ApiTags('Webhooks de entrada')
@Controller('webhooks/entrada')
export class WebhookEntradaPublicoController {
  constructor(private readonly recebimentos: RecebimentosService) {}

  @Post(':token')
  @Publico()
  @SemVerificacaoDeOrigem()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Recebe um lead (endereço público do ponto de entrada)',
    description:
      'JSON ou `application/x-www-form-urlencoded`, até 256 KB (R8.2). Responde 202 na hora, com o id do recebimento; o processamento vai para a fila, com até 3 tentativas (R8.4). ' +
      'Token inexistente: 404; ponto desativado: 410; mais de 60 chamadas por minuto: 429 (R8.7). Com segredo configurado, exige `X-Assinatura: sha256=<hex>`, o HMAC-SHA256 do corpo bruto; inválida: 401, e o recebimento fica registrado como erro (R8.3).',
  })
  @ApiParam({
    name: 'token',
    description:
      'O token do endereço (mostrado ao criar ou regenerar o ponto).',
  })
  @ApiHeader({
    name: 'X-Assinatura',
    required: false,
    description:
      '`sha256=<hex>`: HMAC-SHA256 do corpo bruto com o segredo do ponto.',
  })
  @ApiConsumes('application/json', 'application/x-www-form-urlencoded')
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      example: {
        name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        phone: '(11) 98765-4321',
        utm_source: 'google',
      },
    },
  })
  @ApiAcceptedResponse({ type: RecebimentoAceitoDto })
  @ApiRespostasDeErro(401, 404, 410, 413, 415, 429)
  receber(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<RequisicaoHttp>,
  ): Promise<RecebimentoAceitoDto> {
    return this.recebimentos.receber(token, req);
  }
}

/** O catálogo de aplicativos do assistente (R32.1). Só o Admin. */
@ApiTags('Integrações: aplicativos')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webhooks/aplicativos')
export class AplicativosController {
  constructor(private readonly webhooks: WebhooksEntradaService) {}

  @Get()
  @ApiOperation({
    summary:
      'Catálogo de aplicativos (Webhook, Elementor, RD Station, ActiveCampaign, Great Pages, Lead Lovers, ManyChat, Typeform e os que chegam depois)',
    description:
      'Em ordem alfabética, com o que cada um pede: credencial, segredo, autenticidade, passo a passo do lado da ferramenta, modelo de mapeamento pronto e se busca campos ou escolhe formulário. `disponivel: false`: aparece no catálogo, mas ainda não dá para criar. Traz também os destinos do mapeamento.',
  })
  @ApiOkResponse({ type: CatalogoDeAplicativosDto })
  catalogo(): CatalogoDeAplicativosDto {
    return this.webhooks.catalogo();
  }
}

/** O histórico de recebimentos de todas as integrações (R32.7). Só o Admin. */
@ApiTags('Integrações: histórico')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webhooks/recebimentos')
export class HistoricoDeRecebimentosController {
  constructor(private readonly recebimentos: RecebimentosService) {}

  @Get()
  @ApiOperation({
    summary: 'Histórico de recebimentos de todas as integrações',
    description:
      'Do mais novo ao mais antigo, sem o corpo, guardados por 90 dias (R8.6). Filtros: data (`de`, `ate`), `status` (vários), `aplicativo` (vários) e `integracaoId`. Cada item traz o aplicativo, a integração, os avisos e o resultado por item.',
  })
  @ApiRespostaPaginada(RecebimentoDto)
  @ApiRespostasDeErro(400, 404)
  listar(@Query() filtro: FiltroHistoricoDto): Promise<Pagina<RecebimentoDto>> {
    return this.recebimentos.listarHistorico(filtro);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalha um recebimento: cabeçalhos, corpo, avisos e o que foi criado ou atualizado',
    description: 'O corpo vem como JSON para "Copiar payload".',
  })
  @ApiOkResponse({ type: RecebimentoDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<RecebimentoDetalheDto> {
    return this.recebimentos.detalharPorId(id);
  }

  @Post(':id/reprocessar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reprocessa um recebimento com a configuração atual da integração',
    description:
      'As mesmas regras de `POST /webhooks/entradas/{id}/recebimentos/{recebimentoId}/reprocessar`. Num recebimento de vários itens, só os que não foram processados refazem.',
  })
  @ApiAcceptedResponse({ type: RecebimentoDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  reprocessar(@Param('id', ParseIdPipe) id: string): Promise<RecebimentoDto> {
    return this.recebimentos.reprocessarPorId(id);
  }
}
