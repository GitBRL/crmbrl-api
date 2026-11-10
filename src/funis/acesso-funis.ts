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
 *
 * **Ver** e **agir** são separados (R5.12): a pessoa vê todos os negócios do
 * funil se tiver, por qualquer caminho (direto, pelo setor ou pelo papel), `VER`,
 * `GESTOR` ou `CONFIGURAR` — senão só os seus e os sem responsável; as ações
 * seguem o maior nível (`MEMBRO` age só nos seus e nos sem responsável, mesmo
 * que veja todos). Ex.: um membro do Comercial com `VER` no funil-base vê os
 * negócios dos colegas e continua movendo só os seus.
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
 * O que a pessoa tem num funil (R5.12): o nível que decide as **ações** e se ela
 * **vê** todos os negócios dele.
 */
export interface AlcanceNoFunil {
  /** O maior nível que ela tem no funil: decide o que faz. */
  readonly nivel: NivelNoFunil;
  /**
   * Vê todos os negócios: algum dos seus níveis no funil (direto, pelo setor ou
   * pelo papel) é `VER`, `GESTOR` ou `CONFIGURAR`. Falso = só os seus e os sem
   * responsável (só `MEMBRO`).
   */
  readonly veTodos: boolean;
}

/** O alcance de quem tem um nível só (ex.: `CONFIGURAR` da diretoria). */
export function alcanceDoNivel(nivel: NivelNoFunil): AlcanceNoFunil {
  return { nivel, veTodos: nivel !== 'MEMBRO' };
}

const CONFIGURA_TUDO: AlcanceNoFunil = alcanceDoNivel('CONFIGURAR');

/**
 * Alcance efetivo da pessoa no funil (R5.9, R5.11, R5.12): `null` = não vê.
 * `setorAtivo` diz se um setor-alvo está ativo (acesso de setor desativado não conta).
 */
export function alcanceEfetivo(
  pessoa: QuemAcessa,
  funil: FunilParaAcesso,
  acessos: AcessosDoFunil,
  setorAtivo: (area: Area) => boolean,
): AlcanceNoFunil | null {
  if (ehDiretoria(pessoa.papel)) {
    return CONFIGURA_TUDO;
  }
  const meuSetor = setorDaPessoa(pessoa);
  const niveis: NivelNoFunil[] = [];
  if (meuSetor !== null && meuSetor === funil.area) {
    if (pessoa.papel === 'LIDER') {
      return CONFIGURA_TUDO;
    }
    if (funil.visibilidade === 'SETOR') {
      niveis.push('MEMBRO');
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
      niveis.push(acesso.nivel);
    }
  }
  if (funil.visibilidade === 'SETOR') {
    for (const acesso of acessos.doSetor) {
      if (valeParaMim(acesso)) {
        niveis.push(acesso.nivel);
      }
    }
  }
  const nivel = niveis.reduce<NivelNoFunil | null>(maiorNivel, null);
  return nivel
    ? { nivel, veTodos: niveis.some((cada) => cada !== 'MEMBRO') }
    : null;
}

/**
 * Nível efetivo da pessoa no funil — o de ação (R5.9, R5.11, R5.12): `null` =
 * não vê. Para saber se ela vê todos os negócios, use `alcanceEfetivo`.
 */
export function nivelEfetivo(
  pessoa: QuemAcessa,
  funil: FunilParaAcesso,
  acessos: AcessosDoFunil,
  setorAtivo: (area: Area) => boolean,
): NivelNoFunil | null {
  return alcanceEfetivo(pessoa, funil, acessos, setorAtivo)?.nivel ?? null;
}

/** O mínimo de um negócio para as regras de visibilidade e ação. */
export interface NegocioParaAcesso {
  readonly funilId: string;
  readonly responsavelId: string | null;
}

const NENHUM_NEGOCIO: Prisma.NegocioWhereInput = { id: { in: [] } };

/**
 * O alcance de uma pessoa em todos os funis que ela vê (o mapa de
 * `funisAcessiveis`). Admin e C-level (`todos`) têm `CONFIGURAR` em qualquer
 * funil, sem precisar do mapa.
 */
export class AcessoAosFunis {
  private constructor(
    readonly pessoa: QuemAcessa,
    private readonly alcances: ReadonlyMap<string, AlcanceNoFunil>,
    /** Admin e C-level: veem e configuram todos os funis. */
    readonly todos: boolean,
  ) {}

  static deDiretoria(pessoa: QuemAcessa): AcessoAosFunis {
    return new AcessoAosFunis(pessoa, new Map(), true);
  }

  /** O mapa `funil → alcance` (um nível sozinho vale como `alcanceDoNivel`). */
  static comNiveis(
    pessoa: QuemAcessa,
    niveis: ReadonlyMap<string, NivelNoFunil | AlcanceNoFunil>,
  ): AcessoAosFunis {
    if (ehDiretoria(pessoa.papel)) {
      return AcessoAosFunis.deDiretoria(pessoa);
    }
    const alcances = new Map<string, AlcanceNoFunil>();
    for (const [funilId, valor] of niveis) {
      alcances.set(
        funilId,
        typeof valor === 'string' ? alcanceDoNivel(valor) : valor,
      );
    }
    return new AcessoAosFunis(pessoa, alcances, false);
  }

  /** Alcance da pessoa no funil (`null` = não vê). */
  alcance(funilId: string): AlcanceNoFunil | null {
    return this.todos ? CONFIGURA_TUDO : (this.alcances.get(funilId) ?? null);
  }

  /** Nível de ação da pessoa no funil (`null` = não vê). */
  nivel(funilId: string): NivelNoFunil | null {
    return this.alcance(funilId)?.nivel ?? null;
  }

  /** Vê todos os negócios do funil (e não só os seus e os sem responsável)? */
  veTodosNoFunil(funilId: string): boolean {
    return this.alcance(funilId)?.veTodos ?? false;
  }

  /** Funis que a pessoa vê (sem os de Admin e C-level, que veem todos: confira `todos`). */
  idsVisiveis(): string[] {
    return [...this.alcances.keys()];
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

  /**
   * Vê o negócio (R5.9, R5.12): todos, se vê todos no funil (`VER`, `GESTOR` ou
   * `CONFIGURAR` por algum caminho); senão, os seus e os sem responsável.
   */
  podeVerNegocio(negocio: NegocioParaAcesso): boolean {
    const alcance = this.alcance(negocio.funilId);
    if (!alcance) {
      return false;
    }
    return alcance.veTodos || this.ehSeuOuSemResponsavel(negocio);
  }

  /**
   * Edita, move, assume, ganha e perde o negócio (R5.12), pelo nível de ação:
   * `GESTOR` e `CONFIGURAR` em todos; `MEMBRO` nos seus e nos sem responsável
   * (mesmo que veja os demais); `VER` em nenhum.
   */
  podeAgirNoNegocio(negocio: NegocioParaAcesso): boolean {
    const nivel = this.nivel(negocio.funilId);
    if (!nivelAlcanca(nivel, 'MEMBRO')) {
      return false;
    }
    return nivel !== 'MEMBRO' || this.ehSeuOuSemResponsavel(negocio);
  }

  private ehSeuOuSemResponsavel(negocio: NegocioParaAcesso): boolean {
    return (
      negocio.responsavelId === null || negocio.responsavelId === this.pessoa.id
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
    for (const [funilId, { veTodos }] of this.alcances) {
      (veTodos ? completos : deMembro).push(funilId);
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
