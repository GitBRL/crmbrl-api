import { sugerirMapeamento, validarMapeamento } from '../importacao/campos';
import {
  lerDataDaPlanilha,
  lerFormaDePagamento,
  lerSituacaoDaPlanilha,
  lerValorDaPlanilha,
} from './campos-de-parcela';

describe('Financeiro — importação de parcelas (R22.5)', () => {
  it('lê valores brasileiros e americanos', () => {
    expect(lerValorDaPlanilha('R$ 1.234,56')).toBe('1234.56');
    expect(lerValorDaPlanilha('1234.56')).toBe('1234.56');
    expect(lerValorDaPlanilha('1.234')).toBe('1234.00');
    expect(lerValorDaPlanilha('299,9')).toBe('299.90');
    expect(lerValorDaPlanilha('abc')).toBeNull();
    expect(lerValorDaPlanilha('-10')).toBeNull();
  });

  it('lê datas dd/mm/aaaa e aaaa-mm-dd, e recusa as inexistentes', () => {
    expect(lerDataDaPlanilha('05/11/2026')).toBe('2026-11-05');
    expect(lerDataDaPlanilha('2026-11-05')).toBe('2026-11-05');
    expect(lerDataDaPlanilha('2026-11-05T10:00:00')).toBe('2026-11-05');
    expect(lerDataDaPlanilha('31/02/2026')).toBeNull();
    expect(lerDataDaPlanilha('ontem')).toBeNull();
  });

  it('reconhece a situação e a forma de pagamento', () => {
    expect(lerSituacaoDaPlanilha('Pago')).toBe('PAGO');
    expect(lerSituacaoDaPlanilha('QUITADO')).toBe('PAGO');
    expect(lerSituacaoDaPlanilha('Em aberto')).toBe('ABERTO');
    expect(lerSituacaoDaPlanilha('Cancelada')).toBe('CANCELADO');
    expect(lerSituacaoDaPlanilha('talvez')).toBeNull();
    expect(lerFormaDePagamento('Cartão de crédito')).toBe('CARTAO');
    expect(lerFormaDePagamento('PIX')).toBe('PIX');
  });

  it('sugere o mapeamento pelo nome da coluna e só exige o número do título', () => {
    const colunas = [
      'Número do título',
      'Cliente',
      'Vencimento',
      'Valor',
      'Link do boleto',
      'Situação',
    ];
    const m = sugerirMapeamento('PARCELAS', colunas);
    expect(m).toMatchObject({
      'Número do título': 'numero',
      Cliente: 'nome',
      Vencimento: 'vencimento',
      Valor: 'valor',
      'Link do boleto': 'linkBoleto',
      Situação: 'status',
    });
    expect(validarMapeamento('PARCELAS', colunas, m, true)).toEqual([]);
    expect(
      validarMapeamento('PARCELAS', colunas, { Cliente: 'nome' }, true),
    ).toHaveLength(1);
  });
});
