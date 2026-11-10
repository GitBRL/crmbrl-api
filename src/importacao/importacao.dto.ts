import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAXIMO_DE_REGRAS_DO_FILTRO,
  OPERADORES_DO_FILTRO,
  type FiltroDaPlanilha,
  type OperadorFiltro,
} from './filtro-de-linhas';
import { type NegocioParaTodos, lerOpcoes } from './opcoes';
import { QUANTIDADE_MAXIMA_ETIQUETAS } from '../comum/dominio/etiquetas';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import {
  AcaoDuplicado,
  Area,
  EstrategiaDistribuicao,
  type Importacao,
  type ImportacaoModelo,
  ResultadoLinhaImportacao,
  StatusImportacao,
  TipoImportacao,
} from '../generated/prisma/client';

const MENSAGEM_TEXTO = 'deve ser um texto';
const MENSAGEM_UUID = { message: 'deve ser um identificador (UUID) válido' };

const emMaiusculas = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  );

export class LeituraDto {
  @ApiPropertyOptional({
    description: 'CSV: `,` `;` tab ou `|`. Ausente = detecta.',
  })
  @IsOptional()
  @IsIn([',', ';', '\t', '|'], { message: 'deve ser `,`, `;`, tab ou `|`' })
  separador?: string;

  @ApiPropertyOptional({ enum: ['utf-8', 'latin1'] })
  @IsOptional()
  @IsIn(['utf-8', 'latin1'], { message: 'deve ser utf-8 ou latin1' })
  codificacao?: 'utf-8' | 'latin1';

