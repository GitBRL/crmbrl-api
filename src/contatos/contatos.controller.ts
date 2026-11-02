import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { ContatosService } from './contatos.service';
import { EtiquetaEmUsoDto, FiltroEtiquetasDto } from './dto/comum.dto';
import {
  AnonimizarContatoDto,
  AtualizarContatoDto,
  ContatoDto,
  CriarContatoDto,
  FiltroContatosDto,
  ResultadoCriacaoContatoDto,
} from './dto/contato.dto';
import {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from './dto/linha-do-tempo.dto';

/**
 * Contatos (R4) e a linha do tempo deles (R3.5). Todos os usuários veem os
 * contatos; editar segue a matriz §12; anonimizar, só o Admin (R4.6).
 */
@ApiTags('Contatos')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('contatos')
export class ContatosController {
  constructor(private readonly contatos: ContatosService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os contatos, com busca, filtros e paginação',
    description:
      'Busca por nome, e-mail ou telefone; filtros por responsável, empresa, origem (primeira e última), etiqueta e opt-out (R4.6). Contatos anonimizados não aparecem.',
  })
  @ApiRespostaPaginada(ContatoDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroContatosDto,
  ): Promise<Pagina<ContatoDto>> {
    return this.contatos.listar(usuario, filtro);
  }

  @Get('etiquetas')
  @ApiOperation({
    summary: 'Etiquetas em uso nos contatos (para filtros e autocompletar)',
  })
  @ApiOkResponse({ type: [EtiquetaEmUsoDto] })
  @ApiRespostasDeErro(400)
  etiquetas(@Query() filtro: FiltroEtiquetasDto): Promise<EtiquetaEmUsoDto[]> {
    return this.contatos.etiquetasEmUso(filtro);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Cria um contato (ou reconverte o existente)',
    description:
      'Com o e-mail ou o telefone de um contato ativo, não cria outro: completa os campos vazios, atualiza a última origem e registra `contato.reconvertido` (R4.2). Responde 201 nos dois casos; `criado` diz qual foi.',
  })
  @ApiCreatedResponse({ type: ResultadoCriacaoContatoDto })
  @ApiRespostasDeErro(400, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarContatoDto,
  ): Promise<ResultadoCriacaoContatoDto> {
    return this.contatos.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha um contato' })
  @ApiOkResponse({ type: ContatoDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ContatoDto> {
    return this.contatos.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita um contato',
    description:
      'Admin e C-level editam todos; o líder, os que têm responsável na equipe; o membro, os seus (§12). E-mail e telefone continuam únicos (409) e sobra pelo menos um (R4.1).',
  })
  @ApiOkResponse({ type: ContatoDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarContatoDto,
  ): Promise<ContatoDto> {
    return this.contatos.atualizar(usuario, id, dto);
  }

  @Post(':id/anonimizar')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Exclui o contato com anonimização (LGPD, só Admin)',
    description:
      'Exclusão lógica (R4.6): apaga os dados pessoais, liga o opt-out e registra `contato.anonimizado` na auditoria, sem os dados apagados. Não tem volta.',
  })
  @ApiNoContentResponse({ description: 'Contato anonimizado.' })
  @ApiRespostasDeErro(400, 404)
  async anonimizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AnonimizarContatoDto,
  ): Promise<void> {
    await this.contatos.anonimizar(usuario, id, dto);
  }

  @Get(':id/dados-pessoais')
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Exporta os dados pessoais do contato (LGPD art. 18, só Admin)',
    description:
      'Devolve em JSON o contato, o consentimento, os identificadores de canal, os negócios, as atividades e as conversas com as mensagens. A consulta é auditada (`contato.dados-exportados`), sem os dados.',
  })
  @ApiRespostasDeErro(403, 404)
  dadosPessoais(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.contatos.dadosPessoais(usuario, id);
  }

  @Get(':id/linha-do-tempo')
  @ApiOperation({
    summary: 'Linha do tempo do contato: auditoria e atividades (R3.5)',
    description:
      'Eventos de auditoria ligados ao contato e as atividades dele (e dos negócios dele), mais recentes primeiro. Atividades e eventos de negócio seguem a visibilidade de quem pede (R6.4, R5.9).',
  })
  @ApiRespostaPaginada(RegistroDaLinhaDoTempoDto)
  @ApiRespostasDeErro(400, 404)
  linhaDoTempo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    return this.contatos.linhaDoTempo(usuario, id, filtro);
  }
}
