import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { interpretarFaixa } from '../../arquivos/faixa';
import { cabecalhoContentDisposition } from '../../arquivos/politica';
import { UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { exigirAtendimento } from '../../atendimento/conversas.service';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import type { Arquivo } from '../../generated/prisma/client';
import {
  ConfirmarSugestaoDto,
  FinalizarGravacaoDto,
  ReprocessarDto,
  RespostaDaParteDto,
  RespostaDeFinalizacaoDto,
  RespostaDeSugestaoDto,
  TranscricaoCompletaDto,
} from './gravacao.dto';
import { GravacaoService } from './gravacao.service';
import {
  LeituraDaGravacaoService,
  type VersaoDoAudio,
} from './leitura-gravacao.service';
import { ReprocessamentoDaGravacaoService } from './reprocessamento-gravacao.service';
import { SugestoesDeAtividadeService } from './sugestoes-de-atividade.service';

/**
 * Serve o conteúdo com `Range` (o player avança e volta), `ETag` e cabeçalhos seguros.
 * `aoComecar` roda uma vez por reprodução: só quando a resposta parte do byte 0.
 */
async function servir(
  arquivos: ArquivosService,
  arquivo: Arquivo,
  requisicao: Request,
  resposta: Response,
  opcoes: {
    disposicao: 'inline' | 'attachment';
    nome: string;
    cache?: string;
    /** Chamado antes de mandar o corpo, com o primeiro byte pedido (0 sem `Range`). */
    aoComecar?: (inicio: number) => Promise<void>;
  },
): Promise<void> {
  const etag = `"${arquivo.sha256}"`;
  resposta.set({
    'Content-Type': arquivo.mime,
    'Content-Disposition': cabecalhoContentDisposition(
      opcoes.nome,
      opcoes.disposicao,
    ),
    'X-Content-Type-Options': 'nosniff',
    // Áudio de ligação é dado pessoal: nada de cache compartilhado nem armazenado.
    'Cache-Control': opcoes.cache ?? 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ETag: etag,
    'Accept-Ranges': 'bytes',
  });
  const ifRange = requisicao.headers['if-range'];
  const faixa = interpretarFaixa(
    ifRange && ifRange !== etag ? undefined : requisicao.headers.range,
    arquivo.tamanho,
  );
  if (faixa.tipo === 'invalida') {
    resposta
      .status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
      .set('Content-Range', `bytes */${arquivo.tamanho}`)
      .end();
    return;
  }
  const parcial = faixa.tipo === 'parcial' ? faixa.faixa : undefined;
  const tamanho = parcial ? parcial.fim - parcial.inicio + 1 : arquivo.tamanho;
  if (requisicao.method === 'HEAD') {
    resposta
      .status(parcial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK)
      .set('Content-Length', String(tamanho))
      .end();
    return;
  }
  await opcoes.aoComecar?.(parcial?.inicio ?? 0);
  const conteudo = await arquivos.abrirConteudo(arquivo, parcial);
  resposta.status(parcial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
  resposta.set('Content-Length', String(tamanho));
  if (parcial) {
    resposta.set(
      'Content-Range',
      `bytes ${parcial.inicio}-${parcial.fim}/${arquivo.tamanho}`,
    );
  }
  await pipeline(conteudo, resposta).catch(() => {
    // O player fechou a conexão para pular para outro trecho.
    conteudo.destroy();
    resposta.destroy();
  });
}

function versaoDe(valor: string | undefined): VersaoDoAudio {
  if (valor === undefined || valor === 'ouvir') {
    return 'ouvir';
  }
  if (valor === 'original') {
    return 'original';
  }
  throw new DadosInvalidosException('Versão inválida.', {
    campos: [{ campo: 'versao', mensagens: ['use "ouvir" ou "original"'] }],
  });
}

/**
 * Gravação, transcrição e resumo das ligações (R30). O gravador do navegador manda as partes
 * (`POST …/gravacao/partes/:sequencia`, corpo cru `audio/webm`) e finaliza ao fim da ligação
 * (`POST …/gravacao/finalizar`, também por `navigator.sendBeacon`); o painel lê o estado em
 * `GET /ligacoes/:id`, a transcrição em `…/transcricao` e ouve em `…/audio` (com `Range`).
 * O tempo real avisa com `ligacao.processada`.
 */
@ApiTags('Ligações — gravação e transcrição')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('ligacoes')
export class GravacaoController {
  constructor(
    private readonly gravacao: GravacaoService,
    private readonly leitura: LeituraDaGravacaoService,
    private readonly reprocessamento: ReprocessamentoDaGravacaoService,
    private readonly sugestoes: SugestoesDeAtividadeService,
    private readonly arquivos: ArquivosService,
  ) {}

  @Post(':id/gravacao/partes/:sequencia')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envia uma parte da gravação (~5 s de webm/opus)',
    description:
      'Corpo cru (`Content-Type: audio/webm`), até 4 MB. Idempotente por sequência: reenviar a mesma parte devolve `duplicada: true`; outra parte com o mesmo número é 409. A sequência começa em 0 (a primeira parte traz o cabeçalho webm). Só o atendente da ligação, com ela EM_ANDAMENTO (ou encerrada há menos de 2 minutos), e só se o canal grava.',
  })
  @ApiConsumes('audio/webm', 'application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOkResponse({ type: RespostaDaParteDto })
  @ApiRespostasDeErro(400, 404, 409, 413)
  parte(
    @Param('id', ParseIdPipe) id: string,
    @Param('sequencia') sequencia: string,
    @Req() requisicao: Request,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RespostaDaParteDto> {
    return this.gravacao.receberParte(
      usuario,
      id,
      /^\d+$/.test(sequencia) ? Number(sequencia) : -1,
      requisicao,
    );
  }

  @Post(':id/gravacao/finalizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finaliza a gravação: junta as partes e enfileira o processamento',
    description:
      'Corpo `{totalPartes}` ou `?totalPartes=N` (para o `navigator.sendBeacon`, que não leva JSON). Idempotente. Sem partes, nada é gravado (`gravacao: "sem"`). Depois, o estado vira `enviando` e o evento `ligacao.processada` avisa a conversão, a transcrição e o resumo.',
  })
  @ApiOkResponse({ type: RespostaDeFinalizacaoDto })
  @ApiRespostasDeErro(400, 404, 409)
  finalizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: FinalizarGravacaoDto,
    @Query() consulta: FinalizarGravacaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RespostaDeFinalizacaoDto> {
    return this.gravacao.finalizar(
      usuario,
      id,
      dto?.totalPartes ?? consulta.totalPartes,
    );
  }

  @Get(':id/transcricao')
  @ApiOperation({
    summary:
      'Transcrição da ligação (trechos de Atendente e Cliente, com tempo)',
    description:
      'Quem vê a conversa ou o contato lê. Cada leitura é auditada. 404 se a ligação não foi gravada ou se a guarda já apagou a transcrição.',
  })
  @ApiOkResponse({ type: TranscricaoCompletaDto })
  @ApiRespostasDeErro(404)
  transcricao(
    @Param('id', ParseIdPipe) id: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<TranscricaoCompletaDto> {
    return this.leitura.transcricao(usuario, id);
  }

  @Get(':id/audio')
  @ApiOperation({
    summary: 'Áudio da ligação para ouvir (mono, ogg/opus), com `Range`',
    description:
      'Streaming com suporte a `Range` (206) para o player avançar e voltar. Quem vê a conversa ou o contato ouve; a reprodução é auditada. `?versao=original` entrega o webm estéreo (atendente à esquerda, cliente à direita).',
  })
  @ApiProduces('audio/ogg', 'audio/webm')
  @ApiResponse({ status: 200, description: 'O áudio inteiro.' })
  @ApiResponse({ status: 206, description: 'A faixa de bytes pedida.' })
  @ApiResponse({ status: 416, description: 'Faixa fora do arquivo.' })
  @ApiRespostasDeErro(400, 404, 503)
  async audio(
    @Param('id', ParseIdPipe) id: string,
    @Query('versao') versao: string | undefined,
    @Req() requisicao: Request,
    @Res() resposta: Response,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<void> {
    const v = versaoDe(versao);
    const arquivo = await this.leitura.arquivoDoAudio(usuario, id, {
      baixar: false,
      versao: v,
    });
    await servir(this.arquivos, arquivo, requisicao, resposta, {
      disposicao: 'inline',
      nome: arquivo.nome,
      aoComecar: (inicio) =>
        this.leitura.registrarAcessoAoAudio(id, arquivo, {
          baixar: false,
          versao: v,
          usuarioId: usuario.id,
          inicio,
        }),
    });
  }

  @Get(':id/audio/baixar')
  @ApiOperation({
    summary: 'Baixa a gravação (só Admin e líderes)',
    description:
      'Como `…/audio`, mas como anexo. Os demais recebem 403. O download é auditado.',
  })
  @ApiProduces('audio/ogg', 'audio/webm')
  @ApiResponse({ status: 200, description: 'O arquivo.' })
  @ApiRespostasDeErro(400, 403, 404, 503)
  async baixar(
    @Param('id', ParseIdPipe) id: string,
    @Query('versao') versao: string | undefined,
    @Req() requisicao: Request,
    @Res() resposta: Response,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<void> {
    const v = versaoDe(versao);
    const arquivo = await this.leitura.arquivoDoAudio(usuario, id, {
      baixar: true,
      versao: v,
    });
    await servir(this.arquivos, arquivo, requisicao, resposta, {
      disposicao: 'attachment',
      nome: arquivo.nome,
      aoComecar: (inicio) =>
        this.leitura.registrarAcessoAoAudio(id, arquivo, {
          baixar: true,
          versao: v,
          usuarioId: usuario.id,
          inicio,
        }),
    });
  }

  @Post(':id/reprocessar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Reprocessa a gravação (conversão, transcrição e resumo) ou só o resumo',
    description:
      'Só o atendente da ligação, o Admin e os líderes. Os estados voltam a `pendente` e o `ligacao.processada` avisa o fim. 409 se a ligação já está sendo processada, se não tem gravação ou se a guarda já a apagou.',
  })
  @ApiRespostasDeErro(400, 403, 404, 409)
  async reprocessar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ReprocessarDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<{ aceita: true }> {
    await this.reprocessamento.reprocessar(usuario, id, dto?.etapa);
    return { aceita: true };
  }

  @Post(':id/resumo/sugestoes/:sugestaoId/confirmar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirma uma sugestão de atividade do resumo (cria a atividade)',
    description:
      'A atividade só existe depois desta confirmação. O corpo (opcional) ajusta título, descrição, tipo, vencimento e responsável. Cada sugestão vale uma vez (409).',
  })
  @ApiOkResponse({ type: RespostaDeSugestaoDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  confirmar(
    @Param('id', ParseIdPipe) id: string,
    @Param('sugestaoId', ParseIdPipe) sugestaoId: string,
    @Body() dto: ConfirmarSugestaoDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RespostaDeSugestaoDto> {
    return this.sugestoes.confirmar(usuario, id, sugestaoId, dto ?? {});
  }

  @Post(':id/resumo/sugestoes/:sugestaoId/descartar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descarta uma sugestão de atividade do resumo' })
  @ApiOkResponse({ type: RespostaDeSugestaoDto })
  @ApiRespostasDeErro(404, 409)
  descartar(
    @Param('id', ParseIdPipe) id: string,
    @Param('sugestaoId', ParseIdPipe) sugestaoId: string,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<RespostaDeSugestaoDto> {
    return this.sugestoes.descartar(usuario, id, sugestaoId);
  }

  @Get('canais/:canalId/aviso')
  @ApiOperation({
    summary:
      'Áudio de aviso do canal (o navegador toca para o cliente ao atender)',
    description:
      'Para quem usa o Atendimento. 404 se o canal não tem aviso. O Admin sobe o áudio em `POST /arquivos?contexto=LIGACAO` e liga com `PATCH /whatsapp-oficial/canais/:canalId/ligacoes {avisoArquivoId}`.',
  })
  @ApiProduces('audio/*')
  @ApiRespostasDeErro(404)
  async aviso(
    @Param('canalId', ParseIdPipe) canalId: string,
    @Req() requisicao: Request,
    @Res() resposta: Response,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<void> {
    exigirAtendimento(usuario);
    const arquivo = await this.leitura.arquivoDoAviso(canalId);
    await servir(this.arquivos, arquivo, requisicao, resposta, {
      disposicao: 'inline',
      nome: arquivo.nome,
      cache: 'private, max-age=300',
    });
  }
}
