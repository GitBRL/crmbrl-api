import { DadosInvalidosException } from '../comum/erros/excecoes';
import { validarDadosEmMassa } from './negocios-em-massa.dados';

const UUID = '3f1c5a52-0000-4000-8000-000000000001';

function campos(
  acao: Parameters<typeof validarDadosEmMassa>[0],
  dados?: object,
) {
  try {
    validarDadosEmMassa(acao, dados as Record<string, unknown>);
  } catch (erro) {
    expect(erro).toBeInstanceOf(DadosInvalidosException);
    return (
      (erro as DadosInvalidosException).detalhes as {
        campos: { campo: string }[];
      }
    ).campos.map((c) => c.campo);
  }
  return [];
}

describe('validarDadosEmMassa (R5.16)', () => {
  it('R5.16 — MOVER exige etapaId UUID; motivoPerda é opcional e aparado', () => {
    expect(campos('MOVER', {})).toEqual(['dados.etapaId']);
    expect(campos('MOVER', { etapaId: 'x' })).toEqual(['dados.etapaId']);
    expect(
      validarDadosEmMassa('MOVER', { etapaId: UUID, motivoPerda: ' ruim ' }),
    ).toEqual({
      acao: 'MOVER',
      etapaId: UUID,
      motivoPerda: 'ruim',
    });
  });

  it('R5.16 — RESPONSAVEL aceita UUID ou null, não ausente', () => {
    expect(validarDadosEmMassa('RESPONSAVEL', { responsavelId: null })).toEqual(
      {
        acao: 'RESPONSAVEL',
        responsavelId: null,
      },
    );
    expect(campos('RESPONSAVEL', {})).toEqual(['dados.responsavelId']);
  });

  it('R5.16 — PERDER exige motivo (até 500 caracteres)', () => {
    expect(campos('PERDER', { motivoPerda: '  ' })).toEqual([
      'dados.motivoPerda',
    ]);
    expect(campos('PERDER', { motivoPerda: 'x'.repeat(501) })).toEqual([
      'dados.motivoPerda',
    ]);
    expect(validarDadosEmMassa('PERDER', { motivoPerda: 'ok' })).toMatchObject({
      motivoPerda: 'ok',
    });
  });

  it('R5.16 — ETIQUETAR normaliza (sem repetir) e exige ao menos uma', () => {
    expect(campos('ETIQUETAR', { etiquetas: [] })).toEqual(['dados.etiquetas']);
    expect(campos('DESETIQUETAR', { etiquetas: [1] })).toEqual([
      'dados.etiquetas',
    ]);
    expect(
      validarDadosEmMassa('ETIQUETAR', {
        etiquetas: ['VIP', ' vip ', 'Quente'],
      }),
    ).toEqual({
      acao: 'ETIQUETAR',
      etiquetas: ['VIP', 'Quente'],
    });
  });

  it('R5.16 — ATIVIDADE: tipo permitido (sem reunião), título, vencimento com fuso e não em nota', () => {
    expect(campos('ATIVIDADE', { tipo: 'REUNIAO', titulo: 'x' })).toEqual([
      'dados.tipo',
    ]);
    expect(campos('ATIVIDADE', { tipo: 'TAREFA' })).toEqual(['dados.titulo']);
    expect(
      campos('ATIVIDADE', {
        tipo: 'TAREFA',
        titulo: 'x',
        vencimento: '2030-01-01',
      }),
    ).toEqual(['dados.vencimento']);
    expect(
      campos('ATIVIDADE', {
        tipo: 'NOTA',
        titulo: 'x',
        vencimento: '2030-01-01T10:00:00Z',
      }),
    ).toEqual(['dados.vencimento']);
    expect(
      validarDadosEmMassa('ATIVIDADE', {
        tipo: 'LIGACAO',
        titulo: ' Ligar ',
        vencimento: '2030-01-01T10:00:00-03:00',
      }),
    ).toMatchObject({
      tipo: 'LIGACAO',
      titulo: 'Ligar',
      vencimento: '2030-01-01T10:00:00-03:00',
    });
  });

  it('R5.16 — GANHAR e EXCLUIR não pedem dados', () => {
    expect(validarDadosEmMassa('GANHAR', undefined)).toEqual({
      acao: 'GANHAR',
    });
    expect(validarDadosEmMassa('EXCLUIR', {})).toEqual({ acao: 'EXCLUIR' });
  });
});
