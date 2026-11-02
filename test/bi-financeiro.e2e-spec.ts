import { diaLocal } from '../src/bi/periodo';
import type { Contato, Usuario } from '../src/generated/prisma/client';
import { cartao, consultarPainel, criarCanal, DIA, linhasDa } from './bi-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarFila,
  criarUsuario,
  entrarComo,
} from './utils';

/** Dia `AAAA-MM-DD` de `n` dias atrás (em Brasília). */
function dia(n: number): string {
  return diaLocal(new Date(Date.now() - n * DIA));
}

function data(n: number): Date {
  return new Date(`${dia(n)}T00:00:00.000Z`);
}

describe('BI — painel Financeiro e risco de churn (e2e)', () => {
  let t: AppTeste;
  let sequencia = 0;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function contrato(opcoes: {
    contato: Contato;
    responsavel: Usuario;
    mrr: string;
    status?: 'ATIVO' | 'CANCELADO';
  }) {
    return t.prisma.contrato.create({
      data: {
        contatoId: opcoes.contato.id,
        produto: 'Plano teste',
        valor: opcoes.mrr,
        mrr: opcoes.mrr,
        inicioEm: data(200),
        status: opcoes.status ?? 'ATIVO',
        responsavelCsId: opcoes.responsavel.id,
      },
    });
  }

  async function movimento(
    contratoId: string,
    tipo: 'NOVO' | 'EXPANSAO' | 'CONTRACAO' | 'CHURN',
    delta: string,
    n: number,
  ) {
    await t.prisma.movimentoMrr.create({
      data: {
        contratoId,
        tipo,
        valorAnterior: '0',
        valorNovo: '0',
        delta,
        dia: data(n),
      },
    });
  }

  async function parcela(opcoes: {
    contrato: { id: string; contatoId: string | null };
    vencimento: number;
    valor: string;
    pago?: number;
    status?: 'ABERTO' | 'ATRASADO' | 'PAGO' | 'CANCELADO';
  }) {
    sequencia += 1;
    const vencimento = data(opcoes.vencimento);
    return t.prisma.parcela.create({
      data: {
        numero: `BI-${sequencia}`,
        contratoId: opcoes.contrato.id,
        contatoId: opcoes.contrato.contatoId,
        vencimento,
        vencimentoOriginal: vencimento,
        valor: opcoes.valor,
        valorPago: opcoes.pago !== undefined ? opcoes.valor : null,
        pagoEm: opcoes.pago !== undefined ? data(opcoes.pago) : null,
        status:
          opcoes.status ??
          (opcoes.pago !== undefined
            ? 'PAGO'
            : opcoes.vencimento > 0
              ? 'ATRASADO'
              : 'ABERTO'),
      },
    });
  }

  async function montar() {
    const { cLevel, lider, membros } = await criarEquipe(t, 'CS', {
      membros: 2,
    });
    const [m1, m2] = membros;
    const [c1, c2, c3] = await Promise.all([
      criarContato(t),
      criarContato(t),
      criarContato(t),
    ]);
    const k1 = await contrato({ contato: c1, responsavel: m1, mrr: '1000.00' });
    const k2 = await contrato({ contato: c2, responsavel: m2, mrr: '500.00' });
    const k3 = await contrato({
      contato: c3,
      responsavel: m2,
      mrr: '300.00',
      status: 'CANCELADO',
    });
    // Período atual (últimos 10 dias): dia -3. Anterior (10 dias antes): dia -14.
    await movimento(k1.id, 'NOVO', '1000.00', 3);
    await movimento(k2.id, 'NOVO', '400.00', 3);
    await movimento(k2.id, 'EXPANSAO', '100.00', 3);
    await movimento(k3.id, 'CHURN', '-300.00', 3);
    await movimento(k3.id, 'CONTRACAO', '-50.00', 14);
    await movimento(k1.id, 'NOVO', '700.00', 14);
    // Parcelas: vencidas e abertas em faixas, pagas no período e no anterior.
    await parcela({ contrato: k1, vencimento: 5, valor: '200.00' }); // 0-30
    await parcela({ contrato: k1, vencimento: 45, valor: '300.00' }); // 31-60
    await parcela({ contrato: k2, vencimento: 75, valor: '400.00' }); // 61-90
    await parcela({ contrato: k2, vencimento: 120, valor: '600.00' }); // 90+
    await parcela({ contrato: k2, vencimento: -10, valor: '100.00' }); // a vencer
    await parcela({ contrato: k1, vencimento: 4, valor: '250.00', pago: 3 });
    await parcela({ contrato: k2, vencimento: 20, valor: '150.00', pago: 14 });
    await parcela({
      contrato: k2,
      vencimento: 2,
      valor: '999.00',
      status: 'CANCELADO',
    });
    return { cLevel, lider, m1, m2, c1, c2, c3 };
  }

  it('R20, R23 — cartões do período e de agora batem com os dados conhecidos', async () => {
    const { cLevel } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, cLevel),
      'financeiro',
    );
    expect(cartao(painel, 'mrrAtual').valor).toBe(1500);
    expect(cartao(painel, 'contratosAtivos').valor).toBe(2);
    expect(cartao(painel, 'mrrNovo')).toMatchObject({
      valor: 1400,
      anterior: 700,
      variacao: 100,
    });
    expect(cartao(painel, 'mrrExpansao').valor).toBe(100);
    expect(cartao(painel, 'mrrContracao')).toMatchObject({
      valor: 0,
      anterior: 50,
    });
    expect(cartao(painel, 'mrrChurn').valor).toBe(300);
    // Recebido: 250 pago no dia -3; anterior: 150 pago no dia -14.
    expect(cartao(painel, 'recebido')).toMatchObject({
      valor: 250,
      anterior: 150,
    });
    // Previsto no período (vencimento de -9 a 0 no fuso do BI): só a parcela de 250 (dia -4)
    // e a de 200 (dia -5); a cancelada fica fora.
    expect(cartao(painel, 'previsto').valor).toBe(450);
    expect(cartao(painel, 'realizado').valor).toBe(250);
    expect(cartao(painel, 'taxaRealizacao').valor).toBe(55.56);
    // Inadimplência de agora: 200+300+400+600 = 1500 de 1600 a receber.
    expect(cartao(painel, 'valorInadimplente').valor).toBe(1500);
    expect(cartao(painel, 'taxaInadimplencia').valor).toBe(93.8);
    expect(cartao(painel, 'clientesInadimplentes').valor).toBe(2);
    expect(cartao(painel, 'valorInadimplente').anterior).toBeNull();
  });

  it('R20, R23.2 — inadimplência por faixa e séries mensais', async () => {
    const { cLevel } = await montar();
    const painel = await consultarPainel(
      await entrarComo(t, cLevel),
      'financeiro',
    );
    expect(linhasDa(painel, 'inadimplenciaPorFaixa')).toEqual([
      { faixa: '0-30', quantidade: 1, valor: 200, clientes: 1 },
      { faixa: '31-60', quantidade: 1, valor: 300, clientes: 1 },
      { faixa: '61-90', quantidade: 1, valor: 400, clientes: 1 },
      { faixa: '90+', quantidade: 1, valor: 600, clientes: 1 },
    ]);
    const mrr = linhasDa(painel, 'mrrPorMes');
    expect(mrr.length).toBeGreaterThanOrEqual(12);
    expect(mrr.at(-1)?.mes).toBe(dia(0).slice(0, 7));
    const somaNovo = mrr.reduce((s, l) => s + Number(l.novo), 0);
    expect(somaNovo).toBe(1400 + 700 + 0); // todos os NOVO (movimentos de 3 e 14 dias atrás)
    expect(Number(mrr.at(-1)?.mrr)).toBe(1000 + 400 + 100 - 300 - 50 + 700);
    const pr = linhasDa(painel, 'previstoRealizado');
    expect(pr.reduce((s, l) => s + Number(l.recebidoNoMes), 0)).toBe(400);
  });

  it('R1, R22.1 — membro de CS vê só a própria carteira; o líder vê tudo; o filtro de pessoa recorta', async () => {
    const { lider, m1, m2 } = await montar();
    const doM1 = await consultarPainel(await entrarComo(t, m1), 'financeiro');
    expect(cartao(doM1, 'mrrAtual').valor).toBe(1000);
    expect(cartao(doM1, 'mrrNovo').valor).toBe(1000);
    expect(cartao(doM1, 'valorInadimplente').valor).toBe(500);
    expect(cartao(doM1, 'clientesInadimplentes').valor).toBe(1);
    const doM2 = await consultarPainel(await entrarComo(t, m2), 'financeiro');
    expect(cartao(doM2, 'mrrAtual').valor).toBe(500);
    expect(cartao(doM2, 'valorInadimplente').valor).toBe(1000);
    const doLider = await consultarPainel(
      await entrarComo(t, lider),
      'financeiro',
    );
    expect(cartao(doLider, 'mrrAtual').valor).toBe(1500);
    const recorte = await consultarPainel(
      await entrarComo(t, lider),
      'financeiro',
      { pessoaId: m2.id },
    );
    expect(cartao(recorte, 'mrrAtual').valor).toBe(500);
    expect(cartao(recorte, 'mrrChurn').valor).toBe(300);
    expect(linhasDa(recorte, 'inadimplenciaPorFaixa')[0]).toMatchObject({
      quantidade: 0,
    });
  });

  it('R20 — Comercial e Marketing não acessam o painel Financeiro', async () => {
    await montar();
    const comercial = await criarUsuario(t, { papel: 'COMERCIAL' });
    const marketing = await criarUsuario(t, { papel: 'MARKETING' });
    await consultarPainel(
      await entrarComo(t, comercial),
      'financeiro',
      {},
      403,
    );
    await consultarPainel(
      await entrarComo(t, marketing),
      'financeiro',
      {},
      403,
    );
  });

  it('R23.4, R20 — o painel CS mostra o risco de churn (atraso + satisfação baixa + silêncio)', async () => {
    const { cLevel, m1, m2, c1, c2 } = await montar();
    // c1: atraso de 45 dias (35) + nota 1 (30) = 65 → ALTO. c2: atraso de 120 dias (50) → MÉDIO.
    const canal = await criarCanal(t);
    const fila = await criarFila(t, { area: 'CS' });
    const agora = new Date();
    await t.prisma.conversa.create({
      data: {
        canalId: canal.id,
        contatoId: c1.id,
        filaId: fila.id,
        responsavelId: m1.id,
        status: 'RESOLVIDA',
        ultimaMensagemEm: agora,
        resolvidaEm: agora,
        satisfacaoNota: 1,
        satisfacaoRespondidaEm: agora,
      },
    });
    await t.prisma.conversa.create({
      data: {
        canalId: canal.id,
        contatoId: c2.id,
        filaId: fila.id,
        responsavelId: m2.id,
        status: 'ABERTA',
        ultimaMensagemEm: agora,
      },
    });
    const painel = await consultarPainel(await entrarComo(t, cLevel), 'cs');
    expect(cartao(painel, 'riscoAlto').valor).toBe(1);
    expect(cartao(painel, 'riscoMedio').valor).toBe(1);
    expect(cartao(painel, 'riscoAlto').anterior).toBeNull();
    const tabela = linhasDa(painel, 'riscoDeChurn');
    expect(tabela.map((l) => [l.contatoId, l.pontuacao, l.nivel])).toEqual([
      [c1.id, 65, 'Alto'],
      [c2.id, 50, 'Médio'],
    ]);
    // O membro m2 só enxerga o próprio cliente (c2).
    const doM2 = await consultarPainel(await entrarComo(t, m2), 'cs');
    expect(linhasDa(doM2, 'riscoDeChurn').map((l) => l.contatoId)).toEqual([
      c2.id,
    ]);
    expect(cartao(doM2, 'riscoAlto').valor).toBe(0);
  });
});
