import { randomUUID } from 'node:crypto';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  funilBase,
} from './utils';

const EM_MASSA = '/api/v1/negocios/em-massa';

describe('Ações em massa nos negócios (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  async function cenario() {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const [ana, bia] = equipe.membros;
    const funil = await funilBase(t, 'COMERCIAL');
    const abertas = funil.etapas.filter((e) => e.tipo === 'ABERTA');
    const ganho = funil.etapas.find((e) => e.tipo === 'GANHO')!;
    const perdido = funil.etapas.find((e) => e.tipo === 'PERDIDO')!;
    return {
      ...equipe,
      ana,
      bia,
      funil,
      abertas,
      ganho,
      perdido,
      comoLider: await entrarComo(t, equipe.lider),
      comoAna: await entrarComo(t, ana),
    };
  }

  it('R5.16 — MOVER leva cada negócio à etapa, com histórico, e grava a auditoria-resumo', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { titulo: 'A', responsavel: c.ana });
    const b = await criarNegocio(t, { titulo: 'B', responsavel: c.bia });

    const r = await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id, b.id],
        acao: 'MOVER',
        dados: { etapaId: c.abertas[1].id },
      })
      .expect(200);
    expect(r.body).toEqual({ total: 2, sucesso: 2, falhas: [] });

    const depois = await t.prisma.negocio.findMany({
      where: { id: { in: [a.id, b.id] } },
    });
    expect(depois.every((n) => n.etapaId === c.abertas[1].id)).toBe(true);
    expect(
      await t.prisma.negocioMovimentacao.count({
        where: { negocioId: a.id, paraEtapaId: c.abertas[1].id },
      }),
    ).toBe(1);
    const resumo = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'negocio.acao_em_massa' },
    });
    expect(resumo).toHaveLength(1);
    expect(resumo[0].dados).toEqual({
      acao: 'MOVER',
      total: 2,
      sucesso: 2,
      falhas: 0,
    });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'negocio.movido' },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('R5.16 — MOVER para etapa de perda exige motivo (400 antes de tudo); com motivo perde', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const sem = await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'MOVER',
        dados: { etapaId: c.perdido.id },
      })
      .expect(400);
    expect(sem.body.detalhes.campos[0].campo).toBe('dados.motivoPerda');
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe('ABERTO');

    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'MOVER',
        dados: { etapaId: c.perdido.id, motivoPerda: 'Sem orçamento' },
      })
      .expect(200);
    const perdido = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(perdido).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Sem orçamento',
    });
  });

  it('R5.4 — MOVER para etapa de outro funil falha em cada negócio (422), sem derrubar o pedido', async () => {
    const c = await cenario();
    const cs = await funilBase(t, 'CS');
    const a = await criarNegocio(t, { responsavel: c.ana });
    const r = await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'MOVER',
        dados: { etapaId: cs.etapas[0].id },
      })
      .expect(200);
    expect(r.body.sucesso).toBe(0);
    expect(r.body.falhas[0]).toMatchObject({
      negocioId: a.id,
      statusCode: 422,
      regra: 'R5.4',
    });
  });

  it('R5.16 — RESPONSAVEL troca, tira (null) e recusa quem não atua no funil (R5.13)', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const b = await criarNegocio(t);
    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id, b.id],
        acao: 'RESPONSAVEL',
        dados: { responsavelId: c.bia.id },
      })
      .expect(200)
      .expect((res) => expect(res.body.sucesso).toBe(2));
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: a.id } }))
        .responsavelId,
    ).toBe(c.bia.id);

    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'RESPONSAVEL',
        dados: { responsavelId: null },
      })
      .expect(200);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: a.id } }))
        .responsavelId,
    ).toBeNull();

    const csUser = await criarUsuario(t, { papel: 'MEMBRO', area: 'CS' });
    const r = await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id, b.id],
        acao: 'RESPONSAVEL',
        dados: { responsavelId: csUser.id },
      })
      .expect(200);
    expect(r.body.sucesso).toBe(0);
    expect(r.body.falhas.map((f: { regra: string }) => f.regra)).toEqual([
      'R5.13',
      'R5.13',
    ]);
  });

  it('R5.16 — GANHAR e PERDER usam a etapa de fechamento do funil de cada negócio', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const b = await criarNegocio(t, { responsavel: c.ana });
    await c.comoLider
      .post(EM_MASSA, { negocioIds: [a.id], acao: 'GANHAR' })
      .expect(200)
      .expect((res) => expect(res.body.sucesso).toBe(1));
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe('GANHO');

    await c.comoLider
      .post(EM_MASSA, { negocioIds: [b.id], acao: 'PERDER', dados: {} })
      .expect(400);
    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [b.id],
        acao: 'PERDER',
        dados: { motivoPerda: 'Foi para o concorrente' },
      })
      .expect(200);
    expect(
      await t.prisma.negocio.findUniqueOrThrow({ where: { id: b.id } }),
    ).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Foi para o concorrente',
    });

    // Ganho já fechado não é reaberto por quem não configura: falha 403 R5.5.
    const comoAna = c.comoAna;
    const r = await comoAna
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'MOVER',
        dados: { etapaId: c.abertas[0].id },
      })
      .expect(200);
    expect(r.body.falhas[0]).toMatchObject({ statusCode: 403, regra: 'R5.5' });
  });

  it('R5.16 — ETIQUETAR e DESETIQUETAR mexem nas etiquetas do contato (sem duplicar)', async () => {
    const c = await cenario();
    const contato = await criarContato(t, {
      etiquetas: ['VIP'],
      responsavel: c.ana,
    });
    const a = await criarNegocio(t, { contato, responsavel: c.ana });
    const b = await criarNegocio(t, { contato, responsavel: c.ana });
    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id, b.id],
        acao: 'ETIQUETAR',
        dados: { etiquetas: ['vip', 'Quente'] },
      })
      .expect(200)
      .expect((res) =>
        expect(res.body).toEqual({ total: 2, sucesso: 2, falhas: [] }),
      );
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .etiquetas,
    ).toEqual(['VIP', 'Quente']);

    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'DESETIQUETAR',
        dados: { etiquetas: ['vip'] },
      })
      .expect(200);
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .etiquetas,
    ).toEqual(['Quente']);

    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'ETIQUETAR',
        dados: { etiquetas: [] },
      })
      .expect(400);

    // As regras do contato valem: contato de outra pessoa o membro não edita (403 por negócio).
    const alheio = await criarContato(t, { responsavel: c.bia });
    const doAlheio = await criarNegocio(t, {
      contato: alheio,
      responsavel: c.ana,
    });
    const r = await c.comoAna
      .post(EM_MASSA, {
        negocioIds: [doAlheio.id],
        acao: 'ETIQUETAR',
        dados: { etiquetas: ['x'] },
      })
      .expect(200);
    expect(r.body.falhas[0]).toMatchObject({ statusCode: 403 });
  });

  it('R5.16 — ATIVIDADE cria uma por negócio, para o responsável dele (ou quem pede, se não tem)', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const b = await criarNegocio(t);
    const r = await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id, b.id],
        acao: 'ATIVIDADE',
        dados: {
          tipo: 'LIGACAO',
          titulo: 'Ligar para confirmar',
          vencimento: '2030-01-10T15:00:00-03:00',
        },
      })
      .expect(200);
    expect(r.body).toMatchObject({ total: 2, sucesso: 2 });
    const doA = await t.prisma.atividade.findMany({
      where: { negocioId: a.id },
    });
    const doB = await t.prisma.atividade.findMany({
      where: { negocioId: b.id },
    });
    expect(doA).toHaveLength(1);
    expect(doA[0]).toMatchObject({
      titulo: 'Ligar para confirmar',
      tipo: 'LIGACAO',
      responsavelId: c.ana.id,
    });
    expect(doB[0].responsavelId).toBe(c.lider.id);

    await c.comoLider
      .post(EM_MASSA, {
        negocioIds: [a.id],
        acao: 'ATIVIDADE',
        dados: { tipo: 'REUNIAO', titulo: 'X' },
      })
      .expect(400);
  });

  it('R5.16/R5.12 — EXCLUIR só com CONFIGURAR: o líder exclui; o membro recebe 403 por negócio', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const b = await criarNegocio(t, { responsavel: c.ana });
    const membro = await c.comoAna
      .post(EM_MASSA, { negocioIds: [a.id], acao: 'EXCLUIR' })
      .expect(200);
    expect(membro.body.sucesso).toBe(0);
    expect(membro.body.falhas[0]).toMatchObject({
      statusCode: 403,
      regra: 'R5.12',
      titulo: a.titulo,
    });
    await c.comoLider
      .post(EM_MASSA, { negocioIds: [a.id, b.id], acao: 'EXCLUIR' })
      .expect(200)
      .expect((res) => expect(res.body.sucesso).toBe(2));
    expect(
      await t.prisma.negocio.count({
        where: { id: { in: [a.id, b.id] }, excluidoEm: null },
      }),
    ).toBe(0);
  });

  it('R5.12 — por nível: o membro age nos seus e nos sem responsável, não nos dos colegas; quem só vê (VER) não age em nada', async () => {
    const c = await cenario();
    const meu = await criarNegocio(t, { responsavel: c.ana });
    const livre = await criarNegocio(t);
    const doColega = await criarNegocio(t, { responsavel: c.bia });

    const r = await c.comoAna
      .post(EM_MASSA, {
        negocioIds: [meu.id, livre.id, doColega.id],
        acao: 'MOVER',
        dados: { etapaId: c.abertas[1].id },
      })
      .expect(200);
    expect(r.body.sucesso).toBe(2);
    expect(r.body.falhas).toHaveLength(1);
    // O membro comum nem vê o negócio do colega: 404, sem revelar.
    expect(r.body.falhas[0]).toMatchObject({
      negocioId: doColega.id,
      titulo: null,
      statusCode: 404,
    });
    // Com acesso VER pessoal ele vê todos, mas age só nos seus: 403 R5.12.
    await c.comoLider
      .put(`/api/v1/funis/${c.funil.id}/acessos`, {
        acessos: [{ usuarioId: c.ana.id, nivel: 'VER' }],
      })
      .expect(200);
    const veTodos = await c.comoAna
      .post(EM_MASSA, {
        negocioIds: [doColega.id],
        acao: 'MOVER',
        dados: { etapaId: c.abertas[0].id },
      })
      .expect(200);
    expect(veTodos.body.falhas[0]).toMatchObject({
      statusCode: 403,
      regra: 'R5.12',
      titulo: doColega.titulo,
    });
    for (const acao of ['ETIQUETAR', 'ATIVIDADE'] as const) {
      const dados =
        acao === 'ETIQUETAR'
          ? { etiquetas: ['x'] }
          : { tipo: 'TAREFA', titulo: 'T' };
      const res = await c.comoAna
        .post(EM_MASSA, { negocioIds: [doColega.id], acao, dados })
        .expect(200);
      expect(res.body.falhas[0]).toMatchObject({
        statusCode: 403,
        regra: 'R5.12',
      });
    }

    // Setor CS com acesso VER ao funil comercial: vê todos, não age.
    await c.comoLider
      .put(`/api/v1/funis/${c.funil.id}/acessos`, {
        acessos: [{ area: 'CS', nivel: 'VER' }],
      })
      .expect(200);
    const csMembro = await criarUsuario(t, { papel: 'MEMBRO', area: 'CS' });
    const comoCs = await entrarComo(t, csMembro);
    const ver = await comoCs
      .post(EM_MASSA, {
        negocioIds: [meu.id, livre.id],
        acao: 'GANHAR',
      })
      .expect(200);
    expect(ver.body.sucesso).toBe(0);
    expect(ver.body.falhas.map((f: { regra: string }) => f.regra)).toEqual([
      'R5.12',
      'R5.12',
    ]);
  });

  it('R5.16/R5.9 — negócio que a pessoa não vê, ou que não existe, entra em falhas como 404, sem título', async () => {
    const c = await cenario();
    const a = await criarNegocio(t, { responsavel: c.ana });
    const csMembro = await criarUsuario(t, { papel: 'MEMBRO', area: 'CS' });
    const comoCs = await entrarComo(t, csMembro);
    const inexistente = randomUUID();
    const r = await comoCs
      .post(EM_MASSA, {
        negocioIds: [a.id, inexistente],
        acao: 'GANHAR',
      })
      .expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.sucesso).toBe(0);
    expect(r.body.falhas).toEqual([
      {
        negocioId: a.id,
        titulo: null,
        statusCode: 404,
        regra: null,
        mensagem: 'Negócio não encontrado.',
      },
      {
        negocioId: inexistente,
        titulo: null,
        statusCode: 404,
        regra: null,
        mensagem: 'Negócio não encontrado.',
      },
    ]);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe('ABERTO');
  });

  it('R5.16 — sucesso parcial: o que dá certo fica feito e o que falha volta com título e motivo', async () => {
    const c = await cenario();
    const ok = await criarNegocio(t, { titulo: 'Bom', responsavel: c.ana });
    const fechado = await criarNegocio(t, {
      titulo: 'Já ganho',
      etapa: c.ganho.chave!,
      responsavel: c.ana,
    });
    const r = await c.comoAna
      .post(EM_MASSA, {
        negocioIds: [ok.id, fechado.id, randomUUID()],
        acao: 'MOVER',
        dados: { etapaId: c.abertas[1].id },
      })
      .expect(200);
    expect(r.body).toMatchObject({ total: 3, sucesso: 1 });
    expect(r.body.falhas).toHaveLength(2);
    expect(r.body.falhas[0]).toMatchObject({
      negocioId: fechado.id,
      titulo: 'Já ganho',
      statusCode: 403,
      regra: 'R5.5',
    });
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: ok.id } }))
        .etapaId,
    ).toBe(c.abertas[1].id);
    const resumo = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'negocio.acao_em_massa' },
    });
    expect(resumo.dados).toEqual({
      acao: 'MOVER',
      total: 3,
      sucesso: 1,
      falhas: 2,
    });
  });

  describe('corpo inválido e limite', () => {
    it('R5.16 — aceita 500 negócios e recusa 501 (400)', async () => {
      const c = await cenario();
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      const ok = await c.comoLider
        .post(EM_MASSA, { negocioIds: ids(500), acao: 'GANHAR' })
        .expect(200);
      expect(ok.body).toMatchObject({ total: 500, sucesso: 0 });
      expect(ok.body.falhas).toHaveLength(500);
      const mais = await c.comoLider
        .post(EM_MASSA, { negocioIds: ids(501), acao: 'GANHAR' })
        .expect(400);
      expect(mais.body.detalhes.campos[0].campo).toBe('negocioIds');
    });

    it.each([
      ['lista vazia', { negocioIds: [], acao: 'GANHAR' }],
      [
        'repetidos',
        {
          negocioIds: [
            '3f1c5a52-0000-4000-8000-000000000001',
            '3f1c5a52-0000-4000-8000-000000000001',
          ],
          acao: 'GANHAR',
        },
      ],
      ['id que não é UUID', { negocioIds: ['abc'], acao: 'GANHAR' }],
      [
        'ação desconhecida',
        {
          negocioIds: ['3f1c5a52-0000-4000-8000-000000000001'],
          acao: 'APAGAR',
        },
      ],
      [
        'MOVER sem etapa',
        { negocioIds: ['3f1c5a52-0000-4000-8000-000000000001'], acao: 'MOVER' },
      ],
      [
        'campo desconhecido',
        {
          negocioIds: ['3f1c5a52-0000-4000-8000-000000000001'],
          acao: 'GANHAR',
          x: 1,
        },
      ],
      [
        'RESPONSAVEL sem responsavelId',
        {
          negocioIds: ['3f1c5a52-0000-4000-8000-000000000001'],
          acao: 'RESPONSAVEL',
          dados: {},
        },
      ],
    ])('R5.16 — 400 para %s, sem auditoria', async (_nome, corpo) => {
      const c = await cenario();
      await c.comoLider.post(EM_MASSA, corpo).expect(400);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.acao_em_massa' },
        }),
      ).toBe(0);
    });
  });
});
