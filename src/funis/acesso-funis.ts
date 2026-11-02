/**
 * Quem vê e quem configura o quê nos funis (R5.1, R5.5, R5.8, R5.9 e a matriz
 * da seção 12 das regras). Funções puras: os serviços chamam estas regras e a
 * matriz do papel (`permissoesDoPapel`) continua sendo a única fonte do alcance.
 */
import { areaDoPapel, ehDiretoria } from '../comum/dominio/papeis';
import { type Escopo, permissoesDoPapel } from '../comum/dominio/permissoes';
import type { Area, Papel, Prisma } from '../generated/prisma/client';

/** O mínimo do usuário que as regras de acesso precisam (cabe um `UsuarioAutenticado`). */
export interface QuemAcessa {
  readonly id: string;
  readonly papel: Papel;
}

/** Alcance `TODOS` ou `AREA` (da própria área) cobre a área pedida? */
function alcanca(escopo: Escopo, papel: Papel, area: Area): boolean {
  if (escopo === 'TODOS') {
    return true;
  }
  if (escopo === 'NENHUM') {
    return false;
  }
  return areaDoPapel(papel) === area;
}

/** Áreas cujos funis o usuário vê (Admin e C-level: todas; demais: a própria). */
export function areasVisiveis(usuario: QuemAcessa): readonly Area[] {
  return permissoesDoPapel(usuario.papel).areasVisiveis;
}

/** O usuário vê os funis desta área? (R5.9: o Marketing não vê o funil Comercial.) */
export function podeVerArea(usuario: QuemAcessa, area: Area): boolean {
  return areasVisiveis(usuario).includes(area);
}

/** R5.1: Admin e C-level configuram todos os funis; o líder, os da sua área. */
export function podeConfigurarFunis(usuario: QuemAcessa, area: Area): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).configurarFunis,
    usuario.papel,
    area,
  );
}

/** R5.5: reabrir negócio ganho ou perdido é só do líder da área, do C-level e do Admin. */
export function podeReabrirNegocio(usuario: QuemAcessa, area: Area): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).reabrirNegocios,
    usuario.papel,
    area,
  );
}

/**
 * Excluir um negócio segue o mesmo alcance de reabrir (líder da área, C-level
 * e Admin): as regras não dão ao membro o poder de apagar oportunidades.
 */
export function podeExcluirNegocio(usuario: QuemAcessa, area: Area): boolean {
  return podeReabrirNegocio(usuario, area);
}

/** Matriz: Admin e C-level configuram todos os rodízios; o líder, o da sua área. */
export function podeConfigurarRodizio(
  usuario: QuemAcessa,
  area: Area,
): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).configurarRodizio,
    usuario.papel,
    area,
  );
}

/** Matriz: passagens entre funis são configuradas pelo Admin e pelo C-level (R5.7). */
export function podeConfigurarPassagens(usuario: QuemAcessa): boolean {
  return permissoesDoPapel(usuario.papel).configurarPassagens;
}

/**
 * Pode ser responsável por um negócio de um funil da `area`: quem vê esse
 * funil — Admin, C-level e as pessoas da área (líder e membros).
 */
export function podeSerResponsavelNaArea(papel: Papel, area: Area): boolean {
  return ehDiretoria(papel) || areaDoPapel(papel) === area;
}

/**
 * Filtro Prisma dos negócios que o usuário vê (R5.9, proposta):
 * - Admin e C-level: todos;
 * - líder: todos os dos funis da sua área;
 * - membro: os dos funis da sua área em que é o responsável e os ainda sem
 *   responsável (que ele pode assumir).
 */
export function filtroDeNegociosVisiveis(
  usuario: QuemAcessa,
): Prisma.NegocioWhereInput {
  const escopo = permissoesDoPapel(usuario.papel).verNegocios;
  const area = areaDoPapel(usuario.papel);
  if (escopo === 'TODOS') {
    return {};
  }
  if (!area || escopo === 'NENHUM') {
    // Papel sem área e sem alcance: não vê nada (nenhum papel atual cai aqui).
    return { id: { in: [] } };
  }
  if (escopo === 'AREA') {
    return { funil: { area } };
  }
  return {
    funil: { area },
    OR: [{ responsavelId: usuario.id }, { responsavelId: null }],
  };
}

/** Mesma regra de `filtroDeNegociosVisiveis`, para um negócio já carregado. */
export function podeVerNegocio(
  usuario: QuemAcessa,
  negocio: {
    readonly responsavelId: string | null;
    readonly funil: { readonly area: Area };
  },
): boolean {
  const escopo = permissoesDoPapel(usuario.papel).verNegocios;
  if (escopo === 'TODOS') {
    return true;
  }
  if (areaDoPapel(usuario.papel) !== negocio.funil.area) {
    return false;
  }
  if (escopo === 'AREA') {
    return true;
  }
  return (
    escopo === 'PROPRIOS' &&
    (negocio.responsavelId === null || negocio.responsavelId === usuario.id)
  );
}
