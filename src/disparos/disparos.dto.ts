import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import {
  StatusCampanha,
  StatusDestinatario,
  TipoPublico,
} from '../generated/prisma/client';
import type { Area } from '../comum/dominio/setores';
import { ChaveDeSetor } from '../comum/validacao/setor';

const MENSAGEM_UUID = 'Informe um id válido.';

function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function paraLista({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const itens = (Array.isArray(value) ? value : [value]) as unknown[];
  if (!itens.every((i) => typeof i === 'string')) {
    return value;
  }
  const lista = (itens as string[])
    .flatMap((i) => i.split(','))
    .map((i) => i.trim().toUpperCase())
    .filter((i) => i !== '');
  return lista.length > 0 ? lista : undefined;
}

/** Os canais aceitos nas campanhas. */
export const CANAIS_DE_CAMPANHA = ['WHATSAPP', 'EMAIL'] as const;
export type CanalDeCampanha = (typeof CANAIS_DE_CAMPANHA)[number];

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

class RitmoDto {
  @ApiPropertyOptional({
    description: 'Intervalo mínimo entre envios, em segundos.',
    default: 20,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(3600, { message: 'deve ser no máximo 3600' })
  intervaloMinimoSegundos?: number;

  @ApiPropertyOptional({
    description: 'Intervalo máximo entre envios, em segundos.',
    default: 60,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(3600, { message: 'deve ser no máximo 3600' })
  intervaloMaximoSegundos?: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Envios por lote antes da pausa (nulo = sem lote).',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(10_000, { message: 'deve ser no máximo 10000' })
  loteTamanho?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Pausa entre os lotes, em segundos.',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(86_400, { message: 'deve ser no máximo 86400' })
  lotePausaSegundos?: number | null;

  @ApiPropertyOptional({
    description: 'Mostrar "digitando…" antes de cada envio (WhatsApp).',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  simularDigitando?: boolean;

  @ApiPropertyOptional({
    description: 'Pausa automática depois de tantas falhas seguidas.',
    default: 5,
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(100, { message: 'deve ser no máximo 100' })
  pausarAposFalhas?: number;
}

export class CriarCampanhaDto extends RitmoDto {
  @ApiProperty({ example: 'Reativação de clientes — novembro' })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(150, { message: 'deve ter no máximo 150 caracteres' })
  nome: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(1000)
  descricao?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    nullable: true,
    description: 'Só Admin e C-level escolhem; os demais usam a própria área.',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;

  @ApiProperty({ enum: CANAIS_DE_CAMPANHA })
  @IsIn(CANAIS_DE_CAMPANHA as unknown as string[], {
    message: 'canal inválido: use WHATSAPP ou EMAIL',
  })
  canal: CanalDeCampanha;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Números de WhatsApp (ou caixas de e-mail) em rodízio, na ordem. Podem faltar no rascunho.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  canalIds?: string[];

  @ApiPropertyOptional({
    enum: TipoPublico,
    enumName: 'TipoPublico',
    default: 'SEGMENTO',
  })
  @IsOptional()
  @IsEnum(TipoPublico, { message: 'tipo de público inválido' })
  tipoPublico?: TipoPublico;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Segmento (formato de `/segmentos`), com `tipoPublico = SEGMENTO`.',
  })
  @IsOptional()
  @IsObject()
  segmento?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Importação concluída cujos contatos formam o público.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  importacaoId?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Modelo de origem; o texto é copiado para a campanha.',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  modeloId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Assunto do e-mail (aceita variáveis).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(300)
  assunto?: string | null;

  @ApiPropertyOptional({
    description:
      'Texto com variáveis `{{contato.primeiro_nome}}` e variações `{Olá|Oi}`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  texto?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Mídia (arquivo com contexto CAMPANHA).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Janela de envio: `{ fusoHorario, dias: { "1": [{ inicio, fim }] } }` (0 = domingo). Nula = qualquer hora.',
  })
  @IsOptional()
  @IsObject()
  janelaEnvio?: Record<string, unknown> | null;
}

export class AtualizarCampanhaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(150)
  nome?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(1000)
  descricao?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  canalIds?: string[];

  @ApiPropertyOptional({ enum: TipoPublico, enumName: 'TipoPublico' })
  @IsOptional()
  @IsEnum(TipoPublico)
  tipoPublico?: TipoPublico;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  segmento?: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  importacaoId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  modeloId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(300)
  assunto?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  texto?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  janelaEnvio?: Record<string, unknown> | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0)
  @Max(3600)
  intervaloMinimoSegundos?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0)
  @Max(3600)
  intervaloMaximoSegundos?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1)
  @Max(10_000)
  loteTamanho?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1)
  @Max(86_400)
  lotePausaSegundos?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  simularDigitando?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1)
  @Max(100)
  pausarAposFalhas?: number;
}

export class FiltroCampanhasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusCampanha,
    enumName: 'StatusCampanha',
    isArray: true,
    description: 'Um ou vários (`?status=EM_ANDAMENTO,PAUSADA`).',
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray()
  @IsEnum(StatusCampanha, { each: true, message: 'status inválido' })
  status?: StatusCampanha[];

  @ApiPropertyOptional({ enum: CANAIS_DE_CAMPANHA })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(CANAIS_DE_CAMPANHA as unknown as string[], {
    message: 'canal inválido',
  })
  canal?: CanalDeCampanha;

  @ApiPropertyOptional({ description: 'Busca pelo nome.' })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(100)
  busca?: string;

  @ApiPropertyOptional({ type: String, example: 'COMERCIAL' })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area;

  @ApiPropertyOptional({ description: 'Só as que eu criei.' })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) =>
      value === 'true' || value === true || value === '1',
  )
  @IsBoolean()
  minhas?: boolean;
}

