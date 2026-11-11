import type { Response } from 'supertest';
import { filtroDeLinhaDoTempo } from '../src/auditoria/auditoria.service';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { DesligamentoService } from '../src/usuarios/desligamento.service';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  entrarPeloLogin,
  etapaDoFunilBase,
  funilBase,
  processarEventos,
} from './utils';

describe('Usuários — desligamento com encaminhamento (e2e)', () => {
  let t: AppTeste;
  let admin: Usuario;
  let comoAdmin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin Geral' });
    comoAdmin = await entrarComo(t, admin);
  });

  afterAll(async () => {
    await t.fechar();
  });

  const desligar = (id: string, corpo: object = {}) =>
    comoAdmin.post(`/api/v1/usuarios/${id}/desligar`, corpo);
  const previa = (id: string, destinatarioId?: string) =>
    comoAdmin.get(
      `/api/v1/usuarios/${id}/desligamento/previa${destinatarioId ? `?destinatarioId=${destinatarioId}` : ''}`,
    );

  it('cenário 3 — R2.4: login → cookie → auth/eu responde; desligar o usuário → a requisição seguinte dele devolve 401', async () => {
    const { membros } = await criarEquipe(t, 'MARKETING', { membros: 1 });
    const [membro] = membros;
    const { cliente } = await entrarPeloLogin(t, membro.email);
    const outraSessao = await entrarComo(t, membro);
    await cliente.get('/api/v1/auth/eu').expect(200);

    const resposta = await desligar(membro.id).expect(200);
    expect(resposta.body.contagens.sessoesRevogadas).toBe(2);
    expect(resposta.body.usuario).toMatchObject({
      id: membro.id,
      ativo: false,
      desligadoEm: expect.any(String),
    });

    const negado = await cliente.get('/api/v1/auth/eu').expect(401);
    expect(negado.body.erro).toBe('nao_autenticado');
    await outraSessao.get('/api/v1/notificacoes').expect(401);
    const sessoes = await t.prisma.sessao.findMany({
      where: { usuarioId: membro.id },
    });
    expect(sessoes).toHaveLength(2);
    for (const sessao of sessoes) {
      expect(sessao).toMatchObject({ motivoRevogacao: 'desligamento' });
      expect(sessao.revogadaEm).not.toBeNull();
    }
    // E o login com a senha certa responde "Acesso desativado" (R2.3).
    const { resposta: login } = await entrarPeloLogin(t, membro.email);
    expect(login.status).toBe(403);
  });

  it('cenário 4 — R7: membro com 3 atividades pendentes, 1 concluída, 2 negócios abertos e 1 contato → tudo vai para o líder; a concluída fica; o líder é notificado; a auditoria guarda as contagens', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const pedro = await t.prisma.usuario.update({
      where: { id: membros[0].id },
      data: { nome: 'Pedro' },
    });
    const contato = await criarContato(t, { responsavel: pedro });
    const pendentes = [
      await criarAtividade(t, { responsavel: pedro, contato }),
      await criarAtividade(t, { responsavel: pedro, tipo: 'LIGACAO' }),
      await criarAtividade(t, {
        responsavel: pedro,
        tipo: 'REUNIAO',
        inicioEm: new Date(),
        fimEm: new Date(Date.now() + 3_600_000),
      }),
    ];
    const concluida = await criarAtividade(t, {
      responsavel: pedro,
      status: 'CONCLUIDA',
    });
    const abertos = [
      await criarNegocio(t, { contato, responsavel: pedro, valor: '100.00' }),
      await criarNegocio(t, { contato, responsavel: pedro, etapa: 'proposta' }),
    ];
    const ganho = await criarNegocio(t, {
      contato,
      responsavel: pedro,
      etapa: 'ganho',
    });

    // R7.1: a prévia mostra quem recebe e quanto, sem alterar nada.
    const vista = await previa(pedro.id).expect(200);
    expect(vista.body).toEqual({
      usuario: expect.objectContaining({ id: pedro.id, nome: 'Pedro' }),
      destinatario: expect.objectContaining({ id: lider.id }),
      motivoDestinatario: 'LIDER',
      explicacao: `O que está com Pedro (Comercial) vai para o líder, ${lider.nome}.`,
      exigeEscolha: false,
      candidatos: [],
      ignorados: [],
      contagens: {
        atividades: 3,
        negocios: 2,
        contatos: 1,
        empresas: 0,
        liderados: 0,
        responsavelFixo: 0,
      },
      // Ajuste da R7.3: o líder atua no funil Comercial, então fica com os dois negócios.
      divisaoDosNegocios: [
        expect.objectContaining({
          destinatario: expect.objectContaining({ id: lider.id }),
          motivo: 'DESTINATARIO',
          negocios: 2,
        }),
      ],
      liderados: [],
      alertaEquipeSemLider: false,
    });
    expect(
      (await t.prisma.usuario.findUniqueOrThrow({ where: { id: pedro.id } }))
        .ativo,
    ).toBe(true);

    const resposta = await desligar(pedro.id, {
      destinatarioId: lider.id,
    }).expect(200);
    expect(resposta.body).toMatchObject({
      destinatario: { id: lider.id },
      motivoDestinatario: 'LIDER',
      contagens: {
        atividades: 3,
        negocios: 2,
        contatos: 1,
        empresas: 0,
        liderados: 0,
      },
    });

    // As 3 pendentes vão para o líder, com a origem do encaminhamento.
    const transferidas = await t.prisma.atividade.findMany({
      where: { id: { in: pendentes.map(({ id }) => id) } },
    });
    for (const atividade of transferidas) {
      expect(atividade).toMatchObject({
        responsavelId: lider.id,
        encaminhadaDeId: pedro.id,
        status: 'PENDENTE',
      });
      expect(atividade.encaminhadaEm).not.toBeNull();
    }
    // A concluída fica com quem a fez.
    expect(
      await t.prisma.atividade.findUniqueOrThrow({
        where: { id: concluida.id },
      }),
    ).toMatchObject({ responsavelId: pedro.id, encaminhadaDeId: null });
    // Negócios abertos e o contato vão; o ganho fica.
    for (const negocio of abertos) {
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).responsavelId,
      ).toBe(lider.id);
    }
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: ganho.id } }))
        .responsavelId,
    ).toBe(pedro.id);
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(lider.id);

    // O líder é notificado (R7.4).
    const notificacoes = await t.prisma.notificacao.findMany({
      where: { usuarioId: lider.id },
    });
    expect(notificacoes).toEqual([
      expect.objectContaining({
        tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
        titulo: 'Itens recebidos de Pedro',
        texto: 'Você recebeu 3 atividades, 2 negócios e 1 contato de Pedro.',
      }),
    ]);
    const comoLider = await entrarComo(t, lider);
    const sino = await comoLider
      .get('/api/v1/notificacoes/nao-lidas/contagem')
      .expect(200);
    expect(sino.body.naoLidas).toBe(1);

    // A auditoria guarda as contagens (R7.4).
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'usuario.desligado', entidadeId: pedro.id },
    });
    expect(auditoria).toMatchObject({
      tipoAtor: 'USUARIO',
      usuarioId: admin.id,
      resumo: `Desligamento de Pedro (Comercial) — para ${lider.nome}: 3 atividades, 2 negócios e 1 contato`,
      dados: {
        destinatario: { id: lider.id, nome: lider.nome },
        motivoDestinatario: 'LIDER',
        contagens: {
          atividades: 3,
          negocios: 2,
          contatos: 1,
          empresas: 0,
          liderados: 0,
          sessoesRevogadas: 0,
        },
      },
    });
    expect(auditoria.relacionados).toEqual(
      expect.arrayContaining([`usuario:${pedro.id}`, `usuario:${lider.id}`]),
    );
    // Cada encaminhamento aparece na linha do tempo do item (R3.2, R3.5).
    const linhaDoContato = await t.prisma.eventoAuditoria.findMany({
      where: filtroDeLinhaDoTempo('contato', contato.id),
      select: { acao: true },
    });
    expect(linhaDoContato.map(({ acao }) => acao).sort()).toEqual([
      'atividade.encaminhada',
      'contato.encaminhado',
      'negocio.encaminhado',
      'negocio.encaminhado',
    ]);

    // R7.4: o evento usuario.desligado vai para a outbox (webhooks de saída).
    const evento = await t.prisma.eventoDominio.findFirstOrThrow({
      where: { tipo: 'usuario.desligado' },
    });
    expect(evento).toMatchObject({ tipoAtor: 'USUARIO', usuarioId: admin.id });
    expect(evento.dados).toMatchObject({
      usuario: { id: pedro.id, papel: 'MEMBRO', area: 'COMERCIAL' },
      destinatario: { id: lider.id },
      motivoDestinatario: 'LIDER',
      contagens: { atividades: 3, negocios: 2, contatos: 1 },
    });
    await processarEventos(t);
    expect(
      (
        await t.prisma.eventoDominio.findUniqueOrThrow({
          where: { id: evento.id },
        })
      ).processadoEm,
    ).not.toBeNull();
  });

  it('cenário 5 — R7.2/R7.3: desligar um líder → os itens vão para o C-level, os liderados passam a responder a ele e o Admin recebe "equipe sem líder"', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'CS');
    const outroAdmin = await criarUsuario(t, { papel: 'ADMIN' });
    const empresa = await criarEmpresa(t, { responsavel: lider });
    const atividade = await criarAtividade(t, { responsavel: lider });
    const negocio = await criarNegocio(t, { area: 'CS', responsavel: lider });

    const vista = await previa(lider.id).expect(200);
    expect(vista.body).toMatchObject({
      destinatario: { id: cLevel.id },
      motivoDestinatario: 'C_LEVEL_RESPONSAVEL',
      alertaEquipeSemLider: true,
      contagens: { atividades: 1, negocios: 1, empresas: 1, liderados: 2 },
      liderados: expect.arrayContaining(
        membros.map(({ id }) => expect.objectContaining({ id })),
      ),
    });

    const resposta = await desligar(lider.id).expect(200);
    expect(resposta.body).toMatchObject({
      destinatario: { id: cLevel.id },
      motivoDestinatario: 'C_LEVEL_RESPONSAVEL',
      contagens: { atividades: 1, negocios: 1, empresas: 1, liderados: 2 },
    });

    expect(
      await t.prisma.atividade.findUniqueOrThrow({
        where: { id: atividade.id },
      }),
    ).toMatchObject({ responsavelId: cLevel.id, encaminhadaDeId: lider.id });
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: negocio.id } }))
        .responsavelId,
    ).toBe(cLevel.id);
    expect(
      (await t.prisma.empresa.findUniqueOrThrow({ where: { id: empresa.id } }))
        .responsavelId,
    ).toBe(cLevel.id);
    // Os liderados passam a responder ao C-level até o Admin definir um novo líder.
    const liderados = await t.prisma.usuario.findMany({
      where: { id: { in: membros.map(({ id }) => id) } },
    });
    expect(liderados.map(({ liderId }) => liderId)).toEqual([
      cLevel.id,
      cLevel.id,
    ]);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.lider_alterado' },
      }),
    ).toBe(2);

    // Cada Admin ativo recebe o alerta "equipe sem líder".
    for (const quem of [admin, outroAdmin]) {
      const alertas = await t.prisma.notificacao.findMany({
        where: { usuarioId: quem.id, tipo: TIPOS_NOTIFICACAO.EQUIPE_SEM_LIDER },
      });
      expect(alertas).toEqual([
        expect.objectContaining({
          titulo: 'Equipe sem líder: Customer Success',
          texto: `Com o desligamento de ${lider.nome} (Líder Customer Success), a equipe de Customer Success ficou sem líder: 2 liderados passaram a responder a ${cLevel.nome} até você definir um novo líder.`,
        }),
      ]);
    }
    // O C-level é notificado do que recebeu, inclusive os liderados.
    const recebido = await t.prisma.notificacao.findFirstOrThrow({
      where: { usuarioId: cLevel.id },
    });
    expect(recebido.texto).toContain(
      `Você recebeu 1 atividade, 1 negócio e 1 empresa de ${lider.nome}.`,
    );
    expect(recebido.texto).toContain(
      'passaram a responder a você até a definição de um novo líder.',
    );

    // Na visão de equipe, os liderados aparecem aguardando novo líder.
    const comoCLevel = await entrarComo(t, cLevel);
    const equipes = await comoCLevel
      .get(`/api/v1/usuarios/equipes?liderId=${cLevel.id}`)
      .expect(200);
    expect(equipes.body[0].membros).toEqual(
      membros.map(() => expect.objectContaining({ aguardandoNovoLider: true })),
    );

    // O Admin define o novo líder (R1.2) e a equipe se normaliza.
    const { lider: novoLider } = await criarEquipe(t, 'CS', {
      membros: 0,
      cLevel,
    });
    for (const membro of membros) {
      await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { liderId: novoLider.id })
        .expect(200);
    }
  });

  it('cenário 6 — R7.2: membro cujo líder está inativo → os itens sobem direto para o C-level', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'MARKETING', {
      membros: 1,
    });
    const [membro] = membros;
    // O líder saiu sem passar pelo desligamento: o membro ainda aponta para ele.
    await t.prisma.usuario.update({
      where: { id: lider.id },
      data: { ativo: false, desligadoEm: new Date() },
    });
    const contato = await criarContato(t, { responsavel: membro });
    const atividade = await criarAtividade(t, { responsavel: membro, contato });

    const vista = await previa(membro.id).expect(200);
    expect(vista.body).toMatchObject({
      destinatario: { id: cLevel.id },
      motivoDestinatario: 'SUBIU_NA_CADEIA',
      ignorados: [expect.objectContaining({ id: lider.id, ativo: false })],
      explicacao: `O líder de ${membro.nome} (Marketing), ${lider.nome}, foi desligado: o que está com ${membro.nome} sobe na cadeia até ${cLevel.nome}.`,
    });

    const resposta = await desligar(membro.id).expect(200);
    expect(resposta.body).toMatchObject({
      destinatario: { id: cLevel.id },
      motivoDestinatario: 'SUBIU_NA_CADEIA',
    });
    expect(
      (
        await t.prisma.atividade.findUniqueOrThrow({
          where: { id: atividade.id },
        })
      ).responsavelId,
    ).toBe(cLevel.id);
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(cLevel.id);
    expect(
      await t.prisma.notificacao.count({ where: { usuarioId: cLevel.id } }),
    ).toBe(1);
    expect(
      await t.prisma.notificacao.count({ where: { usuarioId: lider.id } }),
    ).toBe(0);
    // Membro desligado não gera "equipe sem líder".
    expect(
      await t.prisma.notificacao.count({
        where: { tipo: TIPOS_NOTIFICACAO.EQUIPE_SEM_LIDER },
      }),
    ).toBe(0);
  });

  it('R7.2 — C-level desligado: o Admin escolhe outro C-level ativo, que recebe os itens e os líderes', async () => {
    const { cLevel, lider } = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
    const outroCLevel = await criarUsuario(t, { papel: 'C_LEVEL' });
    const negocio = await criarNegocio(t, { responsavel: cLevel });

    const vista = await previa(cLevel.id).expect(200);
    expect(vista.body).toMatchObject({
      destinatario: null,
      motivoDestinatario: null,
      exigeEscolha: true,
      candidatos: [expect.objectContaining({ id: outroCLevel.id })],
      contagens: { negocios: 1, liderados: 1 },
    });
    const comEscolha = await previa(cLevel.id, outroCLevel.id).expect(200);
    expect(comEscolha.body).toMatchObject({
      destinatario: { id: outroCLevel.id },
      motivoDestinatario: 'ESCOLHIDO_PELO_ADMIN',
    });

    const semEscolha = await desligar(cLevel.id).expect(422);
    expect(semEscolha.body).toMatchObject({
      detalhes: {
        regra: 'R7.2',
        candidatos: [expect.objectContaining({ id: outroCLevel.id })],
      },
    });
    const escolhaInvalida = await desligar(cLevel.id, {
      destinatarioId: lider.id,
    }).expect(422);
    expect(escolhaInvalida.body.detalhes.regra).toBe('R7.2');
    expect(
      (await t.prisma.usuario.findUniqueOrThrow({ where: { id: cLevel.id } }))
        .ativo,
    ).toBe(true);

    await desligar(cLevel.id, { destinatarioId: outroCLevel.id }).expect(200);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: negocio.id } }))
        .responsavelId,
    ).toBe(outroCLevel.id);
    // O líder passa a responder ao outro C-level: hierarquia válida, sem alerta.
    expect(
      (await t.prisma.usuario.findUniqueOrThrow({ where: { id: lider.id } }))
        .liderId,
    ).toBe(outroCLevel.id);
    expect(
      await t.prisma.notificacao.count({
        where: { tipo: TIPOS_NOTIFICACAO.EQUIPE_SEM_LIDER },
      }),
    ).toBe(0);
  });

  it('R7.2 — sem outro C-level ativo, o C-level não é desligado', async () => {
    const { cLevel } = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
    const resposta = await previa(cLevel.id).expect(422);
    expect(resposta.body).toMatchObject({
      detalhes: { regra: 'R7.2' },
      mensagem: expect.stringContaining('Não há outro C-level ativo'),
    });
  });

  it('R7.2 — Admin desligado: o que estava com ele vai para o Admin que executa; ninguém desliga a si mesmo', async () => {
    const outroAdmin = await criarUsuario(t, { papel: 'ADMIN' });
    const contato = await criarContato(t, { responsavel: outroAdmin });

    const resposta = await desligar(outroAdmin.id).expect(200);
    expect(resposta.body).toMatchObject({
      destinatario: { id: admin.id },
      motivoDestinatario: 'ADMIN_EXECUTOR',
      contagens: { contatos: 1 },
    });
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(admin.id);

    const terceiro = await criarUsuario(t, { papel: 'ADMIN' });
    const proprio = await desligar(admin.id).expect(422);
    expect(proprio.body.detalhes.regra).toBe('R7.2');
    expect(proprio.body.mensagem).toContain(
      'não pode desligar a própria conta',
    );
    expect(
      (await t.prisma.usuario.findUniqueOrThrow({ where: { id: terceiro.id } }))
        .ativo,
    ).toBe(true);
  });

  it('R7.2 — o destinatário informado confirma a prévia: se a situação mudou, 409', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const vista = await previa(membro.id).expect(200);
    expect(vista.body.destinatario.id).toBe(lider.id);

    // Entre a prévia e a confirmação, o líder foi desligado.
    await desligar(lider.id).expect(200);
    const resposta = await desligar(membro.id, {
      destinatarioId: vista.body.destinatario.id,
    }).expect(409);
    expect(resposta.body).toMatchObject({
      erro: 'conflito',
      detalhes: {
        regra: 'R7.2',
        destinatarioCalculado: expect.objectContaining({ id: cLevel.id }),
      },
    });
    await desligar(membro.id, { destinatarioId: cLevel.id }).expect(200);
  });

  it('R7.6 — desligar quem já está desligado devolve 409', async () => {
    const { membros } = await criarEquipe(t, 'CS', { membros: 1 });
    await desligar(membros[0].id).expect(200);
    const resposta = await desligar(membros[0].id).expect(409);
    expect(resposta.body).toMatchObject({
      erro: 'conflito',
      detalhes: { regra: 'R7.6', desligadoEm: expect.any(String) },
    });
    await previa(membros[0].id).expect(409);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.desligado' },
      }),
    ).toBe(1);
    await desligar('00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('R7.6 — dois pedidos de desligamento ao mesmo tempo: um desliga, o outro recebe 409', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    await criarContato(t, { responsavel: membros[0] });
    const respostas = await Promise.all([
      desligar(membros[0].id),
      desligar(membros[0].id),
    ]);
    expect(respostas.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [200, 409],
    );
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.desligado' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.notificacao.count({ where: { usuarioId: lider.id } }),
    ).toBe(1);
  });

  it('R1.4 — dois Admins desligando um ao outro ao mesmo tempo: só um consegue', async () => {
    const outro = await criarUsuario(t, { papel: 'ADMIN' });
    const comoOutro = await entrarComo(t, outro);
    const respostas = await Promise.all([
      desligar(outro.id),
      comoOutro.post(`/api/v1/usuarios/${admin.id}/desligar`, {}),
    ]);
    const situacoes = respostas
      .map(({ status }) => status)
      .sort((a, b) => a - b);
    expect(situacoes[0]).toBe(200);
    expect([401, 403]).toContain(situacoes[1]);
    expect(
      await t.prisma.usuario.count({ where: { papel: 'ADMIN', ativo: true } }),
    ).toBe(1);
  });

  it('R7.5 — reativar exige um líder válido e não devolve o que foi encaminhado', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const contato = await criarContato(t, { responsavel: membro });
    const atividade = await criarAtividade(t, { responsavel: membro });
    await desligar(membro.id).expect(200);

    const semLider = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, {})
      .expect(422);
    expect(semLider.body).toMatchObject({
      detalhes: {
        regra: 'R7.5',
        liderEsperado: { papel: 'LIDER', area: 'COMERCIAL' },
      },
      mensagem: `Para reativar ${membro.nome} como Comercial, defina um líder válido: um Líder Comercial ativo.`,
    });
    const liderInvalido = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, { liderId: cLevel.id })
      .expect(422);
    expect(liderInvalido.body.detalhes.regra).toBe('R1.2');

    const reativado = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, { liderId: lider.id })
      .expect(200);
    expect(reativado.body).toMatchObject({
      id: membro.id,
      ativo: true,
      desligadoEm: null,
      lider: { id: lider.id },
    });
    // Nada volta (R7.5).
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(lider.id);
    expect(
      (
        await t.prisma.atividade.findUniqueOrThrow({
          where: { id: atividade.id },
        })
      ).responsavelId,
    ).toBe(lider.id);
    // Volta a entrar no CRM.
    const { resposta } = await entrarPeloLogin(t, membro.email);
    expect(resposta.status).toBe(200);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.reativado', entidadeId: membro.id },
      }),
    ).toBe(1);

    const jaAtivo = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, { liderId: lider.id })
      .expect(409);
    expect(jaAtivo.body.erro).toBe('conflito');
  });

  it('R7.5 — a reativação pode trazer a pessoa em outro papel, com o líder desse papel', async () => {
    const { cLevel, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    await desligar(membro.id).expect(200);
    const comoCLevelSemLider = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, {
        papel: 'C_LEVEL',
        liderId: cLevel.id,
      })
      .expect(422);
    expect(comoCLevelSemLider.body.detalhes.regra).toBe('R1.2');
    const reativado = await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, {
        papel: 'LIDER',
        area: 'MARKETING',
        liderId: cLevel.id,
      })
      .expect(200);
    expect(reativado.body).toMatchObject({
      papel: 'LIDER',
      area: 'MARKETING',
      rotuloPapel: 'Líder Marketing',
      lider: { id: cLevel.id },
    });
  });

  it('R7.3 — tira o usuário dos rodízios; a reativação o devolve à regra padrão da área', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const regras = await t.prisma.regraDistribuicao.findMany();
    const marketing = regras.find(({ area }) => area === 'MARKETING');
    if (!marketing) {
      throw new Error('a configuração inicial cria uma regra por área');
    }
    // Incluído de propósito no rodízio de Marketing.
    await t.prisma.regraDistribuicaoParticipante.create({
      data: { regraId: marketing.id, usuarioId: membro.id, participa: true },
    });

    await desligar(membro.id).expect(200);
    const participacoes = await t.prisma.regraDistribuicaoParticipante.findMany(
      {
        where: { usuarioId: membro.id },
      },
    );
    expect(participacoes).toHaveLength(regras.length);
    expect(participacoes.every(({ participa }) => !participa)).toBe(true);

    await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, { liderId: lider.id })
      .expect(200);
    expect(
      await t.prisma.regraDistribuicaoParticipante.count({
        where: { usuarioId: membro.id },
      }),
    ).toBe(0);
  });

  it('R7.3 — webhooks de entrada e passagens com o usuário como responsável fixo passam para o destinatário', async () => {
    const { lider, membros } = await criarEquipe(t, 'MARKETING', {
      membros: 1,
    });
    const [membro] = membros;
    const funil = await funilBase(t, 'MARKETING');
    const etapa = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
    const webhook = await t.prisma.webhookEntrada.create({
      data: {
        nome: 'Landing de teste',
        tokenHash: 'hash-de-teste',
        tokenPrefixo: 'abc',
        funilId: funil.id,
        etapaId: etapa.id,
        estrategia: 'RESPONSAVEL_FIXO',
        responsavelFixoId: membro.id,
      },
    });
    const passagem = await t.prisma.passagem.update({
      where: { chave: 'marketing_comercial' },
      data: { estrategia: 'RESPONSAVEL_FIXO', responsavelFixoId: membro.id },
    });

    const vista = await previa(membro.id).expect(200);
    expect(vista.body.contagens.responsavelFixo).toBe(2);
    const resposta = await desligar(membro.id).expect(200);
    expect(resposta.body.contagens.responsavelFixo).toBe(2);
    expect(
      (
        await t.prisma.webhookEntrada.findUniqueOrThrow({
          where: { id: webhook.id },
        })
      ).responsavelFixoId,
    ).toBe(lider.id);
    expect(
      (
        await t.prisma.passagem.findUniqueOrThrow({
          where: { id: passagem.id },
        })
      ).responsavelFixoId,
    ).toBe(lider.id);
    const aviso = await t.prisma.notificacao.findFirstOrThrow({
      where: { usuarioId: lider.id },
    });
    expect(aviso.texto).toContain('2 distribuições automáticas');
  });

  it('R7.3/R5.13 — membro com acesso MEMBRO a um funil de outro setor é desligado: o negócio desse funil vai para o líder do outro setor; a prévia mostra a divisão', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const cs = await criarEquipe(t, 'CS', {
      membros: 0,
      cLevel: comercial.cLevel,
    });
    const [pedro] = comercial.membros;
    const funilCs = await funilBase(t, 'CS');
    const funilComercial = await funilBase(t, 'COMERCIAL');
    await comoAdmin
      .put(`/api/v1/funis/${funilCs.id}/acessos`, {
        acessos: [{ usuarioId: pedro.id, nivel: 'MEMBRO' }],
      })
      .expect(200);
    const doComercial = await criarNegocio(t, {
      area: 'COMERCIAL',
      responsavel: pedro,
    });
    const doCs = await criarNegocio(t, { area: 'CS', responsavel: pedro });

    const vista = await previa(pedro.id).expect(200);
    expect(vista.body.destinatario.id).toBe(comercial.lider.id);
    expect(vista.body.contagens.negocios).toBe(2);
    expect(vista.body.divisaoDosNegocios).toEqual([
      {
        destinatario: expect.objectContaining({ id: comercial.lider.id }),
        motivo: 'DESTINATARIO',
        negocios: 1,
        funis: [
          {
            id: funilComercial.id,
            nome: funilComercial.nome,
            area: 'COMERCIAL',
          },
        ],
      },
      {
        destinatario: expect.objectContaining({ id: cs.lider.id }),
        motivo: 'LIDER_DO_SETOR_DO_FUNIL',
        negocios: 1,
        funis: [{ id: funilCs.id, nome: funilCs.nome, area: 'CS' }],
      },
    ]);

    const resposta = await desligar(pedro.id).expect(200);
    expect(resposta.body.contagens.negocios).toBe(2);
    expect(resposta.body.divisaoDosNegocios).toHaveLength(2);
    const responsavel = async (id: string) =>
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id } }))
        .responsavelId;
    expect(await responsavel(doComercial.id)).toBe(comercial.lider.id);
    expect(await responsavel(doCs.id)).toBe(cs.lider.id);
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'negocio.encaminhado', entidadeId: doCs.id },
    });
    expect(auditoria.dados).toMatchObject({
      para: { id: cs.lider.id },
      motivoDaParte: 'LIDER_DO_SETOR_DO_FUNIL',
      regra: 'R5.13',
      alteracoes: {
        responsavelId: { antes: pedro.id, depois: cs.lider.id },
      },
    });
    // Cada um é avisado só do que recebeu.
    const avisoCs = await t.prisma.notificacao.findFirstOrThrow({
      where: {
        usuarioId: cs.lider.id,
        tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
      },
    });
    expect(avisoCs.texto).toContain('1 negócio');
    const avisoLider = await t.prisma.notificacao.findFirstOrThrow({
      where: {
        usuarioId: comercial.lider.id,
        tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
      },
    });
    expect(avisoLider.texto).toContain('1 negócio');
    // Sem líder ativo no CS, o negócio do funil de CS sobe para o C-level.
    const ana = await criarUsuario(t, {
      papel: 'MEMBRO',
      area: 'COMERCIAL',
      lider: comercial.lider,
    });
    await comoAdmin
      .put(`/api/v1/funis/${funilCs.id}/acessos`, {
        acessos: [{ usuarioId: ana.id, nivel: 'MEMBRO' }],
      })
      .expect(200);
    const outroDoCs = await criarNegocio(t, { area: 'CS', responsavel: ana });
    await t.prisma.usuario.update({
      where: { id: cs.lider.id },
      data: { ativo: false, desligadoEm: new Date() },
    });
    const semLider = await previa(ana.id).expect(200);
    expect(semLider.body.divisaoDosNegocios).toEqual([
      expect.objectContaining({
        destinatario: expect.objectContaining({ id: comercial.cLevel.id }),
        motivo: 'C_LEVEL',
        negocios: 1,
      }),
    ]);
    await desligar(ana.id).expect(200);
    expect(await responsavel(outroDoCs.id)).toBe(comercial.cLevel.id);
  });

  it('R7.3/R5.13 — a varredura final (negócio que chegou depois da divisão) segue a mesma divisão por funil', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const cs = await criarEquipe(t, 'CS', {
      membros: 0,
      cLevel: comercial.cLevel,
    });
    const [pedro] = comercial.membros;
    const funilCs = await funilBase(t, 'CS');
    await comoAdmin
      .put(`/api/v1/funis/${funilCs.id}/acessos`, {
        acessos: [{ usuarioId: pedro.id, nivel: 'MEMBRO' }],
      })
      .expect(200);
    const doComercial = await criarNegocio(t, {
      area: 'COMERCIAL',
      responsavel: pedro,
    });
    const doCs = await criarNegocio(t, { area: 'CS', responsavel: pedro });
    // A divisão do plano não vê nenhum negócio: todos "chegam depois" dela.
    const servico = t.get(DesligamentoService) as unknown as {
      dividirNegocios: (...argumentos: unknown[]) => Promise<unknown[]>;
    };
    const espiao = jest
      .spyOn(servico, 'dividirNegocios')
      .mockResolvedValueOnce([]);
    try {
      const resposta = await desligar(pedro.id).expect(200);
      expect(espiao).toHaveBeenCalledTimes(2);
      expect(resposta.body.contagens.negocios).toBe(2);
      expect(resposta.body.divisaoDosNegocios).toEqual([
        expect.objectContaining({
          destinatario: expect.objectContaining({ id: comercial.lider.id }),
          motivo: 'DESTINATARIO',
          negocios: 1,
        }),
        expect.objectContaining({
          destinatario: expect.objectContaining({ id: cs.lider.id }),
          motivo: 'LIDER_DO_SETOR_DO_FUNIL',
          negocios: 1,
        }),
      ]);
    } finally {
      espiao.mockRestore();
    }
    const responsavel = async (id: string) =>
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id } }))
        .responsavelId;
    expect(await responsavel(doComercial.id)).toBe(comercial.lider.id);
    expect(await responsavel(doCs.id)).toBe(cs.lider.id);
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'negocio.encaminhado', entidadeId: doCs.id },
    });
    expect(auditoria.dados).toMatchObject({
      motivoDaParte: 'LIDER_DO_SETOR_DO_FUNIL',
      regra: 'R5.13',
    });
    const avisoCs = await t.prisma.notificacao.findFirstOrThrow({
      where: {
        usuarioId: cs.lider.id,
        tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
      },
    });
    expect(avisoCs.texto).toContain('1 negócio');
  });

  it('R7.3 — invalida os links de senha pendentes e não mexe em itens excluídos', async () => {
    const { lider, membros } = await criarEquipe(t, 'CS', { membros: 1 });
    const [membro] = membros;
    await comoAdmin.post(`/api/v1/usuarios/${membro.id}/convite`).expect(202);
    const token = t.email.tokenDoUltimo(membro.email);
    const excluido = await criarContato(t, { responsavel: membro });
    await t.prisma.contato.update({
      where: { id: excluido.id },
      data: { excluidoEm: new Date() },
    });

    const resposta = await desligar(membro.id).expect(200);
    expect(resposta.body.contagens.contatos).toBe(0);
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: excluido.id } }))
        .responsavelId,
    ).toBe(membro.id);
    expect(
      (
        await t.prisma.tokenSenha.findFirstOrThrow({
          where: { usuarioId: membro.id },
        })
      ).invalidadoEm,
    ).not.toBeNull();
    // Sem nada para receber, o destinatário não é notificado.
    expect(
      await t.prisma.notificacao.count({ where: { usuarioId: lider.id } }),
    ).toBe(0);

    // Mesmo depois de reativado, o link antigo não volta a valer.
    await comoAdmin
      .post(`/api/v1/usuarios/${membro.id}/reativar`, { liderId: lider.id })
      .expect(200);
    const consulta = await comoAdmin
      .post('/api/v1/auth/senha/token', { token })
      .expect(200);
    expect(consulta.body).toEqual({ valido: false });
  });

  it('R7.3 — tudo numa transação: se algo falha no meio, nada muda', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const contato = await criarContato(t, { responsavel: membro });
    // Um gatilho de teste faz a gravação da notificação falhar no fim.
    await t.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION teste_falhar_notificacao() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha de teste'; END; $$`);
    await t.prisma.$executeRawUnsafe(`
      CREATE TRIGGER teste_falhar_notificacao BEFORE INSERT ON notificacoes
      FOR EACH ROW EXECUTE FUNCTION teste_falhar_notificacao()`);
    try {
      await desligar(membro.id).expect(500);
    } finally {
      await t.prisma.$executeRawUnsafe(
        'DROP TRIGGER teste_falhar_notificacao ON notificacoes',
      );
      await t.prisma.$executeRawUnsafe(
        'DROP FUNCTION teste_falhar_notificacao()',
      );
    }
    expect(
      await t.prisma.usuario.findUniqueOrThrow({ where: { id: membro.id } }),
    ).toMatchObject({ ativo: true, desligadoEm: null });
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(membro.id);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: { in: ['usuario.desligado', 'contato.encaminhado'] } },
      }),
    ).toBe(0);
    expect(await t.prisma.eventoDominio.count()).toBe(0);
    await desligar(membro.id).expect(200);
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }))
        .responsavelId,
    ).toBe(lider.id);
  });

  it('R7.3 — deadlock com outra transação: o desligamento é repetido e conclui inteiro', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const contato = await criarContato(t, { responsavel: membro });
    let pedido: Promise<Response> | undefined;
    // Como um webhook reconvertendo o contato: trava o contato do desligado e
    // depois o rodízio — a ordem inversa da do desligamento.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE contatos SET cargo = 'reconvertido' WHERE id = ${contato.id}::uuid`;
      pedido = desligar(membro.id).then((resposta) => resposta);
      await esperarAte(async () => {
        const [{ esperando }] = await t.prisma.$queryRaw<
          { esperando: number }[]
        >`SELECT count(*)::int AS esperando FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return esperando > 0;
      });
      await tx.$queryRaw`SELECT id FROM regras_distribuicao ORDER BY area FOR UPDATE`;
    });

    const resposta = await pedido;
    expect(resposta?.status).toBe(200);
    // As duas transações valeram: a do "webhook" e o desligamento repetido.
    expect(
      await t.prisma.contato.findUniqueOrThrow({ where: { id: contato.id } }),
    ).toMatchObject({ cargo: 'reconvertido', responsavelId: lider.id });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.desligado' },
      }),
    ).toBe(1);
  });

  it('R7.3 — desligamento com muitos itens termina dentro do prazo da transação', async () => {
    const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    const [membro] = membros;
    const quantidade = 1_500;
    await t.prisma.contato.createMany({
      data: Array.from({ length: quantidade }, (_valor, indice) => ({
        nome: `Contato em massa ${indice}`,
        email: `massa-${indice}@teste.local`,
        responsavelId: membro.id,
      })),
    });
    await t.prisma.atividade.createMany({
      data: Array.from({ length: 500 }, (_valor, indice) => ({
        tipo: 'TAREFA' as const,
        titulo: `Tarefa ${indice}`,
        responsavelId: membro.id,
      })),
    });

    const inicio = Date.now();
    const resposta = await desligar(membro.id).expect(200);
    const duracaoMs = Date.now() - inicio;
    expect(resposta.body.contagens).toMatchObject({
      contatos: quantidade,
      atividades: 500,
    });
    expect(
      await t.prisma.contato.count({ where: { responsavelId: lider.id } }),
    ).toBe(quantidade);
    expect(duracaoMs).toBeLessThan(15_000);
  });
});

/** Espera `condicao` ficar verdadeira (consultando a cada 25 ms), até `prazoMs`. */
async function esperarAte(
  condicao: () => Promise<boolean>,
  prazoMs = 5_000,
): Promise<void> {
  const limite = Date.now() + prazoMs;
  while (!(await condicao())) {
    if (Date.now() > limite) {
      throw new Error('a condição esperada não aconteceu a tempo');
    }
    await new Promise((resolver) => setTimeout(resolver, 25));
  }
}
