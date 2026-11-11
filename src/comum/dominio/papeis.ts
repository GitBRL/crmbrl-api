/**
 * Papéis, setores e hierarquia (R1, tabela da seção 1 das regras).
 *
 * O papel é só o nível; o setor da pessoa fica em `usuarios.area` (obrigatório
 * para Líder e Membro, nulo para Admin e C-level — um CHECK no banco garante).
 *
 * | Papel   | Setor       | Nível         | Líder obrigatório                 |
 * | ------- | ----------- | ------------- | --------------------------------- |
 * | ADMIN   | —           | ADMINISTRADOR | não tem                           |
 * | C_LEVEL | —           | DIRETORIA     | não tem                           |
 * | LIDER   | obrigatório | LIDER         | um C_LEVEL ativo                  |
 * | MEMBRO  | obrigatório | MEMBRO        | um LIDER ativo do mesmo setor     |
 */
import { Papel } from '../../generated/prisma/client';
import { type Area, nomeDoSetor } from './setores';

export type NivelPapel = 'ADMINISTRADOR' | 'DIRETORIA' | 'LIDER' | 'MEMBRO';

/** O papel e o setor de uma pessoa: o mínimo das regras de acesso (cabe um `UsuarioAutenticado`). */
export interface ComPapel {
  readonly papel: Papel;
  /** Setor (chave); `null` para Admin e C-level. */
  readonly area: Area | null;
}

export interface DefinicaoPapel {
  readonly papel: Papel;
  /** Rótulo do nível ("Líder", "Membro"); o rótulo completo leva o setor (`rotuloDoPapel`). */
  readonly rotulo: string;
  readonly nivel: NivelPapel;
  /** Líder e Membro têm setor; Admin e C-level não. */
  readonly temSetor: boolean;
}

export const DEFINICOES_DE_PAPEL: Readonly<Record<Papel, DefinicaoPapel>> = {
  ADMIN: {
    papel: 'ADMIN',
    rotulo: 'Admin',
    nivel: 'ADMINISTRADOR',
    temSetor: false,
  },
  C_LEVEL: {
    papel: 'C_LEVEL',
    rotulo: 'C-level',
    nivel: 'DIRETORIA',
    temSetor: false,
  },
  LIDER: { papel: 'LIDER', rotulo: 'Líder', nivel: 'LIDER', temSetor: true },
  MEMBRO: {
    papel: 'MEMBRO',
    rotulo: 'Membro',
    nivel: 'MEMBRO',
    temSetor: true,
  },
};

/** Todos os papéis, na ordem do enum. */
export const TODOS_OS_PAPEIS: readonly Papel[] = Object.values(Papel);

export function definicaoDoPapel(papel: Papel): DefinicaoPapel {
  return DEFINICOES_DE_PAPEL[papel];
}

export function nivelDoPapel(papel: Papel): NivelPapel {
  return DEFINICOES_DE_PAPEL[papel].nivel;
}

/** Líder e Membro têm setor; Admin e C-level não (R1.2). */
export function papelTemSetor(papel: Papel): boolean {
  return DEFINICOES_DE_PAPEL[papel].temSetor;
}

/**
 * Rótulo do papel com o setor (R1): "Admin", "C-level", "Líder Comercial",
 * "Comercial" (o membro leva só o nome do setor).
 */
export function rotuloDoPapel(papel: Papel, area?: Area | null): string {
  return rotuloComNomeDoSetor(papel, area ? nomeDoSetor(area) : null);
}

/** `rotuloDoPapel` com o nome do setor já em mãos (ex.: lido do banco junto com a pessoa). */
export function rotuloComNomeDoSetor(
  papel: Papel,
  nomeSetor: string | null,
): string {
  if (papel === 'LIDER') {
    return nomeSetor ? `Líder ${nomeSetor}` : 'Líder';
  }
  if (papel === 'MEMBRO') {
    return nomeSetor ?? 'Membro';
  }
  return DEFINICOES_DE_PAPEL[papel].rotulo;
}

/** Rótulo do papel de uma pessoa (`rotuloDoPapel(pessoa.papel, pessoa.area)`). */
export function rotuloDaPessoa(pessoa: ComPapel): string {
  return rotuloDoPapel(pessoa.papel, pessoa.area);
}

/** Nome do setor, para mensagens ("Comercial", "Customer Success"…). */
export function rotuloDaArea(area: Area): string {
  return nomeDoSetor(area);
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

/** Líder de um setor. */
export function ehLider(papel: Papel): boolean {
  return papel === 'LIDER';
}

/** Membro de um setor. */
export function ehMembro(papel: Papel): boolean {
  return papel === 'MEMBRO';
}

/** A pessoa é do setor (líder ou membro)? */
export function ehDoSetor(pessoa: ComPapel, area: Area): boolean {
  return papelTemSetor(pessoa.papel) && pessoa.area === area;
}

/** A pessoa é líder do setor? */
export function ehLiderDoSetor(pessoa: ComPapel, area: Area): boolean {
  return pessoa.papel === 'LIDER' && pessoa.area === area;
}

/** A pessoa é membro do setor? */
export function ehMembroDoSetor(pessoa: ComPapel, area: Area): boolean {
  return pessoa.papel === 'MEMBRO' && pessoa.area === area;
}

/** Setor da pessoa, se for Líder ou Membro (`null` para Admin e C-level). */
export function setorDaPessoa(pessoa: ComPapel): Area | null {
  return papelTemSetor(pessoa.papel) ? pessoa.area : null;
}

/** O papel e o setor que o líder de alguém precisa ter (R1.2). */
export interface LiderEsperado {
  readonly papel: Papel;
  /** Setor do líder: o do membro; `null` quando o líder é um C-level. */
  readonly area: Area | null;
}

/**
 * Quem pode liderar a pessoa (R1.2): membro → líder do mesmo setor; líder →
 * C-level; Admin e C-level → `null` (não têm líder).
 */
export function liderEsperado(pessoa: ComPapel): LiderEsperado | null {
  if (pessoa.papel === 'MEMBRO' && pessoa.area) {
    return { papel: 'LIDER', area: pessoa.area };
  }
  if (pessoa.papel === 'LIDER') {
    return { papel: 'C_LEVEL', area: null };
  }
  return null;
}

/** Rótulo de quem pode liderar ("Líder Comercial", "C-level"). */
export function rotuloDoLiderEsperado(esperado: LiderEsperado): string {
  return rotuloDoPapel(esperado.papel, esperado.area);
}

/** `lider` pode liderar `liderado`? (R1.2; a checagem de "ativo" fica com quem chama). */
export function podeLiderar(lider: ComPapel, liderado: ComPapel): boolean {
  const esperado = liderEsperado(liderado);
  return (
    esperado !== null &&
    lider.papel === esperado.papel &&
    (esperado.area === null || lider.area === esperado.area)
  );
}
