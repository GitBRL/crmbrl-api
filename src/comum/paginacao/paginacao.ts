import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type as Transformar } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Tamanho máximo de página (`porPagina`). */
export const POR_PAGINA_MAXIMO = 100;

/**
 * Paginação por página: `?pagina=1&porPagina=20` (máx. 100). Estenda nos DTOs
 * de filtro (`class FiltroContatosDto extends PaginacaoDto { … }`).
 */
export class PaginacaoDto {
  @ApiPropertyOptional({
    description: 'Página, a partir de 1.',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Transformar(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  pagina: number = 1;

  @ApiPropertyOptional({
    description: 'Itens por página (máximo 100).',
    default: 20,
    minimum: 1,
    maximum: POR_PAGINA_MAXIMO,
  })
  @IsOptional()
  @Transformar(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(POR_PAGINA_MAXIMO, {
    message: `deve ser no máximo ${POR_PAGINA_MAXIMO}`,
  })
  porPagina: number = 20;
}

/** Resposta paginada: `{ itens, total, pagina, porPagina }`. */
export interface Pagina<T> {
  itens: T[];
  total: number;
  pagina: number;
  porPagina: number;
}

/** `skip`/`take` do Prisma para a página pedida. */
export function paraSkipTake(paginacao: PaginacaoDto): {
  skip: number;
  take: number;
} {
  return {
    skip: (paginacao.pagina - 1) * paginacao.porPagina,
    take: paginacao.porPagina,
  };
}

export function montarPagina<T>(
  itens: T[],
  total: number,
  paginacao: PaginacaoDto,
): Pagina<T> {
  return {
    itens,
    total,
    pagina: paginacao.pagina,
    porPagina: paginacao.porPagina,
  };
}

/**
 * Paginação por cursor (auditoria e logs): `?cursor=<opaco>&limite=50`.
 * Resposta: `{ itens, proximoCursor }` (`null` na última página).
 */
export class CursorDto {
  @ApiPropertyOptional({
    description: 'Cursor devolvido pela página anterior.',
  })
  @IsOptional()
  @IsString({ message: 'deve ser um texto' })
  @MaxLength(200, { message: 'deve ter no máximo 200 caracteres' })
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Itens por página (máximo 100).',
    default: 50,
    minimum: 1,
    maximum: POR_PAGINA_MAXIMO,
  })
  @IsOptional()
  @Transformar(() => Number)
  @IsInt({ message: 'deve ser um número inteiro' })
  @Min(1, { message: 'deve ser no mínimo 1' })
  @Max(POR_PAGINA_MAXIMO, {
    message: `deve ser no máximo ${POR_PAGINA_MAXIMO}`,
  })
  limite: number = 50;
}

export interface PaginaPorCursor<T> {
  itens: T[];
  proximoCursor: string | null;
}

/**
 * Documenta no Swagger uma resposta `Pagina<modelo>`.
 *
 * ```ts
 * @ApiRespostaPaginada(ContatoDto)
 * listar(@Query() filtro: FiltroContatosDto): Promise<Pagina<ContatoDto>> { … }
 * ```
 */
export function ApiRespostaPaginada(modelo: Type<unknown>) {
  return applyDecorators(
    ApiExtraModels(modelo),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['itens', 'total', 'pagina', 'porPagina'],
        properties: {
          itens: { type: 'array', items: { $ref: getSchemaPath(modelo) } },
          total: { type: 'integer', example: 42 },
          pagina: { type: 'integer', example: 1 },
          porPagina: { type: 'integer', example: 20 },
        },
      },
    }),
  );
}

/** Documenta no Swagger uma resposta `PaginaPorCursor<modelo>`. */
export function ApiRespostaPorCursor(modelo: Type<unknown>) {
  return applyDecorators(
    ApiExtraModels(modelo),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['itens', 'proximoCursor'],
        properties: {
          itens: { type: 'array', items: { $ref: getSchemaPath(modelo) } },
          proximoCursor: { type: 'string', nullable: true },
        },
      },
    }),
  );
}
