import {
  avaliarPedido,
  contarSemResposta,
  DIA_MS,
  pedidosQueContam,
  podeLigarSegundoORegistro,
  situacaoExibida,
} from './permissoes';

const AGORA = new Date('2026-11-02T12:00:00Z');
const antes = (ms: number) => new Date(AGORA.getTime() - ms);
const HORA = 3_600_000;

describe('Permissão de ligação (R29.4)', () => {
  it('R29.4 — sem pedidos, pode pedir', () => {
    expect(avaliarPedido([], AGORA)).toMatchObject({
      pode: true,
      motivo: null,
      liberaEm: null,
      usoNas24h: 0,
      usoNos7d: 0,
    });
  });

  it('R29.4 — 1 pedido por 24 h: bloqueia e diz quando libera', () => {
    const pedido = antes(2 * HORA);
    const resultado = avaliarPedido([pedido], AGORA);
    expect(resultado.pode).toBe(false);
    expect(resultado.motivo).toBe('limite_24h');
    expect(resultado.liberaEm).toEqual(new Date(pedido.getTime() + DIA_MS));
    expect(resultado.usoNas24h).toBe(1);
  });

  it('R29.4 — passadas 24 h libera o segundo pedido da semana', () => {
    expect(avaliarPedido([antes(25 * HORA)], AGORA).pode).toBe(true);
  });

  it('R29.4 — 2 pedidos em 7 dias: bloqueia até o mais antigo sair da semana', () => {
    const primeiro = antes(6 * DIA_MS);
    const segundo = antes(3 * DIA_MS);
    const resultado = avaliarPedido([segundo, primeiro], AGORA);
    expect(resultado.pode).toBe(false);
    expect(resultado.motivo).toBe('limite_7d');
    expect(resultado.liberaEm).toEqual(
      new Date(primeiro.getTime() + 7 * DIA_MS),
    );
    expect(resultado.usoNos7d).toBe(2);
  });

  it('R29.4 — pedidos com mais de 7 dias não contam e são descartados', () => {
    const velho = antes(8 * DIA_MS);
    const recente = antes(2 * DIA_MS);
    expect(avaliarPedido([velho, recente], AGORA).pode).toBe(true);
    expect(pedidosQueContam([velho, recente], AGORA)).toEqual([recente]);
  });

  it('R29.4 — a temporária vencida aparece como EXPIRADA; a permanente nunca vence', () => {
    expect(
      situacaoExibida(
        { situacao: 'CONCEDIDA', tipo: 'TEMPORARIA', validaAte: antes(1000) },
        AGORA,
      ),
    ).toBe('EXPIRADA');
    expect(
      situacaoExibida(
        {
          situacao: 'CONCEDIDA',
          tipo: 'TEMPORARIA',
          validaAte: new Date(AGORA.getTime() + HORA),
        },
        AGORA,
      ),
    ).toBe('CONCEDIDA');
    expect(
      situacaoExibida(
        { situacao: 'CONCEDIDA', tipo: 'PERMANENTE', validaAte: null },
        AGORA,
      ),
    ).toBe('CONCEDIDA');
    expect(situacaoExibida(null, AGORA)).toBe('NENHUMA');
    expect(
      podeLigarSegundoORegistro(
        { situacao: 'NEGADA', tipo: null, validaAte: null },
        AGORA,
      ),
    ).toBe(false);
  });

  it('R29.4 — 4 ligações feitas seguidas sem resposta revogam; atender zera', () => {
    let total = 0;
    for (let i = 1; i <= 3; i++) {
      const passo = contarSemResposta(total, 'sem_resposta');
      expect(passo.revoga).toBe(false);
      total = passo.total;
    }
    expect(contarSemResposta(total, 'sem_resposta')).toEqual({
      total: 4,
      revoga: true,
    });
    expect(contarSemResposta(3, 'atendida')).toEqual({
      total: 0,
      revoga: false,
    });
    expect(contarSemResposta(3, 'ignorar')).toEqual({
      total: 3,
      revoga: false,
    });
  });
});
