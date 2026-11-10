/**
 * Quem vê e quem faz o quê nos funis (R5.1, R5.5, R5.8, R5.9, R5.11–R5.13 e a
 * matriz da seção 12 das regras). Funções puras: os serviços carregam os
 * acessos do banco (`acessos-no-banco.ts`) e chamam estas regras.
 *
 * O **nível efetivo** de uma pessoa num funil é o maior entre:
 * - o papel no setor dono: líder → `CONFIGURAR`; membro → `MEMBRO`, só se o funil
 *   for `SETOR` (no `RESTRITA`, do setor dono só os líderes veem);
 * - os acessos do próprio funil, pela pessoa ou pelo setor dela;
 * - os acessos do setor dono, pela pessoa ou pelo setor dela — que **não** valem
 *   para funil `RESTRITA`.
 * Admin e C-level: `CONFIGURAR` em todos. Acesso dado a um setor desativado não
 * conta.
 */
import {
  type ComPapel,
  ehDiretoria,
  ehDoSetor,
  setorDaPessoa,
} from '../comum/dominio/papeis';
import { type Escopo, permissoesDoPapel } from '../comum/dominio/permissoes';
import type { Area } from '../comum/dominio/setores';
import {
  type NivelAcesso,
  Prisma,
  type VisibilidadeFunil,
} from '../generated/prisma/client';

/** O mínimo do usuário que as regras de acesso precisam (cabe um `UsuarioAutenticado`). */
export interface QuemAcessa extends ComPapel {
  readonly id: string;
}

/**
 * Nível efetivo de uma pessoa num funil (R5.12), do menor ao maior:
 * - `VER`: vê todos os negócios, só leitura;
 * - `MEMBRO`: vê os seus e os sem responsável; assume, cria, edita e move os que vê;
 * - `GESTOR`: vê, cria, edita e move todos e troca o responsável;
 * - `CONFIGURAR`: o de `GESTOR` e ainda configura o funil, reabre e exclui negócios
 *   (líder do setor dono, C-level e Admin).
 */
export type NivelNoFunil = NivelAcesso | 'CONFIGURAR';

/** Os níveis em ordem crescente. */
export const NIVEIS_NO_FUNIL: readonly NivelNoFunil[] = [
  'VER',
  'MEMBRO',
  'GESTOR',
  'CONFIGURAR',
];

const PESO: Readonly<Record<NivelNoFunil, number>> = {
  VER: 1,
  MEMBRO: 2,
  GESTOR: 3,
  CONFIGURAR: 4,
};

/** O nível alcança o mínimo pedido? (`null` = não vê o funil.) */
export function nivelAlcanca(
  nivel: NivelNoFunil | null | undefined,
  minimo: NivelNoFunil,
): boolean {
  return !!nivel && PESO[nivel] >= PESO[minimo];
}

/** O maior de dois níveis (`null` = sem acesso). */
export function maiorNivel(
  a: NivelNoFunil | null,
  b: NivelNoFunil | null,
): NivelNoFunil | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return PESO[a] >= PESO[b] ? a : b;
}

/** O mínimo de um funil para calcular o nível. */
export interface FunilParaAcesso {
  readonly id: string;
  readonly area: Area;
  readonly visibilidade: VisibilidadeFunil;
}

/** Um acesso extra (de funil ou de setor): para um setor inteiro **ou** uma pessoa. */
export interface AcessoExtra {
  readonly area: Area | null;
  readonly usuarioId: string | null;
  readonly nivel: NivelAcesso;
}

/** Os acessos que valem para um funil: os da lista dele e os do setor dono. */
export interface AcessosDoFunil {
  readonly doFunil: readonly AcessoExtra[];
  /** Acessos do setor dono do funil (ignorados se o funil for `RESTRITA`). */
  readonly doSetor: readonly AcessoExtra[];
}

/**
 * Nível efetivo da pessoa no funil (R5.9, R5.11): `null` = não vê.
 * `setorAtivo` diz se um setor-alvo está ativo (acesso de setor desativado não conta).
 */
export function nivelEfetivo(
  pessoa: QuemAcessa,
  funil: FunilParaAcesso,
  acessos: AcessosDoFunil,
  setorAtivo: (area: Area) => boolean,
): NivelNoFunil | null {
  if (ehDiretoria(pessoa.papel)) {
    return 'CONFIGURAR';
  }
  const meuSetor = setorDaPessoa(pessoa);
  let nivel: NivelNoFunil | null = null;
  if (meuSetor !== null && meuSetor === funil.area) {
    if (pessoa.papel === 'LIDER') {
      return 'CONFIGURAR';
    }
    if (funil.visibilidade === 'SETOR') {
      nivel = 'MEMBRO';
    }
  }
  const valeParaMim = (acesso: AcessoExtra): boolean =>
    acesso.usuarioId === pessoa.id ||
    (acesso.area !== null &&
      meuSetor !== null &&
      acesso.area === meuSetor &&
      setorAtivo(acesso.area));
  for (const acesso of acessos.doFunil) {
    if (valeParaMim(acesso)) {
      nivel = maiorNivel(nivel, acesso.nivel);
    }
  }
  if (funil.visibilidade === 'SETOR') {
    for (const acesso of acessos.doSetor) {
      if (valeParaMim(acesso)) {
        nivel = maiorNivel(nivel, acesso.nivel);
      }
    }
  }
  return nivel;
}

/** O mínimo de um negócio para as regras de visibilidade e ação. */
export interface NegocioParaAcesso {
  readonly funilId: string;
  readonly responsavelId: string | null;
}

const NENHUM_NEGOCIO: Prisma.NegocioWhereInput = { id: { in: [] } };

