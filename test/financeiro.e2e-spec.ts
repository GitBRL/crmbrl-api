import { ContratosService } from '../src/financeiro/contratos.service';
import { hojeLocal, somarDias, somarMeses } from '../src/financeiro/datas';
import { IndicadoresFinanceirosService } from '../src/financeiro/indicadores.service';
import { ParcelasService } from '../src/financeiro/parcelas.service';
import { RiscoDeChurnService } from '../src/financeiro/risco-de-churn.service';
import { TIPO_NOTIFICACAO_SUGESTAO_CONTRATO } from '../src/financeiro/sugestao-de-contrato.service';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { EventosDominioService } from '../src/eventos/eventos-dominio.service';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarArquivo,
  criarContato,
  criarConversa,
  criarEmpresa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarTudo,
  entrarComo,
  processarEventos,
} from './utils';

interface ParcelaApi {
  id: string;
  numero: string;
  status: string;
  statusGravado: string;
  valor: string;
  vencimento: string;
  diasEmAtraso: number;
  faixaDeAtraso: string | null;
  contrato: { id: string; codigo: string } | null;
  pagoEm: string | null;
  linkBoleto: string | null;
}

interface ContratoApi {
  id: string;
  codigo: string;
  status: string;
  mrr: string;
  valor: string;
  resumoParcelas?: {
    total: number;
    abertas: number;
    pagas: number;
    valorEmAberto: string;
  };
}

