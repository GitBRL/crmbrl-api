import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { DadosInvalidosException } from '../../comum/erros/excecoes';

/** Maior valor de um `bigint` do PostgreSQL. */
const MAIOR_BIGINT = 9_223_372_036_854_775_807n;

/**
 * Valida o id sequencial (`bigint`) de um evento de auditoria ou de um log
 * técnico, vindo da rota como texto; inválido → 400 `dados_invalidos`.
 *
 * ```ts
 * @Get(':id') detalhar(@Param('id', ParseIdSequencialPipe) id: bigint) { … }
 * ```
 */
@Injectable()
export class ParseIdSequencialPipe implements PipeTransform<unknown, bigint> {
  transform(valor: unknown, metadados: ArgumentMetadata): bigint {
    if (typeof valor === 'string' && /^\d{1,19}$/.test(valor)) {
      const id = BigInt(valor);
      if (id > 0n && id <= MAIOR_BIGINT) {
        return id;
      }
    }
    const campo = metadados.data ?? 'id';
    throw new DadosInvalidosException(`Identificador inválido em ${campo}.`, {
      campos: [
        { campo, mensagens: ['deve ser um número inteiro positivo (o id)'] },
      ],
    });
  }
}
