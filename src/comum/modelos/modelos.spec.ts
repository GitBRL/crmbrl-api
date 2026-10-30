import {
  analisarModelo,
  type DadosDoModelo,
  geradorComSemente,
  primeiroNome,
  renderizarModelo,
  validarModelo,
} from './modelos';

const dados: DadosDoModelo = {
  contato: {
    nome: 'Ana Maria Souza',
    email: 'ana@exemplo.com',
    telefone: '5511987654321',
    campos: { cidade: 'Campinas', plano: { nome: 'Ouro' }, vip: true },
  },
  empresa: { nome: 'Exemplo Ltda', campos: { segmento: 'Varejo' } },
  negocio: { titulo: 'Plano anual', valor: '1500.00', etapa: 'Proposta' },
  responsavel: { nome: 'Bruno Lima' },
  variaveis: { resposta: '2', endereco: { cep: '01001-000' } },
};

describe('Renderizador de modelos (Onda B §2.1)', () => {
  it('substitui as variáveis do contato, empresa, negócio e responsável', () => {
    expect(
      renderizarModelo(
        'Oi {{contato.primeiro_nome}} ({{contato.nome}}), da {{empresa.nome}}: {{negocio.titulo}} por {{negocio.valor}}. Att, {{responsavel.primeiro_nome}}',
        dados,
      ),
    ).toBe(
      'Oi Ana (Ana Maria Souza), da Exemplo Ltda: Plano anual por R$ 1.500,00. Att, Bruno',
    );
  });

  it('lê campos personalizados e variáveis da execução (inclusive aninhados)', () => {
    expect(
      renderizarModelo(
        '{{contato.campos.cidade}}/{{contato.campos.plano.nome}}/{{contato.campos.vip}}/{{empresa.campos.segmento}}/{{variaveis.resposta}}/{{variaveis.endereco.cep}}',
        dados,
      ),
    ).toBe('Campinas/Ouro/sim/Varejo/2/01001-000');
  });

  it('usa o valor padrão quando a variável está vazia', () => {
    expect(
      renderizarModelo(
        'Olá {{contato.primeiro_nome|cliente}}, {{contato.cargo | tudo bem}}?',
        {
          contato: { nome: '  ' },
        },
      ),
    ).toBe('Olá cliente, tudo bem?');
    expect(renderizarModelo('[{{contato.cargo}}]', {})).toBe('[]');
  });

  it('sorteia as variações de forma reprodutível pela semente', () => {
    const modelo =
      '{Olá|Oi|E aí} {{contato.primeiro_nome}}, {tudo bem?|como vai?}';
    const a = renderizarModelo(modelo, dados, { semente: 'destinatario-1' });
    const b = renderizarModelo(modelo, dados, { semente: 'destinatario-1' });
    expect(a).toBe(b);
    const saidas = new Set(
      Array.from({ length: 40 }, (_, i) =>
        renderizarModelo(modelo, dados, { semente: `d-${i}` }),
      ),
    );
    expect(saidas.size).toBeGreaterThan(2);
    for (const saida of saidas) {
      expect(saida).toMatch(/^(Olá|Oi|E aí) Ana, (tudo bem\?|como vai\?)$/);
    }
  });

  it('aceita variáveis dentro das variações e deixa chaves sem "|" como texto', () => {
    const saida = renderizarModelo(
      '{Olá {{contato.primeiro_nome}}|Oi {{contato.primeiro_nome}}} {assim}',
      dados,
      { semente: 'x' },
    );
    expect(saida).toMatch(/^(Olá|Oi) Ana \{assim\}$/);
  });

  it('valores extras por caminho', () => {
    expect(
      renderizarModelo(
        '{{campanha.nome}}',
        {},
        { extras: { 'campanha.nome': 'Black Friday' } },
      ),
    ).toBe('Black Friday');
  });

  it('aponta variáveis desconhecidas e erros de sintaxe com a posição', () => {
    const resultado = validarModelo(
      'Oi {{contato.apelido}} {{}} {{empresa.nome',
    );
    expect(resultado.valido).toBe(false);
    expect(resultado.erros.map((e) => e.mensagem)).toEqual([
      'Variável desconhecida: {{contato.apelido}}.',
      'Variável vazia: {{}}.',
      'Variável sem fechar: falta "}}".',
    ]);
    expect(resultado.erros[0]).toMatchObject({
      inicio: 3,
      fim: 22,
      variavel: 'contato.apelido',
    });
  });

  it('valida variáveis extras, prefixos dinâmicos e a opção sem variáveis da execução', () => {
    expect(
      validarModelo('{{contato.campos.cidade}} {{variaveis.x}}').valido,
    ).toBe(true);
    expect(
      validarModelo('{{campanha.nome}}', { variaveisExtras: ['campanha.nome'] })
        .valido,
    ).toBe(true);
    expect(
      validarModelo('{{variaveis.x}}', { permitirVariaveisDaExecucao: false })
        .valido,
    ).toBe(false);
    expect(validarModelo('{Oi {{contato.xpto}}|Olá}').erros[0].variavel).toBe(
      'contato.xpto',
    );
  });

  it('lista as variáveis usadas e conta as variações', () => {
    const analise = analisarModelo(
      '{A|B} {{contato.nome}} {{contato.nome}} {C|{{empresa.nome}}}',
    );
    expect(analise.variaveis).toEqual(['contato.nome', 'empresa.nome']);
    expect(analise.variacoes).toBe(2);
  });

  it('gerador com semente é determinístico e fica em [0, 1)', () => {
    const g1 = geradorComSemente('abc');
    const g2 = geradorComSemente('abc');
    for (let i = 0; i < 100; i++) {
      const v = g1();
      expect(v).toBe(g2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(primeiroNome('  Ana   Maria ')).toBe('Ana');
  });
});
