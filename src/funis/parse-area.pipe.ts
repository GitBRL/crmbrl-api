import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { TODAS_AS_AREAS } from '../comum/dominio/papeis';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import type { Area } from '../generated/prisma/client';

/**
 * Valida uma área vinda da rota (`/regras-distribuicao/comercial`), sem
 * diferenciar maiúsculas; inválida → 400 `dados_invalidos`.
 */
@Injectable()
export class ParseAreaPipe implements PipeTransform<unknown, Area> {
  transform(valor: unknown, metadados: ArgumentMetadata): Area {
    const texto = typeof valor === 'string' ? valor.trim().toUpperCase() : '';
    const area = TODAS_AS_AREAS.find((candidata) => candidata === texto);
    if (area) {
      return area;
    }
    const campo = metadados.data ?? 'area';
    throw new DadosInvalidosException(`Área inválida em ${campo}.`, {
      campos: [{ campo, mensagens: ['deve ser MARKETING, COMERCIAL ou CS'] }],
    });
  }
}
