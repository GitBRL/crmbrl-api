import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginacaoDto } from '../../comum/paginacao/paginacao';
import {
  MAXIMO_DE_MEMBROS_DO_GRUPO,
  TAMANHO_MAXIMO_DA_DESCRICAO,
  TAMANHO_MAXIMO_DO_NOME,
  TAMANHO_MAXIMO_DO_TEXTO,
} from '../regras-chat';

const TEXTO = { message: 'deve ser um texto' } as const;
const UUID = { message: 'deve ser um identificador (UUID) válido' } as const;
const UUIDS = {
  each: true,
  message: 'deve ter só identificadores (UUID) válidos',
} as const;
const OBRIGATORIO = { message: 'é obrigatório' } as const;
const BOOLEANO = { message: 'deve ser verdadeiro ou falso' } as const;

function maximo(tamanho: number) {
  return { message: `deve ter no máximo ${tamanho} caracteres` } as const;
}

/** Apara textos (o resto do tipo segue para a validação). */
function aparar({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Ids em minúsculas e sem repetidos. */
function idsUnicos({ value }: { value: unknown }): unknown {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.map((item: unknown) =>
            typeof item === 'string' ? item.trim().toLowerCase() : item,
          ),
        ),
      ]
    : value;
}

/** `?x=true|false` da query string. */
function booleanoDaQuery({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true || value === '1') {
    return true;
  }
  if (value === 'false' || value === false || value === '0') {
    return false;
  }
  return value;
}

export class CriarGrupoChatDto {
  @ApiProperty({ example: 'Lançamento de outubro', maxLength: 80 })
  @Transform(aparar)
  @IsString(TEXTO)
  @Matches(/\S/, OBRIGATORIO)
  @MaxLength(TAMANHO_MAXIMO_DO_NOME, maximo(TAMANHO_MAXIMO_DO_NOME))
  nome: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TAMANHO_MAXIMO_DA_DESCRICAO,
    example: 'Combinados da campanha com Comercial e Marketing.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(TEXTO)
  @MaxLength(TAMANHO_MAXIMO_DA_DESCRICAO, maximo(TAMANHO_MAXIMO_DA_DESCRICAO))
  descricao?: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Quem entra no grupo além de quem cria (usuários ativos). Quem cria entra sozinho, como administrador.',
    example: ['6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10'],
  })
  @Transform(idsUnicos)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMaxSize(MAXIMO_DE_MEMBROS_DO_GRUPO - 1, {
    message: `deve ter no máximo ${MAXIMO_DE_MEMBROS_DO_GRUPO - 1} pessoas`,
  })
  @IsUUID('all', UUIDS)
  membrosIds: string[];
}

export class AtualizarCanalChatDto {
  @ApiPropertyOptional({ example: 'Lançamento de novembro', maxLength: 80 })
  @IsOptional()
  @Transform(aparar)
  @IsString(TEXTO)
  @Matches(/\S/, OBRIGATORIO)
  @MaxLength(TAMANHO_MAXIMO_DO_NOME, maximo(TAMANHO_MAXIMO_DO_NOME))
  nome?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TAMANHO_MAXIMO_DA_DESCRICAO,
    description: '`null` ou texto vazio apaga a descrição.',
  })
  @IsOptional()
  @Transform(aparar)
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsString(TEXTO)
  @MaxLength(TAMANHO_MAXIMO_DA_DESCRICAO, maximo(TAMANHO_MAXIMO_DA_DESCRICAO))
  descricao?: string | null;
}

export class AdicionarMembrosChatDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Usuários ativos que entram no grupo.',
  })
  @Transform(idsUnicos)
  @IsArray({ message: 'deve ser uma lista' })
  @ArrayMinSize(1, { message: 'deve ter pelo menos uma pessoa' })
  @ArrayMaxSize(MAXIMO_DE_MEMBROS_DO_GRUPO, {
    message: `deve ter no máximo ${MAXIMO_DE_MEMBROS_DO_GRUPO} pessoas`,
  })
  @IsUUID('all', UUIDS)
  usuariosIds: string[];
}

export class AtualizarMembroChatDto {
  @ApiProperty({
    description: 'Administra o grupo (renomeia, adiciona e tira pessoas).',
  })
  @IsBoolean(BOOLEANO)
  administrador: boolean;
}

