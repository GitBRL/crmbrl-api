import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  AlvoCriterioSdr,
  ModoSdr,
  TipoCriterioSdr,
  TipoDecisaoSdr,
} from '../../generated/prisma/client';
import {
  ESFORCOS_DO_SDR,
  LIMITES_DO_SDR as L,
  MODELOS_DO_SDR,
} from '../sdr.constantes';

const aparar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

function texto(minimo: number, maximo: number) {
  return [
    IsString({ message: 'deve ser um texto' }),
    MinLength(minimo, { message: `deve ter no mínimo ${minimo} caracteres` }),
    MaxLength(maximo, { message: `deve ter no máximo ${maximo} caracteres` }),
    Transform(aparar),
  ];
}

function aplicar(decoradores: PropertyDecorator[]): PropertyDecorator {
  return (alvo, chave) => {
    for (const d of decoradores) {
      d(alvo, chave);
    }
  };
}

function inteiro(minimo: number, maximo: number): PropertyDecorator {
  return aplicar([
    IsInt({ message: 'deve ser um número inteiro' }),
    Min(minimo, { message: `deve ser no mínimo ${minimo}` }),
    Max(maximo, { message: `deve ser no máximo ${maximo}` }),
  ]);
}

// ---------------------------------------------------------------------------
// Configuração geral
// ---------------------------------------------------------------------------

export class RegrasDePassagemDto {
  @ApiPropertyOptional({ description: 'O lead pede uma pessoa.' })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  pedidoHumano?: boolean;

  @ApiPropertyOptional({ description: 'Assunto sensível ou fora do escopo.' })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  assuntoSensivel?: boolean;

