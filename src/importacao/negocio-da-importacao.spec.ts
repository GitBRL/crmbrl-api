import {
  type FunilDoCache,
  resolverDestino,
  resolverResponsavel,
} from './negocio-da-importacao';

const funis: FunilDoCache[] = [
  {
    id: 'f1',
    nome: 'Vendas Diretas',
    ativo: true,
    area: 'COMERCIAL',
    visibilidade: 'SETOR',
    etapas: [
      { id: 'e1', nome: 'Novo Lead', tipo: 'ABERTA' },
      { id: 'e2', nome: 'Proposta', tipo: 'ABERTA' },
      { id: 'e3', nome: 'Ganho', tipo: 'GANHO' },
      { id: 'e4', nome: 'Perdido', tipo: 'PERDIDO' },
    ],
  },
  {
    id: 'f2',
    nome: 'Parceiros',
    ativo: true,
    area: 'MARKETING',
    visibilidade: 'SETOR',
    etapas: [{ id: 'e5', nome: 'Triagem', tipo: 'ABERTA' }],
  },
  {
    id: 'f3',
    nome: 'Antigo',
    ativo: false,
    area: 'COMERCIAL',
    visibilidade: 'SETOR',
    etapas: [],
  },
];
const cartao = { funilId: 'f1', etapaId: 'e2' };
const tudo = () => true;

describe('Negócio por linha (R16.12)', () => {
  it('R16.12 — sem coluna e sem cartão, não há negócio', () => {
    expect(
      resolverDestino({ funis, cartao: null, podeCriarNoFunil: tudo }),
    ).toEqual({});
  });

  it('R16.12 — sem coluna usa o funil e a etapa do cartão', () => {
    const r = resolverDestino({ funis, cartao, podeCriarNoFunil: tudo });
    expect(r.destino?.etapa.id).toBe('e2');
  });

  it('R16.12 — funil e etapa da coluna têm prioridade, com nome sem acento nem caixa', () => {
    const r = resolverDestino({
      funis,
      cartao,
      funilTexto: ' vendas  DIRETAS ',
      etapaTexto: 'novo lead',
      podeCriarNoFunil: tudo,
    });
    expect(r.destino?.funil.id).toBe('f1');
    expect(r.destino?.etapa.id).toBe('e1');
  });

  it('R16.12 — só funil na linha usa a etapa de entrada; só etapa usa o funil do cartão', () => {
    expect(
      resolverDestino({
        funis,
        cartao,
        funilTexto: 'parceiros',
        podeCriarNoFunil: tudo,
      }).destino?.etapa.id,
    ).toBe('e5');
    expect(
      resolverDestino({
        funis,
        cartao,
        etapaTexto: 'Novo lead',
        podeCriarNoFunil: tudo,
      }).destino?.etapa.id,
    ).toBe('e1');
    expect(
      resolverDestino({
        funis,
        cartao: null,
        etapaTexto: 'Novo lead',
        podeCriarNoFunil: tudo,
      }).aviso,
    ).toContain('informe o funil');
  });

  it('R16.12 — funil inexistente, arquivado, sem permissão e etapa de perda viram aviso', () => {
    expect(
      resolverDestino({
        funis,
        cartao,
        funilTexto: 'Nada',
        podeCriarNoFunil: tudo,
      }).aviso,
    ).toBe('funil "Nada" não encontrado.');
    expect(
      resolverDestino({
        funis,
        cartao,
        funilTexto: 'Antigo',
        podeCriarNoFunil: tudo,
      }).aviso,
    ).toContain('arquivado');
    expect(
      resolverDestino({
        funis,
        cartao,
        funilTexto: 'Parceiros',
        podeCriarNoFunil: (f) => f.area !== 'MARKETING',
      }).aviso,
    ).toContain('sem permissão');
    expect(
      resolverDestino({
        funis,
        cartao,
        etapaTexto: 'perdido',
        podeCriarNoFunil: tudo,
      }).aviso,
    ).toContain('perda');
    expect(
      resolverDestino({
        funis,
        cartao,
        etapaTexto: 'Triagem',
        podeCriarNoFunil: tudo,
      }).aviso,
    ).toContain('não encontrada');
  });

  it('R16.12 — responsável por e-mail exato ou nome normalizado único', () => {
    const comercial = { papel: 'MEMBRO' as const, area: 'COMERCIAL' };
    const usuarios = [
      { id: 'u1', nome: 'Ana Souza', email: 'ana@x.com', ...comercial },
      { id: 'u2', nome: 'João', email: 'j1@x.com', ...comercial },
      { id: 'u3', nome: 'Joao', email: 'j2@x.com', ...comercial },
    ];
    expect(resolverResponsavel('ANA@x.com', usuarios).usuario?.id).toBe('u1');
    expect(resolverResponsavel(' ana  souza', usuarios).usuario?.id).toBe('u1');
    expect(resolverResponsavel('joao', usuarios).aviso).toContain('ambíguo');
    expect(resolverResponsavel('Zé', usuarios).aviso).toContain(
      'não encontrado',
    );
  });
});

describe('Tradução e negócio fechado (R16.14)', () => {
  it('R16.14 — a tradução do funil vale antes do nome e leva à etapa traduzida', () => {
    const r = resolverDestino({
      funis,
      cartao: null,
      funilTexto: 'SDR',
      etapaTexto: '1º CONTATO',
      podeCriarNoFunil: tudo,
      traducaoFunis: { sdr: 'f1' },
      traducaoEtapas: { f1: { '1º contato': 'e2' } },
    });
    expect(r.destino?.funil.id).toBe('f1');
    expect(r.destino?.etapa.id).toBe('e2');
  });

  it('R16.14 — tradução para funil ou etapa que não existe mais vira aviso', () => {
    expect(
      resolverDestino({
        funis,
        cartao: null,
        funilTexto: 'SDR',
        podeCriarNoFunil: tudo,
        traducaoFunis: { sdr: 'inexistente' },
      }).aviso,
    ).toMatch(/não existe mais/);
    expect(
      resolverDestino({
        funis,
        cartao: null,
        funilTexto: 'Vendas Diretas',
        etapaTexto: 'x',
        podeCriarNoFunil: tudo,
        traducaoEtapas: { f1: { x: 'inexistente' } },
      }).aviso,
    ).toMatch(/não existe mais/);
  });

  it('R16.14 — ganho e perdido vão direto para a etapa de fechamento; a etapa da planilha não conta', () => {
    const entrada = {
      funis,
      cartao: null,
      funilTexto: 'Vendas Diretas',
      etapaTexto: 'etapa que não existe',
      podeCriarNoFunil: tudo,
    };
    expect(
      resolverDestino({ ...entrada, status: 'GANHO' }).destino?.etapa.id,
    ).toBe('e3');
    expect(
      resolverDestino({ ...entrada, status: 'PERDIDO' }).destino?.etapa.id,
    ).toBe('e4');
  });

  it('R16.14 — funil sem etapa de ganho avisa', () => {
    expect(
      resolverDestino({
        funis,
        cartao: null,
        funilTexto: 'Parceiros',
        podeCriarNoFunil: tudo,
        status: 'GANHO',
      }).aviso,
    ).toMatch(/não tem etapa de ganho/);
  });
});