/**
 * Os níveis de uma pessoa em todos os funis que ela vê (o mapa de
 * `funisAcessiveis`). Admin e C-level (`todos`) têm `CONFIGURAR` em qualquer
 * funil, sem precisar do mapa.
 */
export class AcessoAosFunis {
  private constructor(
    readonly pessoa: QuemAcessa,
    private readonly niveis: ReadonlyMap<string, NivelNoFunil>,
    /** Admin e C-level: veem e configuram todos os funis. */
    readonly todos: boolean,
  ) {}

  static deDiretoria(pessoa: QuemAcessa): AcessoAosFunis {
    return new AcessoAosFunis(pessoa, new Map(), true);
  }

  static comNiveis(
    pessoa: QuemAcessa,
    niveis: ReadonlyMap<string, NivelNoFunil>,
  ): AcessoAosFunis {
    return ehDiretoria(pessoa.papel)
      ? AcessoAosFunis.deDiretoria(pessoa)
      : new AcessoAosFunis(pessoa, niveis, false);
  }

  /** Nível da pessoa no funil (`null` = não vê). */
  nivel(funilId: string): NivelNoFunil | null {
    return this.todos ? 'CONFIGURAR' : (this.niveis.get(funilId) ?? null);
  }

  /** Funis que a pessoa vê (sem os de Admin e C-level, que veem todos: confira `todos`). */
  idsVisiveis(): string[] {
    return [...this.niveis.keys()];
  }

  /** Vê o funil (qualquer nível)? */
  podeVerFunil(funilId: string): boolean {
    return this.nivel(funilId) !== null;
  }

  /** Cria negócios no funil (`MEMBRO` ou mais, R5.12)? */
  podeCriarNoFunil(funilId: string): boolean {
    return nivelAlcanca(this.nivel(funilId), 'MEMBRO');
  }

  /** Configura o funil, reabre e exclui negócios dele (líder do setor dono, C-level, Admin — R5.1, R5.5)? */
  podeConfigurarFunil(funilId: string): boolean {
    return this.nivel(funilId) === 'CONFIGURAR';
  }

  /** Vê o negócio (R5.9): `MEMBRO` só os seus e os sem responsável; os demais níveis, todos. */
  podeVerNegocio(negocio: NegocioParaAcesso): boolean {
    const nivel = this.nivel(negocio.funilId);
    if (!nivel) {
      return false;
    }
    return (
      nivel !== 'MEMBRO' ||
      negocio.responsavelId === null ||
      negocio.responsavelId === this.pessoa.id
    );
  }

  /** Edita, move, assume, ganha e perde o negócio (R5.12): vê e tem `MEMBRO` ou mais. */
  podeAgirNoNegocio(negocio: NegocioParaAcesso): boolean {
    return (
      this.podeVerNegocio(negocio) &&
      nivelAlcanca(this.nivel(negocio.funilId), 'MEMBRO')
    );
  }

  /** Filtro Prisma dos negócios que a pessoa vê (R5.9). Use dentro de um `AND`. */
  filtroDeNegocios(): Prisma.NegocioWhereInput {
    if (this.todos) {
      return {};
    }
    const { completos, deMembro } = this.separarPorAlcance();
    const alternativas: Prisma.NegocioWhereInput[] = [];
    if (completos.length > 0) {
      alternativas.push({ funilId: { in: completos } });
    }
    if (deMembro.length > 0) {
      alternativas.push({
        funilId: { in: deMembro },
        OR: [{ responsavelId: this.pessoa.id }, { responsavelId: null }],
      });
    }
    return alternativas.length > 0 ? { OR: alternativas } : NENHUM_NEGOCIO;
  }

  /** O mesmo filtro em SQL, para a tabela de negócios `n` (`n.funil_id`, `n.responsavel_id`). */
  sqlDeNegocios(n: Prisma.Sql = Prisma.raw('n')): Prisma.Sql {
    if (this.todos) {
      return Prisma.sql`TRUE`;
    }
    const { completos, deMembro } = this.separarPorAlcance();
    if (completos.length === 0 && deMembro.length === 0) {
      return Prisma.sql`FALSE`;
    }
    return Prisma.sql`(${n}.funil_id = ANY(${completos}::uuid[])
      OR (${n}.funil_id = ANY(${deMembro}::uuid[])
          AND (${n}.responsavel_id = ${this.pessoa.id}::uuid OR ${n}.responsavel_id IS NULL)))`;
  }

  /** Funis em que vê todos os negócios e funis em que vê só os seus e os sem responsável. */
  private separarPorAlcance(): { completos: string[]; deMembro: string[] } {
    const completos: string[] = [];
    const deMembro: string[] = [];
    for (const [funilId, nivel] of this.niveis) {
      (nivel === 'MEMBRO' ? deMembro : completos).push(funilId);
    }
    return { completos, deMembro };
  }
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

/**
 * R5.1: cria funis no setor — Admin e C-level em todos; o líder, no seu. (Os
 * funis já criados se configuram pelo nível: `AcessoAosFunis.podeConfigurarFunil`.)
 */
export function podeConfigurarFunis(usuario: QuemAcessa, area: Area): boolean {
  return alcanca(
    permissoesDoPapel(usuario.papel).configurarFunis,
    usuario,
    area,
  );
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
 * Admin, C-level ou pessoa do setor (líder ou membro) — o alcance de um setor
 * inteiro, sem olhar funil (ex.: o rodízio de contatos da importação). Para
 * responsável de negócio, use o nível no funil (R5.13).
 */
export function atuaNoSetor(pessoa: ComPapel, area: Area): boolean {
  return ehDiretoria(pessoa.papel) || ehDoSetor(pessoa, area);
}
