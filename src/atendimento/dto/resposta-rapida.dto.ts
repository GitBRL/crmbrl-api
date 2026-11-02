import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ArquivoDto } from '../../arquivos/arquivos.dto';
import { Area } from '../../generated/prisma/client';
import type { VariavelDisponivel } from '../variaveis';
import { AREAS_DO_ATENDIMENTO, type AreaDoAtendimento } from './fila.dto';
import {
  aparar,
  emMaiusculas,
  MENSAGEM_UUID,
  OpcionalNaoNulo,
  paraBooleano,
  PessoaDto,
} from './comum.dto';
import { TAMANHO_MAXIMO_MENSAGEM } from './mensagem.dto';

/** Resposta rápida ("/atalho" no compositor), com variáveis (R12). */
export class RespostaRapidaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'boas-vindas',
    description: 'Sem a barra: no compositor, digite "/boas-vindas".',
  })
  atalho: string;

  @ApiProperty({ example: 'Boas-vindas' })
  titulo: string;

  @ApiProperty({
    example:
      '{{saudacao}}, {{contato.primeiroNome}}! Sou {{usuario.primeiroNome}}.',
  })
  texto: string;

  @ApiPropertyOptional({
    nullable: true,
    enum: Area,
    enumName: 'Area',
    description: 'Nula = vale para todas as áreas.',
  })
  area: Area | null;

  @ApiPropertyOptional({ nullable: true, type: ArquivoDto })
  arquivo: ArquivoDto | null;

  @ApiProperty()
  ativa: boolean;

  @ApiProperty({
    type: [String],
    description: 'Variáveis usadas no texto (sem as chaves).',
  })
  variaveis: string[];

  @ApiPropertyOptional({ nullable: true, type: PessoaDto })
  criadoPor: PessoaDto | null;

  @ApiProperty({ description: 'A pessoa pode alterar ou excluir.' })
  podeEditar: boolean;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

export class VariavelDto implements VariavelDisponivel {
  @ApiProperty({ example: 'contato.primeiroNome' })
  nome: string;

  @ApiProperty({ example: 'Primeiro nome do contato' })
  descricao: string;

  @ApiProperty({ example: 'Maria' })
  exemplo: string;
}

/** `GET /atendimento/respostas-rapidas`. */
export class FiltroRespostasRapidasDto {
  @ApiPropertyOptional({
    description: 'Atalho, título ou texto.',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;

  @ApiPropertyOptional({
    enum: [...AREAS_DO_ATENDIMENTO, 'GLOBAL'],
    description: 'Só as de uma área (`GLOBAL` = só as que valem para todas).',
  })
  @IsOptional()
  @Transform(emMaiusculas)
  @IsIn([...AREAS_DO_ATENDIMENTO, 'GLOBAL'], {
    message: 'deve ser COMERCIAL, CS ou GLOBAL',
  })
  area?: AreaDoAtendimento | 'GLOBAL';

  @ApiPropertyOptional({
    description: 'Inclui as desativadas (só para quem as gerencia).',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  incluirInativas?: boolean;
}

/** `POST /atendimento/respostas-rapidas`. */
export class CriarRespostaRapidaDto {
  @ApiProperty({
    maxLength: 40,
    example: 'boas-vindas',
    description:
      'Sem espaços nem barras (a barra inicial é tirada; vira minúsculas). Único na área (ou entre as globais).',
  })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(41, { message: 'deve ter no máximo 40 caracteres' })
  atalho: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  titulo: string;

  @ApiProperty({
    maxLength: TAMANHO_MAXIMO_MENSAGEM,
    description:
      'Texto com variáveis entre chaves duplas, ex.: `{{contato.primeiroNome}}` (lista em `GET /atendimento/respostas-rapidas/variaveis`).',
  })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_MENSAGEM, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_MENSAGEM} caracteres`,
  })
  texto: string;

  @ApiPropertyOptional({
    nullable: true,
    enum: AREAS_DO_ATENDIMENTO,
    description:
      'Nula = todas as áreas (só Admin e C-level). O líder cria as da sua área.',
  })
  @IsOptional()
  @Transform(emMaiusculas)
  @IsIn(AREAS_DO_ATENDIMENTO, {
    message: 'deve ser COMERCIAL ou CS (ou nula, para todas)',
  })
  area?: AreaDoAtendimento | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'Anexo (enviado antes por `POST /arquivos?contexto=MENSAGEM`).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string | null;

  @ApiPropertyOptional({ default: true })
  @OpcionalNaoNulo()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;
}

export class AtualizarRespostaRapidaDto extends PartialType(
  CriarRespostaRapidaDto,
) {}

/** `POST /atendimento/respostas-rapidas/:id/aplicar`. */
export class AplicarRespostaRapidaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  conversaId: string;
}

/** O texto já com as variáveis da conversa, para revisar antes de enviar. */
export class RespostaAplicadaDto {
  @ApiProperty()
  texto: string;

  @ApiPropertyOptional({ nullable: true, type: ArquivoDto })
  arquivo: ArquivoDto | null;
}
