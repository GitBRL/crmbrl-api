import {
  type AmbienteDeCondicao,
  avaliarCondicao,
  compararValores,
  condicoesDoRamo,
  janelaFechadaEm,
  problemaDaCondicao,
} from './condicoes';

const AGORA = new Date('2026-11-04T15:00:00Z'); // quarta-feira, 12h em São Paulo

function ambiente(extra: Partial<AmbienteDeCondicao> = {}): AmbienteDeCondicao {
  return {
    variaveis: { assunto: 'Suporte', quantidade: '12' },
    contato: {
      nome: 'Ana Souza',
      email: 'ana@exemplo.com',
      etiquetas: ['VIP', 'Lead quente'],
      campos: { plano: 'Pro' },
    },
    canal: { id: 'canal-1', tipo: 'WHATSAPP', horarioAtendimento: null },
    agora: AGORA,
    ...extra,
  };
}

describe('R18 — condições do passo "se… então"', () => {
  it('R18.4 — compara variável sem acento nem caixa e com operadores numéricos', () => {
    expect(compararValores('Suporte', 'igual', 'suporte')).toBe(true);
    expect(compararValores('Preço alto', 'contem', 'PRECO')).toBe(true);
    expect(compararValores('abc', 'comeca_com', 'AB')).toBe(true);
    expect(compararValores('12', 'maior', 10)).toBe(true);
    expect(compararValores('abc', 'maior', 10)).toBe(false);
    expect(compararValores('', 'existe', undefined)).toBe(false);
    expect(compararValores(null, 'nao_existe', undefined)).toBe(true);
    expect(compararValores([], 'existe', undefined)).toBe(false);
  });

  it('R18.4 — variável, campo do contato (inclusive personalizado), etiqueta e canal', () => {
    const a = ambiente();
    expect(
      avaliarCondicao(
        {
          tipo: 'variavel',
          chave: 'assunto',
          operador: 'igual',
          valor: 'suporte',
        },
        a,
      ),
    ).toBe(true);
    expect(
      avaliarCondicao(
        {
          tipo: 'campo_contato',
          campo: 'campos.plano',
          operador: 'igual',
          valor: 'pro',
        },
        a,
      ),
    ).toBe(true);
    expect(
      avaliarCondicao(
        {
          tipo: 'campo_contato',
          campo: 'email',
          operador: 'contem',
          valor: '@exemplo',
        },
        a,
      ),
    ).toBe(true);
    expect(avaliarCondicao({ tipo: 'etiqueta', etiqueta: 'vip' }, a)).toBe(
      true,
    );
    expect(
      avaliarCondicao({ tipo: 'etiqueta', etiqueta: 'vip', tem: false }, a),
    ).toBe(false);
    expect(
      avaliarCondicao({ tipo: 'canal', canalTipos: ['WHATSAPP'] }, a),
    ).toBe(true);
    expect(avaliarCondicao({ tipo: 'canal', canalTipos: ['EMAIL'] }, a)).toBe(
      false,
    );
    expect(avaliarCondicao({ tipo: 'canal', canalIds: ['canal-1'] }, a)).toBe(
      true,
    );
  });

  it('R18.4 — horário: usa a janela do passo ou a do canal; sem janela = sempre aberto', () => {
    const semJanela = ambiente();
    expect(avaliarCondicao({ tipo: 'horario' }, semJanela)).toBe(true);
    expect(avaliarCondicao({ tipo: 'horario', dentro: false }, semJanela)).toBe(
      false,
    );
    const fechado = janelaFechadaEm(AGORA);
    expect(
      avaliarCondicao({ tipo: 'horario', janela: fechado }, semJanela),
    ).toBe(false);
    const doCanal = ambiente({
      canal: { id: 'c', tipo: 'WEBCHAT', horarioAtendimento: fechado },
    });
    expect(avaliarCondicao({ tipo: 'horario', dentro: false }, doCanal)).toBe(
      true,
    );
    const abre = {
      fusoHorario: 'America/Sao_Paulo',
      dias: { '3': [{ inicio: '08:00', fim: '18:00' }] },
    };
    expect(avaliarCondicao({ tipo: 'horario', janela: abre }, semJanela)).toBe(
      true,
    );
  });

  it('R18.4 — contato ausente nunca satisfaz condição de campo ou etiqueta', () => {
    const a = ambiente({ contato: null });
    expect(
      avaliarCondicao(
        { tipo: 'campo_contato', campo: 'nome', operador: 'existe' },
        a,
      ),
    ).toBe(false);
    expect(avaliarCondicao({ tipo: 'etiqueta', etiqueta: 'VIP' }, a)).toBe(
      false,
    );
  });

  it('R18.4 — lê as condições do ramo (uma, várias ou nenhuma = "senão")', () => {
    expect(condicoesDoRamo(undefined)).toEqual([]);
    expect(condicoesDoRamo({})).toEqual([]);
    expect(
      condicoesDoRamo({ condicao: { tipo: 'etiqueta', etiqueta: 'a' } }),
    ).toHaveLength(1);
    expect(
      condicoesDoRamo({
        condicoes: [{ tipo: 'horario' }, { tipo: 'horario' }],
      }),
    ).toHaveLength(2);
  });

  it('R18.4 — aponta condição incompleta ao validar', () => {
    expect(
      problemaDaCondicao({ tipo: 'variavel', chave: 'x', operador: 'igual' }),
    ).toMatch(/valor/);
    expect(
      problemaDaCondicao({ tipo: 'variavel', chave: 'x', operador: 'existe' }),
    ).toBeNull();
    expect(problemaDaCondicao({ tipo: 'etiqueta', etiqueta: '' })).toMatch(
      /etiqueta/,
    );
    expect(problemaDaCondicao({ tipo: 'canal' })).toMatch(/canal/);
    expect(problemaDaCondicao({ tipo: 'nada' })).toMatch(/tipo/);
    expect(problemaDaCondicao(null)).toMatch(/incompleta/);
    expect(problemaDaCondicao({ tipo: 'horario' })).toBeNull();
  });
});
