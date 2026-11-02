import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  ContagemNaoLidasDto,
  FiltroNotificacoesDto,
  MarcadasComoLidasDto,
  NotificacaoDto,
  PaginaNotificacoesDto,
} from './notificacoes.dto';
import { NotificacoesService } from './notificacoes.service';

/** Notificações do próprio usuário (R10.2). */
@ApiTags('Notificações')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('notificacoes')
export class NotificacoesController {
  constructor(private readonly notificacoes: NotificacoesService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as notificações do usuário (mais novas primeiro)',
  })
  @ApiOkResponse({ type: PaginaNotificacoesDto })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroNotificacoesDto,
  ): Promise<PaginaNotificacoesDto> {
    return this.notificacoes.listar(usuario.id, filtro);
  }

  @Get('nao-lidas/contagem')
  @ApiOperation({ summary: 'Conta as notificações não lidas (para o sino)' })
  @ApiOkResponse({ type: ContagemNaoLidasDto })
  async contarNaoLidas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<ContagemNaoLidasDto> {
    return { naoLidas: await this.notificacoes.contarNaoLidas(usuario.id) };
  }

  @Post('marcar-todas-lidas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marca todas as notificações do usuário como lidas',
  })
  @ApiOkResponse({ type: MarcadasComoLidasDto })
  async marcarTodasComoLidas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<MarcadasComoLidasDto> {
    return {
      marcadas: await this.notificacoes.marcarTodasComoLidas(usuario.id),
    };
  }

  @Post(':id/marcar-lida')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca uma notificação como lida' })
  @ApiOkResponse({ type: NotificacaoDto })
  @ApiRespostasDeErro(400, 404)
  marcarComoLida(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<NotificacaoDto> {
    return this.notificacoes.marcarComoLida(usuario.id, id);
  }
}
