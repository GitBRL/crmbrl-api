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
import { PreviaDeMapeamentoDto, ResultadoDaPreviaDto } from './dto/previa.dto';
import {
  FiltroRecebimentosDto,
  PreviaDoWebhookDto,
  RecebimentoAceitoDto,
  RecebimentoDetalheDto,
  RecebimentoDto,
} from './dto/recebimento.dto';
import {
  AtualizarWebhookEntradaDto,
  CriarWebhookEntradaDto,
  DefinirSegredoEntradaDto,
  FiltroWebhooksDto,
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
 * Configuração dos pontos de entrada de leads (R8.1–R8.3, R8.6): só o Admin
 * (§12). O endereço que recebe os leads é o `POST /webhooks/entrada/:token`
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
  ) {}

  @Get('modelos')
  @ApiOperation({
    summary:
      'Modelos de mapeamento prontos (Genérico e Disparos BRL) e os destinos aceitos',
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

  @Get()
  @ApiOperation({ summary: 'Lista os pontos de entrada' })
  @ApiRespostaPaginada(WebhookEntradaDto)
  @ApiRespostasDeErro(400)
  listar(
    @Query() filtro: FiltroWebhooksDto,
  ): Promise<Pagina<WebhookEntradaDto>> {
    return this.webhooks.listar(filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um ponto de entrada (o endereço completo só aparece agora)',
    description:
      'Padrões (R8.1): funil Marketing, etapa "Novo lead", distribuição por rodízio, modelo Genérico. A resposta traz a `url` com o token (R8.2) e, com `gerarSegredo`, o segredo HMAC — copie agora.',
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

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edita um ponto de entrada (nome, funil, etapa, distribuição, mapeamento, etiquetas, ativo)',
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
