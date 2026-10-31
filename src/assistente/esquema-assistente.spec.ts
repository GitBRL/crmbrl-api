import { RespostaInvalidaError } from '../bi/analise/esquema-analise';
import {
  conferirRespostaDoAssistente,
  ESQUEMA_RESPOSTA_ASSISTENTE,
  respostaParcial,
} from './esquema-assistente';

describe('R25 — saída estruturada do assistente', () => {
  it('R25.2 — esquema com os quatro campos, resposta primeiro', () => {
    expect(Object.keys(ESQUEMA_RESPOSTA_ASSISTENTE.properties)[0]).toBe(
      'resposta',
    );
    expect(ESQUEMA_RESPOSTA_ASSISTENTE.required).toEqual([
      'resposta',
      'resolvido',
      'categoria',
      'resumoDoPedido',
    ]);
    expect(ESQUEMA_RESPOSTA_ASSISTENTE.properties.categoria.enum).toEqual([
      'duvida_de_uso',
      'funcionalidade_inexistente_no_escopo',
      'fora_do_escopo',
      'erro_do_sistema',
    ]);
  });

  it('R25.2 — confere tipos e categoria; corta textos longos', () => {
    const ok = conferirRespostaDoAssistente({
      resposta: '  Abra Funis.  ',
      resolvido: true,
      categoria: 'duvida_de_uso',
      resumoDoPedido: 'x'.repeat(400),
    });
    expect(ok.resposta).toBe('Abra Funis.');
    expect(ok.resumoDoPedido).toHaveLength(300);
    for (const ruim of [
      null,
      [],
      {
        resposta: '',
        resolvido: true,
        categoria: 'duvida_de_uso',
        resumoDoPedido: '',
      },
      {
        resposta: 'a',
        resolvido: 'sim',
        categoria: 'duvida_de_uso',
        resumoDoPedido: '',
      },
      {
        resposta: 'a',
        resolvido: true,
        categoria: 'abrir_chamado',
        resumoDoPedido: '',
      },
      { resposta: 'a', resolvido: true, categoria: 'duvida_de_uso' },
    ]) {
      expect(() => conferirRespostaDoAssistente(ruim)).toThrow(
        RespostaInvalidaError,
      );
    }
  });

  it('R25.2 — o parcial do streaming é só o texto da resposta', () => {
    expect(respostaParcial('{"resposta":"Abra o me')).toBe('Abra o me');
    expect(respostaParcial('{"res')).toBeNull();
    expect(respostaParcial('')).toBeNull();
  });
});