export class IniciarCampanhaDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Futuro = agenda; ausente = começa agora.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'informe uma data e hora válidas' })
  agendadaPara?: string;
}

export class ReprovarCampanhaDto {
  @ApiProperty({ example: 'O texto promete um desconto que não temos.' })
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'Informe o motivo.' })
  @MaxLength(500)
  motivo: string;
}

export class PausarCampanhaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(300)
  motivo?: string;
}

export class PreviaDaMensagemDto {
  @ApiPropertyOptional({
    description: 'Contato da prévia (sem ele, usa dados de exemplo).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;
}

export class EnvioDeTesteDto {
  @ApiPropertyOptional({
    description: 'Telefone de teste (padrão: o telefone do seu usuário).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(40)
  telefone?: string;

  @ApiPropertyOptional({ description: 'E-mail de teste (padrão: o seu).' })
  @IsOptional()
  @Transform(aparar)
  @IsEmail({}, { message: 'informe um e-mail válido' })
  email?: string;

  @ApiPropertyOptional({
    description: 'Contato que recebe o teste (em vez de telefone/e-mail).',
  })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  contatoId?: string;
}

export class PreviaDoPublicoDto {
  @ApiProperty({ enum: CANAIS_DE_CAMPANHA })
  @IsIn(CANAIS_DE_CAMPANHA as unknown as string[], {
    message: 'canal inválido: use WHATSAPP ou EMAIL',
  })
  canal: CanalDeCampanha;

  @ApiPropertyOptional({
    enum: TipoPublico,
    enumName: 'TipoPublico',
    default: 'SEGMENTO',
  })
  @IsOptional()
  @IsEnum(TipoPublico)
  tipoPublico?: TipoPublico;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf(
    (o: PreviaDoPublicoDto) => (o.tipoPublico ?? 'SEGMENTO') === 'SEGMENTO',
  )
  @IsObject({ message: 'informe o segmento' })
  segmento?: Record<string, unknown>;

  @ApiPropertyOptional()
  @ValidateIf((o: PreviaDoPublicoDto) => o.tipoPublico === 'IMPORTACAO')
  @IsUUID('all', { message: MENSAGEM_UUID })
  importacaoId?: string;
}

export class EstimativaDto {
  @ApiProperty({ example: 1200, description: 'Quantos destinatários.' })
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0)
  @Max(1_000_000)
  total: number;

  @ApiProperty({ enum: CANAIS_DE_CAMPANHA })
  @IsIn(CANAIS_DE_CAMPANHA as unknown as string[])
  canal: CanalDeCampanha;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true, message: MENSAGEM_UUID })
  canalIds?: string[];

  @ApiPropertyOptional({ type: () => RitmoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RitmoDto)
  ritmo?: RitmoDto;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  janelaEnvio?: Record<string, unknown> | null;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  inicio?: string;
}

export class FiltroDestinatariosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusDestinatario,
    enumName: 'StatusDestinatario',
    isArray: true,
  })
  @IsOptional()
  @Transform(paraLista)
  @IsArray()
  @IsEnum(StatusDestinatario, { each: true, message: 'status inválido' })
  status?: StatusDestinatario[];

  @ApiPropertyOptional({ description: 'Nome, e-mail ou telefone do contato.' })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(100)
  busca?: string;

  @ApiPropertyOptional({ description: 'Só quem respondeu / não respondeu.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  respondeu?: boolean;
}

export class FiltroRelatorioDto {
  @ApiPropertyOptional({
    enum: ['hora', 'dia'],
    default: 'hora',
    description: 'Agrupamento da série no tempo.',
  })
  @IsOptional()
  @IsIn(['hora', 'dia'])
  agrupar?: 'hora' | 'dia';
}

export class ExportarCampanhaDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: 'formato inválido: use xlsx ou csv' })
  formato?: 'xlsx' | 'csv';
}

export class AtualizarConfiguracaoDisparosDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  aprovacaoDoLider?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['SAIR', 'PARAR', 'CANCELAR'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'informe ao menos uma palavra' })
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  palavrasDeSaida?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(1000)
  mensagemDeSaida?: string;
}

// ---------------------------------------------------------------------------
// Modelos de mensagem
// ---------------------------------------------------------------------------

export class CriarModeloMensagemDto {
  @ApiProperty({ example: 'Reativação — oferta' })
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(150)
  nome: string;

  @ApiPropertyOptional({
    enum: CANAIS_DE_CAMPANHA,
    nullable: true,
    description: 'Nulo = serve para os dois canais.',
  })
  @IsOptional()
  @IsIn([...CANAIS_DE_CAMPANHA, null] as unknown as string[], {
    message: 'canal inválido: use WHATSAPP ou EMAIL',
  })
  canal?: CanalDeCampanha | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(300)
  assunto?: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(10_000)
  texto: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'COMERCIAL',
    nullable: true,
    description: 'Nula = de todas as áreas.',
  })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;
}

export class AtualizarModeloMensagemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(150)
  nome?: string;

  @ApiPropertyOptional({ enum: CANAIS_DE_CAMPANHA, nullable: true })
  @IsOptional()
  @IsIn([...CANAIS_DE_CAMPANHA, null] as unknown as string[], {
    message: 'canal inválido: use WHATSAPP ou EMAIL',
  })
  canal?: CanalDeCampanha | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(300)
  assunto?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(10_000)
  texto?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID('all', { message: MENSAGEM_UUID })
  arquivoId?: string | null;

  @ApiPropertyOptional({ type: String, example: 'COMERCIAL', nullable: true })
  @IsOptional()
  @ChaveDeSetor()
  area?: Area | null;
}

export class FiltroModelosMensagemDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: CANAIS_DE_CAMPANHA,
    description: 'Traz os do canal e os que servem para os dois.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(CANAIS_DE_CAMPANHA as unknown as string[], {
    message: 'canal inválido',
  })
  canal?: CanalDeCampanha;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(100)
  busca?: string;
}
