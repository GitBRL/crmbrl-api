import {
  conteudoDaMensagem,
  eventosDoValor,
  mudancasDoWebhook,
  telefoneDaMeta,
  textoDoConteudo,
} from './eventos-oficial';

const metadata = {
  display_phone_number: '551100000000',
  phone_number_id: '100',
};

describe('WhatsApp oficial (R28) — webhook', () => {
  const agora = new Date('2026-11-02T12:00:00Z');

  it('R28.2 — separa as mudanças por número e campo; object ou corpo estranho → nada', () => {
    expect(
      mudancasDoWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA',
            changes: [
              { field: 'messages', value: { metadata, messages: [] } },
              {
                field: 'calls',
                value: { metadata: { phone_number_id: '200' } },
              },
              { field: 'messages', value: { sem: 'metadata' } },
            ],
          },
        ],
      }).map(({ phoneNumberId, waba, campo }) => [phoneNumberId, waba, campo]),
    ).toEqual([
      ['100', 'WABA', 'messages'],
      ['200', 'WABA', 'calls'],
    ]);
    expect(mudancasDoWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(mudancasDoWebhook(null)).toEqual([]);
    expect(mudancasDoWebhook('lixo')).toEqual([]);
  });

  it('R28.5 — lê o texto, o nome do perfil, o telefone só com dígitos e a citação', () => {
    const [evento] = eventosDoValor(
      {
        metadata,
        contacts: [{ profile: { name: 'Maria' }, wa_id: '5511999990000' }],
        messages: [
          {
            from: '5511999990000',
            id: 'wamid.1',
            timestamp: '1761230000',
            type: 'text',
            text: { body: 'Oi' },
            context: { id: 'wamid.0' },
          },
        ],
      },
      agora,
    );
    expect(evento).toEqual({
      tipo: 'mensagem',
      id: 'wamid.1',
      remetente: { telefone: '5511999990000', bsuid: null, nome: 'Maria' },
      em: new Date(1761230000 * 1000),
      conteudo: { tipo: 'texto', corpo: 'Oi' },
      respondeAId: 'wamid.0',
    });
  });

  it('R28.5 — mídia (imagem com legenda, áudio, documento, figurinha)', () => {
    expect(
      conteudoDaMensagem({
        type: 'image',
        image: { id: 'M1', mime_type: 'image/jpeg', caption: 'Veja' },
      }),
    ).toMatchObject({
      tipo: 'midia',
      tipoMensagem: 'IMAGEM',
      mediaId: 'M1',
      legenda: 'Veja',
    });
    expect(
      conteudoDaMensagem({ type: 'audio', audio: { id: 'M2', voice: true } }),
    ).toMatchObject({ tipoMensagem: 'AUDIO', voz: true });
    expect(
      conteudoDaMensagem({
        type: 'document',
        document: { id: 'M3', filename: 'contrato.pdf' },
      }),
    ).toMatchObject({ tipoMensagem: 'DOCUMENTO', nomeArquivo: 'contrato.pdf' });
    expect(
      conteudoDaMensagem({ type: 'sticker', sticker: { id: 'M4' } }),
    ).toMatchObject({ tipoMensagem: 'FIGURINHA' });
  });

  it('R28.5 — localização, contatos, botão, lista, reação e tipo desconhecido', () => {
    expect(
      conteudoDaMensagem({
        type: 'location',
        location: { latitude: -23.5, longitude: -46.6, name: 'Loja' },
      }),
    ).toEqual({
      tipo: 'localizacao',
      latitude: -23.5,
      longitude: -46.6,
      nome: 'Loja',
      endereco: null,
    });
    expect(
      conteudoDaMensagem({ type: 'location', location: { latitude: 1 } }),
    ).toEqual({ tipo: 'nao_suportado', tipoOriginal: 'location' });
    const contatos = conteudoDaMensagem({
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'João Silva' },
          phones: [{ phone: '+55 11 98888-7777' }],
        },
      ],
    });
    expect(contatos).toMatchObject({
      tipo: 'contatos',
      contatos: [{ nome: 'João Silva', telefones: ['+55 11 98888-7777'] }],
    });
    expect(textoDoConteudo(contatos)).toBe('João Silva');
    expect(
      conteudoDaMensagem({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'sim', title: 'Sim' },
        },
      }),
    ).toEqual({
      tipo: 'interativo',
      origem: 'button_reply',
      id: 'sim',
      titulo: 'Sim',
      descricao: null,
    });
    expect(
      conteudoDaMensagem({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'a', title: 'Plano A', description: 'Mensal' },
        },
      }),
    ).toMatchObject({ origem: 'list_reply', descricao: 'Mensal' });
    expect(
      conteudoDaMensagem({
        type: 'reaction',
        reaction: { message_id: 'wamid.9', emoji: '👍' },
      }),
    ).toEqual({ tipo: 'reacao', mensagemAlvo: 'wamid.9', emoji: '👍' });
    expect(
      conteudoDaMensagem({ type: 'reaction', reaction: { message_id: 'w' } }),
    ).toMatchObject({ emoji: '' });
    expect(conteudoDaMensagem({ type: 'order' })).toEqual({
      tipo: 'nao_suportado',
      tipoOriginal: 'order',
    });
  });

  it('R28.6 — sem telefone, o remetente é o BSUID (do `from_user_id` ou do contato)', () => {
    const eventos = eventosDoValor(
      {
        metadata,
        contacts: [
          {
            profile: { username: 'maria.s' },
            user_id: 'BR.123',
            parent_user_id: 'BR.P',
          },
        ],
        messages: [
          {
            from_user_id: 'BR.123',
            id: 'w1',
            type: 'text',
            text: { body: 'a' },
          },
        ],
      },
      agora,
    );
    expect(eventos[0]).toMatchObject({
      remetente: { telefone: null, bsuid: 'BR.123', nome: 'maria.s' },
    });
    const comOs2 = eventosDoValor(
      {
        metadata,
        contacts: [
          {
            profile: { name: 'Maria' },
            wa_id: '5511999990000',
            user_id: 'BR.123',
          },
        ],
        messages: [
          {
            from: '5511999990000',
            id: 'w2',
            type: 'text',
            text: { body: 'b' },
          },
        ],
      },
      agora,
    );
    expect(comOs2[0]).toMatchObject({
      remetente: { telefone: '5511999990000', bsuid: 'BR.123' },
    });
  });

  it('R28.7 — status: enviada, entregue, lida e falhou (motivo em português); outros ignorados', () => {
    const eventos = eventosDoValor(
      {
        metadata,
        statuses: [
          { id: 'a', status: 'sent', timestamp: '1761230001' },
          { id: 'b', status: 'delivered', timestamp: '1761230002' },
          { id: 'c', status: 'read', timestamp: '1761230003' },
          {
            id: 'd',
            status: 'failed',
            timestamp: '1761230004',
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          },
          {
            id: 'e',
            status: 'failed',
            errors: [{ code: 999999, title: 'Coisa nova' }],
          },
          { id: 'f', status: 'played' },
          { status: 'sent' },
        ],
      },
      agora,
    );
    expect(eventos.map((e) => e.tipo === 'status' && [e.id, e.status])).toEqual(
      [
        ['a', 'ENVIADA'],
        ['b', 'ENTREGUE'],
        ['c', 'LIDA'],
        ['d', 'FALHOU'],
        ['e', 'FALHOU'],
      ],
    );
    const falhas = eventos.filter((e) => e.tipo === 'status' && e.erro);
    expect(falhas[0]).toMatchObject({
      codigoDoErro: 131047,
      erro: expect.stringContaining('24 horas'),
    });
    expect(falhas[1]).toMatchObject({
      erro: 'A Meta não entregou a mensagem: Coisa nova',
    });
  });

  it('telefoneDaMeta aceita + e espaços e recusa o que não é telefone', () => {
    expect(telefoneDaMeta('+55 (11) 99999-0000')).toBe('5511999990000');
    expect(telefoneDaMeta('BR.123')).toBeNull();
    expect(telefoneDaMeta(null)).toBeNull();
  });
});
