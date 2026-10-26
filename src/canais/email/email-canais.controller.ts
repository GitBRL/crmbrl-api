import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../../comum/erros/documentacao-erros';
import { ParseIdPipe } from '../../comum/validacao/parse-id.pipe';
import { EmailCanaisService } from './email-canais.service';
import {
  AtualizarCanalEmailDto,
  CanalEmailDto,
  ConexaoEmailEntradaDto,
  CriarCanalEmailDto,
  TestarCanalEmailDto,
  TesteDeConexaoEmailDto,
} from './email.dto';

/**
 * Configuração dos canais de e-mail (R14): só o Admin. As mensagens chegam
 * pela leitura do IMAP a cada minuto e as respostas saem pelo SMTP do canal.
 */
@ApiTags('Canais — e-mail')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('email/canais')
export class EmailCanaisController {
  constructor(private readonly canais: EmailCanaisService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os canais de e-mail' })
  @ApiOkResponse({ type: [CanalEmailDto] })
  listar(): Promise<CanalEmailDto[]> {
    return this.canais.listar();
  }

  @Post('testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testa IMAP e SMTP antes de salvar (nada é gravado)',
    description:
      'Conecta, autentica e abre a pasta no IMAP; conecta e autentica no SMTP. Cada lado responde `ok` e uma mensagem em português.',
  })
  @ApiOkResponse({ type: TesteDeConexaoEmailDto })
  @ApiRespostasDeErro(400)
  testarNovo(
    @Body() dto: ConexaoEmailEntradaDto,
  ): Promise<TesteDeConexaoEmailDto> {
    return this.canais.testarNovo(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um canal de e-mail (senhas mascaradas)' })
  @ApiOkResponse({ type: CanalEmailDto })
  @ApiRespostasDeErro(404)
  obter(@Param('id', ParseIdPipe) id: string): Promise<CanalEmailDto> {
    return this.canais.obter(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Cria um canal de e-mail',
    description:
      'Só as mensagens que chegarem depois da criação entram no Atendimento. O endereço é único entre os canais de e-mail (409).',
  })
  @ApiCreatedResponse({ type: CanalEmailDto })
  @ApiRespostasDeErro(400, 409)
  criar(
    @Body() dto: CriarCanalEmailDto,
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<CanalEmailDto> {
    return this.canais.criar(dto, usuario.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Altera o canal (senha ausente = mantém a gravada)',
    description:
      'Trocar a caixa (endereço, servidor, usuário ou pasta) recomeça a leitura a partir de agora.',
  })
  @ApiOkResponse({ type: CanalEmailDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarCanalEmailDto,
  ): Promise<CanalEmailDto> {
    return this.canais.atualizar(id, dto);
  }

  @Post(':id/testar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Testa a conexão do canal salvo',
    description: 'Campos enviados no corpo substituem os gravados só no teste.',
  })
  @ApiOkResponse({ type: TesteDeConexaoEmailDto })
  @ApiRespostasDeErro(400, 404)
  testar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: TestarCanalEmailDto,
  ): Promise<TesteDeConexaoEmailDto> {
    return this.canais.testarCanal(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o canal (a leitura para; as conversas ficam)',
  })
  @ApiNoContentResponse()
  @ApiRespostasDeErro(404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.canais.excluir(id);
  }
}
