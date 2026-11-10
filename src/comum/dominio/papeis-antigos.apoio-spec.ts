/**
 * Apoio dos testes (fora do build: o nome termina em `spec.ts`, mas não é um
 * teste). Os papéis antigos, um por setor de base, viram o papel novo + o setor
 * — `'LIDER_COMERCIAL'` → `{ papel: 'LIDER', area: 'COMERCIAL' }`, `'CS'` →
 * `{ papel: 'MEMBRO', area: 'CS' }` —, para os casos de teste continuarem
 * curtos. A API não aceita estes valores.
 */
import type { Papel } from '../../generated/prisma/client';
import type { ComPapel } from './papeis';
import type { Area } from './setores';

export type PapelAntigo =
  | 'LIDER_COMERCIAL'
  | 'COMERCIAL'
  | 'LIDER_MARKETING'
  | 'MARKETING'
  | 'LIDER_CS'
  | 'CS';

export type PapelDeTeste = Papel | PapelAntigo;

/** Os oito papéis da tabela antiga, na ordem antiga. */
export const PAPEIS_ANTIGOS: readonly PapelDeTeste[] = [
  'ADMIN',
  'C_LEVEL',
  'LIDER_COMERCIAL',
  'COMERCIAL',
  'LIDER_MARKETING',
  'MARKETING',
  'LIDER_CS',
  'CS',
];

/** Papel e setor de um papel de teste (o atalho antigo, ou `area` para LIDER/MEMBRO). */
export function papelESetor(papel: PapelDeTeste, area?: Area | null): ComPapel {
  if (papel === 'ADMIN' || papel === 'C_LEVEL') {
    return { papel, area: null };
  }
  if (papel === 'LIDER' || papel === 'MEMBRO') {
    if (!area) {
      throw new Error(`O papel ${papel} precisa de um setor (area) no teste.`);
    }
    return { papel, area };
  }
  return papel.startsWith('LIDER_')
    ? { papel: 'LIDER', area: papel.slice('LIDER_'.length) }
    : { papel: 'MEMBRO', area: papel };
}

/** Uma pessoa de teste: `pessoa('LIDER_CS', { id: 'u1' })`. */
export function pessoa<T extends object = { id: string }>(
  papel: PapelDeTeste,
  extra: T = { id: 'u1' } as T,
): ComPapel & T {
  return { ...extra, ...papelESetor(papel) };
}
