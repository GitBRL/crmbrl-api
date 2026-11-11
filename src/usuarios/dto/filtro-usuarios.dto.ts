import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import { Papel } from '../../generated/prisma/client';
import { MENSAGEM_PAPEL, MENSAGEM_UUID } from './criar-usuario.dto';
import { aparar, booleanoDaQuery, idEmMinusculas } from './transformacoes';
import type { Area } from '../../comum/dominio/setores';

/**
 * Filtros da lista de usuários. O recorte de visibilidade (R1.5) vale sempre:
 * o líder só recebe a própria equipe e o membro, a si mesmo.
 */
export class FiltroUsuariosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Trecho do nome ou do e-mail (sem diferença de maiúsculas).',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  busca?: string;

  @ApiPropertyOptional({ enum: Papel, enumName: 'Papel' })
  @IsOptional()
  @IsEnum(Papel, { message: MENSAGEM_PAPEL })
  papel?: Papel;

  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    description: 'Líderes e membros do setor (chave).',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area;

  @ApiPropertyOptional({
    description:
      'Só ativos (`true`) ou só desligados (`false`). Sem o filtro, todos.',
  })
  @IsOptional()
  @Transform(booleanoDaQuery)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Liderados de um usuário.',
  })
  @IsOptional()
  @Transform(idEmMinusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  liderId?: string;
}
