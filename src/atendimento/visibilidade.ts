/**
 * Quem vê quais conversas do Atendimento (R12, versão da base — o módulo de
 * atendimento pode refinar, mantendo estas funções como a fonte única):
 *
 * - Admin e C-level: todas;
 * - Marketing (líder e membros): nenhuma — o Marketing não acessa o Atendimento;
 * - líder (Comercial, CS e setores criados): as das filas do seu setor e as que
 *   estão com ele;
 * - membro: as que estão com ele e as sem responsável das filas do seu setor.
 *
 * Conversa sem fila e sem responsável só aparece para Admin e C-level.
 */
import {
  type ComPapel,
  ehDiretoria,
  ehLider,
  setorDaPessoa,
} from '../comum/dominio/papeis';
import { type Area, SETOR_MARKETING } from '../comum/dominio/setores';
import type { Prisma } from '../generated/prisma/client';

/** O mínimo do usuário para decidir a visibilidade. */
export interface UsuarioDoAtendimento extends ComPapel {
  readonly id: string;
}

/** O mínimo da conversa para decidir a visibilidade. */
export interface ConversaParaVisibilidade {
  readonly responsavelId: string | null;
  readonly fila: { readonly area: Area } | null;
}

/** A pessoa usa o Atendimento? (Marketing não; Admin, C-level e os demais setores, sim.) */
export function podeUsarAtendimento(pessoa: ComPapel): boolean {
  return setorDaPessoa(pessoa) !== SETOR_MARKETING;
}

/** O setor usa o Atendimento (filas, respostas rápidas)? Todos menos o Marketing (R12). */
export function setorUsaAtendimento(area: Area): boolean {
  return area !== SETOR_MARKETING;
}

/** O usuário vê esta conversa? */
export function podeVerConversa(
  usuario: UsuarioDoAtendimento,
  conversa: ConversaParaVisibilidade,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  if (!podeUsarAtendimento(usuario)) {
    return false;
  }
  if (conversa.responsavelId === usuario.id) {
    return true;
  }
  const area = setorDaPessoa(usuario);
  if (!area || conversa.fila?.area !== area) {
    return false;
  }
  return ehLider(usuario.papel) || conversa.responsavelId === null;
}

/**
 * O mesmo recorte como filtro do Prisma, para listas e contagens. `null` =
 * o usuário não vê nenhuma conversa (responda lista vazia ou 404).
 */
export function filtroDeConversasVisiveis(
  usuario: UsuarioDoAtendimento,
): Prisma.ConversaWhereInput | null {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const area = setorDaPessoa(usuario);
  if (!area || !podeUsarAtendimento(usuario)) {
    return null;
  }
  return {
    OR: [
      { responsavelId: usuario.id },
      ehLider(usuario.papel)
        ? { fila: { area } }
        : { responsavelId: null, fila: { area } },
    ],
  };
}
