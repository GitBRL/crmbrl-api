import {
  CONFIGURACAO_PADRAO,
  dataDoDia,
  diaEmSaoPaulo,
  diasEntre,
  duracaoDoDigitando,
  esperaRestante,
  inicioDoProximoDia,
  lerConfiguracao,
  limiteDoDia,
  MINIMO_DO_AQUECIMENTO,
  situacaoDoAquecimento,
  sortearIntervalo,
} from './protecoes';

describe('proteções anti-banimento (R13)', () => {
  it('lê a configuração com padrões e dentro das faixas', () => {
    expect(lerConfiguracao(null)).toEqual(CONFIGURACAO_PADRAO);
    expect(lerConfiguracao([])).toEqual(CONFIGURACAO_PADRAO);
    expect(
      lerConfiguracao({
        digitando: false,
        digitandoMaximoSegundos: 99,
        pausarAposFalhasSeguidas: -3,
        verificarNumero: 'sim',
        limitarRespostas: true,
        outraCoisa: 1,
      }),
    ).toEqual({
      ...CONFIGURACAO_PADRAO,
      digitando: false,
      digitandoMaximoSegundos: 30,
      pausarAposFalhasSeguidas: 0,
      limitarRespostas: true,
    });
  });

  it('dia no fuso de São Paulo e início do dia seguinte', () => {
    // 23/10 às 23h30 em São Paulo = 24/10 02h30 UTC.
    const noite = new Date('2026-10-24T02:30:00.000Z');
    expect(diaEmSaoPaulo(noite)).toBe('2026-10-23');
    expect(dataDoDia('2026-10-23').toISOString()).toBe(
      '2026-10-23T00:00:00.000Z',
    );
    expect(inicioDoProximoDia(noite).toISOString()).toBe(
      '2026-10-24T03:00:00.000Z',
    );
    expect(diaEmSaoPaulo(inicioDoProximoDia(noite))).toBe('2026-10-24');
    expect(
      diasEntre(
        new Date('2026-10-20T12:00:00.000Z'),
        new Date('2026-10-23T12:00:00.000Z'),
      ),
    ).toBe(3);
  });

  describe('aquecimento', () => {
    const inicio = new Date('2026-10-01T15:00:00.000Z');
    const numero = {
      limiteDiario: 1000,
      aquecimentoInicioEm: inicio,
      aquecimentoDias: 14,
    };

    it('sem primeira conexão ou sem dias, vale o limite cheio', () => {
      const agora = new Date('2026-10-02T15:00:00.000Z');
      expect(limiteDoDia({ ...numero, aquecimentoInicioEm: null }, agora)).toBe(
        1000,
      );
      expect(limiteDoDia({ ...numero, aquecimentoDias: 0 }, agora)).toBe(1000);
      expect(
        situacaoDoAquecimento({ ...numero, aquecimentoInicioEm: null }, agora),
      ).toEqual({ ativo: false, dia: null, dias: 14, terminaEm: null });
    });

    it('rampa linear até o limite cheio, nunca abaixo do mínimo', () => {
      expect(limiteDoDia(numero, inicio)).toBe(72); // dia 1: ceil(1000/14)
      expect(limiteDoDia(numero, new Date('2026-10-07T15:00:00.000Z'))).toBe(
        500,
      ); // dia 7
      expect(limiteDoDia(numero, new Date('2026-10-15T15:00:00.000Z'))).toBe(
        1000,
      ); // passou dos 14 dias
      expect(limiteDoDia({ ...numero, limiteDiario: 100 }, inicio)).toBe(
        MINIMO_DO_AQUECIMENTO,
      );
      expect(limiteDoDia({ ...numero, limiteDiario: 10 }, inicio)).toBe(10);
      expect(
        situacaoDoAquecimento(numero, new Date('2026-10-03T15:00:00.000Z')),
      ).toEqual({ ativo: true, dia: 3, dias: 14, terminaEm: '2026-10-15' });
    });
  });

  it('ritmo: sorteio entre o mínimo e o máximo e espera restante', () => {
    expect(sortearIntervalo(2, 6, () => 0)).toBe(2_000);
    expect(sortearIntervalo(2, 6, () => 1)).toBe(6_000);
    expect(sortearIntervalo(2, 6, () => 0.5)).toBe(4_000);
    expect(sortearIntervalo(6, 2, () => 0.5)).toBe(2_000);
    expect(esperaRestante(undefined, 5_000, 10_000)).toBe(0);
    expect(esperaRestante(8_000, 5_000, 10_000)).toBe(3_000);
    expect(esperaRestante(1_000, 5_000, 10_000)).toBe(0);
  });

  it('"digitando…" proporcional ao texto, entre 0,8 s e o teto', () => {
    expect(duracaoDoDigitando('', 4)).toBe(1_000);
    expect(duracaoDoDigitando(null, 4)).toBe(1_000);
    expect(duracaoDoDigitando('a'.repeat(50), 4)).toBe(3_000);
    expect(duracaoDoDigitando('a'.repeat(500), 4)).toBe(4_000);
    expect(duracaoDoDigitando('oi', 0)).toBe(0);
  });
});
