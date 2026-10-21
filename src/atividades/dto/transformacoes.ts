/**
 * Transformações e validações dos DTOs de atividades (corpo e query string).
 */
import type { TransformFnParams } from 'class-transformer';
import { isISO8601, ValidateBy, type ValidationOptions } from 'class-validator';

/** Data e hora ISO 8601 **com fuso** (`Z` ou `±hh:mm`): sem fuso, a hora seria ambígua. */
const DATA_HORA_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const MENSAGEM_DATA_HORA =
  'deve ser uma data e hora ISO 8601 com fuso (ex.: 2026-10-20T14:00:00-03:00)';

export function ehDataHoraComFuso(valor: unknown): valor is string {
  return (
    typeof valor === 'string' &&
    DATA_HORA_COM_FUSO.test(valor) &&
    isISO8601(valor, { strict: true }) &&
    !Number.isNaN(Date.parse(valor))
  );
}

/** Valida uma data e hora ISO 8601 com fuso (o campo continua texto no DTO). */
export function IsDataHoraComFuso(
  opcoes?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehDataHoraComFuso',
      validator: {
        validate: (valor: unknown) => ehDataHoraComFuso(valor),
        defaultMessage: () => MENSAGEM_DATA_HORA,
      },
    },
    { message: MENSAGEM_DATA_HORA, ...opcoes },
  );
}

/** Converte o texto validado em `Date`, mantendo `undefined` (não informado) e `null` (limpar). */
export function lerDataHora(
  valor: string | null | undefined,
): Date | null | undefined {
  if (valor === undefined || valor === null) {
    return valor;
  }
  return new Date(valor);
}

/** Apara textos; o resto passa como veio (o validador reclama). */
export function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** Apara e troca texto vazio por `null` (campos opcionais que podem ser limpos). */
export function apararOuNulo({ value }: TransformFnParams): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const aparado = value.trim();
  return aparado === '' ? null : aparado;
}

/** Ids em minúsculas, para comparar com os do banco. */
export function minusculas({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * Lista na query string: aceita o parâmetro repetido (`?tipo=A&tipo=B`) ou
 * separado por vírgula (`?tipo=A,B`). Vazio = não informado.
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

/** `deve ser um destes valores: A, B, C` — a mensagem dos enums. */
export function mensagemDeValores(valores: readonly string[]): string {
  return `deve ser um destes valores: ${valores.join(', ')}`;
}
