import { RespostaInvalidaError } from '../bi/analise/esquema-analise';
import {
  conferirTurnoDoSdr,
  ESQUEMA_TURNO_SDR,
  NOME_DO_ESQUEMA_DO_SDR,
} from './esquema-sdr';

const VALIDO = {
  resposta: 'Oi! Qual curso você procura?',
  criterios: [{ chave: 'curso', valor: 'Enfermagem', confianca: 0.9 }],
  acao: 'continuar',
  motivo: 'Descobriu o curso.',
  resumo: 'Lead quer Enfermagem.',
};

describe('Saída estruturada do SDR (R31)', () => {
  it('R31.2 — o esquema se chama turno_sdr e tem os campos combinados', () => {
    expect(ESQUEMA_TURNO_SDR.title).toBe('turno_sdr');
    expect(NOME_DO_ESQUEMA_DO_SDR).toBe('turno_sdr');
    expect(ESQUEMA_TURNO_SDR.required).toEqual([
      'resposta',
      'criterios',
      'acao',
      'motivo',
      'resumo',
    ]);
    expect(ESQUEMA_TURNO_SDR.properties.acao.enum).toEqual([
      'continuar',
      'qualificado',
      'desqualificado',
      'passar_humano',
    ]);
  });

  it('R31.2 — confere e converte a ação', () => {
    expect(conferirTurnoDoSdr(VALIDO)).toMatchObject({
      resposta: 'Oi! Qual curso você procura?',
      acao: 'CONTINUAR',
      criterios: [{ chave: 'curso', valor: 'Enfermagem', confianca: 0.9 }],
    });
    expect(conferirTurnoDoSdr({ ...VALIDO, acao: 'passar_humano' }).acao).toBe(
      'PASSAR_HUMANO',
    );
  });

  it('R31.2 — ação desconhecida, resposta ausente ou critérios fora de lista são inválidos', () => {
    expect(() => conferirTurnoDoSdr({ ...VALIDO, acao: 'vender' })).toThrow(
      RespostaInvalidaError,
    );
    expect(() =>
      conferirTurnoDoSdr({ ...VALIDO, resposta: undefined }),
    ).toThrow(RespostaInvalidaError);
    expect(() => conferirTurnoDoSdr({ ...VALIDO, resposta: '  ' })).toThrow(
      RespostaInvalidaError,
    );
    expect(() => conferirTurnoDoSdr({ ...VALIDO, criterios: 'x' })).toThrow(
      RespostaInvalidaError,
    );
    expect(() => conferirTurnoDoSdr('texto')).toThrow(RespostaInvalidaError);
  });

  it('R31.2 — passar para humano aceita resposta vazia (a API usa a mensagem de passagem)', () => {
    expect(
      conferirTurnoDoSdr({ ...VALIDO, acao: 'passar_humano', resposta: '' })
        .resposta,
    ).toBe('');
  });

  it('R31.2 — itens inválidos de critérios são descartados e os textos, cortados', () => {
    const r = conferirTurnoDoSdr({
      ...VALIDO,
      resposta: 'a'.repeat(5000),
      criterios: [
        null,
        { chave: '', valor: 'x', confianca: 1 },
        { chave: 'curso', valor: 12, confianca: 'alta' },
      ],
    });
    expect(r.resposta.length).toBeLessThanOrEqual(1500);
    expect(r.criterios).toEqual([
      { chave: 'curso', valor: '12', confianca: 0 },
    ]);
  });
});
