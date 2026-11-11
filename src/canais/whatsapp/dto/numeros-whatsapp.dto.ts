import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import { StatusWhatsapp } from '../../../generated/prisma/client';
import { FAIXAS_DAS_PROTECOES } from '../protecoes';
import type { Area } from '../../../comum/dominio/setores';

/** Tamanho máximo do nome do número (e do canal). */
export const TAMANHO_MAXIMO_NOME_NUMERO = 80;
/** Tamanho máximo do motivo de uma pausa manual. */
export const TAMANHO_MAXIMO_MOTIVO_PAUSA = 300;

const MENSAGEM_TEXTO = { message: 'deve ser um texto' };
const MENSAGEM_BOOLEANO = { message: 'deve ser verdadeiro ou falso' };
const MENSAGEM_INTEIRO = { message: 'deve ser um número inteiro' };
const minimo = (valor: number) => ({ message: `deve ser no mínimo ${valor}` });
const maximoValor = (valor: number) => ({
  message: `deve ser no máximo ${valor}`,
});
const maximo = (limite: number) => ({
  message: `deve ter no máximo ${limite} caracteres`,
});

function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Opcional que, quando vem, não pode ser `null`. */
function OpcionalNaoNulo(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateIf(
    (_objeto: object, valor: unknown) => valor !== undefined,
    opcoes,
  );
}

/** Proteções anti-banimento do número (R13); o que não vier fica como está (ou no padrão). */
export class ProtecoesDoNumeroDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'Mostra "digitando…" (ou "gravando…") ao contato antes de cada envio.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  digitando?: boolean;

  @ApiPropertyOptional({
    default: 4,
    minimum: FAIXAS_DAS_PROTECOES.digitandoMaximoSegundos.minimo,
    maximum: FAIXAS_DAS_PROTECOES.digitandoMaximoSegundos.maximo,
    description:
      'Teto do "digitando…", em segundos (a duração acompanha o tamanho do texto).',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.digitandoMaximoSegundos.minimo, minimo(0))
  @Max(
    FAIXAS_DAS_PROTECOES.digitandoMaximoSegundos.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.digitandoMaximoSegundos.maximo),
  )
  digitandoMaximoSegundos?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Confere se o telefone tem WhatsApp antes de uma mensagem ativa (cache de 7 dias).',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  verificarNumero?: boolean;

  @ApiPropertyOptional({
    default: 5,
    minimum: FAIXAS_DAS_PROTECOES.pausarAposFalhasSeguidas.minimo,
    maximum: FAIXAS_DAS_PROTECOES.pausarAposFalhasSeguidas.maximo,
    description:
      'Mensagens seguidas que não saem e pausam o número sozinho (0 = nunca pausa).',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.pausarAposFalhasSeguidas.minimo, minimo(0))
  @Max(
    FAIXAS_DAS_PROTECOES.pausarAposFalhasSeguidas.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.pausarAposFalhasSeguidas.maximo),
  )
  pausarAposFalhasSeguidas?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'O limite diário vale também para as respostas às conversas abertas pelo contato (padrão: só para as mensagens ativas).',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  limitarRespostas?: boolean;
}

