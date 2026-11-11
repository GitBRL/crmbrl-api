/**
 * Permissões dos Disparos (R17): Admin, C-level, líderes e membros de
 * Marketing/Comercial/CS usam. Membros veem só as próprias campanhas; líderes as
 * da área (e as próprias); Admin e C-level todas.
 */
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, ehLider, setorDaPessoa } from '../comum/dominio/papeis';
import type { Prisma } from '../generated/prisma/client';
import type { Area } from '../comum/dominio/setores';

type Usuario = Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>;

export interface DonoDeCampanha {
  area: Area | null;
  criadoPorId: string | null;
}

/** Recorte de campanhas que o usuário vê (junte ao `where`). */
export function filtroDeCampanhasVisiveis(
  usuario: Usuario,
): Prisma.CampanhaWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const area = setorDaPessoa(usuario);
  if (ehLider(usuario.papel) && area) {
    return { OR: [{ area }, { criadoPorId: usuario.id }] };
  }
  return { criadoPorId: usuario.id };
}

/** O usuário vê (e gerencia) a campanha? */
export function podeVerCampanha(
  usuario: Usuario,
  campanha: DonoDeCampanha,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  if (campanha.criadoPorId === usuario.id) {
    return true;
  }
  const area = setorDaPessoa(usuario);
  return ehLider(usuario.papel) && area !== null && campanha.area === area;
}

/** Quem aprova: Admin, C-level e o líder da área da campanha. */
export function podeAprovarCampanha(
  usuario: Usuario,
  campanha: DonoDeCampanha,
): boolean {
  if (ehDiretoria(usuario.papel)) {
    return true;
  }
  const area = setorDaPessoa(usuario);
  return ehLider(usuario.papel) && area !== null && campanha.area === area;
}

/** Líder e diretoria começam campanha sem aprovação; membro depende da configuração. */
export function dispensaAprovacao(usuario: Usuario): boolean {
  return ehDiretoria(usuario.papel) || ehLider(usuario.papel);
}

/** Área em que o usuário cria: a própria (membro e líder); diretoria escolhe (ou nenhuma). */
export function areaDaNovaCampanha(
  usuario: Usuario,
  pedida: Area | null | undefined,
): Area | null {
  if (ehDiretoria(usuario.papel)) {
    return pedida ?? null;
  }
  return setorDaPessoa(usuario);
}
