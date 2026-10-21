import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { EtapaDto } from './funis.dto';
import { FiltroBaseNegociosDto, NegocioDto } from './negocios.dto';
import { ResumoFunilDto } from './comum.dto';

export const LIMITE_POR_ETAPA_PADRAO = 50;
export const LIMITE_POR_ETAPA_MAXIMO = 200;

export class FiltroQuadroDto extends FiltroBaseNegociosDto {
  @ApiPropertyOptional({
    description:
      'Quantos cartões trazer por etapa (os demais vêm de `GET /negocios?etapaId=…`).',
    default: LIMITE_POR_ETAPA_PADRAO,
    minimum: 1,
    maximum: LIMITE_POR_ETAPA_MAXIMO,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(LIMITE_POR_ETAPA_MAXIMO, {
    message: `deve ser no máximo ${LIMITE_POR_ETAPA_MAXIMO}`,
  })
  limitePorEtapa: number = LIMITE_POR_ETAPA_PADRAO;
}

export class ColunaDoQuadroDto {
  @ApiProperty({ type: EtapaDto })
  etapa: EtapaDto;

  @ApiProperty({
    description: 'Negócios na etapa (com os filtros), não só os desta página.',
    example: 12,
  })
  total: number;

  @ApiProperty({
    description: 'Soma dos valores dos negócios da etapa (com os filtros).',
    example: '18000.00',
  })
  valorTotal: string;

  @ApiProperty({
    description: 'Quantos estão parados (acima do prazo-alvo, R5.10).',
    example: 2,
  })
  parados: number;

  @ApiProperty({
    type: [NegocioDto],
    description: 'Cartões em ordem de posição (até `limitePorEtapa`).',
  })
  negocios: NegocioDto[];

  @ApiProperty({ description: 'Há mais cartões além dos trazidos.' })
  temMais: boolean;
}

export class QuadroDto {
  @ApiProperty({ type: ResumoFunilDto })
  funil: ResumoFunilDto;

  @ApiProperty({ description: 'Falso = funil arquivado.' })
  ativo: boolean;

  @ApiProperty({ type: [ColunaDoQuadroDto], description: 'Etapas em ordem.' })
  colunas: ColunaDoQuadroDto[];

  @ApiProperty({ example: 40 })
  total: number;

  @ApiProperty({ example: '62000.00' })
  valorTotal: string;
}
