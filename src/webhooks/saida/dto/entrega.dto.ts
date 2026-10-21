import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
} from 'class-validator';
import { PaginacaoDto } from '../../../comum/paginacao/paginacao';
import { EVENTOS_DE_WEBHOOK } from '../../../eventos/tipos-eventos';
import {
  StatusEntrega,
  type WebhookEntrega,
  type WebhookEntregaTentativa,
} from '../../../generated/prisma/client';
import {
  IsDataOuDataHora,
  mensagemDeValores,
  paraLista,
  restaurarFuso,
} from '../../dto-comum';

export class FiltroEntregasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusEntrega,
    enumName: 'StatusEntrega',
    isArray: true,
    description: 'Um ou vários (repita o parâmetro ou separe por vírgula).',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(3, { message: 'deve ter no máximo 3 itens' })
  @IsEnum(StatusEntrega, {
    each: true,
    message: `(cada item) ${mensagemDeValores(Object.values(StatusEntrega))}`,
  })
  status?: StatusEntrega[];

  @ApiPropertyOptional({
    enum: EVENTOS_DE_WEBHOOK,
    enumName: 'EventoDeWebhook',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(EVENTOS_DE_WEBHOOK.length, {
    message: `deve ter no máximo ${EVENTOS_DE_WEBHOOK.length} itens`,
  })
  @IsIn(EVENTOS_DE_WEBHOOK, {
    each: true,
    message: `(cada item) ${mensagemDeValores(EVENTOS_DE_WEBHOOK)}`,
  })
  evento?: string[];

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Criadas a partir deste momento (inclusive).',
  })
  @IsOptional()
  @Transform(restaurarFuso)
  @IsDataOuDataHora()
  de?: string;

  @ApiPropertyOptional({
    example: '2026-10-21',
    description: 'Criadas antes deste momento (exclusivo).',
  })
  @IsOptional()
  @Transform(restaurarFuso)
  @IsDataOuDataHora()
  ate?: string;
}

export class TentativaDeEntregaDto {
  @ApiProperty({
    example: 1,
    description: 'Sequência de todas as tentativas da entrega.',
  })
  numero: number;

  @ApiProperty()
  sucesso: boolean;

  @ApiProperty({ type: Number, nullable: true, example: 500 })
  statusHttp: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 132 })
  duracaoMs: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Até 2 KB da resposta (R9.5).',
  })
  trechoResposta: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'HTTP 500 Internal Server Error',
  })
  erro: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  static de(tentativa: WebhookEntregaTentativa): TentativaDeEntregaDto {
    return {
      numero: tentativa.numero,
      sucesso: tentativa.sucesso,
      statusHttp: tentativa.statusHttp,
      duracaoMs: tentativa.duracaoMs,
      trechoResposta: tentativa.trechoResposta,
      erro: tentativa.erro,
      criadoEm: tentativa.criadoEm.toISOString(),
    };
  }
}

/** Uma entrega de evento a um destino (R9.4, R9.5), sem o envelope. */
export class EntregaDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Vai no cabeçalho X-CRM-Entrega.',
  })
  id: string;

  @ApiProperty({ format: 'uuid' })
  webhookId: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Id do evento: o `id` do envelope (R9.3, R9.6), igual em todos os destinos.',
  })
  eventoId: string;

  @ApiProperty({ example: 'negocio.ganho' })
  evento: string;

  @ApiProperty({ enum: StatusEntrega, enumName: 'StatusEntrega' })
  status: StatusEntrega;

  @ApiProperty({
    example: 2,
    description:
      'Tentativas desde o envio (ou o último reenvio): até 7 (R9.4).',
  })
  tentativas: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ultimaTentativaEm: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Quando sai a próxima tentativa (pendente).',
  })
  proximaTentativaEm: string | null;

  @ApiProperty({ type: Number, nullable: true })
  statusHttp: number | null;

  @ApiProperty({ type: Number, nullable: true })
  duracaoMs: number | null;

  @ApiProperty({ type: String, nullable: true })
  trechoResposta: string | null;

  @ApiProperty({ type: String, nullable: true })
  erro: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  entregueEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;

  static de(entrega: Omit<WebhookEntrega, 'payload'>): EntregaDto {
    return {
      id: entrega.id,
      webhookId: entrega.webhookId,
      eventoId: entrega.eventoId,
      evento: entrega.tipoEvento,
      status: entrega.status,
      tentativas: entrega.tentativas,
      ultimaTentativaEm: entrega.ultimaTentativaEm?.toISOString() ?? null,
      proximaTentativaEm: entrega.proximaTentativaEm?.toISOString() ?? null,
      statusHttp: entrega.statusHttp,
      duracaoMs: entrega.duracaoMs,
      trechoResposta: entrega.trechoResposta,
      erro: entrega.erro,
      entregueEm: entrega.entregueEm?.toISOString() ?? null,
      criadoEm: entrega.criadoEm.toISOString(),
      atualizadoEm: entrega.atualizadoEm.toISOString(),
    };
  }
}

export class EntregaDetalheDto extends EntregaDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'O envelope `{ id, evento, ocorridoEm, dados }` (R9.3).',
  })
  payload: unknown;

  @ApiProperty({
    type: [TentativaDeEntregaDto],
    description: 'Todas as tentativas, da primeira à última (R9.5).',
  })
  historicoTentativas: TentativaDeEntregaDto[];
}
