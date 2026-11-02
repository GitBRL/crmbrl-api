/**
 * Quem vê quais conversas do Atendimento (R12, versão da base — o módulo de
 * atendimento pode refinar, mantendo estas funções como a fonte única):
 *
 * - Admin e C-level: todas;
 * - Marketing (líder e membros): nenhuma — o Marketing não acessa o Atendimento;
 * - líder (Comercial, CS): as das filas da sua área e as que estão com ele;
 * - membro: as que estão com ele e as sem responsável das filas da sua área.
 *
 * Conversa sem fila e sem responsável só aparece para Admin e C-level.
 */
import { areaDoPapel, ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { Area, Papel, Prisma } from '../generated/prisma/client';

/** O mínimo do usuário para decidir a visibilidade. */
export interface UsuarioDoAtendimento {
  readonly id: string;
  readonly papel: Papel;
}

/** O mínimo da conversa para decidir a visibilidade. */
export interface ConversaParaVisibilidade {
  readonly responsavelId: string | null;
  readonly fila: { readonly area: Area } | null;
}

/** O papel usa o Atendimento? (Marketing não.) */
export function podeUsarAtendimento(papel: Papel): boolean {
  return areaDoPapel(papel) !== 'MARKETING';
}

/** O usuário vê esta conversa? */
export function podeVerConversa(
  usuario: UsuarioDoAtendimento,
  conversa: ConversaParaVisibilidade,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  if (!podeUsarAtendimento(usuario.papel)) {
    return false;
  }
  if (conversa.responsavelId === usuario.id) {
    return true;
  }
  const area = areaDoPapel(usuario.papel);
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
  const area = areaDoPapel(usuario.papel);
  if (!area || !podeUsarAtendimento(usuario.papel)) {
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
