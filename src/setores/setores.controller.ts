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
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type { Area } from '../comum/dominio/setores';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ParseAreaPipe } from '../funis/parse-area.pipe';
import {
  AtualizarSetorDto,
  CriarSetorDto,
  FiltroSetoresDto,
  SetorDto,
} from './dto/setores.dto';
import { SetoresService } from './setores.service';

const PARAMETRO_CHAVE = {
  name: 'chave',
  description: 'Chave do setor (ex.: `COMERCIAL`, `POS_VENDA`).',
  example: 'COMERCIAL',
} as const;

/** Setores (R1.6–R1.11). */
@ApiTags('Setores')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('setores')
export class SetoresController {
  constructor(private readonly setores: SetoresService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os setores (as opções dos seletores)',
    description:
      'Todo usuário autenticado recebe os ativos, em ordem. Admin e C-level podem pedir os inativos (`incluirInativos`) e recebem também os líderes e as contagens.',
  })
  @ApiOkResponse({ type: [SetorDto] })
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroSetoresDto,
  ): Promise<SetorDto[]> {
    return this.setores.listar(usuario, filtro);
  }

  @Post()
  @Papeis('ADMIN', 'C_LEVEL')
  @ApiOperation({
    summary: 'Cria um setor com funil-base, rodízio e líderes (R1.7)',
    description:
      'Só Admin e C-level. Numa transação: o setor (chave gerada do nome), o funil-base dele (Novo → Em andamento → Ganho/Perdido), a regra de rodízio e os líderes escolhidos (viram `LIDER` do setor, respondendo ao C-level responsável). Nome repetido entre os ativos → 409 (R1.8); líder com liderados → 409 com a lista (R1.3).',
  })
  @ApiCreatedResponse({ type: SetorDto })
  @ApiRespostasDeErro(400, 403, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarSetorDto,
  ): Promise<SetorDto> {
    return this.setores.criar(usuario, dto);
  }

  @Get(':chave')
  @ApiOperation({
    summary: 'Detalha um setor',
    description: 'Os inativos só para Admin e C-level (404 para os demais).',
  })
  @ApiParam(PARAMETRO_CHAVE)
  @ApiOkResponse({ type: SetorDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('chave', ParseAreaPipe) chave: Area,
  ): Promise<SetorDto> {
    return this.setores.detalhar(usuario, chave);
  }

  @Patch(':chave')
  @Papeis('ADMIN', 'C_LEVEL')
  @ApiOperation({
    summary: 'Edita nome, descrição, cor e ordem de um setor (R1.11)',
    description:
      'Só Admin e C-level. A chave não muda; os setores de base também podem ser renomeados. Nome repetido entre os ativos → 409 (R1.8).',
  })
  @ApiParam(PARAMETRO_CHAVE)
  @ApiOkResponse({ type: SetorDto })
  @ApiRespostasDeErro(400, 403, 404, 409)
  atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('chave', ParseAreaPipe) chave: Area,
    @Body() dto: AtualizarSetorDto,
  ): Promise<SetorDto> {
    return this.setores.atualizar(usuario, chave, dto);
  }

  @Post(':chave/desativar')
  @HttpCode(HttpStatus.OK)
  @Papeis('ADMIN', 'C_LEVEL')
  @ApiOperation({
    summary: 'Desativa um setor criado (R1.10)',
    description:
      'Só Admin e C-level, e nunca um setor de base (422). O setor precisa estar vazio: com pessoas, funis ou filas de atendimento ativos → 409 com as listas (`usuarios`, `funis`, `filas`). Inativo, some das listas de escolha e continua nos registros antigos.',
  })
  @ApiParam(PARAMETRO_CHAVE)
  @ApiOkResponse({ type: SetorDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  desativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('chave', ParseAreaPipe) chave: Area,
  ): Promise<SetorDto> {
    return this.setores.desativar(usuario, chave);
  }

  @Post(':chave/reativar')
  @HttpCode(HttpStatus.OK)
  @Papeis('ADMIN', 'C_LEVEL')
  @ApiOperation({
    summary: 'Reativa um setor (R1.10)',
    description:
      'Só Admin e C-level. Nome repetido entre os ativos → 409 (R1.8): renomeie o outro antes.',
  })
  @ApiParam(PARAMETRO_CHAVE)
  @ApiOkResponse({ type: SetorDto })
  @ApiRespostasDeErro(400, 403, 404, 409)
  reativar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('chave', ParseAreaPipe) chave: Area,
  ): Promise<SetorDto> {
    return this.setores.reativar(usuario, chave);
  }
}
