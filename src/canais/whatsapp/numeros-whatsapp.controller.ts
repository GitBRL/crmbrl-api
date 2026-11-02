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
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import type {
  EstadoDoNumero,
  ResultadoDaVerificacao,
} from './contrato-gateway';
import {
  AtualizarNumeroWhatsappDto,
  CriarNumeroWhatsappDto,
  DesconectarNumeroWhatsappDto,
  EnviosDoNumeroNoDiaDto,
  EstadoDoNumeroWhatsappDto,
  FiltroEnviosDoNumeroDto,
  NumeroWhatsappDto,
  PausarNumeroWhatsappDto,
  VerificacaoDeTelefoneDto,
  VerificarTelefoneWhatsappDto,
} from './dto/numeros-whatsapp.dto';
import { NumerosWhatsappService } from './numeros-whatsapp.service';

/**
 * Números de WhatsApp (R13): cadastro (cada número é um canal `WHATSAPP` do
 * Atendimento), conexão pelo QR, limites e proteções anti-banimento, pausa.
 * Só o Admin.
 *
 * Conectar responde `202` na hora: o QR e as mudanças de status chegam ao
 * vivo pelo evento `whatsapp.conexao` do tempo real (`{ numeroId, canalId,
 * status, qr?, qrExpiraEm?, telefone?, motivo? }`, só para quem gerencia
 * canais). `GET …/status` devolve o estado atual com o QR, para quem abriu a
 * tela depois.
 */
@ApiTags('WhatsApp')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Papeis('ADMIN')
@Controller('whatsapp/numeros')
export class NumerosWhatsappController {
  constructor(private readonly numeros: NumerosWhatsappService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os números de WhatsApp' })
  @ApiOkResponse({ type: [NumeroWhatsappDto] })
  listar(): Promise<NumeroWhatsappDto[]> {
    return this.numeros.listar();
  }

  @Post()
  @ApiOperation({
    summary: 'Cadastra um número (e o canal dele); depois, conecte pelo QR',
    description:
      'Cria o canal WHATSAPP do Atendimento e a configuração do número: fila das conversas novas, limite diário, ritmo entre envios, aquecimento e proteções. O telefone só é conhecido depois da leitura do QR.',
  })
  @ApiCreatedResponse({ type: NumeroWhatsappDto })
  @ApiRespostasDeErro(400, 409)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    return this.numeros.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalha um número (status gravado, limites, aquecimento, envios de hoje)',
  })
  @ApiOkResponse({ type: NumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(@Param('id', ParseIdPipe) id: string): Promise<NumeroWhatsappDto> {
    return this.numeros.detalhar(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita nome, fila, ativo, limites, ritmo, aquecimento e proteções',
    description:
      'Vale a partir do próximo envio (o gateway lê a configuração a cada mensagem). As proteções são parciais: o que não vier fica como está.',
  })
  @ApiOkResponse({ type: NumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 409)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    return this.numeros.atualizar(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o número: desvincula do WhatsApp e exclui o canal',
    description: 'As conversas continuam no histórico do Atendimento.',
  })
  @ApiNoContentResponse({ description: 'Excluído.' })
  @ApiRespostasDeErro(400, 404)
  async excluir(@Param('id', ParseIdPipe) id: string): Promise<void> {
    await this.numeros.excluir(id);
  }

  @Post(':id/conectar')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Inicia a conexão: o QR chega pelo evento whatsapp.conexao',
    description:
      'Idempotente. Número com credenciais guardadas reconecta sem QR. Reconectar tira a pausa automática (erro grave, banimento, falhas seguidas).',
  })
  @ApiAcceptedResponse({ type: EstadoDoNumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 503)
  conectar(@Param('id', ParseIdPipe) id: string): Promise<EstadoDoNumero> {
    return this.numeros.conectar(id);
  }

  @Post(':id/desconectar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desconecta; com sair, desvincula (o celular remove o aparelho)',
  })
  @ApiOkResponse({ type: EstadoDoNumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 503)
  desconectar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DesconectarNumeroWhatsappDto,
  ): Promise<EstadoDoNumero> {
    return this.numeros.desconectar(id, dto);
  }

  @Get(':id/status')
  @ApiOperation({
    summary: 'Estado ao vivo no gateway, com o QR enquanto espera a leitura',
  })
  @ApiOkResponse({ type: EstadoDoNumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 503)
  status(@Param('id', ParseIdPipe) id: string): Promise<EstadoDoNumero> {
    return this.numeros.status(id);
  }

  @Post(':id/verificar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confere se um telefone tem WhatsApp (cache de 7 dias)',
    description: 'O número precisa estar conectado (409 se não estiver).',
  })
  @ApiOkResponse({ type: VerificacaoDeTelefoneDto })
  @ApiRespostasDeErro(400, 404, 409, 503)
  verificar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: VerificarTelefoneWhatsappDto,
  ): Promise<ResultadoDaVerificacao> {
    return this.numeros.verificar(id, dto.telefone);
  }

  @Post(':id/pausar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pausa os envios do número (as mensagens esperam na fila)',
  })
  @ApiOkResponse({ type: NumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 409)
  pausar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: PausarNumeroWhatsappDto,
  ): Promise<NumeroWhatsappDto> {
    return this.numeros.pausar(id, dto);
  }

  @Post(':id/retomar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tira a pausa (manual ou automática)' })
  @ApiOkResponse({ type: NumeroWhatsappDto })
  @ApiRespostasDeErro(400, 404, 409)
  retomar(@Param('id', ParseIdPipe) id: string): Promise<NumeroWhatsappDto> {
    return this.numeros.retomar(id);
  }

  @Get(':id/envios')
  @ApiOperation({
    summary:
      'Envios por dia (São Paulo), com o limite de cada dia (aquecimento)',
  })
  @ApiOkResponse({ type: [EnviosDoNumeroNoDiaDto] })
  @ApiRespostasDeErro(400, 404)
  envios(
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroEnviosDoNumeroDto,
  ): Promise<EnviosDoNumeroNoDiaDto[]> {
    return this.numeros.envios(id, filtro.dias);
  }
}
