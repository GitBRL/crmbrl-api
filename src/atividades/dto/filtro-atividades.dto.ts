import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  PrioridadeAtividade,
  StatusAtividade,
  TipoAtividade,
} from '../../generated/prisma/client';
import { FUSO_HORARIO_DAS_ATIVIDADES } from '../fuso-horario';
import {
  GRUPOS_DE_ATIVIDADES,
  type GrupoAtividade,
} from '../regras-atividades';
import { MENSAGEM_UUID } from './criar-atividade.dto';
import {
  aparar,
  IsDataHoraComFuso,
  MENSAGEM_DATA_HORA,
  mensagemDeValores,
  minusculas,
  paraBooleano,
  paraLista,
} from './transformacoes';

/**
 * Recorte por pessoa, sempre dentro do que o usuário pode ver (R6.4):
 * - `MINHAS`: as que têm o usuário como responsável;
 * - `EQUIPE`: as dos liderados dele (e, para o C-level, as das equipes dos
 *   líderes que respondem a ele) — vazio para quem não lidera ninguém;
 * - `TODAS`: todas as que ele pode ver (membro: as suas e as que criou; líder:
 *   também as da equipe; C-level e Admin: todas).
 */
export const ESCOPOS_DE_ATIVIDADES = ['MINHAS', 'EQUIPE', 'TODAS'] as const;
export type EscopoAtividades = (typeof ESCOPOS_DE_ATIVIDADES)[number];

export const ORDENS_DE_ATIVIDADES = [
  'DATA',
  'DATA_DESC',
  'CRIACAO_DESC',
  'CONCLUSAO_DESC',
  'PRIORIDADE',
] as const;
export type OrdemAtividades = (typeof ORDENS_DE_ATIVIDADES)[number];

const MENSAGEM_FUSO =
  'deve ser um fuso horário IANA válido (ex.: America/Sao_Paulo)';

/** Filtros comuns à lista e aos agrupamentos. */
export class FiltroBaseAtividadesDto {
  @ApiPropertyOptional({
    enum: ESCOPOS_DE_ATIVIDADES,
    enumName: 'EscopoAtividades',
    default: 'TODAS',
    description:
      '`MINHAS` (sou o responsável), `EQUIPE` (dos meus liderados) ou `TODAS` (tudo o que posso ver, R6.4).',
  })
  @IsOptional()
  @IsIn(ESCOPOS_DE_ATIVIDADES, {
    message: mensagemDeValores(ESCOPOS_DE_ATIVIDADES),
  })
  escopo: EscopoAtividades = 'TODAS';

  @ApiPropertyOptional({ format: 'uuid', description: 'Só deste responsável.' })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Só as criadas por.' })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  criadoPorId?: string;

  @ApiPropertyOptional({
    enum: TipoAtividade,
    enumName: 'TipoAtividade',
    isArray: true,
    description:
      'Um ou mais tipos (repetido ou separado por vírgula). Sem este filtro as notas ficam de fora: elas só aparecem na linha do tempo (R6.2) ou pedidas com `tipo=NOTA`.',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(TipoAtividade, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(TipoAtividade))}`,
  })
  tipo?: TipoAtividade[];

  @ApiPropertyOptional({
    enum: PrioridadeAtividade,
    enumName: 'PrioridadeAtividade',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(PrioridadeAtividade, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(PrioridadeAtividade))}`,
  })
  prioridade?: PrioridadeAtividade[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  negocioId?: string;

  @ApiPropertyOptional({
    description:
      '`true`: só as recebidas por desligamento (R7.3); `false`: só as outras.',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  encaminhadas?: boolean;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Texto no título ou na descrição (sem diferença de maiúsculas).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  busca?: string;

  @ApiPropertyOptional({
    default: FUSO_HORARIO_DAS_ATIVIDADES,
    description:
      'Fuso dos agrupamentos ("hoje", "próximos 7 dias"…). Padrão: America/Sao_Paulo.',
  })
  @IsOptional()
  @IsTimeZone({ message: MENSAGEM_FUSO })
  fusoHorario: string = FUSO_HORARIO_DAS_ATIVIDADES;
}

/** `GET /atividades` — lista paginada. */
export class FiltroAtividadesDto extends IntersectionType(
  FiltroBaseAtividadesDto,
  PaginacaoDto,
) {
  @ApiPropertyOptional({
    enum: StatusAtividade,
    enumName: 'StatusAtividade',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsEnum(StatusAtividade, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(StatusAtividade))}`,
  })
  status?: StatusAtividade[];

  @ApiPropertyOptional({
    enum: GRUPOS_DE_ATIVIDADES,
    enumName: 'GrupoAtividade',
    description:
      'Só as de um agrupamento da agenda (para "ver mais" de `GET /atividades/agrupadas`).',
  })
  @IsOptional()
  @IsIn(GRUPOS_DE_ATIVIDADES, {
    message: mensagemDeValores(GRUPOS_DE_ATIVIDADES),
  })
  grupo?: GrupoAtividade;

  @ApiPropertyOptional({
    description:
      '`true`: só as atrasadas (R6.3: pendentes com o prazo no passado); `false`: só as que não estão.',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  atrasadas?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Período pela data da atividade (vencimento; início, na reunião): a partir de (inclusive).',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  de?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Período pela data da atividade: antes de (exclusivo).',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  ate?: string;

  @ApiPropertyOptional({
    enum: ORDENS_DE_ATIVIDADES,
    enumName: 'OrdemAtividades',
    description:
      'Padrão: a ordem do `grupo` pedido; sem grupo, `DATA` (mais próximas primeiro, sem data no fim).',
  })
  @IsOptional()
  @IsIn(ORDENS_DE_ATIVIDADES, {
    message: mensagemDeValores(ORDENS_DE_ATIVIDADES),
  })
  ordem?: OrdemAtividades;
}

/** `GET /atividades/agrupadas` — os seis grupos da agenda. */
export class FiltroAgrupadasDto extends FiltroBaseAtividadesDto {
  @ApiPropertyOptional({
    default: 10,
    minimum: 0,
    maximum: 50,
    description: 'Quantas atividades listar em cada grupo (0 = só os totais).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(50, { message: 'deve ser no máximo 50' })
  limitePorGrupo: number = 10;
}
