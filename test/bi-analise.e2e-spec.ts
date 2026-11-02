import { CLIENTE_ANTHROPIC } from '../src/bi/analise/cliente-anthropic';
import { OPCOES_CHAMADA_CLAUDE } from '../src/bi/analise/chamada-claude.service';
import { diaLocal } from '../src/bi/periodo';
import type { Usuario } from '../src/generated/prisma/client';
import { criarNegocioBi, DIA, quando } from './bi-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  entrarComo,
} from './utils';
import {
  ClienteAnthropicFalso,
  entradaDaChamada,
  erroDaApi,
} from './utils/anthropic-falso';

/** Chave falsa só destes testes: nunca pode aparecer numa resposta. */
const CHAVE_FALSA = 'sk-ant-chave-falsa-dos-testes-0123456789';

interface EventoSse {
  evento: string;
  dados: Record<string, unknown>;
}

function emDias(dias: number): string {
  const hoje = new Date(`${diaLocal(new Date())}T00:00:00.000Z`);
  return new Date(hoje.getTime() + dias * DIA).toISOString().slice(0, 10);
}

/** Faz o POST e lê o corpo `text/event-stream` inteiro. */
async function transmitir(
  cliente: ClienteHttp,
  url: string,
  corpo: object,
): Promise<{
  status: number;
  eventos: EventoSse[];
  bruto: string;
  tipo: string;
}> {
  const resposta = await cliente
    .post(url, corpo)
    .buffer(true)
    .parse((res, fim) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (parte: string) => (texto += parte));
      res.on('end', () => fim(null, texto));
    });
  const bruto = resposta.body as string;
  const eventos: EventoSse[] = [];
  for (const bloco of bruto.split('\n\n')) {
    const evento = /^event: (.+)$/m.exec(bloco)?.[1];
    const dados = /^data: (.+)$/m.exec(bloco)?.[1];
    if (evento && dados) {
      eventos.push({
        evento,
        dados: JSON.parse(dados) as Record<string, unknown>,
      });
    }
  }
  return {
    status: resposta.status,
    eventos,
    bruto,
    tipo: String(resposta.headers['content-type'] ?? ''),
  };
}

function nomes(eventos: EventoSse[]): string[] {
  return eventos.map((e) => e.evento).filter((e, i, l) => l[i - 1] !== e);
}

