import type {
  AplicativoIntegracao,
  ModeloMapeamento,
  Prisma,
} from '../../generated/prisma/client';
import { adaptadorDe } from '../aplicativos/registro';
import { type Mapeamento, mapeamentoEfetivo } from './mapeamento';

/** O que vale para a integração: o modelo pronto do aplicativo, o do R8.1 ou o gravado (R32.2). */
export function mapeamentoDaIntegracao(integracao: {
  readonly modeloMapeamento: ModeloMapeamento;
  readonly mapeamento: Prisma.JsonValue | null;
  readonly aplicativo: AplicativoIntegracao;
}): Mapeamento {
  if (integracao.modeloMapeamento === 'DO_APLICATIVO') {
    return (
      adaptadorDe(integracao.aplicativo)?.definicao.modelo?.mapeamento ?? {
        campos: [],
        ignorarQuando: [],
      }
    );
  }
  return mapeamentoEfetivo(integracao.modeloMapeamento, integracao.mapeamento);
}
