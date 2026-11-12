import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type { PrismaService } from '../prisma/prisma.service';
import { CalculoIndicadoresService } from './calculo-indicadores.service';
import type { FiltrosIndicadoresService } from './filtros-indicadores.service';
import type { FiltroResolvido, Widget } from './indicadores.tipos';

const USUARIO = {
  id: '11111111-1111-4111-8111-111111111111',
  papel: 'ADMIN',
  area: null,
  nome: 'Admin',
} as unknown as UsuarioAutenticado;

function filtro(parcial: Partial<FiltroResolvido> = {}): FiltroResolvido {
  return {
    de: new Date('2026-11-10T03:00:00.000Z'),
    ate: new Date('2026-11-13T03:00:00.000Z'),
    anteriorDe: new Date('2026-11-07T03:00:00.000Z'),
    anteriorAte: new Date('2026-11-10T03:00:00.000Z'),
    comparar: true,
    pessoas: null,
    funilIds: null,
    etapaIds: null,
    setor: null,
    origens: null,
    utmSource: null,
    utmCampaign: null,
    etiquetas: null,
    aplicados: {},
    ...parcial,
  };
}

function servico(respostas: unknown[][], etapas: unknown[] = []) {
  const fila = [...respostas];
  const prisma = {
    $queryRaw: jest.fn(() => Promise.resolve(fila.shift() ?? [])),
    etapa: { findMany: jest.fn(() => Promise.resolve(etapas)) },
    funil: {
      findFirst: jest.fn(() =>
        Promise.resolve({ id: 'f1', nome: 'Vendas', area: 'COMERCIAL' }),
      ),
    },
  };
  const filtros = {
    exigirFunilVisivel: jest.fn(() =>
      Promise.resolve({ id: 'f1', nome: 'Vendas', area: 'COMERCIAL' }),
    ),
    exigirEtapaVisivel: jest.fn(),
  };
  return new CalculoIndicadoresService(
    prisma as unknown as PrismaService,
    filtros as unknown as FiltrosIndicadoresService,
  );
}

const widget = (parcial: Partial<Widget>): Widget => ({
  id: 'w1',
  indicador: 'leads_recebidos',
  parametros: {},
  visualizacao: 'NUMERO',
  largura: 1,
  ordem: 0,
  ...parcial,
});

