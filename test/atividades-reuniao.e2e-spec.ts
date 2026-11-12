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
});
