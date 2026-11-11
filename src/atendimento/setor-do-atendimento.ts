import type { Area } from '../comum/dominio/setores';
import { RegraVioladaException } from '../comum/erros/excecoes';
import {
  garantirSetorAtivo,
  type LeitorDeSetores,
} from '../setores/setores-no-banco';
import { REGRA_ATENDIMENTO } from './atendimento.constantes';
import { setorUsaAtendimento } from './visibilidade';

/**
 * O setor pode receber uma fila ou uma resposta rápida? Precisa existir, estar
 * ativo (R1.9) e não ser o Marketing, que não usa o Atendimento (R12).
 */
export async function garantirSetorDoAtendimento(
  db: LeitorDeSetores,
  area: Area,
  campo = 'area',
): Promise<void> {
  if (!setorUsaAtendimento(area)) {
    throw new RegraVioladaException(
      REGRA_ATENDIMENTO,
      'O Marketing não usa o Atendimento: escolha outro setor.',
      { campo, area },
    );
  }
  await garantirSetorAtivo(db, area, campo);
}