  @ApiPropertyOptional({ description: 'A IA sem confiança.' })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  baixaConfianca?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description:
      'Confiança mínima (0 a 1) para gravar um critério e para qualificar.',
  })
  @IsOptional()
  @IsNumber({}, { message: 'deve ser um número' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(1, { message: 'deve ser no máximo 1' })
  confiancaMinima?: number;

  @ApiPropertyOptional({ description: 'Limite de mensagens sem avanço.' })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  semAvanco?: boolean;

  @ApiPropertyOptional({ description: 'Reclamação.' })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  reclamacao?: boolean;
}

/** `PUT /sdr/configuracao`: parcial. */
export class AtualizarConfiguracaoSdrDto {
  @ApiPropertyOptional({ description: 'Nome da assistente.' })
  @IsOptional()
  @aplicar(texto(L.nomeAssistente.min, L.nomeAssistente.max))
  nomeAssistente?: string;

  @ApiPropertyOptional({ description: 'Tom da conversa.' })
  @IsOptional()
  @aplicar(texto(L.tom.min, L.tom.max))
  tom?: string;

  @ApiPropertyOptional({
    description:
      'Apresentação obrigatória como assistente virtual ("Sou a Bia, assistente virtual da BRL").',
  })
  @IsOptional()
  @aplicar(texto(L.apresentacao.min, L.apresentacao.max))
  apresentacao?: string;

  @ApiPropertyOptional({ description: 'Mensagem de passagem para humano.' })
  @IsOptional()
  @aplicar(texto(L.mensagemPassagem.min, L.mensagemPassagem.max))
  mensagemPassagem?: string;

  @ApiPropertyOptional({
    enum: MODELOS_DO_SDR.map((m) => m.id),
    description: 'Modelo do Claude.',
  })
  @IsOptional()
  @IsIn(MODELOS_DO_SDR.map((m) => m.id), { message: 'modelo não aceito' })
  modelo?: string;

  @ApiPropertyOptional({ enum: ESFORCOS_DO_SDR })
  @IsOptional()
  @IsIn([...ESFORCOS_DO_SDR], { message: 'use low, medium ou high' })
  esforco?: string;

  @ApiPropertyOptional({
    description: 'Segundos de espera para agrupar mensagens seguidas do lead.',
  })
  @IsOptional()
  @inteiro(L.esperaAgrupamentoSegundos.min, L.esperaAgrupamentoSegundos.max)
  esperaAgrupamentoSegundos?: number;

  @ApiPropertyOptional({ description: 'Mensagens da IA por conversa.' })
  @IsOptional()
  @inteiro(L.maxMensagensPorConversa.min, L.maxMensagensPorConversa.max)
  maxMensagensPorConversa?: number;

  @ApiPropertyOptional({
    description: 'Mensagens seguidas sem avanço na qualificação.',
  })
  @IsOptional()
  @inteiro(L.maxMensagensSemAvanco.min, L.maxMensagensSemAvanco.max)
  maxMensagensSemAvanco?: number;

  @ApiPropertyOptional({ description: 'Tokens por conversa.' })
  @IsOptional()
  @inteiro(L.maxTokensPorConversa.min, L.maxTokensPorConversa.max)
  maxTokensPorConversa?: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Orçamento mensal de tokens. `null` = sem orçamento.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @inteiro(L.orcamentoMensalTokens.min, L.orcamentoMensalTokens.max)
  orcamentoMensalTokens?: number | null;

  @ApiPropertyOptional({
    description: 'Nota mínima para qualificar (0 a 100).',
  })
  @IsOptional()
  @inteiro(L.nota.min, L.nota.max)
  notaMinimaQualificado?: number;

  @ApiPropertyOptional({
    description: 'Nota a partir da qual o lead é quente.',
  })
  @IsOptional()
  @inteiro(L.nota.min, L.nota.max)
  faixaQuente?: number;

  @ApiPropertyOptional({ description: 'Nota a partir da qual o lead é morno.' })
  @IsOptional()
  @inteiro(L.nota.min, L.nota.max)
  faixaMorno?: number;

  @ApiPropertyOptional({ type: RegrasDePassagemDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegrasDePassagemDto)
  regrasPassagem?: RegrasDePassagemDto;
}

export class DefinirModoDoCanalSdrDto {
  @ApiProperty({
    enum: ModoSdr,
    enumName: 'ModoSdr',
    description:
      '`DESLIGADO`, `AUTOMATICO` (a IA responde sozinha) ou `SUGESTAO` (só propõe a resposta ao atendente).',
  })
  @IsEnum(ModoSdr, { message: 'use DESLIGADO, AUTOMATICO ou SUGESTAO' })
  modo: ModoSdr;
}

// ---------------------------------------------------------------------------
// Base de conhecimento
// ---------------------------------------------------------------------------

export class CriarArtigoSdrDto {
  @ApiProperty()
  @aplicar(texto(L.artigoTitulo.min, L.artigoTitulo.max))
  titulo: string;

  @ApiProperty({ description: 'Texto do artigo (preços, prazos, FAQ…).' })
  @aplicar(texto(L.artigoConteudo.min, L.artigoConteudo.max))
  conteudo: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;

  @ApiPropertyOptional({ description: 'Ordem no prompt (menor primeiro).' })
  @IsOptional()
  @inteiro(0, 10_000)
  ordem?: number;
}

export class AtualizarArtigoSdrDto {
  @ApiPropertyOptional()
  @IsOptional()
  @aplicar(texto(L.artigoTitulo.min, L.artigoTitulo.max))
  titulo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @aplicar(texto(L.artigoConteudo.min, L.artigoConteudo.max))
  conteudo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @inteiro(0, 10_000)
  ordem?: number;
}

// ---------------------------------------------------------------------------
// Critérios
// ---------------------------------------------------------------------------

export class CriarCriterioSdrDto {
  @ApiProperty({
    description:
      'Identificador estável (minúsculas, números e `_`; começa com letra). Vai no prompt e na saída da IA.',
    example: 'curso',
  })
  @aplicar(texto(L.criterioChave.min, L.criterioChave.max))
  chave: string;

  @ApiProperty({ example: 'Curso de interesse' })
  @aplicar(texto(L.criterioRotulo.min, L.criterioRotulo.max))
  rotulo: string;

  @ApiProperty({ description: 'O que a IA deve descobrir e como entender.' })
  @aplicar(texto(L.criterioInstrucao.min, L.criterioInstrucao.max))
  instrucao: string;

  @ApiPropertyOptional({
    enum: TipoCriterioSdr,
    enumName: 'TipoCriterioSdr',
    default: 'TEXTO',
  })
  @IsOptional()
  @IsEnum(TipoCriterioSdr, {
    message: 'use TEXTO, OPCAO, NUMERO, DATA ou SIM_NAO',
  })
  tipo?: TipoCriterioSdr;

  @ApiPropertyOptional({
    type: [String],
    description: 'Obrigatório (2 a 20) quando o tipo é `OPCAO`.',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(L.criterioOpcoes, {
    message: `deve ter no máximo ${L.criterioOpcoes} opções`,
  })
  @IsString({ each: true, message: 'cada opção deve ser um texto' })
  @MaxLength(L.criterioOpcao, {
    each: true,
    message: `cada opção deve ter no máximo ${L.criterioOpcao} caracteres`,
  })
  opcoes?: string[];

  @ApiPropertyOptional({
    enum: AlvoCriterioSdr,
    enumName: 'AlvoCriterioSdr',
    default: 'NENHUM',
    description:
      'Onde gravar o valor: no contato, no negócio ou só na qualificação.',
  })
  @IsOptional()
  @IsEnum(AlvoCriterioSdr, { message: 'use NENHUM, CONTATO ou NEGOCIO' })
  alvo?: AlvoCriterioSdr;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Campo de destino: `nome`, `cargo` ou `campos.<chave>` (contato); `campos.<chave>` (negócio). Veja `GET /sdr/campos-disponiveis`.',
    example: 'campos.curso',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(110, { message: 'deve ter no máximo 110 caracteres' })
  @Transform(aparar)
  campo?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @inteiro(L.peso.min, L.peso.max)
  peso?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  obrigatorio?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @inteiro(0, 10_000)
  ordem?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;
}

/** `PUT /sdr/criterios/:id`: parcial (a chave não muda). */
export class AtualizarCriterioSdrDto {
  @ApiPropertyOptional()
  @IsOptional()
  @aplicar(texto(L.criterioRotulo.min, L.criterioRotulo.max))
  rotulo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @aplicar(texto(L.criterioInstrucao.min, L.criterioInstrucao.max))
  instrucao?: string;

  @ApiPropertyOptional({ enum: TipoCriterioSdr, enumName: 'TipoCriterioSdr' })
  @IsOptional()
  @IsEnum(TipoCriterioSdr, {
    message: 'use TEXTO, OPCAO, NUMERO, DATA ou SIM_NAO',
  })
  tipo?: TipoCriterioSdr;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(L.criterioOpcoes, {
    message: `deve ter no máximo ${L.criterioOpcoes} opções`,
  })
  @IsString({ each: true, message: 'cada opção deve ser um texto' })
  @MaxLength(L.criterioOpcao, {
    each: true,
    message: `cada opção deve ter no máximo ${L.criterioOpcao} caracteres`,
  })
  opcoes?: string[];

  @ApiPropertyOptional({ enum: AlvoCriterioSdr, enumName: 'AlvoCriterioSdr' })
  @IsOptional()
  @IsEnum(AlvoCriterioSdr, { message: 'use NENHUM, CONTATO ou NEGOCIO' })
  alvo?: AlvoCriterioSdr;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(110, { message: 'deve ter no máximo 110 caracteres' })
  @Transform(aparar)
  campo?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @inteiro(L.peso.min, L.peso.max)
  peso?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  obrigatorio?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @inteiro(0, 10_000)
  ordem?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativo?: boolean;
}

export class ReordenarCriteriosSdrDto {
  @ApiProperty({
    type: [String],
    description: 'Ids dos critérios na nova ordem.',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(L.criterios, {
    message: `deve ter no máximo ${L.criterios} ids`,
  })
  @IsUUID('all', { each: true, message: 'cada id deve ser um UUID' })
  ids: string[];
}

// ---------------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------------

export class MensagemDoSimuladorSdrDto {
  @ApiProperty({ enum: ['lead', 'ia'] })
  @IsIn(['lead', 'ia'], { message: 'use lead ou ia' })
  papel: 'lead' | 'ia';

  @ApiProperty()
  @aplicar(texto(1, 2000))
  texto: string;
}

export class ValorDoSimuladorSdrDto {
  @ApiProperty()
  @aplicar(texto(1, 40))
  chave: string;

  @ApiPropertyOptional({
    description: 'Ignorado (a tela pode devolver o item como veio).',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  rotulo?: string;

  @ApiProperty({
    description: 'Texto, número ou sim/não, como o turno anterior devolveu.',
  })
  @aplicar(texto(1, 300))
  valor: string;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsNumber({}, { message: 'deve ser um número' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(1, { message: 'deve ser no máximo 1' })
  confianca: number;
}

/** `POST /sdr/simulador/turno`: a conversa até aqui (sem estado no servidor). */
export class TurnoDoSimuladorSdrDto {
  @ApiProperty({
    type: [MensagemDoSimuladorSdrDto],
    description:
      'A conversa até agora, em ordem; a última precisa ser do lead. Máximo de 40 mensagens.',
  })
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(40, { message: 'deve ter no máximo 40 mensagens' })
  @ValidateNested({ each: true })
  @Type(() => MensagemDoSimuladorSdrDto)
  mensagens: MensagemDoSimuladorSdrDto[];

  @ApiPropertyOptional({
    type: [ValorDoSimuladorSdrDto],
    description:
      'Os critérios descobertos nos turnos anteriores (devolvidos em `valores` pelo turno anterior).',
  })
  @IsOptional()
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(L.criterios, {
    message: `deve ter no máximo ${L.criterios} valores`,
  })
  @ValidateNested({ each: true })
  @Type(() => ValorDoSimuladorSdrDto)
  valores?: ValorDoSimuladorSdrDto[];

  @ApiPropertyOptional({
    description:
      'Quantas respostas da IA já houve (padrão: contadas nas mensagens).',
  })
  @IsOptional()
  @inteiro(0, 1000)
  mensagensDaIa?: number;
}

// ---------------------------------------------------------------------------
// Conversas e sugestões
// ---------------------------------------------------------------------------

export class AprovarSugestaoSdrDto {
  @ApiPropertyOptional({
    description:
      'O texto a enviar, se o atendente editou a sugestão. Sem ele, vai o texto sugerido.',
  })
  @IsOptional()
  @aplicar(texto(1, 4000))
  texto?: string;
}

export class FiltroDecisoesSdrDto extends PaginacaoDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um UUID' })
  conversaId?: string;

  @ApiPropertyOptional({ enum: TipoDecisaoSdr, enumName: 'TipoDecisaoSdr' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(TipoDecisaoSdr, { message: 'tipo de decisão desconhecido' })
  tipo?: TipoDecisaoSdr;
}
