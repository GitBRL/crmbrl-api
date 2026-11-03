import ExcelJS from 'exceljs';
import {
  cartao,
  consultarPainel,
  criarNegocioBi,
  periodoDeTeste,
  quando,
} from './bi-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  entrarComo,
} from './utils';

describe('BI — acesso, filtros, cache e exportação (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  /** Baixa um arquivo salvo (`url` do `ArquivoDto`) como bytes. */
  async function baixar(cliente: ClienteHttp, url: string): Promise<Buffer> {
    const resposta = await cliente
      .get(url)
      .buffer(true)
      .parse((res, fim) => {
        const partes: Buffer[] = [];
        res.on('data', (parte: Buffer) => partes.push(parte));
        res.on('end', () => fim(null, Buffer.concat(partes)));
      })
      .expect(200);
    return resposta.body as Buffer;
  }

  it('R20 — sem sessão, 401', async () => {
    await clienteAnonimo(t).get('/api/v1/bi/comercial').expect(401);
    await clienteAnonimo(t).get('/api/v1/bi/paineis').expect(401);
  });

  it('cenário 71 — R1, R20 — cada papel vê só os painéis da sua área; os outros são 403', async () => {
    const admin = await criarUsuario(t, { papel: 'ADMIN' });
    const marketing = await criarEquipe(t, 'MARKETING', { membros: 1 });
    const comercial = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
      cLevel: marketing.cLevel,
    });
    const cs = await criarEquipe(t, 'CS', {
      membros: 1,
      cLevel: marketing.cLevel,
    });
    const esperado: [typeof admin, string[]][] = [
      [
        admin,
        ['marketing', 'comercial', 'cs', 'atendimento', 'sdr', 'financeiro'],
      ],
      [
        marketing.cLevel,
        ['marketing', 'comercial', 'cs', 'atendimento', 'sdr', 'financeiro'],
      ],
      [marketing.lider, ['marketing']],
      [marketing.membros[0], ['marketing']],
      [comercial.lider, ['comercial', 'atendimento', 'sdr']],
      [comercial.membros[0], ['comercial', 'atendimento', 'sdr']],
      [cs.lider, ['cs', 'atendimento', 'sdr', 'financeiro']],
      [cs.membros[0], ['cs', 'atendimento', 'sdr', 'financeiro']],
    ];
    for (const [usuario, paineis] of esperado) {
      const cliente = await entrarComo(t, usuario);
      const lista = await cliente.get('/api/v1/bi/paineis').expect(200);
      expect(lista.body.paineis).toEqual(paineis);
      for (const painel of [
        'marketing',
        'comercial',
        'cs',
        'atendimento',
        'sdr',
        'financeiro',
      ] as const) {
        await consultarPainel(
          cliente,
          painel,
          {},
          paineis.includes(painel) ? 200 : 403,
        );
      }
    }
    const recusa = await consultarPainel(
      await entrarComo(t, comercial.membros[0]),
      'marketing',
      {},
      403,
    );
    expect(recusa).toMatchObject({ detalhes: { regra: 'R20' } });
  });

  it('cenário 74 — R20 — painel desconhecido, datas inválidas e período grande demais são recusados', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    await admin.get('/api/v1/bi/financeiro-inexistente').expect(400);
    await admin.get('/api/v1/bi/comercial').query({ de: 'ontem' }).expect(400);
    await admin
      .get('/api/v1/bi/comercial')
      .query({ de: '2026-10-10T00:00:00Z', ate: '2026-10-01T00:00:00Z' })
      .expect(400);
    await admin
      .get('/api/v1/bi/comercial')
      .query({ de: '2024-01-01T00:00:00Z', ate: '2026-10-01T00:00:00Z' })
      .expect(400);
    await admin
      .get('/api/v1/bi/comercial')
      .query({ equipeId: 'x' })
      .expect(400);
  });

  it('cenário 73 — R1, R20 — filtros fora do alcance: área de outro, equipe de outra área, pessoa de outra área', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const cs = await criarEquipe(t, 'CS', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const cliente = await entrarComo(t, comercial.lider);
    await consultarPainel(cliente, 'atendimento', { area: 'CS' }, 403);
    await consultarPainel(cliente, 'atendimento', { area: 'COMERCIAL' }, 200);
    await consultarPainel(cliente, 'comercial', { equipeId: cs.lider.id }, 403);
    await consultarPainel(
      cliente,
      'comercial',
      { equipeId: comercial.membros[0].id },
      400,
    ); // não é líder
    await consultarPainel(
      cliente,
      'comercial',
      { pessoaId: cs.membros[0].id },
      404,
    );
    await consultarPainel(
      cliente,
      'comercial',
      { equipeId: comercial.lider.id },
      200,
    );
    await consultarPainel(
      cliente,
      'atendimento',
      { canalId: comercial.lider.id },
      404,
    );
  });

  it('cenário 76 — R20 — cache curto: a mesma consulta repetida volta igual; no-cache recalcula', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const cliente = await entrarComo(t, lider);
    const consulta = periodoDeTeste();
    const pedir = (semCache: boolean) => {
      const pedido = cliente.get('/api/v1/bi/comercial').query(consulta);
      return (
        semCache ? pedido.set('Cache-Control', 'no-cache') : pedido
      ).expect(200);
    };
    const primeira = (await pedir(false)).body;
    expect(cartao(primeira, 'novos').valor).toBe(0);
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'novo',
      responsavel: membros[0],
      criadoEm: quando(1),
    });
    const segunda = (await pedir(false)).body;
    expect(segunda.geradoEm).toBe(primeira.geradoEm);
    expect(cartao(segunda, 'novos').valor).toBe(0);
    const fresca = (await pedir(true)).body;
    expect(cartao(fresca, 'novos').valor).toBe(1);
    // O cache é por pessoa: outra pessoa não recebe a resposta guardada.
    const outro = await entrarComo(t, membros[0]);
    const doMembro = (
      await outro.get('/api/v1/bi/comercial').query(consulta).expect(200)
    ).body;
    expect(cartao(doMembro, 'novos').valor).toBe(1);
  });

  it('cenário 77 — R20, R3 — exporta CSV de uma tabela, com os mesmos números do painel, e audita', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'perdido',
      responsavel: membros[0],
      valor: '100.00',
      motivoPerda: '=HYPERLINK("x")',
      criadoEm: quando(5),
      fechadoEm: quando(2),
    });
    const cliente = await entrarComo(t, lider);
    const resposta = await cliente
      .post('/api/v1/bi/comercial/exportar')
      .send({ ...periodoDeTeste(), formato: 'csv', tabela: 'motivosDePerda' })
      .expect(200);
    expect(resposta.body).toMatchObject({
      contexto: 'RELATORIO',
      mime: 'text/csv',
    });
    const csv = (await baixar(cliente, resposta.body.url)).toString('utf8');
    expect(csv.startsWith('﻿Motivo;Negócios;Valor (R$)\r\n')).toBe(true);
    // Texto que parece fórmula sai protegido.
    expect(csv).toContain(`"'=HYPERLINK(""x"")";1;100`);
    const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'bi.exportado' },
    });
    expect(evento).toMatchObject({ entidade: 'painel_bi' });
    expect(evento.dados).toMatchObject({
      painel: 'comercial',
      formato: 'csv',
      tabela: 'motivosDePerda',
      linhas: 1,
      regra: 'R20',
    });
  });

  it('R20 — exporta XLSX com uma aba por tabela e respeita a visibilidade de quem exporta', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 2,
    });
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'ganho',
      responsavel: membros[0],
      valor: '500.00',
      criadoEm: quando(5),
      fechadoEm: quando(2),
    });
    await criarNegocioBi(t, {
      area: 'COMERCIAL',
      etapa: 'ganho',
      responsavel: membros[1],
      valor: '700.00',
      criadoEm: quando(5),
      fechadoEm: quando(2),
    });
    const exportar = async (usuario: typeof lider) => {
      const cliente = await entrarComo(t, usuario);
      const resposta = await cliente
        .post('/api/v1/bi/comercial/exportar')
        .send({ ...periodoDeTeste() })
        .expect(200);
      const livro = new ExcelJS.Workbook();
      await livro.xlsx.load(
        (await baixar(cliente, resposta.body.url)) as never,
      );
      return livro;
    };
    const doLider = await exportar(lider);
    expect(doLider.worksheets.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'Indicadores',
        'Funil por etapa',
        'Ranking por vendedor',
        'Motivos de perda',
        'Período',
      ]),
    );
    const indicadores = (livro: ExcelJS.Workbook) => {
      const folha = livro.getWorksheet('Indicadores');
      const por = new Map<string, unknown>();
      folha?.eachRow((linha, indice) => {
        if (indice > 1) por.set(linha.getCell(1).text, linha.getCell(2).value);
      });
      return por;
    };
    expect(indicadores(doLider).get('Valor ganho')).toBe(1200);
    // O vendedor exporta só o que enxerga.
    expect(indicadores(await exportar(membros[0])).get('Valor ganho')).toBe(
      500,
    );
  });

  it('R20 — exportação recusa tabela desconhecida, formato inválido e painel proibido', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const cliente = await entrarComo(t, membros[0]);
    await cliente
      .post('/api/v1/bi/comercial/exportar')
      .send({ tabela: 'nada' })
      .expect(400);
    await cliente
      .post('/api/v1/bi/comercial/exportar')
      .send({ formato: 'pdf' })
      .expect(400);
    await cliente.post('/api/v1/bi/marketing/exportar').send({}).expect(403);
    expect(
      await t.prisma.eventoAuditoria.count({ where: { acao: 'bi.exportado' } }),
    ).toBe(0);
  });
});
