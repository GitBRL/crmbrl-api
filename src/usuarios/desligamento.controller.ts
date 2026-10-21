import {
  Body,
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
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { DesligamentoService } from './desligamento.service';
import {
  ConsultaPreviaDesligamentoDto,
  DesligarUsuarioDto,
  PreviaDesligamentoDto,
  ReativarUsuarioDto,
  ResultadoDesligamentoDto,
} from './dto/desligamento.dto';
import { UsuarioDto } from './dto/usuario.dto';

/** Desligamento com encaminhamento e reativação (R7) — só o Admin (R7.1). */
@ApiTags('Usuários')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('usuarios')
export class DesligamentoController {
  constructor(private readonly desligamento: DesligamentoService) {}

  @Get(':id/desligamento/previa')
  @ApiOperation({
    summary: 'Prévia do desligamento: quem recebe e quanto',
    description:
      'Antes de confirmar (R7.1): o destinatário calculado (R7.2) e o que vai para ele — atividades pendentes, ' +
      'negócios abertos, contatos, empresas e liderados. C-level desligado: `exigeEscolha` e os `candidatos`.',
  })
  @ApiOkResponse({ type: PreviaDesligamentoDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  previa(
    @UsuarioAtual() admin: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() consulta: ConsultaPreviaDesligamentoDto,
  ): Promise<PreviaDesligamentoDto> {
    return this.desligamento.previa(admin, id, consulta.destinatarioId);
  }

  @Post(':id/desligar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desliga o usuário e encaminha o que estava com ele',
    description:
      'Numa única transação (R7.3): corta o acesso e revoga as sessões, transfere atividades pendentes, negócios ' +
      'abertos, contatos e empresas ao destinatário (R7.2), passa os liderados para ele, tira o usuário dos ' +
      'rodízios, notifica o destinatário e audita com as contagens; publica `usuario.desligado` (R7.4). ' +
      'Já desligado: 409 (R7.6).',
  })
  @ApiOkResponse({ type: ResultadoDesligamentoDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  desligar(
    @UsuarioAtual() admin: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DesligarUsuarioDto,
  ): Promise<ResultadoDesligamentoDto> {
    return this.desligamento.desligar(admin, id, dto);
  }

  @Post(':id/reativar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reativa um usuário desligado',
    description:
      'Exige um líder válido para o papel (R7.5, R1.2) e não devolve o que foi encaminhado. Já ativo: 409.',
  })
  @ApiOkResponse({ type: UsuarioDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  reativar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ReativarUsuarioDto,
  ): Promise<UsuarioDto> {
    return this.desligamento.reativar(id, dto);
  }
}