/** Campos comuns de criar e editar. */
class CamposDoNumeroDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Fila das conversas novas deste número (R12). `null` = sem fila (ficam sem responsável).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  filaPadraoId?: string | null;

  @ApiPropertyOptional({
    default: 1000,
    minimum: FAIXAS_DAS_PROTECOES.limiteDiario.minimo,
    maximum: FAIXAS_DAS_PROTECOES.limiteDiario.maximo,
    description:
      'Envios por dia (fuso de São Paulo) depois do aquecimento. Vale para as mensagens ativas.',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.limiteDiario.minimo, minimo(1))
  @Max(
    FAIXAS_DAS_PROTECOES.limiteDiario.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.limiteDiario.maximo),
  )
  limiteDiario?: number;

  @ApiPropertyOptional({
    default: 2,
    minimum: FAIXAS_DAS_PROTECOES.intervaloSegundos.minimo,
    maximum: FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo,
    description: 'Espera mínima entre dois envios do número, em segundos.',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.intervaloSegundos.minimo, minimo(0))
  @Max(
    FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo),
  )
  intervaloMinimoSegundos?: number;

  @ApiPropertyOptional({
    default: 6,
    minimum: FAIXAS_DAS_PROTECOES.intervaloSegundos.minimo,
    maximum: FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo,
    description:
      'Espera máxima entre dois envios, em segundos (a espera é sorteada entre o mínimo e o máximo).',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.intervaloSegundos.minimo, minimo(0))
  @Max(
    FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.intervaloSegundos.maximo),
  )
  intervaloMaximoSegundos?: number;

  @ApiPropertyOptional({
    default: 14,
    minimum: FAIXAS_DAS_PROTECOES.aquecimentoDias.minimo,
    maximum: FAIXAS_DAS_PROTECOES.aquecimentoDias.maximo,
    description:
      'Dias de aquecimento de número novo (o limite do dia cresce aos poucos a partir da primeira conexão). 0 = sem aquecimento.',
  })
  @OpcionalNaoNulo()
  @IsInt(MENSAGEM_INTEIRO)
  @Min(FAIXAS_DAS_PROTECOES.aquecimentoDias.minimo, minimo(0))
  @Max(
    FAIXAS_DAS_PROTECOES.aquecimentoDias.maximo,
    maximoValor(FAIXAS_DAS_PROTECOES.aquecimentoDias.maximo),
  )
  aquecimentoDias?: number;

  @ApiPropertyOptional({ type: ProtecoesDoNumeroDto })
  @OpcionalNaoNulo()
  @ValidateNested()
  @Type(() => ProtecoesDoNumeroDto)
  protecoes?: ProtecoesDoNumeroDto;
}

export class CriarNumeroWhatsappDto extends CamposDoNumeroDto {
  @ApiProperty({
    example: 'Comercial — principal',
    maxLength: TAMANHO_MAXIMO_NOME_NUMERO,
    description:
      'Nome do canal na tela (o telefone aparece depois da leitura do QR).',
  })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_NUMERO, maximo(TAMANHO_MAXIMO_NOME_NUMERO))
  nome: string;
}

export class AtualizarNumeroWhatsappDto extends CamposDoNumeroDto {
  @ApiPropertyOptional({ maxLength: TAMANHO_MAXIMO_NOME_NUMERO })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(TAMANHO_MAXIMO_NOME_NUMERO, maximo(TAMANHO_MAXIMO_NOME_NUMERO))
  nome?: string;

  @ApiPropertyOptional({
    description:
      'Canal inativo não recebe conversas novas no Atendimento (o número continua conectado).',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;
}

export class DesconectarNumeroWhatsappDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Desvincular: faz logout no WhatsApp (o celular remove o aparelho) e apaga as chaves; para voltar, é preciso ler o QR de novo.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  sair?: boolean;
}

export class VerificarTelefoneWhatsappDto {
  @ApiProperty({ example: '(11) 98888-7777' })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty({ message: 'é obrigatório' })
  @MaxLength(30, maximo(30))
  telefone: string;
}

export class PausarNumeroWhatsappDto {
  @ApiPropertyOptional({
    maxLength: TAMANHO_MAXIMO_MOTIVO_PAUSA,
    example: 'Troca de chip',
  })
  @OpcionalNaoNulo()
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(TAMANHO_MAXIMO_MOTIVO_PAUSA, maximo(TAMANHO_MAXIMO_MOTIVO_PAUSA))
  motivo?: string;
}

export class FiltroEnviosDoNumeroDto {
  @ApiPropertyOptional({ default: 14, minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt(MENSAGEM_INTEIRO)
  @Min(1, minimo(1))
  @Max(90, maximoValor(90))
  dias?: number;
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

export class FilaDoNumeroWhatsappDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Comercial' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  area: Area;
}

export class AquecimentoDoNumeroDto {
  @ApiProperty({
    description: 'Ainda no aquecimento (o limite do dia é menor que o cheio).',
  })
  ativo: boolean;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 3,
    description:
      'Dia do aquecimento (1 = o da primeira conexão), quando ativo.',
  })
  dia: number | null;

  @ApiProperty({ example: 14 })
  dias: number;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Primeira conexão (início do aquecimento).',
  })
  inicioEm: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-11-06',
    description: 'Primeiro dia (São Paulo) com o limite cheio.',
  })
  terminaEm: string | null;
}

