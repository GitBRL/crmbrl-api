import { DadosInvalidosException } from '../erros/excecoes';
import {
  problemasDoSegmento,
  validarSegmento,
  whereDoSegmento,
} from './segmentos';

const ID = '2b1f0c9e-7c1a-4e7b-9a52-0d1c2b3a4f5e';
const AGORA = new Date('2026-10-30T12:00:00Z');

describe('Segmentos (Onda B §2.1)', () => {
  describe('validação', () => {
    it('aceita um segmento completo e normaliza a combinação', () => {
      const segmento = validarSegmento({
        condicoes: [
          { campo: 'etiquetas', operador: 'contem_alguma', valor: [' vip '] },
          { campo: 'origem', operador: 'em', valor: ['WHATSAPP', 'SITE'] },
          { campo: 'utm.source', operador: 'igual', valor: 'instagram' },
          { campo: 'responsavel', operador: 'vazio' },
          {
            campo: 'negocio',
            operador: 'tem',
            valor: { funilId: ID, status: ['ABERTO'] },
          },
          {
            campo: 'criado_em',
            operador: 'entre',
            valor: ['2026-01-01', '2026-02-01'],
          },
          { campo: 'ultima_interacao_em', operador: 'mais_de_dias', valor: 30 },
          { campo: 'campos.plano', operador: 'igual', valor: 'Ouro' },
          {
            grupo: {
              combinacao: 'qualquer',
              condicoes: [{ campo: 'email', operador: 'preenchido' }],
            },
          },
        ],
      });
      expect(segmento.combinacao).toBe('todas');
      expect(segmento.condicoes[0]).toEqual({
        campo: 'etiquetas',
        operador: 'contem_alguma',
        valor: ['vip'],
      });
      expect(segmento.condicoes[3]).toEqual({
        campo: 'responsavel',
        operador: 'vazio',
      });
    });

    it('aponta campo, operador e valor inválidos com o caminho', () => {
      expect(
        problemasDoSegmento({
          condicoes: [
            { campo: 'xpto', operador: 'igual', valor: 1 },
            { campo: 'etiquetas', operador: 'igual', valor: ['a'] },
            { campo: 'origem', operador: 'em', valor: ['FAX'] },
            { campo: 'criado_em', operador: 'ultimos_dias', valor: -1 },
            { grupo: { condicoes: 'x' } },
          ],
        }),
      ).toEqual([
        {
          caminho: 'segmento.condicoes[0].campo',
          mensagem: 'Campo desconhecido: "xpto".',
        },
        {
          caminho: 'segmento.condicoes[1].operador',
          mensagem: 'Operador "igual" não vale para "etiquetas".',
        },
        {
          caminho: 'segmento.condicoes[2].valor',
          mensagem: 'Valor inválido: "FAX".',
        },
        {
          caminho: 'segmento.condicoes[3].valor',
          mensagem: 'Informe um número inteiro de dias.',
        },
        {
          caminho: 'segmento.condicoes[4].grupo.condicoes',
          mensagem: 'Informe a lista de condições.',
        },
      ]);
      expect(() => validarSegmento(null)).toThrow(DadosInvalidosException);
      expect(
        problemasDoSegmento({
          condicoes: [{ campo: 'utm.foo', operador: 'igual', valor: 'x' }],
        })[0].mensagem,
      ).toBe('Campo desconhecido: "utm.foo".');
    });

    it('limita a profundidade dos grupos', () => {
      const fundo = {
        condicoes: [
          {
            grupo: {
              condicoes: [
                { grupo: { condicoes: [{ grupo: { condicoes: [] } }] } },
              ],
            },
          },
        ],
      };
      expect(problemasDoSegmento(fundo)[0].mensagem).toBe(
        'No máximo 3 níveis de grupos.',
      );
    });
  });

  describe('where do Prisma', () => {
    it('sempre exclui os excluídos e, por padrão, o opt-out (R4.6)', () => {
      expect(whereDoSegmento({ condicoes: [] })).toEqual({
        AND: [{ excluidoEm: null }, { optOutMarketing: false }],
      });
      expect(
        whereDoSegmento({ condicoes: [] }, { excluirOptOut: false }),
      ).toEqual({
        AND: [{ excluidoEm: null }],
      });
    });

    it('traduz etiquetas, origem, responsável e negócio restrito ao negócio da automação', () => {
      const where = whereDoSegmento(
        validarSegmento({
          combinacao: 'qualquer',
          condicoes: [
            { campo: 'etiquetas', operador: 'nao_contem', valor: ['frio'] },
            {
              campo: 'primeira_origem',
              operador: 'fora_de',
              valor: ['IMPORTACAO'],
            },
            { campo: 'responsavel', operador: 'fora_de', valor: [ID] },
            {
              campo: 'negocio',
              operador: 'nao_tem',
              valor: { status: ['GANHO'] },
            },
          ],
        }),
        { excluirOptOut: false, negocioId: ID },
      );
      expect(where).toEqual({
        AND: [
          { excluidoEm: null },
          {
            OR: [
              { NOT: { etiquetas: { hasSome: ['frio'] } } },
              { primeiraOrigem: { notIn: ['IMPORTACAO'] } },
              {
                OR: [
                  { responsavelId: null },
                  { responsavelId: { notIn: [ID] } },
                ],
              },
              {
                negocios: {
                  none: { excluidoEm: null, id: ID, status: { in: ['GANHO'] } },
                },
              },
            ],
          },
        ],
      });
    });

    it('datas relativas usam o "agora" e datas sem hora valem o dia inteiro', () => {
      const where = whereDoSegmento(
        validarSegmento({
          condicoes: [
            { campo: 'criado_em', operador: 'ultimos_dias', valor: 7 },
            {
              campo: 'ultima_origem_em',
              operador: 'depois',
              valor: '2026-10-01',
            },
            {
              campo: 'ultima_interacao_em',
              operador: 'mais_de_dias',
              valor: 30,
            },
          ],
        }),
        { excluirOptOut: false, agora: AGORA },
      );
      expect((where.AND as unknown[])[1]).toEqual({
        AND: [
          { criadoEm: { gte: new Date('2026-10-23T12:00:00Z') } },
          { ultimaOrigemEm: { gt: new Date('2026-10-01T23:59:59.999Z') } },
          {
            conversas: {
              none: {
                ultimaMensagemEm: { gte: new Date('2026-09-30T12:00:00Z') },
              },
            },
          },
        ],
      });
    });

    it('grupo "qualquer" vazio não seleciona ninguém', () => {
      expect(
        whereDoSegmento(
          { combinacao: 'qualquer', condicoes: [] },
          { excluirOptOut: false },
        ),
      ).toEqual({
        AND: [{ excluidoEm: null }, { id: { in: [] } }],
      });
    });
  });
});