describe('cálculo dos widgets (R33.2, R33.5)', () => {
  it('R33.2 — número traz o período anterior, a variação e a meta', async () => {
    const s = servico([[{ a: 12, b: null }], [{ a: 8, b: null }]]);
    const r = await s.calcular(
      USUARIO,
      widget({ meta: { geral: 24 } }),
      filtro(),
    );
    expect(r).toMatchObject({
      ok: true,
      valor: 12,
      valorAnterior: 8,
      variacao: 50,
      meta: { alvo: 24, progresso: 50, atingida: false },
    });
  });

  it('R33.2 — taxa é calculada a partir das duas contagens (R33.1: comparecimento)', async () => {
    const s = servico([[{ a: 3, b: 1 }], [{ a: 0, b: 0 }]]);
    const r = await s.calcular(
      USUARIO,
      widget({ indicador: 'taxa_comparecimento' }),
      filtro(),
    );
    expect(r.valor).toBe(75);
    expect(r.valorAnterior).toBeNull();
  });

  it('R33.2 — indicador de agora não tem período nem comparação', async () => {
    const s = servico([[{ a: 4, b: null }]]);
    const r = await s.calcular(
      USUARIO,
      widget({ indicador: 'negocios_abertos' }),
      filtro(),
    );
    expect(r.periodo).toBeNull();
    expect(r.valorAnterior).toBeNull();
    expect(r.valor).toBe(4);
  });

  it('R33.2 — série completa os dias sem dados: zero na contagem, nulo na média', async () => {
    const dias = [{ chave: '2026-11-10', a: 2, b: null }];
    const contagem = await servico([dias]).calcular(
      USUARIO,
      widget({ visualizacao: 'SERIE' }),
      filtro(),
    );
    expect(contagem.pontos?.map((p) => [p.chave, p.valor])).toEqual([
      ['2026-11-10', 2],
      ['2026-11-11', 0],
      ['2026-11-12', 0],
    ]);
    const media = await servico([dias]).calcular(
      USUARIO,
      widget({
        indicador: 'tempo_ate_atendimento',
        visualizacao: 'SERIE',
      }),
      filtro(),
    );
    expect(media.pontos?.map((p) => p.valor)).toEqual([2, null, null]);
  });

  it('R33.2 e R33.5 — ranking ordena do maior ao menor, com a meta de cada pessoa', async () => {
    const s = servico([
      [
        { id: 'p1', rotulo: 'Ana', a: 2, b: null },
        { id: 'p2', rotulo: 'Beto', a: 6, b: null },
        { id: null, rotulo: null, a: 1, b: null },
      ],
    ]);
    const r = await s.calcular(
      USUARIO,
      widget({ visualizacao: 'RANKING', meta: { porPessoa: 4 } }),
      filtro(),
    );
    expect(r.linhas?.map((l) => [l.rotulo, l.valor])).toEqual([
      ['Beto', 6],
      ['Ana', 2],
      ['Sem responsável', 1],
    ]);
    expect(r.linhas?.[0].meta).toMatchObject({
      progresso: 150,
      atingida: true,
    });
    expect(r.linhas?.[1].meta).toMatchObject({
      progresso: 50,
      atingida: false,
    });
  });

  it('R33.2 — ranking de "menos é melhor" ordena do menor ao maior', async () => {
    const s = servico([
      [
        { id: 'p1', rotulo: 'Ana', a: 600, b: null },
        { id: 'p2', rotulo: 'Beto', a: 60, b: null },
      ],
    ]);
    const r = await s.calcular(
      USUARIO,
      widget({
        indicador: 'tempo_ate_atendimento',
        visualizacao: 'RANKING',
      }),
      filtro(),
    );
    expect(r.linhas?.map((l) => l.rotulo)).toEqual(['Beto', 'Ana']);
  });

  it('R33.2 — por etapa lista todas as etapas do funil, inclusive as vazias, na ordem', async () => {
    const s = servico(
      [[{ id: 'e2', a: 5, b: null }]],
      [
        { id: 'e1', nome: 'Novo', tipo: 'ABERTA' },
        { id: 'e2', nome: 'Proposta', tipo: 'ABERTA' },
      ],
    );
    const r = await s.calcular(
      USUARIO,
      widget({ indicador: 'negocios_abertos', visualizacao: 'POR_ETAPA' }),
      filtro(),
    );
    expect(r.funil?.nome).toBe('Vendas');
    expect(r.linhas?.map((l) => [l.rotulo, l.valor])).toEqual([
      ['Novo', 0],
      ['Proposta', 5],
    ]);
  });

  it('R33.2 — barras trocam o código pelo rótulo e põem o nulo em "Não informado"', async () => {
    const s = servico([
      [
        { id: 'SITE', a: 3, b: null },
        { id: null, a: 5, b: null },
      ],
    ]);
    const r = await s.calcular(
      USUARIO,
      widget({
        visualizacao: 'BARRAS',
        parametros: { por: 'ORIGEM' },
      }),
      filtro(),
    );
    expect(r.linhas?.map((l) => l.rotulo)).toEqual(['Não informado', 'Site']);
  });

  it('R33.2 — funil calcula a conversão sobre a etapa anterior e sobre a primeira', async () => {
    const s = servico(
      [
        // Quantos negócios pararam em cada ordem (a maior que alcançaram): "chegou à etapa N" soma ordem ≥ N.
        [
          { ordem: 1, negocios: 5 },
          { ordem: 2, negocios: 4 },
          { ordem: 3, negocios: 1 },
        ],
      ],
      [
        { id: 'e1', nome: 'Novo', tipo: 'ABERTA', ordem: 1 },
        { id: 'e2', nome: 'Proposta', tipo: 'ABERTA', ordem: 2 },
        { id: 'e3', nome: 'Ganho', tipo: 'GANHO', ordem: 3 },
      ],
    );
    const r = await s.calcular(
      USUARIO,
      widget({
        indicador: 'conversao_entre_etapas',
        visualizacao: 'FUNIL',
      }),
      filtro(),
    );
    expect(
      r.linhas?.map((l) => [l.valor, l.conversao, l.conversaoTotal]),
    ).toEqual([
      [10, null, null],
      [5, 50, 50],
      [1, 20, 10],
    ]);
  });

  it('R33.2 — funil: quem pulou etapas conta nas anteriores, então a conversão nunca passa de 100%', async () => {
    const s = servico(
      [
        [
          { ordem: 1, negocios: 3 },
          { ordem: 3, negocios: 2 },
        ],
      ],
      [
        { id: 'e1', nome: 'Novo', tipo: 'ABERTA', ordem: 1 },
        { id: 'e2', nome: 'Qualificação', tipo: 'ABERTA', ordem: 2 },
        { id: 'e3', nome: 'Proposta', tipo: 'ABERTA', ordem: 3 },
      ],
    );
    const r = await s.calcular(
      USUARIO,
      widget({ indicador: 'conversao_entre_etapas', visualizacao: 'FUNIL' }),
      filtro(),
    );
    expect(r.linhas?.map((l) => [l.valor, l.conversao])).toEqual([
      [5, null],
      [2, 40],
      [2, 100],
    ]);
  });

  it('R33.2 — conversão entre etapas como número: dos que entraram, quantos chegaram', async () => {
    const s = servico([[{ a: 3, b: 4 }], [{ a: 1, b: 4 }]]);
    const r = await s.calcular(
      USUARIO,
      widget({
        indicador: 'conversao_entre_etapas',
        parametros: { etapaOrigemId: 'a', etapaDestinoId: 'b' },
      }),
      filtro(),
    );
    expect(r.valor).toBe(75);
    expect(r.valorAnterior).toBe(25);
  });

  it('R20.8 — o clique descreve a lista só quando ela representa o número', async () => {
    const aberto = await servico([[{ a: 1, b: null }]]).calcular(
      USUARIO,
      widget({ indicador: 'leads_sem_atendimento' }),
      filtro(),
    );
    expect(aberto.clique).toEqual({
      lista: 'NEGOCIOS',
      filtros: { status: 'ABERTO', atendido: false },
    });
    const reuniao = await servico([
      [{ a: 1, b: null }],
      [{ a: 0, b: null }],
    ]).calcular(USUARIO, widget({ indicador: 'reunioes_no_show' }), filtro());
    expect(reuniao.clique?.lista).toBe('ATIVIDADES');
    expect(reuniao.clique?.filtros).toMatchObject({
      tipo: ['REUNIAO'],
      resultadoReuniao: ['NAO_COMPARECEU'],
    });
    const comOrigem = await servico([
      [{ a: 1, b: null }],
      [{ a: 0, b: null }],
    ]).calcular(
      USUARIO,
      widget({ indicador: 'reunioes_no_show' }),
      filtro({ origens: ['SITE'] }),
    );
    expect(comOrigem.clique).toBeNull();
    const leads = await servico([
      [{ a: 1, b: null }],
      [{ a: 0, b: null }],
    ]).calcular(USUARIO, widget({}), filtro());
    expect(leads.clique).toBeNull();
  });
});
