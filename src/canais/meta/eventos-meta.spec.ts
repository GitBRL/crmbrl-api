import {
  entradasDoWebhook,
  eventosDaEntrada,
  idDoCanalNaMeta,
  lerConfiguracaoMeta,
  tipoDaMensagemDoAnexo,
  tipoDoAnexoParaEnvio,
} from './eventos-meta';
import { ErroDaGraph } from './graph-api';

describe('Meta (R14) — eventos do webhook', () => {
  const agora = new Date('2026-10-23T12:00:00Z');

  it('separa as entradas por canal; object desconhecido ou corpo estranho → nada', () => {
    expect(
      entradasDoWebhook({
        object: 'page',
        entry: [{ id: '1', messaging: [] }, { id: 2 }, { sem: 'id' }],
      }),
    ).toEqual([
      { tipo: 'MESSENGER', idDoCanal: '1', bruta: { id: '1', messaging: [] } },
      { tipo: 'MESSENGER', idDoCanal: '2', bruta: { id: 2 } },
    ]);
    expect(
      entradasDoWebhook({ object: 'instagram', entry: [{ id: '17841' }] })[0]
        .tipo,
    ).toBe('INSTAGRAM');
    expect(
      entradasDoWebhook({
        object: 'whatsapp_business_account',
        entry: [{ id: '1' }],
      }),
    ).toEqual([]);
    expect(entradasDoWebhook('lixo')).toEqual([]);
    expect(entradasDoWebhook(null)).toEqual([]);
  });

  it('lê mensagens (texto, anexos, citação), botões, entregas, leituras e reações; ignora ecos e apagadas', () => {
    const eventos = eventosDaEntrada(
      {
        id: 'pagina',
        messaging: [
          {
            sender: { id: 'psid' },
            timestamp: 1761220800000,
            message: {
              mid: 'm_1',
              text: 'Oi',
              reply_to: { mid: 'm_0' },
              attachments: [
                { type: 'image', payload: { url: 'https://cdn/x.jpg' } },
                { type: 'share', payload: {} },
              ],
            },
          },
          {
            sender: { id: 'pagina' },
            message: { mid: 'm_eco', text: 'x', is_echo: true },
          },
          {
            sender: { id: 'psid' },
            message: { mid: 'm_apagada', is_deleted: true },
          },
          {
            sender: { id: 'psid' },
            postback: {
              title: 'Quero orçamento',
              payload: 'ORCAMENTO',
              mid: 'm_pb',
            },
          },
          {
            sender: { id: 'psid' },
            delivery: { mids: ['m_9', 3], watermark: 1761220900000 },
          },
          { sender: { id: 'psid' }, read: { watermark: 1761221000000 } },
          {
            sender: { id: 'psid' },
            reaction: { mid: 'm_9', action: 'react', emoji: '❤' },
          },
          {
            sender: { id: 'psid' },
            reaction: { mid: 'm_9', action: 'unreact' },
          },
          { recipient: { id: 'sem-remetente' }, message: { mid: 'm_x' } },
        ],
      },
      agora,
    );
    expect(eventos).toEqual([
      {
        tipo: 'mensagem',
        remetente: 'psid',
        mid: 'm_1',
        texto: 'Oi',
        anexos: [
          { tipo: 'image', url: 'https://cdn/x.jpg', titulo: null },
          { tipo: 'share', url: null, titulo: null },
        ],
        respondeA: 'm_0',
        em: new Date(1761220800000),
      },
      {
        tipo: 'mensagem',
        remetente: 'psid',
        mid: 'm_pb',
        texto: 'Quero orçamento',
        anexos: [],
        respondeA: null,
        em: agora,
      },
      {
        tipo: 'entrega',
        remetente: 'psid',
        mids: ['m_9'],
        em: new Date(1761220900000),
      },
      {
        tipo: 'leitura',
        remetente: 'psid',
        ate: new Date(1761221000000),
        mid: null,
      },
      { tipo: 'reacao', remetente: 'psid', mid: 'm_9', emoji: '❤', em: agora },
    ]);
  });

  it('tipos de anexo, na entrada e no envio', () => {
    expect(tipoDaMensagemDoAnexo('image')).toBe('IMAGEM');
    expect(tipoDaMensagemDoAnexo('ig_reel')).toBe('VIDEO');
    expect(tipoDaMensagemDoAnexo('file')).toBe('DOCUMENTO');
    expect(tipoDaMensagemDoAnexo('share')).toBeNull();
    expect(tipoDoAnexoParaEnvio('image/png')).toBe('image');
    expect(tipoDoAnexoParaEnvio('audio/ogg')).toBe('audio');
    expect(tipoDoAnexoParaEnvio('application/pdf')).toBe('file');
  });

  it('configuração: o id do canal na Meta é a página (Messenger) ou a conta (Instagram)', () => {
    const config = lerConfiguracaoMeta({
      appId: '1',
      pageId: '22',
      instagramId: '333',
      outro: 1,
    });
    expect(config).toEqual({ appId: '1', pageId: '22', instagramId: '333' });
    expect(idDoCanalNaMeta('MESSENGER', config)).toBe('22');
    expect(idDoCanalNaMeta('INSTAGRAM', config)).toBe('333');
    expect(lerConfiguracaoMeta(null)).toEqual({
      appId: '',
      pageId: '',
      instagramId: null,
    });
  });

  it('classifica os erros da Graph API', () => {
    const janela = new ErroDaGraph(
      '(#10) This message is sent outside of allowed window.',
      400,
      10,
      2018278,
    );
    expect([
      janela.foraDaJanela,
      janela.tokenInvalido,
      janela.passageiro,
    ]).toEqual([true, false, false]);
    const token = new ErroDaGraph('Invalid OAuth access token', 400, 190, null);
    expect([token.foraDaJanela, token.tokenInvalido, token.passageiro]).toEqual(
      [false, true, false],
    );
    expect(new ErroDaGraph('limite', 400, 613, null).passageiro).toBe(true);
    expect(new ErroDaGraph('fora do ar', 503, null, null).passageiro).toBe(
      true,
    );
    expect(new ErroDaGraph('rede', 0, null, null).passageiro).toBe(true);
    expect(new ErroDaGraph('param', 400, 100, null).passageiro).toBe(false);
  });
});