export class EnviosDoNumeroNoDiaDto {
  @ApiProperty({
    example: '2026-10-23',
    description: 'Dia no fuso de São Paulo.',
  })
  dia: string;

  @ApiProperty({ example: 42 })
  enviados: number;

  @ApiProperty({ example: 1 })
  falhas: number;

  @ApiProperty({
    example: 500,
    description: 'Limite daquele dia (com o aquecimento).',
  })
  limite: number;
}

export class ProtecoesAtuaisDoNumeroDto {
  @ApiProperty()
  digitando: boolean;

  @ApiProperty()
  digitandoMaximoSegundos: number;

  @ApiProperty()
  verificarNumero: boolean;

  @ApiProperty()
  pausarAposFalhasSeguidas: number;

  @ApiProperty()
  limitarRespostas: boolean;
}

export class PausaDoNumeroDto {
  @ApiProperty({ format: 'date-time' })
  pausadoEm: string;

  @ApiProperty({ nullable: true, type: String })
  motivo: string | null;

  @ApiProperty({
    description:
      'Pausa do gateway (falhas seguidas, limite do WhatsApp, erro grave): sai ao retomar ou ao reconectar pelo CRM.',
  })
  automatica: boolean;
}

export class NumeroWhatsappDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'O canal do Atendimento deste número.',
  })
  canalId: string;

  @ApiProperty({ example: 'Comercial — principal' })
  nome: string;

  @ApiProperty({ description: 'Canal ativo no Atendimento.' })
  ativo: boolean;

  @ApiProperty({ type: FilaDoNumeroWhatsappDto, nullable: true })
  filaPadrao: FilaDoNumeroWhatsappDto | null;

  @ApiProperty({ enum: StatusWhatsapp, enumName: 'StatusWhatsapp' })
  status: StatusWhatsapp;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Por que está nesse status, em português.',
  })
  motivo: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '5511988887777',
    description:
      'Telefone conectado (E.164 só com dígitos), depois da leitura do QR.',
  })
  telefone: string | null;

  @ApiProperty({ example: 1000 })
  limiteDiario: number;

  @ApiProperty({ example: 2 })
  intervaloMinimoSegundos: number;

  @ApiProperty({ example: 6 })
  intervaloMaximoSegundos: number;

  @ApiProperty({ type: AquecimentoDoNumeroDto })
  aquecimento: AquecimentoDoNumeroDto;

  @ApiProperty({ type: EnviosDoNumeroNoDiaDto, description: 'Envios de hoje.' })
  hoje: EnviosDoNumeroNoDiaDto;

  @ApiProperty({ type: ProtecoesAtuaisDoNumeroDto })
  protecoes: ProtecoesAtuaisDoNumeroDto;

  @ApiProperty({ type: PausaDoNumeroDto, nullable: true })
  pausa: PausaDoNumeroDto | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  conectadoEm: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  desconectadoEm: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  ultimoEventoEm: string | null;

  @ApiProperty({ example: 0 })
  tentativasReconexao: number;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

/** Estado ao vivo no gateway (com o QR enquanto espera a leitura). */
export class EstadoDoNumeroWhatsappDto {
  @ApiProperty({ format: 'uuid' })
  numeroId: string;

  @ApiProperty({ format: 'uuid' })
  canalId: string;

  @ApiProperty({ enum: StatusWhatsapp, enumName: 'StatusWhatsapp' })
  status: StatusWhatsapp;

  @ApiProperty({ nullable: true, type: String })
  telefone: string | null;

  @ApiProperty({ nullable: true, type: String })
  motivo: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'data:image/png;base64,iVBORw0KGgo…',
    description:
      'QR atual (data URL) enquanto `AGUARDANDO_QR`. Os seguintes chegam pelo evento `whatsapp.conexao`.',
  })
  qr: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  qrExpiraEm: string | null;
}

export class VerificacaoDeTelefoneDto {
  @ApiProperty({ example: '5511988887777' })
  telefone: string;

  @ApiProperty()
  existe: boolean;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '5511988887777@s.whatsapp.net',
    description:
      'Endereço que o WhatsApp devolveu (pode diferir do telefone, como no nono dígito).',
  })
  jid: string | null;

  @ApiProperty({ description: 'A resposta veio do cache (7 dias).' })
  doCache: boolean;
}
