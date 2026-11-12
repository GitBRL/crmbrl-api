import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  entrarComo,
} from './utils';

const URL = '/api/v1/atividades';
const horas = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

/** R6.6 — resultado da reunião: concluir, remarcar, corrigir, reabrir e filtros. */
describe('Atividades — resultado da reunião (e2e)', () => {
  let t: AppTeste;
  let ana: Usuario;
  let cliente: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    const equipe = await criarEquipe(t, 'COMERCIAL');
    ana = equipe.membros[0]!;
    cliente = await entrarComo(t, ana);
  });
  afterAll(() => t.fechar());

  async function novaReuniao(
    extra: Record<string, unknown> = {},
    inicio = horas(2),
  ) {
    const resposta = await cliente
      .post(URL, {
        tipo: 'REUNIAO',
        titulo: 'Apresentação',
        inicioEm: inicio,
        fimEm: new Date(new Date(inicio).getTime() + 3_600_000).toISOString(),
        ...extra,
      })
      .expect(201);
    return resposta.body as { id: string };
  }

  it('R6.6 — reunião concluída por pessoa exige resultado (400 no campo)', async () => {
    const { id } = await novaReuniao();
    const resposta = await cliente.post(`${URL}/${id}/concluir`).expect(400);
    expect(JSON.stringify(resposta.body.detalhes)).toContain(
      'resultadoReuniao',
    );
    expect(
      (await t.prisma.atividade.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PENDENTE');
  });

  it.each(['COMPARECEU', 'NAO_COMPARECEU'])(
    'R6.6 — conclui com %s, grava o resultado e o leva no evento',
    async (resultado) => {
      const { id } = await novaReuniao();
      const resposta = await cliente
        .post(`${URL}/${id}/concluir`, { resultadoReuniao: resultado })
        .expect(200);
      expect(resposta.body).toMatchObject({
        status: 'CONCLUIDA',
        resultadoReuniao: resultado,
        remarcadaDeId: null,
        aguardandoResultado: false,
      });
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'atividade.concluida' },
      });
      expect(evento.dados).toMatchObject({ resultadoReuniao: resultado });
    },
  );

  it('R6.6 — novaData só vale com REMARCADA e resultado é recusado em outros tipos', async () => {
    const { id } = await novaReuniao();
    await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'COMPARECEU',
        novaData: horas(48),
      })
      .expect(400);
    const tarefa = await cliente
      .post(URL, { tipo: 'TAREFA', titulo: 'Ligar', venceEm: horas(3) })
      .expect(201);
    await cliente
      .post(`${URL}/${tarefa.body.id}/concluir`, {
        resultadoReuniao: 'COMPARECEU',
      })
      .expect(400);
    await cliente.post(`${URL}/${tarefa.body.id}/concluir`).expect(200);
  });

  it('R6.6 — REMARCADA exige novaData futura e cria a nova reunião pendente na mesma transação', async () => {
    const contato = await criarContato(t);
    const negocio = await criarNegocio(t, { contato, responsavel: ana });
    const { id } = await novaReuniao({
      negocioId: negocio.id,
      descricao: 'Levar a proposta',
    });
    await cliente
      .post(`${URL}/${id}/concluir`, { resultadoReuniao: 'REMARCADA' })
      .expect(400);
    await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(-1),
      })
      .expect(400);
    expect(await t.prisma.atividade.count()).toBe(1);

    const novaData = horas(72);
    const resposta = await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData,
      })
      .expect(200);
    expect(resposta.body).toMatchObject({
      status: 'CONCLUIDA',
      resultadoReuniao: 'REMARCADA',
    });
    const nova = await t.prisma.atividade.findFirstOrThrow({
      where: { remarcadaDeId: id },
    });
    expect(nova).toMatchObject({
      tipo: 'REUNIAO',
      status: 'PENDENTE',
      titulo: 'Apresentação',
      descricao: 'Levar a proposta',
      responsavelId: ana.id,
      negocioId: negocio.id,
      contatoId: contato.id,
      resultadoReuniao: null,
    });
    expect(nova.inicioEm?.toISOString()).toBe(novaData);
    expect(nova.fimEm!.getTime() - nova.inicioEm!.getTime()).toBe(3_600_000);
    const detalhe = await cliente.get(`${URL}/${nova.id}`).expect(200);
    expect(detalhe.body.remarcadaDeId).toBe(id);
  });

  it('R6.6 — corrige o resultado (auditado) e reabrir apaga o resultado, mantendo a remarcada criada', async () => {
    const { id } = await novaReuniao();
    await cliente
      .post(`${URL}/${id}/concluir`, { resultadoReuniao: 'NAO_COMPARECEU' })
      .expect(200);
    const corrigida = await cliente
      .patch(`${URL}/${id}`, { resultadoReuniao: 'COMPARECEU' })
      .expect(200);
    expect(corrigida.body.resultadoReuniao).toBe('COMPARECEU');
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'atividade.atualizada', entidadeId: id },
    });
    expect(JSON.stringify(auditoria.dados)).toContain('resultadoReuniao');
    await cliente
      .patch(`${URL}/${id}`, { resultadoReuniao: 'REMARCADA' })
      .expect(400);
    const remarcada = await cliente
      .patch(`${URL}/${id}`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(96),
      })
      .expect(200);
    expect(remarcada.body.resultadoReuniao).toBe('REMARCADA');
    expect(
      await t.prisma.atividade.count({ where: { remarcadaDeId: id } }),
    ).toBe(1);
    const reaberta = await cliente.post(`${URL}/${id}/reabrir`).expect(200);
    expect(reaberta.body).toMatchObject({
      status: 'PENDENTE',
      resultadoReuniao: null,
    });
    expect(
      await t.prisma.atividade.count({ where: { remarcadaDeId: id } }),
    ).toBe(1);
  });

  it('R6.6 — corrigir o resultado só vale numa reunião concluída', async () => {
    const { id } = await novaReuniao();
    await cliente
      .patch(`${URL}/${id}`, { resultadoReuniao: 'COMPARECEU' })
      .expect(400);
  });

  it('R6.6 — aguardandoResultado: reunião pendente com início no passado; filtros por resultado', async () => {
    const passada = await novaReuniao({ titulo: 'Passada' }, horas(-3));
    const futura = await novaReuniao({ titulo: 'Futura' }, horas(5));
    const feita = await novaReuniao({ titulo: 'Feita' }, horas(7));
    await cliente
      .post(`${URL}/${feita.id}/concluir`, { resultadoReuniao: 'COMPARECEU' })
      .expect(200);
    const sem = await novaReuniao(
      { titulo: 'Concluída sem resultado' },
      horas(9),
    );
    await t.prisma.atividade.update({
      where: { id: sem.id },
      data: { status: 'CONCLUIDA', concluidaEm: new Date() },
    });
    const ids = (corpo: { itens: Array<{ id: string }> }) =>
      corpo.itens.map((i) => i.id).sort();
    const consultar = async (query: Record<string, string>) =>
      ids(
        (
          await cliente
            .get(URL)
            .query({ porPagina: 50, ...query })
            .expect(200)
        ).body,
      );

    const aguardando = await cliente
      .get(URL)
      .query({ aguardandoResultado: 'true' })
      .expect(200);
    expect(ids(aguardando.body)).toEqual([passada.id]);
    expect(aguardando.body.itens[0]).toMatchObject({
      aguardandoResultado: true,
    });
    expect(await consultar({ aguardandoResultado: 'false' })).toEqual(
      [futura.id, feita.id, sem.id].sort(),
    );
    expect(await consultar({ resultadoReuniao: 'COMPARECEU' })).toEqual([
      feita.id,
    ]);
    expect(await consultar({ resultadoReuniao: 'SEM_RESULTADO' })).toEqual(
      [passada.id, futura.id, sem.id].sort(),
    );
    expect(
      await consultar({ resultadoReuniao: 'NAO_COMPARECEU,REMARCADA' }),
    ).toEqual([]);
    await cliente.get(URL).query({ resultadoReuniao: 'XPTO' }).expect(400);
  });

  it('R6.6 — criar reunião já concluída exige o resultado (400 no campo); com ele, grava (e REMARCADA cria a nova)', async () => {
    const inicio = horas(-2);
    const base = {
      tipo: 'REUNIAO',
      titulo: 'Já aconteceu',
      inicioEm: inicio,
      fimEm: new Date(new Date(inicio).getTime() + 3_600_000).toISOString(),
      concluida: true,
    };
    const sem = await cliente.post(URL, base).expect(400);
    expect(JSON.stringify(sem.body.detalhes)).toContain('resultadoReuniao');
    expect(await t.prisma.atividade.count()).toBe(0);
    const ok = await cliente
      .post(URL, { ...base, resultadoReuniao: 'COMPARECEU' })
      .expect(201);
    expect(ok.body).toMatchObject({
      status: 'CONCLUIDA',
      resultadoReuniao: 'COMPARECEU',
    });
    const remarcada = await cliente
      .post(URL, {
        ...base,
        resultadoReuniao: 'REMARCADA',
        novaData: horas(48),
      })
      .expect(201);
    expect(
      await t.prisma.atividade.count({
        where: { remarcadaDeId: remarcada.body.id },
      }),
    ).toBe(1);
    // Fora da reunião concluída, o resultado é recusado.
    await cliente
      .post(URL, {
        tipo: 'TAREFA',
        titulo: 'Tarefa',
        venceEm: horas(5),
        resultadoReuniao: 'COMPARECEU',
      })
      .expect(400);
    await cliente
      .post(URL, { ...base, concluida: false, resultadoReuniao: 'COMPARECEU' })
      .expect(400);
  });

  it('R6.6 — trocar o tipo de uma reunião concluída limpa o resultado; uma concluída vira reunião só com resultado', async () => {
    const { id } = await novaReuniao();
    await cliente
      .post(`${URL}/${id}/concluir`, { resultadoReuniao: 'COMPARECEU' })
      .expect(200);
    const virou = await cliente
      .patch(`${URL}/${id}`, { tipo: 'LIGACAO', venceEm: horas(5) })
      .expect(200);
    expect(virou.body).toMatchObject({
      tipo: 'LIGACAO',
      resultadoReuniao: null,
    });
    // O caminho inverso: concluída → reunião sem resultado é recusada.
    const datas = { inicioEm: horas(-2), fimEm: horas(-1) };
    const sem = await cliente
      .patch(`${URL}/${id}`, { tipo: 'REUNIAO', ...datas })
      .expect(400);
    expect(JSON.stringify(sem.body.detalhes)).toContain('resultadoReuniao');
    const com = await cliente
      .patch(`${URL}/${id}`, {
        tipo: 'REUNIAO',
        ...datas,
        resultadoReuniao: 'NAO_COMPARECEU',
      })
      .expect(200);
    expect(com.body).toMatchObject({
      tipo: 'REUNIAO',
      resultadoReuniao: 'NAO_COMPARECEU',
    });
  });

  it('R6.6 — REMARCADA → COMPARECEU → REMARCADA não cria uma segunda remarcada: move a primeira', async () => {
    const { id } = await novaReuniao();
    await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(48),
      })
      .expect(200);
    await cliente
      .patch(`${URL}/${id}`, { resultadoReuniao: 'COMPARECEU' })
      .expect(200);
    const novaData = horas(96);
    await cliente
      .patch(`${URL}/${id}`, { resultadoReuniao: 'REMARCADA', novaData })
      .expect(200);
    const remarcadas = await t.prisma.atividade.findMany({
      where: { remarcadaDeId: id },
    });
    expect(remarcadas).toHaveLength(1);
    expect(remarcadas[0].inicioEm?.toISOString()).toBe(
      new Date(novaData).toISOString(),
    );
  });

  it('R6.6 — REMARCADA → REMARCADA com outra data move a reunião remarcada; concluída, recusa (409)', async () => {
    const { id } = await novaReuniao();
    await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(48),
      })
      .expect(200);
    const outraData = horas(120);
    await cliente
      .patch(`${URL}/${id}`, {
        resultadoReuniao: 'REMARCADA',
        novaData: outraData,
      })
      .expect(200);
    const unica = await t.prisma.atividade.findFirstOrThrow({
      where: { remarcadaDeId: id },
    });
    expect(unica.inicioEm?.toISOString()).toBe(
      new Date(outraData).toISOString(),
    );
    expect(unica.fimEm!.getTime() - unica.inicioEm!.getTime()).toBe(3_600_000);
    expect(
      await t.prisma.atividade.count({ where: { remarcadaDeId: id } }),
    ).toBe(1);
    // A remarcada já foi concluída: não dá para remarcar a origem de novo.
    await t.prisma.atividade.update({
      where: { id: unica.id },
      data: { status: 'CONCLUIDA', concluidaEm: new Date() },
    });
    const conflito = await cliente
      .patch(`${URL}/${id}`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(150),
      })
      .expect(409);
    expect(conflito.body.mensagem).toMatch(/remarcada/);
    // Reabrir a origem e concluir como REMARCADA de novo também não duplica.
    await t.prisma.atividade.update({
      where: { id: unica.id },
      data: { status: 'PENDENTE', concluidaEm: null },
    });
    await cliente.post(`${URL}/${id}/reabrir`).expect(200);
    await cliente
      .post(`${URL}/${id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(200),
      })
      .expect(200);
    expect(
      await t.prisma.atividade.count({ where: { remarcadaDeId: id } }),
    ).toBe(1);
  });
});
