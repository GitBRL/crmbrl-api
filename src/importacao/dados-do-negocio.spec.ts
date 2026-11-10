import {
  lerDataDaPlanilha,
  lerDataDoNegocio,
  lerStatusDoNegocio,
} from './dados-do-negocio';

describe('Status do negócio importado (R16.14)', () => {
  it.each([
    ['Aberto', 'ABERTO'],
    ['  EM  ABERTO ', 'ABERTO'],
    ['open', 'ABERTO'],
    ['Em andamento', 'ABERTO'],
    ['Ganho', 'GANHO'],
    ['WON', 'GANHO'],
    ['vendido', 'GANHO'],
    ['Perdido', 'PERDIDO'],
    ['lost', 'PERDIDO'],
    ['Perda', 'PERDIDO'],
    ['', 'ABERTO'],
  ])('R16.14 — "%s" vira %s', (texto, status) => {
    const r = lerStatusDoNegocio(texto);
    expect(r.status).toBe(status);
    expect(r.aviso).toBeUndefined();
  });

  it('R16.14 — valor desconhecido entra aberto com aviso', () => {
    expect(lerStatusDoNegocio('Congelado')).toEqual({
      status: 'ABERTO',
      aviso: 'Status "Congelado" desconhecido: o negócio entrou aberto.',
    });
  });
});

describe('Datas da planilha (R16.14)', () => {
  it('R16.14 — dd/mm/aaaa hh:mm:ss no horário de São Paulo', () => {
    expect(lerDataDaPlanilha('05/11/2026 13:08:29')?.toISOString()).toBe(
      '2026-11-05T16:08:29.000Z',
    );
  });

  it('R16.14 — dd/mm/aaaa sem hora é meia-noite de São Paulo', () => {
    expect(lerDataDaPlanilha('05/11/2026')?.toISOString()).toBe(
      '2026-11-05T03:00:00.000Z',
    );
  });

  it('R16.14 — aaaa-mm-dd e aaaa-mm-ddThh:mm', () => {
    expect(lerDataDaPlanilha('2026-11-05')?.toISOString()).toBe(
      '2026-11-05T03:00:00.000Z',
    );
    expect(lerDataDaPlanilha('2026-11-05T09:30')?.toISOString()).toBe(
      '2026-11-05T12:30:00.000Z',
    );
  });

  it('R16.14 — número de série do Excel', () => {
    // 46331 = 05/11/2026; .5 = meio-dia
    expect(lerDataDaPlanilha('46331.5')?.toISOString()).toBe(
      '2026-11-05T15:00:00.000Z',
    );
  });

  it('R16.14 — data inexistente ou texto solto é inválida', () => {
    expect(lerDataDaPlanilha('31/02/2026')).toBeNull();
    expect(lerDataDaPlanilha('ontem')).toBeNull();
    expect(lerDataDaPlanilha('05/11/2026 25:00')).toBeNull();
  });

  it('R16.14 — inválida ou no futuro vira aviso e o campo é ignorado', () => {
    const agora = new Date('2026-11-10T12:00:00Z');
    expect(lerDataDoNegocio('Data do ganho', 'abc', agora)).toEqual({
      aviso: 'Data do ganho inválida ("abc"); ignorada.',
    });
    expect(
      lerDataDoNegocio('Data do ganho', '01/01/2030', agora).aviso,
    ).toMatch(/no futuro/);
    expect(
      lerDataDoNegocio('Data do ganho', '01/11/2026', agora).data,
    ).toBeInstanceOf(Date);
  });
});
