/** Transformações de entrada dos DTOs de usuários (`@Transform`). */
import type { TransformFnParams } from 'class-transformer';
import { normalizarEmail } from '../../comum/dominio/email';

/** Apara textos; o resto passa como veio (a validação recusa). */
export function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** E-mail aparado e em minúsculas (R1.1), antes do `@IsEmail`. */
export function emailNormalizado({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? normalizarEmail(value) : value;
}

/** Ids (UUID) em minúsculas, para comparar com os do banco. */
export function idEmMinusculas({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** `'true'`/`'false'` da query string → booleano. */
export function booleanoDaQuery({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}
