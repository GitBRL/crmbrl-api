import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { definirUsuarioDoContexto } from '../comum/contexto/contexto-requisicao';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { type RequisicaoHttp, truncar } from '../comum/http/requisicao-http';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { AuthService, type MetadadosDoLogin } from './auth.service';
import {
  lerCookie,
  NOME_COOKIE_SESSAO,
  opcoesDoCookieDeSessao,
} from './cookies';
import {
  PermitirTrocaDeSenhaPendente,
  Publico,
  UsuarioAtual,
} from './decorators';
import {
  ConsultaTokenDto,
  EntrarDto,
  EsqueciSenhaDto,
  MensagemDto,
  PerfilDto,
  RedefinirSenhaDto,
  TokenDeSenhaDto,
  TrocarSenhaDto,
} from './dto/auth.dto';
import { SenhasService } from './senhas.service';
import type { UsuarioAutenticado } from './usuario-autenticado';

/** Login, sessão e senha (R2). */
@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly senhas: SenhasService,
    private readonly adaptador: HttpAdapterHost,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  @Post('entrar')
  @Publico()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Entra com e-mail e senha',
    description:
      'Abre a sessão e devolve o cookie `crmbrl_sessao` (HttpOnly). Credenciais erradas: 401 com mensagem genérica; ' +
      'usuário desligado: 403; 5 falhas em 15 min bloqueiam o e-mail por 15 min (429, R2.5).',
  })
  @ApiOkResponse({ type: PerfilDto })
  @ApiRespostasDeErro(400, 401, 403, 429)
  async entrar(
    @Body() dto: EntrarDto,
    @Req() requisicao: RequisicaoHttp,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<PerfilDto> {
    const { token, sessaoId, perfil } = await this.auth.entrar(dto, {
      ...this.metadados(requisicao),
      tokenAnterior: lerCookie(requisicao, NOME_COOKIE_SESSAO),
    });
    this.adaptador.httpAdapter.setCookie?.(
      resposta,
      NOME_COOKIE_SESSAO,
      token,
      opcoesDoCookieDeSessao(this.ambiente),
    );
    // O log HTTP desta requisição já sai com quem entrou.
    definirUsuarioDoContexto(
      {
        id: perfil.usuario.id,
        papel: perfil.usuario.papel,
        nome: perfil.usuario.nome,
      },
      sessaoId,
    );
    return perfil;
  }

  @Post('sair')
  @PermitirTrocaDeSenhaPendente()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Encerra a sessão atual' })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(401)
  async sair(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<void> {
    await this.auth.sair(usuario);
    this.adaptador.httpAdapter.clearCookie?.(
      resposta,
      NOME_COOKIE_SESSAO,
      opcoesDoCookieDeSessao(this.ambiente),
    );
  }

  @Get('eu')
  @PermitirTrocaDeSenhaPendente()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Quem está logado: usuário, papel, área e permissões',
    description:
      'Funciona com troca de senha pendente (R2.7): o front usa `deveTrocarSenha` para levar à troca.',
  })
  @ApiOkResponse({ type: PerfilDto })
  @ApiRespostasDeErro(401)
  eu(@UsuarioAtual() usuario: UsuarioAutenticado): Promise<PerfilDto> {
    return this.auth.perfil(usuario.id, usuario.sessaoId);
  }

  @Post('senha')
  @PermitirTrocaDeSenhaPendente()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Troca a própria senha',
    description:
      'Inclui a troca obrigatória do primeiro acesso. Encerra as outras sessões do usuário.',
  })
  @ApiOkResponse({ type: PerfilDto })
  @ApiRespostasDeErro(400, 401, 429)
  trocarSenha(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: TrocarSenhaDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<PerfilDto> {
    return this.auth.trocarSenha(usuario, dto, this.metadados(requisicao));
  }

  @Post('senha/esqueci')
  @Publico()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Pede o link de redefinição de senha por e-mail',
    description:
      'Responde igual exista o e-mail ou não. Exige SMTP configurado (422 R2.8 sem ele).',
  })
  @ApiAcceptedResponse({ type: MensagemDto })
  @ApiRespostasDeErro(400, 422)
  async esqueciSenha(@Body() dto: EsqueciSenhaDto): Promise<MensagemDto> {
    await this.senhas.solicitarRedefinicao(dto.email);
    return {
      mensagem:
        'Se o e-mail estiver cadastrado e ativo, enviaremos um link para redefinir a senha.',
    };
  }

  @Post('senha/token')
  @Publico()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confere se o link de convite ou de redefinição ainda vale',
  })
  @ApiOkResponse({ type: ConsultaTokenDto })
  @ApiRespostasDeErro(400)
  consultarToken(@Body() dto: TokenDeSenhaDto): Promise<ConsultaTokenDto> {
    return this.senhas.consultarToken(dto.token);
  }

  @Post('senha/redefinir')
  @Publico()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Define a senha pelo link do convite ou da redefinição',
    description:
      'O token é de uso único e vale 24 horas. Encerra todas as sessões do usuário.',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 422)
  async redefinirSenha(@Body() dto: RedefinirSenhaDto): Promise<void> {
    await this.senhas.redefinirComToken(dto.token, dto.novaSenha);
  }

  private metadados(requisicao: RequisicaoHttp): MetadadosDoLogin {
    return {
      ip: requisicao.ip,
      userAgent: truncar(requisicao.get('user-agent'), 500),
    };
  }
}
