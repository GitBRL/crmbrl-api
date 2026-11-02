/**
 * Papéis, áreas e hierarquia (R1, tabela da seção 1 das regras).
 *
 * | Papel           | Área      | Nível         | Líder obrigatório       |
 * | --------------- | --------- | ------------- | ----------------------- |
 * | ADMIN           | —         | ADMINISTRADOR | não tem                 |
 * | C_LEVEL         | —         | DIRETORIA     | não tem                 |
 * | LIDER_COMERCIAL | COMERCIAL | LIDER         | um C_LEVEL ativo        |
 * | COMERCIAL       | COMERCIAL | MEMBRO        | um LIDER_COMERCIAL ativo|
 * | LIDER_MARKETING | MARKETING | LIDER         | um C_LEVEL ativo        |
 * | MARKETING       | MARKETING | MEMBRO        | um LIDER_MARKETING ativo|
 * | LIDER_CS        | CS        | LIDER         | um C_LEVEL ativo        |
 * | CS              | CS        | MEMBRO        | um LIDER_CS ativo       |
 */
import { Area, Papel } from '../../generated/prisma/client';

export type NivelPapel = 'ADMINISTRADOR' | 'DIRETORIA' | 'LIDER' | 'MEMBRO';

export interface DefinicaoPapel {
  readonly papel: Papel;
  readonly rotulo: string;
  /** `null` para Admin e C-level (sem área). */
  readonly area: Area | null;
  readonly nivel: NivelPapel;
}

export const DEFINICOES_DE_PAPEL: Readonly<Record<Papel, DefinicaoPapel>> = {
  ADMIN: {
    papel: 'ADMIN',
    rotulo: 'Admin',
    area: null,
    nivel: 'ADMINISTRADOR',
  },
  C_LEVEL: {
    papel: 'C_LEVEL',
    rotulo: 'C-level',
    area: null,
    nivel: 'DIRETORIA',
  },
  LIDER_COMERCIAL: {
    papel: 'LIDER_COMERCIAL',
    rotulo: 'Líder Comercial',
    area: 'COMERCIAL',
    nivel: 'LIDER',
  },
  COMERCIAL: {
    papel: 'COMERCIAL',
    rotulo: 'Comercial',
    area: 'COMERCIAL',
    nivel: 'MEMBRO',
  },
  LIDER_MARKETING: {
    papel: 'LIDER_MARKETING',
    rotulo: 'Líder Marketing',
    area: 'MARKETING',
    nivel: 'LIDER',
  },
  MARKETING: {
    papel: 'MARKETING',
    rotulo: 'Marketing',
    area: 'MARKETING',
    nivel: 'MEMBRO',
  },
  LIDER_CS: {
    papel: 'LIDER_CS',
    rotulo: 'Líder CS',
    area: 'CS',
    nivel: 'LIDER',
  },
  CS: { papel: 'CS', rotulo: 'CS', area: 'CS', nivel: 'MEMBRO' },
};

export const ROTULO_DA_AREA: Readonly<Record<Area, string>> = {
  MARKETING: 'Marketing',
  COMERCIAL: 'Comercial',
  CS: 'Customer Success',
};

/** Todos os papéis, na ordem do enum. */
export const TODOS_OS_PAPEIS: readonly Papel[] = Object.values(Papel);

/** Todas as áreas, na ordem do enum. */
export const TODAS_AS_AREAS: readonly Area[] = Object.values(Area);

const LIDER_DA_AREA: Readonly<Record<Area, Papel>> = {
  MARKETING: 'LIDER_MARKETING',
  COMERCIAL: 'LIDER_COMERCIAL',
  CS: 'LIDER_CS',
};

const MEMBRO_DA_AREA: Readonly<Record<Area, Papel>> = {
  MARKETING: 'MARKETING',
  COMERCIAL: 'COMERCIAL',
  CS: 'CS',
};

export function definicaoDoPapel(papel: Papel): DefinicaoPapel {
  return DEFINICOES_DE_PAPEL[papel];
}

/** Área do papel; `null` para Admin e C-level. */
export function areaDoPapel(papel: Papel): Area | null {
  return DEFINICOES_DE_PAPEL[papel].area;
}

export function nivelDoPapel(papel: Papel): NivelPapel {
  return DEFINICOES_DE_PAPEL[papel].nivel;
}

export function rotuloDoPapel(papel: Papel): string {
  return DEFINICOES_DE_PAPEL[papel].rotulo;
}

export function rotuloDaArea(area: Area): string {
  return ROTULO_DA_AREA[area];
}

export function ehAdmin(papel: Papel): boolean {
  return papel === 'ADMIN';
}

export function ehCLevel(papel: Papel): boolean {
  return papel === 'C_LEVEL';
}

/** Admin ou C-level: veem tudo (R1.5, R5.9, R6.4). */
export function ehDiretoria(papel: Papel): boolean {
  return papel === 'ADMIN' || papel === 'C_LEVEL';
}

/** Líder de área (Comercial, Marketing ou CS). */
export function ehLider(papel: Papel): boolean {
  return DEFINICOES_DE_PAPEL[papel].nivel === 'LIDER';
}

/** Membro de área (Comercial, Marketing ou CS). */
export function ehMembro(papel: Papel): boolean {
  return DEFINICOES_DE_PAPEL[papel].nivel === 'MEMBRO';
}

/** Papel do líder da área (`COMERCIAL` → `LIDER_COMERCIAL`). */
export function liderDaArea(area: Area): Papel {
  return LIDER_DA_AREA[area];
}

/** Papel do membro da área (`COMERCIAL` → `COMERCIAL`). */
export function membroDaArea(area: Area): Papel {
  return MEMBRO_DA_AREA[area];
}

/** Os dois papéis da área: `[líder, membro]`. */
export function papeisDaArea(area: Area): readonly [Papel, Papel] {
  return [LIDER_DA_AREA[area], MEMBRO_DA_AREA[area]];
}

/**
 * Papel que o líder de alguém com `papel` precisa ter (R1.2): membro → líder da
 * mesma área; líder → C-level; Admin e C-level → `null` (não têm líder).
 */
export function liderEsperado(papel: Papel): Papel | null {
  const { area, nivel } = DEFINICOES_DE_PAPEL[papel];
  if (nivel === 'MEMBRO' && area) {
    return LIDER_DA_AREA[area];
  }
  if (nivel === 'LIDER') {
    return 'C_LEVEL';
  }
  return null;
}

/** `papelDoLider` pode liderar `papelDoLiderado`? (R1.2; a checagem de "ativo" fica com quem chama). */
export function podeLiderar(
  papelDoLider: Papel,
  papelDoLiderado: Papel,
): boolean {
  return liderEsperado(papelDoLiderado) === papelDoLider;
}
