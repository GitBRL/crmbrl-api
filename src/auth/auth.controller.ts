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
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { definirUsuarioDoContexto } from '../comum/contexto/contexto-requisicao';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { type RequisicaoHttp, truncar } from '../comum/http/requisicao-http';
import { LimitadorDeRequisicoes } from '../canais/comum/limitador';
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
  ConcluirEntradaDto,
  ConsultaTokenDto,
  DesafioDoisFatoresDto,
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

/** Limites das rotas públicas de senha, por IP (e por e-mail no pedido de link). */
export const LIMITES_DE_SENHA = {
  /** Pedidos de link de redefinição por IP. */
  esqueciPorIp: { limite: 10, janelaMs: 15 * 60_000 },
  /** Pedidos de link por e-mail (conta igual exista o e-mail ou não). */
  esqueciPorEmail: { limite: 3, janelaMs: 15 * 60_000 },
  /** Consulta e uso do token por IP: impede adivinhar tokens. */
  tokenPorIp: { limite: 30, janelaMs: 15 * 60_000 },
} as const;

/** Login, sessão e senha (R2). */
@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly senhas: SenhasService,
    private readonly adaptador: HttpAdapterHost,
    private readonly limitador: LimitadorDeRequisicoes,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  @Post('entrar')
  @Publico()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Entra com e-mail e senha',
    description:
      'Abre a sessão e devolve o cookie `crmbrl_sessao` (HttpOnly). Credenciais erradas: 401 com mensagem genérica; ' +
      'usuário desligado: 403; 5 falhas em 15 min bloqueiam o e-mail por 15 min (429, R2.5). Com verificação em ' +
      'duas etapas ativa (R2.11), a resposta é `{ doisFatoresNecessario: true, desafio, expiraEm }` e a sessão só ' +
      'nasce em `auth/entrar/dois-fatores`.',
  })
  @ApiExtraModels(PerfilDto, DesafioDoisFatoresDto)
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PerfilDto) },
        { $ref: getSchemaPath(DesafioDoisFatoresDto) },
      ],
    },
  })
  @ApiRespostasDeErro(400, 401, 403, 429)
  async entrar(
    @Body() dto: EntrarDto,
    @Req() requisicao: RequisicaoHttp,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<PerfilDto | DesafioDoisFatoresDto> {
    const resultado = await this.auth.entrar(dto, {
      ...this.metadados(requisicao),
      tokenAnterior: lerCookie(requisicao, NOME_COOKIE_SESSAO),
    });
    if (resultado.tipo === 'dois_fatores') {
      return {
        doisFatoresNecessario: true,
        desafio: resultado.desafio,
        expiraEm: resultado.expiraEm,
      };
    }
    return this.abrirCookie(resultado, resposta);
  }

  @Post('entrar/dois-fatores')
  @Publico()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Segunda etapa do login: código do aplicativo ou de recuperação',
    description:
      'Abre a sessão e devolve o cookie. O desafio vale 5 minutos e aceita 5 códigos errados; erros contam na ' +
      'força bruta (R2.5). Código de recuperação vale uma vez.',
  })
  @ApiOkResponse({ type: PerfilDto })
  @ApiRespostasDeErro(400, 401, 403, 429)
  async entrarComDoisFatores(
    @Body() dto: ConcluirEntradaDto,
    @Req() requisicao: RequisicaoHttp,
    @Res({ passthrough: true }) resposta: Response,
  ): Promise<PerfilDto> {
    this.limitador.exigir(
      `entrar-2fa:ip:${requisicao.ip ?? '?'}`,
      LIMITES_DE_SENHA.tokenPorIp,
      'Muitas tentativas de verificação.',
    );
    const resultado = await this.auth.concluirEntrada(dto, {
      ...this.metadados(requisicao),
      tokenAnterior: lerCookie(requisicao, NOME_COOKIE_SESSAO),
    });
    return this.abrirCookie(resultado, resposta);
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
  @ApiRespostasDeErro(400, 422, 429)
  async esqueciSenha(
    @Body() dto: EsqueciSenhaDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<MensagemDto> {
    const mensagem = 'Muitos pedidos de redefinição.';
    this.limitador.exigir(
      `senha-esqueci:ip:${requisicao.ip ?? '?'}`,
      LIMITES_DE_SENHA.esqueciPorIp,
      mensagem,
    );
    this.limitador.exigir(
      `senha-esqueci:email:${dto.email.trim().toLowerCase()}`,
      LIMITES_DE_SENHA.esqueciPorEmail,
      mensagem,
    );
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
  @ApiRespostasDeErro(400, 429)
  consultarToken(
    @Body() dto: TokenDeSenhaDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<ConsultaTokenDto> {
    this.limitarToken(requisicao);
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
  @ApiRespostasDeErro(400, 422, 429)
  async redefinirSenha(
    @Body() dto: RedefinirSenhaDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<void> {
    this.limitarToken(requisicao);
    await this.senhas.redefinirComToken(dto.token, dto.novaSenha);
  }

  private abrirCookie(
    {
      token,
      sessaoId,
      perfil,
    }: { token: string; sessaoId: string; perfil: PerfilDto },
    resposta: Response,
  ): PerfilDto {
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

  private limitarToken(requisicao: RequisicaoHttp): void {
    this.limitador.exigir(
      `senha-token:ip:${requisicao.ip ?? '?'}`,
      LIMITES_DE_SENHA.tokenPorIp,
      'Muitas tentativas com links de senha.',
    );
  }

  private metadados(requisicao: RequisicaoHttp): MetadadosDoLogin {
    return {
      ip: requisicao.ip,
      userAgent: truncar(requisicao.get('user-agent'), 500),
    };
  }
}
