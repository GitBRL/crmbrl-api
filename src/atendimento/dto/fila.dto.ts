import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNotIn,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { EstrategiaFila, Papel } from '../../generated/prisma/client';
import type { ModoDosParticipantes, MotivoNaFila } from '../distribuicao-fila';
import {
  aparar,
  apararOuNulo,
  emMaiusculas,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
  paraBooleano,
  PessoaDto,
  ResumoCanalDto,
} from './comum.dto';
import { type Area, SETOR_MARKETING } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';

/**
 * Setor que atende (chave): qualquer setor ativo menos o Marketing, que não usa
 * o Atendimento (R12). O serviço confere (`garantirSetorDoAtendimento`).
 */
/** O Marketing não usa o Atendimento (R12): recusado já na validação (400). */
export const MENSAGEM_SETOR_SEM_ATENDIMENTO =
  'deve ser um setor que atende (o Marketing não usa o Atendimento)';

export const DESCRICAO_SETOR_DO_ATENDIMENTO =
  'Setor (chave) que atende: `COMERCIAL`, `CS` ou um setor criado — o Marketing não usa o Atendimento (R12).';

/** SLA: até 30 dias para a primeira resposta e 365 dias para a resolução. */
export const SLA_PRIMEIRA_RESPOSTA_MAXIMO = 30 * 24 * 60;
export const SLA_RESOLUCAO_MAXIMO = 365 * 24 * 60;

export const MOTIVOS_NA_FILA: readonly MotivoNaFila[] = [
  'AREA',
  'NA_LISTA',
  'RETIRADO',
  'FORA_DA_LISTA',
  'LIDER',
  'CONVITE_PENDENTE',
  'PRIMEIRO_ACESSO_PENDENTE',
];

export class PessoaNaFilaDto extends PessoaDto {
  @ApiProperty({ enum: Papel, enumName: 'Papel' })
  papel: Papel;

  @ApiProperty({ description: 'Recebe conversas desta fila agora.' })
  participa: boolean;

  @ApiProperty({
    enum: MOTIVOS_NA_FILA,
    description:
      '`AREA` (membro da área, sem lista definida), `NA_LISTA`, `RETIRADO` (tirado à mão), `FORA_DA_LISTA`, `LIDER` (só entra pela lista), `CONVITE_PENDENTE` e `PRIMEIRO_ACESSO_PENDENTE` (ainda não ativou o acesso: entra sozinho quando ativar).',
  })
  motivo: MotivoNaFila;

  @ApiProperty({ description: 'Conversas em aberto com a pessoa agora.' })
  emAberto: number;
}

/** Fila de atendimento (R12). */
export class FilaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Identifica filas criadas pelo sistema.',
  })
  chave: string | null;

  @ApiProperty({ example: 'Comercial — WhatsApp' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  area: Area;

  @ApiPropertyOptional({ nullable: true, type: String })
  descricao: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Prazo da primeira resposta, em minutos (nulo = sem SLA).',
  })
  slaPrimeiraRespostaMinutos: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Prazo de resolução, em minutos (nulo = sem SLA).',
  })
  slaResolucaoMinutos: number | null;

  @ApiProperty({
    enum: EstrategiaFila,
    enumName: 'EstrategiaFila',
    description:
      '`RODIZIO` (cada conversa nova para o próximo da vez), `MENOR_CARGA` (para quem tem menos conversas em aberto) ou `MANUAL` (fica sem responsável até alguém assumir).',
  })
  estrategia: EstrategiaFila;

  @ApiProperty()
  ativa: boolean;

  @ApiProperty({
    enum: ['AREA', 'LISTA'],
    description:
      '`AREA`: participam todos os membros ativos da área (menos os retirados). `LISTA`: só quem está na lista.',
  })
  modoParticipantes: ModoDosParticipantes;

  @ApiProperty({
    type: [PessoaNaFilaDto],
    description: 'Pessoas ativas da área, na ordem do rodízio.',
  })
  pessoas: PessoaNaFilaDto[];

  @ApiPropertyOptional({
    nullable: true,
    type: PessoaDto,
    description:
      'Quem recebe a próxima conversa (nulo: ninguém; fica na fila).',
  })
  proximo: PessoaDto | null;

  @ApiProperty({
    type: [ResumoCanalDto],
    description: 'Canais que mandam as conversas novas para esta fila.',
  })
  canais: ResumoCanalDto[];

  @ApiProperty()
  conversasEmAberto: number;

  @ApiProperty({ description: 'Em aberto e sem responsável.' })
  conversasSemResponsavel: number;

  @ApiProperty({ description: 'A pessoa pode alterar a fila.' })
  podeEditar: boolean;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

