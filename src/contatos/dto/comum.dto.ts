import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Utm } from '../../comum/dominio/utm';
import { OrigemContato, Papel } from '../../generated/prisma/client';
import {
  TAMANHO_MAXIMO_BUSCA,
  TAMANHO_MAXIMO_TEXTO_CURTO,
} from '../contatos.constantes';

/** Usuário ligado a um contato ou empresa (responsável, quem criou). */
export class UsuarioVinculadoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Lima' })
  nome: string;

  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ description: 'Falso para quem foi desligado.' })
  ativo: boolean;

  static de(usuario: {
    id: string;
    nome: string;
    papel: Papel;
    ativo: boolean;
  }): UsuarioVinculadoDto {
    return {
      id: usuario.id,
      nome: usuario.nome,
      papel: usuario.papel,
      ativo: usuario.ativo,
    };
  }
}

/** Empresa ligada a um contato. */
export class EmpresaVinculadaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME Ltda' })
  nome: string;
}

/** Parâmetros UTM de uma origem (R4.3). Na entrada, chaves desconhecidas são recusadas. */
export class UtmOrigemDto {
  @ApiPropertyOptional({ example: 'google' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  source?: string;

  @ApiPropertyOptional({ example: 'cpc' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  medium?: string;

  @ApiPropertyOptional({ example: 'black-friday' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  campaign?: string;

  @ApiPropertyOptional({ example: 'crm para pequenas empresas' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  term?: string;

  @ApiPropertyOptional({ example: 'banner-topo' })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  content?: string;

  static de(utm: Utm | null): UtmOrigemDto | null {
    return utm ? { ...utm } : null;
  }
}

/** Primeira origem do contato (R4.3): imutável. */
export class OrigemContatoDto {
  @ApiProperty({ enum: OrigemContato, enumName: 'OrigemContato' })
  tipo: OrigemContato;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Ex.: o nome do webhook de entrada.',
    example: 'Landing Black Friday',
  })
  detalhe: string | null;

  @ApiProperty({ type: () => UtmOrigemDto, nullable: true })
  utm: UtmOrigemDto | null;
}

/** Última origem do contato (R4.3): muda a cada reconversão. */
export class UltimaOrigemContatoDto extends OrigemContatoDto {
  @ApiProperty({ format: 'date-time' })
  em: string;
}

/** Consentimento LGPD (R4.6): de onde veio e quando. */
export class ConsentimentoContatoDto {
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  em: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Formulário do site',
  })
  origem: string | null;
}

/** Consentimento informado na criação ou edição do contato (R4.6). */
export class ConsentimentoEntradaDto {
  @ApiProperty({
    example: 'Formulário do site',
    description: 'De onde veio o consentimento.',
    maxLength: TAMANHO_MAXIMO_TEXTO_CURTO,
  })
  @IsString({ message: 'deve ser um texto' })
  @Matches(/\S/, { message: 'é obrigatória' })
  @MaxLength(TAMANHO_MAXIMO_TEXTO_CURTO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TEXTO_CURTO} caracteres`,
  })
  origem: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Quando o titular consentiu (padrão: agora). Não pode ser no futuro.',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'deve ser uma data no formato ISO 8601' },
  )
  em?: string;
}

/** Etiqueta em uso, para filtros e autocompletar (R4.7). */
export class EtiquetaEmUsoDto {
  @ApiProperty({
    example: 'VIP',
    description:
      'A grafia mais usada (a comparação não diferencia maiúsculas).',
  })
  etiqueta: string;

  @ApiProperty({ example: 12 })
  quantidade: number;
}

export class FiltroEtiquetasDto {
  @ApiPropertyOptional({
    description: 'Começo da etiqueta (sem diferenciar maiúsculas).',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_BUSCA, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_BUSCA} caracteres`,
  })
  busca?: string;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(500, { message: 'deve ser no máximo 500' })
  limite: number = 100;
}
