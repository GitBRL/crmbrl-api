import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { FORMATO_VALOR } from '../comum/dominio/dinheiro';
import { PaginacaoDto } from '../comum/paginacao/paginacao';
import {
  FormaPagamento,
  PeriodicidadeContrato,
  ResultadoLigacao,
  StatusContrato,
  StatusParcela,
} from '../generated/prisma/client';
import { FAIXAS_DE_ATRASO } from './financeiro.constantes';

const MSG_VALOR =
  'deve ser um valor em reais com até 2 casas, com ponto (ex.: 1500.00)';
const MSG_DATA = 'deve ser uma data AAAA-MM-DD';
export const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MSG_UUID = 'Informe um id válido.';

function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function lista({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const itens = Array.isArray(value) ? value : [value];
  return (itens as unknown[])
    .flatMap((i) => (typeof i === 'string' ? i.split(',') : [i]))
    .map((i) => (typeof i === 'string' ? i.trim().toUpperCase() : i))
    .filter((i) => i !== '');
}

function booleano({ value }: { value: unknown }): unknown {
  return value === 'true' ? true : value === 'false' ? false : value;
}

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

export class CriarContratoDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  empresaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contatoId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Negócio ganho de origem; completa o cliente e o responsável.',
  })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  negocioId?: string;

  @ApiProperty({ example: 'Plano Pro' })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'Informe o produto ou plano.' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  produto: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  descricao?: string | null;

  @ApiProperty({
    example: '299.90',
    description: 'Valor de cada período de cobrança.',
  })
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valor: string;

  @ApiPropertyOptional({
    enum: PeriodicidadeContrato,
    enumName: 'PeriodicidadeContrato',
    default: 'MENSAL',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(PeriodicidadeContrato, { message: 'periodicidade inválida' })
  periodicidade?: PeriodicidadeContrato;

  @ApiProperty({ format: 'date' })
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  inicioEm: string;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  fimEm?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  renovacaoEm?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  renovacaoAutomatica?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 31 })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(31, { message: 'deve ser no máximo 31' })
  diaVencimento?: number | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Responsável de CS.',
  })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  responsavelCsId?: string | null;

  @ApiPropertyOptional({
    default: true,
    description: 'Gera as parcelas do contrato.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  gerarParcelas?: boolean;

  @ApiPropertyOptional({
    description:
      'Quantidade de parcelas (padrão: até o fim do contrato, ou 12).',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(120, { message: 'deve ser no máximo 120' })
  quantidadeParcelas?: number;
}

export class AtualizarContratoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'Informe o produto ou plano.' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  produto?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valor?: string;

  @ApiPropertyOptional({
    enum: PeriodicidadeContrato,
    enumName: 'PeriodicidadeContrato',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(PeriodicidadeContrato, { message: 'periodicidade inválida' })
  periodicidade?: PeriodicidadeContrato;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  fimEm?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  renovacaoEm?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  renovacaoAutomatica?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(31, { message: 'deve ser no máximo 31' })
  diaVencimento?: number | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: MSG_UUID })
  responsavelCsId?: string | null;

  @ApiPropertyOptional({
    description:
      'Aplica o novo valor às parcelas em aberto que ainda vão vencer.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  atualizarParcelasAbertas?: boolean;
}

export class CancelarContratoDto {
  @ApiProperty()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'Informe o motivo do cancelamento.' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  motivo: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Cancela as parcelas em aberto que ainda não venceram.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  cancelarParcelas?: boolean;
}

export class GerarParcelasDto {
  @ApiProperty({ minimum: 1, maximum: 120 })
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(120, { message: 'deve ser no máximo 120' })
  quantidade: number;
}

export class FiltroContratosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusContrato,
    enumName: 'StatusContrato',
    isArray: true,
  })
  @IsOptional()
  @Transform(lista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsIn(Object.values(StatusContrato), {
    each: true,
    message: 'status inválido',
  })
  status?: StatusContrato[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  empresaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contatoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  negocioId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  responsavelCsId?: string;

  @ApiPropertyOptional({
    description: 'Produto, cliente ou número (C-000012).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;
}

// ---------------------------------------------------------------------------
// Parcelas
// ---------------------------------------------------------------------------

export class CriarParcelaDto {
  @ApiPropertyOptional({
    description: 'Identificador do título (único). Padrão: gerado.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'não pode ficar vazio' })
  @MaxLength(60, { message: 'deve ter no máximo 60 caracteres' })
  numero?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contratoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contatoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  empresaId?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  descricao?: string | null;

  @ApiProperty({ format: 'date' })
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  vencimento: string;

  @ApiProperty({ example: '299.90' })
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valor: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  linkBoleto?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  linkPagamento?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Pix copia e cola.' })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  pix?: string | null;
}

export class AtualizarParcelaDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(500, { message: 'deve ter no máximo 500 caracteres' })
  descricao?: string | null;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Mudar o vencimento reinicia a régua do título.',
  })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  vencimento?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valor?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  linkBoleto?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  linkPagamento?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(2000, { message: 'deve ter no máximo 2000 caracteres' })
  pix?: string | null;
}

export class BaixaDto {
  @ApiPropertyOptional({ format: 'date', description: 'Padrão: hoje.' })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  pagoEm?: string;

  @ApiPropertyOptional({ description: 'Padrão: o valor da parcela.' })
  @IsOptional()
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valorPago?: string;

  @ApiPropertyOptional({ enum: FormaPagamento, enumName: 'FormaPagamento' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(FormaPagamento, { message: 'forma de pagamento inválida' })
  formaPagamento?: FormaPagamento;
}

export class RenegociarParcelaDto {
  @ApiProperty({ format: 'date' })
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  vencimento: string;

  @ApiPropertyOptional({
    description: 'Padrão: o valor da parcela renegociada.',
  })
  @IsOptional()
  @Matches(FORMATO_VALOR, { message: MSG_VALOR })
  valor?: string;
}

export class FiltroParcelasDto extends PaginacaoDto {
  @ApiPropertyOptional({
    enum: StatusParcela,
    enumName: 'StatusParcela',
    isArray: true,
    description: 'ATRASADO inclui as abertas já vencidas.',
  })
  @IsOptional()
  @Transform(lista)
  @IsArray({ message: 'deve ser uma lista' })
  @IsIn(Object.values(StatusParcela), {
    each: true,
    message: 'status inválido',
  })
  status?: StatusParcela[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contratoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  contatoId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  empresaId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  responsavelCsId?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  vencimentoDe?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  vencimentoAte?: string;

  @ApiPropertyOptional({ enum: FAIXAS_DE_ATRASO })
  @IsOptional()
  @IsIn(FAIXAS_DE_ATRASO, { message: 'faixa inválida' })
  faixa?: (typeof FAIXAS_DE_ATRASO)[number];

  @ApiPropertyOptional({
    description: 'Número do título, cliente, e-mail ou telefone.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(100, { message: 'deve ter no máximo 100 caracteres' })
  busca?: string;

  @ApiPropertyOptional({
    description: 'Só as com promessa de pagamento vigente.',
  })
  @IsOptional()
  @Transform(booleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  comPromessa?: boolean;
}

export class FiltroExportacaoDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: 'deve ser xlsx ou csv' })
  formato?: 'xlsx' | 'csv';
}

// ---------------------------------------------------------------------------
// Indicadores
// ---------------------------------------------------------------------------

export class FiltroPeriodoDto {
  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Mês inicial (AAAA-MM). Padrão: 11 meses atrás.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'deve ser um mês AAAA-MM' })
  de?: string;

  @ApiPropertyOptional({
    example: '2026-10',
    description: 'Mês final (AAAA-MM). Padrão: o mês atual.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'deve ser um mês AAAA-MM' })
  ate?: string;
}

// ---------------------------------------------------------------------------
// Régua
// ---------------------------------------------------------------------------

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SalvarEtapaDto {
  @ApiProperty({ example: 'Lembrete de pagamento' })
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @IsNotEmpty({ message: 'Informe o nome da etapa.' })
  @MaxLength(120, { message: 'deve ter no máximo 120 caracteres' })
  nome: string;

  @ApiProperty({
    example: 3,
    description: 'Dias a partir do vencimento (negativo = antes).',
  })
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(-365, { message: 'deve ser no mínimo -365' })
  @Max(365, { message: 'deve ser no máximo 365' })
  marco: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  whatsapp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  email?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ligacao?: boolean;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: MSG_UUID })
  modeloWhatsappId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Aceita {{titulo.valor}}, {{titulo.vencimento}}, {{titulo.link_pagamento}}… e variações {a|b}.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(4000, { message: 'deve ter no máximo 4000 caracteres' })
  textoWhatsapp?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: MSG_UUID })
  modeloEmailId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(300, { message: 'deve ter no máximo 300 caracteres' })
  assuntoEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(8000, { message: 'deve ter no máximo 8000 caracteres' })
  textoEmail?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(4000, { message: 'deve ter no máximo 4000 caracteres' })
  roteiroLigacao?: string | null;
}

export class AtualizarConfiguracaoReguaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  ativa?: boolean;

  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @Matches(HORA, { message: 'deve ser HH:MM' })
  horario?: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'Etapas atrasadas além destes dias são puladas.',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(60, { message: 'deve ser no máximo 60' })
  toleranciaDias?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Número de WhatsApp do financeiro (canal). Nulo = qualquer número conectado.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all', { message: MSG_UUID })
  canalWhatsappId?: string | null;

  @ApiPropertyOptional({
    example: 20,
    description: 'Intervalo entre mensagens de WhatsApp, em segundos.',
  })
  @IsOptional()
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(0, { message: 'deve ser no mínimo 0' })
  @Max(600, { message: 'deve ser no máximo 600' })
  intervaloWhatsappSegundos?: number;

  @ApiPropertyOptional({
    example: '17:00',
    description:
      'Sem resultado da ligação até este horário, a mensagem da etapa sai sozinha.',
  })
  @IsOptional()
  @Matches(HORA, { message: 'deve ser HH:MM' })
  horarioLimiteLigacoes?: string;

  @ApiPropertyOptional({
    description: 'Pausa os envios (WhatsApp e e-mail) da régua.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  pausada?: boolean;

  @ApiPropertyOptional({
    description:
      'Confirmação enviada ao registrar uma promessa. Variáveis {{titulo.promessa}}…',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(4000, { message: 'deve ter no máximo 4000 caracteres' })
  textoPromessaConfirmada?: string;

  @ApiPropertyOptional({
    description: 'Aviso enviado quando a data prometida passa sem pagamento.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(4000, { message: 'deve ter no máximo 4000 caracteres' })
  textoPromessaNaoCumprida?: string;
}

export class ResultadoLigacaoDto {
  @ApiProperty({ enum: ['PROMESSA', 'SEM_ACORDO', 'NAO_ATENDEU', 'JA_PAGOU'] })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(['PROMESSA', 'SEM_ACORDO', 'NAO_ATENDEU', 'JA_PAGOU'], {
    message: 'deve ser PROMESSA, SEM_ACORDO, NAO_ATENDEU ou JA_PAGOU',
  })
  resultado: Exclude<ResultadoLigacao, 'EXPIRADA'>;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Obrigatória na promessa; depois de hoje.',
  })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  promessaAte?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(1000, { message: 'deve ter no máximo 1000 caracteres' })
  observacao?: string;
}

export class FiltroEnviosDto extends PaginacaoDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Dia da execução. Padrão: hoje.',
  })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  dia?: string;

  @ApiPropertyOptional({ enum: ['WHATSAPP', 'EMAIL', 'LIGACAO'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(['WHATSAPP', 'EMAIL', 'LIGACAO'], { message: 'canal inválido' })
  canal?: 'WHATSAPP' | 'EMAIL' | 'LIGACAO';

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsString({ message: 'deve ser um texto' })
  situacao?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: MSG_UUID })
  parcelaId?: string;
}

export class FiltroLigacoesDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Só as que ainda aguardam resultado (padrão: sim).',
  })
  @IsOptional()
  @Transform(booleano)
  @IsBoolean({ message: 'deve ser verdadeiro ou falso' })
  pendentes?: boolean;
}

export class ReenviarDto {
  @ApiPropertyOptional({ enum: ['WHATSAPP', 'EMAIL'] })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(['WHATSAPP', 'EMAIL'], { message: 'canal inválido' })
  canal?: 'WHATSAPP' | 'EMAIL';

  @ApiPropertyOptional({
    format: 'date',
    description: 'Dia da execução. Padrão: hoje.',
  })
  @IsOptional()
  @Matches(FORMATO_DATA, { message: MSG_DATA })
  dia?: string;
}

export class ExportarParcelasDto extends FiltroParcelasDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: 'deve ser xlsx ou csv' })
  formato?: 'xlsx' | 'csv';
}

export class FiltroRiscoDto {
  @ApiPropertyOptional({ enum: ['BAIXO', 'MEDIO', 'ALTO'], default: 'MEDIO' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(['BAIXO', 'MEDIO', 'ALTO'], { message: 'nível inválido' })
  nivelMinimo?: 'BAIXO' | 'MEDIO' | 'ALTO';

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(200, { message: 'deve ser no máximo 200' })
  limite?: number;
}

export class PreviaDaEtapaDto {
  @ApiProperty({
    description: 'Texto com variáveis {{titulo.*}} e {{contato.*}}.',
  })
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(8000, { message: 'deve ter no máximo 8000 caracteres' })
  texto: string;
}
