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
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { ApiRespostaPaginada, type Pagina } from '../comum/paginacao/paginacao';
import { ParseIdPipe } from '../comum/validacao/parse-id.pipe';
import { AtualizarUsuarioDto } from './dto/atualizar-usuario.dto';
import { CriarUsuarioDto } from './dto/criar-usuario.dto';
import { EquipeDto, FiltroEquipesDto } from './dto/equipe.dto';
import { FiltroUsuariosDto } from './dto/filtro-usuarios.dto';
import { DefinirSenhaTemporariaDto } from './dto/senha-temporaria.dto';
import {
  ConviteEnviadoDto,
  UsuarioCriadoDto,
  UsuarioDto,
} from './dto/usuario.dto';
import { UsuariosService } from './usuarios.service';

/**
 * Usuários, papéis e hierarquia (R1) e senhas pelo Admin (R2.8). Ver segue a
 * visibilidade do R1.5; gerenciar é só do Admin.
 */
@ApiTags('Usuários')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuarios: UsuariosService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista os usuários que quem pede pode ver',
    description:
      'Admin e C-level veem todos; o líder, a própria equipe (ele e os liderados); o membro, a si mesmo (R1.5).',
  })
  @ApiRespostaPaginada(UsuarioDto)
  @ApiRespostasDeErro(400)
  listar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroUsuariosDto,
  ): Promise<Pagina<UsuarioDto>> {
    return this.usuarios.listar(usuario, filtro);
  }

  @Get('equipes')
  @Papeis('ADMIN', 'C_LEVEL', 'LIDER_COMERCIAL', 'LIDER_MARKETING', 'LIDER_CS')
  @ApiOperation({
    summary:
      'Visão de equipe: cada líder com quem responde a ele e a carga de trabalho',
    description:
      'O líder vê a própria equipe; Admin e C-level, todas (a do C-level reúne os líderes que respondem a ele). ' +
      'Cada pessoa traz atividades pendentes e atrasadas, negócios abertos (quantidade e valor) e contatos. ' +
      '`aguardandoNovoLider` marca quem responde provisoriamente ao destinatário de um desligamento (R7.3).',
  })
  @ApiOkResponse({ type: [EquipeDto] })
  @ApiRespostasDeErro(400, 403, 404)
  equipes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() filtro: FiltroEquipesDto,
  ): Promise<EquipeDto[]> {
    return this.usuarios.equipes(usuario, filtro);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalha um usuário',
    description: '404 para quem não pode ver o usuário (R1.5).',
  })
  @ApiOkResponse({ type: UsuarioDto })
  @ApiRespostasDeErro(400, 404)
  detalhar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<UsuarioDto> {
    return this.usuarios.detalhar(usuario, id);
  }

  @Post()
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Cria um usuário (só Admin)',
    description:
      'E-mail único, sem diferença de maiúsculas (R1.1); líder conforme o papel (R1.2). Com `senhaTemporaria`, ' +
      'a troca é obrigatória no primeiro acesso; sem ela, a API envia o convite por e-mail (exige SMTP: 422 R2.8).',
  })
  @ApiCreatedResponse({ type: UsuarioCriadoDto })
  @ApiRespostasDeErro(400, 403, 409, 422)
  criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarUsuarioDto,
  ): Promise<UsuarioCriadoDto> {
    return this.usuarios.criar(usuario, dto);
  }

  @Patch(':id')
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Edita um usuário (só Admin)',
    description:
      'Mudar o papel revalida a hierarquia: o líder do novo papel (R1.2), os liderados (R1.3: o erro lista quem ' +
      'precisa de novo líder) e o último Admin ativo, que não é rebaixado (R1.4).',
  })
  @ApiOkResponse({ type: UsuarioDto })
  @ApiRespostasDeErro(400, 403, 404, 409, 422)
  atualizar(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: AtualizarUsuarioDto,
  ): Promise<UsuarioDto> {
    return this.usuarios.atualizar(id, dto);
  }

  @Post(':id/senha-temporaria')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Define uma senha temporária (só Admin)',
    description:
      'Encerra as sessões do usuário e exige a troca no próximo acesso (R2.8).',
  })
  @ApiOkResponse({ type: UsuarioDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  definirSenhaTemporaria(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DefinirSenhaTemporariaDto,
  ): Promise<UsuarioDto> {
    return this.usuarios.definirSenhaTemporaria(usuario, id, dto);
  }

  @Post(':id/convite')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Envia (ou reenvia) o convite por e-mail (só Admin)',
    description:
      'Link de uso único, válido por 24 horas, para definir a senha; o anterior deixa de valer. Exige SMTP (422 R2.8).',
  })
  @ApiAcceptedResponse({ type: ConviteEnviadoDto })
  @ApiRespostasDeErro(400, 403, 404, 422)
  enviarConvite(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseIdPipe) id: string,
  ): Promise<ConviteEnviadoDto> {
    return this.usuarios.enviarConvite(usuario, id);
  }
}
