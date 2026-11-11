import {
  type ArgumentMetadata,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { Area } from '../comum/dominio/setores';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import {
  FORMATO_DA_CHAVE_DE_SETOR,
  MENSAGEM_SETOR,
} from '../comum/validacao/setor';

/**
 * Valida a chave de um setor vinda da rota (`/regras-distribuicao/comercial`),
 * sem diferenciar maiúsculas; fora do formato da chave → 400 `dados_invalidos`.
 * Que o setor existe fica com o serviço (404 ou 422).
 */
@Injectable()
export class ParseAreaPipe implements PipeTransform<unknown, Area> {
  transform(valor: unknown, metadados: ArgumentMetadata): Area {
    const texto = typeof valor === 'string' ? valor.trim().toUpperCase() : '';
    if (FORMATO_DA_CHAVE_DE_SETOR.test(texto)) {
      return texto;
    }
    const campo = metadados.data ?? 'area';
    throw new DadosInvalidosException(`Setor inválido em ${campo}.`, {
      campos: [{ campo, mensagens: [MENSAGEM_SETOR] }],
    });
  }
}
