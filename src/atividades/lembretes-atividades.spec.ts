import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';
import {
  AGENDA_DOS_LEMBRETES,
  ANTECEDENCIA_DO_LEMBRETE_MS,
  FILA_LEMBRETES_DE_ATIVIDADES,
  notificacaoDeAtraso,
  notificacaoDeVencimento,
} from './lembretes-atividades.service';

const AGORA = new Date('2026-10-20T15:00:00Z'); // 12h em São Paulo

describe('lembretes de atividades (R6.5)', () => {
  it('roda a cada 15 minutos, avisando 1 hora antes', () => {
    expect(FILA_LEMBRETES_DE_ATIVIDADES).toBe('atividades.lembretes');
    expect(AGENDA_DOS_LEMBRETES).toBe('*/15 * * * *');
    expect(ANTECEDENCIA_DO_LEMBRETE_MS).toBe(60 * 60 * 1_000);
  });

  it('lembrete de vencimento com a hora local e o link da atividade', () => {
    const notificacao = notificacaoDeVencimento(
      {
        id: 'a1',
        tipo: 'EMAIL',
        titulo: 'Enviar proposta',
        responsavelId: 'u1',
        venceEm: new Date('2026-10-20T15:50:00Z'),
        inicioEm: null,
        fimEm: null,
      },
      AGORA,
    );
    expect(notificacao).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
      titulo: 'Atividade vencendo',
      texto: 'O e-mail "Enviar proposta" vence às 12:50.',
      link: '/atividades?atividade=a1',
      dados: { atividadeId: 'a1', tipo: 'EMAIL' },
    });
  });

  it('reunião: o lembrete fala do início; o atraso, do fim', () => {
    const reuniao = {
      id: 'r1',
      tipo: 'REUNIAO' as const,
      titulo: 'Apresentação ACME',
      responsavelId: 'u1',
      venceEm: new Date('2026-10-20T15:45:00Z'),
      inicioEm: new Date('2026-10-20T15:45:00Z'),
      fimEm: new Date('2026-10-20T16:30:00Z'),
    };
    expect(notificacaoDeVencimento(reuniao, AGORA)).toMatchObject({
      titulo: 'Reunião em breve',
      texto: 'A reunião "Apresentação ACME" começa às 12:45.',
    });
    expect(
      notificacaoDeAtraso(reuniao, new Date('2026-10-20T17:00:00Z')),
    ).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
      texto:
        'A reunião "Apresentação ACME" terminou às 13:30 e continua pendente.',
    });
  });

  it('atraso de outro dia mostra a data', () => {
    expect(
      notificacaoDeAtraso(
        {
          id: 't1',
          tipo: 'TAREFA',
          titulo: 'Ligar de volta',
          responsavelId: 'u1',
          venceEm: new Date('2026-10-19T20:00:00Z'),
          inicioEm: null,
          fimEm: null,
        },
        AGORA,
      ).texto,
    ).toBe(
      'A tarefa "Ligar de volta" venceu em 19/10 às 17:00 e continua pendente.',
    );
  });
});
