import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  type Area,
  type CorDeSetor,
  CORES_DE_SETOR,
  TAMANHO_MAXIMO_DO_NOME,
} from '../../comum/dominio/setores';
import { UsuarioResumoDto } from '../../usuarios/dto/usuario.dto';
import { aparar, booleanoDaQuery } from '../../usuarios/dto/transformacoes';

const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';
const MENSAGEM_COR = `deve ser uma destas cores: ${CORES_DE_SETOR.join(', ')}`;
export const TAMANHO_MAXIMO_DESCRICAO = 500;
export const LIDERES_POR_SETOR_MAXIMO = 20;

/** Presente no corpo (mesmo que `null`, que então é recusado). */
const informado = (_objeto: object, valor: unknown): boolean =>
  valor !== undefined;

/** Texto aparado; vazio vira `null` (para campos opcionais que aceitam apagar). */
function apararOuNulo({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const texto = value.trim();
  return texto === '' ? null : texto;
}

/** `GET /setores`. */
export class FiltroSetoresDto {
  @ApiPropertyOptional({
    description:
      'Inclui os setores desativados (só Admin e C-level; ignorado para os demais).',
  })
  @IsOptional()
  @Transform(booleanoDaQuery)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirInativos?: boolean;
}

/** `POST /setores` (R1.7). */
export class CriarSetorDto {
  @ApiProperty({
    example: 'Pós-venda',
    maxLength: TAMANHO_MAXIMO_DO_NOME,
    description:
      'Único entre os setores ativos, sem diferenciar maiúsculas nem acentos (R1.8). A chave é gerada dele.',
  })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_DO_NOME, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_DO_NOME} caracteres`,
  })
  nome: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: TAMANHO_MAXIMO_DESCRICAO,
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_DESCRICAO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`,
  })
  descricao?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: CORES_DE_SETOR,
    description: 'Tom do selo do design system usado como cor do setor.',
  })
  @IsOptional()
  @IsIn(CORES_DE_SETOR, { message: MENSAGEM_COR })
  cor?: CorDeSetor | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10_000,
    description: 'Posição nas listas (padrão: depois do último).',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(10_000, { message: 'deve ser no máximo 10000' })
  ordem?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: LIDERES_POR_SETOR_MAXIMO,
    description:
      'Pessoas ativas que viram Líder do setor, respondendo ao C-level responsável (R1.2). Quem tem liderados não muda de setor (R1.3 → 409 com a lista).',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(LIDERES_POR_SETOR_MAXIMO, {
    message: `deve ter no máximo ${LIDERES_POR_SETOR_MAXIMO} pessoas`,
  })
  @ArrayUnique({ message: 'não pode repetir pessoas' })
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  lideres?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'C-level ativo que lidera os líderes (o "C-level responsável", R1.2). Obrigatório quando há líderes.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  cLevelResponsavelId?: string | null;
}

/** `PATCH /setores/:chave` (R1.11): só os campos enviados mudam; a chave não muda. */
export class AtualizarSetorDto {
  @ApiPropertyOptional({
    example: 'Pós-venda',
    maxLength: TAMANHO_MAXIMO_DO_NOME,
  })
  @ValidateIf(informado)
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_DO_NOME, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_DO_NOME} caracteres`,
  })
  nome?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: TAMANHO_MAXIMO_DESCRICAO,
    description: '`null` ou vazio apaga.',
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_DESCRICAO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`,
  })
  descricao?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: CORES_DE_SETOR,
    description: '`null` apaga.',
  })
  @IsOptional()
  @IsIn(CORES_DE_SETOR, { message: MENSAGEM_COR })
  cor?: CorDeSetor | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_000 })
  @ValidateIf(informado)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(10_000, { message: 'deve ser no máximo 10000' })
  ordem?: number;
}

/** O que impede desativar um setor (R1.10). */
export class ContagensDoSetorDto {
  @ApiProperty({ description: 'Líderes e membros ativos.' })
  usuariosAtivos: number;

  @ApiProperty({ description: 'Funis ativos (não arquivados nem excluídos).' })
  funisAtivos: number;
}

/** Um setor (R1.6). */
export class SetorDto {
  @ApiProperty({
    example: 'POS_VENDA',
    description:
      'Chave imutável, gravada em todas as colunas `area` (usuários, funis, filas…).',
  })
  chave: Area;

  @ApiProperty({ example: 'Pós-venda' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  descricao: string | null;

  @ApiPropertyOptional({ nullable: true, enum: CORES_DE_SETOR })
  cor: string | null;

  @ApiProperty({
    description:
      'Um dos três de base (Marketing, Comercial, Customer Success): não é desativado.',
  })
  base: boolean;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty()
  ordem: number;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  @ApiPropertyOptional({
    type: [UsuarioResumoDto],
    nullable: true,
    description:
      'Líderes ativos do setor. Só para Admin e C-level (nulo para os demais).',
  })
  lideres: UsuarioResumoDto[] | null;

  @ApiPropertyOptional({
    type: ContagensDoSetorDto,
    nullable: true,
    description: 'Só para Admin e C-level (nulo para os demais).',
  })
  contagens: ContagensDoSetorDto | null;
}
