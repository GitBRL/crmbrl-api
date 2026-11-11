import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { UsuarioAtual } from '../../auth/decorators';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ApiRespostasDeErro } from '../erros/documentacao-erros';
import { analisarModelo } from './modelos';
import { ModelosService } from './modelos.service';

export class PreviaDeModeloDto {
  @ApiProperty({ example: '{Olá|Oi} {{contato.primeiro_nome|cliente}}!' })
  @IsString()
  @MaxLength(10_000)
  texto: string;

  @ApiPropertyOptional({
    description:
      'Contato da prévia. Sem ele (e sem negócio), usa dados de exemplo.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'Informe um id válido.' })
  contatoId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', { message: 'Informe um id válido.' })
  negocioId?: string;

  @ApiPropertyOptional({
    description: 'Semente das variações (a mesma semente, o mesmo sorteio).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  semente?: string;

  @ApiPropertyOptional({
    description: 'Valores de `{{variaveis.*}}`.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  variaveis?: Record<string, unknown>;
}

export class ErroDeModeloDto {
  @ApiProperty({ example: 'Variável desconhecida: {{contato.apelido}}.' })
  mensagem: string;
  @ApiProperty() inicio: number;
  @ApiProperty() fim: number;
  @ApiPropertyOptional() variavel?: string;
}

export class PreviaDeModeloRespostaDto {
  @ApiProperty({ example: 'Oi Ana!' })
  texto: string;
  @ApiProperty({ type: [ErroDeModeloDto] })
  erros: ErroDeModeloDto[];
  @ApiProperty({ type: [String], example: ['contato.primeiro_nome'] })
  variaveis: string[];
  @ApiProperty({ example: 1 })
  variacoes: number;
}

/** Editor de modelos de mensagem (Onda B, §2.1): variáveis disponíveis e prévia. */
@ApiTags('Modelos de mensagem')
@ApiCookieAuth()
@ApiRespostasDeErro(401)
@Controller('modelos')
export class ModelosController {
  constructor(private readonly modelos: ModelosService) {}

  @Get('variaveis')
  @ApiOperation({
    summary: 'Variáveis dos modelos de mensagem',
    description:
      'Variáveis fixas (com rótulo e exemplo) e as chaves de campos personalizados em uso (`{{contato.campos.<chave>}}`).',
  })
  @ApiOkResponse({
    description:
      '`{ variaveis: [{ chave, rotulo, exemplo }], camposPersonalizados: { contato, empresa, negocio } }`',
  })
  variaveis() {
    return this.modelos.catalogo();
  }

  @Post('previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida e renderiza um modelo',
    description:
      'Renderiza para o contato (ou negócio) informado, ou com dados de exemplo. Variáveis desconhecidas e erros de sintaxe voltam em `erros`, com a posição no texto.',
  })
  @ApiOkResponse({ type: PreviaDeModeloRespostaDto })
  @ApiRespostasDeErro(400, 404)
  async previa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: PreviaDeModeloDto,
  ): Promise<PreviaDeModeloRespostaDto> {
    if (dto.negocioId) {
      // R5.9: a prévia não mostra dados de negócio de funil que a pessoa não vê (404).
      await this.modelos.exigirNegocioVisivel(usuario, dto.negocioId);
    }
    const { texto, erros } = await this.modelos.renderizarPara(
      dto.texto,
      {
        contatoId: dto.contatoId,
        negocioId: dto.negocioId,
        variaveis: dto.variaveis,
      },
      { semente: dto.semente },
    );
    const { variaveis, variacoes } = analisarModelo(dto.texto);
    return { texto, erros, variaveis, variacoes };
  }
}
