import { permissaoNaJanelaOficial } from './adaptador-whatsapp-oficial';
import {
  componentesDoEnvio,
  corpoDeMidia,
  corpoDeTemplate,
  corpoDeTexto,
  estruturaDoTemplate,
  textoDoTemplate,
  valoresQueFaltam,
} from './formato-meta';

const componentes = [
  { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
  { type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} saiu para entrega.' },
  { type: 'FOOTER', text: 'Equipe BRL' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Ok' },
      { type: 'URL', text: 'Rastrear', url: 'https://brl.com/r/{{1}}' },
    ],
  },
];

describe('WhatsApp oficial (R28) — formatos da Meta', () => {
  it('R28.4 — a janela de 24 h vale até janelaAte; fora dela só template', () => {
    const agora = new Date('2026-11-02T12:00:00Z');
    expect(
      permissaoNaJanelaOficial(
        { janelaAte: new Date('2026-11-02T12:00:01Z') },
        agora,
      ),
    ).toEqual({ pode: true });
    const fechada = permissaoNaJanelaOficial({ janelaAte: agora }, agora);
    expect(fechada).toMatchObject({ pode: false, apenasTemplate: true });
    expect(fechada.motivo).toContain('template');
    expect(permissaoNaJanelaOficial({ janelaAte: null }, agora).pode).toBe(
      false,
    );
  });

  it('R28.3 — corpos de texto e mídia (telefone em `to`, BSUID em `recipient`)', () => {
    expect(
      corpoDeTexto({ telefone: '5511999990000', bsuid: 'BR.1' }, 'Oi', {
        idExterno: 'wamid.0',
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999990000',
      type: 'text',
      text: { preview_url: true, body: 'Oi' },
      context: { message_id: 'wamid.0' },
    });
    expect(corpoDeTexto({ telefone: null, bsuid: 'BR.1' }, 'Oi')).toMatchObject(
      {
        recipient: 'BR.1',
      },
    );
    expect(
      corpoDeTexto({ telefone: null, bsuid: 'BR.1' }, 'Oi'),
    ).not.toHaveProperty('to');
    expect(
      corpoDeMidia({ telefone: '5511', bsuid: null }, 'DOCUMENTO', 'M1', {
        legenda: 'Contrato',
        nomeArquivo: 'c.pdf',
      }),
    ).toMatchObject({
      type: 'document',
      document: { id: 'M1', caption: 'Contrato', filename: 'c.pdf' },
    });
    // Áudio não leva legenda.
    expect(
      corpoDeMidia({ telefone: '5511', bsuid: null }, 'AUDIO', 'M2', {
        legenda: 'x',
      }),
    ).toMatchObject({ type: 'audio', audio: { id: 'M2' } });
  });

  it('R28.4 — lê o template, preenche as variáveis e monta os components do envio', () => {
    const estrutura = estruturaDoTemplate(componentes);
    expect(estrutura.cabecalho).toMatchObject({
      formato: 'TEXT',
      variaveis: ['1'],
    });
    expect(estrutura.corpo.variaveis).toEqual(['1', '2']);
    expect(estrutura.botoes.map((b) => [b.tipo, b.variaveis])).toEqual([
      ['QUICK_REPLY', []],
      ['URL', ['1']],
    ]);
    const valores = {
      cabecalho: ['#77'],
      corpo: ['Maria', '#77'],
      botoes: [null, 'abc'],
    };
    expect(valoresQueFaltam(estrutura, valores)).toEqual([]);
    expect(valoresQueFaltam(estrutura, { corpo: ['Maria'] })).toEqual([
      'cabeçalho {{1}}',
      'corpo {{2}}',
      'botão "Rastrear"',
    ]);
    expect(textoDoTemplate(estrutura, valores)).toBe(
      'Pedido #77\n\nOlá Maria, seu pedido #77 saiu para entrega.\n\nEquipe BRL',
    );
    expect(componentesDoEnvio(estrutura, valores)).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: '#77' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Maria' },
          { type: 'text', text: '#77' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '1',
        parameters: [{ type: 'text', text: 'abc' }],
      },
    ]);
    expect(
      corpoDeTemplate({ telefone: '5511', bsuid: null }, 'pedido', 'pt_BR', []),
    ).toMatchObject({
      type: 'template',
      template: { name: 'pedido', language: { code: 'pt_BR' } },
    });
  });

  it('R28.4 — template com cabeçalho de mídia leva o id da mídia', () => {
    const estrutura = estruturaDoTemplate([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Promoção!' },
    ]);
    expect(componentesDoEnvio(estrutura, {}, 'M9')).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'M9' } }] },
    ]);
  });
});