describe('Financeiro — contratos, parcelas e indicadores (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function admin(): Promise<ClienteHttp> {
    return entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  }

  async function contratoMensal(
    cliente: ClienteHttp,
    extra: Record<string, unknown> = {},
  ): Promise<ContratoApi> {
    const contato = await criarContato(t);
    const r = await cliente
      .post('/api/v1/financeiro/contratos', {
        contatoId: contato.id,
        produto: 'Plano Pro',
        valor: '300.00',
        periodicidade: 'MENSAL',
        inicioEm: somarMeses(hojeLocal(), -2),
        fimEm: somarMeses(hojeLocal(), 3),
        ...extra,
      })
      .expect(201);
    return r.body as ContratoApi;
  }

  async function parcelasDo(
    cliente: ClienteHttp,
    contratoId: string,
  ): Promise<ParcelaApi[]> {
    const r = await cliente
      .get(`/api/v1/financeiro/parcelas?contratoId=${contratoId}&porPagina=100`)
      .expect(200);
    return (r.body as { itens: ParcelaApi[] }).itens;
  }

  // ------------------------------------------------------------------ R22.1

  it('R22.1 — Marketing não acessa; CS vê só a carteira; Comercial só lê; líder de CS vê tudo', async () => {
    const cs = await criarEquipe(t, 'CS', { membros: 2 });
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const marketing = await criarUsuario(t, { papel: 'MARKETING' });
    const clienteAdmin = await admin();

    const contratoDoCs1 = await contratoMensal(clienteAdmin, {
      responsavelCsId: cs.membros[0].id,
    });
    await contratoMensal(clienteAdmin, { responsavelCsId: cs.membros[1].id });
    const negocio = await criarNegocio(t, {
      etapa: 'ganho',
      responsavel: comercial.membros[0],
    });
    const doNegocio = await clienteAdmin
      .post('/api/v1/financeiro/contratos', {
        negocioId: negocio.id,
        produto: 'Plano Anual',
        valor: '1200.00',
        periodicidade: 'ANUAL',
        inicioEm: hojeLocal(),
      })
      .expect(201);

    await (
      await entrarComo(t, marketing)
    )
      .get('/api/v1/financeiro/contratos')
      .expect(403);

    const clienteCs = await entrarComo(t, cs.membros[0]);
    const doCs = await clienteCs
      .get('/api/v1/financeiro/contratos')
      .expect(200);
    expect(
      (doCs.body as { itens: ContratoApi[] }).itens.map((c) => c.id),
    ).toEqual([contratoDoCs1.id]);
    await clienteCs
      .get(`/api/v1/financeiro/contratos/${(doNegocio.body as ContratoApi).id}`)
      .expect(404);
    await clienteCs
      .patch(`/api/v1/financeiro/contratos/${contratoDoCs1.id}`, {
        produto: 'Plano Pro Plus',
      })
      .expect(200);
    await clienteCs.get('/api/v1/financeiro/regua/configuracao').expect(200);
    await clienteCs
      .patch('/api/v1/financeiro/regua/configuracao', { horario: '10:00' })
      .expect(403);
    await clienteCs.post('/api/v1/financeiro/regua/executar').expect(403);

    const clienteComercial = await entrarComo(t, comercial.membros[0]);
    const doComercial = await clienteComercial
      .get('/api/v1/financeiro/contratos')
      .expect(200);
    expect(
      (doComercial.body as { itens: ContratoApi[] }).itens.map((c) => c.id),
    ).toEqual([(doNegocio.body as ContratoApi).id]);
    await clienteComercial
      .post('/api/v1/financeiro/contratos', {
        contatoId: (await criarContato(t)).id,
        produto: 'X',
        valor: '1.00',
        inicioEm: hojeLocal(),
      })
      .expect(403);
    await clienteComercial
      .post(
        `/api/v1/financeiro/contratos/${(doNegocio.body as ContratoApi).id}/suspender`,
      )
      .expect(403);
    await clienteComercial.get('/api/v1/financeiro/regua/etapas').expect(403);
    const outroComercial = await entrarComo(t, comercial.membros[1]);
    await outroComercial
      .get(`/api/v1/financeiro/contratos/${(doNegocio.body as ContratoApi).id}`)
      .expect(404);

    const lider = await entrarComo(t, cs.lider);
    const todos = await lider.get('/api/v1/financeiro/contratos').expect(200);
    expect((todos.body as { total: number }).total).toBe(3);
    await lider
      .patch('/api/v1/financeiro/regua/configuracao', { toleranciaDias: 5 })
      .expect(200);
  });

  // ------------------------------------------------------------------ R22.2 / R22.3

  it('R22.2 — contrato de negócio ganho gera parcelas e o movimento "novo" do MRR; negócio aberto é recusado', async () => {
    const c = await admin();
    const negocioAberto = await criarNegocio(t);
    await c
      .post('/api/v1/financeiro/contratos', {
        negocioId: negocioAberto.id,
        produto: 'X',
        valor: '10.00',
        inicioEm: hojeLocal(),
      })
      .expect(422);
    await c
      .post('/api/v1/financeiro/contratos', {
        produto: 'X',
        valor: '10.00',
        inicioEm: hojeLocal(),
      })
      .expect(400);

    const contrato = await contratoMensal(c);
    expect(contrato.mrr).toBe('300.00');
    expect(contrato.codigo).toMatch(/^C-\d{6}$/);
    const parcelas = await parcelasDo(c, contrato.id);
    // início há 2 meses até daqui a 3: 6 parcelas, 3 já vencidas.
    expect(parcelas).toHaveLength(6);
    expect(parcelas.filter((p) => p.status === 'ATRASADO')).toHaveLength(2);
    expect(parcelas[0].numero).toBe(`${contrato.codigo}-01`);
    const movimentos = await t.prisma.movimentoMrr.findMany({
      where: { contratoId: contrato.id },
    });
    expect(movimentos).toHaveLength(1);
    expect(movimentos[0]).toMatchObject({ tipo: 'NOVO' });
    expect(movimentos[0].delta.toFixed(2)).toBe('300.00');
    const detalhe = await c
      .get(`/api/v1/financeiro/contratos/${contrato.id}`)
      .expect(200);
    expect((detalhe.body as ContratoApi).resumoParcelas).toMatchObject({
      total: 6,
    });
    const auditoria = await t.prisma.eventoAuditoria.findFirst({
      where: { acao: 'contrato.criado' },
    });
    expect(auditoria?.entidadeId).toBe(contrato.id);
  });

  it('R22.2 — contrato anual: o MRR é 1/12 do valor; cobrança única não entra no MRR', async () => {
    const c = await admin();
    const anual = await contratoMensal(c, {
      valor: '1200.00',
      periodicidade: 'ANUAL',
      fimEm: null,
    });
    expect(anual.mrr).toBe('100.00');
    const unico = await contratoMensal(c, {
      valor: '500.00',
      periodicidade: 'UNICO',
      fimEm: null,
    });
    expect(unico.mrr).toBe('0.00');
    expect(await parcelasDo(c, unico.id)).toHaveLength(1);
    expect(
      await t.prisma.movimentoMrr.count({ where: { contratoId: unico.id } }),
    ).toBe(0);
  });

  // ------------------------------------------------------------------ R23.1

  it('R23.1 — MRR por mês: novo, expansão, contração e churn; cancelar cancela as parcelas que não venceram', async () => {
    const c = await admin();
    const contrato = await contratoMensal(c);
    await c
      .patch(`/api/v1/financeiro/contratos/${contrato.id}`, { valor: '500.00' })
      .expect(200);
    await c
      .patch(`/api/v1/financeiro/contratos/${contrato.id}`, {
        valor: '450.00',
        atualizarParcelasAbertas: true,
      })
      .expect(200);
    const outro = await contratoMensal(c, { valor: '100.00' });

    const mes = hojeLocal().slice(0, 7);
    let r = await c
      .get(`/api/v1/financeiro/indicadores/mrr?de=${mes}&ate=${mes}`)
      .expect(200);
    let linha = (r.body as { meses: Record<string, string>[] }).meses[0];
    expect(linha).toMatchObject({
      novo: '400.00',
      expansao: '200.00',
      contracao: '50.00',
      churn: '0.00',
      mrr: '550.00',
    });

    await c
      .post(`/api/v1/financeiro/contratos/${outro.id}/cancelar`, {
        motivo: 'Preço',
      })
      .expect(200);
    await c
      .post(`/api/v1/financeiro/contratos/${outro.id}/cancelar`, {
        motivo: 'Preço',
      })
      .expect(409);
    await c
      .post(`/api/v1/financeiro/contratos/${outro.id}/cancelar`, {})
      .expect(400);
    const depois = await parcelasDo(c, outro.id);
    expect(
      depois.filter((p) => p.statusGravado === 'CANCELADO').length,
    ).toBeGreaterThan(0);
    expect(
      depois.some(
        (p) => p.statusGravado === 'ABERTO' && p.vencimento >= hojeLocal(),
      ),
    ).toBe(false);
    r = await c
      .get(`/api/v1/financeiro/indicadores/mrr?de=${mes}&ate=${mes}`)
      .expect(200);
    linha = (
      r.body as {
        meses: Record<string, string>[];
        atual: { mrr: string; contratos: number };
      }
    ).meses[0];
    expect(linha).toMatchObject({ churn: '100.00', mrr: '450.00' });
    expect(
      (r.body as { atual: { mrr: string; contratos: number } }).atual,
    ).toEqual({ mrr: '450.00', contratos: 1 });
    const parcelasAbertasDoPrimeiro = await parcelasDo(c, contrato.id);
    const futuras = parcelasAbertasDoPrimeiro.filter(
      (p) => p.vencimento >= hojeLocal(),
    );
    expect(futuras.every((p) => p.valor === '450.00')).toBe(true);

    await c
      .post(`/api/v1/financeiro/contratos/${contrato.id}/suspender`)
      .expect(200);
    await c
      .post(`/api/v1/financeiro/contratos/${contrato.id}/suspender`)
      .expect(422);
    await c
      .post(`/api/v1/financeiro/contratos/${contrato.id}/reativar`)
      .expect(200);
    const reativado = await c
      .post(`/api/v1/financeiro/contratos/${outro.id}/reativar`)
      .expect(200);
    expect((reativado.body as ContratoApi).status).toBe('ATIVO');
    r = await c
      .get(`/api/v1/financeiro/indicadores/mrr?de=${mes}&ate=${mes}`)
      .expect(200);
    expect((r.body as { meses: Record<string, string>[] }).meses[0].novo).toBe(
      '500.00',
    );
  });

  it('R22.2 — contrato sem renovação é encerrado ao fim do prazo (churn); com renovação automática, estende e gera parcelas', async () => {
    const c = await admin();
    const encerrar = await contratoMensal(c, {
      inicioEm: '2025-01-10',
      fimEm: '2025-03-31',
    });
    const renovar = await contratoMensal(c, {
      inicioEm: '2025-01-10',
      fimEm: '2025-03-31',
      renovacaoAutomatica: true,
    });
    const resultado = await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
      t.get(ContratosService).processarVencimentos(hojeLocal()),
    );
    expect(resultado).toEqual({ renovados: 1, encerrados: 1 });
    const a = await c
      .get(`/api/v1/financeiro/contratos/${encerrar.id}`)
      .expect(200);
    expect((a.body as ContratoApi).status).toBe('ENCERRADO');
    expect(
      await t.prisma.movimentoMrr.count({
        where: { contratoId: encerrar.id, tipo: 'CHURN' },
      }),
    ).toBe(1);
    const b = await c
      .get(`/api/v1/financeiro/contratos/${renovar.id}`)
      .expect(200);
    expect((b.body as ContratoApi).status).toBe('ATIVO');
    expect((await parcelasDo(c, renovar.id)).length).toBe(3 + 12);
  });

  // ------------------------------------------------------------------ R22.4

  it('R22.4 — baixa manual marca como pago, audita e publica parcela.paga; a segunda baixa é recusada', async () => {
    const c = await admin();
    const contrato = await contratoMensal(c);
    const [primeira] = await parcelasDo(c, contrato.id);
    const r = await c
      .post(`/api/v1/financeiro/parcelas/${primeira.id}/baixa`, {
        formaPagamento: 'pix',
        valorPago: '299.00',
      })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'PAGO',
      valorPago: '299.00',
      formaPagamento: 'PIX',
      baixaOrigem: 'MANUAL',
      pagoEm: hojeLocal(),
    });
    await c
      .post(`/api/v1/financeiro/parcelas/${primeira.id}/baixa`, {})
      .expect(422);
    await c
      .post(`/api/v1/financeiro/parcelas/${primeira.id}/baixa`, {
        pagoEm: '31/02/2026',
      })
      .expect(400);
    const evento = await t.prisma.eventoDominio.findFirst({
      where: { tipo: 'parcela.paga' },
    });
    expect((evento?.dados as { parcelaId: string }).parcelaId).toBe(
      primeira.id,
    );
    const aud = await t.prisma.eventoAuditoria.findFirst({
      where: { acao: 'parcela.baixada', entidadeId: primeira.id },
    });
    expect(aud?.resumo).toContain('Baixa do título');
    const resumo = await c
      .get(`/api/v1/financeiro/contratos/${contrato.id}`)
      .expect(200);
    expect((resumo.body as ContratoApi).resumoParcelas?.pagas).toBe(1);
  });

  it('R22.3 — parcela manual: número único, edição bloqueada depois do pagamento, renegociação cria outra parcela', async () => {
    const c = await admin();
    const contato = await criarContato(t);
    const criar = (extra: object = {}) =>
      c.post('/api/v1/financeiro/parcelas', {
        contatoId: contato.id,
        numero: 'NF-100',
        vencimento: somarDias(hojeLocal(), 10),
        valor: '80.00',
        ...extra,
      });
    const criada = (await criar().expect(201)).body as ParcelaApi;
    await criar().expect(409);
    await c
      .post('/api/v1/financeiro/parcelas', {
        vencimento: hojeLocal(),
        valor: '1.00',
      })
      .expect(400);
    const editada = await c
      .patch(`/api/v1/financeiro/parcelas/${criada.id}`, {
        linkBoleto: 'https://x.co/b',
        valor: '90.00',
      })
      .expect(200);
    expect(editada.body).toMatchObject({
      linkBoleto: 'https://x.co/b',
      valor: '90.00',
    });

    const reneg = await c
      .post(`/api/v1/financeiro/parcelas/${criada.id}/renegociar`, {
        vencimento: somarDias(hojeLocal(), 30),
        valor: '95.00',
      })
      .expect(200);
    expect(reneg.body).toMatchObject({
      numero: 'NF-100-R1',
      valor: '95.00',
      origem: 'RENEGOCIACAO',
      status: 'ABERTO',
    });
    const antiga = await c
      .get(`/api/v1/financeiro/parcelas/${criada.id}`)
      .expect(200);
    expect((antiga.body as ParcelaApi).status).toBe('RENEGOCIADO');
    await c
      .patch(`/api/v1/financeiro/parcelas/${criada.id}`, { valor: '1.00' })
      .expect(422);
    await c
      .post(`/api/v1/financeiro/parcelas/${criada.id}/cancelar`)
      .expect(422);
    const nova = (reneg.body as ParcelaApi).id;
    await c.post(`/api/v1/financeiro/parcelas/${nova}/cancelar`).expect(200);
  });

  // ------------------------------------------------------------------ R22.7

  it('R22.7 — a parcela vencida aparece como atrasada na hora e o job marca o status e publica parcela.atrasada', async () => {
    const c = await admin();
    const contato = await criarContato(t);
    const r = await c
      .post('/api/v1/financeiro/parcelas', {
        contatoId: contato.id,
        numero: 'ATR-1',
        vencimento: somarDias(hojeLocal(), -3),
        valor: '50.00',
      })
      .expect(201);
    const parcela = r.body as ParcelaApi;
    expect(parcela).toMatchObject({
      status: 'ATRASADO',
      diasEmAtraso: 3,
      faixaDeAtraso: '0-30',
    });
    await t.prisma.parcela.update({
      where: { id: parcela.id },
      data: { status: 'ABERTO' },
    });
    const lista = await c
      .get('/api/v1/financeiro/parcelas?status=ATRASADO')
      .expect(200);
    expect(
      (lista.body as { itens: ParcelaApi[] }).itens.map((p) => p.numero),
    ).toEqual(['ATR-1']);
    const aberta = await c
      .get('/api/v1/financeiro/parcelas?status=ABERTO')
      .expect(200);
    expect((aberta.body as { total: number }).total).toBe(0);

    expect(await t.get(ParcelasService).marcarAtrasadas()).toBe(1);
    expect(await t.get(ParcelasService).marcarAtrasadas()).toBe(0);
    expect(
      (await t.prisma.parcela.findUniqueOrThrow({ where: { id: parcela.id } }))
        .status,
    ).toBe('ATRASADO');
    const evento = await t.prisma.eventoDominio.findFirst({
      where: { tipo: 'parcela.atrasada' },
    });
    expect((evento?.dados as { numero: string }).numero).toBe('ATR-1');
    const totais = await c
      .get('/api/v1/financeiro/parcelas/totais')
      .expect(200);
    expect(
      (totais.body as { porStatus: Record<string, { quantidade: number }> })
        .porStatus.ATRASADO.quantidade,
    ).toBe(1);
  });

  // ------------------------------------------------------------------ R23.2 / R23.3

  it('R23.2 — inadimplência por faixa: 0–30, 31–60, 61–90 e 90+, só do que o usuário vê', async () => {
    const c = await admin();
    const cs = await criarEquipe(t, 'CS', { membros: 1 });
    const meu = await criarContato(t, { responsavel: cs.membros[0] });
    const alheio = await criarContato(t);
    const dias = [5, 30, 31, 61, 95];
    let i = 0;
    for (const d of dias) {
      await c
        .post('/api/v1/financeiro/parcelas', {
          contatoId: i++ < 3 ? meu.id : alheio.id,
          numero: `INAD-${d}`,
          vencimento: somarDias(hojeLocal(), -d),
          valor: '100.00',
        })
        .expect(201);
    }
    await c
      .post('/api/v1/financeiro/parcelas', {
        contatoId: meu.id,
        numero: 'FUTURA',
        vencimento: somarDias(hojeLocal(), 5),
        valor: '300.00',
      })
      .expect(201);
    const r = await c
      .get('/api/v1/financeiro/indicadores/inadimplencia')
      .expect(200);
    const corpo = r.body as {
      faixas: {
        faixa: string;
        quantidade: number;
        valor: string;
        clientes: number;
      }[];
      total: { quantidade: number; valor: string; clientes: number };
      taxa: number;
    };
    expect(corpo.faixas.map((f) => [f.faixa, f.quantidade])).toEqual([
      ['0-30', 2],
      ['31-60', 1],
      ['61-90', 1],
      ['90+', 1],
    ]);
    expect(corpo.total).toEqual({
      quantidade: 5,
      valor: '500.00',
      clientes: 2,
    });
    expect(corpo.taxa).toBe(62.5);

    const doCs = await (
      await entrarComo(t, cs.membros[0])
    )
      .get('/api/v1/financeiro/indicadores/inadimplencia')
      .expect(200);
    expect((doCs.body as typeof corpo).total).toEqual({
      quantidade: 3,
      valor: '300.00',
      clientes: 1,
    });
  });

  it('R23.3 — receita prevista × realizada por mês', async () => {
    const c = await admin();
    const contato = await criarContato(t);
    const mes = hojeLocal().slice(0, 7);
    const mesAnterior = somarMeses(`${mes}-01`, -1, 1).slice(0, 7);
    const nova = async (numero: string, vencimento: string, valor: string) =>
      (
        await c
          .post('/api/v1/financeiro/parcelas', {
            contatoId: contato.id,
            numero,
            vencimento,
            valor,
          })
          .expect(201)
      ).body as ParcelaApi;
    const a = await nova('PR-1', `${mes}-01`, '100.00');
    await nova('PR-2', `${mes}-02`, '200.00');
    const cancelada = await nova('PR-3', `${mes}-03`, '999.00');
    await c
      .post(`/api/v1/financeiro/parcelas/${cancelada.id}/cancelar`)
      .expect(200);
    const velha = await nova('PR-4', `${mesAnterior}-15`, '50.00');
    await c
      .post(`/api/v1/financeiro/parcelas/${a.id}/baixa`, {
        valorPago: '100.00',
        pagoEm: `${mes}-01`,
      })
      .expect(200);
    await c
      .post(`/api/v1/financeiro/parcelas/${velha.id}/baixa`, {
        valorPago: '50.00',
        pagoEm: `${mes}-01`,
      })
      .expect(200);

    const r = await c
      .get(
        `/api/v1/financeiro/indicadores/previsto-realizado?de=${mesAnterior}&ate=${mes}`,
      )
      .expect(200);
    const meses = (r.body as { meses: Record<string, string | number>[] })
      .meses;
    expect(meses[0]).toMatchObject({
      mes: mesAnterior,
      previsto: '50.00',
      realizado: '50.00',
      taxaDeRealizacao: 100,
    });
    expect(meses[1]).toMatchObject({
      mes,
      previsto: '300.00',
      realizado: '100.00',
      emAberto: '200.00',
      recebidoNoMes: '150.00',
      taxaDeRealizacao: 33.3,
    });
    const resumo = await c
      .get('/api/v1/financeiro/indicadores/resumo')
      .expect(200);
    expect(
      (resumo.body as { previstoRealizado: { previsto: string } })
        .previstoRealizado.previsto,
    ).toBe('300.00');
    await c.get('/api/v1/financeiro/indicadores/mrr?de=2026-13').expect(400);
  });

  // ------------------------------------------------------------------ R23.4 / R20

  it('R23.4 — risco de churn soma atraso, satisfação baixa e silêncio; o serviço de leitura serve ao BI (R20)', async () => {
    const c = await admin();
    const lider = await criarEquipe(t, 'CS', { membros: 1 });
    const contato = await criarContato(t, { responsavel: lider.membros[0] });
    const tranquilo = await criarContato(t, { responsavel: lider.membros[0] });
    const mk = async (cid: string, extra: object) =>
      c
        .post('/api/v1/financeiro/contratos', {
          contatoId: cid,
          produto: 'Plano',
          valor: '100.00',
          inicioEm: somarDias(hojeLocal(), -120),
          responsavelCsId: lider.membros[0].id,
          gerarParcelas: false,
          ...extra,
        })
        .expect(201);
    await mk(contato.id, {});
    await mk(tranquilo.id, {});
    await c
      .post('/api/v1/financeiro/parcelas', {
        contatoId: contato.id,
        numero: 'RC-1',
        vencimento: somarDias(hojeLocal(), -40),
        valor: '100.00',
      })
      .expect(201);
    const conversa = await criarConversa(t, { contato });
    await t.prisma.conversa.update({
      where: { id: conversa.id },
      data: {
        satisfacaoNota: 2,
        satisfacaoRespondidaEm: new Date(),
        ultimaMensagemEm: new Date(),
      },
    });
    // O contato "tranquilo" tem conversa recente e nota 5.
    const conversa2 = await criarConversa(t, { contato: tranquilo });
    await t.prisma.conversa.update({
      where: { id: conversa2.id },
      data: {
        satisfacaoNota: 5,
        satisfacaoRespondidaEm: new Date(),
        ultimaMensagemEm: new Date(),
      },
    });

    const r = await c
      .get(`/api/v1/financeiro/risco-churn/contatos/${contato.id}`)
      .expect(200);
    const risco = (
      r.body as {
        risco: {
          pontuacao: number;
          nivel: string;
          fatores: { tipo: string; pontos: number }[];
        };
      }
    ).risco;
    expect(risco.nivel).toBe('ALTO');
    expect(risco.pontuacao).toBe(65);
    expect(risco.fatores.map((f) => f.tipo).sort()).toEqual([
      'ATRASO',
      'SATISFACAO',
    ]);
    const ok = await c
      .get(`/api/v1/financeiro/risco-churn/contatos/${tranquilo.id}`)
      .expect(200);
    expect((ok.body as { risco: { nivel: string } }).risco.nivel).toBe('BAIXO');

    const sem = await c
      .get(
        `/api/v1/financeiro/risco-churn/contatos/${(await criarContato(t)).id}`,
      )
      .expect(200);
    expect((sem.body as { risco: unknown }).risco).toBeNull();
    const ranking = await c
      .get('/api/v1/financeiro/risco-churn?nivelMinimo=ALTO')
      .expect(200);
    expect(
      (ranking.body as { contato: { id: string } }[]).map((x) => x.contato.id),
    ).toEqual([contato.id]);

    // Serviços de leitura para o BI.
    const doBi = { id: lider.lider.id, papel: lider.lider.papel };
    expect(await t.get(RiscoDeChurnService).contagemPorNivel(doBi)).toEqual({
      BAIXO: 1,
      MEDIO: 0,
      ALTO: 1,
    });
    const inad = await t.get(IndicadoresFinanceirosService).inadimplencia(doBi);
    expect(inad.total.valor).toBe('100.00');
    const mrr = await t.get(IndicadoresFinanceirosService).mrr(doBi);
    expect(mrr.atual).toEqual({ mrr: '200.00', contratos: 2 });
    // Quem não vê o cliente não enxerga o risco (nem o atraso).
    const outro = await criarEquipe(t, 'CS', { membros: 1 });
    expect(
      await t
        .get(RiscoDeChurnService)
        .doContato({ id: outro.membros[0].id, papel: 'CS' }, contato.id),
    ).toBeNull();
  });

  // ------------------------------------------------------------------ R22.6

  it('R22.6 — ao ganhar um negócio o CRM sugere criar o contrato (notificação e dados pré-preenchidos)', async () => {
    const equipeCs = await criarEquipe(t, 'CS', { membros: 0 });
    const equipeCom = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const empresa = await criarEmpresa(t);
    const negocio = await criarNegocio(t, {
      etapa: 'ganho',
      responsavel: equipeCom.membros[0],
      empresa,
      valor: '900.00',
      valorRecorrente: '150.00',
      titulo: 'Plano Pro',
    });
    await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
      t.prisma.$transaction((tx) =>
        t.get(EventosDominioService).publicar(tx, 'negocio.ganho', {
          negocioId: negocio.id,
          funilId: negocio.funilId,
          valor: '900.00',
        }),
      ),
    );
    await processarEventos(t);
    await processarEventos(t);
    const notificacoes = await t.prisma.notificacao.findMany({
      where: { tipo: TIPO_NOTIFICACAO_SUGESTAO_CONTRATO },
    });
    expect(notificacoes.map((n) => n.usuarioId).sort()).toEqual(
      [equipeCom.membros[0].id, equipeCs.lider.id].sort(),
    );
    expect(notificacoes[0].link).toBe(
      `/financeiro/contratos/novo?negocio=${negocio.id}`,
    );

    const clienteCs = await entrarComo(t, equipeCs.lider);
    const r = await clienteCs
      .get(`/api/v1/financeiro/negocios/${negocio.id}/sugestao-de-contrato`)
      .expect(200);
    expect(r.body).toMatchObject({
      negocioGanho: true,
      jaTemContrato: false,
      sugestao: {
        produto: 'Plano Pro',
        valor: '150.00',
        periodicidade: 'MENSAL',
        empresaId: empresa.id,
      },
    });
    const lista = await clienteCs
      .get('/api/v1/financeiro/negocios/sem-contrato')
      .expect(200);
    expect((lista.body as { id: string }[]).map((n) => n.id)).toEqual([
      negocio.id,
    ]);
    await clienteCs
      .post('/api/v1/financeiro/contratos', {
        negocioId: negocio.id,
        produto: 'Plano Pro',
        valor: '150.00',
        inicioEm: hojeLocal(),
        fimEm: somarMeses(hojeLocal(), 2),
      })
      .expect(201);
    expect(
      (
        (
          await clienteCs
            .get('/api/v1/financeiro/negocios/sem-contrato')
            .expect(200)
        ).body as unknown[]
      ).length,
    ).toBe(0);
  });

  // ------------------------------------------------------------------ R22.5

  describe('importação de parcelas (R22.5)', () => {
    async function importar(
      cliente: ClienteHttp,
      csv: string,
      opcoes: Record<string, unknown> = {},
    ) {
      const arquivo = await criarArquivo(t, {
        contexto: 'IMPORTACAO',
        nome: 'titulos.csv',
        mime: 'text/csv',
        conteudo: csv,
        criadoPor: cliente.usuario!,
      });
      const criada = (
        await cliente
          .post('/api/v1/importacoes', {
            tipo: 'PARCELAS',
            arquivoId: arquivo.id,
          })
          .expect(201)
      ).body as {
        id: string;
        previa: { sugestao: Record<string, string> };
      };
      if (Object.keys(opcoes).length > 0) {
        await cliente
          .patch(`/api/v1/importacoes/${criada.id}`, opcoes)
          .expect(200);
      }
      await cliente
        .post(`/api/v1/importacoes/${criada.id}/iniciar`)
        .expect(200);
      await drenarTudo(t);
      const final = await cliente
        .get(`/api/v1/importacoes/${criada.id}`)
        .expect(200);
      return {
        sugestao: criada.previa.sugestao,
        ...(final.body as Record<string, unknown>),
      } as {
        sugestao: Record<string, string>;
        status: string;
        criados: number;
        atualizados: number;
        ignorados: number;
        erros: number;
      };
    }

    const amanha = somarDias(hojeLocal(), 1);
    const csvInicial = [
      'Número do título,Cliente,E-mail,Telefone,Vencimento,Valor,Link do boleto,Situação',
      `T-1,Ana Souza,ana@teste.local,11987654321,${somarDias(hojeLocal(), -10)},"1.234,56",https://x.co/b1,aberto`,
      `T-2,Bruno Lima,bruno@teste.local,,${amanha},300.00,,aberto`,
      `T-3,Carla Dias,carla@teste.local,,${amanha},50.00,,pago`,
      `T-4,,,,${amanha},50.00,,aberto`,
      `T-5,Duda,duda@teste.local,,31/02/2026,10.00,,aberto`,
      '',
    ].join('\n');

    it('R22.5 — importa títulos criando clientes, dando baixa nos pagos e relatando os erros; só gestão importa', async () => {
      const cs = await criarEquipe(t, 'CS', { membros: 1 });
      const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
      const arquivo = await criarArquivo(t, {
        contexto: 'IMPORTACAO',
        nome: 'a.csv',
        mime: 'text/csv',
        conteudo: 'A,B\n1,2\n',
        criadoPor: comercial.lider,
      });
      await (
        await entrarComo(t, comercial.lider)
      )
        .post('/api/v1/importacoes', {
          tipo: 'PARCELAS',
          arquivoId: arquivo.id,
        })
        .expect(403);

      const c = await entrarComo(t, cs.lider);
      const r = await importar(c, csvInicial);
      expect(r.sugestao).toMatchObject({
        'Número do título': 'numero',
        Cliente: 'nome',
        Valor: 'valor',
        'Link do boleto': 'linkBoleto',
      });
      expect(r).toMatchObject({ status: 'CONCLUIDA', criados: 3, erros: 2 });
      const t1 = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-1' },
        include: { contato: true },
      });
      expect(t1.valor.toFixed(2)).toBe('1234.56');
      expect(t1.status).toBe('ATRASADO');
      expect(t1.origem).toBe('IMPORTACAO');
      expect(t1.contato?.email).toBe('ana@teste.local');
      expect(t1.linkBoleto).toBe('https://x.co/b1');
      const t3 = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-3' },
      });
      expect(t3).toMatchObject({ status: 'PAGO', baixaOrigem: 'IMPORTACAO' });
      expect(
        await t.prisma.eventoDominio.count({ where: { tipo: 'parcela.paga' } }),
      ).toBe(1);
      expect(await t.prisma.parcela.count()).toBe(3);
    });

    it('R22.5 — reimportar atualiza pelo número, baixa os pagos, reinicia a régua de quem mudou o vencimento e não apaga colunas ausentes', async () => {
      const c = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
      await importar(c, csvInicial);
      const antes = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-2' },
      });
      await t.prisma.reguaEnvio.create({
        data: {
          parcelaId: antes.id,
          ciclo: 1,
          marco: -3,
          etapaNome: 'Lembrete',
          canal: 'WHATSAPP',
          situacao: 'AGENDADO',
          dia: antes.vencimento,
        },
      });
      const novoVenc = somarDias(hojeLocal(), 20);
      const csv2 = [
        'Número do título,Vencimento,Situação,Valor,Link do boleto',
        `T-1,,pago,,`,
        `T-2,${novoVenc},aberto,,`,
        `T-3,${amanha},aberto,,`,
        '',
      ].join('\n');
      const r = await importar(c, csv2, { duplicados: 'SOBRESCREVER' });
      expect(r).toMatchObject({
        status: 'CONCLUIDA',
        criados: 0,
        atualizados: 2,
        ignorados: 1,
      });
      const t1 = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-1' },
      });
      expect(t1).toMatchObject({ status: 'PAGO', baixaOrigem: 'IMPORTACAO' });
      expect(t1.linkBoleto).toBe('https://x.co/b1');
      expect(t1.valor.toFixed(2)).toBe('1234.56');
      const t2 = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-2' },
      });
      expect(t2.cicloRegua).toBe(2);
      expect(t2.vencimento.toISOString().slice(0, 10)).toBe(novoVenc);
      expect(t2.valor.toFixed(2)).toBe('300.00');
      expect(
        (
          await t.prisma.reguaEnvio.findFirstOrThrow({
            where: { parcelaId: t2.id },
          })
        ).situacao,
      ).toBe('CANCELADO');
      const t3 = await t.prisma.parcela.findUniqueOrThrow({
        where: { numero: 'T-3' },
      });
      expect(t3.status).toBe('PAGO');
    });

    it('R22.5 — a opção "ignorar duplicados" não toca nos títulos existentes', async () => {
      const c = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
      await importar(c, csvInicial);
      const r = await importar(c, 'Número do título,Valor\nT-2,999.00\n', {
        duplicados: 'IGNORAR',
      });
      expect(r).toMatchObject({ criados: 0, atualizados: 0, ignorados: 1 });
      expect(
        (
          await t.prisma.parcela.findUniqueOrThrow({ where: { numero: 'T-2' } })
        ).valor.toFixed(2),
      ).toBe('300.00');
    });
  });
});
