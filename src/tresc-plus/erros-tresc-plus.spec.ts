import { montarCorpo } from '../comum/erros/filtro-de-erros';
import { ErroTrescPlus } from './erros-tresc-plus';

describe('R34.5 — erro da 3C+ nunca vira o status do CRM', () => {
  it.each([
    [401, 422],
    [404, 422],
    [429, 422],
    [500, 503],
    [0, 503],
  ])(
    'o filtro global converte ErroTrescPlus com status %i em %i (sem o 401 que desloga a pessoa)',
    (statusDaTresc, esperado) => {
      const codigo =
        statusDaTresc === 0
          ? 'rede'
          : statusDaTresc >= 500
            ? 'indisponivel'
            : statusDaTresc === 401
              ? 'token_invalido'
              : 'nao_encontrado';
      const erro = new ErroTrescPlus(codigo, 'Mensagem clara.', statusDaTresc);
      const corpo = montarCorpo(erro, 'req-1');
      expect(corpo.statusCode).toBe(esperado);
      expect(corpo.mensagem).toBe('Mensagem clara.');
      expect(corpo.statusCode).not.toBe(401);
    },
  );
});
