import { DistribuicaoService } from '../src/funis/distribuicao.service';
import {
  type AppTeste,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  entrarComo,
  type ClienteHttp,
} from './utils';

interface SetorResposta {
  chave: string;
  nome: string;
  descricao: string | null;
  cor: string | null;
  base: boolean;
  ativo: boolean;
  ordem: number;
  lideres: { id: string; papel: string; area: string }[] | null;
  contagens: { usuariosAtivos: number; funisAtivos: number } | null;
}

describe('Setores (e2e, R1.6–R1.11)', () => {
  let t: AppTeste;
  let comoAdmin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    comoAdmin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  });

  afterAll(() => t.fechar());

  it('R1.6 — todo autenticado lista os setores ativos em ordem; só a diretoria vê líderes, contagens e inativos', async () => {
    const { lider, membros } = await criarEquipe(t, 'CS', { membros: 1 });
    const comoMembro = await entrarComo(t, membros[0]);
    const doMembro = await comoMembro
      .get('/api/v1/setores?incluirInativos=true')
      .expect(200);
    expect(
      (doMembro.body as SetorResposta[]).map((s) => [s.chave, s.nome, s.base]),
    ).toEqual([
      ['MARKETING', 'Marketing', true],
      ['COMERCIAL', 'Comercial', true],
      ['CS', 'Customer Success', true],
    ]);
    expect(doMembro.body[2]).toMatchObject({ lideres: null, contagens: null });

    const doAdmin = await comoAdmin.get('/api/v1/setores').expect(200);
    expect(doAdmin.body[2]).toMatchObject({
      chave: 'CS',
      lideres: [{ id: lider.id, papel: 'LIDER', area: 'CS' }],
      contagens: { usuariosAtivos: 2, funisAtivos: 1 },
    });

    const documento = await comoAdmin.get('/api/docs-json').expect(200);
    expect(Object.keys(documento.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/setores',
        '/api/v1/setores/{chave}',
        '/api/v1/setores/{chave}/desativar',
        '/api/v1/setores/{chave}/reativar',
      ]),
    );
  });

  it('cenário 1 — R1.7: o C-level cria um setor com funil-base, rodízio e líderes, tudo numa transação', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const { membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
      cLevel,
    });
    const futuroLider = membros[0];
    const comoCLevel = await entrarComo(t, cLevel);

    const criado = await comoCLevel
      .post('/api/v1/setores', {
        nome: '  Pós-venda ',
        descricao: 'Clientes depois da entrega',
        cor: 'menta',
        lideres: [futuroLider.id],
        cLevelResponsavelId: cLevel.id,
      })
      .expect(201);
    expect(criado.body).toMatchObject({
      chave: 'POS_VENDA',
      nome: 'Pós-venda',
      descricao: 'Clientes depois da entrega',
      cor: 'menta',
      base: false,
      ativo: true,
      ordem: 4,
      lideres: [{ id: futuroLider.id, papel: 'LIDER', area: 'POS_VENDA' }],
      contagens: { usuariosAtivos: 1, funisAtivos: 1 },
    });

    const funil = await t.prisma.funil.findFirstOrThrow({
      where: { area: 'POS_VENDA' },
      include: { etapas: { orderBy: { ordem: 'asc' } } },
    });
    expect(funil).toMatchObject({ nome: 'Pós-venda', base: true, ativo: true });
    expect(
      funil.etapas.map((etapa) => [etapa.nome, etapa.tipo, etapa.prazoDias]),
    ).toEqual([
      ['Novo', 'ABERTA', 2],
      ['Em andamento', 'ABERTA', 7],
      ['Ganho', 'GANHO', null],
      ['Perdido', 'PERDIDO', null],
    ]);
    expect(
      await t.prisma.regraDistribuicao.count({ where: { area: 'POS_VENDA' } }),
    ).toBe(1);
    expect(
      await t.prisma.usuario.findUniqueOrThrow({
        where: { id: futuroLider.id },
        select: { papel: true, area: true, liderId: true },
      }),
    ).toEqual({ papel: 'LIDER', area: 'POS_VENDA', liderId: cLevel.id });

    const acoes = await t.prisma.eventoAuditoria.findMany({
      where: {
        acao: {
          in: [
            'setor.criado',
            'funil.criado',
            'regra_distribuicao.criada',
            'usuario.atualizado',
          ],
        },
        criadoEm: { gte: new Date(Date.now() - 60_000) },
        usuarioId: cLevel.id,
      },
      select: { acao: true },
    });
    expect(acoes.map(({ acao }) => acao).sort()).toEqual([
      'funil.criado',
      'regra_distribuicao.criada',
      'setor.criado',
      'usuario.atualizado',
    ]);

    // O líder novo entra pelo setor: perfil, funis e permissões.
    const comoLider = await entrarComo(
      t,
      await t.prisma.usuario.findUniqueOrThrow({
        where: { id: futuroLider.id },
      }),
    );
    const eu = await comoLider.get('/api/v1/auth/eu').expect(200);
    expect(eu.body.usuario).toMatchObject({
      papel: 'LIDER',
      area: 'POS_VENDA',
      nomeSetor: 'Pós-venda',
      rotuloPapel: 'Líder Pós-venda',
      nivel: 'LIDER',
    });
    expect(eu.body.permissoes.areasVisiveis).toEqual(['POS_VENDA']);
    const funis = await comoLider.get('/api/v1/funis').expect(200);
    expect(funis.body.map((f: { id: string }) => f.id)).toEqual([funil.id]);
    await comoLider.get('/api/v1/regras-distribuicao/pos_venda').expect(200);

    // Um membro novo no setor entra no rodízio dele (R5.8).
    const membro = await comoAdmin
      .post('/api/v1/usuarios', {
        nome: 'Paula Pós',
        email: 'paula@brl.com.br',
        papel: 'MEMBRO',
        area: 'POS_VENDA',
        liderId: futuroLider.id,
        senhaTemporaria: 'Temporaria#2026',
      })
      .expect(201);
    expect(membro.body.usuario).toMatchObject({
      rotuloPapel: 'Pós-venda',
      nomeSetor: 'Pós-venda',
    });
    await t.prisma.usuario.update({
      where: { id: membro.body.usuario.id },
      data: { acessoAtivadoEm: new Date() },
    });
    const escolhido = await t.prisma.$transaction((tx) =>
      t
        .get(DistribuicaoService)
        .escolherResponsavel(tx, 'POS_VENDA', 'RODIZIO'),
    );
    expect(escolhido).toBe(membro.body.usuario.id);

    // Admin e C-level veem o novo setor nas permissões.
    const doAdmin = await comoAdmin.get('/api/v1/auth/eu').expect(200);
    expect(doAdmin.body.permissoes.areasVisiveis).toEqual([
      'MARKETING',
      'COMERCIAL',
      'CS',
      'POS_VENDA',
    ]);
  });

  it('R1.7 — só Admin e C-level criam; R1.8 — nome repetido (sem caixa/acento) é recusado e a chave ganha sufixo', async () => {
    const { lider } = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
    const comoLider = await entrarComo(t, lider);
    await comoLider.post('/api/v1/setores', { nome: 'Novo' }).expect(403);

    const repetido = await comoAdmin
      .post('/api/v1/setores', { nome: 'customer   SUCCÉSS' })
      .expect(409);
    expect(repetido.body.detalhes).toMatchObject({
      regra: 'R1.8',
      campos: ['nome'],
      chave: 'CS',
    });

    const parecido = await comoAdmin
      .post('/api/v1/setores', { nome: 'Comercial!' })
      .expect(201);
    expect(parecido.body).toMatchObject({
      chave: 'COMERCIAL_2',
      lideres: [],
    });

    const invalido = await comoAdmin
      .post('/api/v1/setores', { nome: '', cor: 'roxo', lideres: ['x'] })
      .expect(400);
    expect(
      invalido.body.detalhes.campos.map((c: { campo: string }) => c.campo),
    ).toEqual(expect.arrayContaining(['nome', 'cor', 'lideres']));
  });

  it('R1.2/R1.3 — líderes exigem um C-level responsável ativo; quem tem liderados não muda de setor (409 com a lista) e nada é criado', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 2,
    });
    const semCLevel = await comoAdmin
      .post('/api/v1/setores', { nome: 'Suporte', lideres: [membros[0].id] })
      .expect(422);
    expect(semCLevel.body.detalhes).toMatchObject({
      regra: 'R1.2',
      campo: 'cLevelResponsavelId',
    });
    const cLevelErrado = await comoAdmin
      .post('/api/v1/setores', {
        nome: 'Suporte',
        lideres: [membros[0].id],
        cLevelResponsavelId: lider.id,
      })
      .expect(422);
    expect(cLevelErrado.body.detalhes.regra).toBe('R1.2');

    const comLiderados = await comoAdmin
      .post('/api/v1/setores', {
        nome: 'Suporte',
        lideres: [lider.id, membros[0].id],
        cLevelResponsavelId: cLevel.id,
      })
      .expect(409);
    expect(comLiderados.body).toMatchObject({
      erro: 'conflito',
      detalhes: {
        regra: 'R1.3',
        pendencias: [
          {
            usuario: { id: lider.id, nome: lider.nome },
            liderados: expect.arrayContaining([
              expect.objectContaining({ id: membros[0].id }),
              expect.objectContaining({ id: membros[1].id }),
            ]),
          },
        ],
      },
    });
    expect(await t.prisma.setor.count({ where: { chave: 'SUPORTE' } })).toBe(0);
    expect(await t.prisma.funil.count({ where: { area: 'SUPORTE' } })).toBe(0);
    expect(
      await t.prisma.usuario.findUniqueOrThrow({
        where: { id: membros[0].id },
        select: { papel: true, area: true },
      }),
    ).toEqual({ papel: 'MEMBRO', area: 'COMERCIAL' });
  });

  it('R1.11 — edita nome, descrição, cor e ordem (também os de base); o rótulo e o canal do chat acompanham', async () => {
    const { lider } = await criarEquipe(t, 'CS', { membros: 0 });
    await t.prisma.chatCanal.create({
      data: {
        tipo: 'AREA',
        chave: 'area:CS',
        nome: 'Customer Success',
        area: 'CS',
      },
    });
    const editado = await comoAdmin
      .patch('/api/v1/setores/cs', {
        nome: 'Sucesso do Cliente',
        cor: 'ciano',
        ordem: 9,
      })
      .expect(200);
    expect(editado.body).toMatchObject({
      chave: 'CS',
      nome: 'Sucesso do Cliente',
      cor: 'ciano',
      ordem: 9,
      base: true,
    });
    const usuario = await comoAdmin
      .get(`/api/v1/usuarios/${lider.id}`)
      .expect(200);
    expect(usuario.body).toMatchObject({
      rotuloPapel: 'Líder Sucesso do Cliente',
      nomeSetor: 'Sucesso do Cliente',
    });
    expect(
      await t.prisma.chatCanal.findFirstOrThrow({
        where: { chave: 'area:CS' },
      }),
    ).toMatchObject({ nome: 'Sucesso do Cliente' });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'setor.atualizado', entidadeId: 'CS' },
      }),
    ).toBe(1);

    const repetido = await comoAdmin
      .patch('/api/v1/setores/MARKETING', { nome: 'sucesso do cliente' })
      .expect(409);
    expect(repetido.body.detalhes.regra).toBe('R1.8');
    await comoAdmin
      .patch('/api/v1/setores/NAO_EXISTE', { cor: null })
      .expect(404);
    await comoAdmin.patch('/api/v1/setores/cs', { chave: 'X' }).expect(400);
  });

  it('R1.10 — base não desativa; setor com pessoas, funis ou filas ativos → 409 com o que falta; inativo some das escolhas (R1.9) e volta ao reativar', async () => {
    await comoAdmin.post('/api/v1/setores/cs/desativar').expect(422);

    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const membroAvulso = await criarUsuario(t, {
      papel: 'MEMBRO',
      area: 'MARKETING',
    });
    const criado = await comoAdmin
      .post('/api/v1/setores', {
        nome: 'Eventos',
        lideres: [membroAvulso.id],
        cLevelResponsavelId: cLevel.id,
      })
      .expect(201);
    const chave = criado.body.chave as string;
    const funil = await t.prisma.funil.findFirstOrThrow({
      where: { area: chave },
    });

    const ocupado = await comoAdmin
      .post(`/api/v1/setores/${chave}/desativar`)
      .expect(409);
    expect(ocupado.body.detalhes).toMatchObject({
      regra: 'R1.10',
      usuarios: [{ id: membroAvulso.id, papel: 'LIDER' }],
      funis: [{ id: funil.id, base: true }],
      filas: [],
    });

    // Esvazia: a pessoa volta ao Marketing e o funil é arquivado.
    const { lider: liderMarketing } = await criarEquipe(t, 'MARKETING', {
      membros: 0,
      cLevel,
    });
    await comoAdmin
      .patch(`/api/v1/usuarios/${membroAvulso.id}`, {
        papel: 'MEMBRO',
        area: 'MARKETING',
        liderId: liderMarketing.id,
      })
      .expect(200);
    await comoAdmin
      .patch(`/api/v1/funis/${funil.id}`, { ativo: false })
      .expect(200);
    const desativado = await comoAdmin
      .post(`/api/v1/setores/${chave}/desativar`)
      .expect(200);
    expect(desativado.body).toMatchObject({ chave, ativo: false });
    await comoAdmin.post(`/api/v1/setores/${chave}/desativar`).expect(409);

    const ativos = await comoAdmin.get('/api/v1/setores').expect(200);
    expect(ativos.body.map((s: SetorResposta) => s.chave)).not.toContain(chave);
    const todos = await comoAdmin
      .get('/api/v1/setores?incluirInativos=true')
      .expect(200);
    expect(todos.body.map((s: SetorResposta) => s.chave)).toContain(chave);

    // R1.9: setor inativo não vale para registros novos ou reativados.
    const usuarioNoInativo = await comoAdmin
      .patch(`/api/v1/usuarios/${membroAvulso.id}`, { area: chave })
      .expect(422);
    expect(usuarioNoInativo.body.detalhes).toMatchObject({
      regra: 'R1.9',
      campo: 'area',
    });
    const funilNoInativo = await comoAdmin
      .post('/api/v1/funis', { nome: 'Outro', area: chave })
      .expect(422);
    expect(funilNoInativo.body.detalhes.regra).toBe('R1.9');
    await comoAdmin
      .patch(`/api/v1/funis/${funil.id}`, { ativo: true })
      .expect(422);
    await comoAdmin
      .post('/api/v1/funis', { nome: 'Outro', area: 'NAO_EXISTE' })
      .expect(422);

    // Um membro não enxerga o setor inativo.
    const comoMembro = await entrarComo(t, membroAvulso);
    await comoMembro.get(`/api/v1/setores/${chave}`).expect(404);

    const reativado = await comoAdmin
      .post(`/api/v1/setores/${chave}/reativar`)
      .expect(200);
    expect(reativado.body).toMatchObject({ chave, ativo: true });
    await comoAdmin
      .patch(`/api/v1/funis/${funil.id}`, { ativo: true })
      .expect(200);
    expect(
      (
        await t.prisma.eventoAuditoria.findMany({
          where: { entidade: 'setor', entidadeId: chave },
          select: { acao: true },
          orderBy: { id: 'asc' },
        })
      ).map(({ acao }) => acao),
    ).toEqual(['setor.criado', 'setor.desativado', 'setor.reativado']);
  });

  it('R1.8 — reativar com o nome em uso por outro setor ativo é recusado', async () => {
    const primeiro = await comoAdmin
      .post('/api/v1/setores', { nome: 'Parcerias' })
      .expect(201);
    const funil = await t.prisma.funil.findFirstOrThrow({
      where: { area: primeiro.body.chave },
    });
    await comoAdmin
      .patch(`/api/v1/funis/${funil.id}`, { ativo: false })
      .expect(200);
    await comoAdmin
      .post(`/api/v1/setores/${primeiro.body.chave}/desativar`)
      .expect(200);
    const segundo = await comoAdmin
      .post('/api/v1/setores', { nome: 'PARCERIAS' })
      .expect(201);
    expect(segundo.body.chave).toBe('PARCERIAS_2');
    const conflito = await comoAdmin
      .post(`/api/v1/setores/${primeiro.body.chave}/reativar`)
      .expect(409);
    expect(conflito.body.detalhes.regra).toBe('R1.8');
  });
});
