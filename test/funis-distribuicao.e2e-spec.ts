import { DistribuicaoService } from '../src/funis/distribuicao.service';
import type {
  Area,
  EstrategiaDistribuicao,
} from '../src/generated/prisma/client';
import { mover } from './funis-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  entrarPeloLogin,
  etapaDoFunilBase,
  SENHA_DE_TESTE,
} from './utils';

describe('Distribuição por rodízio (e2e)', () => {
  let t: AppTeste;
  let distribuicao: DistribuicaoService;

  beforeAll(async () => {
    t = await criarAppTeste();
    distribuicao = t.get(DistribuicaoService);
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  const escolher = (
    area: Area,
    estrategia: EstrategiaDistribuicao = 'RODIZIO',
    responsavelFixoId?: string,
  ) =>
    t.prisma.$transaction((tx) =>
      distribuicao.escolherResponsavel(tx, area, estrategia, responsavelFixoId),
    );

  const escolherVarias = async (area: Area, vezes: number) => {
    const escolhidos: (string | null)[] = [];
    for (let i = 0; i < vezes; i++) {
      escolhidos.push(await escolher(area));
    }
    return escolhidos;
  };

  it('R5.8 — alterna entre os membros ativos em ordem estável, com o ponteiro salvo na regra', async () => {
    const {
      membros: [ana, bruno, caio],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 3 });
    expect(await escolherVarias('COMERCIAL', 7)).toEqual([
      ana.id,
      bruno.id,
      caio.id,
      ana.id,
      bruno.id,
      caio.id,
      ana.id,
    ]);
    const regra = await t.prisma.regraDistribuicao.findUniqueOrThrow({
      where: { area: 'COMERCIAL' },
    });
    expect(regra.ultimoUsuarioId).toBe(ana.id);
    // Cada área tem o seu rodízio.
    const {
      membros: [carla],
    } = await criarEquipe(t, 'CS', { membros: 1 });
    expect(await escolher('CS')).toBe(carla.id);
    expect(await escolher('COMERCIAL')).toBe(bruno.id);
  });

  it('R5.8 — desligado e tirado à mão saem do rodízio; o líder só entra se a regra disser', async () => {
    const {
      lider,
      membros: [ana, bruno, caio],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 3 });
    await t.prisma.usuario.update({
      where: { id: bruno.id },
      data: { ativo: false, desligadoEm: new Date() },
    });
    expect(await escolherVarias('COMERCIAL', 3)).toEqual([
      ana.id,
      caio.id,
      ana.id,
    ]);

    const comoLider = await entrarComo(t, lider);
    await comoLider
      .put(`/api/v1/regras-distribuicao/comercial/participantes/${caio.id}`, {
        participa: false,
      })
      .expect(200);
    expect(await escolherVarias('COMERCIAL', 2)).toEqual([ana.id, ana.id]);

    const comLideres = await comoLider
      .patch('/api/v1/regras-distribuicao/COMERCIAL', { incluirLideres: true })
      .expect(200);
    expect(
      (comLideres.body.participantes as { id: string; motivo: string }[]).map(
        (p) => [p.id, p.motivo],
      ),
    ).toEqual([
      [lider.id, 'LIDER_INCLUIDO_PELA_REGRA'],
      [ana.id, 'MEMBRO_DA_AREA'],
    ]);
    expect(await escolherVarias('COMERCIAL', 2)).toEqual([lider.id, ana.id]);

    await comoLider
      .delete(`/api/v1/regras-distribuicao/comercial/participantes/${caio.id}`)
      .expect(200);
    await comoLider
      .patch('/api/v1/regras-distribuicao/comercial', { incluirLideres: false })
      .expect(200);
    // Inclusão manual de um líder quando a regra não inclui líderes.
    const incluido = await comoLider
      .put(`/api/v1/regras-distribuicao/comercial/participantes/${lider.id}`, {
        participa: true,
      })
      .expect(200);
    expect(
      (incluido.body.participantes as { id: string; motivo: string }[]).map(
        (p) => [p.id, p.motivo],
      ),
    ).toEqual([
      [lider.id, 'INCLUIDO_MANUALMENTE'],
      [ana.id, 'MEMBRO_DA_AREA'],
      [caio.id, 'MEMBRO_DA_AREA'],
    ]);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { entidade: 'regra_distribuicao', usuarioId: lider.id },
      }),
    ).toBe(5);
  });

  it('cenário 19 — R5.8 (ajuste): só entra no rodízio quem já ativou o acesso: convite pendente e senha temporária sem login ficam fora até ativar', async () => {
    const {
      lider,
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const convidado = await criarUsuario(t, {
      papel: 'COMERCIAL',
      lider,
      senha: null,
    });
    const temporario = await criarUsuario(t, {
      papel: 'COMERCIAL',
      lider,
      deveTrocarSenha: true,
    });
    expect(await escolherVarias('COMERCIAL', 2)).toEqual([ana.id, ana.id]);

    const comoLider = await entrarComo(t, lider);
    const regra = await comoLider
      .get('/api/v1/regras-distribuicao/comercial')
      .expect(200);
    expect(
      (regra.body.participantes as { id: string }[]).map((p) => p.id),
    ).toEqual([ana.id]);
    expect(regra.body.aguardandoAcesso).toEqual([
      expect.objectContaining({
        id: convidado.id,
        papel: 'COMERCIAL',
        motivo: 'CONVITE_PENDENTE',
      }),
      expect.objectContaining({
        id: temporario.id,
        motivo: 'PRIMEIRO_ACESSO_PENDENTE',
      }),
    ]);
    // Nada de senha nem de dados de acesso na resposta.
    expect(Object.keys(regra.body.aguardandoAcesso[0]).sort()).toEqual([
      'avatarUrl',
      'id',
      'motivo',
      'nome',
      'papel',
    ]);
    // Incluir à mão quem ainda não ativou não o põe na fila.
    const incluido = await comoLider
      .put(
        `/api/v1/regras-distribuicao/comercial/participantes/${convidado.id}`,
        { participa: true },
      )
      .expect(200);
    expect(
      (incluido.body.participantes as { id: string }[]).map((p) => p.id),
    ).toEqual([ana.id]);
    expect(await escolher('COMERCIAL')).toBe(ana.id);

    // Só entrar não basta: o primeiro login se conclui com a troca da senha temporária.
    const { cliente: comoTemporario } = await entrarPeloLogin(
      t,
      temporario.email,
    );
    expect(await escolher('COMERCIAL')).toBe(ana.id);
    await comoTemporario
      .post('/api/v1/auth/senha', {
        senhaAtual: SENHA_DE_TESTE,
        novaSenha: 'senha-nova-do-temporario',
      })
      .expect(200);
    expect(await escolher('COMERCIAL')).toBe(temporario.id);
    // Definir a senha do convite também (o que o link do convite grava; o banco
    // marca `acesso_ativado_em`).
    await t.prisma.usuario.update({
      where: { id: convidado.id },
      data: {
        senhaHash: temporario.senhaHash,
        deveTrocarSenha: false,
        senhaAlteradaEm: new Date(),
      },
    });
    // Uma senha temporária nova, depois, não tira ninguém do rodízio.
    await t.prisma.usuario.update({
      where: { id: temporario.id },
      data: { deveTrocarSenha: true },
    });
    expect(await escolherVarias('COMERCIAL', 3)).toEqual([
      ana.id,
      convidado.id,
      temporario.id,
    ]);
    const depois = await comoLider
      .get('/api/v1/regras-distribuicao/comercial')
      .expect(200);
    expect(depois.body.aguardandoAcesso).toEqual([]);
  });

  it('R5.8 — sem membros disponíveis vai para o líder da área; sem líder, para um C-level; sem ninguém, fica sem responsável', async () => {
    const { cLevel, lider } = await criarEquipe(t, 'CS', { membros: 0 });
    expect(await escolher('CS')).toBe(lider.id);
    await t.prisma.usuario.update({
      where: { id: lider.id },
      data: { ativo: false },
    });
    expect(await escolher('CS')).toBe(cLevel.id);
    await t.prisma.usuario.update({
      where: { id: cLevel.id },
      data: { ativo: false },
    });
    expect(await escolher('CS')).toBeNull();
    // O ponteiro só anda no rodízio de verdade.
    expect(
      (
        await t.prisma.regraDistribuicao.findUniqueOrThrow({
          where: { area: 'CS' },
        })
      ).ultimoUsuarioId,
    ).toBeNull();
  });

  it('R5.8 — LIDER_DA_AREA e RESPONSAVEL_FIXO (inativo, de outra área ou ausente cai para o líder da área)', async () => {
    const {
      cLevel,
      lider,
      membros: [ana],
    } = await criarEquipe(t, 'MARKETING', { membros: 1 });
    const {
      membros: [carlos],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1, cLevel });
    expect(await escolher('MARKETING', 'LIDER_DA_AREA')).toBe(lider.id);
    expect(await escolher('MARKETING', 'RESPONSAVEL_FIXO', ana.id)).toBe(
      ana.id,
    );
    expect(await escolher('MARKETING', 'RESPONSAVEL_FIXO', cLevel.id)).toBe(
      cLevel.id,
    );
    expect(await escolher('MARKETING', 'RESPONSAVEL_FIXO', carlos.id)).toBe(
      lider.id,
    );
    await t.prisma.usuario.update({
      where: { id: ana.id },
      data: { ativo: false },
    });
    expect(await escolher('MARKETING', 'RESPONSAVEL_FIXO', ana.id)).toBe(
      lider.id,
    );
    expect(await escolher('MARKETING', 'RESPONSAVEL_FIXO')).toBe(lider.id);
    expect(
      await t.prisma.logTecnico.count({ where: { contexto: 'Distribuicao' } }),
    ).toBe(3);
  });

  it('R5.8 — concorrência: distribuições simultâneas não repetem a pessoa (trava na linha da regra)', async () => {
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 3 });
    const escolhidos = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.prisma.$transaction(async (tx) => {
          const id = await distribuicao.escolherResponsavel(
            tx,
            'COMERCIAL',
            'RODIZIO',
          );
          // Segura a trava um pouco: as outras transações esperam na fila.
          await new Promise((resolver) => setTimeout(resolver, 50));
          return id;
        }),
      ),
    );
    const vezes = new Map<string | null, number>();
    for (const id of escolhidos) {
      vezes.set(id, (vezes.get(id) ?? 0) + 1);
    }
    expect(membros.map((membro) => vezes.get(membro.id) ?? 0)).toEqual([
      2, 2, 2,
    ]);
  });

  it('R5.8 — concorrência ponta a ponta: passagens simultâneas distribuem o Comercial em rodízio', async () => {
    const cLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const {
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    const { membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 3,
      cLevel,
    });
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const negocios = await Promise.all(
      Array.from({ length: 6 }, async () =>
        criarNegocio(t, {
          area: 'MARKETING',
          contato: await criarContato(t),
          responsavel: marina,
        }),
      ),
    );
    const comoMarina = await entrarComo(t, marina);
    const respostas = await Promise.all(
      negocios.map((negocio) => mover(comoMarina, negocio.id, mql.id)),
    );
    expect(respostas.map((resposta) => resposta.status)).toEqual(
      Array(6).fill(200),
    );
    const noComercial = await t.prisma.negocio.groupBy({
      by: ['responsavelId'],
      where: { funil: { area: 'COMERCIAL' } },
      _count: { _all: true },
    });
    expect(
      membros.map(
        (membro) =>
          noComercial.find((linha) => linha.responsavelId === membro.id)?._count
            ._all ?? 0,
      ),
    ).toEqual([2, 2, 2]);
  });

  it('configuração do rodízio: o líder só a da sua área; o membro não; mostra a ordem e o próximo da vez', async () => {
    const admin = await criarUsuario(t);
    const {
      lider,
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL');
    const {
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1 });

    const doAdmin = await (
      await entrarComo(t, admin)
    )
      .get('/api/v1/regras-distribuicao')
      .expect(200);
    expect(
      (doAdmin.body as { area: string }[]).map((regra) => regra.area),
    ).toEqual(['MARKETING', 'COMERCIAL', 'CS']);

    const comoLider = await entrarComo(t, lider);
    const doLider = await comoLider
      .get('/api/v1/regras-distribuicao')
      .expect(200);
    expect((doLider.body as { area: string }[]).map((r) => r.area)).toEqual([
      'COMERCIAL',
    ]);
    await comoLider.get('/api/v1/regras-distribuicao/cs').expect(403);
    await comoLider.get('/api/v1/regras-distribuicao/vendas').expect(400);
    await (
      await entrarComo(t, ana)
    )
      .get('/api/v1/regras-distribuicao')
      .expect(403);

    const antes = await comoLider
      .get('/api/v1/regras-distribuicao/comercial')
      .expect(200);
    expect(antes.body).toMatchObject({
      area: 'COMERCIAL',
      incluirLideres: false,
      ultimoUsuario: null,
      proximo: { id: ana.id },
    });
    expect(
      (antes.body.participantes as { id: string }[]).map(({ id }) => id),
    ).toEqual([ana.id, bruno.id]);
    await escolher('COMERCIAL');
    const depois = await comoLider
      .get('/api/v1/regras-distribuicao/comercial')
      .expect(200);
    expect(depois.body).toMatchObject({
      ultimoUsuario: { id: ana.id },
      proximo: { id: bruno.id },
    });

    const deOutraArea = await comoLider
      .put(`/api/v1/regras-distribuicao/comercial/participantes/${marina.id}`, {
        participa: true,
      })
      .expect(422);
    expect(deOutraArea.body.detalhes.regra).toBe('R5.8');
    await comoLider
      .delete(`/api/v1/regras-distribuicao/comercial/participantes/${bruno.id}`)
      .expect(404);
    await comoLider
      .put(`/api/v1/regras-distribuicao/comercial/participantes/${bruno.id}`, {
        participa: 'sim',
      })
      .expect(400);
  });
});
