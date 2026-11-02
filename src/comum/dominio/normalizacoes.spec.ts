import { Prisma } from '../../generated/prisma/client';
import {
  ehCnpjValido,
  formatarCnpj,
  normalizarCnpj,
  normalizarCnpjOpcional,
} from './cnpj';
import { formatarValor, lerValor } from './dinheiro';
import {
  ehEmailValido,
  normalizarEmail,
  normalizarEmailOpcional,
} from './email';
import { juntarEtiquetas, normalizarEtiquetas } from './etiquetas';
import { normalizarTelefone, normalizarTelefoneOpcional } from './telefone';
import { normalizarUtm } from './utm';

describe('e-mail (R1.1, R4.1)', () => {
  it('apara e põe em minúsculas', () => {
    expect(normalizarEmail('  Fulano.Silva@BRL.com.BR ')).toBe(
      'fulano.silva@brl.com.br',
    );
  });

  it('valida o formato', () => {
    for (const valido of ['a@b.co', 'nome.sobrenome+tag@empresa.com.br']) {
      expect(ehEmailValido(valido)).toBe(true);
    }
    for (const invalido of [
      'sem-arroba',
      'a@b',
      'a b@c.com',
      'a@@b.com',
      'a..b@c.com',
      `${'x'.repeat(250)}@b.com`,
    ]) {
      expect(ehEmailValido(invalido)).toBe(false);
    }
  });

  it('versão opcional: vazio vira null e inválido lança', () => {
    expect(normalizarEmailOpcional('  ')).toBeNull();
    expect(normalizarEmailOpcional(undefined)).toBeNull();
    expect(normalizarEmailOpcional('A@B.com')).toBe('a@b.com');
    expect(() => normalizarEmailOpcional('inválido')).toThrow(TypeError);
  });
});

describe('telefone (R4.1)', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['11 98765 4321', '5511987654321'],
    ['+55 (11) 98765-4321', '5511987654321'],
    ['5511987654321', '5511987654321'],
    ['011 98765-4321', '5511987654321'],
    ['(21) 3333-4444', '552133334444'],
    ['0055 21 3333 4444', '552133334444'],
    ['+1 (415) 555-2671', '14155552671'],
    ['+351 912 345 678', '351912345678'],
  ])('normaliza %s para %s (E.164 só com dígitos)', (entrada, esperado) => {
    expect(normalizarTelefone(entrada)).toEqual({
      valido: true,
      telefone: esperado,
    });
  });

  it('números brasileiros de 10 ou 11 dígitos ganham o 55 e têm o DDD validado', () => {
    expect(normalizarTelefone('(20) 98765-4321')).toEqual({
      valido: false,
      motivo: 'DDD 20 não existe.',
    });
    expect(normalizarTelefone('+55 23 98765-4321')).toEqual({
      valido: false,
      motivo: 'DDD 23 não existe.',
    });
    expect(normalizarTelefone('(11) 88765-4321')).toMatchObject({
      valido: false,
    });
  });

  it('recusa vazio, curto ou longo demais', () => {
    expect(normalizarTelefone('')).toMatchObject({ valido: false });
    expect(normalizarTelefone('123')).toMatchObject({ valido: false });
    expect(normalizarTelefone('+1234567890123456')).toMatchObject({
      valido: false,
    });
  });

  it('versão opcional: vazio vira null e inválido lança com o motivo', () => {
    expect(normalizarTelefoneOpcional(null)).toBeNull();
    expect(normalizarTelefoneOpcional('11 3333-4444')).toBe('551133334444');
    expect(() => normalizarTelefoneOpcional('(20) 3333-4444')).toThrow(
      'DDD 20 não existe.',
    );
  });
});

describe('CNPJ (R4.4)', () => {
  it('valida os dígitos verificadores do CNPJ numérico', () => {
    expect(ehCnpjValido('11.222.333/0001-81')).toBe(true);
    expect(ehCnpjValido('11222333000181')).toBe(true);
    expect(ehCnpjValido('11.222.333/0001-82')).toBe(false);
    expect(ehCnpjValido('11111111111111')).toBe(false);
    expect(ehCnpjValido('1122233300018')).toBe(false);
  });

  it('aceita o CNPJ alfanumérico de 2026, com o mesmo módulo 11 (letra = código ASCII − 48)', () => {
    expect(ehCnpjValido('12.ABC.345/01DE-35')).toBe(true);
    expect(ehCnpjValido('12abc34501de35')).toBe(true);
    expect(ehCnpjValido('12.ABC.345/01DE-36')).toBe(false);
    // Os dígitos verificadores continuam numéricos.
    expect(ehCnpjValido('12ABC34501DE3A')).toBe(false);
  });

  it('normaliza (sem pontuação, maiúsculas) e formata', () => {
    expect(normalizarCnpj(' 12.abc.345/01de-35 ')).toBe('12ABC34501DE35');
    expect(formatarCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(normalizarCnpjOpcional('')).toBeNull();
    expect(normalizarCnpjOpcional('11.222.333/0001-81')).toBe('11222333000181');
    expect(() => normalizarCnpjOpcional('00.000.000/0000-01')).toThrow(
      TypeError,
    );
  });
});

describe('etiquetas (R4.7)', () => {
  it('apara, colapsa espaços e tira duplicatas sem diferenciar maiúsculas', () => {
    expect(
      normalizarEtiquetas([
        ' VIP ',
        'vip',
        'Lead   quente',
        '',
        42,
        'lead quente',
      ]),
    ).toEqual(['VIP', 'Lead quente']);
  });

  it('corta etiquetas longas e limita a quantidade', () => {
    expect(normalizarEtiquetas(['x'.repeat(80)])).toEqual(['x'.repeat(50)]);
    const muitas = Array.from({ length: 70 }, (_valor, indice) => `e${indice}`);
    expect(normalizarEtiquetas(muitas)).toHaveLength(50);
  });

  it('junta etiquetas novas às existentes', () => {
    expect(juntarEtiquetas(['cliente'], ['Cliente', 'webhook'])).toEqual([
      'cliente',
      'webhook',
    ]);
    expect(normalizarEtiquetas(null)).toEqual([]);
  });
});

describe('UTM (R4.3)', () => {
  it('aceita as chaves com ou sem utm_, apara e descarta o resto', () => {
    expect(
      normalizarUtm({
        utm_source: ' google ',
        medium: 'cpc',
        utm_campaign: '',
        outra: 'x',
        term: 3,
      }),
    ).toEqual({ source: 'google', medium: 'cpc', term: '3' });
  });

  it('devolve null quando não sobra nada', () => {
    expect(normalizarUtm({ outra: 'x' })).toBeNull();
    expect(normalizarUtm(undefined)).toBeNull();
  });
});

describe('valores em reais', () => {
  it('formata com duas casas', () => {
    expect(formatarValor(new Prisma.Decimal('1500'))).toBe('1500.00');
    expect(formatarValor('10.5')).toBe('10.50');
    expect(formatarValor(null)).toBeNull();
  });

  it('lê texto decimal e recusa outros formatos', () => {
    expect(lerValor('1500.5').toFixed(2)).toBe('1500.50');
    for (const invalido of ['-1', '1,50', '1.234', '1e3', '']) {
      expect(() => lerValor(invalido)).toThrow(TypeError);
    }
  });
});
