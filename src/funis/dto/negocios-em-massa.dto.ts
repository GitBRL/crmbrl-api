import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';

/** Máximo de negócios por pedido de ação em massa (R5.16). */
export const LIMITE_NEGOCIOS_EM_MASSA = 500;

export const ACOES_EM_MASSA = [
  'MOVER',
  'RESPONSAVEL',
  'GANHAR',
  'PERDER',
  'ETIQUETAR',
  'DESETIQUETAR',
  'ATIVIDADE',
  'EXCLUIR',
] as const;
export type AcaoEmMassa = (typeof ACOES_EM_MASSA)[number];

const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';

export class AcaoEmMassaDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: LIMITE_NEGOCIOS_EM_MASSA,
    description: 'Negócios alvo, sem repetidos (1 a 500).',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(1, { message: 'informe ao menos 1 negócio' })
  @ArrayMaxSize(LIMITE_NEGOCIOS_EM_MASSA, {
    message: `informe no máximo ${LIMITE_NEGOCIOS_EM_MASSA} negócios`,
  })
  @ArrayUnique({ message: 'não pode ter negócios repetidos' })
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  negocioIds: string[];

  @ApiProperty({ enum: ACOES_EM_MASSA, enumName: 'AcaoEmMassa' })
  @IsIn(ACOES_EM_MASSA, {
    message: `deve ser um destes valores: ${ACOES_EM_MASSA.join(', ')}`,
  })
  acao: AcaoEmMassa;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Parâmetros da ação: `MOVER` {etapaId, motivoPerda?}; `RESPONSAVEL` {responsavelId|null}; `PERDER` {motivoPerda}; ' +
      '`ETIQUETAR`/`DESETIQUETAR` {etiquetas}; `ATIVIDADE` {tipo, titulo, vencimento?, descricao?}; `GANHAR` e `EXCLUIR` sem dados.',
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  dados?: Record<string, unknown>;
}

export class FalhaEmMassaDto {
  @ApiProperty({ format: 'uuid' })
  negocioId: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Título do negócio; `null` quando a pessoa não o vê.',
  })
  titulo: string | null;

  @ApiProperty({ example: 422 })
  statusCode: number;

  @ApiProperty({ nullable: true, type: String, example: 'R5.13' })
  regra: string | null;

  @ApiProperty()
  mensagem: string;
}

export class ResultadoEmMassaDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  sucesso: number;

  @ApiProperty({ type: [FalhaEmMassaDto] })
  falhas: FalhaEmMassaDto[];
}
