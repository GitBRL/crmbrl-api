import {
  validarFiltros,
  validarMeta,
  validarParametros,
  validarWidgets,
} from './validacao-widgets';

/** Mensagem (em português) do erro de validação que a função lança. */
function falha(fn: () => unknown): string {
  try {
    fn();
  } catch (erro) {
    return (erro as { mensagem?: string }).mensagem ?? String(erro);
  }
  return '';
}

const UUID = '3f1f3a52-9a53-4d63-a7a3-5c8e0f6f2f10';

describe('validação dos widgets (R33.6)', () => {
  it('R33.6 — normaliza id, largura, ordem e título', () => {
    const [w] = validarWidgets([
      {
        indicador: 'leads_recebidos',
        visualizacao: 'NUMERO',
        titulo: '  Meus leads  ',
      },
    ]);
    expect(w.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.largura).toBe(1);
    expect(w.ordem).toBe(0);
    expect(w.titulo).toBe('Meus leads');
  });

  it('R33.6 — recusa indicador desconhecido e visualização que o indicador não aceita', () => {
    expect(
      falha(() =>
        validarWidgets([{ indicador: 'nada', visualizacao: 'NUMERO' }]),
      ),
    ).toMatch(/Indicador desconhecido/);
    expect(
      falha(() =>
        validarWidgets([{ indicador: 'taxa_no_show', visualizacao: 'FUNIL' }]),
      ),
    ).toMatch(/aceita/);
  });

  it('R33.6 — recusa id repetido, largura fora de 1 a 3 e mais de 40 indicadores', () => {
    const base = { indicador: 'leads_recebidos', visualizacao: 'NUMERO' };
    expect(
      falha(() =>
        validarWidgets([
          { ...base, id: 'a' },
          { ...base, id: 'a' },
        ]),
      ),
    ).toMatch(/repetido/);
    expect(falha(() => validarWidgets([{ ...base, largura: 4 }]))).toMatch(
      /largura/,
    );
    expect(
      falha(() =>
        validarWidgets(Array.from({ length: 41 }, () => ({ ...base }))),
      ),
    ).toMatch(/no máximo 40/);
  });

  it('R33.6 — reordena pela ordem informada', () => {
    const base = { indicador: 'leads_recebidos', visualizacao: 'NUMERO' };
    const resultado = validarWidgets([
      { ...base, id: 'b', ordem: 5 },
      { ...base, id: 'a', ordem: 1 },
    ]);
    expect(resultado.map((w) => w.id)).toEqual(['a', 'b']);
    expect(resultado.map((w) => w.ordem)).toEqual([0, 1]);
  });
});

describe('parâmetros e metas', () => {
  it('R33.1 — parâmetro de enum só aceita as opções; desconhecido é recusado', () => {
    expect(
      validarParametros('atividades_concluidas', 'NUMERO', { tipo: 'REUNIAO' }),
    ).toEqual({ tipo: 'REUNIAO' });
    expect(
      falha(() =>
        validarParametros('atividades_concluidas', 'NUMERO', { tipo: 'XYZ' }),
      ),
    ).toMatch(/Valor inválido/);
    expect(
      falha(() =>
        validarParametros('atividades_concluidas', 'NUMERO', { foo: 'x' }),
      ),
    ).toMatch(/desconhecido/);
  });

  it('R33.1 — conversão entre etapas exige origem e destino como número, e só o funil como funil', () => {
    expect(
      falha(() => validarParametros('conversao_entre_etapas', 'NUMERO', {})),
    ).toMatch(/Etapa de origem/);
    expect(
      validarParametros('conversao_entre_etapas', 'NUMERO', {
        etapaOrigemId: UUID,
        etapaDestinoId: UUID,
      }),
    ).toEqual({ etapaOrigemId: UUID, etapaDestinoId: UUID });
    expect(validarParametros('conversao_entre_etapas', 'FUNIL', {})).toEqual(
      {},
    );
    expect(
      falha(() =>
        validarParametros('conversao_entre_etapas', 'NUMERO', {
          etapaOrigemId: 'x',
          etapaDestinoId: UUID,
        }),
      ),
    ).toMatch(/inválido/);
  });

  it('R33.5 — meta só em número e ranking, com valores de 0 para cima', () => {
    expect(validarMeta({ geral: 10, porPessoa: 3 }, 'RANKING')).toEqual({
      geral: 10,
      porPessoa: 3,
    });
    expect(validarMeta({ geral: 10, porPessoa: 3 }, 'NUMERO')).toEqual({
      geral: 10,
    });
    expect(validarMeta(undefined, 'NUMERO')).toBeUndefined();
    expect(falha(() => validarMeta({ geral: 1 }, 'SERIE'))).toMatch(/meta/);
    expect(falha(() => validarMeta({ geral: -1 }, 'NUMERO'))).toMatch(
      /maior ou igual/,
    );
    expect(falha(() => validarMeta({ geral: 'x' }, 'NUMERO'))).toMatch(
      /maior ou igual/,
    );
  });
});

describe('filtros (R33.3)', () => {
  it('R33.3 — aceita período predefinido ou personalizado e as listas', () => {
    expect(
      validarFiltros({
        periodo: { tipo: 'MES_ATUAL' },
        funilIds: [UUID],
        origens: ['SITE'],
        etiquetas: ['vip'],
        utmSource: ['google'],
      }),
    ).toMatchObject({ periodo: { tipo: 'MES_ATUAL' }, funilIds: [UUID] });
    expect(
      validarFiltros({
        periodo: { tipo: 'PERSONALIZADO', de: '2026-11-01', ate: '2026-11-10' },
      }).periodo,
    ).toEqual({ tipo: 'PERSONALIZADO', de: '2026-11-01', ate: '2026-11-10' });
  });

  it('R33.3 — recusa filtro desconhecido, período inválido e id que não é UUID', () => {
    expect(falha(() => validarFiltros({ cor: 'azul' }))).toMatch(
      /desconhecido/,
    );
    expect(
      falha(() => validarFiltros({ periodo: { tipo: 'SEMPRE' } })),
    ).toMatch(/período/);
    expect(
      falha(() =>
        validarFiltros({
          periodo: { tipo: 'PERSONALIZADO', de: '2026-11-01' },
        }),
      ),
    ).toMatch(/datas válidas/);
    expect(falha(() => validarFiltros({ funilIds: ['x'] }))).toMatch(
      /identificadores/,
    );
    expect(falha(() => validarFiltros({ origens: ['LUA'] }))).toMatch(
      /valores de/,
    );
  });
});
