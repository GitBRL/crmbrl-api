import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Papeis, UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { type Pagina } from '../../comum/paginacao/paginacao';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { AnaliseService, type PedidoPreparado } from './analise.service';
import {
  AnaliseDetalheDto,
  type AnaliseResumoDto,
  ConfiguracaoAnaliseDto,
  EstadoAnaliseDto,
  FiltroHistoricoAnaliseDto,
  PaginaAnalisesDto,
  PerguntaAnaliseDto,
  SolicitarAnaliseDto,
} from './dto/analise.dto';
import { EmissorSse } from './emissor-sse';

const DESCRICAO_STREAMING =
  'Resposta `text/event-stream` (SSE no corpo do POST; leia com `fetch` + `ReadableStream`). Eventos, cada um `event: <nome>` + `data: <json>`: ' +
  '`inicio` {tipo, analiseId, perguntaId, painel, periodo, modelo}; ' +
  '`fase` {fase: "pensando" | "escrevendo"}; ' +
  '`parcial` {resumo?, destaques?, riscos?, acoes? (sem link)} — o JSON em formação, a cada ~120 ms; ' +
  '`nova_tentativa` {tentativa: 2, motivo} — descarte o parcial; ' +
  '`concluido` (análise: {analiseId, resultado, tokens, tentativas, duracaoMs, restantesHoje}; pergunta: {analiseId, perguntaId, resposta, tokens, tentativas, duracaoMs}); ' +
  '`erro` {codigo, mensagem, analiseId, perguntaId}. Linhas `: batimento` mantêm a conexão. ' +
  'Fechar a conexão cancela a chamada. Antes do streaming, os erros são respostas JSON normais (400, 403, 404, 409, 422, 429, 503).';

/**
 * Análise do BI por IA (R21): só Admin (os demais recebem 403). A chave da
 * Anthropic nunca é devolvida; sem ela, `GET estado` diz como configurar.
 */
@ApiTags('BI — análise por IA')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('bi/analise')
export class AnaliseController {
  constructor(private readonly analises: AnaliseService) {}

  @Get('estado')
  @ApiOperation({
    summary: 'Se a análise está configurada e disponível, e o uso do dia',
    description:
      'Sem `ANTHROPIC_API_KEY` no servidor: `configurada: false` e `comoConfigurar` (o botão mostra isso no lugar de analisar).',
  })
  @ApiOkResponse({ type: EstadoAnaliseDto })
  estado(): Promise<EstadoAnaliseDto> {
    return this.analises.estado();
  }

  @Put('configuracao')
  @ApiOperation({
    summary: 'Muda o limite de análises por dia (auditado)',
  })
  @ApiOkResponse({ type: EstadoAnaliseDto })
  @ApiRespostasDeErro(400)
  configurar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: ConfiguracaoAnaliseDto,
  ): Promise<EstadoAnaliseDto> {
    return this.analises.configurar(usuario, dto);
  }

  @Post()
  @ApiOperation({
    summary: 'Analisa o painel com os filtros atuais (streaming)',
    description:
      'Envia ao Claude só os números agregados do painel para estes filtros (os mesmos da tela; nada de dados de contatos). ' +
      'Conta no limite diário. Auditado (`bi.analise_ia_concluida` ou `bi.analise_ia_falhou`). ' +
      DESCRICAO_STREAMING,
  })
  @ApiBody({ type: SolicitarAnaliseDto })
  @ApiProduces('text/event-stream')
  @ApiRespostasDeErro(400, 429, 503)
  async analisar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: SolicitarAnaliseDto,
    @Res() resposta: Response,
  ): Promise<void> {
    const pedido = await this.analises.prepararAnalise(usuario, dto);
    await this.transmitir(pedido, resposta);
  }

  @Post(':id/perguntas')
  @ApiOperation({
    summary: 'Pergunta de acompanhamento sobre uma análise (streaming)',
    description:
      'Continua a mesma conversa (números, análise e perguntas anteriores). Até 5 por análise; não conta no limite diário. ' +
      'Auditado (`bi.analise_ia_pergunta_respondida` ou `…_falhou`). ' +
      DESCRICAO_STREAMING,
  })
  @ApiProduces('text/event-stream')
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  async perguntar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PerguntaAnaliseDto,
    @Res() resposta: Response,
  ): Promise<void> {
    const pedido = await this.analises.prepararPergunta(
      usuario,
      id,
      dto.pergunta,
    );
    await this.transmitir(pedido, resposta);
  }

  @Get('historico')
  @ApiOperation({
    summary: 'Histórico das análises (quem, painel, filtros, resumo, tokens)',
  })
  @ApiOkResponse({ type: PaginaAnalisesDto })
  @ApiRespostasDeErro(400)
  historico(
    @Query() filtro: FiltroHistoricoAnaliseDto,
  ): Promise<Pagina<AnaliseResumoDto>> {
    return this.analises.historico(filtro);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Uma análise: resultado, entrada enviada, perguntas e tokens',
  })
  @ApiOkResponse({ type: AnaliseDetalheDto })
  @ApiRespostasDeErro(400, 404)
  detalhe(@Param('id', ParseIdPipe) id: string): Promise<AnaliseDetalheDto> {
    return this.analises.detalhe(id);
  }

  private async transmitir(
    pedido: PedidoPreparado,
    resposta: Response,
  ): Promise<void> {
    const emissor = new EmissorSse(resposta);
    const cancelar = new AbortController();
    resposta.on('close', () => {
      if (!resposta.writableFinished) {
        cancelar.abort();
      }
    });
    emissor.abrir();
    try {
      await this.analises.executar(pedido, emissor, cancelar.signal);
    } finally {
      emissor.fechar();
    }
  }
}
