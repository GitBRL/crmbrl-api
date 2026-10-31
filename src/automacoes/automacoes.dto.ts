import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import {
  Area,
  LimiteExecucao,
  StatusExecucao,
  TipoGatilhoAutomacao,
} from '../generated/prisma/client';
import { CRITERIOS_DE_PARADA } from './automacoes.constantes';

const MENSAGEM_UUID = 'Informe um id válido.';

function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function paraBooleano({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === '1' || value === true) {
    return true;
  }
  if (value === 'false' || value === '0' || value === false) {
    return false;
  }
  return value;
}

function paraLista({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const itens = Array.isArray(value) ? (value as unknown[]) : [value];
  return itens
    .flatMap((i) => (typeof i === 'string' ? i.split(',') : [i]))
    .map((i) => (typeof i === 'string' ? i.trim().toUpperCase() : i))
    .filter((i) => i !== '');
}

export class CriarAutomacaoDto {
  @ApiProperty({ maxLength: 120, example: 'Boas-vindas ao lead' })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(120, { message: 'deve ter no máximo 120 caracteres' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000 })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(1000, { message: 'deve ter no máximo 1000 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    nullable: true,
    description:
      'Escopo. Líder: sempre a própria área. Admin/C-level: uma área, ou nula (todas).',
  })
  @IsOptional()
  @IsEnum(Area, { message: 'área inválida' })
  area?: Area | null;

  @ApiProperty({ enum: TipoGatilhoAutomacao, enumName: 'TipoGatilhoAutomacao' })
  @IsEnum(TipoGatilhoAutomacao, { message: 'tipo de gatilho inválido' })
  tipoGatilho: TipoGatilhoAutomacao;

  @ApiPropertyOptional({
    description:
      'Tipo do evento (`GET /automacoes/catalogo`), obrigatório quando `tipoGatilho = EVENTO`.',
    example: 'negocio.movido',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100)
  evento?: string | null;

  @ApiPropertyOptional({
    description:
      'Filtros do evento (`{ funilId, etapaId, palavras… }`), `DataRelativa` (`{ campo, dias, hora }`) ou `Recorrencia` (`{ frequencia, hora, diasDaSemana, diaDoMes }`).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  gatilhoConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Entidade do gatilho (contato, negocio, atividade ou conversa). Vem do gatilho; se enviada, deve coincidir.',
  })
  @IsOptional()
  @IsIn(['contato', 'negocio', 'atividade', 'conversa'], {
    message: 'entidade inválida',
  })
  entidade?: string;

  @ApiPropertyOptional({
    description: '`{ segmento?: Segmento, horario?: janela }`.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  condicoes?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Passos: `{ passos: [{ id, tipo, config, ramos? }] }`.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  definicao?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: CRITERIOS_DE_PARADA, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CRITERIOS_DE_PARADA.length)
  @IsIn(CRITERIOS_DE_PARADA as unknown as string[], {
    each: true,
    message: 'critério de parada inválido',
  })
  criteriosParada?: string[];

  @ApiPropertyOptional({ enum: LimiteExecucao, enumName: 'LimiteExecucao' })
  @IsOptional()
  @IsEnum(LimiteExecucao, { message: 'limite inválido' })
  limiteExecucao?: LimiteExecucao;

  @ApiPropertyOptional({
    description: 'Obrigatório em `UMA_VEZ_POR_PERIODO`.',
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1)
  @Max(3650)
  limitePeriodoDias?: number | null;

  @ApiPropertyOptional({
    description:
      'Automação de marketing: contatos com opt-out ficam de fora (R4.6).',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  marketing?: boolean;

  @ApiPropertyOptional({ description: 'Chave do modelo pronto de origem.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  modelo?: string | null;
}

export class AtualizarAutomacaoDto extends PartialType(CriarAutomacaoDto) {}

export class CriarDeModeloProntoDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome?: string;

  @ApiPropertyOptional({ enum: Area, enumName: 'Area', nullable: true })
  @IsOptional()
  @IsEnum(Area, { message: 'área inválida' })
  area?: Area | null;

  @ApiPropertyOptional({
    description:
      'Preenche o que o modelo deixou em branco (ex.: `{ etapaId }`).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  gatilhoConfig?: Record<string, unknown>;
}

export class PausarAutomacaoDto {
  @ApiPropertyOptional({
    description:
      'Também cancela as execuções em andamento (padrão: elas ficam suspensas).',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  cancelarExecucoes?: boolean;
}

export class TestarAutomacaoDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'A entidade (contato, negócio, atividade ou conversa, conforme a automação) para o teste.',
  })
  @IsUUID('all', { message: MENSAGEM_UUID })
  entidadeId: string;
}

export class FiltroAutomacoesDto extends PaginacaoDto {
  @ApiPropertyOptional({ description: 'Busca pelo nome.' })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(100)
  busca?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;

  @ApiPropertyOptional({ enum: Area, enumName: 'Area' })
  @IsOptional()
  @IsEnum(Area, { message: 'área inválida' })
  area?: Area;

  @ApiPropertyOptional({
    enum: TipoGatilhoAutomacao,
    enumName: 'TipoGatilhoAutomacao',
  })
  @IsOptional()
  @IsEnum(TipoGatilhoAutomacao, { message: 'tipo de gatilho inválido' })
  tipoGatilho?: TipoGatilhoAutomacao;

  @ApiPropertyOptional({ description: 'Tipo de evento do gatilho.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  evento?: string;
}

export class FiltroExecucoesDto extends PaginacaoDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Histórico de uma automação.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  automacaoId?: string;

  @ApiPropertyOptional({
    enum: ['contato', 'negocio', 'atividade', 'conversa'],
  })
  @IsOptional()
  @IsIn(['contato', 'negocio', 'atividade', 'conversa'])
  entidade?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Histórico de uma entidade.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  entidadeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Execuções de um contato (qualquer entidade).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;

  @ApiPropertyOptional({
    enum: StatusExecucao,
    enumName: 'StatusExecucao',
    isArray: true,
    description: 'Um ou vários (`?status=FALHOU,AGUARDANDO`).',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray()
  @IsEnum(StatusExecucao, { each: true, message: 'status inválido' })
  status?: StatusExecucao[];

  @ApiPropertyOptional({
    description:
      'Só as de modo teste (true) ou sem elas (false). Padrão: sem testes.',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  teste?: boolean;
}