describe('BI — análise por IA (e2e)', () => {
  let t: AppTeste;
  const falso = new ClienteAnthropicFalso();

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: { ANTHROPIC_API_KEY: CHAVE_FALSA },
      ajustar: (c) =>
        c
          .overrideProvider(CLIENTE_ANTHROPIC)
          .useValue(falso)
          .overrideProvider(OPCOES_CHAMADA_CLAUDE)
          .useValue({ timeoutMs: 400, esperaMs: 5, tentativas: 2 }),
    });
  });
  beforeEach(async () => {
    await t.limparBanco();
    falso.limpar();
  });
  afterAll(() => t.fechar());

  async function montarCs(): Promise<{ admin: Usuario; cliente: ClienteHttp }> {
    const { membros } = await criarEquipe(t, 'CS', { membros: 1 });
    const [c1] = membros;
    const cs = (dados: Omit<Parameters<typeof criarNegocioBi>[1], 'area'>) =>
      criarNegocioBi(t, { area: 'CS', ...dados });
    await cs({
      etapa: 'boas_vindas',
      valorRecorrente: '100.00',
      previsao: emDias(10),
      criadoEm: quando(5),
      responsavel: c1,
    });
    await cs({
      etapa: 'acompanhamento',
      valorRecorrente: '300.00',
      previsao: emDias(20),
      criadoEm: quando(40),
      responsavel: c1,
    });
    await cs({
      etapa: 'renovado',
      valorRecorrente: '200.00',
      criadoEm: quando(50),
      fechadoEm: quando(3),
      responsavel: c1,
    });
    const admin = await criarUsuario(t, { papel: 'ADMIN' });
    return { admin, cliente: await entrarComo(t, admin) };
  }

  it('cenário 80 — R21 — sem sessão 401; só o Admin usa (os outros papéis recebem 403)', async () => {
    await clienteAnonimo(t).get('/api/v1/bi/analise/estado').expect(401);
    const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
      membros: 1,
    });
    for (const usuario of [cLevel, lider, membros[0]]) {
      const c = await entrarComo(t, usuario);
      await c.get('/api/v1/bi/analise/estado').expect(403);
      await c.get('/api/v1/bi/analise/historico').expect(403);
      await c.post('/api/v1/bi/analise', { painel: 'comercial' }).expect(403);
      await c
        .put('/api/v1/bi/analise/configuracao', { limiteDiario: 5 })
        .expect(403);
      await c
        .post(`/api/v1/bi/analise/${cLevel.id}/perguntas`, {
          pergunta: 'Por quê?',
        })
        .expect(403);
    }
    expect(falso.chamadas).toHaveLength(0);
  });

  it('cenário 81 — R21 — analisa em streaming, só com números agregados, e grava histórico e auditoria', async () => {
    const { admin, cliente } = await montarCs();
    const estadoAntes = await cliente
      .get('/api/v1/bi/analise/estado')
      .expect(200);
    expect(estadoAntes.body).toMatchObject({
      configurada: true,
      comoConfigurar: null,
      disponivel: true,
      modelo: 'claude-opus-5-5',
      limiteDiario: 20,
      usadasHoje: 0,
      restantesHoje: 20,
      maxPerguntasPorAnalise: 5,
    });

    const r = await transmitir(cliente, '/api/v1/bi/analise', {
      painel: 'cs',
      comparar: true,
    });
    expect(r.status).toBe(200);
    expect(r.tipo).toContain('text/event-stream');
    const ordem = nomes(r.eventos);
    expect(ordem[0]).toBe('inicio');
    expect(ordem).toEqual(
      expect.arrayContaining(['fase', 'parcial', 'concluido']),
    );
    expect(ordem.at(-1)).toBe('concluido');
    expect(ordem).not.toContain('erro');
    const parcial = r.eventos.find((e) => e.evento === 'parcial')!.dados;
    expect(JSON.stringify(parcial)).not.toContain('"link"');

    // A chamada: modelo, raciocínio adaptativo, saída estruturada, cache e reserva.
    expect(falso.chamadas).toHaveLength(1);
    const p = falso.chamadas[0];
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config?.format?.type).toBe('json_schema');
    expect(p.output_config?.effort).toBe('medium');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p.fallbacks).toBe('default');
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    expect(Array.isArray(p.system) && p.system[0].cache_control).toEqual({
      type: 'ephemeral',
    });
    // Nada de dados pessoais de contatos (nomes, e-mails, títulos de negócio).
    const enviado = JSON.stringify(p.messages);
    expect(enviado).not.toMatch(/@teste\.local|Contato \d|BI CS /);
    const entrada = entradaDaChamada(p);
    expect(entrada.painel).toBe('cs');
    expect(entrada.tabelas?.map((tb) => tb.chave)).toContain(
      'proximasRenovacoesPorEtapa',
    );

    const fim = r.eventos.at(-1)!.dados as {
      analiseId: string;
      resultado: { resumo: string; acoes: { link: Record<string, unknown> }[] };
      tokens: Record<string, number>;
      restantesHoje: number;
    };
    expect(fim.resultado.resumo).toBeTruthy();
    // O link da ação (etapa de onboarding) foi conferido contra a entrada.
    expect(fim.resultado.acoes[0].link).toMatchObject({
      caminho: '/funis/cs',
      ajustado: false,
    });
    expect(fim.tokens).toEqual({
      entrada: 1200,
      saida: 450,
      cacheLeitura: 0,
      cacheEscrita: 900,
    });
    expect(fim.restantesHoje).toBe(19);

    const linha = await t.prisma.analiseIa.findUniqueOrThrow({
      where: { id: fim.analiseId },
    });
    expect(linha).toMatchObject({
      usuarioId: admin.id,
      painel: 'cs',
      status: 'CONCLUIDA',
      tentativas: 1,
      tokensEntrada: 1200,
      tokensSaida: 450,
      tokensCacheEscrita: 900,
    });
    const auditoria = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'bi.analise_ia_concluida' },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({
      entidade: 'analise_ia',
      entidadeId: fim.analiseId,
      usuarioId: admin.id,
    });

    const estado = await cliente.get('/api/v1/bi/analise/estado').expect(200);
    expect(estado.body).toMatchObject({ usadasHoje: 1, restantesHoje: 19 });

    // Histórico e detalhe (só Admin), sem a chave em lugar nenhum.
    const historico = await cliente
      .get('/api/v1/bi/analise/historico?painel=cs')
      .expect(200);
    expect(historico.body).toMatchObject({ total: 1, pagina: 1 });
    expect(historico.body.itens[0]).toMatchObject({
      id: fim.analiseId,
      usuario: { id: admin.id },
      painel: 'cs',
      status: 'CONCLUIDA',
      totalPerguntas: 0,
      tokens: { entrada: 1200, saida: 450 },
    });
    const detalhe = await cliente
      .get(`/api/v1/bi/analise/${fim.analiseId}`)
      .expect(200);
    expect(detalhe.body.resultado.resumo).toBe(fim.resultado.resumo);
    expect(detalhe.body.entrada.painel).toBe('cs');
    for (const corpo of [
      r.bruto,
      JSON.stringify(estado.body),
      JSON.stringify(historico.body),
      JSON.stringify(detalhe.body),
    ]) {
      expect(corpo).not.toContain(CHAVE_FALSA);
    }
    await cliente
      .get('/api/v1/bi/analise/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('cenário 82 — R21 — link inventado pelo modelo vira o painel; filtros inválidos são 400 antes do streaming', async () => {
    const { cliente } = await montarCs();
    falso.enfileirar({
      tipo: 'resposta',
      corpo: {
        resumo: 'ok',
        destaques: [],
        riscos: [],
        acoes: [
          {
            titulo: 'x',
            detalhe: 'y',
            prioridade: 'alta',
            link: '/contatos?responsavel=00000000-0000-4000-8000-000000000000',
            rotuloLink: 'Ver',
          },
          {
            titulo: 'x',
            detalhe: 'y',
            prioridade: 'baixa',
            link: 'https://malicioso.example/roubar',
            rotuloLink: 'Ver',
          },
        ],
      },
    });
    const r = await transmitir(cliente, '/api/v1/bi/analise', { painel: 'cs' });
    const fim = r.eventos.at(-1)!;
    expect(fim.evento).toBe('concluido');
    const acoes = (fim.dados.resultado as { acoes: { link: unknown }[] }).acoes;
    expect(acoes[0].link).toEqual({
      caminho: '/contatos',
      parametros: {},
      rotulo: 'Ver',
      ajustado: true,
    });
    expect(acoes[1].link).toMatchObject({ caminho: '/bi/cs', ajustado: true });

    const invalido = await cliente
      .post('/api/v1/bi/analise', { painel: 'vendas' })
      .expect(400);
    expect(invalido.headers['content-type']).toContain('application/json');
    await cliente
      .post('/api/v1/bi/analise', { painel: 'cs', de: 'ontem' })
      .expect(400);
  });

  it('cenário 83 — R21 — pergunta de acompanhamento continua a conversa (cache) e soma os tokens; limite de 5', async () => {
    const { cliente } = await montarCs();
    const r = await transmitir(cliente, '/api/v1/bi/analise', { painel: 'cs' });
    const analiseId = r.eventos.at(-1)!.dados.analiseId as string;

    const p1 = await transmitir(
      cliente,
      `/api/v1/bi/analise/${analiseId}/perguntas`,
      { pergunta: 'Qual etapa preocupa mais?' },
    );
    const fim = p1.eventos.at(-1)!;
    expect(fim.evento).toBe('concluido');
    expect(fim.dados).toMatchObject({ tipo: 'pergunta', analiseId });
    expect((fim.dados.resposta as { resposta: string }).resposta).toContain(
      'Qual etapa preocupa mais?',
    );
    const chamada = falso.chamadas[1];
    expect(chamada.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    // Mesmo prefixo da análise (sistema e 1ª mensagem): o cache aproveita.
    expect(chamada.system).toEqual(falso.chamadas[0].system);
    expect(chamada.messages[0]).toEqual(falso.chamadas[0].messages[0]);
    expect(chamada.output_config).toEqual(falso.chamadas[0].output_config);

    const linha = await t.prisma.analiseIa.findUniqueOrThrow({
      where: { id: analiseId },
    });
    expect(linha.tokensEntrada).toBe(2400);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'bi.analise_ia_pergunta_respondida' },
      }),
    ).toBe(1);

    for (let i = 2; i <= 5; i++) {
      const p = await transmitir(
        cliente,
        `/api/v1/bi/analise/${analiseId}/perguntas`,
        {
          pergunta: `Pergunta ${i}?`,
        },
      );
      expect(p.eventos.at(-1)!.evento).toBe('concluido');
    }
    // A 5ª leva as 4 anteriores na conversa.
    expect(falso.chamadas.at(-1)!.messages).toHaveLength(2 + 4 * 2 + 1);
    // E começa igual à 1ª pergunta (prefixo estável para o cache).
    expect(falso.chamadas.at(-1)!.messages.slice(0, 3)).toEqual(
      falso.chamadas[1].messages,
    );
    const sexta = await cliente
      .post(`/api/v1/bi/analise/${analiseId}/perguntas`, {
        pergunta: 'Mais uma?',
      })
      .expect(422);
    expect(sexta.body.detalhes.regra).toBe('R21');

    const detalhe = await cliente
      .get(`/api/v1/bi/analise/${analiseId}`)
      .expect(200);
    expect(detalhe.body.perguntas).toHaveLength(5);
    expect(detalhe.body.totalPerguntas).toBe(5);
    // Perguntas não contam no limite diário.
    const estado = await cliente.get('/api/v1/bi/analise/estado').expect(200);
    expect(estado.body.usadasHoje).toBe(1);
    await cliente
      .post(
        '/api/v1/bi/analise/00000000-0000-4000-8000-000000000000/perguntas',
        {
          pergunta: 'Existe?',
        },
      )
      .expect(404);
  });

  it('cenário 84 — R21 — erro da Anthropic: evento de erro, análise FALHOU, auditada, sem contar no limite quando não gastou tokens', async () => {
    const { cliente } = await montarCs();
    falso.enfileirar({
      tipo: 'erro',
      erro: erroDaApi(401, `chave ${CHAVE_FALSA} inválida`),
    });
    const r = await transmitir(cliente, '/api/v1/bi/analise', { painel: 'cs' });
    expect(r.status).toBe(200);
    const fim = r.eventos.at(-1)!;
    expect(fim.evento).toBe('erro');
    expect(fim.dados.codigo).toBe('chave_recusada');
    expect(r.bruto).not.toContain(CHAVE_FALSA);
    expect(falso.chamadas).toHaveLength(1);
    const linha = await t.prisma.analiseIa.findFirstOrThrow();
    expect(linha.status).toBe('FALHOU');
    expect(linha.erro).not.toContain(CHAVE_FALSA);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'bi.analise_ia_falhou' },
      }),
    ).toBe(1);
    const estado = await cliente.get('/api/v1/bi/analise/estado').expect(200);
    expect(estado.body.usadasHoje).toBe(0);
    // Falha que já gastou tokens conta no limite (teto de custo); cancelada não.
    await t.prisma.analiseIa.update({
      where: { id: linha.id },
      data: { tokensSaida: 500 },
    });
    expect(
      (await cliente.get('/api/v1/bi/analise/estado').expect(200)).body
        .usadasHoje,
    ).toBe(1);
    await t.prisma.analiseIa.update({
      where: { id: linha.id },
      data: { erro: 'A análise foi cancelada.' },
    });
    expect(
      (await cliente.get('/api/v1/bi/analise/estado').expect(200)).body
        .usadasHoje,
    ).toBe(0);
    // Pergunta sobre análise que falhou: 422.
    await cliente
      .post(`/api/v1/bi/analise/${linha.id}/perguntas`, {
        pergunta: 'E agora?',
      })
      .expect(422);
  });

  it('R21 — tempo esgotado: nova tentativa (descarta o parcial) e, se esgotar de novo, erro', async () => {
    const { cliente } = await montarCs();
    falso.enfileirar({ tipo: 'travar' }, { tipo: 'resposta' });
    const r1 = await transmitir(cliente, '/api/v1/bi/analise', {
      painel: 'cs',
    });
    expect(nomes(r1.eventos)).toContain('nova_tentativa');
    expect(
      r1.eventos.find((e) => e.evento === 'nova_tentativa')!.dados,
    ).toEqual({
      tentativa: 2,
      motivo: 'tempo_esgotado',
    });
    expect(r1.eventos.at(-1)!.evento).toBe('concluido');
    expect(r1.eventos.at(-1)!.dados.tentativas).toBe(2);

    falso.enfileirar({ tipo: 'travar' }, { tipo: 'travar' });
    const r2 = await transmitir(cliente, '/api/v1/bi/analise', {
      painel: 'cs',
    });
    expect(r2.eventos.at(-1)).toEqual({
      evento: 'erro',
      dados: expect.objectContaining({ codigo: 'tempo_esgotado' }) as unknown,
    });
    const falhou = await t.prisma.analiseIa.findFirstOrThrow({
      where: { status: 'FALHOU' },
    });
    expect(falhou.tentativas).toBe(2);
  });

  it('cenário 85 — R21 — limite diário configurável pelo Admin (auditado): 429 com Retry-After; zero desliga', async () => {
    const { cliente } = await montarCs();
    const mudado = await cliente
      .put('/api/v1/bi/analise/configuracao', { limiteDiario: 1 })
      .expect(200);
    expect(mudado.body).toMatchObject({ limiteDiario: 1, restantesHoje: 1 });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'bi.analise_ia_configurada' },
      }),
    ).toBe(1);
    await cliente
      .put('/api/v1/bi/analise/configuracao', { limiteDiario: -1 })
      .expect(400);

    const r = await transmitir(cliente, '/api/v1/bi/analise', { painel: 'cs' });
    expect(r.eventos.at(-1)!.evento).toBe('concluido');
    const excedido = await cliente
      .post('/api/v1/bi/analise', { painel: 'cs' })
      .expect(429);
    expect(excedido.headers['retry-after']).toBeDefined();
    expect(excedido.body.detalhes).toMatchObject({
      regra: 'R21',
      limiteDiario: 1,
      usadasHoje: 1,
    });
    const estado = await cliente.get('/api/v1/bi/analise/estado').expect(200);
    expect(estado.body).toMatchObject({ disponivel: false, restantesHoje: 0 });
    expect(estado.body.motivo).toContain('limite');

    await cliente
      .put('/api/v1/bi/analise/configuracao', { limiteDiario: 0 })
      .expect(200);
    await cliente.post('/api/v1/bi/analise', { painel: 'cs' }).expect(429);
    expect(falso.chamadas).toHaveLength(1);
  });
});

describe('BI — análise por IA sem chave configurada (e2e)', () => {
  let t: AppTeste;
  const falso = new ClienteAnthropicFalso();

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: { ANTHROPIC_API_KEY: '' },
      ajustar: (c) => c.overrideProvider(CLIENTE_ANTHROPIC).useValue(falso),
    });
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  it('cenário 86 — R21 — o estado diz como configurar e a análise é 503, sem chamar a Anthropic', async () => {
    const admin = await criarUsuario(t, { papel: 'ADMIN' });
    const cliente = await entrarComo(t, admin);
    const estado = await cliente.get('/api/v1/bi/analise/estado').expect(200);
    expect(estado.body).toMatchObject({
      configurada: false,
      disponivel: false,
    });
    expect(estado.body.comoConfigurar).toContain('ANTHROPIC_API_KEY');
    const r = await cliente
      .post('/api/v1/bi/analise', { painel: 'comercial' })
      .expect(503);
    expect(r.body.detalhes).toMatchObject({
      regra: 'R21',
      motivo: 'nao_configurada',
    });
    expect(falso.chamadas).toHaveLength(0);
    expect(await t.prisma.analiseIa.count()).toBe(0);
  });
});
