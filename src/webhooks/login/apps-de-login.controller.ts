import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import type { AplicativoDeLogin } from '../../generated/prisma/client';
import {
  APLICATIVOS_DE_LOGIN,
  AppDeLoginDto,
  GravarAppDeLoginDto,
} from './apps-de-login.dto';
import { AppsDeLoginService } from './apps-de-login.service';
import { ParseAplicativoDeLoginPipe } from './parse-aplicativo.pipe';

/**
 * Apps de login (R32.22), só do Admin: o app da Meta, do Typeform e do RD Station, cadastrados uma
 * vez e usados por todas as conexões ("Entrar com…"). O segredo é cifrado e nunca devolvido.
 */
@ApiTags('Apps de login')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('configuracoes/apps-de-login')
export class AppsDeLoginController {
  constructor(private readonly apps: AppsDeLoginService) {}

  @Get()
  @ApiOperation({
    summary: 'Os três apps de login (Meta, Typeform e RD Station)',
    description:
      'Sempre os três, configurados ou não: ID, segredo mascarado, endereço de retorno a cadastrar no app do serviço, quanto está em uso e (Meta) o webhook de páginas e os escopos.',
  })
  @ApiOkResponse({ type: [AppDeLoginDto] })
  listar(): Promise<AppDeLoginDto[]> {
    return this.apps.listar();
  }

  @Put(':aplicativo')
  @ApiParam({ name: 'aplicativo', enum: APLICATIVOS_DE_LOGIN })
  @ApiOperation({
    summary: 'Cadastra ou atualiza o app de um serviço',
    description:
      'O segredo é obrigatório na primeira gravação e ao trocar o `clientId`; nas demais, ausente mantém o atual. Meta: o par é conferido na Graph (422 se recusado). Trocar o `clientId` de um app em uso exige `confirmarTroca: true` (senão 409 com o que está em uso); trocar só o segredo leva o novo às cópias das conexões e dos canais, na mesma transação.',
  })
  @ApiOkResponse({ type: AppDeLoginDto })
  @ApiRespostasDeErro(400, 409, 422)
  gravar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('aplicativo', ParseAplicativoDeLoginPipe)
    aplicativo: AplicativoDeLogin,
    @Body() dto: GravarAppDeLoginDto,
  ): Promise<AppDeLoginDto> {
    return this.apps.gravar(usuario, aplicativo, dto);
  }

  @Delete(':aplicativo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'aplicativo', enum: APLICATIVOS_DE_LOGIN })
  @ApiOperation({
    summary: 'Remove o app de um serviço',
    description:
      '409 enquanto houver conexão, canal ou integração usando o app.',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404, 409)
  remover(
    @Param('aplicativo', ParseAplicativoDeLoginPipe)
    aplicativo: AplicativoDeLogin,
  ): Promise<void> {
    return this.apps.remover(aplicativo);
  }
}
