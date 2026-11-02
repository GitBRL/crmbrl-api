import { Prisma, type Papel } from '../src/generated/prisma/client';
import { IndicadoresFinanceirosService } from '../src/financeiro/indicadores.service';
import {
  filtroDeContratosVisiveis,
  filtroDeParcelasVisiveis,
} from '../src/financeiro/permissoes-financeiro';
import {
  sqlContratosVisiveis,
  sqlParcelasVisiveis,
} from '../src/financeiro/permissoes-financeiro-sql';
import { RiscoDeChurnService } from '../src/financeiro/risco-de-churn.service';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarUsuario,
} from './utils';

const DIA = 86_400_000;
const data = (n: number) =>
  new Date(
    `${new Date(Date.now() - n * DIA).toISOString().slice(0, 10)}T00:00:00.000Z`,
  );

describe('Financeiro — agregações em SQL equivalem ao filtro de visibilidade (e2e)', () => {
  let t: AppTeste;
  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function montar() {
    const { cLevel, lider, membros } = await criarEquipe(t, 'CS', {
      membros: 2,
    });
    const [m1, m2] = membros;
    const comercial = await criarUsuario(t, { papel: 'COMERCIAL' });
    const marketing = await criarUsuario(t, { papel: 'MARKETING' });
    const [c1, c2, c3] = await Promise.all([
      criarContato(t),
      criarContato(t),
      criarContato(t),
    ]);
    await t.prisma.contato.update({
      where: { id: c3.id },
      data: { responsavelId: m1.id },
    });
    const k1 = await t.prisma.contrato.create({
      data: {
        contatoId: c1.id,
        produto: 'P',
        valor: '1000',
        mrr: '1000',
        inicioEm: data(300),
        status: 'ATIVO',
        responsavelCsId: m1.id,
      },
    });
    const k2 = await t.prisma.contrato.create({
      data: {
        contatoId: c2.id,
        produto: 'P',
        valor: '500',
        mrr: '500',
        inicioEm: data(100),
        status: 'ATIVO',
        responsavelCsId: m2.id,
      },
    });
    await t.prisma.movimentoMrr.create({
      data: {
        contratoId: k1.id,
        tipo: 'NOVO',
        valorAnterior: '0',
        valorNovo: '1000',
        delta: '1000',
        dia: data(3),
      },
    });
    await t.prisma.movimentoMrr.create({
      data: {
        contratoId: k2.id,
        tipo: 'CHURN',
        valorAnterior: '500',
        valorNovo: '0',
        delta: '-500',
        dia: data(3),
      },
    });
    let n = 0;
    const parcela = (
      contrato: { id: string; contatoId: string | null } | null,
      contatoId: string | null,
      venc: number,
      valor: string,
      pago?: number,
    ) => {
      n += 1;
      return t.prisma.parcela.create({
        data: {
          numero: `SQL-${n}`,
          contratoId: contrato?.id ?? null,
          contatoId,
          vencimento: data(venc),
          vencimentoOriginal: data(venc),
          valor,
          valorPago: pago !== undefined ? valor : null,
          pagoEm: pago !== undefined ? data(pago) : null,
          status:
            pago !== undefined ? 'PAGO' : venc > 0 ? 'ATRASADO' : 'ABERTO',
        },
      });
    };
    await parcela(k1, c1.id, 10, '200.00');
    await parcela(k1, c1.id, 70, '300.00');
    await parcela(k2, c2.id, 130, '400.00');
    await parcela(k2, c2.id, -5, '100.00');
    await parcela(k1, c1.id, 4, '250.00', 3);
    await parcela(null, c3.id, 40, '90.00'); // avulso da carteira de m1
    return { cLevel, lider, m1, m2, comercial, marketing };
  }

  it('cenário 119: o SQL de visibilidade devolve os mesmos contratos e parcelas que o filtro do Prisma, por papel', async () => {
    const e = await montar();
    const usuarios: { id: string; papel: Papel }[] = [
      e.cLevel,
      e.lider,
      e.m1,
      e.m2,
      e.comercial,
      e.marketing,
    ];
    for (const u of usuarios) {
      const [pc, pp] = await Promise.all([
        t.prisma.contrato.findMany({
          where: filtroDeContratosVisiveis(u),
          select: { id: true },
        }),
        t.prisma.parcela.findMany({
          where: filtroDeParcelasVisiveis(u),
          select: { id: true },
        }),
      ]);
      const [sc, sp] = await Promise.all([
        t.prisma.$queryRaw<
          { id: string }[]
        >`SELECT c.id FROM contratos c WHERE ${sqlContratosVisiveis(u)}`,
        t.prisma.$queryRaw<
          { id: string }[]
        >`SELECT p.id FROM parcelas p WHERE ${sqlParcelasVisiveis(u)}`,
      ]);
      expect(sc.map((x) => x.id).sort()).toEqual(pc.map((x) => x.id).sort());
      expect(sp.map((x) => x.id).sort()).toEqual(pp.map((x) => x.id).sort());
    }
  });

  it('cenário 148: inadimplência, previsto × realizado e MRR agregados no banco respeitam a carteira de cada pessoa', async () => {
    const e = await montar();
    const ind = t.app.get(IndicadoresFinanceirosService);
    const gestor = await ind.inadimplencia(e.lider);
    expect(
      gestor.faixas.map((f) => [f.faixa, f.quantidade, f.valor, f.clientes]),
    ).toEqual([
      ['0-30', 1, '200.00', 1],
      ['31-60', 1, '90.00', 1],
      ['61-90', 1, '300.00', 1],
      ['90+', 1, '400.00', 1],
    ]);
    expect(gestor.total).toEqual({
      quantidade: 4,
      valor: '990.00',
      clientes: 3,
    });
    expect(gestor.taxa).toBe(90.8);
    const doM1 = await ind.inadimplencia(e.m1);
    expect(doM1.total).toEqual({ quantidade: 3, valor: '590.00', clientes: 2 });
    const doM2 = await ind.inadimplencia(e.m2);
    expect(doM2.total).toEqual({ quantidade: 1, valor: '400.00', clientes: 1 });
    expect((await ind.inadimplencia(e.comercial)).total.quantidade).toBe(0);
    const pr = await ind.previstoRealizado(e.m1);
    expect(pr.total).toEqual({
      previsto: '840.00',
      realizado: '250.00',
      recebidoNoMes: '250.00',
    });
    const mrr = await ind.mrr(e.m2);
    expect(mrr.atual).toEqual({ mrr: '500.00', contratos: 1 });
    const rec = await ind.recebimentosDoPeriodo(
      e.lider,
      data(30).toISOString().slice(0, 10),
      data(0).toISOString().slice(0, 10),
    );
    expect(rec.recebido).toBe(250);
  });

  it('cenário 149: o risco de churn agregado no banco pontua atraso e silêncio e respeita a carteira', async () => {
    const e = await montar();
    const risco = t.app.get(RiscoDeChurnService);
    const todos = await risco.ranking(e.lider, { nivelMinimo: 'BAIXO' });
    expect(todos).toHaveLength(3);
    const c2 = todos.find((r) =>
      r.fatores.some((f) => f.tipo === 'ATRASO' && f.detalhe.includes('130')),
    );
    expect(c2?.pontuacao).toBeGreaterThanOrEqual(50);
    const doM2 = await risco.ranking(e.m2, { nivelMinimo: 'BAIXO' });
    expect(doM2.map((r) => r.contatoId)).toEqual([c2?.contatoId]);
    expect(await risco.ranking(e.marketing, { nivelMinimo: 'BAIXO' })).toEqual(
      [],
    );
    expect(await risco.contagemPorNivel(e.lider)).toEqual(
      expect.objectContaining({ ALTO: expect.any(Number) }),
    );
  });

  it('cenário 150: existe o índice parcial de parcelas pagas por data de pagamento', async () => {
    const r = await t.prisma.$queryRaw<{ indexdef: string }[]>(
      Prisma.sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'parcelas_pago_em_pago_idx'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].indexdef).toContain('pago_em');
    expect(r[0].indexdef).toContain("'PAGO'");
  });
});
