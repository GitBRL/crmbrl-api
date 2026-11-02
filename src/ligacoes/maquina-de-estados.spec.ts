import type { DirecaoLigacao, EstadoLigacao } from '../generated/prisma/client';
import {
  avanca,
  decidir,
  ehTerminal,
  type EventoDaLigacao,
  podeCompletarDados,
} from './maquina-de-estados';

const ESTADOS: EstadoLigacao[] = [
  'CHAMANDO',
  'TOCANDO',
  'EM_ANDAMENTO',
  'ENCERRADA',
  'PERDIDA',
  'RECUSADA',
  'SEM_RESPOSTA',
  'FALHOU',
];
const TERMINAIS = ESTADOS.filter((estado) => ehTerminal(estado));

const EVENTOS: EventoDaLigacao[] = [
  { tipo: 'tocando_no_cliente' },
  { tipo: 'cliente_atendeu' },
  { tipo: 'cliente_recusou' },
  { tipo: 'atendida_pelo_atendente' },
  { tipo: 'encerrada_pela_meta', atendida: true, falhou: false },
  { tipo: 'encerrada_pela_meta', atendida: false, falhou: false },
  { tipo: 'encerrada_pela_meta', atendida: false, falhou: true },
  { tipo: 'tempo_de_toque_esgotado' },
  { tipo: 'nao_pode_tocar', motivo: 'fora_do_horario' },
  { tipo: 'cancelada_pelo_atendente' },
  { tipo: 'encerramento_forcado', motivo: 'conexao_perdida' },
  { tipo: 'falhou', motivo: 'falha_na_meta' },
  { tipo: 'vigia_esgotada' },
];

function estadoApos(
  inicial: EstadoLigacao,
  direcao: DirecaoLigacao,
  eventos: EventoDaLigacao[],
): EstadoLigacao {
  let estado = inicial;
  for (const evento of eventos) {
    const decisao = decidir(estado, direcao, evento);
    if (decisao.aplicar) {
      estado = decisao.estado;
    }
  }
  return estado;
}