  @ApiPropertyOptional({
    description: 'XLSX: nome da aba (padrão: a primeira).',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  aba?: string;

  @ApiPropertyOptional({
    description: 'Linha do cabeçalho (padrão 1).',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(100, { message: 'deve ser no máximo 100' })
  linhaCabecalho?: number;

  @ApiPropertyOptional({
    description:
      'A planilha não tem cabeçalho: colunas "Coluna 1", "Coluna 2"… e a linha 1 é dado.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  semCabecalho?: boolean;
}

export class CriarImportacaoDto {
  @ApiProperty({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  @emMaiusculas()
  @IsEnum(TipoImportacao, {
    message: 'deve ser CONTATOS, EMPRESAS ou PARCELAS',
  })
  tipo: TipoImportacao;

  @ApiProperty({
    format: 'uuid',
    description:
      'Arquivo enviado antes por `POST /arquivos?contexto=IMPORTACAO` (CSV ou XLSX).',
  })
  @IsUUID('all', MENSAGEM_UUID)
  arquivoId: string;

  @ApiPropertyOptional({ type: LeituraDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LeituraDto)
  leitura?: LeituraDto;
}

export class RegraDoFiltroDto {
  @ApiProperty({ description: 'Nome de uma coluna do arquivo.' })
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  coluna: string;

  @ApiProperty({ enum: OPERADORES_DO_FILTRO })
  @emMaiusculas()
  @IsIn([...OPERADORES_DO_FILTRO], {
    message: `deve ser um destes: ${OPERADORES_DO_FILTRO.join(', ')}`,
  })
  operador: OperadorFiltro;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Obrigatório, menos em VAZIO e PREENCHIDO.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  valor?: string | null;
}

export class FiltroDaPlanilhaDto {
  @ApiProperty({ enum: ['TODAS', 'QUALQUER'] })
  @emMaiusculas()
  @IsIn(['TODAS', 'QUALQUER'], { message: 'deve ser TODAS ou QUALQUER' })
  combinacao: 'TODAS' | 'QUALQUER';

  @ApiProperty({
    type: [RegraDoFiltroDto],
    description: `De 1 a ${MAXIMO_DE_REGRAS_DO_FILTRO} regras.`,
  })
  @IsArray({ message: 'deve ser uma lista de regras' })
  @ArrayMinSize(1, { message: 'informe ao menos uma regra' })
  @ArrayMaxSize(MAXIMO_DE_REGRAS_DO_FILTRO, {
    message: `no máximo ${MAXIMO_DE_REGRAS_DO_FILTRO} regras`,
  })
  @ValidateNested({ each: true })
  @Type(() => RegraDoFiltroDto)
  regras: RegraDoFiltroDto[];
}

export class NegocioParaTodosDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', MENSAGEM_UUID)
  funilId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', MENSAGEM_UUID)
  etapaId: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 200,
    description: 'Padrão: o nome do contato.',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  titulo?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Número maior ou igual a zero (`1500`, `1500.50`).',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um número em texto' })
  @MaxLength(30, { message: 'deve ter no máximo 30 caracteres' })
  valor?: string | null;
}

export class AtualizarImportacaoDto {
  @ApiPropertyOptional({
    type: FiltroDaPlanilhaDto,
    nullable: true,
    description:
      'Só importa as linhas que passam nas regras (R16.11). Nulo remove.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => FiltroDaPlanilhaDto)
  filtro?: FiltroDaPlanilhaDto | null;

  @ApiPropertyOptional({
    type: NegocioParaTodosDto,
    nullable: true,
    description:
      'Negócio para cada contato importado (R16.12), só para contatos. Nulo remove.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NegocioParaTodosDto)
  negocio?: NegocioParaTodosDto | null;

  @ApiPropertyOptional({
    example: '55',
    description: 'DDI aplicado a telefones sem `+`/`00` (1 a 3 dígitos).',
  })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/^\d{1,3}$/, { message: 'deve ter de 1 a 3 dígitos' })
  ddiPadrao?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'E-mail': 'email', Cidade: 'campos.cidade' },
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto { coluna: campo }' })
  mapeamento?: Record<string, string>;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Aplica o modelo salvo às colunas do arquivo (substitui o mapeamento enviado junto).',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  modeloId?: string | null;

  @ApiPropertyOptional({ enum: AcaoDuplicado, enumName: 'AcaoDuplicado' })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(AcaoDuplicado, {
    message: 'deve ser ATUALIZAR_VAZIOS, IGNORAR ou SOBRESCREVER',
  })
  duplicados?: AcaoDuplicado;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(QUANTIDADE_MAXIMA_ETIQUETAS, {
    message: `no máximo ${QUANTIDADE_MAXIMA_ETIQUETAS} etiquetas`,
  })
  @IsString({ each: true, message: 'cada etiqueta deve ser um texto' })
  etiquetas?: string[];

  @ApiPropertyOptional({
    enum: ['RODIZIO', 'RESPONSAVEL_FIXO'],
    nullable: true,
    description:
      'Nulo = quem importa fica como responsável dos registros novos (R4.5).',
  })
  @IsOptional()
  @emMaiusculas()
  @IsIn(['RODIZIO', 'RESPONSAVEL_FIXO'], {
    message: 'deve ser RODIZIO ou RESPONSAVEL_FIXO',
  })
  estrategiaResponsavel?: EstrategiaDistribuicao | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  responsavelId?: string | null;

  @ApiPropertyOptional({ enum: Area, enumName: 'Area', nullable: true })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(Area, { message: 'deve ser MARKETING, COMERCIAL ou CS' })
  areaRodizio?: Area | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  origemDetalhe?: string | null;

  @ApiPropertyOptional({
    type: LeituraDto,
    description:
      'Nova leitura do arquivo (separador, aba…): refaz colunas e total de linhas e zera o mapeamento.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LeituraDto)
  leitura?: LeituraDto;
}

export class FiltroImportacoesDto extends PaginacaoDto {
  @ApiPropertyOptional({ enum: StatusImportacao, enumName: 'StatusImportacao' })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(StatusImportacao, { message: 'status inválido' })
  status?: StatusImportacao;

  @ApiPropertyOptional({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(TipoImportacao, {
    message: 'deve ser CONTATOS, EMPRESAS ou PARCELAS',
  })
  tipo?: TipoImportacao;
}

export class FiltroLinhasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: ResultadoLinhaImportacao,
    enumName: 'ResultadoLinhaImportacao',
  })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(ResultadoLinhaImportacao, { message: 'resultado inválido' })
  resultado?: ResultadoLinhaImportacao;
}

export class FiltroPreviaDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(50, { message: 'deve ser no máximo 50' })
  linhas: number = 10;
}

export class FiltroCamposDto {
  @ApiProperty({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  @emMaiusculas()
  @IsEnum(TipoImportacao, {
    message: 'deve ser CONTATOS, EMPRESAS ou PARCELAS',
  })
  tipo: TipoImportacao;
}

export class FiltroModelosDto {
  @ApiPropertyOptional({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  @IsOptional()
  @emMaiusculas()
  @IsEnum(TipoImportacao, {
    message: 'deve ser CONTATOS, EMPRESAS ou PARCELAS',
  })
  tipo?: TipoImportacao;
}

export class CriarModeloDto {
  @ApiProperty({ maxLength: 100 })
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome: string;

  @ApiProperty({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  @emMaiusculas()
  @IsEnum(TipoImportacao, {
    message: 'deve ser CONTATOS, EMPRESAS ou PARCELAS',
  })
  tipo: TipoImportacao;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @IsObject({ message: 'deve ser um objeto { coluna: campo }' })
  mapeamento: Record<string, string>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  opcoes?: Record<string, unknown>;
}

export class AtualizarModeloDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString({ message: MENSAGEM_TEXTO })
  @Matches(/\S/, { message: 'é obrigatório' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  nome?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto { coluna: campo }' })
  mapeamento?: Record<string, string>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  opcoes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

export class CriadorDaImportacaoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() nome: string;
}

export class ImportacaoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  tipo: TipoImportacao;
  @ApiProperty({ enum: StatusImportacao, enumName: 'StatusImportacao' })
  status: StatusImportacao;
  @ApiProperty({ description: 'Nome original do arquivo.' }) nome: string;
  @ApiProperty({ format: 'uuid' }) arquivoId: string;
  @ApiProperty({ enum: ['csv', 'xlsx'] }) formato: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) leitura: Record<
    string,
    unknown
  >;
  @ApiProperty({ type: [String] }) colunas: string[];
  @ApiProperty({ type: Number, nullable: true }) totalLinhas: number | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  mapeamento: Record<string, string>;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) modeloId:
    string | null;
  @ApiProperty({ enum: AcaoDuplicado, enumName: 'AcaoDuplicado' })
  duplicados: AcaoDuplicado;
  @ApiProperty({ type: [String] }) etiquetas: string[];
  @ApiProperty({
    enum: EstrategiaDistribuicao,
    enumName: 'EstrategiaDistribuicao',
    nullable: true,
  })
  estrategiaResponsavel: EstrategiaDistribuicao | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) responsavelId:
    string | null;
  @ApiProperty({ enum: Area, enumName: 'Area', nullable: true })
  areaRodizio: Area | null;
  @ApiProperty({ type: String, nullable: true }) origemDetalhe: string | null;
  @ApiProperty() processadas: number;
  @ApiProperty() criados: number;
  @ApiProperty() atualizados: number;
  @ApiProperty() ignorados: number;
  @ApiProperty() erros: number;
  @ApiProperty({
    description: 'Linhas que não passaram no filtro da planilha.',
  })
  filtradas: number;
  @ApiProperty() negociosCriados: number;
  @ApiProperty() negociosReconvertidos: number;
  @ApiProperty({ type: FiltroDaPlanilhaDto, nullable: true })
  filtro: FiltroDaPlanilha | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  negocio:
    | (NegocioParaTodos & {
        funil: { id: string; nome: string };
        etapa: { id: string; nome: string };
      })
    | null;
  @ApiProperty({ example: '55' }) ddiPadrao: string;
  @ApiProperty({ description: '0 a 100.' }) progresso: number;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Relatório XLSX (baixe por `GET /importacoes/:id/relatorio`).',
  })
  relatorioId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo de a importação inteira ter falhado.',
  })
  erro: string | null;
  @ApiProperty({ type: String, nullable: true }) iniciadaEm: string | null;
  @ApiProperty({ type: String, nullable: true }) concluidaEm: string | null;
  @ApiProperty() criadoEm: string;
  @ApiProperty({ type: CriadorDaImportacaoDto, nullable: true })
  criadoPor: CriadorDaImportacaoDto | null;

  /** `nomes`: nomes de funis e etapas do cartão "Negócio para todos" (id → nome). */
  static de(
    importacao: Importacao & {
      criadoPor?: { id: string; nome: string } | null;
    },
    nomes: ReadonlyMap<string, string> = new Map(),
  ): ImportacaoDto {
    const total = importacao.totalLinhas ?? 0;
    const feitas = importacao.processadas + importacao.filtradas;
    const progresso =
      importacao.status === 'CONCLUIDA'
        ? 100
        : total > 0
          ? Math.min(100, Math.floor((feitas / total) * 100))
          : 0;
    const opcoes = lerOpcoes(importacao.opcoes);
    const leitura = {
      ...(importacao.leitura as Record<string, unknown>),
    };
    leitura.semCabecalho = leitura.semCabecalho === true;
    return {
      id: importacao.id,
      tipo: importacao.tipo,
      status: importacao.status,
      nome: importacao.nome,
      arquivoId: importacao.arquivoId,
      formato: importacao.formato,
      leitura,
      colunas: importacao.colunas,
      totalLinhas: importacao.totalLinhas,
      mapeamento: importacao.mapeamento as Record<string, string>,
      modeloId: importacao.modeloId,
      duplicados: importacao.duplicados,
      etiquetas: importacao.etiquetas,
      estrategiaResponsavel: importacao.estrategiaResponsavel,
      responsavelId: importacao.responsavelId,
      areaRodizio: importacao.areaRodizio,
      origemDetalhe: importacao.origemDetalhe,
      processadas: importacao.processadas,
      criados: importacao.criados,
      atualizados: importacao.atualizados,
      ignorados: importacao.ignorados,
      erros: importacao.erros,
      filtradas: importacao.filtradas,
      negociosCriados: importacao.negociosCriados,
      negociosReconvertidos: importacao.negociosReconvertidos,
      filtro: opcoes.filtro,
      negocio: opcoes.negocio
        ? {
            ...opcoes.negocio,
            funil: {
              id: opcoes.negocio.funilId,
              nome: nomes.get(opcoes.negocio.funilId) ?? '',
            },
            etapa: {
              id: opcoes.negocio.etapaId,
              nome: nomes.get(opcoes.negocio.etapaId) ?? '',
            },
          }
        : null,
      ddiPadrao: opcoes.ddiPadrao,
      progresso,
      relatorioId: importacao.relatorioId,
      erro: importacao.erro,
      iniciadaEm: importacao.iniciadaEm?.toISOString() ?? null,
      concluidaEm: importacao.concluidaEm?.toISOString() ?? null,
      criadoEm: importacao.criadoEm.toISOString(),
      criadoPor: importacao.criadoPor
        ? { id: importacao.criadoPor.id, nome: importacao.criadoPor.nome }
        : null,
    };
  }
}

export class PreviaDto {
  @ApiProperty({ type: [String] }) colunas: string[];
  @ApiProperty({
    description:
      'Primeiras linhas de dados: `numero` no arquivo e valores na ordem das colunas.',
  })
  linhas: Array<{ numero: number; valores: string[] }>;
  @ApiProperty() totalLinhas: number;
  @ApiProperty({
    description:
      'Linhas que passam no filtro da planilha (igual a `totalLinhas` sem filtro).',
  })
  linhasNoFiltro: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Mapeamento sugerido pelos nomes das colunas.',
  })
  sugestao: Record<string, string>;
  @ApiPropertyOptional({
    type: [String],
    description: 'XLSX: abas do arquivo.',
  })
  abas?: string[];
}

export class CriadaImportacaoDto extends ImportacaoDto {
  @ApiProperty({ type: PreviaDto }) previa: PreviaDto;
}

export class LinhaDeImportacaoDto {
  @ApiProperty() numero: number;
  @ApiProperty({
    enum: ResultadoLinhaImportacao,
    enumName: 'ResultadoLinhaImportacao',
  })
  resultado: ResultadoLinhaImportacao;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) entidadeId:
    string | null;
  @ApiProperty({ type: String, nullable: true }) motivo: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  dados: Record<string, unknown> | null;
}

export class CampoDeImportacaoDto {
  @ApiProperty({ example: 'email' }) chave: string;
  @ApiProperty({ example: 'E-mail' }) rotulo: string;
  @ApiProperty() obrigatorio: boolean;
  @ApiProperty({
    example: 'Contato',
    description:
      'Seção da lista: Contato, Negócio, Campos personalizados, Empresa ou Parcela.',
  })
  grupo: string;
}

export class ModeloDeImportacaoDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() nome: string;
  @ApiProperty({ enum: TipoImportacao, enumName: 'TipoImportacao' })
  tipo: TipoImportacao;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  mapeamento: Record<string, string>;
  @ApiProperty({ type: 'object', additionalProperties: true }) opcoes: Record<
    string,
    unknown
  >;
  @ApiProperty() criadoEm: string;

  static de(modelo: ImportacaoModelo): ModeloDeImportacaoDto {
    return {
      id: modelo.id,
      nome: modelo.nome,
      tipo: modelo.tipo,
      mapeamento: modelo.mapeamento as Record<string, string>,
      opcoes: modelo.opcoes as Record<string, unknown>,
      criadoEm: modelo.criadoEm.toISOString(),
    };
  }
}
