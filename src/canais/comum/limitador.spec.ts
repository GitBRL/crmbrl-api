import { MuitasTentativasException } from '../../comum/erros/excecoes';
import { LimitadorDeRequisicoes } from './limitador';

class LimitadorComRelogio extends LimitadorDeRequisicoes {
  instante = 1_000_000;

  protected override agora(): number {
    return this.instante;
  }
}

describe('LimitadorDeRequisicoes', () => {
  const regra = { limite: 3, janelaMs: 60_000 };

  it('permite até o limite na janela e depois diz quanto falta', () => {
    const limitador = new LimitadorComRelogio();
    for (let i = 0; i < 3; i++) {
      expect(limitador.consumir('ip:1', regra).permitido).toBe(true);
    }
    limitador.instante += 15_000;
    expect(limitador.consumir('ip:1', regra)).toEqual({
      permitido: false,
      tentarEmSegundos: 45,
    });
    // Outra chave tem a sua própria conta.
    expect(limitador.consumir('ip:2', regra).permitido).toBe(true);
  });

  it('a janela vencida recomeça a contagem', () => {
    const limitador = new LimitadorComRelogio();
    for (let i = 0; i < 4; i++) {
      limitador.consumir('k', regra);
    }
    limitador.instante += 60_000;
    expect(limitador.consumir('k', regra).permitido).toBe(true);
  });

  it('exigir lança 429 com Retry-After e mensagem em português', () => {
    const limitador = new LimitadorComRelogio();
    limitador.exigir('k', { limite: 1, janelaMs: 10_000 }, 'Calma.');
    let erro: unknown;
    try {
      limitador.exigir('k', { limite: 1, janelaMs: 10_000 }, 'Calma.');
    } catch (falha) {
      erro = falha;
    }
    expect(erro).toBeInstanceOf(MuitasTentativasException);
    expect(erro).toMatchObject({
      tentarDeNovoEmSegundos: 10,
      mensagem: 'Calma. Tente de novo em 10 s.',
    });
  });

  it('apaga as janelas vencidas de tempo em tempo', () => {
    const limitador = new LimitadorComRelogio();
    for (let i = 0; i < 600; i++) {
      limitador.consumir(`chave:${i}`, { limite: 1, janelaMs: 1000 });
    }
    limitador.instante += 5000;
    for (let i = 0; i < 500; i++) {
      limitador.consumir('nova', { limite: 1000, janelaMs: 60_000 });
    }
    const janelas = (limitador as unknown as { janelas: Map<string, unknown> })
      .janelas;
    expect(janelas.size).toBeLessThan(600);
  });
});
