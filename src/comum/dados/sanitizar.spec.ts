import { Prisma } from '../../generated/prisma/client';
import {
  calcularAlteracoes,
  sanitizarParaJson,
  VALOR_OMITIDO,
} from './sanitizar';

describe('sanitizarParaJson (R3.1: nunca senhas, tokens ou segredos)', () => {
  it('omite textos e estruturas em campos sensíveis, em qualquer profundidade', () => {
    expect(
      sanitizarParaJson({
        nome: 'Ana',
        senha: '123',
        novaSenha: '456',
        senhaHash: 'scrypt$...',
        tokenHash: 'abc',
        segredoCifrado: 'v1.x',
        cabecalhos: { Authorization: 'Bearer x', 'X-Outro': 'ok' },
        aninhado: [{ token: 't' }],
      }),
    ).toEqual({
      nome: 'Ana',
      senha: VALOR_OMITIDO,
      novaSenha: VALOR_OMITIDO,
      senhaHash: VALOR_OMITIDO,
      tokenHash: VALOR_OMITIDO,
      segredoCifrado: VALOR_OMITIDO,
      cabecalhos: { Authorization: VALOR_OMITIDO, 'X-Outro': 'ok' },
      aninhado: [{ token: VALOR_OMITIDO }],
    });
  });

  it('mantém booleanos, números e datas de campos que só mencionam senha', () => {
    expect(
      sanitizarParaJson({
        deveTrocarSenha: true,
        senhaAlteradaEm: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toEqual({
      deveTrocarSenha: true,
      senhaAlteradaEm: '2026-01-01T00:00:00.000Z',
    });
  });

  it('converte Date, Decimal, bigint, Map e Set; descarta funções e undefined', () => {
    expect(
      sanitizarParaJson({
        quando: new Date('2026-10-20T12:00:00Z'),
        valor: new Prisma.Decimal('1500.5'),
        id: 10n,
        mapa: new Map([['a', 1]]),
        conjunto: new Set(['x']),
        funcao: () => 1,
        indefinido: undefined,
        nulo: null,
        infinito: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      quando: '2026-10-20T12:00:00.000Z',
      valor: '1500.50',
      id: '10',
      mapa: { a: 1 },
      conjunto: ['x'],
      nulo: null,
      infinito: null,
    });
  });

  it('corta referências circulares e textos enormes', () => {
    const circular: Record<string, unknown> = { nome: 'loop' };
    circular.eu = circular;
    expect(sanitizarParaJson(circular)).toEqual({
      nome: 'loop',
      eu: '[circular]',
    });
    const texto = sanitizarParaJson('x'.repeat(20_000)) as string;
    expect(texto.length).toBe(10_001);
  });
});

describe('calcularAlteracoes (antes/depois da auditoria)', () => {
  it('lista só os campos que mudaram, sem as datas de controle', () => {
    expect(
      calcularAlteracoes(
        {
          titulo: 'A',
          valor: new Prisma.Decimal('10'),
          etapaId: 'e1',
          atualizadoEm: new Date(1),
        },
        {
          titulo: 'B',
          valor: new Prisma.Decimal('10.00'),
          etapaId: 'e1',
          atualizadoEm: new Date(2),
        },
      ),
    ).toEqual({ titulo: { antes: 'A', depois: 'B' } });
  });

  it('compara só os campos pedidos e nunca mostra o valor de campos sensíveis', () => {
    expect(
      calcularAlteracoes(
        { nome: 'A', senhaHash: 'x', email: 'a@x.com' },
        { nome: 'B', senhaHash: 'y', email: 'b@x.com' },
        ['nome', 'senhaHash'],
      ),
    ).toEqual({
      nome: { antes: 'A', depois: 'B' },
      senhaHash: { antes: VALOR_OMITIDO, depois: VALOR_OMITIDO },
    });
  });

  it('trata ausência e null como iguais', () => {
    expect(calcularAlteracoes({ telefone: null }, {}, ['telefone'])).toEqual(
      {},
    );
    expect(calcularAlteracoes(null, { nome: 'Novo' })).toEqual({
      nome: { antes: null, depois: 'Novo' },
    });
  });
});
