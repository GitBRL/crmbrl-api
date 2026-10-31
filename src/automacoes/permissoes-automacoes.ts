/**
 * Permissões das Automações (R19): Admin e C-level veem e gerenciam todas
 * (inclusive as sem área); líderes, as da própria área; membros não usam.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { areaDoPapel, ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { Area, Prisma } from '../generated/prisma/client';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel'>;

/** Quem entra no módulo: diretoria e líderes. */
export function podeUsarAutomacoes(usuario: Usuario): boolean {
  return ehDiretoria(usuario.papel) || ehLider(usuario.papel);
}

/** Recorte de automações que o usuário vê (junte ao `where`). */
export function filtroDeAutomacoesVisiveis(
  usuario: Usuario,
): Prisma.AutomacaoWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const area = areaDoPapel(usuario.papel);
  return ehLider(usuario.papel) && area ? { area } : { id: { in: [] } };
}

/** O usuário vê (e gerencia) a automação? */
export function podeGerenciarAutomacao(
  usuario: Usuario,
  automacao: { area: Area | null },
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  const area = areaDoPapel(usuario.papel);
  return ehLider(usuario.papel) && area !== null && automacao.area === area;
}

/** Área em que a pessoa cria: a própria (líder); a diretoria escolhe (ou nenhuma = todas). */
export function areaDaNovaAutomacao(
  usuario: Usuario,
  pedida: Area | null | undefined,
): Area | null {
  return ehDiretoria(usuario.papel)
    ? (pedida ?? null)
    : areaDoPapel(usuario.papel);
}

/** `marketing` da nova automação: o que veio no pedido; sem ele, verdadeiro numa área de Marketing (R4.6). */
export function marketingDaNovaAutomacao(
  area: Area | null,
  pedido: boolean | null | undefined,
): boolean {
  return pedido ?? area === 'MARKETING';
}
