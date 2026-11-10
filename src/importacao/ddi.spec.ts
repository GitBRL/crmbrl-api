import { normalizarTelefoneComDdi } from './ddi';

describe('DDI padrão (R16.13)', () => {
  it('R16.13 — com 55 vale a regra brasileira de hoje', () => {
    expect(normalizarTelefoneComDdi('(11) 98765-4321')).toEqual({
      valido: true,
      telefone: '5511987654321',
    });
    expect(normalizarTelefoneComDdi('(20) 98765-4321', '55').valido).toBe(
      false,
    );
  });

  it('R16.13 — outro DDI entra no telefone sem + ou 00, sem duplicar quando já vem junto', () => {
    expect(normalizarTelefoneComDdi('912 345 678', '351')).toEqual({
      valido: true,
      telefone: '351912345678',
    });
    expect(normalizarTelefoneComDdi('351912345678', '351')).toEqual({
      valido: true,
      telefone: '351912345678',
    });
    expect(normalizarTelefoneComDdi('(415) 555-2671', '1')).toEqual({
      valido: true,
      telefone: '14155552671',
    });
  });

  it('R16.13 — telefone com + ou 00 mantém o próprio código de país', () => {
    expect(normalizarTelefoneComDdi('+55 11 98765-4321', '351')).toEqual({
      valido: true,
      telefone: '5511987654321',
    });
    expect(normalizarTelefoneComDdi('0035 1912345678', '1').valido).toBe(true);
  });

  it('R16.13 — vazio é inválido', () => {
    expect(normalizarTelefoneComDdi('abc', '351').valido).toBe(false);
  });
});
