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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ArquivoRecebido } from '../../arquivos/armazenamento-multer';
import { Publico, SemVerificacaoDeOrigem } from '../../auth/decorators';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { responderArquivoPublico } from '../comum/arquivos-publicos';
import {
  AcessoDoWidgetGuard,
  ChatDoSite,
  type RequisicaoDoWidget,
} from './acesso-do-widget';
import {
  AnexoDoVisitanteEntradaDto,
  ConfiguracaoPublicaDto,
  HistoricoDoVisitanteDto,
  HistoricoPublicoDto,
  LinkDoArquivoDto,
  MensagemDoVisitanteEntradaDto,
  MensagemEnviadaDto,
  NovoVisitanteDto,
  SessaoDoVisitanteDto,
  TokenDoVisitanteDto,
  VisitanteCriadoDto,
} from './webchat.dto';
import { type CanalWebchat, WebchatService } from './webchat.service';
import { WidgetDoSite } from './widget.service';

const CHAVE = {
  name: 'chave',
  description: 'Chave pública do canal (`data-chave` do trecho de instalação).',
  example: 'wc_3k9f0QeZb1x7Lm2N8pRt5vW4',
};

/**
 * Rotas públicas do chat do site (§2.5, R14), usadas pelo widget: sem sessão
 * (`@Publico`) e sem a verificação de origem do CRM — a origem é conferida
 * contra os domínios do canal pelo `AcessoDoWidgetGuard`, que também aplica o
 * limite de requisições e responde o CORS. O token do visitante vai sempre no
 * corpo (formulário), nunca na URL.
 */
@ApiTags('Chat do site (público)')
@Publico()
@SemVerificacaoDeOrigem()
@Controller('publico/webchat')
export class WebchatPublicoController {
  constructor(
    private readonly webchat: WebchatService,
    private readonly widget: WidgetDoSite,
  ) {}

