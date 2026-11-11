import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { rotuloDoPapel, setorDaPessoa } from '../../comum/dominio/papeis';
import { type Area, nomeDoSetor } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import { Papel } from '../../generated/prisma/client';
import { aparar } from './transformacoes';

/** Quantas pessoas a busca devolve no máximo. */
export const LIMITE_DE_OPCOES_DE_PESSOAS = 50;

/**
 * Busca de pessoas para os editores de acessos (R5.11): quem configura funil ou
 * setor (Admin, C-level e líderes) acha qualquer pessoa ativa, de qualquer setor.
 */
export class FiltroOpcoesDePessoasDto {
  @ApiPropertyOptional({
    description: 'Trecho do nome (sem diferença de maiúsculas).',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  busca?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    description: 'Só os líderes e membros do setor (chave).',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area;

  @ApiPropertyOptional({
    description: `Quantas pessoas (padrão 20, máx. ${LIMITE_DE_OPCOES_DE_PESSOAS}).`,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(LIMITE_DE_OPCOES_DE_PESSOAS, {
    message: `deve ser no máximo ${LIMITE_DE_OPCOES_DE_PESSOAS}`,
  })
  limite: number = 20;
}

/** Uma pessoa ativa como opção de escolha: só o resumo (sem e-mail, telefone nem equipe). */
export class OpcaoDePessoaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  @ApiProperty({
    enum: Papel,
    enumName: 'Papel',
    description: 'O nível (`ADMIN`, `C_LEVEL`, `LIDER`, `MEMBRO`).',
  })
  papel: Papel;

  @ApiProperty({ example: 'Líder Comercial' })
  rotuloPapel: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'COMERCIAL',
    description: 'Setor (chave); nulo para Admin e C-level.',
  })
  area: Area | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Comercial',
    description: 'Nome do setor; nulo para Admin e C-level.',
  })
  nomeSetor: string | null;

  static de(pessoa: {
    id: string;
    nome: string;
    avatarUrl: string | null;
    papel: Papel;
    area: string | null;
  }): OpcaoDePessoaDto {
    const area = setorDaPessoa(pessoa);
    return {
      id: pessoa.id,
      nome: pessoa.nome,
      avatarUrl: pessoa.avatarUrl,
      papel: pessoa.papel,
      rotuloPapel: rotuloDoPapel(pessoa.papel, area),
      area,
      nomeSetor: area ? nomeDoSetor(area) : null,
    };
  }
}
