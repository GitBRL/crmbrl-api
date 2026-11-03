import {
  contarPalavras,
  ehRuido,
  intercalar,
  marcaDeTempo,
  prepararCanal,
  textoDaConversa,
} from './trechos';

describe('R30 — trechos da transcrição', () => {
  it('R30.20 — intercala os dois canais por tempo, atendente primeiro no empate', () => {
    const atendente = prepararCanal('atendente', [
      { inicio: 0, fim: 3, texto: ' Bom dia, em que posso ajudar? ' },
      { inicio: 10, fim: 12, texto: 'Claro, envio hoje.' },
    ]);
    const cliente = prepararCanal('cliente', [
      { inicio: 0, fim: 2, texto: 'Alô' },
      { inicio: 4, fim: 9, texto: 'Quero a proposta.' },
    ]);
    const conversa = intercalar([cliente, atendente]);
    expect(conversa.map((t) => [t.falante, t.inicio])).toEqual([
      ['atendente', 0],
      ['cliente', 0],
      ['cliente', 4],
      ['atendente', 10],
    ]);
    expect(conversa[0].texto).toBe('Bom dia, em que posso ajudar?');
  });

  it('R30.20 — junta trechos seguidos do mesmo falante com pausa curta, mas não com pausa longa', () => {
    const juntos = intercalar([
      prepararCanal('cliente', [
        { inicio: 0, fim: 2, texto: 'Eu queria' },
        { inicio: 2.5, fim: 4, texto: 'saber o preço.' },
        { inicio: 20, fim: 22, texto: 'Obrigado.' },
      ]),
    ]);
    expect(juntos).toEqual([
      {
        falante: 'cliente',
        inicio: 0,
        fim: 4,
        texto: 'Eu queria saber o preço.',
      },
      { falante: 'cliente', inicio: 20, fim: 22, texto: 'Obrigado.' },
    ]);
  });

  it('R30.20 — não junta por cima da fala do outro lado', () => {
    const conversa = intercalar([
      prepararCanal('cliente', [
        { inicio: 0, fim: 2, texto: 'Primeiro' },
        { inicio: 3, fim: 4, texto: 'segundo' },
      ]),
      prepararCanal('atendente', [{ inicio: 2.4, fim: 2.8, texto: 'Sei.' }]),
    ]);
    expect(conversa.map((t) => t.falante)).toEqual([
      'cliente',
      'atendente',
      'cliente',
    ]);
  });

  it('R30.20 — descarta ruído e alucinações do Whisper em silêncio', () => {
    for (const ruido of [
      '',
      '   ',
      '[BLANK_AUDIO]',
      '(música)',
      '♪ ♪',
      'Legendas pela comunidade Amara.org',
      '...',
    ]) {
      expect(ehRuido(ruido)).toBe(true);
    }
    expect(ehRuido('Boa tarde')).toBe(false);
    expect(
      prepararCanal('cliente', [
        { inicio: 0, fim: 1, texto: '[BLANK_AUDIO]' },
        { inicio: 1, fim: 2, texto: 'Oi' },
      ]),
    ).toHaveLength(1);
  });

  it('R30.20 — corrige tempos inválidos', () => {
    const [t] = prepararCanal('cliente', [
      { inicio: -3, fim: -5, texto: 'Oi' },
    ]);
    expect(t.inicio).toBe(0);
    expect(t.fim).toBe(0);
  });

  it('R30.20 — texto da conversa com rótulos e marcas de tempo', () => {
    expect(marcaDeTempo(72)).toBe('1:12');
    expect(marcaDeTempo(3725)).toBe('1:02:05');
    const trechos = intercalar([
      prepararCanal('atendente', [{ inicio: 0, fim: 1, texto: 'Oi' }]),
      prepararCanal('participante', [{ inicio: 5, fim: 6, texto: 'Sim' }]),
    ]);
    expect(textoDaConversa(trechos)).toBe(
      '[0:00] Atendente: Oi\n[0:05] Participante: Sim',
    );
    expect(contarPalavras(trechos)).toBe(2);
  });
});
