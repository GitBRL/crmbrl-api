import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Area } from '../../generated/prisma/client';

const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';
const MENSAGEM_DATA = 'deve ser uma data no formato ISO 8601';

function lerBooleano({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return value;
}

/** Filtros comuns dos painéis (query string no `GET`, corpo no `POST …/exportar`). */
export class FiltroBiDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Início do período, inclusivo (padrão: 30 dias antes do fim).',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: MENSAGEM_DATA })
  de?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Fim do período, exclusivo (padrão: agora). Máximo de 1 ano.',
    example: '2026-11-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: MENSAGEM_DATA })
  ate?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Compara com o período anterior de mesma duração (colado no início do atual).',
  })
  @IsOptional()
  @Transform(lerBooleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  comparar?: boolean;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    description:
      'Marketing: área das campanhas; Atendimento: área da fila. Nos painéis Comercial e CS a área já é a do painel. Quem não é Admin nem C-level só pode pedir a própria.',
  })
  @IsOptional()
  @IsEnum(Area, { message: 'área inválida' })
  area?: Area;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Equipe: o id de um líder; vale ele e os liderados dele (responsável do negócio, da atividade ou da conversa; criador da campanha).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  equipeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Pessoa: só o que é dela (responsável).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  pessoaId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Funil (Marketing, Comercial e CS): precisa ser da área do painel. Sem ele, valem todos os funis da área; a tabela "funil por etapa" usa o funil-base.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  funilId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Canal (Marketing: campanhas que usam o canal; Atendimento: conversas do canal).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  canalId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Fila de atendimento (só no painel Atendimento).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  filaId?: string;
}

export class ExportarBiDto extends FiltroBiDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: 'formato inválido: use xlsx ou csv' })
  formato?: 'xlsx' | 'csv';

  @ApiPropertyOptional({
    description:
      'Chave da tabela a exportar (veja `tabelas` da resposta do painel; `cartoes` exporta os indicadores). No XLSX, sem ela, o arquivo leva todas as tabelas em abas; no CSV o padrão é `cartoes`.',
    example: 'ranking',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(60, { message: 'no máximo 60 caracteres' })
  tabela?: string;
}

export class ColunaBiDto {
  @ApiProperty() chave: string;
  @ApiProperty() rotulo: string;
  @ApiProperty({
    enum: [
      'texto',
      'numero',
      'moeda',
      'percentual',
      'segundos',
      'dias',
      'nota',
      'data',
      'id',
    ],
  })
  tipo: string;
  @ApiProperty({
    description: 'Falso nas colunas de apoio (ids para o clique).',
  })
  visivel: boolean;
}

export class CartaoBiDto {
  @ApiProperty({ example: 'taxaGanho' }) chave: string;
  @ApiProperty({ example: 'Taxa de ganho' }) rotulo: string;
  @ApiProperty({ type: Number, nullable: true }) valor: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Valor do período anterior; nulo em indicadores "de agora".',
  })
  anterior: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Variação percentual sobre o anterior.',
  })
  variacao: number | null;
  @ApiProperty({
    enum: ['numero', 'moeda', 'percentual', 'segundos', 'dias', 'nota'],
  })
  unidade: string;
  @ApiProperty({ enum: ['maior', 'menor'], nullable: true, type: String })
  melhorQuando: 'maior' | 'menor' | null;
  @ApiProperty({ description: 'Texto curto que explica a métrica.' })
  dica: string;
}

export class TabelaBiDto {
  @ApiProperty() chave: string;
  @ApiProperty() titulo: string;
  @ApiProperty() dica: string;
  @ApiProperty({ type: [ColunaBiDto] }) colunas: ColunaBiDto[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Uma linha por objeto, com as chaves de `colunas`.',
  })
  linhas: Record<string, string | number | boolean | null>[];
}

export class PeriodoBiDto {
  @ApiProperty({ format: 'date-time' }) de: string;
  @ApiProperty({ format: 'date-time', description: 'Exclusivo.' }) ate: string;
}

export class FiltrosAplicadosDto {
  @ApiProperty({ enum: Area, enumName: 'Area', nullable: true })
  area: Area | null;
  @ApiProperty({ type: String, nullable: true }) equipeId: string | null;
  @ApiProperty({ type: String, nullable: true }) pessoaId: string | null;
  @ApiProperty({ type: String, nullable: true }) funilId: string | null;
  @ApiProperty({ type: String, nullable: true }) canalId: string | null;
  @ApiProperty({ type: String, nullable: true }) filaId: string | null;
  @ApiProperty() comparar: boolean;
}

export class PainelBiDto {
  @ApiProperty({
    enum: ['marketing', 'comercial', 'cs', 'atendimento', 'financeiro'],
  })
  painel: string;
  @ApiProperty({ type: PeriodoBiDto }) periodo: PeriodoBiDto;
  @ApiProperty({
    type: PeriodoBiDto,
    nullable: true,
    description:
      'Período anterior usado na comparação (nulo com `comparar=false`).',
  })
  anterior: PeriodoBiDto | null;
  @ApiProperty({
    format: 'date-time',
    description: 'Quando o painel foi calculado (o cache dura 30 segundos).',
  })
  geradoEm: string;
  @ApiProperty({ type: FiltrosAplicadosDto }) filtros: FiltrosAplicadosDto;
  @ApiProperty({ type: [CartaoBiDto] }) cartoes: CartaoBiDto[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/TabelaBiDto' },
    description:
      'Tabelas por chave (dados dos gráficos e das tabelas da tela).',
  })
  tabelas: Record<string, TabelaBiDto>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Apoio para a tela (funil usado, faixas).',
  })
  meta: Record<string, unknown>;
}

export class PaineisDoUsuarioDto {
  @ApiProperty({
    type: [String],
    enum: ['marketing', 'comercial', 'cs', 'atendimento', 'financeiro'],
    description: 'Abas que o papel vê, na ordem.',
  })
  paineis: string[];
}
