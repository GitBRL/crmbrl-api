import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  isISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { CursorDto } from '../../comum/paginacao/paginacao';

/**
 * Data ISO 8601: só a data (meia-noite em UTC) ou data e hora **com fuso**
 * (`Z` ou `±hh:mm`), para não depender do fuso do servidor.
 */
const DATA_ISO_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const MENSAGEM_DATA =
  'deve ser uma data ISO 8601 com fuso (ex.: 2026-10-20T03:00:00Z)';

/** Data ISO 8601 válida (calendário de verdade), só a data ou com fuso. */
export function ehDataComFuso(valor: unknown): boolean {
  return (
    typeof valor === 'string' &&
    DATA_ISO_COM_FUSO.test(valor) &&
    isISO8601(valor, { strict: true }) &&
    !Number.isNaN(Date.parse(valor))
  );
}

/** Valida `ehDataComFuso`, com uma única mensagem em português. */
export function EhDataComFuso(): PropertyDecorator {
  return ValidateBy({
    name: 'ehDataComFuso',
    validator: {
      validate: (valor: unknown) => ehDataComFuso(valor),
      defaultMessage: () => MENSAGEM_DATA,
    },
  });
}

/**
 * Converte o valor da query numa lista: aceita o parâmetro repetido
 * (`?acao=a&acao=b`) e itens separados por vírgula (`?acao=a,b`). Itens vazios
 * são descartados.
 */
export function paraLista({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  const valores: unknown[] = Array.isArray(value) ? value : [value];
  return valores
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
}

/** `true`/`false` (ou `1`/`0`) da query string viram booleanos. */
export function paraBooleano({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === '1' || value === true) {
    return true;
  }
  if (value === 'false' || value === '0' || value === false) {
    return false;
  }
  return value;
}

/** Texto da query aparado (vazio = não informado). */
export function aparar({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const aparado = value.trim();
  return aparado === '' ? undefined : aparado;
}

/**
 * Data da query, aparada. O `+` de um fuso enviado sem codificar (`%2B`) chega
 * como espaço (`…T03:00:00 03:00`): ele volta para o lugar.
 */
export function paraData({ value }: { value: unknown }): unknown {
  const aparado = aparar({ value });
  return typeof aparado === 'string'
    ? aparado.replace(/ (\d{2}:\d{2})$/, '+$1')
    : aparado;
}

/**
 * Filtros comuns às consultas por cursor (auditoria e logs técnicos): período,
 * usuário, id da requisição e texto, mais `cursor` e `limite`.
 */
export class FiltroDeConsultaDto extends CursorDto {
  @ApiPropertyOptional({
    description:
      'Início do período (inclusive). ISO 8601 com fuso; só a data vale meia-noite em UTC.',
    example: '2026-10-20T03:00:00.000Z',
  })
  @IsOptional()
  @Transform(paraData)
  @EhDataComFuso()
  de?: string;

  @ApiPropertyOptional({
    description:
      'Fim do período (exclusivo). Para um dia inteiro em São Paulo: `de=2026-10-20T03:00:00Z&ate=2026-10-21T03:00:00Z`.',
    example: '2026-10-21T03:00:00.000Z',
  })
  @IsOptional()
  @Transform(paraData)
  @EhDataComFuso()
  ate?: string;

  @ApiPropertyOptional({
    description: 'Só o que este usuário fez (ou, nos logs, a requisição dele).',
    format: 'uuid',
  })
  @IsOptional()
  @Transform(aparar)
  @IsUUID('all', { message: 'deve ser um identificador (UUID) válido' })
  usuarioId?: string;

  @ApiPropertyOptional({
    description:
      'Id da requisição (`X-Request-Id`): correlaciona auditoria e logs técnicos.',
    example: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(128, { message: 'deve ter no máximo 128 caracteres' })
  requisicaoId?: string;

  @ApiPropertyOptional({
    description:
      'Busca por texto, sem diferenciar maiúsculas nem acentos. Com várias palavras, todas precisam aparecer (até 5).',
    example: 'negocio proposta',
  })
  @IsOptional()
  @Transform(aparar)
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  texto?: string;
}
