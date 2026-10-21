import { DadosInvalidosException } from '../../comum/erros/excecoes';
import {
  codificarCursor,
  condicoesDeBusca,
  condicoesDoPeriodo,
  escaparLike,
  LETRAS_ACENTUADAS,
  LETRAS_SEM_ACENTO,
  lerCursor,
  lerPeriodo,
  montarPaginaPorCursor,
  normalizarParaBusca,
  termosDaBusca,
} from './consulta-comum';

describe('consulta-comum', () => {
  describe('cursor', () => {
    it('R3.4 — ida e volta do cursor opaco', () => {
      const cursor = codificarCursor('auditoria', 123n);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cursor).not.toContain('123');
      expect(lerCursor('auditoria', cursor)).toBe(123n);
      expect(lerCursor('logs', codificarCursor('logs', 9n))).toBe(9n);
    });

    it('sem cursor é a primeira página', () => {
      expect(lerCursor('auditoria', undefined)).toBeUndefined();
      expect(lerCursor('auditoria', '')).toBeUndefined();
    });

    it.each([
      ['lixo', 'abc!@#'],
      ['texto qualquer em base64', Buffer.from('oi').toString('base64url')],
      ['cursor de outra lista', codificarCursor('logs', 5n)],
      ['id zero', Buffer.from('auditoria:0').toString('base64url')],
      [
        'id acima do bigint',
        Buffer.from('auditoria:9223372036854775808').toString('base64url'),
      ],
      ['id negativo', Buffer.from('auditoria:-1').toString('base64url')],
    ])('cursor inválido (%s) → 400', (_caso, cursor) => {
      expect(() => lerCursor('auditoria', cursor)).toThrow(
        DadosInvalidosException,
      );
    });

    it('a página seguinte existe só quando veio uma linha a mais', () => {
      const linhas = [{ id: 5n }, { id: 4n }, { id: 3n }];
      const comMais = montarPaginaPorCursor('logs', linhas, 2, ({ id }) =>
        id.toString(),
      );
      expect(comMais.itens).toEqual(['5', '4']);
      expect(lerCursor('logs', comMais.proximoCursor ?? undefined)).toBe(4n);
      const ultima = montarPaginaPorCursor('logs', linhas, 3, ({ id }) =>
        id.toString(),
      );
      expect(ultima).toEqual({ itens: ['5', '4', '3'], proximoCursor: null });
      expect(montarPaginaPorCursor('logs', [], 10, ({ id }) => id)).toEqual({
        itens: [],
        proximoCursor: null,
      });
    });
  });

  describe('período', () => {
    it('de inclusivo e até exclusivo; até antes de de → 400', () => {
      const periodo = lerPeriodo('2026-10-20T03:00:00Z', '2026-10-21');
      expect(periodo.de?.toISOString()).toBe('2026-10-20T03:00:00.000Z');
      expect(periodo.ate?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
      expect(lerPeriodo()).toEqual({ de: undefined, ate: undefined });
      expect(() =>
        lerPeriodo('2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z'),
      ).toThrow(DadosInvalidosException);
      expect(() => lerPeriodo('2026-10-22', '2026-10-21')).toThrow(
        DadosInvalidosException,
      );
    });

    it('vira condições SQL parametrizadas', () => {
      const [inicio, fim] = condicoesDoPeriodo(
        'criado_em',
        lerPeriodo('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'),
      );
      expect(inicio.text).toBe('criado_em >= $1::timestamptz');
      expect(fim.text).toBe('criado_em < $1::timestamptz');
      expect(inicio.values).toEqual([new Date('2026-10-20T00:00:00Z')]);
      expect(condicoesDoPeriodo('criado_em', {})).toEqual([]);
    });
  });

  describe('busca por texto', () => {
    it('a tabela de acentos tem o mesmo tamanho dos dois lados', () => {
      expect(LETRAS_ACENTUADAS).toHaveLength(LETRAS_SEM_ACENTO.length);
    });

    it('normaliza sem acentos e em minúsculas', () => {
      expect(normalizarParaBusca('NEGÓCIO Ação Útil Pão Ñ')).toBe(
        'negocio acao util pao n',
      );
      // Decomposto (NFD) também.
      expect(normalizarParaBusca('Negócio')).toBe('negocio');
    });

    it('separa termos, tira repetidos e considera até 5', () => {
      expect(termosDaBusca(undefined)).toEqual([]);
      expect(termosDaBusca('   ')).toEqual([]);
      expect(termosDaBusca('  Negócio   negocio ACME ')).toEqual([
        'negocio',
        'acme',
      ]);
      expect(termosDaBusca('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('escapa os curingas do LIKE', () => {
      expect(escaparLike('100%_\\x')).toBe('100\\%\\_\\\\x');
    });

    it('cada termo vira uma condição (E), com as colunas em OU', () => {
      const condicoes = condicoesDeBusca(
        ['resumo', 'acao'],
        ['negocio', '50%'],
      );
      expect(condicoes).toHaveLength(2);
      expect(condicoes[0].text).toBe(
        '(lower(translate(resumo, $1, $2)) LIKE $3 OR lower(translate(acao, $4, $5)) LIKE $6)',
      );
      expect(condicoes[0].values).toEqual([
        LETRAS_ACENTUADAS,
        LETRAS_SEM_ACENTO,
        '%negocio%',
        LETRAS_ACENTUADAS,
        LETRAS_SEM_ACENTO,
        '%negocio%',
      ]);
      expect(condicoes[1].values).toContain('%50\\%%');
      expect(condicoesDeBusca(['resumo'], [])).toEqual([]);
    });
  });
});
