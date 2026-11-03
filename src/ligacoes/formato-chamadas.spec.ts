import {
  chaveDeDedupe,
  corpoDeAcao,
  corpoDeConfiguracao,
  corpoDeConnect,
  corpoDePedidoInterativo,
  eventosDeChamadas,
  falhaDeMidia,
  idDaChamadaCriada,
  permissaoDaMeta,
  respostaDePermissao,
  temComponenteDePermissao,
  traduzirErroDeChamada,
} from './formato-chamadas';

const connectRecebido = {
  messaging_product: 'whatsapp',
  metadata: { phone_number_id: '100', display_phone_number: '5511940000001' },
  contacts: [
    {
      profile: { name: 'Maria' },
      wa_id: '5511999990001',
      user_id: 'BR.abc',
    },
  ],
  calls: [
    {
      id: 'wacid.A1',
      to: '5511940000001',
      from: '5511999990001',
      event: 'connect',
      timestamp: '1761230000',
      session: { sdp_type: 'offer', sdp: 'v=0 oferta' },
    },
  ],
};

describe('Webhook de chamadas da Meta (R29)', () => {
  it('R29.2 — connect recebido: direção pela oferta SDP, cliente pelo contacts[0]', () => {
    const [evento] = eventosDeChamadas(connectRecebido);
    expect(evento).toMatchObject({
      tipo: 'chamada',
      chamada: {
        id: 'wacid.A1',
        evento: 'connect',
        direcao: 'RECEBIDA',
        sdpTipo: 'offer',
        sdp: 'v=0 oferta',
      },
      cliente: { telefone: '5511999990001', bsuid: 'BR.abc', nome: 'Maria' },
    });
  });

  it('R29.3 — connect com resposta SDP (ligação feita), também em connection.webrtc.sdp', () => {
    const [feita] = eventosDeChamadas({
      calls: [
        {
          id: 'wacid.B1',
          event: 'connect',
          direction: 'BUSINESS_INITIATED',
          to: '5511999990001',
          session: { sdp_type: 'answer', sdp: 'v=0 resposta' },
          biz_opaque_callback_data: 'lig-1',
        },
      ],
    });
    expect(feita).toMatchObject({
      chamada: { direcao: 'FEITA', sdp: 'v=0 resposta', dadosOpacos: 'lig-1' },
      cliente: { telefone: '5511999990001' },
    });
    const [alternativa] = eventosDeChamadas({
      calls: [
        {
          id: 'wacid.B2',
          event: 'connect',
          connection: { webrtc: { sdp: 'v=0 alternativa' } },
          session: { sdp_type: 'answer' },
        },
      ],
    });
    expect(alternativa).toMatchObject({ chamada: { sdp: 'v=0 alternativa' } });
  });

  it('R29.2 — terminate: status em qualquer caixa, duração e erros', () => {
    const [encerrada] = eventosDeChamadas({
      contacts: [{ wa_id: '5511999990001' }],
      calls: [
        {
          id: 'wacid.A1',
          event: 'terminate',
          direction: 'USER_INITIATED',
          timestamp: '1761230100',
          status: 'Completed',
          start_time: '1761230010',
          end_time: '1761230100',
          duration: 90,
        },
        {
          id: 'wacid.A2',
          event: 'terminate',
          status: ['Failed', 'Completed'],
          errors: [{ code: 138021, message: 'sem mídia' }],
        },
      ],
    });
    expect(encerrada).toMatchObject({
      chamada: {
        direcao: 'RECEBIDA',
        status: 'COMPLETED',
        duracaoSegundos: 90,
      },
    });
    const calls = eventosDeChamadas({
      calls: [
        { id: 'x', event: 'terminate', status: ['Failed', 'Completed'] },
        { id: 'y', event: 'terminate', status: 'WEIRD' },
        { id: 'z', event: 'terminate' },
      ],
    }).map((e) => (e.tipo === 'chamada' ? e.chamada.status : null));
    expect(calls).toEqual(['FAILED', 'COMPLETED', null]);
  });

  it('R29.3 — statuses RINGING, ACCEPTED e REJECTED', () => {
    const eventos = eventosDeChamadas({
      statuses: [
        {
          id: 'wacid.B1',
          type: 'call',
          status: 'RINGING',
          timestamp: '1761230001',
          recipient_id: '5511999990001',
          biz_opaque_callback_data: 'lig-1',
        },
        { id: 'wacid.B1', type: 'message', status: 'sent' },
      ],
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      tipo: 'status',
      status: { id: 'wacid.B1', status: 'RINGING', dadosOpacos: 'lig-1' },
      cliente: { telefone: '5511999990001' },
    });
  });

  it('R29.2 — ignora chamadas sem id ou evento; corpo estranho vira lista vazia', () => {
    expect(
      eventosDeChamadas({ calls: [{ event: 'connect' }, 'x', null] }),
    ).toEqual([]);
    expect(eventosDeChamadas({})).toEqual([]);
  });

  it('R29.2 — chave de dedupe distingue oferta e resposta, e cada status', () => {
    const eventos = [
      ...eventosDeChamadas(connectRecebido),
      ...eventosDeChamadas({
        calls: [
          {
            id: 'wacid.A1',
            event: 'connect',
            session: { sdp_type: 'answer', sdp: 'x' },
          },
          { id: 'wacid.A1', event: 'terminate' },
        ],
        statuses: [{ id: 'wacid.A1', status: 'RINGING' }],
      }),
    ];
    const chaves = eventos.map((e) => chaveDeDedupe('c1', e));
    expect(new Set(chaves).size).toBe(4);
    expect(chaves[0]).toBe('c1:connect:wacid.A1:offer');
    expect(chaves[3]).toBe('c1:status:wacid.A1:RINGING');
  });
});

