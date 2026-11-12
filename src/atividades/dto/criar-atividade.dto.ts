import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PrioridadeAtividade,
  ResultadoReuniao,
  TipoAtividade,
} from '../../generated/prisma/client';
import {
  aparar,
  apararOuNulo,
  IsDataHoraComFuso,
  MENSAGEM_DATA_HORA,
  mensagemDeValores,
  minusculas,
} from './transformacoes';

export const TAMANHO_MAXIMO_TITULO = 200;
export const TAMANHO_MAXIMO_DESCRICAO = 10_000;

export const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';

/** R6.1, R6.2 — nova atividade. */
export class CriarAtividadeDto {
  @ApiProperty({ enum: TipoAtividade, enumName: 'TipoAtividade' })
  @IsEnum(TipoAtividade, {
    message: mensagemDeValores(Object.values(TipoAtividade)),
  })
  tipo: TipoAtividade;

  @ApiProperty({
    example: 'Ligar para apresentar a proposta',
    maxLength: TAMANHO_MAXIMO_TITULO,
  })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_TITULO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TITULO} caracteres`,
  })
  titulo: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: TAMANHO_MAXIMO_DESCRICAO,
    description: 'Detalhes; na nota, o texto dela.',
  })
  @IsOptional()
  @Transform(apararOuNulo)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_MAXIMO_DESCRICAO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`,
  })
  descricao?: string | null;

  @ApiPropertyOptional({
    enum: PrioridadeAtividade,
    enumName: 'PrioridadeAtividade',
    default: PrioridadeAtividade.MEDIA,
  })
  @IsOptional()
  @IsEnum(PrioridadeAtividade, {
    message: mensagemDeValores(Object.values(PrioridadeAtividade)),
  })
  prioridade?: PrioridadeAtividade;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    example: '2026-10-21T15:00:00-03:00',
    description:
      'Vencimento (opcional). Não vale para nota; na reunião, use início e fim.',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  venceEm?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    example: '2026-10-21T14:00:00-03:00',
    description: 'Início — obrigatório na reunião e só nela (R6.1).',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  inicioEm?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    example: '2026-10-21T15:00:00-03:00',
    description:
      'Fim — obrigatório na reunião e só nela; igual ou depois do início (R6.1).',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  fimEm?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Usuário ativo responsável (R6.2). Padrão: quem cria.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Contato ligado (R6.1). Sem ele, vem do negócio informado, quando houver.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Empresa ligada (R6.1). Sem ela, vem do negócio ou do contato informado, quando houver.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Negócio ligado (R6.1) — um que quem cria consegue ver (R5.9).',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  negocioId?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Registra a atividade já concluída (ex.: uma ligação que já aconteceu). A nota sempre nasce concluída (R6.2).',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  concluida?: boolean;

  @ApiPropertyOptional({
    enum: ResultadoReuniao,
    enumName: 'ResultadoReuniao',
    description:
      'R6.6 — obrigatório ao criar uma reunião já concluída (`concluida: true`); recusado nos outros casos.',
  })
  @IsOptional()
  @IsEnum(ResultadoReuniao, {
    message: mensagemDeValores(Object.values(ResultadoReuniao)),
  })
  resultadoReuniao?: ResultadoReuniao;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'R6.6 — com `resultadoReuniao: REMARCADA`: início da nova reunião (no futuro).',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  novaData?: string;
}
