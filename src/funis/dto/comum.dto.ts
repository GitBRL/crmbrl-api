import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import type { Utm } from '../../comum/dominio/utm';
import { TipoEtapa } from '../../generated/prisma/client';
import type { Area } from '../../comum/dominio/setores';

/**
 * Campo opcional que, quando vem, não pode ser `null` (o `@IsOptional` do
 * class-validator deixaria passar `null` sem validar). Para campos que aceitam
 * `null` (limpar o valor), use `@IsOptional()`.
 */
export function OpcionalNaoNulo(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateIf(
    (_objeto: object, valor: unknown) => valor !== undefined,
    opcoes,
  );
}

/** Apara textos vindos do cliente (o resto passa como veio, para a validação acusar). */
export function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** `'true'`/`'false'` da query string → booleano (o resto passa, para a validação acusar). */
export function lerBooleano({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}

export class ResumoUsuarioDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;
}

export class ResumoFunilDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Comercial' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  area: Area;
}

export class ResumoEtapaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Proposta' })
  nome: string;

  @ApiProperty({ enum: TipoEtapa, enumName: 'TipoEtapa' })
  tipo: TipoEtapa;

  @ApiProperty({ example: 4 })
  ordem: number;
}

export class ResumoContatoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Lima' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  email: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'E.164 só com dígitos.',
    example: '5511987654321',
  })
  telefone: string | null;

  @ApiProperty({ type: [String], example: ['VIP'] })
  etiquetas: string[];
}

export class ResumoEmpresaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ACME Ltda.' })
  nome: string;
}

/** UTM da origem (R4.3): `source`, `medium`, `campaign`, `term` e `content`. */
export class UtmDto implements Utm {
  @ApiPropertyOptional({ example: 'google' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  source?: string;

  @ApiPropertyOptional({ example: 'cpc' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  medium?: string;

  @ApiPropertyOptional({ example: 'black-friday' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  campaign?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  term?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  content?: string;
}
