import {
  ehPalavraDeSaida,
  esperaDepoisDoEnvio,
  estimarDuracao,
  intervaloEfetivo,
  normalizarPalavra,
  situacaoDaJanela,
} from './ritmo';

const RITMO = {
  intervaloMinimoSegundos: 20,
  intervaloMaximoSegundos: 60,
  loteTamanho: null,
  lotePausaSegundos: null,
};

describe('R17 — ritmo anti-banimento', () => {
  it('R17.4 — o intervalo sorteado fica entre o mínimo e o máximo da campanha', () => {
    const baixo = esperaDepoisDoEnvio(RITMO, 0, null, () => 0);
    const alto = esperaDepoisDoEnvio(RITMO, 0, null, () => 1);
    expect(baixo.esperaMs).toBe(20_000);
    expect(alto.esperaMs).toBe(60_000);
  });

  it('R17.4 — nunca mais rápido do que o número permite (piso do gateway, R13)', () => {
    expect(
      intervaloEfetivo(RITMO, {
        intervaloMinimoSegundos: 30,
        intervaloMaximoSegundos: 90,
      }),
    ).toEqual({ minimo: 30, maximo: 90 });
    const espera = esperaDepoisDoEnvio(
      { ...RITMO, intervaloMinimoSegundos: 1, intervaloMaximoSegundos: 2 },
      0,
      { intervaloMinimoSegundos: 10, intervaloMaximoSegundos: 12 },
      () => 0,
    );
    expect(espera.esperaMs).toBe(10_000);
  });

  it('R17.4 — fecha o lote e faz a pausa do lote', () => {
    const ritmo = { ...RITMO, loteTamanho: 3, lotePausaSegundos: 600 };
    expect(esperaDepoisDoEnvio(ritmo, 1, null, () => 0)).toMatchObject({
      enviadosNoLote: 2,
      fechouLote: false,
    });
    const fechou = esperaDepoisDoEnvio(ritmo, 2, null, () => 0);
    expect(fechou).toMatchObject({
      enviadosNoLote: 0,
      fechouLote: true,
      esperaMs: 600_000,
    });
    expect(
      esperaDepoisDoEnvio(ritmo, 2, null, () => 1).esperaMs,
    ).toBeLessThanOrEqual(660_000);
  });

  it('R17.6 — janela de envio: dentro e fora do horário (America/Sao_Paulo)', () => {
    const janela = {
      fusoHorario: 'America/Sao_Paulo',
      dias: { '1': [{ inicio: '09:00', fim: '18:00' }] },
    };
    // 2026-11-02 é segunda-feira. 10:00 em São Paulo = 13:00 UTC.
    expect(
      situacaoDaJanela(janela, new Date('2026-11-02T13:00:00Z')).aberta,
    ).toBe(true);
    const fechada = situacaoDaJanela(janela, new Date('2026-11-02T22:00:00Z'));
    expect(fechada.aberta).toBe(false);
    expect(fechada.proximaAbertura?.toISOString()).toBe(
      '2026-11-09T12:00:00.000Z',
    );
    expect(situacaoDaJanela(null, new Date()).aberta).toBe(true);
  });

  it('R17.12 — estimativa: duração, janela e limite diário', () => {
    const base = {
      total: 100,
      ritmo: {
        ...RITMO,
        intervaloMinimoSegundos: 30,
        intervaloMaximoSegundos: 30,
      },
      pisos: [null],
      limitesDoDia: [null],
      janela: null,
      inicio: new Date('2026-11-02T12:00:00Z'),
    };
    const livre = estimarDuracao(base);
    expect(livre.duracaoSegundos).toBe(3000);
    expect(livre.enviosPorHora).toBe(120);
    expect(livre.terminoPrevisto).not.toBeNull();
    const limitado = estimarDuracao({ ...base, limitesDoDia: [40] });
    expect(limitado.dias).toBe(3);
    expect(estimarDuracao({ ...base, total: 0 }).duracaoSegundos).toBe(0);
  });
});

describe('R17 — palavras de saída (opt-out, R4.6)', () => {
  it('R17.9 — compara a mensagem inteira, sem acento nem caixa', () => {
    const palavras = ['SAIR', 'PARAR', 'CANCELAR'];
    expect(ehPalavraDeSaida('sair', palavras)).toBe(true);
    expect(ehPalavraDeSaida('  Parar!  ', palavras)).toBe(true);
    expect(ehPalavraDeSaida('CANCELAR.', palavras)).toBe(true);
    expect(ehPalavraDeSaida('não quero cancelar o pedido', palavras)).toBe(
      false,
    );
    expect(ehPalavraDeSaida('', palavras)).toBe(false);
    expect(ehPalavraDeSaida(null, palavras)).toBe(false);
    expect(ehPalavraDeSaida('Não', ['NÃO', 'nao'])).toBe(true);
    expect(normalizarPalavra('  ÁGUA?? ')).toBe('agua');
  });
});
