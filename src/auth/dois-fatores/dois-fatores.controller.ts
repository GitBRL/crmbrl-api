import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { type RequisicaoHttp, truncar } from '../../comum/http/requisicao-http';
import { UsuarioAtual } from '../decorators';
import type { UsuarioAutenticado } from '../usuario-autenticado';
import {
  AtivacaoDoisFatoresDto,
  CodigoDto,
  CodigosRecuperacaoDto,
  DesativarDoisFatoresDto,
  SituacaoDoisFatoresDto,
} from './dois-fatores.dto';
import { DoisFatoresService } from './dois-fatores.service';

/** Verificação em duas etapas da própria conta (R2.11). */
@ApiTags('Autenticação')
@ApiCookieAuth()
@Controller('auth/dois-fatores')
export class DoisFatoresController {
  constructor(private readonly doisFatores: DoisFatoresService) {}

  @Get()
  @ApiOperation({ summary: 'Situação da verificação em duas etapas' })
  @ApiOkResponse({ type: SituacaoDoisFatoresDto })
  @ApiRespostasDeErro(401)
  situacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<SituacaoDoisFatoresDto> {
    return this.doisFatores.situacao(usuario.id);
  }

  @Post('ativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Começa a ativação: gera o segredo, o QR e a chave',
    description:
      'Só vale depois de confirmada com um código (`confirmar`). Chamar de novo antes de confirmar troca o segredo. 422 (R2.11) se já está ativa.',
  })
  @ApiOkResponse({ type: AtivacaoDoisFatoresDto })
  @ApiRespostasDeErro(401, 422)
  ativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<AtivacaoDoisFatoresDto> {
    return this.doisFatores.iniciarAtivacao(usuario);
  }

  @Post('confirmar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirma a ativação com um código e devolve os códigos de recuperação',
    description:
      'Os 10 códigos aparecem só nesta resposta. Código errado conta na força bruta (R2.5).',
  })
  @ApiOkResponse({ type: CodigosRecuperacaoDto })
  @ApiRespostasDeErro(400, 401, 422, 429)
  async confirmar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CodigoDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<CodigosRecuperacaoDto> {
    return {
      codigos: await this.doisFatores.confirmarAtivacao(
        usuario,
        dto.codigo,
        this.meta(requisicao),
      ),
    };
  }

  @Post('codigos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gera novos códigos de recuperação',
    description:
      'Pede um código do aplicativo. Os códigos antigos deixam de valer.',
  })
  @ApiOkResponse({ type: CodigosRecuperacaoDto })
  @ApiRespostasDeErro(400, 401, 422, 429)
  async novosCodigos(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CodigoDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<CodigosRecuperacaoDto> {
    return {
      codigos: await this.doisFatores.gerarNovosCodigos(
        usuario,
        dto.codigo,
        this.meta(requisicao),
      ),
    };
  }

  @Post('desativar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Desativa a verificação em duas etapas',
    description:
      'Pede a senha atual e um código (do aplicativo ou de recuperação).',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(400, 401, 422, 429)
  desativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: DesativarDoisFatoresDto,
    @Req() requisicao: RequisicaoHttp,
  ): Promise<void> {
    return this.doisFatores.desativar(
      usuario,
      dto.senha,
      dto.codigo,
      this.meta(requisicao),
    );
  }

  private meta(requisicao: RequisicaoHttp): {
    ip?: string;
    userAgent?: string;
  } {
    return {
      ip: requisicao.ip,
      userAgent: truncar(requisicao.get('user-agent'), 500),
    };
  }
}
