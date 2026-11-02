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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { EtiquetaEmUsoDto, FiltroEtiquetasDto } from './dto/comum.dto';
import {
  AtualizarEmpresaDto,
  CriarEmpresaDto,
  EmpresaDto,
  FiltroEmpresasDto,
} from './dto/empresa.dto';
import {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from './dto/linha-do-tempo.dto';
import { EmpresasService } from './empresas.service';

/** Empresas (R4.4, R4.5, R4.7) e a linha do tempo delas (R3.5). */
@ApiTags('Empresas')
@ApiCookieAuth()
@ApiRespostasDeErro(401, 403)
@Controller('empresas')
export class EmpresasController {
  constructor(private readonly empresas: EmpresasService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista as empresas, com busca, filtros e paginação',
    description:
      'Busca por nome, CNPJ (com ou sem pontuação), e-mail ou telefone; filtros por responsável, etiqueta e UF.',
  })
  @ApiRespostaPaginada(EmpresaDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroEmpresasDto,
  ): Promise<Pagina<EmpresaDto>> {
    return this.empresas.listar(usuario, filtro);
  }

  @Get('etiquetas')
  @ApiOperation({ summary: 'Etiquetas em uso nas empresas' })
  @ApiOkResponse({ type: [EtiquetaEmUsoDto] })
  @ApiRespostasDeErro(400)
  etiquetas(@Query() filtro: FiltroEtiquetasDto): Promise<EtiquetaEmUsoDto[]> {
    return this.empresas.etiquetasEmUso(filtro);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Cria uma empresa',
    description:
      'Nome obrigatório; CNPJ opcional, validado pelos dígitos verificadores e único (409 se já houver outra empresa com ele, R4.4).',
  })
  @ApiCreatedResponse({ type: EmpresaDto })
  @ApiRespostasDeErro(400, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarEmpresaDto,
  ): Promise<EmpresaDto> {
    return this.empresas.criar(usuario, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalha uma empresa' })
  @ApiOkResponse({ type: EmpresaDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<EmpresaDto> {
    return this.empresas.detalhar(usuario, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita uma empresa',
    description:
      'Admin e C-level editam todas; o líder, as que têm responsável na equipe; o membro, as suas (§12).',
  })
  @ApiOkResponse({ type: EmpresaDto })
  @ApiRespostasDeErro(400, 404, 409, 422)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarEmpresaDto,
  ): Promise<EmpresaDto> {
    return this.empresas.atualizar(usuario, id, dto);
  }

  @Get(':id/linha-do-tempo')
  @ApiOperation({
    summary: 'Linha do tempo da empresa: auditoria e atividades (R3.5)',
  })
  @ApiRespostaPaginada(RegistroDaLinhaDoTempoDto)
  @ApiRespostasDeErro(400, 404)
  linhaDoTempo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Query() filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    return this.empresas.linhaDoTempo(usuario, id, filtro);
  }
}