describe('Máquina de estados da ligação (R29.1)', () => {
  it('R29.1 — recebida: TOCANDO → EM_ANDAMENTO → ENCERRADA', () => {
    expect(
      decidir('TOCANDO', 'RECEBIDA', { tipo: 'atendida_pelo_atendente' }),
    ).toEqual({ aplicar: true, estado: 'EM_ANDAMENTO', motivo: null });
    expect(
      decidir('EM_ANDAMENTO', 'RECEBIDA', {
        tipo: 'encerrada_pela_meta',
        atendida: true,
        falhou: false,
      }),
    ).toEqual({
      aplicar: true,
      estado: 'ENCERRADA',
      motivo: 'encerrada_pelo_cliente',
    });
  });

  it('R29.1 — recebida: o terminate depois do pedido do atendente vira "encerrada pelo atendente"', () => {
    expect(
      decidir('EM_ANDAMENTO', 'RECEBIDA', {
        tipo: 'encerrada_pela_meta',
        atendida: true,
        falhou: false,
        canceladaPorNos: true,
      }),
    ).toMatchObject({
      estado: 'ENCERRADA',
      motivo: 'encerrada_pelo_atendente',
    });
  });

  it('R29.1 — recebida perdida: tempo de toque, cliente desligou e condições da chegada', () => {
    expect(
      decidir('TOCANDO', 'RECEBIDA', { tipo: 'tempo_de_toque_esgotado' }),
    ).toMatchObject({ estado: 'PERDIDA', motivo: 'tempo_esgotado' });
    expect(
      decidir('TOCANDO', 'RECEBIDA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: false,
      }),
    ).toMatchObject({ estado: 'PERDIDA', motivo: 'cliente_desligou' });
    expect(
      decidir('TOCANDO', 'RECEBIDA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: false,
        toqueVencido: true,
      }),
    ).toMatchObject({ estado: 'PERDIDA', motivo: 'tempo_esgotado' });
    for (const motivo of [
      'fora_do_horario',
      'sem_atendente',
      'ligacoes_desativadas',
      'atrasada',
    ] as const) {
      expect(
        decidir('TOCANDO', 'RECEBIDA', { tipo: 'nao_pode_tocar', motivo }),
      ).toMatchObject({ estado: 'PERDIDA', motivo });
    }
  });

  it('R29.1 — recebida: falha na Meta vira FALHOU', () => {
    expect(
      decidir('TOCANDO', 'RECEBIDA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: true,
      }),
    ).toMatchObject({ estado: 'FALHOU', motivo: 'falha_na_meta' });
    expect(
      decidir('TOCANDO', 'RECEBIDA', {
        tipo: 'falhou',
        motivo: 'falha_ao_atender',
      }),
    ).toMatchObject({ estado: 'FALHOU', motivo: 'falha_ao_atender' });
  });

  it('R29.1 — feita: CHAMANDO → TOCANDO → EM_ANDAMENTO → ENCERRADA', () => {
    expect(
      estadoApos('CHAMANDO', 'FEITA', [
        { tipo: 'tocando_no_cliente' },
        { tipo: 'cliente_atendeu' },
        { tipo: 'encerrada_pela_meta', atendida: true, falhou: false },
      ]),
    ).toBe('ENCERRADA');
  });

  it('R29.1 — feita: recusada, sem resposta, cancelada, falha e vigia', () => {
    expect(
      decidir('TOCANDO', 'FEITA', { tipo: 'cliente_recusou' }),
    ).toMatchObject({ estado: 'RECUSADA', motivo: 'recusada_pelo_cliente' });
    expect(
      decidir('TOCANDO', 'FEITA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: false,
      }),
    ).toMatchObject({ estado: 'SEM_RESPOSTA', motivo: 'sem_resposta' });
    expect(
      decidir('CHAMANDO', 'FEITA', { tipo: 'cancelada_pelo_atendente' }),
    ).toMatchObject({
      estado: 'SEM_RESPOSTA',
      motivo: 'cancelada_pelo_atendente',
    });
    expect(
      decidir('TOCANDO', 'FEITA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: false,
        canceladaPorNos: true,
      }),
    ).toMatchObject({
      estado: 'SEM_RESPOSTA',
      motivo: 'cancelada_pelo_atendente',
    });
    expect(
      decidir('CHAMANDO', 'FEITA', {
        tipo: 'encerrada_pela_meta',
        atendida: false,
        falhou: true,
      }),
    ).toMatchObject({ estado: 'FALHOU', motivo: 'falha_ao_ligar' });
    expect(
      decidir('CHAMANDO', 'FEITA', { tipo: 'vigia_esgotada' }),
    ).toMatchObject({ estado: 'FALHOU', motivo: 'sem_resposta_da_meta' });
    expect(
      decidir('TOCANDO', 'FEITA', { tipo: 'vigia_esgotada' }),
    ).toMatchObject({
      estado: 'SEM_RESPOSTA',
    });
  });

  it('R29.1 — feita: terminate direto no CHAMANDO e o ACCEPTED que pula o RINGING', () => {
    expect(
      decidir('CHAMANDO', 'FEITA', { tipo: 'cliente_atendeu' }),
    ).toMatchObject({ estado: 'EM_ANDAMENTO' });
    expect(
      decidir('CHAMANDO', 'FEITA', { tipo: 'cliente_recusou' }),
    ).toMatchObject({ estado: 'RECUSADA' });
  });

  it('R29.1 — com ligação em andamento, o erro de mídia no fim ainda é ENCERRADA', () => {
    expect(
      decidir('EM_ANDAMENTO', 'FEITA', {
        tipo: 'encerrada_pela_meta',
        atendida: true,
        falhou: true,
        motivoDaFalha: 'falha_de_midia',
      }),
    ).toMatchObject({ estado: 'ENCERRADA', motivo: 'falha_de_midia' });
  });

  it('R29.1 — estado terminal nunca muda, qualquer que seja o evento', () => {
    for (const direcao of ['RECEBIDA', 'FEITA'] as const) {
      for (const terminal of TERMINAIS) {
        for (const evento of EVENTOS) {
          expect(decidir(terminal, direcao, evento)).toEqual({
            aplicar: false,
            razao: 'terminal',
          });
        }
        expect(podeCompletarDados(terminal)).toBe(true);
      }
    }
    expect(podeCompletarDados('TOCANDO')).toBe(false);
  });

  it('R29.1 — webhooks fora de ordem ou repetidos não regridem o estado', () => {
    // RINGING depois do ACCEPTED, e RINGING repetido.
    expect(
      estadoApos('CHAMANDO', 'FEITA', [
        { tipo: 'cliente_atendeu' },
        { tipo: 'tocando_no_cliente' },
        { tipo: 'tocando_no_cliente' },
      ]),
    ).toBe('EM_ANDAMENTO');
    expect(
      decidir('EM_ANDAMENTO', 'FEITA', { tipo: 'tocando_no_cliente' }),
    ).toEqual({ aplicar: false, razao: 'retrocesso' });
    expect(decidir('TOCANDO', 'FEITA', { tipo: 'tocando_no_cliente' })).toEqual(
      {
        aplicar: false,
        razao: 'retrocesso',
      },
    );
    expect(
      decidir('EM_ANDAMENTO', 'FEITA', { tipo: 'cliente_atendeu' }),
    ).toEqual({
      aplicar: false,
      razao: 'retrocesso',
    });
    // Duas confirmações de atendimento na recebida.
    expect(
      decidir('EM_ANDAMENTO', 'RECEBIDA', { tipo: 'atendida_pelo_atendente' }),
    ).toMatchObject({ aplicar: false });
    // O tempo de toque esgotando depois de atendida não derruba a ligação.
    expect(
      decidir('EM_ANDAMENTO', 'RECEBIDA', { tipo: 'tempo_de_toque_esgotado' }),
    ).toMatchObject({ aplicar: false });
  });

  it('R29.1 — eventos que não fazem sentido para a direção são ignorados', () => {
    expect(
      decidir('TOCANDO', 'RECEBIDA', { tipo: 'cliente_atendeu' }),
    ).toMatchObject({ aplicar: false, razao: 'invalido' });
    expect(
      decidir('TOCANDO', 'RECEBIDA', { tipo: 'cliente_recusou' }),
    ).toMatchObject({ aplicar: false });
    expect(
      decidir('TOCANDO', 'FEITA', { tipo: 'atendida_pelo_atendente' }),
    ).toMatchObject({ aplicar: false, razao: 'invalido' });
    expect(
      decidir('TOCANDO', 'FEITA', { tipo: 'tempo_de_toque_esgotado' }),
    ).toMatchObject({ aplicar: false });
    expect(
      decidir('EM_ANDAMENTO', 'FEITA', { tipo: 'cancelada_pelo_atendente' }),
    ).toMatchObject({ aplicar: false });
  });

  it('R29.1 — nenhuma sequência de eventos regride um estado ativo (varredura)', () => {
    for (const direcao of ['RECEBIDA', 'FEITA'] as const) {
      for (const inicial of ESTADOS.filter((e) => !ehTerminal(e))) {
        for (const evento of EVENTOS) {
          const decisao = decidir(inicial, direcao, evento);
          if (decisao.aplicar) {
            expect(
              decisao.estado === inicial ||
                avanca(inicial, decisao.estado) ||
                ehTerminal(decisao.estado),
            ).toBe(true);
          }
        }
      }
    }
  });
});