export class IniciarDiretaChatDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Com quem conversar (um usuário ativo, que não seja você).',
  })
  @Transform(aparar)
  @IsUUID('all', UUID)
  usuarioId: string;
}

export class PreferenciasDoCanalChatDto {
  @ApiProperty({
    description:
      'Silenciado: as mensagens do canal não contam no menu (as menções a você continuam contando e notificando).',
  })
  @IsBoolean(BOOLEANO)
  silenciado: boolean;
}

export class MarcarLeituraChatDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Leu até esta mensagem (inclusive). Sem ela, até a última mensagem do canal.',
  })
  @IsOptional()
  @Transform(aparar)
  @IsUUID('all', UUID)
  mensagemId?: string;
}

export class FiltroCanaisChatDto {
  @ApiPropertyOptional({
    description: 'Inclui os grupos arquivados (só leitura).',
    default: true,
  })
  @IsOptional()
  @Transform(booleanoDaQuery)
  @IsBoolean(BOOLEANO)
  arquivados: boolean = true;
}

export class EnviarMensagemChatDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: TAMANHO_MAXIMO_DO_TEXTO,
    description:
      'Texto (até 4.000 caracteres). Menções: `<@usuarioId>` (só membros do canal; notificam). Referências: `<negocio:id>`, `<contato:id>`, `<empresa:id>` (itens que você vê; viram links). Obrigatório sem `arquivoId`.',
    example:
      'Bom dia <@6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10>, viu o <negocio:0b7e7f43-6c43-4c9e-b2f4-2f1f0d1e5a10>?',
  })
  @IsOptional()
  @IsString(TEXTO)
  @MaxLength(TAMANHO_MAXIMO_DO_TEXTO, maximo(TAMANHO_MAXIMO_DO_TEXTO))
  texto?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Anexo já enviado por você em `POST /api/v1/arquivos?contexto=CHAT` (um por mensagem).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsUUID('all', UUID)
  arquivoId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Responde a esta mensagem (do mesmo canal, não excluída).',
  })
  @IsOptional()
  @Transform(aparar)
  @IsUUID('all', UUID)
  respostaAId?: string;
}

export class EditarMensagemChatDto {
  @ApiProperty({
    maxLength: TAMANHO_MAXIMO_DO_TEXTO,
    description:
      'Texto novo, com as mesmas marcações do envio. Vazio só se a mensagem tiver anexo.',
  })
  @IsString(TEXTO)
  @MaxLength(TAMANHO_MAXIMO_DO_TEXTO, maximo(TAMANHO_MAXIMO_DO_TEXTO))
  texto: string;
}

export class FiltroMensagensChatDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Mensagens mais antigas que esta (rolar para cima).',
  })
  @IsOptional()
  @IsUUID('all', UUID)
  antesDe?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Mensagens mais novas que esta (depois de reconectar).',
  })
  @IsOptional()
  @IsUUID('all', UUID)
  depoisDe?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Uma janela com esta mensagem no meio (abrir uma menção ou um resultado da busca).',
  })
  @IsOptional()
  @IsUUID('all', UUID)
  aoRedorDe?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(100, { message: 'deve ser no máximo 100' })
  limite: number = 50;
}

export class BuscaMensagensChatDto extends PaginacaoDto {
  @ApiProperty({
    description:
      'Termos (sem diferenciar acentos nem maiúsculas); cada um precisa aparecer na mensagem.',
    minLength: 2,
    maxLength: 100,
    example: 'proposta acme',
  })
  @Transform(aparar)
  @IsString(TEXTO)
  @MinLength(2, { message: 'deve ter pelo menos 2 caracteres' })
  @MaxLength(100, maximo(100))
  texto: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Só neste canal.',
  })
  @IsOptional()
  @IsUUID('all', UUID)
  canalId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Só desta pessoa.' })
  @IsOptional()
  @IsUUID('all', UUID)
  autorId?: string;
}

export class FiltroPessoasChatDto extends PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Nome ou e-mail (sem diferenciar acentos nem maiúsculas).',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(aparar)
  @IsString(TEXTO)
  @MaxLength(100, maximo(100))
  busca?: string;
}