/** `GET /atendimento/filas`. */
export class FiltroFilasDto {
  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    description: DESCRICAO_SETOR_DO_ATENDIMENTO,
  })
  @IsOptional()
  @ChaveDeSetor()
  @IsNotIn([SETOR_MARKETING], { message: MENSAGEM_SETOR_SEM_ATENDIMENTO })
  area?: Area;

  @ApiPropertyOptional({ description: 'Inclui as filas desativadas.' })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirInativas?: boolean;
}

/** `POST /atendimento/filas`. */
export class CriarFilaDto {
  @ApiProperty({ maxLength: 100, example: 'Comercial — WhatsApp' })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiProperty({
    type: String,
    example: 'COMERCIAL',
    description: DESCRICAO_SETOR_DO_ATENDIMENTO,
  })
  @ChaveDeSetor()
  @IsNotIn([SETOR_MARKETING], { message: MENSAGEM_SETOR_SEM_ATENDIMENTO })
  area: Area;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 500 })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: SLA_PRIMEIRA_RESPOSTA_MAXIMO,
    description: 'Minutos para a primeira resposta (`null` = sem SLA).',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro de minutos' })
  @Min(1, { message: 'deve ser no mínimo 1 minuto' })
  @Max(SLA_PRIMEIRA_RESPOSTA_MAXIMO, {
    message: 'deve ser no máximo 30 dias',
  })
  slaPrimeiraRespostaMinutos?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: SLA_RESOLUCAO_MAXIMO,
    description: 'Minutos para resolver (`null` = sem SLA).',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro de minutos' })
  @Min(1, { message: 'deve ser no mínimo 1 minuto' })
  @Max(SLA_RESOLUCAO_MAXIMO, { message: 'deve ser no máximo 365 dias' })
  slaResolucaoMinutos?: number | null;

  @ApiPropertyOptional({
    enum: EstrategiaFila,
    enumName: 'EstrategiaFila',
    default: 'RODIZIO',
  })
  @OpcionalNaoNulo()
  @Transform(emMaiusculas)
  @IsEnum(EstrategiaFila, {
    message: 'deve ser RODIZIO, MENOR_CARGA ou MANUAL',
  })
  estrategia?: EstrategiaFila;

  @ApiPropertyOptional({ default: true })
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Lista de participantes (pessoas ativas da área). Vazia ou ausente: a área inteira.',
  })
  @OpcionalNaoNulo()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(200, { message: 'deve ter no máximo 200 pessoas' })
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  participantes?: string[];
}

/**
 * `PATCH /atendimento/filas/:id`: só os campos enviados mudam. A área só muda
 * sem conversas em aberto. `participantes` substitui a lista (vazia = volta a
 * valer a área inteira; os retirados à mão continuam fora).
 */
export class AtualizarFilaDto extends PartialType(CriarFilaDto) {}

/** `PUT /atendimento/filas/:id/participantes/:usuarioId`. */
export class DefinirParticipacaoNaFilaDto {
  @ApiProperty({
    description:
      'Verdadeiro põe a pessoa na lista da fila (a fila passa a valer só para a lista); falso a tira da distribuição.',
  })
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  participa: boolean;
}
