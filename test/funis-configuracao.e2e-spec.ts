import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
} from './utils';

interface EtapaResposta {
  id: string;
  nome: string;
  chave: string | null;
  ordem: number;
  tipo: string;
  prazoDias: number | null;
}

interface FunilResposta {
  id: string;
  nome: string;
  area: string;
  base: boolean;
  ativo: boolean;
  etapas: EtapaResposta[];
}

describe('Funis — configuração de funis e etapas (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  it('as rotas de funis, negócios, passagens e rodízio estão no Swagger', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const documento = await admin.get('/api/docs-json').expect(200);
    const rotas = Object.keys(documento.body.paths as Record<string, unknown>);
    expect(rotas).toEqual(
      expect.arrayContaining([
        '/api/v1/funis',
        '/api/v1/funis/{id}',
        '/api/v1/funis/{id}/etapas',
        '/api/v1/funis/{id}/etapas/reordenar',
        '/api/v1/funis/{id}/etapas/{etapaId}',
        '/api/v1/funis/{id}/quadro',
        '/api/v1/funis/{id}/metricas',
        '/api/v1/negocios',
        '/api/v1/negocios/{id}',
        '/api/v1/negocios/{id}/mover',
        '/api/v1/negocios/{id}/reabrir',
        '/api/v1/negocios/{id}/assumir',
        '/api/v1/negocios/{id}/movimentacoes',
        '/api/v1/passagens',
        '/api/v1/passagens/{id}',
        '/api/v1/regras-distribuicao',
        '/api/v1/regras-distribuicao/{area}',
        '/api/v1/regras-distribuicao/{area}/participantes/{usuarioId}',
      ]),
    );
    const esquemas = Object.keys(
      documento.body.components.schemas as Record<string, unknown>,
    );
    expect(esquemas).toEqual(
      expect.arrayContaining([
        'NegocioDto',
        'QuadroDto',
        'MetricasDoFunilDto',
        'ResultadoMovimentacaoDto',
        'RegraDistribuicaoDto',
        'PassagemDto',
      ]),
    );
  });

  it('R5.1 — cada um lista os funis das áreas que vê, com as etapas em ordem', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const {
      membros: [marketing],
    } = await criarEquipe(t, 'MARKETING', { membros: 1 });

    const todos = await admin.get('/api/v1/funis').expect(200);
    const funis = todos.body as FunilResposta[];
    expect(funis.map((funil) => [funil.area, funil.base])).toEqual([
      ['MARKETING', true],
      ['COMERCIAL', true],
      ['CS', true],
    ]);
    expect(funis[0].etapas.map((etapa) => [etapa.chave, etapa.ordem])).toEqual([
      ['novo_lead', 1],
      ['em_contato', 2],
      ['nutricao', 3],
      ['qualificado_mql', 4],
      ['descartado', 5],
    ]);

    const doMarketing = await (
      await entrarComo(t, marketing)
    )
      .get('/api/v1/funis')
      .expect(200);
    expect(
      (doMarketing.body as FunilResposta[]).map((funil) => funil.area),
    ).toEqual(['MARKETING']);
    const comercial = await funilBase(t, 'COMERCIAL');
    await (
      await entrarComo(t, marketing)
    )
      .get(`/api/v1/funis/${comercial.id}`)
      .expect(404);
  });

  it('R5.1 — o líder cria funil extra na sua área (com as etapas padrão); não na de outra; o membro não configura', async () => {
    const {
      lider,
      membros: [membro],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const comoLider = await entrarComo(t, lider);

    const criado = await comoLider
      .post('/api/v1/funis', { nome: '  Parcerias ', area: 'COMERCIAL' })
      .expect(201);
    const funil = criado.body as FunilResposta;
    expect(funil).toMatchObject({
      nome: 'Parcerias',
      area: 'COMERCIAL',
      base: false,
      ativo: true,
    });
    expect(
      funil.etapas.map((etapa) => [etapa.nome, etapa.tipo, etapa.ordem]),
    ).toEqual([
      ['Novo', 'ABERTA', 1],
      ['Em andamento', 'ABERTA', 2],
      ['Ganho', 'GANHO', 3],
      ['Perdido', 'PERDIDO', 4],
    ]);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: 'funil.criado',
          entidadeId: funil.id,
          usuarioId: lider.id,
        },
      }),
    ).toBe(1);

    const outraArea = await comoLider
      .post('/api/v1/funis', { nome: 'Eventos', area: 'MARKETING' })
      .expect(403);
    expect(outraArea.body.detalhes).toMatchObject({ regra: 'R5.1' });
    await comoLider
      .post('/api/v1/funis', { nome: 'parcerias', area: 'COMERCIAL' })
      .expect(409);

    const comoMembro = await entrarComo(t, membro);
    await comoMembro
      .post('/api/v1/funis', { nome: 'Meu funil', area: 'COMERCIAL' })
      .expect(403);
    await comoMembro
      .post(`/api/v1/funis/${funil.id}/etapas`, { nome: 'Extra' })
      .expect(403);
    await comoMembro
      .patch(`/api/v1/funis/${funil.id}`, { nome: 'Outro nome' })
      .expect(403);
  });

  it('R5.2 — funil novo precisa de ao menos uma etapa aberta, exatamente uma de ganho e uma de perda', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const semGanho = await admin
      .post('/api/v1/funis', {
        nome: 'Sem ganho',
        area: 'CS',
        etapas: [
          { nome: 'A' },
          { nome: 'B' },
          { nome: 'Perdido', tipo: 'PERDIDO' },
        ],
      })
      .expect(422);
    expect(semGanho.body.detalhes).toEqual({
      regra: 'R5.2',
      abertas: 2,
      ganho: 0,
      perda: 1,
    });
    await admin
      .post('/api/v1/funis', {
        nome: 'Dois ganhos',
        area: 'CS',
        etapas: [
          { nome: 'A' },
          { nome: 'G1', tipo: 'GANHO' },
          { nome: 'G2', tipo: 'GANHO' },
          { nome: 'P', tipo: 'PERDIDO' },
        ],
      })
      .expect(422);
    await admin
      .post('/api/v1/funis', {
        nome: 'Sem aberta',
        area: 'CS',
        etapas: [
          { nome: 'G', tipo: 'GANHO' },
          { nome: 'P', tipo: 'PERDIDO' },
          { nome: 'P2', tipo: 'PERDIDO' },
        ],
      })
      .expect(422);
    await admin
      .post('/api/v1/funis', {
        nome: 'Nomes repetidos',
        area: 'CS',
        etapas: [
          { nome: 'Kickoff' },
          { nome: 'kickoff ' },
          { nome: 'G', tipo: 'GANHO' },
          { nome: 'P', tipo: 'PERDIDO' },
        ],
      })
      .expect(409);
    const curto = await admin
      .post('/api/v1/funis', {
        nome: 'Curto',
        area: 'CS',
        etapas: [{ nome: 'G', tipo: 'GANHO' }],
      })
      .expect(400);
    expect(curto.body.detalhes.campos).toEqual([
      { campo: 'etapas', mensagens: ['deve ter pelo menos 3 etapas'] },
    ]);

    const criado = await admin
      .post('/api/v1/funis', {
        nome: 'Onboarding enterprise',
        area: 'CS',
        etapas: [
          { nome: 'Kickoff', prazoDias: 3, probabilidade: 40 },
          { nome: 'Go-live', tipo: 'GANHO' },
          { nome: 'Desistiu', tipo: 'PERDIDO' },
        ],
      })
      .expect(201);
    expect(
      (criado.body as FunilResposta).etapas.map((etapa) => [
        etapa.nome,
        etapa.prazoDias,
      ]),
    ).toEqual([
      ['Kickoff', 3],
      ['Go-live', null],
      ['Desistiu', null],
    ]);
  });

  it('R5.2 — novas etapas são abertas e entram depois da última aberta (ou na ordem pedida)', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const comercial = await funilBase(t, 'COMERCIAL');

    const ganho = await admin
      .post(`/api/v1/funis/${comercial.id}/etapas`, {
        nome: 'Outra vitória',
        tipo: 'GANHO',
      })
      .expect(422);
    expect(ganho.body.detalhes.regra).toBe('R5.2');

    const comDemonstracao = await admin
      .post(`/api/v1/funis/${comercial.id}/etapas`, {
        nome: 'Demonstração',
        prazoDias: 3,
      })
      .expect(201);
    expect(
      (comDemonstracao.body as FunilResposta).etapas.map((etapa) => [
        etapa.nome,
        etapa.ordem,
      ]),
    ).toEqual([
      ['Novo', 1],
      ['Qualificação', 2],
      ['Apresentação', 3],
      ['Proposta', 4],
      ['Negociação', 5],
      ['Demonstração', 6],
      ['Ganho', 7],
      ['Perdido', 8],
    ]);

    const comDiagnostico = await admin
      .post(`/api/v1/funis/${comercial.id}/etapas`, {
        nome: 'Diagnóstico',
        ordem: 2,
      })
      .expect(201);
    expect(
      (comDiagnostico.body as FunilResposta).etapas
        .slice(0, 3)
        .map((etapa) => etapa.nome),
    ).toEqual(['Novo', 'Diagnóstico', 'Qualificação']);

    await admin
      .post(`/api/v1/funis/${comercial.id}/etapas`, { nome: 'PROPOSTA' })
      .expect(409);
    expect(
      await t.prisma.eventoAuditoria.count({ where: { acao: 'etapa.criada' } }),
    ).toBe(2);
  });

  it('R5.2 — etapa com negócios não é excluída; a de ganho, a de perda e a última aberta também não', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const extra = (
      await admin
        .post('/api/v1/funis', {
          nome: 'Mínimo',
          area: 'COMERCIAL',
          etapas: [
            { nome: 'Única aberta' },
            { nome: 'Ganhou', tipo: 'GANHO' },
            { nome: 'Perdeu', tipo: 'PERDIDO' },
          ],
        })
        .expect(201)
    ).body as FunilResposta;
    const [aberta, ganhou, perdeu] = extra.etapas;
    for (const etapa of [ganhou, perdeu, aberta]) {
      const resposta = await admin
        .delete(`/api/v1/funis/${extra.id}/etapas/${etapa.id}`)
        .expect(422);
      expect(resposta.body.detalhes.regra).toBe('R5.2');
    }

    const comercial = await funilBase(t, 'COMERCIAL');
    const proposta = await etapaDoFunilBase(t, 'COMERCIAL', 'proposta');
    await criarNegocio(t, { etapa: 'proposta' });
    const comNegocio = await admin
      .delete(`/api/v1/funis/${comercial.id}/etapas/${proposta.id}`)
      .expect(422);
    expect(comNegocio.body.detalhes).toMatchObject({
      regra: 'R5.2',
      negocios: 1,
    });

    // Etapa usada por passagem (destino de Marketing → Comercial) também fica.
    const novo = await etapaDoFunilBase(t, 'COMERCIAL', 'novo');
    const usada = await admin
      .delete(`/api/v1/funis/${comercial.id}/etapas/${novo.id}`)
      .expect(422);
    expect(usada.body.detalhes.regra).toBe('R5.7');

    const apresentacao = await etapaDoFunilBase(t, 'COMERCIAL', 'apresentacao');
    await admin
      .delete(`/api/v1/funis/${comercial.id}/etapas/${apresentacao.id}`)
      .expect(204);
    const depois = await funilBase(t, 'COMERCIAL');
    expect(depois.etapas.map((etapa) => [etapa.chave, etapa.ordem])).toEqual([
      ['novo', 1],
      ['qualificacao', 2],
      ['proposta', 3],
      ['negociacao', 4],
      ['ganho', 5],
      ['perdido', 6],
    ]);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'etapa.excluida', entidadeId: apresentacao.id },
      }),
    ).toBe(1);
  });

  it('R5.1 — reordenar e renomear etapas, arquivar e reativar; funil-base não é excluído; o extra é', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const marketing = await funilBase(t, 'MARKETING');
    const ids = marketing.etapas.map((etapa) => etapa.id);

    await admin
      .post(`/api/v1/funis/${marketing.id}/etapas/reordenar`, {
        etapaIds: ids.slice(1),
      })
      .expect(400);
    const reordenado = await admin
      .post(`/api/v1/funis/${marketing.id}/etapas/reordenar`, {
        etapaIds: [ids[1], ids[0], ...ids.slice(2)],
      })
      .expect(200);
    expect(
      (reordenado.body as FunilResposta).etapas.map((etapa) => etapa.chave),
    ).toEqual([
      'em_contato',
      'novo_lead',
      'nutricao',
      'qualificado_mql',
      'descartado',
    ]);

    const renomeada = await admin
      .patch(`/api/v1/funis/${marketing.id}/etapas/${ids[2]}`, {
        nome: 'Nutrição por e-mail',
        prazoDias: null,
        probabilidade: 20,
      })
      .expect(200);
    expect(renomeada.body).toMatchObject({
      nome: 'Nutrição por e-mail',
      chave: 'nutricao',
      prazoDias: null,
      probabilidade: 20,
    });
    await admin
      .patch(`/api/v1/funis/${marketing.id}/etapas/${ids[2]}`, {
        tipo: 'GANHO',
      })
      .expect(400);

    // O Comercial é destino da passagem Marketing → Comercial: não arquiva.
    const comercial = await funilBase(t, 'COMERCIAL');
    const destino = await admin
      .patch(`/api/v1/funis/${comercial.id}`, { ativo: false })
      .expect(422);
    expect(destino.body.detalhes.regra).toBe('R5.7');

    await admin
      .patch(`/api/v1/funis/${marketing.id}`, { ativo: false })
      .expect(200);
    const ativos = await admin.get('/api/v1/funis').expect(200);
    expect((ativos.body as FunilResposta[]).map((funil) => funil.area)).toEqual(
      ['COMERCIAL', 'CS'],
    );
    const comArquivados = await admin
      .get('/api/v1/funis?incluirArquivados=true')
      .expect(200);
    expect(comArquivados.body).toHaveLength(3);
    const contato = await criarContato(t);
    const arquivado = await admin
      .post('/api/v1/negocios', {
        contatoId: contato.id,
        funilId: marketing.id,
      })
      .expect(422);
    expect(arquivado.body.detalhes.regra).toBe('R5.1');
    await admin
      .patch(`/api/v1/funis/${marketing.id}`, { ativo: true })
      .expect(200);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: { in: ['funil.arquivado', 'funil.reativado'] },
          entidadeId: marketing.id,
        },
      }),
    ).toBe(2);

    const base = await admin
      .delete(`/api/v1/funis/${marketing.id}`)
      .expect(422);
    expect(base.body.detalhes.regra).toBe('R5.1');

    const extra = (
      await admin
        .post('/api/v1/funis', { nome: 'Temporário', area: 'MARKETING' })
        .expect(201)
    ).body as FunilResposta;
    await admin.delete(`/api/v1/funis/${extra.id}`).expect(204);
    await admin.get(`/api/v1/funis/${extra.id}`).expect(404);
    expect(
      await t.prisma.funil.findUniqueOrThrow({ where: { id: extra.id } }),
    ).toMatchObject({ ativo: false, excluidoEm: expect.any(Date) });
  });
});
