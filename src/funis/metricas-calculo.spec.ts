import {
  contarAlcance,
  mediaInteira,
  proporcao,
  segundosEmDias,
} from './metricas-calculo';

describe('cálculo das métricas (R5.10)', () => {
  const sequencia = ['novo', 'proposta', 'negociacao', 'ganho'];

  it('conta quem alcançou cada degrau, contando os degraus pulados', () => {
    const alcance = contarAlcance(sequencia, [
      new Set(['novo']),
      new Set(['novo', 'proposta']),
      new Set(['novo', 'negociacao', 'ganho']),
      new Set(['ganho']),
    ]);
    expect(alcance).toEqual([4, 3, 2, 2]);
  });

  it('voltar atrás não desfaz o alcance; etapa fora da sequência (perda) não conta', () => {
    const alcance = contarAlcance(sequencia, [
      new Set(['novo', 'negociacao', 'proposta']),
      new Set(['perdido']),
    ]);
    expect(alcance).toEqual([1, 1, 1, 0]);
  });

  it('proporção com 4 casas e nula sem denominador', () => {
    expect(proporcao(2, 3)).toBe(0.6667);
    expect(proporcao(0, 5)).toBe(0);
    expect(proporcao(1, 0)).toBeNull();
  });

  it('médias e conversão para dias', () => {
    expect(mediaInteira([10, 11])).toBe(11);
    expect(mediaInteira([])).toBeNull();
    expect(segundosEmDias(86_400 * 1.5)).toBe(1.5);
    expect(segundosEmDias(null)).toBeNull();
  });
});
