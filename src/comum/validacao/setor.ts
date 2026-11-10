import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/** Formato da chave de um setor (CHECK `setores_chave_check`, R1.8). */
export const FORMATO_DA_CHAVE_DE_SETOR = /^[A-Z0-9][A-Z0-9_]{0,39}$/;

export const MENSAGEM_SETOR = 'deve ser a chave de um setor (ex.: COMERCIAL)';

/** Descrição padrão do campo nas rotas (Swagger). */
export const DESCRICAO_SETOR =
  'Chave do setor (`GET /setores`): `MARKETING`, `COMERCIAL`, `CS` ou a de um setor criado.';

/**
 * Chave de setor num corpo ou consulta (R1.6): aparada, em maiúsculas e no
 * formato da chave. Que o setor existe e está ativo é conferido no serviço
 * (`garantirSetorAtivo`, R1.9), que tem o banco.
 *
 * ```ts
 * @IsOptional()
 * @ChaveDeSetor()
 * area?: Area | null;
 * ```
 */
export function ChaveDeSetor(mensagem = MENSAGEM_SETOR): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toUpperCase() : value,
    ),
    IsString({ message: mensagem }),
    Matches(FORMATO_DA_CHAVE_DE_SETOR, { message: mensagem }),
  );
}
