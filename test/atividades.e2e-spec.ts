import { randomUUID } from 'node:crypto';
import { dataLocal, limitesDoCalendario } from '../src/atividades/fuso-horario';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
} from './utils';

const URL = '/api/v1/atividades';

const horas = (quantidade: number) =>
  new Date(Date.now() + quantidade * 3_600_000);
const iso = (data: Date) => data.toISOString();

interface AtividadeResposta {
  id: string;
  tipo: string;
  titulo: string;
  status: string;
  atrasada: boolean;
  grupo: string | null;
  [campo: string]: unknown;
}

function ids(itens: readonly { id: string }[]): string[] {
  return itens.map(({ id }) => id).sort();
}

/**
 * Um fuso em que agora é dia claro (das 6h às 17h), para os agrupamentos não
 * dependerem da hora em que o teste roda: "daqui a 1 hora" ainda é hoje.
 */
function fusoComDiaClaro(): string {
  const candidatos = [
    'America/Sao_Paulo',
    'Europe/London',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Kiritimati',
    'Pacific/Honolulu',
    'America/New_York',
  ];
  const fuso = candidatos.find((candidato) => {
    const { hora } = dataLocal(new Date(), candidato);
    return hora >= 6 && hora < 17;
  });
  if (!fuso) {
    throw new Error('Nenhum fuso candidato está em horário de dia claro.');
  }
  return fuso;
}

