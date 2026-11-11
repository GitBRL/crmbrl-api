import { Body, Controller, Delete, Put } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UsuarioAtual } from '../auth/decorators';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../comum/erros/documentacao-erros';
import { DefinirFotoDto, FotoDePerfilDto } from './dto/foto-de-perfil.dto';
import { FotoDePerfilService } from './foto-de-perfil.service';

/** A própria foto de perfil (R2.10): todo usuário logado, no Meu perfil. */
@ApiTags('Usuários')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('usuarios/eu/foto')
export class FotoDePerfilController {
  constructor(private readonly fotos: FotoDePerfilService) {}

  @Put()
  @ApiOperation({
    summary: 'Troca a própria foto de perfil',
    description:
      'Envie a imagem antes com `POST /arquivos?contexto=AVATAR` e passe o `id` aqui. Arquivo inexistente ou de outra pessoa: 404; enviado em outro contexto: 422 (R2.10). A foto anterior enviada pelo CRM é removida.',
  })
  @ApiOkResponse({ type: FotoDePerfilDto })
  @ApiRespostasDeErro(400, 404, 422)
  definir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: DefinirFotoDto,
  ): Promise<FotoDePerfilDto> {
    return this.fotos.definir(usuario, dto.arquivoId);
  }

  @Delete()
  @ApiOperation({
    summary: 'Remove a própria foto de perfil',
    description:
      'Volta às iniciais do nome. A foto enviada pelo CRM é removida.',
  })
  @ApiOkResponse({ type: FotoDePerfilDto })
  remover(
    @UsuarioAtual() usuario: UsuarioAutenticado,
  ): Promise<FotoDePerfilDto> {
    return this.fotos.definir(usuario, null);
  }
}
