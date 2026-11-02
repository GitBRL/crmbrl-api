import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { DadosInvalidosException } from '../erros/excecoes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Texto é um UUID (qualquer versão)? */
export function ehUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

/**
 * Valida um id (UUID) vindo da rota ou da query; inválido → 400 `dados_invalidos`.
 *
 * ```ts
 * @Get(':id') detalhar(@Param('id', ParseIdPipe) id: string) { … }
 * ```
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadados: ArgumentMetadata): string {
    if (ehUuid(valor)) {
      return valor.toLowerCase();
    }
    const campo = metadados.data ?? 'id';
    throw new DadosInvalidosException(`Identificador inválido em ${campo}.`, {
      campos: [
        { campo, mensagens: ['deve ser um identificador (UUID) válido'] },
      ],
    });
  }
}
