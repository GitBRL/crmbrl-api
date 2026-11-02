import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { EmissorSse } from '../bi/analise/emissor-sse';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { AssistenteService } from './assistente.service';
import { ChamadosAssistenteService } from './chamados/chamados-assistente.service';
import {
  AbrirChamadoDto,
  AvaliarRespostaDto,
  ChamadoAssistenteDto,
  ConversaAssistenteDto,
  EstadoAssistenteDto,
  PerguntaAssistenteDto,
  PerguntarDto,
} from './dto/assistente.dto';

export const DESCRICAO_STREAMING_ASSISTENTE =
  'Resposta `text/event-stream` (SSE no corpo do POST; leia com `fetch` + `ReadableStream`). Eventos `event: <nome>` + `data: <json>`: ' +
  '`inicio` {conversaId, perguntaId, conversaNova, modelo}; ' +
  '`fase` {fase: "pensando" | "escrevendo"}; ' +
  '`parcial` {resposta} — o texto da resposta até agora (substitui o anterior), a cada ~100 ms; ' +
  '`nova_tentativa` {tentativa, motivo} — descarte o parcial; ' +
  '`concluido` {conversaId, perguntaId, resposta, resolvido, categoria, resumoDoPedido, podeAbrirChamado, restantesHoje, duracaoMs}; ' +
  '`erro` {codigo, mensagem, conversaId, perguntaId}. Linhas `: batimento` mantêm a conexão. ' +
  'Fechar a conexão cancela a pergunta. Antes do streaming, os erros são respostas JSON normais (400, 404, 409, 422, 429, 503).';

/**
 * Assistente de ajuda por IA (R25): qualquer pessoa com sessão pergunta, vê as
 * próprias conversas, avalia as respostas e, com confirmação, abre chamado.
 */
@ApiTags('Assistente de IA')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('assistente')
export class AssistenteController {
  constructor(
    private readonly assistente: AssistenteService,
    private readonly chamados: ChamadosAssistenteService,
  ) {}

  @Get('estado')
  @ApiOperation({
    summary:
      'Se o assistente responde agora, o limite do dia e o aviso de registro',
  })
  @ApiOkResponse({ type: EstadoAssistenteDto })
  estado(@UsuarioAtual() u: UsuarioAutenticado): Promise<EstadoAssistenteDto> {
    return this.assistente.estado(u);
  }

  @Post('perguntas')
  @ApiOperation({
    summary: 'Faz uma pergunta ao assistente (streaming)',
    description:
      'Sem `conversaId`, começa uma conversa nova. Vão para a IA só o papel, a área, a tela (sem ids nem consulta) e o texto escrito. ' +
      'Conta no limite diário da pessoa e no orçamento do mês. Auditado. ' +
      DESCRICAO_STREAMING_ASSISTENTE,
  })
  @ApiBody({ type: PerguntarDto })
  @ApiProduces('text/event-stream')
  @ApiRespostasDeErro(400, 404, 409, 422, 429, 503)
  async perguntar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Body() dto: PerguntarDto,
    @Res() resposta: Response,
  ): Promise<void> {
    const pedido = await this.assistente.preparar(u, dto);
    const emissor = new EmissorSse(resposta);
    const cancelar = new AbortController();
    resposta.on('close', () => {
      if (!resposta.writableFinished) {
        cancelar.abort();
      }
    });
    emissor.abrir();
    try {
      await this.assistente.executar(pedido, emissor, cancelar.signal);
    } finally {
      emissor.fechar();
    }
  }

  @Get('conversas')
  @ApiOperation({ summary: 'As 30 conversas mais recentes da própria pessoa' })
  @ApiOkResponse({ type: [ConversaAssistenteDto] })
  conversas(
    @UsuarioAtual() u: UsuarioAutenticado,
  ): Promise<ConversaAssistenteDto[]> {
    return this.assistente.conversas(u);
  }

  @Get('conversas/:id')
  @ApiOperation({
    summary:
      'Uma conversa com as perguntas, respostas e chamados (a própria; o Admin vê todas)',
  })
  @ApiOkResponse({ type: ConversaAssistenteDto })
  @ApiRespostasDeErro(400, 404)
  conversa(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConversaAssistenteDto> {
    return this.assistente.conversa(u, id);
  }

  @Put('perguntas/:id/avaliacao')
  @ApiOperation({
    summary: 'Avalia a resposta como útil ou não útil (auditado)',
  })
  @ApiOkResponse({ type: PerguntaAssistenteDto })
  @ApiRespostasDeErro(400, 404, 422)
  avaliar(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AvaliarRespostaDto,
  ): Promise<PerguntaAssistenteDto> {
    return this.assistente.avaliar(u, id, dto.avaliacao);
  }

  @Post('perguntas/:id/chamado')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Abre um chamado a partir da resposta (com confirmação)',
    description:
      'Só para respostas da própria pessoa com categoria `funcionalidade_inexistente_no_escopo` ou `erro_do_sistema`, uma vez por resposta. ' +
      'O envio (TicketHub ou webhook) sai pela fila com novas tentativas: consulte `GET /assistente/chamados/:id` até `status` ser ENVIADO (com `numero`/`link`) ou FALHOU. ' +
      'A pessoa também recebe uma notificação. Auditado.',
  })
  @ApiAcceptedResponse({ type: ChamadoAssistenteDto })
  @ApiRespostasDeErro(400, 404, 409, 422, 503)
  abrirChamado(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AbrirChamadoDto,
  ): Promise<ChamadoAssistenteDto> {
    return this.chamados.abrir(u, id, dto);
  }

  @Get('chamados/:id')
  @ApiOperation({
    summary: 'Situação de um chamado (o próprio; o Admin vê todos)',
  })
  @ApiOkResponse({ type: ChamadoAssistenteDto })
  @ApiRespostasDeErro(400, 404)
  chamado(
    @UsuarioAtual() u: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ChamadoAssistenteDto> {
    return this.chamados.detalhe(u, id);
  }
}
