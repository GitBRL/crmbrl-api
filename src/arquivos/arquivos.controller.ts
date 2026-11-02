import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import type { ArquivoRecebido } from './armazenamento-multer';
import {
  ArquivoDto,
  CorpoDoEnvioDto,
  DownloadDeArquivoDto,
  EnvioDeArquivoDto,
} from './arquivos.dto';
import { ArquivosService } from './arquivos.service';
import { interpretarFaixa } from './faixa';
import { cabecalhoContentDisposition, podeExibirNoNavegador } from './politica';

/** Campo do formulário multipart com o arquivo. */
export const CAMPO_DO_ARQUIVO = 'arquivo';

/**
 * Envio e download de arquivos (R11). O conteúdo só sai pela API, com a
 * permissão do item a que o arquivo pertence; a chave do bucket nunca aparece.
 */
@ApiTags('Arquivos')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('arquivos')
export class ArquivosController {
  constructor(private readonly arquivos: ArquivosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor(CAMPO_DO_ARQUIVO))
  @ApiOperation({
    summary: 'Envia um arquivo (multipart, campo "arquivo")',
    description:
      'Tipos aceitos: imagem, áudio, vídeo, PDF, Office/OpenDocument, texto e zip (SVG e HTML são recusados, 415). ' +
      'Limites: 25 MB; documentos 100 MB; foto de perfil 5 MB (413). Depois, use o `id` na mensagem, no chat ou no perfil.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CorpoDoEnvioDto })
  @ApiCreatedResponse({ type: ArquivoDto })
  @ApiRespostasDeErro(400, 413, 415, 503)
  enviar(
    @Query() _consulta: EnvioDeArquivoDto,
    @UploadedFile() recebido?: ArquivoRecebido,
  ): ArquivoDto {
    if (!recebido?.arquivoSalvo) {
      throw new DadosInvalidosException(
        `Envie o arquivo no campo "${CAMPO_DO_ARQUIVO}".`,
        {
          campos: [{ campo: CAMPO_DO_ARQUIVO, mensagens: ['é obrigatório'] }],
        },
      );
    }
    return ArquivoDto.de(recebido.arquivoSalvo);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Baixa (ou abre) um arquivo',
    description:
      'Imagens comuns, áudio, vídeo e PDF abrem no navegador (`inline`); o resto é baixado (`attachment`). ' +
      'Aceita `Range` (206) para o player e `If-None-Match` (304). Quem não pode ver o item recebe 404.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'O conteúdo do arquivo.' })
  @ApiResponse({ status: 206, description: 'A faixa de bytes pedida.' })
  @ApiResponse({ status: 304, description: 'Não mudou (ETag).' })
  @ApiResponse({ status: 416, description: 'Faixa fora do arquivo.' })
  @ApiRespostasDeErro(400, 404, 503)
  async baixar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() consulta: DownloadDeArquivoDto,
    @Req() requisicao: Request,
    @Res() resposta: Response,
  ): Promise<void> {
    const arquivo = await this.arquivos.obterParaUsuario(usuario, id);
    const etag = `"${arquivo.sha256}"`;
    const exibir = !consulta.download && podeExibirNoNavegador(arquivo.mime);
    resposta.set({
      'Content-Type': arquivo.mime,
      'Content-Disposition': cabecalhoContentDisposition(
        arquivo.nome,
        exibir ? 'inline' : 'attachment',
      ),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ETag: etag,
      'Accept-Ranges': 'bytes',
      ...(arquivo.mime === 'application/pdf'
        ? {}
        : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
    });

    if (requisicao.headers['if-none-match'] === etag) {
      resposta.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }

    // `If-Range` com outra versão: devolve o arquivo inteiro.
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
    const tamanho = parcial
      ? parcial.fim - parcial.inicio + 1
      : arquivo.tamanho;
    if (requisicao.method === 'HEAD') {
      resposta
        .status(parcial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK)
        .set('Content-Length', String(tamanho))
        .end();
      return;
    }
    const conteudo = await this.arquivos.abrirConteudo(arquivo, parcial);
    resposta.status(parcial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
    resposta.set('Content-Length', String(tamanho));
    if (parcial) {
      resposta.set(
        'Content-Range',
        `bytes ${parcial.inicio}-${parcial.fim}/${arquivo.tamanho}`,
      );
    }
    await pipeline(conteudo, resposta).catch(() => {
      // Conexão fechada pelo navegador (ex.: o player pulou para outro trecho).
      conteudo.destroy();
      resposta.destroy();
    });
  }
}
