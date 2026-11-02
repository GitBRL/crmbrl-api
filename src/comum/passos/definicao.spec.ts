import { DadosInvalidosException } from '../erros/excecoes';
import {
  type DefinicaoDePassos,
  IndiceDePassos,
  problemasDaDefinicao,
  validarDefinicao,
} from './definicao';
import { fimDaEspera, PASSO_AGUARDAR } from './passos-padrao';

const definicao: DefinicaoDePassos = {
  passos: [
    { id: 'a', tipo: 'mensagem' },
    {
      id: 'b',
      tipo: 'condicao',
      ramos: [
        {
          id: 'sim',
          passos: [
            { id: 'b1', tipo: 'mensagem' },
            { id: 'b2', tipo: 'mensagem' },
          ],
        },
        { id: 'nao', passos: [] },
        {
          id: 'talvez',
          passos: [
            {
              id: 'c',
              tipo: 'condicao',
              ramos: [
                {
                  id: 'x',
                  passos: [{ id: 'c1', tipo: 'mensagem', proximo: 'a' }],
                },
              ],
            },
          ],
        },
      ],
    },
    { id: 'd', tipo: 'encerrar' },
  ],
};

describe('Definição de passos (Onda B §2.1)', () => {
  it('navega em sequência, entra em ramos e volta ao passo seguinte ao dono', () => {
    const indice = new IndiceDePassos(definicao);
    expect(indice.primeiro).toBe('a');
    expect(indice.depoisDe('a')).toBe('b');
    expect(indice.entrarNoRamo('b', 'sim')).toBe('b1');
    expect(indice.depoisDe('b1')).toBe('b2');
    expect(indice.depoisDe('b2')).toBe('d');
    expect(indice.entrarNoRamo('b', 'nao')).toBe('d');
    expect(indice.entrarNoRamo('c', 'x')).toBe('c1');
    expect(indice.emSequencia('c1')).toBe('d');
    expect(indice.depoisDe('c1')).toBe('a');
    expect(indice.depoisDe('d')).toBeNull();
    expect(() => indice.entrarNoRamo('b', 'zzz')).toThrow('não tem o ramo');
    expect(new IndiceDePassos({ passos: [] }).primeiro).toBeNull();
  });

  it('valida ids únicos, tipos registrados, ramos e desvios', () => {
    expect(validarDefinicao(definicao)).toBe(definicao);
    const problemas = problemasDaDefinicao(
      {
        passos: [
          { id: 'a', tipo: 'mensagem' },
          { id: 'a', tipo: 'xpto', proximo: 'nada' },
          { id: 'b', tipo: 'aguardar', config: { quantidade: 0 } },
          {
            id: 'c',
            tipo: 'mensagem',
            ramos: [
              { id: 'r', passos: [] },
              { id: 'r', passos: [] },
            ],
          },
          { tipo: 'mensagem' },
        ],
      },
      {
        tipos: new Map([
          ['mensagem', undefined],
          ['aguardar', PASSO_AGUARDAR.validar],
        ]),
      },
    );
    expect(problemas.map((p) => `${p.caminho}: ${p.mensagem}`)).toEqual([
      'passos[1].id: Id de passo repetido: "a".',
      'passos[1].tipo: Tipo de passo desconhecido: "xpto".',
      'passos[2].config: Informe quanto tempo aguardar.',
      'passos[3].ramos[1].id: Ramo repetido: "r".',
      'passos[4].id: Todo passo precisa de um id.',
      'passos[1].proximo: O desvio aponta para um passo que não existe: "nada".',
    ]);
    expect(() => validarDefinicao({})).toThrow(DadosInvalidosException);
  });

  it('aguardar calcula o fim pela quantidade/unidade ou pela data', () => {
    const agora = new Date('2026-10-30T12:00:00Z');
    expect(fimDaEspera({ quantidade: 2, unidade: 'horas' }, agora)).toEqual(
      new Date('2026-10-30T14:00:00Z'),
    );
    expect(fimDaEspera({ quantidade: 3, unidade: 'dias' }, agora)).toEqual(
      new Date('2026-11-02T12:00:00Z'),
    );
    expect(fimDaEspera({ ate: '2026-12-01T09:00:00-03:00' }, agora)).toEqual(
      new Date('2026-12-01T12:00:00Z'),
    );
  });
});
