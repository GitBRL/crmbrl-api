/**
 * Peças comuns dos DTOs do Atendimento: transformações da entrada e resumos
 * de usuário, fila e canal usados em várias respostas.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { TransformFnParams } from 'class-transformer';
import { ValidateIf, type ValidationOptions } from 'class-validator';
import { Area, TipoCanal } from '../../generated/prisma/client';

export const MENSAGEM_UUID = 'deve ser um identificador (UUID) válido';

/** Apara textos vindos do cliente (o resto passa como veio, para a validação acusar). */
export function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Texto aparado; vazio vira `null` (limpar o campo). */
export function apararOuNulo({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const aparado = value.trim();
  return aparado === '' ? null : aparado;
}

/**
 * Lista na query string: o parâmetro repetido (`?status=A&status=B`) ou
 * separado por vírgula (`?status=A,B`). Vazio = não informado.
 */
export function paraLista({ value }: TransformFnParams): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  const brutos: unknown[] = Array.isArray(value) ? value : [value];
  if (!brutos.every((item) => typeof item === 'string')) {
    return value;
  }
  const itens = (brutos as string[])
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return itens.length > 0 ? itens : undefined;
}

/** Lista de enums em maiúsculas (`?status=aberta,pendente`). */
export function paraListaEmMaiusculas(parametros: TransformFnParams): unknown {
  const lista = paraLista(parametros);
  return Array.isArray(lista)
    ? lista.map((item: unknown) =>
        typeof item === 'string' ? item.toUpperCase() : item,
      )
    : lista;
}

/** Enum em maiúsculas (`?escopo=minhas`). */
export function emMaiusculas({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** Booleano na query string: `true`/`false` (ou `1`/`0`). */
export function paraBooleano({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === '1' || value === true) {
    return true;
  }
  if (value === 'false' || value === '0' || value === false) {
    return false;
  }
  return value;
}

/**
 * Campo opcional que, quando vem, não pode ser `null` (o `@IsOptional` do
 * class-validator deixaria passar `null` sem validar).
 */
export function OpcionalNaoNulo(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateIf(
    (_objeto: object, valor: unknown) => valor !== undefined,
    opcoes,
  );
}

/**
 * Os campos de um DTO como objeto simples (o que os `de(...)` devolvem): pode
 * ser espalhado (`{ ...dto }`) sem perder nada.
 */
export type Campos<T> = { [Campo in keyof T]: T[Campo] };

/** Data em ISO 8601 (nula continua nula). */
export const iso = (data: Date | null | undefined): string | null =>
  data ? data.toISOString() : null;

/** Pessoa da equipe numa resposta. */
export class PessoaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  avatarUrl: string | null;

  static de(usuario: {
    id: string;
    nome: string;
    avatarUrl?: string | null;
  }): Campos<PessoaDto> {
    return {
      id: usuario.id,
      nome: usuario.nome,
      avatarUrl: usuario.avatarUrl ?? null,
    };
  }

  static ouNulo(
    usuario: { id: string; nome: string; avatarUrl?: string | null } | null,
  ): Campos<PessoaDto> | null {
    return usuario ? PessoaDto.de(usuario) : null;
  }
}

/** Fila numa resposta. */
export class ResumoFilaDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Comercial — WhatsApp' })
  nome: string;

  @ApiProperty({ enum: Area, enumName: 'Area' })
  area: Area;

  static ouNulo(
    fila: { id: string; nome: string; area: Area } | null,
  ): Campos<ResumoFilaDto> | null {
    return fila ? { id: fila.id, nome: fila.nome, area: fila.area } : null;
  }
}

/** Canal numa resposta. */
export class ResumoCanalDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: TipoCanal, enumName: 'TipoCanal' })
  tipo: TipoCanal;

  @ApiProperty({ example: 'WhatsApp Vendas' })
  nome: string;

  @ApiProperty({ description: 'Canal ligado (recebe e envia).' })
  ativo: boolean;

  static de(canal: {
    id: string;
    tipo: TipoCanal;
    nome: string;
    ativo: boolean;
  }): Campos<ResumoCanalDto> {
    return {
      id: canal.id,
      tipo: canal.tipo,
      nome: canal.nome,
      ativo: canal.ativo,
    };
  }
}
