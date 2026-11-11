/**
 * Para quem vai cada negócio aberto no desligamento (ajuste da R7.3, R5.13) —
 * função pura. O destinatário calculado (R7.2) recebe os negócios dos funis em
 * que pode ser responsável; os demais vão para o líder ativo do setor dono do
 * funil; sem líder, para um C-level ativo; sem C-level, para o Admin que
 * executa (o desligamento nunca fica bloqueado).
 */
import type { Papel } from '../../generated/prisma/client';
import type { Area } from '../../comum/dominio/setores';

/** Por que a parte foi para essa pessoa. */
export const MOTIVOS_DA_PARTE = [
  'DESTINATARIO',
  'LIDER_DO_SETOR_DO_FUNIL',
  'C_LEVEL',
  'ADMIN',
] as const;

export type MotivoDaParte = (typeof MOTIVOS_DA_PARTE)[number];

export interface FunilDoEncaminhamento {
  readonly id: string;
  readonly nome: string;
  readonly area: Area;
}

export interface NegocioDoEncaminhamento {
  readonly id: string;
  readonly funil: FunilDoEncaminhamento;
}

export interface PessoaDoEncaminhamento {
  readonly id: string;
  readonly papel: Papel;
  readonly area: Area | null;
  readonly ativo: boolean;
}

/** Os negócios que vão para uma pessoa. */
export interface ParteDosNegocios<U extends PessoaDoEncaminhamento> {
  readonly destinatario: U;
  readonly motivo: MotivoDaParte;
  readonly negocioIds: readonly string[];
  /** Os funis desses negócios, sem repetir, na ordem em que apareceram. */
  readonly funis: readonly FunilDoEncaminhamento[];
}

/**
 * Divide os negócios abertos do desligado. `usuarios` em ordem estável (quem
 * entrou primeiro primeiro); `destinatarioAtua(funil)` diz se o destinatário
 * calculado pode ser responsável no funil (R5.13). A parte do destinatário vem
 * primeiro; as outras, na ordem em que surgiram.
 */
export function dividirNegocios<U extends PessoaDoEncaminhamento>(entrada: {
  readonly negocios: readonly NegocioDoEncaminhamento[];
  readonly destinatario: U;
  readonly desligadoId: string;
  readonly executor: U;
  readonly usuarios: readonly U[];
  readonly destinatarioAtua: (funil: FunilDoEncaminhamento) => boolean;
}): ParteDosNegocios<U>[] {
  const { destinatario, desligadoId, executor, usuarios } = entrada;
  const disponivel = (pessoa: U) => pessoa.ativo && pessoa.id !== desligadoId;
  const quemRecebe = (
    funil: FunilDoEncaminhamento,
  ): { pessoa: U; motivo: MotivoDaParte } => {
    if (entrada.destinatarioAtua(funil)) {
      return { pessoa: destinatario, motivo: 'DESTINATARIO' };
    }
    const lider = usuarios.find(
      (pessoa) =>
        disponivel(pessoa) &&
        pessoa.papel === 'LIDER' &&
        pessoa.area === funil.area,
    );
    if (lider) {
      return { pessoa: lider, motivo: 'LIDER_DO_SETOR_DO_FUNIL' };
    }
    const cLevel = usuarios.find(
      (pessoa) => disponivel(pessoa) && pessoa.papel === 'C_LEVEL',
    );
    if (cLevel) {
      return { pessoa: cLevel, motivo: 'C_LEVEL' };
    }
    return { pessoa: executor, motivo: 'ADMIN' };
  };
  const partes = new Map<
    string,
    {
      destinatario: U;
      motivo: MotivoDaParte;
      negocioIds: string[];
      funis: Map<string, FunilDoEncaminhamento>;
    }
  >();
  for (const negocio of entrada.negocios) {
    const { pessoa, motivo } = quemRecebe(negocio.funil);
    let parte = partes.get(pessoa.id);
    if (!parte) {
      parte = {
        destinatario: pessoa,
        motivo: pessoa.id === destinatario.id ? 'DESTINATARIO' : motivo,
        negocioIds: [],
        funis: new Map(),
      };
      partes.set(pessoa.id, parte);
    }
    parte.negocioIds.push(negocio.id);
    parte.funis.set(negocio.funil.id, negocio.funil);
  }
  return [...partes.values()]
    .sort(
      (a, b) =>
        Number(b.destinatario.id === destinatario.id) -
        Number(a.destinatario.id === destinatario.id),
    )
    .map((parte) => ({
      destinatario: parte.destinatario,
      motivo: parte.motivo,
      negocioIds: parte.negocioIds,
      funis: [...parte.funis.values()],
    }));
}
