import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import {
  Area,
  GatilhoFluxo,
  StatusExecucao,
  TipoCanal,
} from '../generated/prisma/client';

function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

const comoBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' || value === true || value === '1'
    ? true
    : value === 'false' || value === false || value === '0'
      ? false
      : value;

const DESCRICAO_DA_DEFINICAO =
  'Definição em passos: `{ passos: [{ id, tipo, rotulo?, config?, ramos?: [{ id, rotulo?, config?, passos }], proximo? }] }`. ' +
  'Tipos: mensagem, pergunta.opcoes, pergunta.aberta, condicao, acao.etiquetar, acao.definir_campo, acao.mover_fila, ' +
  'acao.atribuir, acao.criar_negocio, acao.criar_atividade, acao.webhook, transferir, aguardar, encerrar (`GET /chatbot/passos`).';

export class CriarFluxoChatbotDto {
  @ApiProperty({ maxLength: 120 })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(120, { message: 'deve ter no máximo 120 caracteres' })
  nome!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(500)
  descricao?: string;

  @ApiPropertyOptional({
    enum: Area,
    enumName: 'Area',
    description:
      'Líder: sempre a própria área. Diretoria: escolhe (vazio = todas).',
  })
  @IsOptional()
  @IsEnum(Area, { message: 'área inválida' })
  area?: Area;

  @ApiPropertyOptional({
    type: [String],
    description: 'Canais em que o fluxo vale; vazio = todos.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true, message: 'canal inválido' })
  canalIds?: string[];

  @ApiProperty({ enum: GatilhoFluxo, enumName: 'GatilhoFluxo' })
  @IsEnum(GatilhoFluxo, { message: 'gatilho inválido' })
  gatilho!: GatilhoFluxo;

  @ApiPropertyOptional({
    type: [String],
    description: 'Para o gatilho PALAVRA_CHAVE (sem acento nem caixa).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  palavrasChave?: string[];

  @ApiPropertyOptional({
    description: 'Maior primeiro, quando mais de um fluxo serve.',
    minimum: -100,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(100)
  prioridade?: number;

  @ApiPropertyOptional({
    description: DESCRICAO_DA_DEFINICAO,
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: 'deve ser um objeto' })
  definicao?: Record<string, unknown>;
}

export class AtualizarFluxoChatbotDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @IsNotEmpty({ message: 'não pode ficar vazio' })
  @MaxLength(120)
  nome?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(500)
  descricao?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true, message: 'canal inválido' })
  canalIds?: string[];

  @ApiPropertyOptional({ enum: GatilhoFluxo, enumName: 'GatilhoFluxo' })
  @IsOptional()
  @IsEnum(GatilhoFluxo, { message: 'gatilho inválido' })
  gatilho?: GatilhoFluxo;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  palavrasChave?: string[];

  @ApiPropertyOptional({ minimum: -100, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(100)
  prioridade?: number;
}

export class SalvarRascunhoChatbotDto {
  @ApiProperty({
    description: DESCRICAO_DA_DEFINICAO,
    type: 'object',
    additionalProperties: true,
  })
  @IsObject({ message: 'deve ser um objeto' })
  definicao!: Record<string, unknown>;
}

export class PublicarFluxoChatbotDto {
  @ApiPropertyOptional({
    description:
      'Também ativa o fluxo (padrão: mantém ativo/inativo como está).',
  })
  @IsOptional()
  @IsBoolean()
  ativar?: boolean;
}

export class FiltroFluxosChatbotDto extends PaginacaoDto {
  @ApiPropertyOptional({ description: 'Busca pelo nome.' })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(100)
  busca?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(comoBooleano)
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ enum: GatilhoFluxo, enumName: 'GatilhoFluxo' })
  @IsOptional()
  @IsEnum(GatilhoFluxo, { message: 'gatilho inválido' })
  gatilho?: GatilhoFluxo;
}

export class FiltroExecucoesChatbotDto extends PaginacaoDto {
  @ApiPropertyOptional({ enum: StatusExecucao, enumName: 'StatusExecucao' })
  @IsOptional()
  @IsEnum(StatusExecucao, { message: 'status inválido' })
  status?: StatusExecucao;

  @ApiPropertyOptional({
    description: 'Texto do motivo do fim (ex.: `transferida_para_humano`).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(60)
  motivoFim?: string;
}

class ContatoSimuladoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  telefone?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  etiquetas?: string[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  campos?: Record<string, unknown>;
}

export class IniciarSimulacaoChatbotDto {
  @ApiPropertyOptional({
    enum: ['rascunho', 'publicada'],
    default: 'rascunho',
    description: 'Qual versão roda.',
  })
  @IsOptional()
  @IsIn(['rascunho', 'publicada'])
  origem?: 'rascunho' | 'publicada';

  @ApiPropertyOptional({ enum: TipoCanal, enumName: 'TipoCanal' })
  @IsOptional()
  @IsEnum(TipoCanal, { message: 'canal inválido' })
  canalTipo?: TipoCanal;

  @ApiPropertyOptional({ type: ContatoSimuladoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContatoSimuladoDto)
  contato?: ContatoSimuladoDto;

  @ApiPropertyOptional({
    description:
      'Primeira mensagem do contato (vira `{{variaveis.primeira_mensagem}}`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  mensagem?: string;

  @ApiPropertyOptional({
    description: 'Simula o horário de atendimento aberto (padrão) ou fechado.',
  })
  @IsOptional()
  @IsBoolean()
  horarioAberto?: boolean;
}

export class MensagemDaSimulacaoChatbotDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000)
  texto!: string;
}
