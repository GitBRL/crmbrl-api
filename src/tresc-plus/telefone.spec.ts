import {
  identifierDoDiscador,
  lerIdentifier,
  outraFormaDoCelular,
  telefoneDoTresc,
  telefoneParaTresc,
  variantesDoTelefone,
} from './telefone';

describe('telefone e identifier do 3C+ (R34.3, R34.6)', () => {
  it('R34.6 — o número do discador é nacional, sem o 55, com 7 a 15 dígitos', () => {
    expect(telefoneParaTresc('5511987654321')).toBe('11987654321');
    expect(telefoneParaTresc('(11) 98765-4321')).toBe('11987654321');
    expect(telefoneParaTresc('551133334444')).toBe('1133334444');
    expect(telefoneParaTresc('+1 202 555 0143')).toBe('12025550143');
    expect(telefoneParaTresc('123')).toBeNull();
    expect(telefoneParaTresc(null)).toBeNull();
    expect(telefoneParaTresc('1'.repeat(16))).toBeNull();
  });

  it('R34.3 — o número do 3C+ vira o E.164 do CRM', () => {
    expect(telefoneDoTresc('11987654321')).toBe('5511987654321');
    expect(telefoneDoTresc(11987654321)).toBe('5511987654321');
    expect(telefoneDoTresc('5511987654321')).toBe('5511987654321');
    expect(telefoneDoTresc('')).toBeNull();
    expect(telefoneDoTresc(undefined)).toBeNull();
  });

  it('R34.7 — casa o celular com e sem o nono dígito', () => {
    expect(outraFormaDoCelular('5511988887777')).toBe('551188887777');
    expect(outraFormaDoCelular('551188887777')).toBe('5511988887777');
    expect(outraFormaDoCelular('551133334444')).toBeNull();
    expect(variantesDoTelefone('11988887777')).toEqual([
      '5511988887777',
      '551188887777',
    ]);
    expect(variantesDoTelefone('abc')).toEqual([]);
  });

  it('R34.6 — o identifier é o id do negócio/contato e só UUID volta', () => {
    const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
    expect(identifierDoDiscador(id)).toBe(id.toLowerCase());
    expect(lerIdentifier(id)).toBe(id.toLowerCase());
    expect(lerIdentifier('28394')).toBeNull();
    expect(lerIdentifier(42)).toBeNull();
  });
});
