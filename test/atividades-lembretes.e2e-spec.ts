import {
  AGENDA_DOS_LEMBRETES,
  FILA_LEMBRETES_DE_ATIVIDADES,
  LembretesAtividadesService,
} from '../src/atividades/lembretes-atividades.service';
import type { Usuario } from '../src/generated/prisma/client';
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import {
  type AppTeste,
  criarAppTeste,
  criarAtividade,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
} from './utils';

const minutos = (quantidade: number) =>
  new Date(Date.now() + quantidade * 60_000);
const iso = (data: Date) => data.toISOString();

describe('Atividades — lembretes (e2e)', () => {
  let t: AppTeste;
  let lembretes: LembretesAtividadesService;

  beforeAll(async () => {
    t = await criarAppTeste();
    lembretes = t.get(LembretesAtividadesService);
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  const notificacoesDe = (usuario: Usuario) =>
    t.prisma.notificacao.findMany({
      where: { usuarioId: usuario.id },
      orderBy: { criadoEm: 'asc' },
    });

  it('R6.5 — avisa o responsável 1 hora antes do vencimento, uma única vez', async () => {
    const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
    const proxima = await criarAtividade(t, {
      responsavel: ana,
      tipo: 'EMAIL',
      titulo: 'Enviar proposta',
      venceEm: minutos(40),
    });
    const depois = await criarAtividade(t, {
      responsavel: ana,
      venceEm: minutos(90),
    });

    expect(await lembretes.executar()).toEqual({ vencendo: 1, atrasadas: 0 });
    const [notificacao, ...outras] = await notificacoesDe(ana);
    expect(outras).toEqual([]);
    expect(notificacao).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
      titulo: 'Atividade vencendo',
      link: `/atividades?atividade=${proxima.id}`,
      dados: {
        atividadeId: proxima.id,
        tipo: 'EMAIL',
        venceEm: iso(proxima.venceEm as Date),
      },
      lidaEm: null,
    });
    expect(notificacao.texto).toMatch(
      /^O e-mail "Enviar proposta" vence (às|em) .*\d{2}:\d{2}\.$/,
    );
    const marcada = await t.prisma.atividade.findUniqueOrThrow({
      where: { id: proxima.id },
    });
    expect(marcada.lembreteEnviadoEm).not.toBeNull();
    // O marcador é controle do job: não muda `atualizadoEm` nem passa pela auditoria.
    expect(marcada.atualizadoEm).toEqual(proxima.atualizadoEm);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { entidade: 'atividade' },
      }),
    ).toBe(0);

    // A execução seguinte não repete.
    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 0 });
    // 35 minutos depois, a de 90 minutos entra na janela de 1 hora.
    expect(await lembretes.executar(minutos(35))).toEqual({
      vencendo: 1,
      atrasadas: 0,
    });
    const notificacoes = await notificacoesDe(ana);
    expect(notificacoes.map(({ dados }) => dados)).toEqual([
      expect.objectContaining({ atividadeId: proxima.id }),
      expect.objectContaining({ atividadeId: depois.id }),
    ]);
  });

  it('R6.5 — avisa uma única vez quando a atividade atrasa', async () => {
    const ana = await criarUsuario(t, { papel: 'CS' });
    const vencida = await criarAtividade(t, {
      responsavel: ana,
      tipo: 'LIGACAO',
      titulo: 'Retornar a Maria',
      venceEm: minutos(-10),
    });

    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 1 });
    const [notificacao] = await notificacoesDe(ana);
    expect(notificacao).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
      titulo: 'Atividade atrasada',
      link: `/atividades?atividade=${vencida.id}`,
    });
    expect(notificacao.texto).toMatch(
      /^A ligação "Retornar a Maria" venceu (às|em) .* e continua pendente\.$/,
    );
    expect(
      (
        await t.prisma.atividade.findUniqueOrThrow({
          where: { id: vencida.id },
        })
      ).atrasoNotificadoEm,
    ).not.toBeNull();

    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 0 });
    expect(await lembretes.executar(minutos(600))).toEqual({
      vencendo: 0,
      atrasadas: 0,
    });
    expect(await notificacoesDe(ana)).toHaveLength(1);
  });

  it('R6.5 — reunião: o lembrete sai 1 hora antes do início; o atraso, só depois do fim', async () => {
    const ana = await criarUsuario(t, { papel: 'MARKETING' });
    const cliente = await entrarComo(t, ana);
    const criada = await cliente
      .post('/api/v1/atividades', {
        tipo: 'REUNIAO',
        titulo: 'Apresentação ACME',
        inicioEm: iso(minutos(30)),
        fimEm: iso(minutos(90)),
      })
      .expect(201);

    expect(await lembretes.executar()).toEqual({ vencendo: 1, atrasadas: 0 });
    expect((await notificacoesDe(ana))[0]).toMatchObject({
      titulo: 'Reunião em breve',
      texto: expect.stringMatching(/^A reunião "Apresentação ACME" começa /),
    });
    // Em andamento: não está atrasada.
    expect(await lembretes.executar(minutos(60))).toEqual({
      vencendo: 0,
      atrasadas: 0,
    });
    // Terminou e continua pendente: atrasada, uma vez.
    expect(await lembretes.executar(minutos(100))).toEqual({
      vencendo: 0,
      atrasadas: 1,
    });
    const notificacoes = await notificacoesDe(ana);
    expect(notificacoes).toHaveLength(2);
    expect(notificacoes[1]).toMatchObject({
      tipo: TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
      texto: expect.stringMatching(
        /^A reunião "Apresentação ACME" terminou .* e continua pendente\.$/,
      ),
      dados: expect.objectContaining({ atividadeId: criada.body.id }),
    });
  });

  it('R6.5 — ficam de fora: concluídas, canceladas, notas, sem data e as de responsável desligado', async () => {
    const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
    const desligado = await criarUsuario(t, {
      papel: 'COMERCIAL',
      ativo: false,
    });
    for (const venceEm of [minutos(-30), minutos(30)]) {
      await criarAtividade(t, {
        responsavel: ana,
        venceEm,
        status: 'CONCLUIDA',
      });
      await criarAtividade(t, {
        responsavel: ana,
        venceEm,
        status: 'CANCELADA',
      });
      await criarAtividade(t, { responsavel: desligado, venceEm });
    }
    await criarAtividade(t, { responsavel: ana, tipo: 'NOTA' });
    await criarAtividade(t, { responsavel: ana });

    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 0 });
    expect(await t.prisma.notificacao.count()).toBe(0);
  });

  it('R6.5 — duas execuções ao mesmo tempo não notificam a mesma atividade duas vezes', async () => {
    const ana = await criarUsuario(t, { papel: 'CS' });
    for (let indice = 0; indice < 6; indice++) {
      await criarAtividade(t, {
        responsavel: ana,
        venceEm: minutos(-5 - indice),
      });
      await criarAtividade(t, {
        responsavel: ana,
        venceEm: minutos(10 + indice),
      });
    }

    const resultados = await Promise.all([
      lembretes.executar(),
      lembretes.executar(),
      lembretes.executar(),
    ]);
    const soma = resultados.reduce(
      (total, resultado) => ({
        vencendo: total.vencendo + resultado.vencendo,
        atrasadas: total.atrasadas + resultado.atrasadas,
      }),
      { vencendo: 0, atrasadas: 0 },
    );
    expect(soma).toEqual({ vencendo: 6, atrasadas: 6 });
    const notificacoes = await notificacoesDe(ana);
    expect(notificacoes).toHaveLength(12);
    const porAtividadeETipo = new Set(
      notificacoes.map(
        ({ tipo, dados }) =>
          `${tipo}:${(dados as { atividadeId: string }).atividadeId}`,
      ),
    );
    expect(porAtividadeETipo.size).toBe(12);
  });

  it('R6.5 — processa em lotes: mais de 200 atrasadas saem todas na mesma execução', async () => {
    const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
    const venceEm = minutos(-20);
    await t.prisma.atividade.createMany({
      data: Array.from({ length: 205 }, (_, indice) => ({
        tipo: 'TAREFA' as const,
        titulo: `Tarefa ${indice}`,
        responsavelId: ana.id,
        criadoPorId: ana.id,
        venceEm,
      })),
    });

    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 205 });
    expect(
      await t.prisma.notificacao.count({ where: { usuarioId: ana.id } }),
    ).toBe(205);
    expect(
      await t.prisma.atividade.count({ where: { atrasoNotificadoEm: null } }),
    ).toBe(0);
  });

  it('R6.5 / R7.3 — quem recebe a atividade por desligamento depois do lembrete recebe o seu', async () => {
    const {
      lider,
      membros: [pedro],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const atividade = await criarAtividade(t, {
      responsavel: pedro,
      venceEm: minutos(30),
    });
    expect(await lembretes.executar()).toEqual({ vencendo: 1, atrasadas: 0 });
    const { lembreteEnviadoEm } = await t.prisma.atividade.findUniqueOrThrow({
      where: { id: atividade.id },
    });

    // O desligamento (R7.3) passa a atividade ao líder e guarda de quem veio.
    await t.prisma.usuario.update({
      where: { id: pedro.id },
      data: { ativo: false, desligadoEm: new Date() },
    });
    await t.prisma.atividade.update({
      where: { id: atividade.id },
      data: {
        responsavelId: lider.id,
        encaminhadaDeId: pedro.id,
        encaminhadaEm: new Date((lembreteEnviadoEm as Date).getTime() + 1),
      },
    });

    expect(await lembretes.executar()).toEqual({ vencendo: 1, atrasadas: 0 });
    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 0 });
    expect(await notificacoesDe(pedro)).toHaveLength(1);
    expect(await notificacoesDe(lider)).toEqual([
      expect.objectContaining({
        tipo: TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
        dados: expect.objectContaining({ atividadeId: atividade.id }),
      }),
    ]);
  });

  it('R6.5 — reagendar para o futuro ou trocar o responsável rearma os avisos', async () => {
    const {
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL');
    const cliente = await entrarComo(t, ana);
    const atividade = await criarAtividade(t, {
      responsavel: ana,
      venceEm: minutos(-10),
    });
    const rota = `/api/v1/atividades/${atividade.id}`;
    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 1 });

    // Reagendada para daqui a 30 min: lembrete agora e, se atrasar de novo, novo aviso.
    await cliente.patch(rota, { venceEm: iso(minutos(30)) }).expect(200);
    expect(await lembretes.executar()).toEqual({ vencendo: 1, atrasadas: 0 });
    expect(await lembretes.executar(minutos(45))).toEqual({
      vencendo: 0,
      atrasadas: 1,
    });

    // Para daqui a 3 horas: o lembrete volta a valer, mas só perto da hora.
    await cliente.patch(rota, { venceEm: iso(minutos(180)) }).expect(200);
    expect(await lembretes.executar()).toEqual({ vencendo: 0, atrasadas: 0 });
    expect(await lembretes.executar(minutos(150))).toEqual({
      vencendo: 1,
      atrasadas: 0,
    });

    // Outro responsável: ele recebe o lembrete dele.
    await cliente.patch(rota, { responsavelId: bruno.id }).expect(200);
    expect(await lembretes.executar(minutos(150))).toEqual({
      vencendo: 1,
      atrasadas: 0,
    });
    expect((await notificacoesDe(ana)).map(({ tipo }) => tipo)).toEqual([
      TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
      TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
      TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA,
      TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
    ]);
    expect((await notificacoesDe(bruno)).map(({ tipo }) => tipo)).toEqual([
      TIPOS_NOTIFICACAO.ATIVIDADE_VENCENDO,
    ]);
  });

  it('R6.5 — o job roda pela fila atividades.lembretes', async () => {
    const ana = await criarUsuario(t, { papel: 'CS' });
    await criarAtividade(t, { responsavel: ana, venceEm: minutos(-1) });

    await t.fila.enviar(FILA_LEMBRETES_DE_ATIVIDADES, {});
    expect(await drenarFilas(t, FILA_LEMBRETES_DE_ATIVIDADES)).toBe(1);
    expect(await notificacoesDe(ana)).toEqual([
      expect.objectContaining({ tipo: TIPOS_NOTIFICACAO.ATIVIDADE_ATRASADA }),
    ]);
  });

  it('R6.5 — com as filas ligadas, o job fica agendado a cada 15 minutos no fuso de São Paulo', async () => {
    const comFilas = await criarAppTeste({
      variaveis: { PROCESSAR_FILAS: 'true' },
      limpar: false,
    });
    try {
      const agendamentos = await comFilas.prisma.$queryRaw<
        { name: string; cron: string; timezone: string }[]
      >`SELECT name, cron, timezone FROM pgboss.schedule WHERE name = ${FILA_LEMBRETES_DE_ATIVIDADES}`;
      expect(agendamentos).toEqual([
        {
          name: FILA_LEMBRETES_DE_ATIVIDADES,
          cron: AGENDA_DOS_LEMBRETES,
          timezone: 'America/Sao_Paulo',
        },
      ]);
    } finally {
      await comFilas.fechar();
    }
  });
});