  @Get('widget.js')
  @ApiOperation({
    summary: 'O script do widget (JavaScript, sem dependências)',
    description:
      'Cole no site: `<script src=".../api/v1/publico/webchat/widget.js" data-chave="wc_…" async></script>`.',
  })
  @ApiProduces('application/javascript')
  @ApiOkResponse({ description: 'O script.' })
  widgetJs(@Req() requisicao: Request, @Res() resposta: Response): void {
    const { conteudo, etag } = this.widget.obter();
    resposta.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    });
    if (requisicao.headers['if-none-match'] === etag) {
      resposta.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    resposta.send(conteudo);
  }

  @Get(':chave/configuracao')
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary:
      'Aparência, formulário e horário do chat (para o widget se desenhar)',
  })
  @ApiParam(CHAVE)
  @ApiOkResponse({ type: ConfiguracaoPublicaDto })
  @ApiRespostasDeErro(403, 404, 429)
  configuracao(@ChatDoSite() canal: CanalWebchat): ConfiguracaoPublicaDto {
    return this.webchat.configuracaoPublica(canal);
  }

  @Post(':chave/visitantes')
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary: 'Formulário inicial: cria o visitante e devolve o token',
    description:
      'Nome, e-mail e/ou telefone (conforme o canal) e o consentimento (LGPD, obrigatório). O contato é encontrado ou criado (R4.2) com o consentimento e as UTMs da página.',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiParam(CHAVE)
  @ApiCreatedResponse({ type: VisitanteCriadoDto })
  @ApiRespostasDeErro(400, 403, 404, 429)
  registrar(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: NovoVisitanteDto,
    @Req() requisicao: RequisicaoDoWidget,
  ): Promise<VisitanteCriadoDto> {
    return this.webchat.registrarVisitante(canal, dto, {
      ip: requisicao.ip,
      userAgent: requisicao.get('user-agent'),
    });
  }

  @Post(':chave/sessao')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary: 'Retoma a conversa do visitante (as últimas mensagens)',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiParam(CHAVE)
  @ApiOkResponse({ type: SessaoDoVisitanteDto })
  @ApiRespostasDeErro(400, 401, 403, 404, 429)
  async sessao(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: TokenDoVisitanteDto,
  ): Promise<SessaoDoVisitanteDto> {
    const visitante = await this.webchat.autenticar(canal.canal, dto.token);
    return this.webchat.sessao(canal.canal, visitante);
  }

  @Post(':chave/historico')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({ summary: 'Mensagens anteriores (paginação para cima)' })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiParam(CHAVE)
  @ApiOkResponse({ type: HistoricoPublicoDto })
  @ApiRespostasDeErro(400, 401, 403, 404, 429)
  async historico(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: HistoricoDoVisitanteDto,
  ): Promise<HistoricoPublicoDto> {
    const visitante = await this.webchat.autenticar(canal.canal, dto.token);
    return this.webchat.historico(canal.canal, visitante, dto.antes);
  }

  @Post(':chave/mensagens')
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary: 'O visitante envia uma mensagem de texto',
    description:
      'Entra no Atendimento como mensagem do contato (conversa nova ou a aberta). Com `idCliente`, repetir o envio não duplica. Até 20 por minuto por visitante (429).',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiParam(CHAVE)
  @ApiCreatedResponse({ type: MensagemEnviadaDto })
  @ApiRespostasDeErro(400, 401, 403, 404, 429)
  async enviar(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: MensagemDoVisitanteEntradaDto,
  ): Promise<MensagemEnviadaDto> {
    const visitante = await this.webchat.autenticar(canal.canal, dto.token);
    return {
      mensagem: await this.webchat.enviarTexto(
        canal.canal,
        visitante,
        dto.texto,
        dto.idCliente,
      ),
    };
  }

  @Post(':chave/anexos')
  @UseGuards(AcessoDoWidgetGuard)
  @UseInterceptors(FileInterceptor('arquivo'))
  @ApiOperation({
    summary:
      'O visitante envia um arquivo (multipart: `token` antes de `arquivo`)',
    description:
      'Imagens, PDF, documentos, áudio, vídeo e zip até 10 MB (SVG e HTML recusados, 415). Até 10 a cada 10 minutos por visitante.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description:
      'Campos na ordem: `token`, `idCliente?`, `texto?` e por último `arquivo`.',
    schema: {
      type: 'object',
      required: ['token', 'arquivo'],
      properties: {
        token: { type: 'string' },
        idCliente: { type: 'string' },
        texto: { type: 'string' },
        arquivo: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiParam(CHAVE)
  @ApiCreatedResponse({ type: MensagemEnviadaDto })
  @ApiRespostasDeErro(400, 401, 403, 404, 413, 415, 429)
  async anexar(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: AnexoDoVisitanteEntradaDto,
    @Req() requisicao: RequisicaoDoWidget,
    @UploadedFile() recebido?: ArquivoRecebido,
  ): Promise<MensagemEnviadaDto> {
    const visitante = requisicao.visitanteDoUpload;
    if (!recebido?.arquivoSalvo || !visitante) {
      throw new DadosInvalidosException('Envie o arquivo no campo "arquivo".', {
        campos: [{ campo: 'arquivo', mensagens: ['é obrigatório'] }],
      });
    }
    return {
      mensagem: await this.webchat.enviarAnexo(
        canal.canal,
        visitante,
        recebido.arquivoSalvo,
        dto.texto,
        dto.idCliente,
      ),
    };
  }

  @Post(':chave/sair')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary: 'O visitante encerra: o token deixa de valer neste navegador',
    description: 'A conversa continua no Atendimento.',
  })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiParam(CHAVE)
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 401, 403, 404, 429)
  async sair(
    @ChatDoSite() canal: CanalWebchat,
    @Body() dto: TokenDoVisitanteDto,
  ): Promise<void> {
    const visitante = await this.webchat.autenticar(canal.canal, dto.token);
    await this.webchat.encerrar(visitante);
  }

  @Get(':chave/arquivos/:id')
  @UseGuards(AcessoDoWidgetGuard)
  @ApiOperation({
    summary: 'Anexo da conversa pelo link assinado (vale 24 h)',
    description: 'O link vem pronto em `mensagem.arquivo.url`.',
  })
  @ApiParam(CHAVE)
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ description: 'O conteúdo do arquivo.' })
  @ApiRespostasDeErro(400, 403, 404, 429)
  async arquivo(
    @ChatDoSite() canal: CanalWebchat,
    @Param('id', ParseIdPipe) id: string,
    @Query() link: LinkDoArquivoDto,
    @Res() resposta: Response,
  ): Promise<void> {
    const { arquivo, stream } = await this.webchat.abrirArquivo(
      canal.canal,
      id,
      link,
    );
    await responderArquivoPublico(resposta, arquivo, stream);
  }
}
