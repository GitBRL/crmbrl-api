/**
 * Quem vê quais usuários (R1.5, matriz da seção 12): Admin e C-level veem
 * todos; o líder vê a própria equipe (ele e os liderados); o membro vê a si
 * mesmo. Gerenciar (criar, editar, desligar, reativar, senha) é só do Admin.
 */
import { permissoesDoPapel } from '../../comum/dominio/permissoes';
import type { Papel, Prisma } from '../../generated/prisma/client';

export interface Observador {
  readonly id: string;
  readonly papel: Papel;
}

/** `observador` pode ver `alvo`? */
export function podeVerUsuario(
  observador: Observador,
  alvo: { readonly id: string; readonly liderId: string | null },
): boolean {
  switch (permissoesDoPapel(observador.papel).verUsuarios) {
    case 'TODOS':
      return true;
    case 'EQUIPE':
      return alvo.id === observador.id || alvo.liderId === observador.id;
    default:
      return alvo.id === observador.id;
  }
}

/** O mesmo recorte, como filtro do Prisma para as listagens. */
export function filtroDeVisibilidade(
  observador: Observador,
): Prisma.UsuarioWhereInput {
  switch (permissoesDoPapel(observador.papel).verUsuarios) {
    case 'TODOS':
      return {};
    case 'EQUIPE':
      return { OR: [{ id: observador.id }, { liderId: observador.id }] };
    default:
      return { id: observador.id };
  }
}
