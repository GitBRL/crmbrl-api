/**
 * Permissões do Chatbot (R18): Admin e C-level gerenciam todos os fluxos; o
 * líder, os da própria área (e vê os de todas as áreas, só leitura); membros
 * não têm acesso à configuração do chatbot.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { areaDoPapel, ehDiretoria, ehLider } from '../comum/dominio/papeis';
import type { Area, Prisma } from '../generated/prisma/client';

type Usuario = Pick<UsuarioAutenticado, 'papel'>;

export interface DonoDeFluxo {
  area: Area | null;
}

/** Quem abre a configuração do chatbot. */
export function podeUsarChatbot(usuario: Usuario): boolean {
  return ehDiretoria(usuario.papel) || ehLider(usuario.papel);
}

/**
 * Recorte de fluxos que o usuário vê (junte ao `where`): quem usa o chatbot lê
 * os fluxos de todas as áreas (R18.6); só a edição é limitada (`podeGerenciarFluxo`).
 */
export function filtroDeFluxosVisiveis(
  _usuario: Usuario,
): Prisma.FluxoChatbotWhereInput {
  return {};
}

/** Pode editar, publicar, ativar e excluir o fluxo? */
export function podeGerenciarFluxo(
  usuario: Usuario,
  fluxo: DonoDeFluxo,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  const area = areaDoPapel(usuario.papel);
  return ehLider(usuario.papel) && area !== null && fluxo.area === area;
}

/** Área do fluxo novo: a do líder; a diretoria escolhe (ou nenhuma = todas). */
export function areaDoNovoFluxo(
  usuario: Usuario,
  pedida: Area | null | undefined,
): Area | null {
  return ehDiretoria(usuario.papel)
    ? (pedida ?? null)
    : areaDoPapel(usuario.papel);
}
