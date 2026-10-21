import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  PrioridadeAtividade,
  TipoAtividade,
} from '../../generated/prisma/client';
import {
  MENSAGEM_UUID,
  TAMANHO_MAXIMO_DESCRICAO,
  TAMANHO_MAXIMO_TITULO,
} from './criar-atividade.dto';
import {
  aparar,
  apararOuNulo,
  IsDataHoraComFuso,
  MENSAGEM_DATA_HORA,
  mensagemDeValores,
  minusculas,
} from './transformacoes';

const informado = (campo: string) => (objeto: object) =>
  (objeto as Record<string, unknown>)[campo] !== undefined;

/**
 * Alteração parcial: só os campos enviados mudam; `null` limpa os opcionais
 * (descrição, datas e vínculos). O status muda pelas ações `concluir`,
 * `cancelar` e `reabrir`.
 */
export class AtualizarAtividadeDto {
  @ApiPropertyOptional({
    enum: TipoAtividade,
    enumName: 'TipoAtividade',
    description:
      'Troca entre os tipos (a nota não muda de tipo e nenhum tipo vira nota). Para virar reunião, informe início e fim.',
  })
  @ValidateIf(informado('tipo'))
  @IsEnum(TipoAtividade, {
    message: mensagemDeValores(Object.values(TipoAtividade)),
  })
  tipo?: TipoAtividade;

  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_TITULO })
  @ValidateIf(informado('titulo'))
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_TITULO, {
    message: `deve ter no máximo ${TAMANHO_MAXIMO_TITULO} caracteres`,
  })
  titulo?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
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
    enum: PrioridadeAtividade,
    enumName: 'PrioridadeAtividade',
  })
  @ValidateIf(informado('prioridade'))
  @IsEnum(PrioridadeAtividade, {
    message: mensagemDeValores(Object.values(PrioridadeAtividade)),
  })
  prioridade?: PrioridadeAtividade;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Vencimento; `null` tira a data. Não vale para nota nem reunião.',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  venceEm?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Início da reunião.',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  inicioEm?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Fim da reunião.',
  })
  @IsOptional()
  @IsDataHoraComFuso({ message: MENSAGEM_DATA_HORA })
  fimEm?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Novo responsável: um usuário ativo (R6.2).',
  })
  @ValidateIf(informado('responsavelId'))
  @Transform(minusculas)
  @IsNotEmpty({ message: 'é obrigatório' })
  @IsUUID('all', { message: MENSAGEM_UUID })
  responsavelId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: '`null` desliga do contato.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: '`null` desliga da empresa.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  empresaId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: '`null` desliga do negócio.',
  })
  @IsOptional()
  @Transform(minusculas)
  @IsUUID('all', { message: MENSAGEM_UUID })
  negocioId?: string | null;
}
