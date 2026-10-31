import {
  escolherFluxo,
  type FluxoCandidato,
  gatilhoCombina,
  textoTemPalavraChave,
} from './seletor-de-fluxo';

let sequencia = 0;
function fluxo(extra: Partial<FluxoCandidato> = {}): FluxoCandidato {
  sequencia += 1;
  return {
    id: `f${sequencia}`,
    gatilho: 'NOVA_CONVERSA',
    palavrasChave: [],
    canalIds: [],
    prioridade: 0,
    criadoEm: new Date(2026, 0, sequencia),
    ...extra,
  };
}

const NOVA = {
  canalId: 'c1',
  texto: 'Olá, quero um orçamento',
  conversaNova: true,
  semExecucaoAnterior: true,
  foraDoHorario: false,
};

describe('R18 — escolha do fluxo pela mensagem', () => {
  it('R18.1 — palavra-chave: palavra inteira, sem acento nem caixa, também expressões', () => {
    expect(textoTemPalavraChave('Quero um ORÇAMENTO!', ['orcamento'])).toBe(
      true,
    );
    expect(textoTemPalavraChave('preço do plano pro?', ['plano pro'])).toBe(
      true,
    );
    expect(textoTemPalavraChave('orcamentos', ['orcamento'])).toBe(false);
    expect(textoTemPalavraChave(null, ['oi'])).toBe(false);
    expect(textoTemPalavraChave('oi', [])).toBe(false);
  });

  it('R18.1 — cada gatilho vale na sua situação', () => {
    const nova = fluxo({ gatilho: 'NOVA_CONVERSA' });
    expect(gatilhoCombina(nova, NOVA)).toBe(true);
    expect(gatilhoCombina(nova, { ...NOVA, conversaNova: false })).toBe(false);
    expect(gatilhoCombina(nova, { ...NOVA, semExecucaoAnterior: false })).toBe(
      false,
    );

    const sempre = fluxo({ gatilho: 'SEMPRE' });
    expect(gatilhoCombina(sempre, { ...NOVA, conversaNova: false })).toBe(true);
    expect(
      gatilhoCombina(sempre, { ...NOVA, semExecucaoAnterior: false }),
    ).toBe(false);

    const fora = fluxo({ gatilho: 'FORA_DO_HORARIO' });
    expect(gatilhoCombina(fora, NOVA)).toBe(false);
    expect(gatilhoCombina(fora, { ...NOVA, foraDoHorario: true })).toBe(true);

    const palavra = fluxo({
      gatilho: 'PALAVRA_CHAVE',
      palavrasChave: ['orçamento'],
    });
    expect(gatilhoCombina(palavra, NOVA)).toBe(true);
    // palavra-chave vale em qualquer mensagem, mesmo com fluxo anterior na conversa
    expect(
      gatilhoCombina(palavra, {
        ...NOVA,
        conversaNova: false,
        semExecucaoAnterior: false,
      }),
    ).toBe(true);
    expect(gatilhoCombina(palavra, { ...NOVA, texto: 'oi' })).toBe(false);
  });

  it('R18.1 — canal: lista vazia vale para todos; senão só os listados', () => {
    const todos = fluxo();
    const so2 = fluxo({ canalIds: ['c2'] });
    expect(escolherFluxo([so2], NOVA)).toBeNull();
    expect(escolherFluxo([so2], { ...NOVA, canalId: 'c2' })).toBe(so2);
    expect(escolherFluxo([so2, todos], NOVA)).toBe(todos);
  });

  it('R18.1 — maior prioridade ganha; empate: gatilho mais específico, depois o mais antigo', () => {
    const baixa = fluxo({
      gatilho: 'PALAVRA_CHAVE',
      palavrasChave: ['orçamento'],
      prioridade: 1,
    });
    const alta = fluxo({ gatilho: 'NOVA_CONVERSA', prioridade: 5 });
    expect(escolherFluxo([baixa, alta], NOVA)).toBe(alta);

    const nova = fluxo({ gatilho: 'NOVA_CONVERSA' });
    const palavra = fluxo({
      gatilho: 'PALAVRA_CHAVE',
      palavrasChave: ['orçamento'],
    });
    expect(escolherFluxo([nova, palavra], NOVA)).toBe(palavra);

    const antigo = fluxo({ gatilho: 'SEMPRE' });
    const recente = fluxo({ gatilho: 'SEMPRE' });
    expect(escolherFluxo([recente, antigo], NOVA)).toBe(antigo);
  });

  it('R18.1 — nenhum candidato serve: nulo', () => {
    expect(escolherFluxo([], NOVA)).toBeNull();
    expect(
      escolherFluxo([fluxo({ gatilho: 'FORA_DO_HORARIO' })], NOVA),
    ).toBeNull();
  });
});
