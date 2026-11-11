import { papelESetor as comPapel } from '../comum/dominio/papeis-antigos.apoio-spec';
import type {
  StatusAtividade,
  TipoAtividade,
} from '../generated/prisma/client';
import {
  type DatasDaAtividade,
  ehAtrasada,
  filtroDeVisibilidade,
  flexionar,
  GRUPOS_DE_ATIVIDADES,
  grupoDaAtividade,
  marcadoresParaRearmar,
  podeVerAtividade,
  prazoDaAtividade,
  referenciaDeTempo,
  resolverDatas,
  tipoComArtigo,
} from './regras-atividades';

const AGORA = new Date('2026-10-20T15:00:00Z'); // 12h em São Paulo
const referencia = referenciaDeTempo(AGORA, 'America/Sao_Paulo');
const horas = (quantidade: number) =>
  new Date(AGORA.getTime() + quantidade * 3_600_000);
const dias = (quantidade: number) => horas(quantidade * 24);

function atividade(
  tipo: TipoAtividade,
  venceEm: Date | null,
  extras: { status?: StatusAtividade; fimEm?: Date | null } = {},
): DatasDaAtividade {
  return {
    tipo,
    status: extras.status ?? (tipo === 'NOTA' ? 'CONCLUIDA' : 'PENDENTE'),
    venceEm,
    fimEm: extras.fimEm ?? null,
  };
}

