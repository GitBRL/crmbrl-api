import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { PaginacaoDto } from '../../../comum/paginacao/paginacao';
import {
  StatusRecebimento,
  type WebhookRecebimento,
} from '../../../generated/prisma/client';
import {
  IsDataOuDataHora,
  MENSAGEM_UUID,
  mensagemDeValores,
  OpcionalNaoNulo,
  paraLista,
  restaurarFuso,
} from '../../dto-comum';

export class FiltroRecebimentosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusRecebimento,
    enumName: 'StatusRecebimento',
    isArray: true,
    description: 'Um ou vários (repita o parâmetro ou separe por vírgula).',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(4, { message: 'deve ter no máximo 4 itens' })
  @IsEnum(StatusRecebimento, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(StatusRecebimento))}`,
  })
  status?: StatusRecebimento[];

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Recebidos a partir deste momento (inclusive).',
  })
  @IsOptional()
  @Transform(restaurarFuso)
  @IsDataOuDataHora()
  de?: string;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'Recebidos antes deste momento (exclusivo).',
  })
  @IsOptional()
  @Transform(restaurarFuso)
  @IsDataOuDataHora()
  ate?: string;
}

export class ContatoDoRecebimentoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Souza' })
  nome: string;
}

export class NegocioDoRecebimentoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Maria Souza' })
  titulo: string;
}

/** O que a listagem mostra de cada recebimento (R8.6), sem o corpo. */
export class RecebimentoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  webhookId: string;

  @ApiProperty({ format: 'date-time' })
  recebidoEm: string;

  @ApiProperty({ type: String, nullable: true, example: '203.0.113.7' })
  ip: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'application/json' })
  tipoConteudo: string | null;

  @ApiProperty({ enum: StatusRecebimento, enumName: 'StatusRecebimento' })
  status: StatusRecebimento;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'Contato "Maria Souza" criado; negócio criado em Marketing / Novo lead, com Ana Souza.',
    description: 'O que aconteceu (ou por que deu erro ou foi ignorado).',
  })
  mensagem: string | null;

  @ApiProperty({
    example: 1,
    description: 'Tentativas de processamento (R8.4).',
  })
  tentativas: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processadoEm: string | null;

  @ApiProperty({ type: ContatoDoRecebimentoDto, nullable: true })
  contato: ContatoDoRecebimentoDto | null;

  @ApiProperty({ type: NegocioDoRecebimentoDto, nullable: true })
  negocio: NegocioDoRecebimentoDto | null;

  @ApiProperty({
    description:
      'Recusado na chegada (assinatura inválida, corpo grande demais ou tipo não suportado): não é processado nem reprocessado.',
  })
  recusadoNaRecepcao: boolean;

  @ApiProperty({
    description:
      'O Admin pode reprocessar (R8.6): com erro, ignorado ou ainda na fila, com corpo guardado e aceito na chegada.',
  })
  podeReprocessar: boolean;
}

export class RecebimentoDetalheDto extends RecebimentoDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Parte dos cabeçalhos recebidos (sem cookies nem credenciais).',
  })
  cabecalhos: Record<string, string>;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'O corpo recebido (JSON ou formulário). Nulo quando não foi guardado (grande demais, tipo não suportado) ou foi apagado na anonimização do contato (R4.6).',
  })
  corpo: unknown;
}

/** Resposta do endereço público (R8.4). */
export class RecebimentoAceitoDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Id do recebimento, para conferir depois no CRM.',
  })
  id: string;

  @ApiProperty({ enum: ['RECEBIDO'], example: 'RECEBIDO' })
  status: 'RECEBIDO';
}

export class PreviaDoWebhookDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { name: 'Maria Souza', email: 'maria@x.com' },
    description: 'Um corpo de exemplo. Use este ou `recebimentoId`.',
  })
  @OpcionalNaoNulo()
  @IsObject({ message: 'deve ser um objeto JSON' })
  exemplo?: Record<string, unknown>;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Ou o id de um recebimento deste ponto: a prévia usa o corpo guardado.',
  })
  @OpcionalNaoNulo()
  @IsUUID('all', MENSAGEM_UUID)
  recebimentoId?: string;
}

/** Recebimento como a listagem precisa (com o contato e o negócio já carregados). */
export type RecebimentoComVinculos = WebhookRecebimento & {
  contato: { id: string; nome: string } | null;
  negocio: { id: string; titulo: string } | null;
};
