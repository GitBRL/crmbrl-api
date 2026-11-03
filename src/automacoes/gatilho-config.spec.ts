import {
  casaComFiltros,
  conferirGatilho,
  contemPalavra,
} from './gatilho-config';

const UUID = '3f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10';

describe('Gatilhos das automações (R19.2)', () => {
  it('R19.2 — evento do catálogo define a entidade; gatilho desconhecido é erro', () => {
    const ok = conferirGatilho({
      tipoGatilho: 'EVENTO',
      evento: 'negocio.ganho',
      gatilhoConfig: { funilId: UUID },
    });
    expect(ok.erros).toEqual([]);
    expect(ok.entidade).toBe('negocio');
    expect(
      conferirGatilho({ tipoGatilho: 'EVENTO', evento: 'nada.disso' }).erros,
    ).toHaveLength(1);
    expect(conferirGatilho({ tipoGatilho: 'EVENTO' }).erros).toHaveLength(1);
  });

  it('R19.2 — filtro que não vale para o gatilho ou com valor inválido é erro', () => {
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'contato.criado',
        gatilhoConfig: { etapaId: UUID },
      }).erros[0],
    ).toMatch(/não vale/);
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'negocio.criado',
        gatilhoConfig: { funilId: 'x' },
      }).erros[0],
    ).toMatch(/id válido/);
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'conversa.avaliada',
        gatilhoConfig: { notaMaxima: 9 },
      }).erros[0],
    ).toMatch(/1 a 5/);
  });

  it('R19.2 — "movido para a etapa" e "mensagem com palavra" ficam pendentes até configurar', () => {
    expect(
      conferirGatilho({ tipoGatilho: 'EVENTO', evento: 'negocio.movido' })
        .pendencias,
    ).toHaveLength(1);
    expect(
      conferirGatilho({ tipoGatilho: 'EVENTO', evento: 'mensagem.recebida' })
        .pendencias,
    ).toHaveLength(1);
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'negocio.movido',
        gatilhoConfig: { etapaId: UUID },
      }).pendencias,
    ).toEqual([]);
  });

  it('R19.2 — entidade enviada precisa coincidir com a do gatilho', () => {
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'negocio.ganho',
        entidade: 'contato',
      }).erros[0],
    ).toMatch(/trabalha com negocio/);
  });

  it('R19.2 — data relativa e recorrência são conferidas (entidade vem do campo)', () => {
    const data = conferirGatilho({
      tipoGatilho: 'DATA_RELATIVA',
      gatilhoConfig: {
        campo: 'negocio.previsaoFechamento',
        dias: -3,
        hora: '09:00',
      },
    });
    expect(data.erros).toEqual([]);
    expect(data.entidade).toBe('negocio');
    expect(
      conferirGatilho({
        tipoGatilho: 'DATA_RELATIVA',
        gatilhoConfig: {
          campo: 'contato.campos.renovacao_em',
          dias: 0,
          hora: '08:30',
        },
      }).entidade,
    ).toBe('contato');
    expect(
      conferirGatilho({
        tipoGatilho: 'DATA_RELATIVA',
        gatilhoConfig: { campo: 'x', dias: 1, hora: '09:00' },
      }).erros,
    ).toHaveLength(1);
    expect(
      conferirGatilho({
        tipoGatilho: 'RECORRENCIA',
        gatilhoConfig: { frequencia: 'semanal', hora: '09:00' },
      }).erros,
    ).toHaveLength(1);
    expect(
      conferirGatilho({
        tipoGatilho: 'RECORRENCIA',
        gatilhoConfig: { frequencia: 'diaria', hora: '09:00' },
      }).entidade,
    ).toBe('contato');
  });

  it('R19.2 — palavra casa sem acento, sem caixa e como parte do texto', () => {
    expect(contemPalavra('Quero uma COTAÇÃO, por favor', ['cotacao'])).toBe(
      true,
    );
    expect(contemPalavra('olá', ['preço', 'valor'])).toBe(false);
    expect(contemPalavra(null, ['x'])).toBe(false);
  });

  it('R19.2 — filtros do evento: funil, etapa, origem, tipo, palavras e nota', () => {
    const outro = '11111111-1111-4111-8111-111111111111';
    expect(
      casaComFiltros(
        'negocio.movido',
        { funilId: UUID, etapaId: outro },
        { etapaId: outro },
      ),
    ).toBe(true);
    expect(
      casaComFiltros(
        'negocio.movido',
        { funilId: UUID, etapaId: UUID },
        { etapaId: outro },
      ),
    ).toBe(false);
    expect(
      casaComFiltros(
        'negocio.movido',
        { etapaId: UUID },
        { etapaId: [outro, UUID] },
      ),
    ).toBe(true);
    expect(
      casaComFiltros(
        'contato.criado',
        { primeiraOrigem: { tipo: 'SITE' } },
        { origem: ['SITE', 'WEBHOOK'] },
      ),
    ).toBe(true);
    expect(
      casaComFiltros(
        'contato.criado',
        { primeiraOrigem: { tipo: 'MANUAL' } },
        { origem: 'SITE' },
      ),
    ).toBe(false);
    expect(
      casaComFiltros(
        'atividade.criada',
        { tipo: 'LIGACAO' },
        { tipo: 'TAREFA' },
      ),
    ).toBe(false);
    expect(
      casaComFiltros(
        'mensagem.recebida',
        {},
        { palavras: ['preço'] },
        { texto: 'Qual o PRECO?' },
      ),
    ).toBe(true);
    expect(
      casaComFiltros(
        'mensagem.recebida',
        {},
        { palavras: ['preço'] },
        { texto: 'oi' },
      ),
    ).toBe(false);
    expect(
      casaComFiltros('conversa.avaliada', { nota: 2 }, { notaMaxima: 3 }),
    ).toBe(true);
    expect(
      casaComFiltros('conversa.avaliada', { nota: 5 }, { notaMaxima: 3 }),
    ).toBe(false);
    expect(
      casaComFiltros('conversa.avaliada', { nota: 2 }, { notaMinima: 4 }),
    ).toBe(false);
    expect(casaComFiltros('contato.criado', {}, {})).toBe(true);
  });
});

describe('Gatilhos de ligação (R29.9)', () => {
  it('R29.9 — "ligação perdida" e "ligação encerrada" são da entidade contato e validam os filtros', () => {
    expect(
      conferirGatilho({ tipoGatilho: 'EVENTO', evento: 'ligacao.perdida' }),
    ).toMatchObject({ erros: [], entidade: 'contato' });
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'ligacao.encerrada',
        gatilhoConfig: { resultado: 'atendida', direcao: 'RECEBIDA' },
      }).erros,
    ).toEqual([]);
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'ligacao.encerrada',
        gatilhoConfig: { resultado: 'talvez', direcao: 'X' },
      }).erros,
    ).toHaveLength(2);
    expect(
      conferirGatilho({
        tipoGatilho: 'EVENTO',
        evento: 'ligacao.perdida',
        gatilhoConfig: { resultado: 'atendida' },
      }).erros,
    ).toHaveLength(1);
  });

  it('R29.9 — casa por direção e resultado', () => {
    const dados = { direcao: 'FEITA', resultado: 'sem_resposta' };
    expect(
      casaComFiltros('ligacao.encerrada', dados, { direcao: 'FEITA' }),
    ).toBe(true);
    expect(
      casaComFiltros('ligacao.encerrada', dados, { resultado: 'atendida' }),
    ).toBe(false);
    expect(
      casaComFiltros('ligacao.encerrada', dados, {
        resultado: ['atendida', 'sem_resposta'],
      }),
    ).toBe(true);
  });
});