describe('regras das atividades (R6)', () => {
  describe('R6.3 — atrasada é calculada', () => {
    it('pendente com vencimento no passado está atrasada', () => {
      expect(ehAtrasada(atividade('TAREFA', horas(-1)), AGORA)).toBe(true);
      expect(ehAtrasada(atividade('LIGACAO', horas(1)), AGORA)).toBe(false);
      expect(ehAtrasada(atividade('EMAIL', null), AGORA)).toBe(false);
    });

    it('concluída, cancelada e nota nunca estão atrasadas', () => {
      expect(
        ehAtrasada(
          atividade('TAREFA', horas(-5), { status: 'CONCLUIDA' }),
          AGORA,
        ),
      ).toBe(false);
      expect(
        ehAtrasada(
          atividade('TAREFA', horas(-5), { status: 'CANCELADA' }),
          AGORA,
        ),
      ).toBe(false);
      expect(ehAtrasada(atividade('NOTA', null), AGORA)).toBe(false);
    });

    it('reunião só atrasa depois do fim (em andamento não está atrasada)', () => {
      const emAndamento = atividade('REUNIAO', horas(-1), { fimEm: horas(1) });
      const terminada = atividade('REUNIAO', horas(-2), { fimEm: horas(-1) });
      expect(prazoDaAtividade(emAndamento)).toEqual(horas(1));
      expect(ehAtrasada(emAndamento, AGORA)).toBe(false);
      expect(ehAtrasada(terminada, AGORA)).toBe(true);
    });
  });

  describe('agrupamentos da agenda', () => {
    it('cada pendente cai em um único grupo; concluídas no último', () => {
      const casos: Array<[DatasDaAtividade, string | null]> = [
        [atividade('TAREFA', horas(-1)), 'ATRASADAS'],
        [atividade('TAREFA', horas(2)), 'HOJE'],
        [atividade('REUNIAO', horas(-1), { fimEm: horas(1) }), 'HOJE'],
        // 23h59 de hoje em São Paulo = 02:59Z de amanhã.
        [atividade('LIGACAO', new Date('2026-10-21T02:59:00Z')), 'HOJE'],
        [
          atividade('LIGACAO', new Date('2026-10-21T03:00:00Z')),
          'PROXIMOS_7_DIAS',
        ],
        [atividade('WHATSAPP', dias(6)), 'PROXIMOS_7_DIAS'],
        // Hoje + 7 (27/10) ainda conta; o 8º dia (28/10) já é "mais tarde".
        [
          atividade('TAREFA', new Date('2026-10-28T02:59:00Z')),
          'PROXIMOS_7_DIAS',
        ],
        [atividade('TAREFA', new Date('2026-10-28T03:00:00Z')), 'MAIS_TARDE'],
        [atividade('EMAIL', null), 'SEM_DATA'],
        [atividade('TAREFA', horas(-3), { status: 'CONCLUIDA' }), 'CONCLUIDAS'],
        [atividade('TAREFA', horas(3), { status: 'CANCELADA' }), null],
        [atividade('NOTA', null), null],
      ];
      for (const [dados, grupo] of casos) {
        expect([dados, grupoDaAtividade(dados, referencia)]).toEqual([
          dados,
          grupo,
        ]);
      }
      expect(GRUPOS_DE_ATIVIDADES).toEqual([
        'ATRASADAS',
        'HOJE',
        'PROXIMOS_7_DIAS',
        'MAIS_TARDE',
        'SEM_DATA',
        'CONCLUIDAS',
      ]);
    });
  });

  describe('R6.4 — visibilidade', () => {
    const atividadeDe = {
      responsavelId: 'membro-1',
      criadoPorId: 'membro-2',
      liderDoResponsavelId: 'lider-1',
    };

    it('veem: responsável, quem criou, o líder do responsável, C-level e Admin', () => {
      expect(
        podeVerAtividade(
          { id: 'membro-1', ...comPapel('COMERCIAL') },
          atividadeDe,
        ),
      ).toBe(true);
      expect(
        podeVerAtividade(
          { id: 'membro-2', ...comPapel('COMERCIAL') },
          atividadeDe,
        ),
      ).toBe(true);
      expect(
        podeVerAtividade(
          { id: 'lider-1', ...comPapel('LIDER_COMERCIAL') },
          atividadeDe,
        ),
      ).toBe(true);
      expect(
        podeVerAtividade(
          { id: 'c-level', ...comPapel('C_LEVEL') },
          atividadeDe,
        ),
      ).toBe(true);
      expect(
        podeVerAtividade({ id: 'admin', ...comPapel('ADMIN') }, atividadeDe),
      ).toBe(true);
    });

    it('não veem: colega de equipe, líder de outra equipe', () => {
      expect(
        podeVerAtividade(
          { id: 'membro-3', ...comPapel('COMERCIAL') },
          atividadeDe,
        ),
      ).toBe(false);
      expect(
        podeVerAtividade(
          { id: 'lider-2', ...comPapel('LIDER_CS') },
          atividadeDe,
        ),
      ).toBe(false);
      // Um membro com o mesmo id de líder no registro não ganha a visão de líder.
      expect(
        podeVerAtividade(
          { id: 'lider-1', ...comPapel('COMERCIAL') },
          atividadeDe,
        ),
      ).toBe(false);
    });

    it('o filtro Prisma segue a mesma regra', () => {
      expect(filtroDeVisibilidade({ id: 'x', ...comPapel('ADMIN') })).toEqual(
        {},
      );
      expect(filtroDeVisibilidade({ id: 'x', ...comPapel('C_LEVEL') })).toEqual(
        {},
      );
      expect(filtroDeVisibilidade({ id: 'x', ...comPapel('CS') })).toEqual({
        OR: [{ responsavelId: 'x' }, { criadoPorId: 'x' }],
      });
      expect(
        filtroDeVisibilidade({ id: 'x', ...comPapel('LIDER_CS') }),
      ).toEqual({
        OR: [
          { responsavelId: 'x' },
          { criadoPorId: 'x' },
          { responsavel: { liderId: 'x' } },
        ],
      });
    });
  });

  describe('R6.1 — datas por tipo', () => {
    it('reunião exige início e fim, com o fim depois do início; o vencimento acompanha o início', () => {
      const ok = resolverDatas('REUNIAO', {
        inicioEm: horas(1),
        fimEm: horas(2),
      });
      expect(ok.problemas).toEqual([]);
      expect(ok.datas).toEqual({
        venceEm: horas(1),
        inicioEm: horas(1),
        fimEm: horas(2),
      });
      expect(resolverDatas('REUNIAO', {}).problemas).toEqual([
        { campo: 'inicioEm', mensagens: ['é obrigatório na reunião'] },
        { campo: 'fimEm', mensagens: ['é obrigatório na reunião'] },
      ]);
      expect(
        resolverDatas('REUNIAO', { inicioEm: horas(2), fimEm: horas(1) })
          .problemas,
      ).toEqual([
        {
          campo: 'fimEm',
          mensagens: ['deve ser igual ou posterior ao início'],
        },
      ]);
      expect(
        resolverDatas('REUNIAO', {
          inicioEm: horas(1),
          fimEm: horas(2),
          venceEm: horas(5),
        }).problemas.map(({ campo }) => campo),
      ).toEqual(['venceEm']);
      // Reenviar o vencimento igual ao início (a atividade inteira) é aceito.
      expect(
        resolverDatas('REUNIAO', {
          inicioEm: horas(1),
          fimEm: horas(2),
          venceEm: horas(1),
        }).problemas,
      ).toEqual([]);
    });

    it('os demais tipos têm só vencimento (opcional); a nota, nenhuma data', () => {
      expect(resolverDatas('TAREFA', {}).datas).toEqual({
        venceEm: null,
        inicioEm: null,
        fimEm: null,
      });
      expect(
        resolverDatas('LIGACAO', { venceEm: horas(3) }).datas.venceEm,
      ).toEqual(horas(3));
      expect(
        resolverDatas('TAREFA', { inicioEm: horas(1), fimEm: horas(2) })
          .problemas,
      ).toEqual([
        { campo: 'inicioEm', mensagens: ['só se aplica à reunião'] },
        { campo: 'fimEm', mensagens: ['só se aplica à reunião'] },
      ]);
      expect(resolverDatas('NOTA', { venceEm: horas(1) }).problemas).toEqual([
        { campo: 'venceEm', mensagens: ['não se aplica à nota'] },
      ]);
    });

    it('na alteração, mantém o que não foi pedido e limpa início e fim ao deixar de ser reunião', () => {
      const reuniao = {
        venceEm: horas(1),
        inicioEm: horas(1),
        fimEm: horas(2),
      };
      expect(
        resolverDatas('REUNIAO', { fimEm: horas(3) }, reuniao).datas,
      ).toEqual({ venceEm: horas(1), inicioEm: horas(1), fimEm: horas(3) });
      expect(resolverDatas('TAREFA', {}, reuniao).datas).toEqual({
        venceEm: horas(1),
        inicioEm: null,
        fimEm: null,
      });
      expect(
        resolverDatas('TAREFA', { venceEm: null }, reuniao).datas.venceEm,
      ).toBeNull();
      const tarefa = { venceEm: horas(5), inicioEm: null, fimEm: null };
      expect(
        resolverDatas('REUNIAO', {}, tarefa).problemas.map(
          ({ campo }) => campo,
        ),
      ).toEqual(['inicioEm', 'fimEm']);
    });
  });

  describe('R6.5 — rearmar os lembretes', () => {
    const base = {
      tipo: 'TAREFA' as const,
      responsavelId: 'ana',
      venceEm: horas(-2),
      fimEm: null,
      lembreteEnviadoEm: horas(-3),
      atrasoNotificadoEm: horas(-1),
    };

    it('reagendar para o futuro rearma o lembrete e o aviso de atraso', () => {
      expect(
        marcadoresParaRearmar(base, { ...base, venceEm: horas(5) }, AGORA),
      ).toEqual({ lembreteEnviadoEm: null, atrasoNotificadoEm: null });
    });

    it('reagendar para outra data ainda no passado não avisa de novo', () => {
      expect(
        marcadoresParaRearmar(base, { ...base, venceEm: horas(-1) }, AGORA),
      ).toEqual({});
    });

    it('trocar o responsável faz o novo receber os avisos', () => {
      expect(
        marcadoresParaRearmar(base, { ...base, responsavelId: 'bruno' }, AGORA),
      ).toEqual({ atrasoNotificadoEm: null });
      const futura = { ...base, venceEm: horas(1), atrasoNotificadoEm: null };
      expect(
        marcadoresParaRearmar(
          futura,
          { ...futura, responsavelId: 'bruno' },
          AGORA,
        ),
      ).toEqual({ lembreteEnviadoEm: null });
    });

    it('nada muda sem mudança de data ou de responsável; reabrir rearma o que está no futuro', () => {
      expect(marcadoresParaRearmar(base, base, AGORA)).toEqual({});
      const futura = {
        ...base,
        venceEm: horas(5),
        lembreteEnviadoEm: horas(-1),
        atrasoNotificadoEm: null,
      };
      expect(marcadoresParaRearmar(futura, futura, AGORA, true)).toEqual({
        lembreteEnviadoEm: null,
      });
      expect(marcadoresParaRearmar(base, base, AGORA, true)).toEqual({});
    });
  });

  it('textos concordam com o tipo', () => {
    expect(tipoComArtigo('TAREFA')).toBe('A tarefa');
    expect(tipoComArtigo('EMAIL')).toBe('O e-mail');
    expect(flexionar('WHATSAPP', 'criad')).toBe('criado');
    expect(flexionar('REUNIAO', 'concluíd')).toBe('concluída');
  });
});