describe('Resposta de permissão (R29.4)', () => {
  it('R29.4 — call_permission_reply aprovado, temporário e permanente', () => {
    expect(
      respostaDePermissao({
        interactive: {
          type: 'call_permission_reply',
          call_permission_reply: {
            response: 'accept',
            is_permanent: false,
            expiration_timestamp: '1768550400',
            response_source: 'user_action',
          },
        },
        context: { id: 'wamid.PEDIDO' },
      }),
    ).toEqual({
      resposta: 'accept',
      permanente: false,
      expiraEm: new Date(1768550400 * 1000),
      origem: 'user_action',
      contextoId: 'wamid.PEDIDO',
    });
    expect(
      respostaDePermissao({
        interactive: {
          type: 'call_permission_reply',
          call_permission_reply: { response: 'accept', is_permanent: true },
        },
      }),
    ).toMatchObject({ permanente: true, expiraEm: null });
  });

  it('R29.4 — outras mensagens ou resposta desconhecida não são permissão', () => {
    expect(
      respostaDePermissao({ interactive: { type: 'button_reply' } }),
    ).toBeNull();
    expect(
      respostaDePermissao({
        interactive: {
          type: 'call_permission_reply',
          call_permission_reply: { response: 'talvez' },
        },
      }),
    ).toBeNull();
    expect(respostaDePermissao({ text: { body: 'oi' } })).toBeNull();
  });
});

