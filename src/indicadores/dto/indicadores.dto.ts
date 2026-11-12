import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Papel } from '../../generated/prisma/client';
import {
  MAXIMO_DE_WIDGETS,
  TAMANHO_DESCRICAO_PAINEL,
  TAMANHO_NOME_PAINEL,
} from '../indicadores.constantes';

const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';

export class CompartilhamentoDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Setores (chaves) que veem o painel.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(50, { message: 'no máximo 50 itens' })
  @IsString({ each: true, message: '(cada item) deve ser um texto' })
  @MaxLength(40, { each: true, message: '(cada item) é longo demais' })
  setores?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Pessoas (ids) que veem o painel.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(200, { message: 'no máximo 200 pessoas' })
  @IsUUID('all', { each: true, message: `(cada item) ${MENSAGEM_UUID}` })
  pessoas?: string[];

  @ApiPropertyOptional({
    enum: Papel,
    isArray: true,
    description: 'Papéis inteiros (só Admin e C-level compartilham por papel).',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @IsIn(Object.values(Papel), {
    each: true,
    message: '(cada item) é um papel inválido',
  })
  papeis?: Papel[];
}

export class CriarPainelIndicadoresDto {
  @ApiPropertyOptional({
    description: `Nome (até ${TAMANHO_NOME_PAINEL}). Obrigatório, exceto quando se cria a partir de um modelo (o nome do modelo é o padrão).`,
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_NOME_PAINEL * 2, { message: 'nome longo demais' })
  nome?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: TAMANHO_DESCRICAO_PAINEL })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_DESCRICAO_PAINEL * 2, {
    message: 'descrição longa demais',
  })
  descricao?: string;

  @ApiPropertyOptional({
    description:
      'Chave de um modelo pronto (`time_comercial`): cria o painel já com os indicadores dele.',
    example: 'time_comercial',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(40)
  modelo?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Filtros do painel (R33.3): `periodo {tipo, de?, ate?}`, `comparar`, `funilIds`, `etapaIds`, `setor`, `equipeId`, `pessoaIds`, `origens`, `utmSource`, `utmCampaign`, `etiquetas`.',
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  filtrosPadrao?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: `Indicadores do painel (até ${MAXIMO_DE_WIDGETS}): \`{id?, indicador, parametros, visualizacao, titulo?, filtros?, meta?, largura (1 a 3), ordem}\`.`,
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(MAXIMO_DE_WIDGETS, {
    message: `no máximo ${MAXIMO_DE_WIDGETS} indicadores`,
  })
  @IsObject({ each: true, message: '(cada item) deve ser um objeto' })
  widgets?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: CompartilhamentoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CompartilhamentoDto)
  compartilhamento?: CompartilhamentoDto;
}

export class AtualizarPainelIndicadoresDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_NOME_PAINEL * 2, { message: 'nome longo demais' })
  @IsNotEmpty({ message: 'não pode ficar vazio' })
  nome?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_DESCRICAO_PAINEL * 2, {
    message: 'descrição longa demais',
  })
  descricao?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  filtrosPadrao?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(MAXIMO_DE_WIDGETS, {
    message: `no máximo ${MAXIMO_DE_WIDGETS} indicadores`,
  })
  @IsObject({ each: true, message: '(cada item) deve ser um objeto' })
  widgets?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: CompartilhamentoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CompartilhamentoDto)
  compartilhamento?: CompartilhamentoDto;
}

export class DuplicarPainelDto {
  @ApiPropertyOptional({
    description: 'Nome da cópia (padrão: "<nome> (cópia)").',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(TAMANHO_NOME_PAINEL * 2, { message: 'nome longo demais' })
  nome?: string;
}

export class CalcularIndicadoresDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Painel salvo a calcular.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  painelId?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Indicadores avulsos (prévia do editor, só quem monta painéis). Com `painelId`, substituem os do painel.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(MAXIMO_DE_WIDGETS, {
    message: `no máximo ${MAXIMO_DE_WIDGETS} indicadores`,
  })
  @IsObject({ each: true, message: '(cada item) deve ser um objeto' })
  widgets?: Record<string, unknown>[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Filtros escolhidos no topo: valem sobre os filtros padrão do painel (e são vencidos pelos do widget).',
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  filtros?: Record<string, unknown>;
}

export class ExportarIndicadoresDto extends CalcularIndicadoresDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: 'formato inválido: use xlsx ou csv' })
  formato?: 'xlsx' | 'csv';

  @ApiPropertyOptional({
    description:
      'Id de um indicador do painel: exporta só a tabela dele. Sem ele, o XLSX leva o resumo e uma aba por indicador, e o CSV, o resumo.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(64)
  widgetId?: string;
}

/** Só para a documentação das respostas (a forma completa está em `indicadores.tipos.ts`). */
export class PainelIndicadoresDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() nome!: string;
  @ApiProperty({ nullable: true, type: String }) descricao!: string | null;
  @ApiProperty({ description: '`{id, nome}` de quem criou.' })
  dono!: { id: string; nome: string };
  @ApiProperty() minha!: boolean;
  @ApiProperty() podeEditar!: boolean;
  @ApiProperty({ nullable: true, type: String }) modelo!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  filtrosPadrao!: Record<string, unknown>;
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Vazio na lista; completo no detalhe.',
  })
  widgets!: Record<string, unknown>[];
  @ApiProperty() quantidadeDeWidgets!: number;
  @ApiProperty({
    nullable: true,
    type: CompartilhamentoDto,
    description: 'Só para quem edita.',
  })
  compartilhamento!: CompartilhamentoDto | null;
  @ApiProperty({ format: 'date-time' }) criadoEm!: string;
  @ApiProperty({ format: 'date-time' }) atualizadoEm!: string;
}
