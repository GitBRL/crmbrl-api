/**
 * Quem vê e quem configura o quê nos funis (R5.1, R5.5, R5.8, R5.9 e a matriz
 * da seção 12 das regras). Funções puras: os serviços chamam estas regras e a
 * matriz do papel (`permissoesDoPapel`) continua sendo a única fonte do alcance.
 */
import {
  type ComPapel,
  ehDiretoria,
  ehDoSetor,
  setorDaPessoa,
} from '../comum/dominio/papeis';
import { type Escopo, permissoesDoPapel } from '../comum/dominio/permissoes';
import type { Area } from '../comum/dominio/setores';
import type { Prisma } from '../generated/prisma/client';

/** O mínimo do usuário que as regras de acesso precisam (cabe um `UsuarioAutenticado`). */
export interface QuemAcessa extends ComPapel {
  readonly id: string;
}

/** Alcance `TODOS` ou `AREA` (do próprio setor) cobre o setor pedido? */
function alcanca(escopo: Escopo, usuario: ComPapel, area: Area): boolean {
  if (escopo === 'TODOS') {
    return true;
  }
  if (escopo === 'NENHUM') {
    return false;
  }
  return setorDaPessoa(usuario) === area;
}

/** O usuário vê os funis deste setor? (R5.9: o Marketing não vê o funil Comercial.) */
export function podeVerArea(usuario: QuemAcessa, area: Area): boolean {
  return ehDiretoria(usuario.papel) || setorDaPessoa(usuario) === area;
}

/**
 * Filtro Prisma dos funis que o usuário vê (R5.9): Admin e C-level, todos; Líder
 * e Membro, os do seu setor.
 */
export function filtroDeFunisVisiveis(
  usuario: QuemAcessa,
): Prisma.FunilWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const area = setorDaPessoa(usuario);
  return area ? { area } : { id: { in: [] } };
}

/** R5.1: Admin e C-level configuram todos os funis; o líder, os da sua área. */
export function podeConfigurarFunis(usuario: QuemAcessa, area: Area): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).configurarFunis,
    usuario,
    area,
  );
}

/** R5.5: reabrir negócio ganho ou perdido é só do líder da área, do C-level e do Admin. */
export function podeReabrirNegocio(usuario: QuemAcessa, area: Area): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).reabrirNegocios,
    usuario,
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
    usuario,
    area,
  );
}

/** Matriz: passagens entre funis são configuradas pelo Admin e pelo C-level (R5.7). */
export function podeConfigurarPassagens(usuario: QuemAcessa): boolean {
  return permissoesDoPapel(usuario.papel).configurarPassagens;
}

/**
 * Pode ser responsável por um negócio de um funil do setor `area`: quem vê esse
 * funil — Admin, C-level e as pessoas do setor (líder e membros).
 */
export function podeSerResponsavelNaArea(
  pessoa: ComPapel,
  area: Area,
): boolean {
  return ehDiretoria(pessoa.papel) || ehDoSetor(pessoa, area);
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
  const area = setorDaPessoa(usuario);
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
  if (setorDaPessoa(usuario) !== negocio.funil.area) {
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
