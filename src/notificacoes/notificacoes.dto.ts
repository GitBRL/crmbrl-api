import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import type { Notificacao } from '../generated/prisma/client';

export class FiltroNotificacoesDto extends PaginacaoDto {
  @ApiPropertyOptional({ description: 'Só as não lidas.', default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  apenasNaoLidas: boolean = false;
}

export class NotificacaoDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Tipo (TIPOS_NOTIFICACAO), ex.: `negocio.atribuido`.',
    example: 'negocio.atribuido',
  })
  tipo: string;

  @ApiProperty({ example: 'Novo lead para você' })
  titulo: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'Maria Souza chegou pelo webhook Landing.',
  })
  texto: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Rota do front.',
    example: '/funis/comercial',
  })
  link: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  dados: unknown;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lidaEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  static de(notificacao: Notificacao): NotificacaoDto {
    return {
      id: notificacao.id,
      tipo: notificacao.tipo,
      titulo: notificacao.titulo,
      texto: notificacao.texto,
      link: notificacao.link,
      dados: notificacao.dados ?? null,
      lidaEm: notificacao.lidaEm?.toISOString() ?? null,
      criadoEm: notificacao.criadoEm.toISOString(),
    };
  }
}

export class PaginaNotificacoesDto {
  @ApiProperty({ type: [NotificacaoDto] })
  itens: NotificacaoDto[];

  @ApiProperty({ example: 12 })
  total: number;

  @ApiProperty({ example: 1 })
  pagina: number;

  @ApiProperty({ example: 20 })
  porPagina: number;

  @ApiProperty({
    description:
      'Quantas não lidas o usuário tem (todas, não só desta página).',
    example: 3,
  })
  naoLidas: number;
}

export class ContagemNaoLidasDto {
  @ApiProperty({ example: 3 })
  naoLidas: number;
}

export class MarcadasComoLidasDto {
  @ApiProperty({ description: 'Quantas foram marcadas agora.', example: 3 })
  marcadas: number;
}