describe('Atividades (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  async function listar(
    cliente: ClienteHttp,
    query: Record<string, string | number | boolean | string[]> = {},
  ): Promise<AtividadeResposta[]> {
    const resposta = await cliente
      .get(URL)
      .query({ porPagina: 100, ...query })
      .expect(200);
    return resposta.body.itens as AtividadeResposta[];
  }

  async function eventosDaOutbox() {
    return t.prisma.eventoDominio.findMany({
      where: { tipo: { startsWith: 'atividade.' } },
      orderBy: { criadoEm: 'asc' },
    });
  }

  describe('R6.1 — tipos, datas e vínculos', () => {
    it('R6.1 — cria tarefa com vencimento ligada a contato, empresa e negócio; R6.2 — o responsável padrão é quem criou', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL');
      const empresa = await criarEmpresa(t, { nome: 'ACME' });
      const contato = await criarContato(t, { nome: 'Maria', empresa });
      const negocio = await criarNegocio(t, {
        contato,
        empresa,
        responsavel: ana,
        titulo: 'ACME anual',
      });
      const cliente = await entrarComo(t, ana);
      const vence = horas(5);

      const resposta = await cliente
        .post(URL, {
          tipo: 'TAREFA',
          titulo: '  Enviar proposta  ',
          descricao: 'Com o desconto combinado',
          venceEm: iso(vence),
          prioridade: 'ALTA',
          contatoId: contato.id,
          empresaId: empresa.id,
          negocioId: negocio.id,
        })
        .expect(201);
      const id = resposta.body.id as string;
      expect(resposta.body).toMatchObject({
        tipo: 'TAREFA',
        titulo: 'Enviar proposta',
        descricao: 'Com o desconto combinado',
        status: 'PENDENTE',
        prioridade: 'ALTA',
        venceEm: iso(vence),
        inicioEm: null,
        fimEm: null,
        atrasada: false,
        responsavel: { id: ana.id, nome: ana.nome },
        criadoPor: { id: ana.id },
        concluidaEm: null,
        concluidaPor: null,
        contato: { id: contato.id, nome: 'Maria' },
        empresa: { id: empresa.id, nome: 'ACME' },
        negocio: {
          id: negocio.id,
          titulo: 'ACME anual',
          funilId: negocio.funilId,
        },
        encaminhadaDe: null,
        encaminhadaEm: null,
      });

      // R3.1 — auditoria na mesma transação, ligada ao contato, à empresa e ao negócio (R3.5).
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.criada' },
      });
      expect(auditoria).toMatchObject({
        entidade: 'atividade',
        entidadeId: id,
        tipoAtor: 'USUARIO',
        usuarioId: ana.id,
        resumo: `Tarefa "Enviar proposta" criada para ${ana.nome}`,
      });
      expect(auditoria.relacionados).toEqual(
        expect.arrayContaining([
          `atividade:${id}`,
          `contato:${contato.id}`,
          `empresa:${empresa.id}`,
          `negocio:${negocio.id}`,
        ]),
      );

      // R10.1 / R9.2 — atividade.criada na outbox.
      const eventos = await eventosDaOutbox();
      expect(eventos.map(({ tipo }) => tipo)).toEqual(['atividade.criada']);
      expect(eventos[0].dados).toMatchObject({
        atividadeId: id,
        tipo: 'TAREFA',
        status: 'PENDENTE',
        venceEm: iso(vence),
        responsavelId: ana.id,
        criadoPorId: ana.id,
        contatoId: contato.id,
        empresaId: empresa.id,
        negocioId: negocio.id,
      });

      const detalhe = await cliente.get(`${URL}/${id}`).expect(200);
      expect(detalhe.body).toEqual(resposta.body);
    });

    it('R6.1 — reunião exige início e fim, com o fim depois do início; o vencimento acompanha o início', async () => {
      const usuario = await criarUsuario(t, { papel: 'CS' });
      const cliente = await entrarComo(t, usuario);
      const inicio = horas(24);
      const fim = horas(25);

      const criada = await cliente
        .post(URL, {
          tipo: 'REUNIAO',
          titulo: 'Kickoff',
          inicioEm: iso(inicio),
          fimEm: iso(fim),
        })
        .expect(201);
      expect(criada.body).toMatchObject({
        tipo: 'REUNIAO',
        venceEm: iso(inicio),
        inicioEm: iso(inicio),
        fimEm: iso(fim),
        grupo: expect.any(String),
      });

      const semFim = await cliente
        .post(URL, { tipo: 'REUNIAO', titulo: 'X', inicioEm: iso(inicio) })
        .expect(400);
      expect(semFim.body.detalhes.campos).toEqual([
        { campo: 'fimEm', mensagens: ['é obrigatório na reunião'] },
      ]);
      const invertida = await cliente
        .post(URL, {
          tipo: 'REUNIAO',
          titulo: 'X',
          inicioEm: iso(fim),
          fimEm: iso(inicio),
        })
        .expect(400);
      expect(invertida.body.detalhes.campos).toEqual([
        {
          campo: 'fimEm',
          mensagens: ['deve ser igual ou posterior ao início'],
        },
      ]);
      const comVencimento = await cliente
        .post(URL, {
          tipo: 'REUNIAO',
          titulo: 'X',
          inicioEm: iso(inicio),
          fimEm: iso(fim),
          venceEm: iso(horas(48)),
        })
        .expect(400);
      expect(comVencimento.body.detalhes.campos[0].campo).toBe('venceEm');
      expect(await t.prisma.atividade.count()).toBe(1);
    });

    it('R6.1 — título obrigatório, tipo conhecido, datas só onde cabem e com fuso; campo desconhecido é erro', async () => {
      const usuario = await criarUsuario(t, { papel: 'MARKETING' });
      const cliente = await entrarComo(t, usuario);
      const campos = async (corpo: object) =>
        (await cliente.post(URL, corpo).expect(400)).body.detalhes.campos as {
          campo: string;
          mensagens: string[];
        }[];

      expect(await campos({ tipo: 'TAREFA', titulo: '   ' })).toEqual([
        { campo: 'titulo', mensagens: ['é obrigatório'] },
      ]);
      expect((await campos({ tipo: 'TAREFA' }))[0]).toMatchObject({
        campo: 'titulo',
        mensagens: expect.arrayContaining(['é obrigatório']),
      });
      expect((await campos({ tipo: 'VISITA', titulo: 'X' }))[0].campo).toBe(
        'tipo',
      );
      expect(
        await campos({
          tipo: 'LIGACAO',
          titulo: 'X',
          inicioEm: iso(horas(1)),
        }),
      ).toEqual([{ campo: 'inicioEm', mensagens: ['só se aplica à reunião'] }]);
      expect(
        await campos({ tipo: 'NOTA', titulo: 'X', venceEm: iso(horas(1)) }),
      ).toEqual([{ campo: 'venceEm', mensagens: ['não se aplica à nota'] }]);
      expect(
        await campos({
          tipo: 'TAREFA',
          titulo: 'X',
          venceEm: '2026-10-20T10:00:00',
        }),
      ).toEqual([
        {
          campo: 'venceEm',
          mensagens: [
            'deve ser uma data e hora ISO 8601 com fuso (ex.: 2026-10-20T14:00:00-03:00)',
          ],
        },
      ]);
      expect(
        await campos({ tipo: 'TAREFA', titulo: 'X', status: 'CONCLUIDA' }),
      ).toEqual([{ campo: 'status', mensagens: ['não é um campo aceito'] }]);
      expect(await t.prisma.atividade.count()).toBe(0);
    });

    it('R6.1 — vínculo inexistente, excluído ou de negócio que o usuário não vê é recusado; do negócio vêm o contato e a empresa', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL');
      const marketing = await criarUsuario(t, { papel: 'MARKETING' });
      const empresa = await criarEmpresa(t, { nome: 'ACME' });
      const contato = await criarContato(t, { empresa });
      const negocio = await criarNegocio(t, {
        contato,
        empresa,
        responsavel: ana,
      });
      const daAna = await entrarComo(t, ana);
      const doMarketing = await entrarComo(t, marketing);

      const invisivel = await doMarketing
        .post(URL, { tipo: 'TAREFA', titulo: 'X', negocioId: negocio.id })
        .expect(400);
      expect(invisivel.body.detalhes.campos).toEqual([
        { campo: 'negocioId', mensagens: ['negócio não encontrado'] },
      ]);
      const inexistente = await daAna
        .post(URL, {
          tipo: 'TAREFA',
          titulo: 'X',
          contatoId: randomUUID(),
          empresaId: randomUUID(),
        })
        .expect(400);
      expect(inexistente.body.detalhes.campos).toEqual([
        { campo: 'contatoId', mensagens: ['contato não encontrado'] },
        { campo: 'empresaId', mensagens: ['empresa não encontrada'] },
      ]);
      const excluido = await criarContato(t);
      await t.prisma.contato.update({
        where: { id: excluido.id },
        data: { excluidoEm: new Date() },
      });
      await daAna
        .post(URL, { tipo: 'TAREFA', titulo: 'X', contatoId: excluido.id })
        .expect(400);

      const herdada = await daAna
        .post(URL, {
          tipo: 'LIGACAO',
          titulo: 'Retornar',
          negocioId: negocio.id,
        })
        .expect(201);
      expect(herdada.body).toMatchObject({
        negocio: { id: negocio.id },
        contato: { id: contato.id },
        empresa: { id: empresa.id },
      });
      const doContato = await doMarketing
        .post(URL, { tipo: 'EMAIL', titulo: 'Material', contatoId: contato.id })
        .expect(201);
      expect(doContato.body).toMatchObject({
        contato: { id: contato.id },
        empresa: { id: empresa.id },
        negocio: null,
      });
    });
  });

  describe('R6.2 — responsável, status e conclusão', () => {
    it('R6.2 — o responsável precisa ser um usuário ativo', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const desligado = await criarUsuario(t, {
        papel: 'COMERCIAL',
        ativo: false,
      });
      const cliente = await entrarComo(t, ana);

      for (const responsavelId of [desligado.id, randomUUID()]) {
        const resposta = await cliente
          .post(URL, { tipo: 'TAREFA', titulo: 'X', responsavelId })
          .expect(422);
        expect(resposta.body).toMatchObject({
          erro: 'regra_violada',
          mensagem: 'O responsável precisa ser um usuário ativo.',
          detalhes: { regra: 'R6.2', campo: 'responsavelId', responsavelId },
        });
      }
      const delegada = await cliente
        .post(URL, {
          tipo: 'TAREFA',
          titulo: 'Para o Bruno',
          responsavelId: bruno.id,
        })
        .expect(201);
      expect(delegada.body).toMatchObject({
        responsavel: { id: bruno.id },
        criadoPor: { id: ana.id },
      });
    });

    it('R6.2 — concluir grava quando e quem concluiu e publica atividade.concluida; concluir de novo é conflito', async () => {
      const {
        lider,
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL');
      const atividade = await criarAtividade(t, {
        responsavel: ana,
        titulo: 'Ligar para Maria',
        tipo: 'LIGACAO',
        venceEm: horas(-1),
      });
      const doLider = await entrarComo(t, lider);
      const antes = Date.now();

      const resposta = await doLider
        .post(`${URL}/${atividade.id}/concluir`)
        .expect(200);
      expect(resposta.body).toMatchObject({
        status: 'CONCLUIDA',
        concluidaPor: { id: lider.id },
        atrasada: false,
        grupo: 'CONCLUIDAS',
      });
      expect(
        Date.parse(resposta.body.concluidaEm as string),
      ).toBeGreaterThanOrEqual(antes - 1_000);

      const repetida = await doLider
        .post(`${URL}/${atividade.id}/concluir`)
        .expect(409);
      expect(repetida.body).toMatchObject({
        erro: 'conflito',
        mensagem: 'A atividade já está concluída.',
      });

      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.concluida', entidadeId: atividade.id },
      });
      expect(auditoria.resumo).toBe('Ligação "Ligar para Maria" concluída');
      expect(auditoria.usuarioId).toBe(lider.id);
      const eventos = await eventosDaOutbox();
      expect(eventos.map(({ tipo }) => tipo)).toEqual(['atividade.concluida']);
      expect(eventos[0].dados).toMatchObject({
        atividadeId: atividade.id,
        status: 'CONCLUIDA',
        concluidaPorId: lider.id,
        responsavelId: ana.id,
      });
    });

    it('R6.2 — cancelar e reabrir mudam o status e limpam a conclusão', async () => {
      const usuario = await criarUsuario(t, { papel: 'CS' });
      const cliente = await entrarComo(t, usuario);
      const atividade = await criarAtividade(t, { responsavel: usuario });
      const rota = `${URL}/${atividade.id}`;

      const cancelada = await cliente.post(`${rota}/cancelar`).expect(200);
      expect(cancelada.body).toMatchObject({
        status: 'CANCELADA',
        canceladaEm: expect.any(String),
        grupo: null,
      });
      await cliente.post(`${rota}/cancelar`).expect(409);
      const concluirCancelada = await cliente
        .post(`${rota}/concluir`)
        .expect(409);
      expect(concluirCancelada.body.mensagem).toBe(
        'A atividade está cancelada: reabra-a antes de concluir.',
      );

      const reaberta = await cliente.post(`${rota}/reabrir`).expect(200);
      expect(reaberta.body).toMatchObject({
        status: 'PENDENTE',
        canceladaEm: null,
      });
      await cliente.post(`${rota}/reabrir`).expect(409);

      await cliente.post(`${rota}/concluir`).expect(200);
      const reabertaDeNovo = await cliente.post(`${rota}/reabrir`).expect(200);
      expect(reabertaDeNovo.body).toMatchObject({
        status: 'PENDENTE',
        concluidaEm: null,
        concluidaPor: null,
      });
      const acoes = await t.prisma.eventoAuditoria.findMany({
        where: { entidadeId: atividade.id },
        orderBy: { id: 'asc' },
        select: { acao: true },
      });
      expect(acoes.map(({ acao }) => acao)).toEqual([
        'atividade.cancelada',
        'atividade.reaberta',
        'atividade.concluida',
        'atividade.reaberta',
      ]);
    });

    it('R6.2 — a nota já nasce concluída, não muda de status e só aparece na linha do tempo', async () => {
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const cliente = await entrarComo(t, usuario);
      const contato = await criarContato(t);
      await criarAtividade(t, { responsavel: usuario, titulo: 'Tarefa comum' });

      const nota = await cliente
        .post(URL, {
          tipo: 'NOTA',
          titulo: 'Prefere contato à tarde',
          descricao: 'Disse que de manhã está em reunião.',
          contatoId: contato.id,
        })
        .expect(201);
      expect(nota.body).toMatchObject({
        tipo: 'NOTA',
        status: 'CONCLUIDA',
        concluidaEm: expect.any(String),
        concluidaPor: { id: usuario.id },
        venceEm: null,
        atrasada: false,
        grupo: null,
      });
      const rota = `${URL}/${nota.body.id as string}`;

      expect((await listar(cliente)).map(({ titulo }) => titulo)).toEqual([
        'Tarefa comum',
      ]);
      expect(
        ids(await listar(cliente, { tipo: 'NOTA', contatoId: contato.id })),
      ).toEqual([nota.body.id]);
      const agrupadas = await cliente.get(`${URL}/agrupadas`).expect(200);
      expect(
        (agrupadas.body.grupos as { total: number }[]).reduce(
          (soma, grupo) => soma + grupo.total,
          0,
        ),
      ).toBe(1);

      for (const acao of ['concluir', 'cancelar', 'reabrir']) {
        const resposta = await cliente.post(`${rota}/${acao}`).expect(422);
        expect(resposta.body.detalhes).toEqual({ regra: 'R6.2' });
      }
      await cliente.patch(rota, { titulo: 'Prefere à tarde' }).expect(200);
      const virarTarefa = await cliente
        .patch(rota, { tipo: 'TAREFA' })
        .expect(400);
      expect(virarTarefa.body.detalhes.campos).toEqual([
        { campo: 'tipo', mensagens: ['a nota não muda de tipo'] },
      ]);
      expect((await eventosDaOutbox()).map(({ tipo }) => tipo)).toEqual([
        'atividade.criada',
      ]);
    });

    it('R6.2 — registrar uma atividade já concluída publica atividade.criada e atividade.concluida', async () => {
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const cliente = await entrarComo(t, usuario);

      const resposta = await cliente
        .post(URL, {
          tipo: 'LIGACAO',
          titulo: 'Ligação feita',
          concluida: true,
        })
        .expect(201);
      expect(resposta.body).toMatchObject({
        status: 'CONCLUIDA',
        concluidaPor: { id: usuario.id },
      });
      expect((await eventosDaOutbox()).map(({ tipo }) => tipo)).toEqual([
        'atividade.criada',
        'atividade.concluida',
      ]);
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.criada' },
      });
      expect(auditoria.resumo).toBe(
        'Ligação "Ligação feita" registrada como concluída',
      );
    });
  });

  it('R6.3 — "atrasada" é a pendente com o prazo no passado (na reunião, o fim), calculada na consulta', async () => {
    const usuario = await criarUsuario(t, { papel: 'CS' });
    const cliente = await entrarComo(t, usuario);
    const vencida = await criarAtividade(t, {
      responsavel: usuario,
      venceEm: horas(-2),
    });
    const noPrazo = await criarAtividade(t, {
      responsavel: usuario,
      venceEm: horas(2),
    });
    const semData = await criarAtividade(t, { responsavel: usuario });
    const concluida = await criarAtividade(t, {
      responsavel: usuario,
      venceEm: horas(-2),
      status: 'CONCLUIDA',
    });
    const emAndamento = await criarAtividade(t, {
      responsavel: usuario,
      tipo: 'REUNIAO',
      venceEm: horas(-1),
      inicioEm: horas(-1),
      fimEm: horas(1),
    });
    const reuniaoTerminada = await criarAtividade(t, {
      responsavel: usuario,
      tipo: 'REUNIAO',
      venceEm: horas(-3),
      inicioEm: horas(-3),
      fimEm: horas(-2),
    });

    const atrasadas = await listar(cliente, { atrasadas: true });
    expect(ids(atrasadas)).toEqual(ids([vencida, reuniaoTerminada]));
    expect(atrasadas.every(({ atrasada }) => atrasada)).toBe(true);
    const outras = await listar(cliente, { atrasadas: false });
    expect(ids(outras)).toEqual(
      ids([noPrazo, semData, concluida, emAndamento]),
    );
    expect(outras.some(({ atrasada }) => atrasada)).toBe(false);
    expect(
      await t.prisma.atividade.count({ where: { status: 'PENDENTE' } }),
    ).toBe(5);
  });

  describe('R6.4 — visibilidade', () => {
    let cLevel: Usuario;
    let liderComercial: Usuario;
    let ana: Usuario;
    let bruno: Usuario;
    let liderCs: Usuario;
    let carla: Usuario;
    let admin: Usuario;
    let daAna: string;
    let doBruno: string;
    let paraCarla: string;
    let doLider: string;

    beforeEach(async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      ({ cLevel, lider: liderComercial } = comercial);
      [ana, bruno] = comercial.membros;
      const cs = await criarEquipe(t, 'CS', { membros: 1, cLevel });
      liderCs = cs.lider;
      [carla] = cs.membros;
      admin = await criarUsuario(t, { papel: 'ADMIN' });
      daAna = (await criarAtividade(t, { responsavel: ana })).id;
      doBruno = (await criarAtividade(t, { responsavel: bruno })).id;
      paraCarla = (
        await criarAtividade(t, { responsavel: carla, criadoPor: ana })
      ).id;
      doLider = (
        await criarAtividade(t, {
          responsavel: liderComercial,
          criadoPor: cLevel,
        })
      ).id;
    });

    it('R6.4 — veem: responsável, quem criou, líder do responsável, C-level e Admin', async () => {
      const visiveis = async (usuario: Usuario) =>
        ids(await listar(await entrarComo(t, usuario)));
      expect(await visiveis(ana)).toEqual([daAna, paraCarla].sort());
      expect(await visiveis(bruno)).toEqual([doBruno]);
      expect(await visiveis(carla)).toEqual([paraCarla]);
      expect(await visiveis(liderComercial)).toEqual(
        [daAna, doBruno, doLider].sort(),
      );
      expect(await visiveis(liderCs)).toEqual([paraCarla]);
      const todas = [daAna, doBruno, paraCarla, doLider].sort();
      expect(await visiveis(cLevel)).toEqual(todas);
      expect(await visiveis(admin)).toEqual(todas);

      // A agenda agrupada segue a mesma regra (todas estão "sem data").
      const agenda = await (
        await entrarComo(t, ana)
      )
        .get(`${URL}/agrupadas`)
        .expect(200);
      const semData = (
        agenda.body.grupos as { grupo: string; itens: { id: string }[] }[]
      ).find(({ grupo }) => grupo === 'SEM_DATA');
      expect(ids(semData?.itens ?? [])).toEqual([daAna, paraCarla].sort());
    });

    it('R6.4 — quem não vê recebe 404 para ver, alterar ou concluir', async () => {
      const cliente = await entrarComo(t, ana);
      await cliente.get(`${URL}/${doBruno}`).expect(404);
      await cliente.patch(`${URL}/${doBruno}`, { titulo: 'X' }).expect(404);
      await cliente.post(`${URL}/${doBruno}/concluir`).expect(404);
      await cliente.get(`${URL}/${randomUUID()}`).expect(404);
      const invalido = await cliente.get(`${URL}/nao-e-uuid`).expect(400);
      expect(invalido.body.erro).toBe('dados_invalidos');
      // O líder vê e também altera as da equipe.
      const doLiderCliente = await entrarComo(t, liderComercial);
      await doLiderCliente
        .patch(`${URL}/${doBruno}`, { prioridade: 'ALTA' })
        .expect(200);
      expect(
        (await t.prisma.atividade.findUniqueOrThrow({ where: { id: doBruno } }))
          .prioridade,
      ).toBe('ALTA');
    });

    it('escopos: minhas, equipe e todas — sempre dentro do que o papel vê', async () => {
      const lider = await entrarComo(t, liderComercial);
      expect(ids(await listar(lider, { escopo: 'MINHAS' }))).toEqual([doLider]);
      expect(ids(await listar(lider, { escopo: 'EQUIPE' }))).toEqual(
        [daAna, doBruno].sort(),
      );
      expect(ids(await listar(lider, { escopo: 'TODAS' }))).toEqual(
        [daAna, doBruno, doLider].sort(),
      );
      const diretoria = await entrarComo(t, cLevel);
      expect(ids(await listar(diretoria, { escopo: 'MINHAS' }))).toEqual([]);
      expect(ids(await listar(diretoria, { escopo: 'EQUIPE' }))).toEqual(
        [daAna, doBruno, paraCarla, doLider].sort(),
      );
      const membro = await entrarComo(t, ana);
      expect(ids(await listar(membro, { escopo: 'EQUIPE' }))).toEqual([]);
      expect(ids(await listar(membro, { escopo: 'MINHAS' }))).toEqual([daAna]);
      // Filtrar por outra pessoa não amplia a visão.
      expect(ids(await listar(membro, { responsavelId: bruno.id }))).toEqual(
        [],
      );
      expect(ids(await listar(lider, { responsavelId: bruno.id }))).toEqual([
        doBruno,
      ]);
      expect(ids(await listar(diretoria, { criadoPorId: ana.id }))).toEqual(
        [daAna, paraCarla].sort(),
      );
    });
  });

  it('filtros: tipo, status, prioridade, texto, vínculo, período, paginação e validação da query', async () => {
    const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
    const cliente = await entrarComo(t, usuario);
    const contato = await criarContato(t);
    const ligacao = await criarAtividade(t, {
      responsavel: usuario,
      tipo: 'LIGACAO',
      titulo: 'Ligar sobre a PROPOSTA',
      venceEm: horas(3),
      prioridade: 'ALTA',
      contato,
    });
    const reuniao = await criarAtividade(t, {
      responsavel: usuario,
      tipo: 'REUNIAO',
      titulo: 'Reunião de alinhamento',
      venceEm: horas(30),
      inicioEm: horas(30),
      fimEm: horas(31),
    });
    const concluida = await criarAtividade(t, {
      responsavel: usuario,
      tipo: 'EMAIL',
      titulo: 'Enviar contrato',
      status: 'CONCLUIDA',
      venceEm: horas(-30),
    });
    const tarefa = await criarAtividade(t, {
      responsavel: usuario,
      titulo: 'Atualizar cadastro',
    });

    expect(ids(await listar(cliente, { tipo: 'LIGACAO,REUNIAO' }))).toEqual(
      ids([ligacao, reuniao]),
    );
    expect(ids(await listar(cliente, { tipo: ['LIGACAO', 'EMAIL'] }))).toEqual(
      ids([ligacao, concluida]),
    );
    expect(ids(await listar(cliente, { status: 'CONCLUIDA' }))).toEqual([
      concluida.id,
    ]);
    expect(ids(await listar(cliente, { prioridade: 'ALTA' }))).toEqual([
      ligacao.id,
    ]);
    expect(ids(await listar(cliente, { busca: 'proposta' }))).toEqual([
      ligacao.id,
    ]);
    expect(ids(await listar(cliente, { contatoId: contato.id }))).toEqual([
      ligacao.id,
    ]);
    expect(
      ids(await listar(cliente, { de: iso(horas(0)), ate: iso(horas(48)) })),
    ).toEqual(ids([ligacao, reuniao]));

    // Ordem padrão: pela data, sem data no fim.
    expect((await listar(cliente)).map(({ id }) => id)).toEqual([
      concluida.id,
      ligacao.id,
      reuniao.id,
      tarefa.id,
    ]);
    const pagina = await cliente
      .get(URL)
      .query({ porPagina: 2, pagina: 2 })
      .expect(200);
    expect(pagina.body).toMatchObject({ total: 4, pagina: 2, porPagina: 2 });
    expect(ids(pagina.body.itens as { id: string }[])).toEqual(
      ids([reuniao, tarefa]),
    );

    const periodoInvertido = await cliente
      .get(URL)
      .query({ de: iso(horas(5)), ate: iso(horas(1)) })
      .expect(400);
    expect(periodoInvertido.body.detalhes.campos[0].campo).toBe('ate');
    const tipoInvalido = await cliente
      .get(URL)
      .query({ tipo: 'TAREFA,VISITA' })
      .expect(400);
    expect(tipoInvalido.body.detalhes.campos[0].campo).toBe('tipo');
    await cliente.get(URL).query({ escopo: 'TUDO' }).expect(400);
    await cliente.get(URL).query({ fusoHorario: 'Lugar/Nenhum' }).expect(400);
    await cliente.get(URL).query({ desconhecido: '1' }).expect(400);
  });

  it('agrupamentos: atrasadas, hoje, próximos 7 dias, mais tarde, sem data e concluídas', async () => {
    const fuso = fusoComDiaClaro();
    const usuario = await criarUsuario(t, { papel: 'CS' });
    const outro = await criarUsuario(t, { papel: 'CS' });
    const cliente = await entrarComo(t, usuario);
    const limites = limitesDoCalendario(new Date(), fuso);
    const criar = (dados: Parameters<typeof criarAtividade>[1]) =>
      criarAtividade(t, dados);

    const esperado: Record<string, string[]> = {
      ATRASADAS: [
        (await criar({ responsavel: usuario, venceEm: horas(-1) })).id,
        (
          await criar({
            responsavel: usuario,
            tipo: 'REUNIAO',
            venceEm: horas(-3),
            inicioEm: horas(-3),
            fimEm: horas(-2),
          })
        ).id,
      ],
      HOJE: [
        (await criar({ responsavel: usuario, venceEm: horas(1) })).id,
        (
          await criar({
            responsavel: usuario,
            tipo: 'REUNIAO',
            venceEm: horas(-0.5),
            inicioEm: horas(-0.5),
            fimEm: horas(0.5),
          })
        ).id,
      ],
      PROXIMOS_7_DIAS: [
        (
          await criar({
            responsavel: usuario,
            venceEm: new Date(limites.inicioDeAmanha.getTime() + 60_000),
          })
        ).id,
        (await criar({ responsavel: usuario, venceEm: horas(24 * 3) })).id,
      ],
      MAIS_TARDE: [
        (
          await criar({
            responsavel: usuario,
            venceEm: limites.fimDosProximos7Dias,
          })
        ).id,
      ],
      SEM_DATA: [(await criar({ responsavel: usuario })).id],
      CONCLUIDAS: [
        (
          await criar({
            responsavel: usuario,
            venceEm: horas(-5),
            status: 'CONCLUIDA',
          })
        ).id,
      ],
    };
    // Fora de todos os grupos: cancelada, nota e a de outra pessoa.
    await criar({ responsavel: usuario, status: 'CANCELADA' });
    await criar({ responsavel: usuario, tipo: 'NOTA' });
    await criar({ responsavel: outro, venceEm: horas(1) });

    const resposta = await cliente
      .get(`${URL}/agrupadas`)
      .query({ fusoHorario: fuso, limitePorGrupo: 50 })
      .expect(200);
    expect(resposta.body.referencia).toMatchObject({
      fusoHorario: fuso,
      inicioDeAmanha: iso(limites.inicioDeAmanha),
      fimDosProximos7Dias: iso(limites.fimDosProximos7Dias),
    });
    const grupos = resposta.body.grupos as {
      grupo: string;
      rotulo: string;
      total: number;
      itens: AtividadeResposta[];
    }[];
    expect(grupos.map(({ grupo, rotulo }) => [grupo, rotulo])).toEqual([
      ['ATRASADAS', 'Atrasadas'],
      ['HOJE', 'Hoje'],
      ['PROXIMOS_7_DIAS', 'Próximos 7 dias'],
      ['MAIS_TARDE', 'Mais tarde'],
      ['SEM_DATA', 'Sem data'],
      ['CONCLUIDAS', 'Concluídas'],
    ]);
    for (const { grupo, total, itens } of grupos) {
      expect([grupo, ids(itens)]).toEqual([grupo, [...esperado[grupo]].sort()]);
      expect(total).toBe(esperado[grupo].length);
      expect(itens.every((item) => item.grupo === grupo)).toBe(true);
    }

    // O mesmo critério na lista (o "ver mais" de cada grupo).
    for (const grupo of Object.keys(esperado)) {
      expect(ids(await listar(cliente, { grupo, fusoHorario: fuso }))).toEqual(
        [...esperado[grupo]].sort(),
      );
    }
    const soTotais = await cliente
      .get(`${URL}/agrupadas`)
      .query({ fusoHorario: fuso, limitePorGrupo: 0, tipo: 'REUNIAO' })
      .expect(200);
    expect(
      (soTotais.body.grupos as { total: number; itens: unknown[] }[]).map(
        ({ total, itens }) => [total, itens.length],
      ),
    ).toEqual([
      [1, 0],
      [1, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    await cliente
      .get(`${URL}/agrupadas`)
      .query({ status: 'PENDENTE' })
      .expect(400);
  });

  it('R7.3 — mostra de quem a atividade veio quando foi encaminhada por desligamento', async () => {
    const {
      lider,
      membros: [pedro],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const encaminhada = await criarAtividade(t, {
      responsavel: lider,
      criadoPor: pedro,
    });
    const propria = await criarAtividade(t, { responsavel: lider });
    const quando = new Date(Date.now() - 60_000);
    await t.prisma.usuario.update({
      where: { id: pedro.id },
      data: { ativo: false, desligadoEm: quando },
    });
    await t.prisma.atividade.update({
      where: { id: encaminhada.id },
      data: { encaminhadaDeId: pedro.id, encaminhadaEm: quando },
    });
    const cliente = await entrarComo(t, lider);

    const detalhe = await cliente.get(`${URL}/${encaminhada.id}`).expect(200);
    expect(detalhe.body).toMatchObject({
      encaminhadaDe: { id: pedro.id, nome: pedro.nome },
      encaminhadaEm: iso(quando),
    });
    expect(ids(await listar(cliente, { encaminhadas: true }))).toEqual([
      encaminhada.id,
    ]);
    expect(ids(await listar(cliente, { encaminhadas: false }))).toEqual([
      propria.id,
    ]);
  });

  it('documenta as rotas, os filtros e os modelos no Swagger', async () => {
    const documento = await clienteAnonimo(t).get('/api/docs-json').expect(200);
    const caminhos = documento.body.paths as Record<
      string,
      Record<string, { tags?: string[]; parameters?: { name: string }[] }>
    >;
    expect(Object.keys(caminhos)).toEqual(
      expect.arrayContaining([
        URL,
        `${URL}/agrupadas`,
        `${URL}/{id}`,
        `${URL}/{id}/concluir`,
        `${URL}/{id}/cancelar`,
        `${URL}/{id}/reabrir`,
      ]),
    );
    expect(caminhos[URL].post.tags).toEqual(['Atividades']);
    expect(caminhos[URL].get.parameters?.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'escopo',
        'tipo',
        'status',
        'grupo',
        'atrasadas',
        'de',
        'ate',
        'fusoHorario',
        'pagina',
        'porPagina',
      ]),
    );
    expect(Object.keys(documento.body.components.schemas as object)).toEqual(
      expect.arrayContaining([
        'AtividadeDto',
        'CriarAtividadeDto',
        'AtualizarAtividadeDto',
        'AtividadesAgrupadasDto',
      ]),
    );
  });

  describe('alteração', () => {
    it('altera os campos enviados e audita o antes/depois; sem mudança, não audita', async () => {
      const usuario = await criarUsuario(t, { papel: 'MARKETING' });
      const cliente = await entrarComo(t, usuario);
      const contato = await criarContato(t);
      const atividade = await criarAtividade(t, {
        responsavel: usuario,
        titulo: 'Antigo',
        contato,
      });
      const rota = `${URL}/${atividade.id}`;

      const resposta = await cliente
        .patch(rota, {
          titulo: 'Novo título',
          descricao: 'Detalhes',
          prioridade: 'BAIXA',
          contatoId: null,
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        titulo: 'Novo título',
        descricao: 'Detalhes',
        prioridade: 'BAIXA',
        contato: null,
      });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.atualizada' },
      });
      expect(auditoria.resumo).toBe(
        'Tarefa "Novo título" atualizada: título, descrição, prioridade, contato',
      );
      expect(auditoria.dados).toMatchObject({
        alteracoes: {
          titulo: { antes: 'Antigo', depois: 'Novo título' },
          prioridade: { antes: 'MEDIA', depois: 'BAIXA' },
          contatoId: { antes: contato.id, depois: null },
        },
      });

      await cliente.patch(rota, { titulo: 'Novo título' }).expect(200);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'atividade.atualizada' },
        }),
      ).toBe(1);
      for (const corpo of [
        { titulo: null },
        { concluida: true },
        { responsavelId: null },
        { venceEm: 'amanhã' },
      ]) {
        await cliente.patch(rota, corpo).expect(400);
      }
    });

    it('R6.1 — trocar o tipo revalida as datas: virar reunião exige início e fim; nenhum tipo vira nota', async () => {
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const cliente = await entrarComo(t, usuario);
      const atividade = await criarAtividade(t, {
        responsavel: usuario,
        venceEm: horas(10),
      });
      const rota = `${URL}/${atividade.id}`;

      const semDatas = await cliente
        .patch(rota, { tipo: 'REUNIAO' })
        .expect(400);
      expect(
        (semDatas.body.detalhes.campos as { campo: string }[]).map(
          ({ campo }) => campo,
        ),
      ).toEqual(['inicioEm', 'fimEm']);
      const inicio = horas(20);
      const fim = horas(21);
      const reuniao = await cliente
        .patch(rota, {
          tipo: 'REUNIAO',
          inicioEm: iso(inicio),
          fimEm: iso(fim),
        })
        .expect(200);
      expect(reuniao.body).toMatchObject({
        tipo: 'REUNIAO',
        venceEm: iso(inicio),
        inicioEm: iso(inicio),
        fimEm: iso(fim),
      });
      // Deixar de ser reunião limpa início e fim; o vencimento (o início) fica.
      const deVolta = await cliente
        .patch(rota, { tipo: 'LIGACAO' })
        .expect(200);
      expect(deVolta.body).toMatchObject({
        tipo: 'LIGACAO',
        venceEm: iso(inicio),
        inicioEm: null,
        fimEm: null,
      });
      const virarNota = await cliente.patch(rota, { tipo: 'NOTA' }).expect(400);
      expect(virarNota.body.detalhes.campos).toEqual([
        { campo: 'tipo', mensagens: ['uma atividade não pode virar nota'] },
      ]);
    });

    it('R6.2 — trocar o responsável exige usuário ativo e fica no resumo da auditoria', async () => {
      const {
        lider,
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const desligado = await criarUsuario(t, {
        papel: 'COMERCIAL',
        ativo: false,
      });
      const atividade = await criarAtividade(t, {
        responsavel: ana,
        titulo: 'Visitar cliente',
      });
      const cliente = await entrarComo(t, lider);
      const rota = `${URL}/${atividade.id}`;

      const recusada = await cliente
        .patch(rota, { responsavelId: desligado.id })
        .expect(422);
      expect(recusada.body.detalhes).toMatchObject({ regra: 'R6.2' });
      const trocada = await cliente
        .patch(rota, { responsavelId: bruno.id })
        .expect(200);
      expect(trocada.body.responsavel).toMatchObject({ id: bruno.id });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.atualizada' },
      });
      expect(auditoria.resumo).toBe(
        `Tarefa "Visitar cliente" atualizada: responsável (${ana.nome} → ${bruno.nome})`,
      );
    });
  });
});
