import {
  agenteDoEvento,
  chaveDoEvento,
  decidirChamada,
  ehReceptiva,
  estadoDoAgente,
  lerChamada,
  lerDuracao,
  lerHistorico,
  normalizarEvento,
} from './eventos';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('eventos do socket do 3C+ (R34.4)', () => {
  describe('envelope', () => {
    const dados = { call: { id: 'c1', phone: '11987654321' } };

    it('OBJETO: o nome do evento do socket é o tipo', () => {
      expect(normalizarEvento('call-was-created', [dados], 'OBJETO')).toEqual({
        tipo: 'call-was-created',
        dados,
      });
      expect(normalizarEvento('message', [dados], 'OBJETO')).toBeNull();
    });

    it('EVENTO_DADOS: {event, data} em qualquer evento do socket', () => {
      const envelope = { event: 'call-was-answered', data: dados };
      expect(normalizarEvento('message', [envelope], 'EVENTO_DADOS')).toEqual({
        tipo: 'call-was-answered',
        dados,
      });
      expect(
        normalizarEvento(
          'message',
          [{ type: 'agent-is-idle', agent: { id: 1 } }],
          'EVENTO_DADOS',
        ),
      ).toEqual({
        tipo: 'agent-is-idle',
        dados: { type: 'agent-is-idle', agent: { id: 1 } },
      });
    });

    it('AUTO: tenta o nome do evento e depois o envelope; ignora o que não conhece', () => {
      expect(normalizarEvento('call-was-created', [dados])?.tipo).toBe(
        'call-was-created',
      );
      expect(
        normalizarEvento('evento', [{ event: 'call-was-ended', data: dados }])
          ?.tipo,
      ).toBe('call-was-ended');
      expect(normalizarEvento('ping', [{}])).toBeNull();
      expect(
        normalizarEvento('evento', [{ event: 'desconhecido', data: {} }]),
      ).toBeNull();
      expect(normalizarEvento('call-was-created', [])?.dados).toEqual({});
    });
  });

  describe('campos', () => {
    it('lê a chamada, o agente, a campanha e o identifier', () => {
      const chamada = lerChamada({
        call: {
          id: 99,
          phone: '11987654321',
          mode: 'manual',
          agent: { id: 7, name: 'Ana' },
          campaign: { id: 3, name: 'Vendas' },
          mailing_data: { identifier: ID },
        },
      });
      expect(chamada).toEqual({
        id: '99',
        telefone: '5511987654321',
        telefoneBruto: '11987654321',
        modo: 'manual',
        agente: { id: 7, nome: 'Ana' },
        campanhaId: 3,
        campanhaNome: 'Vendas',
        identifier: ID,
      });
      expect(lerChamada({ call: { phone: '1' } })).toBeNull();
    });

    it('o agente vem do evento de agente ou da chamada, por id, objeto ou nome', () => {
      expect(agenteDoEvento({ agent: { id: '5', name: 'Bia' } })).toEqual({
        id: 5,
        nome: 'Bia',
      });
      expect(agenteDoEvento({ call: { id: 'x', agent: 9 } })).toEqual({
        id: 9,
        nome: null,
      });
      expect(agenteDoEvento({ call: { id: 'x', agent: 'Carlos' } })).toEqual({
        id: null,
        nome: 'Carlos',
      });
      expect(agenteDoEvento({})).toEqual({ id: null, nome: null });
    });

    it('receptiva: reconhece os valores conhecidos de mode, type e direction', () => {
      expect(ehReceptiva({ call: { mode: 'receptive' } })).toBe(true);
      expect(ehReceptiva({ call: { type: 'inbound' } })).toBe(true);
      expect(ehReceptiva({ call: { mode: 'manual' } })).toBe(false);
      expect(ehReceptiva({ call: { mode: 'dialer' } })).toBe(false);
    });
  });

  describe('estado da ligação', () => {
    it('feita: CHAMANDO → TOCANDO (atendeu) → EM_ANDAMENTO → ENCERRADA', () => {
      expect(
        decidirChamada('CHAMANDO', 'FEITA', 'call-was-answered')?.estado,
      ).toBe('TOCANDO');
      expect(
        decidirChamada('TOCANDO', 'FEITA', 'call-was-connected')?.estado,
      ).toBe('EM_ANDAMENTO');
      expect(decidirChamada('EM_ANDAMENTO', 'FEITA', 'call-was-ended')).toEqual(
        {
          estado: 'ENCERRADA',
          motivo: 'concluida',
        },
      );
    });

    it('estados ativos só avançam e o terminal nunca muda', () => {
      expect(
        decidirChamada('EM_ANDAMENTO', 'FEITA', 'call-was-answered'),
      ).toBeNull();
      expect(
        decidirChamada('EM_ANDAMENTO', 'FEITA', 'call-was-created'),
      ).toBeNull();
      expect(
        decidirChamada('ENCERRADA', 'FEITA', 'call-was-failed'),
      ).toBeNull();
      expect(
        decidirChamada('SEM_RESPOSTA', 'FEITA', 'call-was-connected'),
      ).toBeNull();
    });

    it('fim sem ter conectado: SEM_RESPOSTA (feita) ou PERDIDA (recebida)', () => {
      expect(
        decidirChamada('CHAMANDO', 'FEITA', 'call-was-finished')?.estado,
      ).toBe('SEM_RESPOSTA');
      expect(
        decidirChamada('TOCANDO', 'RECEBIDA', 'call-was-ended')?.estado,
      ).toBe('PERDIDA');
    });

    it('não atendida, abandonada e falha', () => {
      expect(
        decidirChamada('CHAMANDO', 'FEITA', 'call-was-not-answered')?.estado,
      ).toBe('SEM_RESPOSTA');
      expect(
        decidirChamada('TOCANDO', 'FEITA', 'call-was-abandoned')?.estado,
      ).toBe('PERDIDA');
      expect(
        decidirChamada('TOCANDO', 'FEITA', 'call-was-abandoned-due-amd')
          ?.motivo,
      ).toBe('abandonada_secretaria');
      expect(
        decidirChamada('CHAMANDO', 'FEITA', 'call-was-failed')?.estado,
      ).toBe('FALHOU');
    });

    it('eventos de pós-atendimento não mudam a ligação', () => {
      expect(
        decidirChamada('EM_ANDAMENTO', 'FEITA', 'manual-call-acw-connected'),
      ).toBeNull();
    });
  });

  describe('estado do agente', () => {
    it('mapeia os eventos de agente', () => {
      expect(estadoDoAgente('agent-is-idle')).toBe('ocioso');
      expect(estadoDoAgente('agent-in-acw')).toBe('pos_atendimento');
      expect(estadoDoAgente('agent-entered-manual')).toBe('manual');
      expect(estadoDoAgente('agent-entered-work-break')).toBe('pausa');
      expect(estadoDoAgente('agent-was-logged-out')).toBe('desconectado');
      expect(estadoDoAgente('call-was-connected')).toBe('em_ligacao');
      expect(estadoDoAgente('call-was-created')).toBeNull();
    });
  });

  describe('deduplicação', () => {
    it('a chave é evento + chamada; evento de agente não tem chave', () => {
      expect(chaveDoEvento('call-was-created', { call: { id: 'c1' } })).toBe(
        'call-was-created:c1',
      );
      expect(
        chaveDoEvento('call-history-was-created', { call: { id: 'c1' } }),
      ).toBe('call-history-was-created:c1');
      expect(chaveDoEvento('agent-is-idle', { agent: { id: 1 } })).toBeNull();
      expect(chaveDoEvento('call-was-created', {})).toBeNull();
    });
  });

  describe('histórico', () => {
    it('duração em segundos, "mm:ss" e "hh:mm:ss"', () => {
      expect(lerDuracao(90)).toBe(90);
      expect(lerDuracao('90')).toBe(90);
      expect(lerDuracao('01:30')).toBe(90);
      expect(lerDuracao('1:01:30')).toBe(3690);
      expect(lerDuracao('x')).toBeNull();
      expect(lerDuracao(-1)).toBeNull();
    });

    it('lê tempo falado, qualificação, observação, data, causa e gravação', () => {
      const h = lerHistorico({
        call: {
          id: 'c1',
          number: '11987654321',
          agent: { id: 4 },
          speaking_time: '00:45',
          billed_time: 60,
          call_date: '2026-11-12 10:00:00',
          qualification: { id: 8, name: 'Interessado', conversion: true },
          qualification_note: 'Pediu proposta',
          hangup_cause: 'NORMAL_CLEARING',
          recording: 'https://x/rec.mp3',
        },
      });
      expect(h).toMatchObject({
        faladoSegundos: 45,
        cobradoSegundos: 60,
        qualificacao: { id: 8, nome: 'Interessado', conversao: true },
        observacao: 'Pediu proposta',
        causaDoFim: 'NORMAL_CLEARING',
        temGravacao: true,
      });
      // `call_date` sem fuso é horário de Brasília.
      expect(h?.dataDaChamada?.toISOString()).toBe('2026-11-12T13:00:00.000Z');
    });

    it('qualificação só com o nome e registro sem gravação', () => {
      const h = lerHistorico({
        id: 'c2',
        number: '11987654321',
        qualification: 'Sem interesse',
      });
      expect(h?.qualificacao).toEqual({
        id: null,
        nome: 'Sem interesse',
        conversao: null,
      });
      expect(h?.temGravacao).toBe(false);
    });
  });
});
