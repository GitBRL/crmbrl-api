/**
 * Validadores dos DTOs de contatos e empresas, com as mesmas regras de
 * normalização dos serviços (R4.1, R4.4) — o erro sai como 400 com
 * `detalhes.campos`, antes de chegar ao serviço.
 */
import { Transform } from 'class-transformer';
import {
  type ValidationArguments,
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import { ehCnpjValido } from '../../comum/dominio/cnpj';
import { ehEmailValido } from '../../comum/dominio/email';
import { normalizarTelefone } from '../../comum/dominio/telefone';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import {
  ehObjetoSimples,
  mensagemDeTelefoneInvalido,
  normalizarCamposPersonalizados,
} from '../deduplicacao';

/** Texto vazio (ou só espaços) vale como "não informado". */
function vazio(valor: unknown): boolean {
  return typeof valor === 'string' && valor.trim() === '';
}

/** Valida só quando o campo veio (`undefined` pula; `null` é validado e recusado). */
export function SeInformado(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_objeto, valor) => valor !== undefined, opcoes);
}

/** E-mail no formato aceito pela normalização (R4.1). Texto vazio passa (= sem e-mail). */
export function EhEmail(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehEmail',
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' && (vazio(valor) || ehEmailValido(valor)),
        defaultMessage: () => 'deve ser um e-mail válido',
      },
    },
    opcoes,
  );
}

/** Telefone que normaliza para E.164 com DDD válido (R4.1). Texto vazio passa. */
export function EhTelefone(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehTelefone',
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' &&
          (vazio(valor) || normalizarTelefone(valor).valido),
        defaultMessage: (argumentos?: ValidationArguments) => {
          const valor: unknown = argumentos?.value;
          if (typeof valor !== 'string') {
            return 'deve ser um texto';
          }
          const resultado = normalizarTelefone(valor);
          return resultado.valido
            ? 'deve ser um telefone válido'
            : mensagemDeTelefoneInvalido(resultado.motivo);
        },
      },
    },
    opcoes,
  );
}

/** CNPJ numérico ou alfanumérico com dígitos verificadores corretos (R4.4). Texto vazio passa. */
export function EhCnpj(opcoes?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehCnpj',
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' && (vazio(valor) || ehCnpjValido(valor)),
        defaultMessage: () =>
          'deve ser um CNPJ válido (dígitos verificadores não conferem)',
      },
    },
    opcoes,
  );
}

/**
 * Objeto JSON de campos personalizados (R4.7): até 200 chaves (de até 100
 * caracteres) e 64 KB. Combine com `@IsOptional()` quando `null` for aceito.
 */
export function EhCamposPersonalizados(
  opcoes?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehCamposPersonalizados',
      validator: {
        validate: (valor: unknown) => {
          if (!ehObjetoSimples(valor)) {
            return false;
          }
          try {
            normalizarCamposPersonalizados(valor);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage: (argumentos?: ValidationArguments) => {
          const valor: unknown = argumentos?.value;
          if (!ehObjetoSimples(valor)) {
            return 'deve ser um objeto';
          }
          try {
            normalizarCamposPersonalizados(valor);
            return 'deve ser um objeto JSON válido';
          } catch (erro) {
            const campos =
              erro instanceof DadosInvalidosException
                ? (erro.detalhes?.campos as
                    { mensagens: string[] }[] | undefined)
                : undefined;
            return (
              campos?.[0]?.mensagens[0] ?? 'deve ser um objeto JSON válido'
            );
          }
        },
      },
    },
    opcoes,
  );
}

/** `"true"`/`"false"` da query string viram booleanos (o resto segue para o `@IsBoolean`). */
export const ParaBooleano = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );

/** Identificadores em minúsculas (o banco não diferencia, as comparações em memória sim). */
export const ParaMinusculas = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

/** Texto aparado (para siglas como a UF, em maiúsculas). */
export const ParaMaiusculas = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );
