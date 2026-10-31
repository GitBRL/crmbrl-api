import {
  conferirResposta,
  ESQUEMA_RESPOSTA,
  RespostaInvalidaError,
} from './esquema-analise';

describe('formato da resposta da análise por IA (R21)', () => {
  it('R21 — o JSON Schema só usa o que a saída estruturada aceita', () => {
    const texto = JSON.stringify(ESQUEMA_RESPOSTA);
    for (const proibido of [
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
    ]) {
      expect(texto).not.toContain(proibido);
    }
    // Todo objeto fecha com additionalProperties: false.
    const objetos = texto.match(/"type":"object"/g)?.length ?? 0;
    const fechados = texto.match(/"additionalProperties":false/g)?.length ?? 0;
    expect(fechados).toBe(objetos);
  });

  it('R21 — confere, corta textos longos e normaliza opções', () => {
    const r = conferirResposta({
      resumo: '  Bom mês.  ',
      destaques: [
        { titulo: 'A', detalhe: 'x'.repeat(2000), tendencia: 'estranha' },
      ],
      riscos: [{ titulo: 'R', detalhe: 'd', gravidade: 'alta' }],
      acoes: Array.from({ length: 12 }, (_, i) => ({
        titulo: `Ação ${i}`,
        detalhe: 'd',
        prioridade: 'media',
        link: '/bi/cs',
        rotuloLink: '',
      })),
    });
    expect(r.resumo).toBe('Bom mês.');
    expect(r.destaques[0].detalhe.length).toBeLessThanOrEqual(800);
    expect(r.destaques[0].tendencia).toBe('neutra');
    expect(r.acoes).toHaveLength(8);
    expect(r.acoes[0].rotuloLink).toBe('Ver a lista');
  });

  it('R21 — formato errado lança RespostaInvalidaError', () => {
    expect(() => conferirResposta([])).toThrow(RespostaInvalidaError);
    expect(() =>
      conferirResposta({ resumo: '', destaques: [], riscos: [], acoes: [] }),
    ).toThrow(RespostaInvalidaError);
    expect(() =>
      conferirResposta({ resumo: 'ok', destaques: 'x', riscos: [], acoes: [] }),
    ).toThrow(RespostaInvalidaError);
  });
});
