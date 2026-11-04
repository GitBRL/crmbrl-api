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
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import {
  ApiRespostaPaginada,
  type Pagina,
} from '../../comum/paginacao/paginacao';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { FiltroWebhooksDto } from '../entrada/dto/webhook-entrada.dto';
import {
  EntregaDetalheDto,
  EntregaDto,
  FiltroEntregasDto,
} from './dto/entrega.dto';
import {
  AtualizarWebhookSaidaDto,
  CriarWebhookSaidaDto,
  EventoDisponivelDto,
  FormatoClintDto,
  WebhookSaidaComSegredoDto,
  WebhookSaidaDto,
} from './dto/webhook-saida.dto';
import { EntregasService } from './entregas.service';
import { WebhooksSaidaService } from './webhooks-saida.service';

/**
 * Webhooks de saída (R9): destinos, entregas, reenvio e evento de teste. Só o
 * Admin (§12).
 *
 * O destino de formato `CLINT` (R32.12) envia só os campos escolhidos, com os
 * identificadores escolhidos: `POST` (corpo JSON) ou `GET` (parâmetros na URL),
 * disparado pelos gatilhos de negócio. Os cabeçalhos `X-CRM-*` seguem iguais; a
 * assinatura cobre `timestamp + "." + corpo` (no GET, o corpo é a query string).
 *
 * No formato `ENVELOPE_CRM`, toda entrega é um `POST` com o envelope `{ id, evento, ocorridoEm, dados }`
 * e os cabeçalhos `X-CRM-Evento`, `X-CRM-Entrega`, `X-CRM-Timestamp` e
 * `X-CRM-Assinatura: sha256=<hmac>` — HMAC-SHA256 de `timestamp + "." + corpo`
 * com o segredo do destino (R9.3). Use o `id` do envelope para não processar o
 * mesmo evento duas vezes: a ordem não é garantida (R9.6).
 */
@ApiTags('Webhooks de saída')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('webhooks/saidas')
export class WebhooksSaidaController {
  constructor(
    private readonly destinos: WebhooksSaidaService,
    private readonly entregas: EntregasService,
  ) {}

  @Get('eventos')
  @ApiOperation({ summary: 'Eventos que um destino pode assinar (R9.2)' })
  @ApiOkResponse({ type: [EventoDisponivelDto] })
  eventos(): EventoDisponivelDto[] {
    return this.destinos.eventosDisponiveis();
  }

  @Get('formato-clint')
  @ApiOperation({
    summary:
      'O que o formato do Clint oferece: gatilhos, campos e métodos (R32.12)',
    description:
      'Para a tela "Enviar" do cartão Webhook: os gatilhos (negócio criado, entra na etapa X, muda de etapa, muda de status), os campos de contato, negócio, funil, etapa, dono, UTMs e evento com o identificador sugerido e o POST ou GET. Campos personalizados: `contato.camposPersonalizados.<chave>` e `negocio.camposPersonalizados.<chave>`.',
  })
  @ApiOkResponse({ type: FormatoClintDto })
  formatoClint(): FormatoClintDto {
    return this.destinos.formatoClint();
  }

  @Get()
  @ApiOperation({ summary: 'Lista os destinos' })
  @ApiRespostaPaginada(WebhookSaidaDto)
  @ApiRespostasDeErro(400)
  listar(@Query() filtro: FiltroWebhooksDto): Promise<Pagina<WebhookSaidaDto>> {
    return this.destinos.listar(filtro);
  }

  @Post()
  @ApiOperation({
    summary: 'Cadastra um destino; o segredo das assinaturas só aparece agora',
    description:
      'A URL é conferida contra SSRF (R9.1): rede interna e localhost são recusados (422), salvo com WEBHOOKS_PERMITIR_REDE_INTERNA=true; em produção, só HTTPS.',
  })
  @ApiCreatedResponse({ type: WebhookSaidaComSegredoDto })
  @ApiRespostasDeErro(400, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarWebhookSaidaDto,
  ): Promise<WebhookSaidaComSegredoDto> {
    return this.destinos.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um destino' })
  @ApiOkResponse({ type: WebhookSaidaDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(@Param('id', ParseIdPipe) id: string): Promise<WebhookSaidaDto> {
    return this.destinos.detalhar(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita um destino (nome, URL, eventos, cabeçalhos, ativo)',
    description:
      'Reativar zera as falhas seguidas (R9.4). Os cabeçalhos são uma atualização parcial: `null` remove um.',
  })
  @ApiOkResponse({ type: WebhookSaidaDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarWebhookSaidaDto,
  ): Promise<WebhookSaidaDto> {
    return this.destinos.atualizar(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui um destino (para de receber eventos)' })
  @ApiNoContentResponse({ description: 'Excluído.' })
  @ApiRespostasDeErro(400, 404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.destinos.excluir(id);
  }

  @Post(':id/regenerar-segredo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gera um segredo novo (mostrado só agora); as próximas entregas usam o novo',
  })
  @ApiOkResponse({ type: WebhookSaidaComSegredoDto })
  @ApiRespostasDeErro(400, 404)
  regenerarSegredo(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<WebhookSaidaComSegredoDto> {
    return this.destinos.regenerarSegredo(id);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Envia agora um evento de teste (webhook.teste) a este destino (R9.5)',
    description:
      'Uma única tentativa, feita na hora (até 10 s): a resposta já traz o resultado. Não agenda novas tentativas nem conta como falha do destino.',
  })
  @ApiOkResponse({ type: EntregaDetalheDto })
  @ApiRespostasDeErro(400, 404)
  testar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<EntregaDetalheDto> {
    return this.entregas.testar(usuario, id);
  }

  @Get(':id/entregas')
  @ApiOperation({
    summary: 'Entregas do destino (R9.5), das mais novas às mais antigas',
  })
  @ApiRespostaPaginada(EntregaDto)
  @ApiRespostasDeErro(400, 404)
  listarEntregas(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroEntregasDto,
  ): Promise<Pagina<EntregaDto>> {
    return this.entregas.listar(id, filtro);
  }

  @Get(':id/entregas/:entregaId')
  @ApiOperation({
    summary: 'Detalha uma entrega: o envelope e todas as tentativas (R9.5)',
  })
  @ApiOkResponse({ type: EntregaDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalharEntrega(
    @Param('id', ParseIdPipe) id: string,
    @Param('entregaId', ParseIdPipe) entregaId: string,
  ): Promise<EntregaDetalheDto> {
    return this.entregas.detalhar(id, entregaId);
  }

  @Post(':id/entregas/:entregaId/reenviar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reenvia uma entrega (R9.5): recomeça as tentativas, pela fila',
    description:
      'Vale para qualquer situação (entregue, pendente ou com falha). O envelope é o mesmo, com o mesmo `id` (R9.6). Destino desativado: 422.',
  })
  @ApiAcceptedResponse({ type: EntregaDetalheDto })
  @ApiRespostasDeErro(400, 404, 422)
  reenviar(
    @Param('id', ParseIdPipe) id: string,
    @Param('entregaId', ParseIdPipe) entregaId: string,
  ): Promise<EntregaDetalheDto> {
    return this.entregas.reenviar(id, entregaId);
  }
}
