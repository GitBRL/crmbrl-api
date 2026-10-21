import type { TransformFnParams } from 'class-transformer';
import {
  apararOuNulo,
  ehDataHoraComFuso,
  lerDataHora,
  paraBooleano,
  paraLista,
} from './transformacoes';

const comValor = (value: unknown) => ({ value }) as TransformFnParams;

describe('transformações dos DTOs de atividades', () => {
  it('data e hora exigem fuso explícito e uma data que existe', () => {
    expect(ehDataHoraComFuso('2026-10-20T14:00:00-03:00')).toBe(true);
    expect(ehDataHoraComFuso('2026-10-20T17:00:00.000Z')).toBe(true);
    expect(ehDataHoraComFuso('2026-10-20T14:00-03:00')).toBe(true);
    expect(ehDataHoraComFuso('2026-10-20T14:00:00')).toBe(false);
    expect(ehDataHoraComFuso('2026-10-20')).toBe(false);
    expect(ehDataHoraComFuso('2026-02-30T10:00:00Z')).toBe(false);
    expect(ehDataHoraComFuso('ontem')).toBe(false);
    expect(ehDataHoraComFuso(1_700_000_000_000)).toBe(false);
  });

  it('lerDataHora mantém undefined (não informado) e null (limpar)', () => {
    expect(lerDataHora(undefined)).toBeUndefined();
    expect(lerDataHora(null)).toBeNull();
    expect(lerDataHora('2026-10-20T14:00:00-03:00')?.toISOString()).toBe(
      '2026-10-20T17:00:00.000Z',
    );
  });

  it('listas na query string: repetidas ou separadas por vírgula', () => {
    expect(paraLista(comValor('TAREFA'))).toEqual(['TAREFA']);
    expect(paraLista(comValor('TAREFA, LIGACAO'))).toEqual([
      'TAREFA',
      'LIGACAO',
    ]);
    expect(paraLista(comValor(['TAREFA', 'REUNIAO,EMAIL']))).toEqual([
      'TAREFA',
      'REUNIAO',
      'EMAIL',
    ]);
    expect(paraLista(comValor(''))).toBeUndefined();
    expect(paraLista(comValor(undefined))).toBeUndefined();
  });

  it('booleanos e textos opcionais', () => {
    expect(paraBooleano(comValor('true'))).toBe(true);
    expect(paraBooleano(comValor('0'))).toBe(false);
    expect(paraBooleano(comValor('talvez'))).toBe('talvez');
    expect(apararOuNulo(comValor('  texto  '))).toBe('texto');
    expect(apararOuNulo(comValor('   '))).toBeNull();
  });
});
