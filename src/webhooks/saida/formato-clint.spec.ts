import {
  gatilhoQueCasa,
  montarCorpoClint,
  montarParametros,
  ehOrigemValida,
  problemasDoCampo,
  urlComParametros,
} from './formato-clint';

const funil = '11111111-1111-4111-8111-111111111111';
const etapaX = '22222222-2222-4222-8222-222222222222';
const evento = (tipo: string, etapaId = etapaX, funilId = funil) => ({
  tipo,
  funilId,
  etapaId,
});

describe('Formato Clint de saída (R32.12)', () => {
  it('R32.12 — gatilhos: criado, entra na etapa X, muda de etapa e muda de status, com filtro de funil', () => {
    expect(
      gatilhoQueCasa([{ tipo: 'NEGOCIO_CRIADO' }], evento('negocio.criado'))
        ?.tipo,
    ).toBe('NEGOCIO_CRIADO');
    expect(
      gatilhoQueCasa([{ tipo: 'NEGOCIO_CRIADO' }], evento('negocio.movido')),
    ).toBeNull();
    // Entra na etapa X: criado nela ou movido para ela; outra etapa não.
    const entra = [{ tipo: 'ENTRA_NA_ETAPA' as const, etapaId: etapaX }];
    expect(gatilhoQueCasa(entra, evento('negocio.movido'))).not.toBeNull();
    expect(gatilhoQueCasa(entra, evento('negocio.criado'))).not.toBeNull();
    expect(gatilhoQueCasa(entra, evento('negocio.movido', 'outra'))).toBeNull();
    expect(
      gatilhoQueCasa(
        [{ tipo: 'MUDA_DE_ETAPA' }],
        evento('negocio.movido', 'qualquer'),
      ),
    ).not.toBeNull();
    expect(
      gatilhoQueCasa([{ tipo: 'MUDA_DE_ETAPA' }], evento('negocio.ganho')),
    ).toBeNull();
    // Status: sem filtro, qualquer mudança (ganho, perdido, reaberto); com filtro, só o escolhido.
    const status = [{ tipo: 'MUDA_DE_STATUS' as const }];
    for (const tipo of [
      'negocio.ganho',
      'negocio.perdido',
      'negocio.reaberto',
    ]) {
      expect(gatilhoQueCasa(status, evento(tipo))).not.toBeNull();
    }
    expect(gatilhoQueCasa(status, evento('negocio.movido'))).toBeNull();
    const soGanho = [
      { tipo: 'MUDA_DE_STATUS' as const, status: 'GANHO' as const },
    ];
    expect(gatilhoQueCasa(soGanho, evento('negocio.ganho'))).not.toBeNull();
    expect(gatilhoQueCasa(soGanho, evento('negocio.perdido'))).toBeNull();
    // Filtro de funil.
    expect(
      gatilhoQueCasa(
        [{ tipo: 'NEGOCIO_CRIADO', funilId: funil }],
        evento('negocio.criado', etapaX, 'outro'),
      ),
    ).toBeNull();
    expect(
      gatilhoQueCasa(
        [{ tipo: 'NEGOCIO_CRIADO', funilId: funil }],
        evento('negocio.criado'),
      ),
    ).not.toBeNull();
  });

  it('R32.12 — o corpo usa o identificador de cada campo; sem valor, null', () => {
    const valores = new Map<string, string | string[] | null>([
      ['contato.nome', 'Maria'],
      ['contato.etiquetas', ['a', 'b']],
    ]);
    expect(
      montarCorpoClint(
        [
          { origem: 'contato.nome', identificador: 'nome_do_lead' },
          { origem: 'contato.etiquetas', identificador: 'tags' },
          { origem: 'contato.email', identificador: 'email' },
        ],
        valores,
      ),
    ).toEqual({ nome_do_lead: 'Maria', tags: ['a', 'b'], email: null });
  });

  it('R32.12 — GET: parâmetros na URL (lista separada por vírgula, nulo vazio), respeitando a query que já existe', () => {
    const parametros = montarParametros({
      nome: 'Maria Souza',
      tags: ['a', 'b'],
      email: null,
      valor: 10,
    });
    expect(parametros).toBe('nome=Maria+Souza&tags=a%2Cb&email=&valor=10');
    expect(urlComParametros('https://x.com/hook?chave=1', parametros)).toBe(
      'https://x.com/hook?chave=1&nome=Maria+Souza&tags=a%2Cb&email=&valor=10',
    );
    expect(urlComParametros('https://x.com/hook', '')).toBe(
      'https://x.com/hook',
    );
  });

  it('R32.12 — origens e identificadores válidos; personalizados por prefixo', () => {
    expect(ehOrigemValida('contato.email')).toBe(true);
    expect(ehOrigemValida('dono.identificador')).toBe(true);
    expect(ehOrigemValida('contato.camposPersonalizados.cidade')).toBe(true);
    expect(ehOrigemValida('negocio.camposPersonalizados.')).toBe(false);
    expect(ehOrigemValida('contato.senha')).toBe(false);
    expect(
      problemasDoCampo({ origem: 'contato.email', identificador: 'email' }),
    ).toEqual([]);
    expect(
      problemasDoCampo({ origem: 'x', identificador: 'com espaço' }),
    ).toHaveLength(2);
  });
});