describe('Corpos das chamadas à Graph (R29)', () => {
  it('R29.2 — pre_accept e accept levam a resposta SDP como "answer" (lacuna 5); reject e terminate, não', () => {
    expect(corpoDeAcao('pre_accept', 'wacid.A1', 'v=0')).toEqual({
      messaging_product: 'whatsapp',
      call_id: 'wacid.A1',
      action: 'pre_accept',
      session: { sdp_type: 'answer', sdp: 'v=0' },
    });
    expect(corpoDeAcao('terminate', 'wacid.A1')).toEqual({
      messaging_product: 'whatsapp',
      call_id: 'wacid.A1',
      action: 'terminate',
    });
  });

  it('R29.3 — connect leva a oferta, o destino e o id da ligação como dado opaco', () => {
    expect(
      corpoDeConnect(
        { telefone: '5511999990001', bsuid: 'BR.x' },
        'v=0',
        'lig-1',
      ),
    ).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999990001',
      action: 'connect',
      session: { sdp_type: 'offer', sdp: 'v=0' },
      biz_opaque_callback_data: 'lig-1',
    });
    expect(
      corpoDeConnect({ telefone: null, bsuid: 'BR.x' }, 'v=0', 'lig-1'),
    ).toMatchObject({ recipient: 'BR.x' });
    expect(idDaChamadaCriada({ calls: [{ id: 'wacid.B9' }] })).toBe('wacid.B9');
    expect(idDaChamadaCriada({})).toBeNull();
  });

  it('R29.6 — configuração liga e desliga as chamadas, sem call_hours e com SIP desligado', () => {
    expect(corpoDeConfiguracao(true)).toEqual({
      calling: {
        status: 'ENABLED',
        call_icon_visibility: 'DEFAULT',
        sip: { status: 'DISABLED' },
      },
    });
    expect(
      (corpoDeConfiguracao(false).calling as { status: string }).status,
    ).toBe('DISABLED');
  });

  it('R29.4 — pedido interativo e detecção do componente do template', () => {
    expect(
      corpoDePedidoInterativo({ telefone: '5511999990001', bsuid: null }, 'Oi'),
    ).toMatchObject({
      to: '5511999990001',
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: 'Oi' },
      },
    });
    expect(
      temComponenteDePermissao([
        { type: 'BODY' },
        { type: 'call_permission_request' },
      ]),
    ).toBe(true);
    expect(temComponenteDePermissao([{ type: 'BODY' }])).toBe(false);
    expect(temComponenteDePermissao(null)).toBe(false);
  });
});

describe('GET call_permissions e erros (R29.4, R29.5)', () => {
  it('R29.4 — lê status, expiração (as duas grafias) e limites', () => {
    const lida = permissaoDaMeta({
      permission: { status: 'temporary', expiration_time: 1745343479 },
      actions: [
        {
          action_name: 'send_call_permission_request',
          can_perform_action: true,
          limits: [
            { time_period: 'PT24H', max_allowed: 1, current_usage: 0 },
            { time_period: 'P7D', max_allowed: 2, current_usage: 1 },
          ],
        },
        {
          action_name: 'start_call',
          can_perform_action: false,
          limits: [
            {
              time_period: 'PT24H',
              max_allowed: 5,
              current_usage: 5,
              limit_expiration_time: 1745622600,
            },
          ],
        },
      ],
    });
    expect(lida.status).toBe('temporary');
    expect(lida.expiraEm).toEqual(new Date(1745343479 * 1000));
    expect(lida.pedir).toMatchObject({ pode: true });
    expect(lida.ligar).toMatchObject({ pode: false });
    expect(lida.ligar?.limites[0]).toMatchObject({
      maximo: 5,
      uso: 5,
      liberaEm: new Date(1745622600 * 1000),
    });
    expect(
      permissaoDaMeta({ permission: { status: 'temporary', expiration: 10 } })
        .expiraEm,
    ).toEqual(new Date(10_000));
    expect(permissaoDaMeta({}).status).toBe('no_permission');
    expect(
      permissaoDaMeta({ permission: { status: 'permanent' } }),
    ).toMatchObject({
      status: 'permanent',
      expiraEm: null,
      pedir: null,
    });
  });

  it('R29.5 — traduz os códigos da Calling API e cai num texto genérico', () => {
    expect(traduzirErroDeChamada(138006).motivo).toBe('sem_permissao');
    expect(traduzirErroDeChamada(138012).motivo).toBe('limite_diario');
    expect(traduzirErroDeChamada(131047).motivo).toBe('janela_fechada');
    expect(traduzirErroDeChamada(138009).motivo).toBe('limite_de_pedidos');
    expect(traduzirErroDeChamada(999999, 'Algo').mensagem).toContain('Algo');
    expect(traduzirErroDeChamada(null).motivo).toBe('erro_da_meta');
    expect(falhaDeMidia(138021)).toBe(true);
    expect(falhaDeMidia(138006)).toBe(false);
  });
});
