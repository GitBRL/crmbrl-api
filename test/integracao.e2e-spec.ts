/**
 * Integração entre módulos (Fase 1): o que só aparece quando os módulos
 * conversam — a linha do tempo do negócio (R3.5, contatos + funis +
 * atividades), a mesma regra de atraso em todas as telas (R6.3) e a jornada
 * completa de um lead, do webhook ao CS, com auditoria e desligamento.
 */
import { TIPOS_NOTIFICACAO } from '../src/notificacoes/tipos-notificacao';
import { mover } from './funis-apoio';
import { enviarLead, FILA_PROCESSAR, tokenDaUrl } from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
  processarEventos,
} from './utils';

interface RegistroDaLinha {
  tipo: 'evento' | 'atividade';
  evento: { acao: string; tipoAtor: string } | null;
  atividade: { titulo: string; atrasada: boolean } | null;
}

interface PassagemExecutada {
  negocioDestinoId: string;
  criado: boolean;
  responsavel: { id: string } | null;
}

const HORA = 3_600_000;

describe('Integração entre módulos (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  const linhaDoTempo = async (
    cliente: ClienteHttp,
    caminho: string,
  ): Promise<RegistroDaLinha[]> =>
    (await cliente.get(caminho).expect(200)).body.itens as RegistroDaLinha[];

  const rotulos = (itens: RegistroDaLinha[]): string[] =>
    itens.map((item) =>
      item.evento
        ? `evento:${item.evento.acao}`
        : `atividade:${item.atividade?.titulo ?? ''}`,
    );

  it('R3.5 — linha do tempo do negócio: os eventos de auditoria dele e as atividades dele; quem não vê o negócio recebe 404 (R5.9)', async () => {
    const {
      lider,
      membros: [ana, bruno],
    } = await criarEquipe(t, 'COMERCIAL');
    const {
      membros: [marcia],
    } = await criarEquipe(t, 'MARKETING', { membros: 1 });
    const contato = await criarContato(t, { nome: 'Lia', responsavel: ana });
    const comercial = await funilBase(t, 'COMERCIAL');
    const comoAna = await entrarComo(t, ana);

    const criado = await comoAna
      .post('/api/v1/negocios', {
        contatoId: contato.id,
        funilId: comercial.id,
        titulo: 'Lia — proposta',
        valor: '1000.00',
      })
      .expect(201);
    const negocioId = (criado.body as { id: string }).id;
    const qualificacao = await etapaDoFunilBase(t, 'COMERCIAL', 'qualificacao');
    await mover(comoAna, negocioId, qualificacao.id).expect(200);
    await comoAna
      .post('/api/v1/atividades', {
        tipo: 'LIGACAO',
        titulo: 'Ligar para a Lia',
        negocioId,
        venceEm: new Date(Date.now() + HORA).toISOString(),
      })
      .expect(201);
    // Fora da linha do tempo deste negócio: a atividade de outro negócio do
    // mesmo contato e, para a Ana, a do Bruno (R6.4).
    const outro = await criarNegocio(t, { contato, responsavel: ana });
    await criarAtividade(t, {
      responsavel: ana,
      negocio: outro,
      titulo: 'Do outro negócio',
    });
    await criarAtividade(t, {
      responsavel: bruno,
      negocio: negocioId,
      titulo: 'Particular do Bruno',
    });

    const caminho = `/api/v1/negocios/${negocioId}/linha-do-tempo`;
    const daAna = rotulos(await linhaDoTempo(comoAna, caminho));
    expect(daAna).toEqual(
      expect.arrayContaining([
        'evento:negocio.criado',
        'evento:negocio.movido',
        'evento:atividade.criada',
        'atividade:Ligar para a Lia',
      ]),
    );
    expect(daAna).not.toContain('atividade:Do outro negócio');
    expect(daAna).not.toContain('atividade:Particular do Bruno');

    // O líder vê o negócio e as atividades da equipe (R5.9, R6.4).
    const comoLider = await entrarComo(t, lider);
    expect(rotulos(await linhaDoTempo(comoLider, caminho))).toEqual(
      expect.arrayContaining([
        'atividade:Ligar para a Lia',
        'atividade:Particular do Bruno',
      ]),
    );
    const soAtividades = await linhaDoTempo(
      comoAna,
      `${caminho}?incluir=atividades`,
    );
    expect(soAtividades.length).toBeGreaterThan(0);
    expect(soAtividades.every((item) => item.tipo === 'atividade')).toBe(true);

    // R5.9: o outro comercial (o negócio tem dono) e o marketing não veem.
    await (await entrarComo(t, bruno)).get(caminho).expect(404);
    await (await entrarComo(t, marcia)).get(caminho).expect(404);
    await comoAna
      .get(
        '/api/v1/negocios/00000000-0000-4000-8000-000000000000/linha-do-tempo',
      )
      .expect(404);

    // O mesmo negócio aparece na linha do tempo do contato, com os dois negócios.
    expect(
      rotulos(
        await linhaDoTempo(
          comoAna,
          `/api/v1/contatos/${contato.id}/linha-do-tempo`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'evento:negocio.criado',
        'atividade:Ligar para a Lia',
        'atividade:Do outro negócio',
      ]),
    );
  });

  it('R6.3 — "atrasada" é a mesma em atividades e nas linhas do tempo: a reunião em andamento não está atrasada; a tarefa vencida está', async () => {
    const {
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const contato = await criarContato(t, { responsavel: ana });
    const negocio = await criarNegocio(t, { contato, responsavel: ana });
    const agora = Date.now();
    const reuniao = await criarAtividade(t, {
      responsavel: ana,
      tipo: 'REUNIAO',
      titulo: 'Reunião em andamento',
      inicioEm: new Date(agora - HORA / 2),
      fimEm: new Date(agora + HORA / 2),
      contato,
      negocio,
    });
    const vencida = await criarAtividade(t, {
      responsavel: ana,
      titulo: 'Tarefa vencida',
      venceEm: new Date(agora - HORA),
      contato,
      negocio,
    });
    const comoAna = await entrarComo(t, ana);

    for (const [atividade, atrasada] of [
      [reuniao, false],
      [vencida, true],
    ] as const) {
      const detalhe = await comoAna
        .get(`/api/v1/atividades/${atividade.id}`)
        .expect(200);
      expect(detalhe.body.atrasada).toBe(atrasada);
    }
    for (const caminho of [
      `/api/v1/contatos/${contato.id}/linha-do-tempo?incluir=atividades`,
      `/api/v1/negocios/${negocio.id}/linha-do-tempo?incluir=atividades`,
    ]) {
      const itens = await linhaDoTempo(comoAna, caminho);
      expect(
        Object.fromEntries(
          itens.map((item) => [
            item.atividade?.titulo,
            item.atividade?.atrasada,
          ]),
        ),
      ).toEqual({ 'Reunião em andamento': false, 'Tarefa vencida': true });
    }
  });

  it('Jornada — lead do Disparos BRL por webhook → Marketing → MQL → Comercial (rodízio) → ganho → CS com o valor recorrente; a auditoria registra tudo e o desligamento encaminha o que ficou aberto', async () => {
    const admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    const comoAdmin = await entrarComo(t, admin);
    const cLevel = await criarUsuario(t, {
      papel: 'C_LEVEL',
      nome: 'Carla Diretora',
    });
    const {
      membros: [marina],
    } = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    const {
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL', { cLevel });
    const {
      lider: liderCs,
      membros: [caio],
    } = await criarEquipe(t, 'CS', { membros: 1, cLevel });

    // 1. Ponto de entrada com o modelo Disparos BRL (R8.1).
    const ponto = await comoAdmin
      .post('/api/v1/webhooks/entradas', {
        nome: 'Disparos BRL',
        modeloMapeamento: 'DISPAROS_BRL',
      })
      .expect(201);
    const token = tokenDaUrl((ponto.body as { url: string }).url);

    // 2. O sistema de disparos manda um lead; a fila processa (R8.2–R8.5).
    const recebido = await enviarLead(t, token, {
      name: 'Lia Martins',
      email: 'lia@acme.com.br',
      phone: '(11) 98888-7777',
      whatsapp: '5511988887777',
      faturamento: 'Acima de R$ 80 mil',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'São Paulo',
    }).expect(202);
    expect(await drenarFilas(t, FILA_PROCESSAR)).toBe(1);
    const recebimento = await t.prisma.webhookRecebimento.findUniqueOrThrow({
      where: { id: (recebido.body as { id: string }).id },
    });
    expect(recebimento.status).toBe('PROCESSADO');
    const contato = await t.prisma.contato.findUniqueOrThrow({
      where: { id: recebimento.contatoId ?? '' },
    });
    expect(contato).toMatchObject({
      nome: 'Lia Martins',
      email: 'lia@acme.com.br',
      telefone: '5511988887777',
      primeiraOrigem: 'WEBHOOK',
      primeiraOrigemDetalhe: 'Disparos BRL',
      primeiraOrigemUtm: {
        campaign: 'Black Friday',
        source: 'Disparos WhatsApp',
      },
      camposPersonalizados: {
        faturamento: 'Acima de R$ 80 mil',
        planilha_cidade: 'São Paulo',
      },
      // R4.5: o contato fica com o responsável do negócio que o originou.
      responsavelId: marina.id,
    });
    const noMarketing = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: recebimento.negocioId ?? '' },
      include: { etapa: true },
    });
    expect(noMarketing).toMatchObject({
      responsavelId: marina.id,
      status: 'ABERTO',
    });
    expect(noMarketing.etapa.chave).toBe('novo_lead');

    // 3. A Marina qualifica (MQL): passagem para o Comercial por rodízio (R5.7, R5.8).
    const mql = await etapaDoFunilBase(t, 'MARKETING', 'qualificado_mql');
    const comoMarina = await entrarComo(t, marina);
    const qualificado = await mover(comoMarina, noMarketing.id, mql.id).expect(
      200,
    );
    expect(qualificado.body.negocio.status).toBe('GANHO');
    const [paraComercial] = qualificado.body.passagens as PassagemExecutada[];
    expect(paraComercial).toMatchObject({
      criado: true,
      responsavel: { id: ana.id },
    });

    // 4. A Ana fecha: valores e ganho → negócio no CS em Boas-vindas (R5.5, R5.7).
    const comoAna = await entrarComo(t, ana);
    await comoAna
      .patch(`/api/v1/negocios/${paraComercial.negocioDestinoId}`, {
        valor: '12000.00',
        valorRecorrente: '990.00',
      })
      .expect(200);
    const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
    const fechado = await mover(
      comoAna,
      paraComercial.negocioDestinoId,
      ganho.id,
    ).expect(200);
    expect(fechado.body.negocio).toMatchObject({
      status: 'GANHO',
      ganhoEm: expect.any(String) as string,
    });
    const [paraCs] = fechado.body.passagens as PassagemExecutada[];
    expect(paraCs).toMatchObject({
      criado: true,
      responsavel: { id: caio.id },
    });
    const noCs = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: paraCs.negocioDestinoId },
      include: { etapa: true },
    });
    expect(noCs.etapa.chave).toBe('boas_vindas');
    expect(noCs.valor.toFixed(2)).toBe('12000.00');
    expect(noCs.valorRecorrente?.toFixed(2)).toBe('990.00');
    expect(noCs).toMatchObject({
      contatoId: contato.id,
      negocioOrigemId: paraComercial.negocioDestinoId,
      origem: 'WEBHOOK',
      utm: { campaign: 'Black Friday', source: 'Disparos WhatsApp' },
    });

    // 5. A auditoria registrou cada passo com o ator certo (R3.1, R3.4).
    const comoCLevel = await entrarComo(t, cLevel);
    const auditoria = await comoCLevel
      .get(
        `/api/v1/auditoria?entidade=contato&entidadeId=${contato.id}&incluirRelacionados=true&limite=100`,
      )
      .expect(200);
    const acoes = (
      auditoria.body.itens as { tipoAtor: string; acao: string }[]
    ).map(({ tipoAtor, acao }) => `${tipoAtor}:${acao}`);
    expect(acoes).toEqual(
      expect.arrayContaining([
        'WEBHOOK:contato.criado',
        'WEBHOOK:negocio.criado',
        'USUARIO:negocio.ganho',
        'AUTOMACAO:passagem.executada',
        'AUTOMACAO:negocio.criado',
        'USUARIO:negocio.atualizado',
      ]),
    );
    // A linha do tempo do contato junta os três funis para quem vê tudo.
    const linhaDoContato = rotulos(
      await linhaDoTempo(
        comoCLevel,
        `/api/v1/contatos/${contato.id}/linha-do-tempo?incluir=eventos&porPagina=100`,
      ),
    );
    expect(
      linhaDoContato.filter((rotulo) => rotulo === 'evento:negocio.criado'),
    ).toHaveLength(3);

    // 6. O Caio é desligado: o negócio aberto do CS vai para o líder do CS (R7).
    await comoAdmin
      .post(`/api/v1/usuarios/${caio.id}/desligar`, {})
      .expect(200);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: noCs.id } }))
        .responsavelId,
    ).toBe(liderCs.id);
    expect(
      await t.prisma.notificacao.count({
        where: {
          usuarioId: liderCs.id,
          tipo: TIPOS_NOTIFICACAO.ITENS_ENCAMINHADOS,
        },
      }),
    ).toBe(1);
    const comoLiderCs = await entrarComo(t, liderCs);
    expect(
      rotulos(
        await linhaDoTempo(
          comoLiderCs,
          `/api/v1/negocios/${noCs.id}/linha-do-tempo?incluir=eventos`,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        'evento:negocio.criado',
        'evento:negocio.encaminhado',
      ]),
    );
    // Os negócios fechados ficam com quem os fechou.
    expect(
      (
        await t.prisma.negocio.findUniqueOrThrow({
          where: { id: paraComercial.negocioDestinoId },
        })
      ).responsavelId,
    ).toBe(ana.id);

    // 7. Os eventos de domínio da jornada estão na outbox e são entregues (R10.1).
    const tipos = new Set(
      (await t.prisma.eventoDominio.findMany({ select: { tipo: true } })).map(
        ({ tipo }) => tipo,
      ),
    );
    for (const tipo of [
      'contato.criado',
      'negocio.criado',
      'negocio.movido',
      'negocio.ganho',
      'usuario.desligado',
    ]) {
      expect(tipos).toContain(tipo);
    }
    await processarEventos(t);
    expect(
      await t.prisma.eventoDominio.count({ where: { processadoEm: null } }),
    ).toBe(0);
  });
});
