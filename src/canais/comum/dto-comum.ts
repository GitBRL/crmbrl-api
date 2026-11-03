/**
 * Apoio dos DTOs dos canais extras (chat do site, e-mail, Meta): mensagens de
 * validação em português, transformações e os campos comuns da configuração
 * de qualquer canal (nome, fila padrão, horário, satisfação).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import type {
  Canal,
  FilaAtendimento,
  TipoCanal,
} from '../../generated/prisma/client';

export const MENSAGEM_TEXTO = { message: 'deve ser um texto' };
export const MENSAGEM_UUID = {
  message: 'deve ser um identificador (UUID) válido',
};
export const MENSAGEM_BOOLEANO = { message: 'deve ser verdadeiro ou falso' };
export const MENSAGEM_OBRIGATORIO = { message: 'é obrigatório' };
export const MENSAGEM_OBJETO = { message: 'deve ser um objeto' };

export const maximo = (limite: number) => ({
  message: `deve ter no máximo ${limite} caracteres`,
});

/** Tamanho máximo do nome de um canal. */
export const TAMANHO_MAXIMO_NOME_CANAL = 120;
/** Tamanho máximo dos textos automáticos (fora do horário, satisfação). */
export const TAMANHO_MAXIMO_TEXTO_AUTOMATICO = 1000;

/**
 * Campo opcional que, quando vem, não pode ser `null` (o `@IsOptional` do
 * class-validator deixaria `null` passar sem validar).
 */
export function OpcionalNaoNulo(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateIf(
    (_objeto: object, valor: unknown) => valor !== undefined,
    opcoes,
  );
}

/** Só os campos definidos de um DTO, num objeto simples (para juntar com o valor atual). */
export function definidos<T extends object>(objeto: T | undefined): Partial<T> {
  return objeto
    ? (Object.fromEntries(
        Object.entries(objeto).filter(([, valor]) => valor !== undefined),
      ) as Partial<T>)
    : {};
}

/** Apara textos; o resto passa como veio (o validador reclama). */
export function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Apara e troca texto vazio por `null` (campo opcional que pode ser apagado). */
export function apararOuNulo({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const texto = value.trim();
  return texto === '' ? null : texto;
}

/** `'true'`/`'false'` (formulário, query) → booleano; o resto passa, para a validação acusar. */
export function lerBooleano({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true || value === 'on' || value === '1') {
    return true;
  }
  if (value === 'false' || value === false || value === '0') {
    return false;
  }
  return value;
}

/**
 * Campos que todo canal tem, iguais na criação de qualquer tipo. Na edição,
 * todos são opcionais (`PartialType`).
 */
export class CamposComunsDoCanalDto {
  @ApiProperty({ example: 'Site institucional', maxLength: 120 })
  @Transform(aparar)
  @IsString(MENSAGEM_TEXTO)
  @IsNotEmpty(MENSAGEM_OBRIGATORIO)
  @MaxLength(TAMANHO_MAXIMO_NOME_CANAL, maximo(TAMANHO_MAXIMO_NOME_CANAL))
  nome: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Desligado, o canal não recebe nem envia.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  ativo?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Fila das conversas novas do canal (R12). `null` = sem fila.',
  })
  @IsOptional()
  @IsUUID('all', MENSAGEM_UUID)
  filaPadraoId?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: {
      fusoHorario: 'America/Sao_Paulo',
      dias: { '1': [{ inicio: '08:00', fim: '18:00' }] },
    },
    description:
      'Horário de atendimento (R12): fuso e intervalos por dia (0 = domingo … 6 = sábado). `null` = 24 horas.',
  })
  @IsOptional()
  @IsObject(MENSAGEM_OBJETO)
  horarioAtendimento?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TAMANHO_MAXIMO_TEXTO_AUTOMATICO,
    description:
      'Resposta automática fora do horário (uma vez por conversa por período). `null` = não responde.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(
    TAMANHO_MAXIMO_TEXTO_AUTOMATICO,
    maximo(TAMANHO_MAXIMO_TEXTO_AUTOMATICO),
  )
  mensagemForaHorario?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Pede a nota de satisfação (1 a 5) ao resolver a conversa.',
  })
  @OpcionalNaoNulo()
  @IsBoolean(MENSAGEM_BOOLEANO)
  pesquisaSatisfacao?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TAMANHO_MAXIMO_TEXTO_AUTOMATICO,
    description: 'Texto da pergunta de satisfação. `null` = texto padrão.',
  })
  @Transform(apararOuNulo)
  @IsOptional()
  @IsString(MENSAGEM_TEXTO)
  @MaxLength(
    TAMANHO_MAXIMO_TEXTO_AUTOMATICO,
    maximo(TAMANHO_MAXIMO_TEXTO_AUTOMATICO),
  )
  mensagemSatisfacao?: string | null;
}

export class FilaDoCanalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Comercial — site' })
  nome: string;
}

/** O que todo canal mostra na tela de configuração. */
export class CanalBaseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: ['WEBCHAT', 'EMAIL', 'INSTAGRAM', 'MESSENGER', 'WHATSAPP_OFICIAL'],
  })
  tipo: TipoCanal;

  @ApiProperty({ example: 'Site institucional' })
  nome: string;

  @ApiProperty()
  ativo: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Identificador do canal no provedor: chave pública do widget, endereço da caixa, id da página ou da conta do Instagram.',
  })
  idExterno: string | null;

  @ApiProperty({ type: FilaDoCanalDto, nullable: true })
  filaPadrao: FilaDoCanalDto | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Horário de atendimento; `null` = 24 horas.',
  })
  horarioAtendimento: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true })
  mensagemForaHorario: string | null;

  @ApiProperty()
  pesquisaSatisfacao: boolean;

  @ApiProperty({ type: String, nullable: true })
  mensagemSatisfacao: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Último erro técnico do canal (conexão, credenciais), em português.',
  })
  ultimoErro: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ultimoErroEm: string | null;

  @ApiProperty({ format: 'date-time' })
  criadoEm: string;

  @ApiProperty({ format: 'date-time' })
  atualizadoEm: string;
}

/** Os campos de `CanalBaseDto` (objeto simples, para compor os DTOs de cada tipo). */
export type CamposBaseDoCanal = {
  [Campo in keyof CanalBaseDto]: CanalBaseDto[Campo];
};

/** Os campos de `CanalBaseDto` a partir do registro. */
export function camposBaseDoCanal(
  canal: Canal & { filaPadrao?: Pick<FilaAtendimento, 'id' | 'nome'> | null },
): CamposBaseDoCanal {
  return {
    id: canal.id,
    tipo: canal.tipo,
    nome: canal.nome,
    ativo: canal.ativo,
    idExterno: canal.idExterno,
    filaPadrao: canal.filaPadrao
      ? { id: canal.filaPadrao.id, nome: canal.filaPadrao.nome }
      : null,
    horarioAtendimento:
      (canal.horarioAtendimento as Record<string, unknown> | null) ?? null,
    mensagemForaHorario: canal.mensagemForaHorario,
    pesquisaSatisfacao: canal.pesquisaSatisfacao,
    mensagemSatisfacao: canal.mensagemSatisfacao,
    ultimoErro: canal.ultimoErro,
    ultimoErroEm: canal.ultimoErroEm?.toISOString() ?? null,
    criadoEm: canal.criadoEm.toISOString(),
    atualizadoEm: canal.atualizadoEm.toISOString(),
  };
}
