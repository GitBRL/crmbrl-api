import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNotIn, IsOptional, IsUUID } from 'class-validator';
import { type Area, SETOR_MARKETING } from '../../comum/dominio/setores';
import { ChaveDeSetor } from '../../comum/validacao/setor';
import {
  DESCRICAO_SETOR_DO_ATENDIMENTO,
  MENSAGEM_SETOR_SEM_ATENDIMENTO,
} from './fila.dto';
import {
  MENSAGEM_UUID,
  PessoaDto,
  ResumoCanalDto,
  ResumoFilaDto,
} from './comum.dto';

/** `GET /atendimento/metricas`. */
export class FiltroMetricasDoAtendimentoDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Início do período (padrão: 30 dias atrás).',
  })
  @IsOptional()
  @IsDateString({}, { message: 'deve ser uma data ISO 8601' })
  de?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Fim do período, exclusivo (padrão: agora).',
  })
  @IsOptional()
  @IsDateString({}, { message: 'deve ser uma data ISO 8601' })
  ate?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    description: `${DESCRICAO_SETOR_DO_ATENDIMENTO} O líder vê sempre só o seu setor.`,
  })
  @IsOptional()
  @ChaveDeSetor()
  @IsNotIn([SETOR_MARKETING], { message: MENSAGEM_SETOR_SEM_ATENDIMENTO })
  area?: Area;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  filaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  canalId?: string;
}

export class TemposDto {
  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Média, em segundos.',
  })
  mediaSegundos: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Mediana, em segundos.',
  })
  medianaSegundos: number | null;
}

export class CumprimentoDoSlaDto {
  @ApiProperty({ description: 'Conversas com esse prazo.' })
  comPrazo: number;

  @ApiProperty()
  cumpridos: number;

  @ApiProperty()
  estourados: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Cumpridos ÷ (cumpridos + estourados), de 0 a 100.',
  })
  percentualCumprido: number | null;
}

export class SatisfacaoMetricasDto {
  @ApiProperty({ description: 'Pesquisas enviadas no período.' })
  solicitadas: number;

  @ApiProperty({ description: 'Notas recebidas no período.' })
  respondidas: number;

  @ApiPropertyOptional({ nullable: true, type: Number, description: '1 a 5.' })
  media: number | null;

  @ApiProperty({
    type: [Number],
    description: 'Quantas notas 1, 2, 3, 4 e 5 (nessa ordem).',
  })
  distribuicao: number[];

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'CSAT: notas 4 e 5 ÷ notas recebidas, de 0 a 100.',
  })
  csat: number | null;
}

/** Indicadores de um recorte (geral, fila, canal ou pessoa). */
export class IndicadoresDoAtendimentoDto {
  @ApiProperty({ description: 'Conversas novas no período.' })
  conversas: number;

  @ApiProperty({
    description: 'Conversas novas que já tiveram a primeira resposta.',
  })
  respondidas: number;

  @ApiProperty({
    type: TemposDto,
    description: 'Tempo até a primeira resposta (conversas novas no período).',
  })
  primeiraResposta: TemposDto;

  @ApiProperty({ description: 'Conversas resolvidas no período.' })
  resolvidas: number;

  @ApiProperty({
    description: 'Das resolvidas, quantas tinham sido reabertas.',
  })
  reabertas: number;

  @ApiProperty({
    type: TemposDto,
    description: 'Tempo da chegada à resolução (resolvidas no período).',
  })
  resolucao: TemposDto;

  @ApiProperty({ type: CumprimentoDoSlaDto })
  slaPrimeiraResposta: CumprimentoDoSlaDto;

  @ApiProperty({ type: CumprimentoDoSlaDto })
  slaResolucao: CumprimentoDoSlaDto;

  @ApiProperty({ type: SatisfacaoMetricasDto })
  satisfacao: SatisfacaoMetricasDto;

  @ApiProperty({ description: 'Mensagens enviadas pela equipe no período.' })
  mensagensEnviadas: number;
}

export class SituacaoAtualDto {
  @ApiProperty()
  emAberto: number;

  @ApiProperty()
  semResponsavel: number;

  @ApiProperty({ description: 'Com o contato esperando resposta.' })
  aguardandoResposta: number;

  @ApiProperty({ description: 'Com algum SLA estourado agora.' })
  slaEstourado: number;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    description: 'Maior espera atual, em segundos.',
  })
  maiorEsperaSegundos: number | null;
}

export class IndicadoresDaFilaDto extends IndicadoresDoAtendimentoDto {
  @ApiPropertyOptional({
    nullable: true,
    type: ResumoFilaDto,
    description: 'Nula = conversas sem fila.',
  })
  fila: ResumoFilaDto | null;

  @ApiProperty({ type: SituacaoAtualDto })
  agora: SituacaoAtualDto;
}

export class IndicadoresDoCanalDto extends IndicadoresDoAtendimentoDto {
  @ApiProperty({ type: ResumoCanalDto })
  canal: ResumoCanalDto;
}

export class IndicadoresDaPessoaDto {
  @ApiProperty({ type: PessoaDto })
  pessoa: PessoaDto;

  @ApiProperty({ description: 'Conversas que a pessoa recebeu no período.' })
  recebidas: number;

  @ApiProperty({
    description: 'Primeiras respostas dadas pela pessoa no período.',
  })
  primeirasRespostas: number;

  @ApiProperty({ type: TemposDto })
  primeiraResposta: TemposDto;

  @ApiProperty({ description: 'Conversas que a pessoa resolveu no período.' })
  resolvidas: number;

  @ApiProperty({ type: TemposDto })
  resolucao: TemposDto;

  @ApiProperty({ type: CumprimentoDoSlaDto })
  slaResolucao: CumprimentoDoSlaDto;

  @ApiProperty({
    type: SatisfacaoMetricasDto,
    description: 'Notas das conversas que a pessoa resolveu.',
  })
  satisfacao: SatisfacaoMetricasDto;

  @ApiProperty()
  mensagensEnviadas: number;

  @ApiProperty({ description: 'Conversas em aberto com a pessoa agora.' })
  emAberto: number;
}

/** Métricas do Atendimento para o BI (R12): por fila, por canal e por pessoa. */
export class MetricasDoAtendimentoDto {
  @ApiProperty({
    type: 'object',
    properties: {
      de: { type: 'string', format: 'date-time' },
      ate: { type: 'string', format: 'date-time' },
    },
  })
  periodo: { de: string; ate: string };

  @ApiProperty({ type: IndicadoresDoAtendimentoDto })
  geral: IndicadoresDoAtendimentoDto;

  @ApiProperty({ type: SituacaoAtualDto })
  agora: SituacaoAtualDto;

  @ApiProperty({ type: [IndicadoresDaFilaDto] })
  porFila: IndicadoresDaFilaDto[];

  @ApiProperty({ type: [IndicadoresDoCanalDto] })
  porCanal: IndicadoresDoCanalDto[];

  @ApiProperty({ type: [IndicadoresDaPessoaDto] })
  porPessoa: IndicadoresDaPessoaDto[];
}
