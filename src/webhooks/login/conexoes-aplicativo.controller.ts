import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  Papeis,
  Publico,
  SemVerificacaoDeOrigem,
  UsuarioAtual,
} from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { InicioDoLoginDto } from '../facebook/facebook.dto';
import {
  ConexaoDeAplicativoDto,
  FiltroConexoesDto,
  IniciarLoginDeAplicativoDto,
} from './conexoes-aplicativo.dto';
import { ConexoesAplicativoService } from './conexoes-aplicativo.service';

/**
 * Conexões de aplicativo por login (R32.25 Typeform, R32.26 RD Station), só para o Admin. As
 * integrações usam a conexão pelo `configuracao.conexaoId` (em `POST /webhooks/entradas`).
 */
@ApiTags('Conexões de aplicativo')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('conexoes-aplicativo')
export class ConexoesAplicativoController {
  constructor(private readonly conexoes: ConexoesAplicativoService) {}

  @Get()
  @ApiOperation({
    summary: 'Conexões (sem tokens), de um aplicativo ou de todos',
  })
  @ApiOkResponse({ type: [ConexaoDeAplicativoDto] })
  listar(
    @Query() filtro: FiltroConexoesDto,
  ): Promise<ConexaoDeAplicativoDto[]> {
    return this.conexoes.listar(filtro.aplicativo);
  }

  @Post('oauth/iniciar')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '"Entrar com o Typeform / RD Station": monta a URL do diálogo',
    description:
      'Usa o app cadastrado em Configurações > Apps de login (422 se ainda não foi cadastrado). Cria a conexão (ou reaproveita `conexaoId`, para reconectar) e devolve `urlDialogo` com `state` assinado, de uso único, válido por 10 minutos e vinculado ao Admin. Depois do diálogo, o serviço chama `GET /publico/conexoes/oauth/retorno`, que troca o `code` e volta para `/retorno-login?app=typeform|rd-station&resultado=conectado|cancelado|erro&conexao=<id>[&motivo&mensagem]` (modo `janela`) ou `/integracoes?typeform|rd-station=…&conexao=<id>` (modo `pagina`, o padrão).',
  })
  @ApiCreatedResponse({ type: InicioDoLoginDto })
  @ApiRespostasDeErro(400, 404, 422)
  iniciar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: IniciarLoginDeAplicativoDto,
  ): Promise<InicioDoLoginDto> {
    return this.conexoes.iniciarLogin(usuario, dto);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Uma conexão',
    description:
      'A tela do assistente consulta esta rota (a cada 3 s, por até 10 min) como reserva do aviso da janela de login: `conectada: true` quer dizer que o login terminou.',
  })
  @ApiOkResponse({ type: ConexaoDeAplicativoDto })
  @ApiRespostasDeErro(404)
  detalhar(
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConexaoDeAplicativoDto> {
    return this.conexoes.detalhar(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Exclui a conexão e apaga os tokens',
    description:
      '409 se alguma integração ainda a usa ou se o CRM não conseguiu remover do serviço o webhook de uma integração já excluída (`?descartarPendencias=true` exclui mesmo assim; o webhook fica no serviço).',
  })
  @ApiQuery({ name: 'descartarPendencias', required: false, type: Boolean })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404, 409)
  excluir(
    @Param('id', ParseIdPipe) id: string,
    @Query('descartarPendencias') descartarPendencias?: string,
  ): Promise<void> {
    return this.conexoes.excluir(id, descartarPendencias === 'true');
  }
}

/** O retorno do diálogo do Typeform e do RD Station (sem login do CRM; o `state` assinado é a prova). */
@ApiTags('Conexões de aplicativo')
@Publico()
@SemVerificacaoDeOrigem()
@Controller('publico/conexoes')
export class ConexoesAplicativoPublicoController {
  constructor(private readonly conexoes: ConexoesAplicativoService) {}

  @Get('oauth/retorno')
  @ApiOperation({
    summary: 'Retorno do "Entrar com o Typeform / RD Station"',
    description:
      'Confere o `state` (assinado, de uso único, até 10 minutos), troca o `code`, guarda os tokens e o nome da conta e redireciona (302) para o front: `/retorno-login?app=…&resultado=…&conexao=<id>` (modo `janela`) ou `/integracoes?typeform|rd-station=…&conexao=<id>` (modo `pagina`). Em erro, `motivo` é `state_invalido`, `state_vencido`, `state_usado`, `sem_codigo`, `app_nao_cadastrado`, `servico_recusou`/`servico_indisponivel` (com `mensagem`) ou o `error` do serviço (ex.: `access_denied`, com `resultado=cancelado`).',
  })
  @ApiQuery({ name: 'code', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'error', required: false })
  @ApiFoundResponse({ description: 'Redireciona para o front.' })
  async retorno(
    @Query() consulta: Record<string, unknown>,
    @Res() resposta: Response,
  ): Promise<void> {
    const { destino } = await this.conexoes.concluirLogin(consulta);
    resposta.setHeader('Cache-Control', 'no-store');
    resposta.setHeader('Referrer-Policy', 'no-referrer');
    resposta.redirect(HttpStatus.FOUND, destino);
  }
}
