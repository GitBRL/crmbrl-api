import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ResumoEtapaDto, ResumoFunilDto } from './comum.dto';

export class FiltroMetricasDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Início do período (padrão: 30 dias antes do fim).',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'deve ser uma data no formato ISO 8601' },
  )
  de?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Fim do período, exclusivo (padrão: agora).',
    example: '2026-11-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'deve ser uma data no formato ISO 8601' },
  )
  ate?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só os negócios deste responsável.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  responsavelId?: string;
}

export class PeriodoDto {
  @ApiProperty({ format: 'date-time' })
  de: string;

  @ApiProperty({ format: 'date-time', description: 'Exclusivo.' })
  ate: string;
}

export class EtapaDaMetricaDto extends ResumoEtapaDto {
  @ApiPropertyOptional({ nullable: true, type: Number })
  prazoDias: number | null;
}

export class MetricaDaEtapaDto {
  @ApiProperty({ type: EtapaDaMetricaDto })
  etapa: EtapaDaMetricaDto;

  @ApiProperty({ description: 'Negócios na etapa agora.', example: 8 })
  negociosAtuais: number;

  @ApiProperty({
    description: 'Soma dos valores dos negócios na etapa agora.',
    example: '12000.00',
  })
  valorAtual: string;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description:
      'Abertos na etapa há mais tempo que o prazo-alvo (nulo se a etapa não tem prazo).',
    example: 2,
  })
  parados: number | null;

  @ApiProperty({
    description: 'Entradas na etapa durante o período (movimentações).',
    example: 15,
  })
  entradasNoPeriodo: number;

  @ApiProperty({
    description: 'Saídas da etapa durante o período (base do tempo médio).',
    example: 11,
  })
  saidasNoPeriodo: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description:
      'Tempo médio na etapa, em segundos, de quem saiu dela no período.',
    example: 259200,
  })
  tempoMedioSegundos: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, example: 3 })
  tempoMedioDias: number | null;
}

export class ConversaoEntreEtapasDto {
  @ApiProperty({ type: ResumoEtapaDto })
  deEtapa: ResumoEtapaDto;

  @ApiProperty({ type: ResumoEtapaDto })
  paraEtapa: ResumoEtapaDto;

  @ApiProperty({
    description:
      'Negócios criados no período que alcançaram a etapa de origem (ou alguma depois dela).',
    example: 40,
  })
  alcancaramOrigem: number;

  @ApiProperty({
    description: 'Desses, quantos alcançaram a etapa seguinte.',
    example: 25,
  })
  alcancaramDestino: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Proporção de 0 a 1 (nula sem negócios na origem).',
    example: 0.625,
  })
  taxa: number | null;
}

export class CoorteDto {
  @ApiProperty({ description: 'Negócios criados no período.', example: 40 })
  criados: number;

  @ApiProperty({ example: 25 })
  abertos: number;

  @ApiProperty({ example: 10 })
  ganhos: number;

  @ApiProperty({ example: 5 })
  perdidos: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Ganhos / criados, de 0 a 1.',
    example: 0.25,
  })
  taxaDeGanho: number | null;
}

export class CicloMedioDto {
  @ApiProperty({
    description: 'Negócios ganhos no período (base do ciclo).',
    example: 10,
  })
  negociosGanhos: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Média de criação → ganho, em segundos.',
    example: 1296000,
  })
  segundos: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, example: 15 })
  dias: number | null;
}

export class MetricasDoFunilDto {
  @ApiProperty({ type: ResumoFunilDto })
  funil: ResumoFunilDto;

  @ApiProperty({ type: PeriodoDto })
  periodo: PeriodoDto;

  @ApiProperty({ type: [MetricaDaEtapaDto], description: 'Etapas em ordem.' })
  etapas: MetricaDaEtapaDto[];

  @ApiProperty({
    type: [ConversaoEntreEtapasDto],
    description:
      'Conversão entre etapas consecutivas: as abertas em ordem e, por último, a de ganho.',
  })
  conversoes: ConversaoEntreEtapasDto[];

  @ApiProperty({ type: CoorteDto })
  coorte: CoorteDto;

  @ApiProperty({ type: CicloMedioDto })
  cicloMedio: CicloMedioDto;

  @ApiProperty({
    description: 'Negócios abertos parados agora, em todas as etapas.',
    example: 4,
  })
  parados: number;
}
