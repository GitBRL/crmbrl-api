/**
 * Apoio dos DTOs dos webhooks: transformações, validadores e os resumos que
 * aparecem nas respostas (usuário, funil, etapa).
 */
import { ApiProperty } from '@nestjs/swagger';
import type { TransformFnParams } from 'class-transformer';
import {
  isISO8601,
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import { TipoEtapa, type Etapa, type Funil } from '../generated/prisma/client';
import type { Area } from '../comum/dominio/setores';

export const MENSAGEM_TEXTO = 'deve ser um texto';
export const MENSAGEM_UUID = {
  message: 'deve ser um identificador (UUID) válido',
};
export const MENSAGEM_BOOLEANO = { message: 'deve ser verdadeiro ou falso' };

export const maximo = (limite: number) => ({
  message: `deve ter no máximo ${limite} caracteres`,
});

export function mensagemDeValores(valores: readonly string[]): string {
  return `deve ser um destes valores: ${valores.join(', ')}`;
}

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

/** Apara textos; o resto passa como veio (o validador reclama). */
export function aparar({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** `'true'`/`'false'` da query string → booleano (o resto passa, para a validação acusar). */
export function lerBooleano({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}

/** Parâmetro repetido (`?status=A&status=B`) ou separado por vírgula (`?status=A,B`) → lista. */
export function paraLista({ value }: TransformFnParams): unknown {
  const itens = Array.isArray(value) ? value : [value];
  if (!itens.every((item) => typeof item === 'string')) {
    return value;
  }
  return (itens as string[])
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Data e hora ISO 8601 com fuso (`Z` ou `±hh:mm`), ou só a data (meia-noite UTC). */
const DATA_OU_DATA_HORA_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const MENSAGEM_DATA_HORA =
  'deve ser uma data (2026-10-20) ou data e hora ISO 8601 com fuso (2026-10-20T14:00:00-03:00)';

/** Valida uma data, ou data e hora com fuso (o campo continua texto no DTO). */
export function IsDataOuDataHora(
  opcoes?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'ehDataOuDataHora',
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' &&
          DATA_OU_DATA_HORA_COM_FUSO.test(valor) &&
          isISO8601(valor, { strict: true }) &&
          !Number.isNaN(Date.parse(valor)),
        defaultMessage: () => MENSAGEM_DATA_HORA,
      },
    },
    { message: MENSAGEM_DATA_HORA, ...opcoes },
  );
}

/** O `+` do fuso enviado sem codificar chega como espaço na query: devolve ao lugar. */
export function restaurarFuso({ value }: TransformFnParams): unknown {
  return typeof value === 'string'
    ? value.trim().replace(/ (\d{2}:\d{2})$/, '+$1')
    : value;
}

export class UsuarioDoWebhookDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Ana Souza' })
  nome: string;

  static de(
    usuario: { id: string; nome: string } | null | undefined,
  ): UsuarioDoWebhookDto | null {
    return usuario ? { id: usuario.id, nome: usuario.nome } : null;
  }
}

export class FunilDoWebhookDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Marketing' })
  nome: string;

  @ApiProperty({ type: String, example: 'COMERCIAL' })
  area: Area;

  static de(funil: Pick<Funil, 'id' | 'nome' | 'area'>): FunilDoWebhookDto {
    return { id: funil.id, nome: funil.nome, area: funil.area };
  }
}

export class EtapaDoWebhookDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Novo lead' })
  nome: string;

  @ApiProperty({ enum: TipoEtapa, enumName: 'TipoEtapa' })
  tipo: TipoEtapa;

  static de(etapa: Pick<Etapa, 'id' | 'nome' | 'tipo'>): EtapaDoWebhookDto {
    return { id: etapa.id, nome: etapa.nome, tipo: etapa.tipo };
  }
}
