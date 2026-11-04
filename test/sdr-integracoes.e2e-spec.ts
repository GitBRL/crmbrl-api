import { OPCOES_CHAMADA_CLAUDE } from '../src/bi/analise/chamada-claude.service';
import { CLIENTE_ANTHROPIC } from '../src/bi/analise/cliente-anthropic';
import { OPCOES_SDR } from '../src/sdr/opcoes-sdr';
import {
  type AdaptadorFalso,
  type CenarioDoAtendimento,
  drenarEnvios,
  montarCenario,
  receberDoContato,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import { cartao, consultarPainel, linhasDa } from './bi-apoio';
import { SdrAnthropicFalso } from './sdr-apoio';
import { FILA_ENTREGAR, ServidorDeTeste } from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  avancarPassos,
  clienteAnonimo,
  criarAppTeste,
  criarCanal,
  drenarFilas,
  drenarTudo,
  entrarComo,
  processarEventos,
} from './utils';

const CHAVE_FALSA = 'sk-ant-chave-falsa-do-sdr-0123456789';
const API = '/api/v1/sdr';

/**
 * SDR com IA, fechamento da Onda G (G3): BI, webhook de saída, gatilho de
 * automação, filtro "atendidas pela IA" na lista de conversas e matriz de acesso
 * (R31.22 a R31.25).
 */
describe('SDR com IA: integrações, BI e acesso (e2e)', () => {
  let t: AppTeste;
  const falso = new SdrAnthropicFalso();
  const servidor = new ServidorDeTeste();
  let desfazer: () => void = () => undefined;
  let adaptador: AdaptadorFalso;
  let c: CenarioDoAtendimento;
  let admin: ClienteHttp;

  beforeAll(async () => {
    await servidor.iniciar();
    t = await criarAppTeste({
      variaveis: {
        ANTHROPIC_API_KEY: CHAVE_FALSA,
        WEBHOOKS_PERMITIR_REDE_INTERNA: 'true',
      },
      ajustar: (b) =>
        b
          .overrideProvider(CLIENTE_ANTHROPIC)
          .useValue(falso)
          .overrideProvider(OPCOES_CHAMADA_CLAUDE)
          .useValue({ timeoutMs: 400, esperaMs: 5, tentativas: 2 })
          .overrideProvider(OPCOES_SDR)
          .useValue({
            simularDigitacao: false,
            digitandoPorCaractereMs: 0,
            digitandoMinimoMs: 0,
            digitandoMaximoMs: 0,
          }),
    });
  });
  afterAll(async () => {
    await t.fechar();
    await servidor.parar();
  });

  beforeEach(async () => {
    await t.limparBanco();
    falso.limpar();
    servidor.limpar();
    desfazer();
    ({ adaptador, desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
    c = await montarCenario(t);
    admin = await entrarComo(t, c.admin);
    await admin
      .put(`${API}/configuracao`)
      .send({ esperaAgrupamentoSegundos: 0 })
      .expect(200);
    await admin
      .put(`${API}/canais/${c.canal.id}`)
      .send({ modo: 'AUTOMATICO' })
      .expect(200);
  });
  afterEach(() => desfazer());

  async function lead(texto: string, de = 'v-1', nome = 'Maria Souza') {
    const r = await receberDoContato(t, c.canal, { texto, de, nome });
    await drenarTudo(t);
    await drenarEnvios(t);
    return r;
  }

  async function qualificar(de = 'v-1', nome = 'Maria Souza') {
    const r = await lead(
      'Oi! curso: Enfermagem, cidade: Recife, quero me matricular',
      de,
      nome,
    );
    return r.conversaId;
  }

  it('cenário 303 — R31.22 — sdr.lead_qualificado e sdr.lead_desqualificado no webhook de saída, sem o histórico da conversa', async () => {
    const eventos = await admin
      .get('/api/v1/webhooks/saidas/eventos')
      .expect(200);
    const nomes = (eventos.body as { evento: string }[]).map((e) => e.evento);
    expect(nomes).toEqual(
      expect.arrayContaining([
        'sdr.lead_qualificado',
        'sdr.lead_desqualificado',
      ]),
    );
    const destino = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'SDR',
        url: `${servidor.url}/sdr`,
        eventos: ['sdr.lead_qualificado', 'sdr.lead_desqualificado'],
      })
      .expect(201);
    expect(destino.body.webhook.id).toBeDefined();

    const conversaId = await qualificar();
    falso.responder({
      resposta: 'Obrigada pelo interesse!',
      acao: 'desqualificado',
      motivo: 'Quer um curso que não oferecemos.',
      resumo: 'Lead quer Astronomia.',
    });
    const outra = await lead('Quero Astronomia', 'v-2', 'João Lima');
    await processarEventos(t);
    await drenarFilas(t, FILA_ENTREGAR);
    expect(servidor.recebidos).toHaveLength(2);
    const envelopes = servidor.recebidos.map(
      (r) =>
        JSON.parse(r.corpo) as {
          evento: string;
          dados: Record<string, any>;
        },
    );
    const q = envelopes.find((e) => e.evento === 'sdr.lead_qualificado')!;
    const estado = await t.prisma.sdrConversa.findUniqueOrThrow({
      where: { conversaId },
    });
    expect(q.dados).toMatchObject({
      conversaId,
      contato: { nome: 'Maria Souza' },
      negocio: { id: estado.negocioId },
      negocioId: estado.negocioId,
      canalId: c.canal.id,
      canalTipo: 'WEBCHAT',
      nota: 100,
      temperatura: 'QUENTE',
    });
    expect(q.dados.vendedor.nome).toEqual(expect.any(String));
    expect(q.dados.resumo).toEqual(expect.any(String));
    expect(q.dados.criterios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chave: 'curso', valor: 'Enfermagem' }),
      ]),
    );
    const d = envelopes.find((e) => e.evento === 'sdr.lead_desqualificado')!;
    expect(d.dados).toMatchObject({
      conversaId: outra.conversaId,
      contato: { nome: 'João Lima' },
      motivo: 'Quer um curso que não oferecemos.',
      resumo: 'Lead quer Astronomia.',
      temperatura: 'FRIO',
      negocioId: null,
    });
    // Nunca o histórico da conversa nem dados de contato além do nome.
    for (const e of envelopes) {
      expect(Object.keys(e.dados)).not.toEqual(
        expect.arrayContaining(['mensagens']),
      );
      expect(JSON.stringify(e)).not.toContain('Quero Astronomia');
      expect(JSON.stringify(e)).not.toContain('quero me matricular');
    }
  });

  it('cenário 304 — R31.23 — gatilho "Lead qualificado pela IA" com filtro de temperatura e canal', async () => {
    const catalogo = await admin.get('/api/v1/automacoes/catalogo').expect(200);
    expect(JSON.stringify(catalogo.body)).toContain('sdr.lead_qualificado');
    const criar = async (nome: string, gatilhoConfig: object) => {
      const r = await admin
        .post('/api/v1/automacoes', {
          nome,
          tipoGatilho: 'EVENTO',
          evento: 'sdr.lead_qualificado',
          gatilhoConfig,
          definicao: {
            passos: [
              {
                id: 'p1',
                tipo: 'acao.etiquetar',
                config: { adicionar: ['qualificado-ia'] },
              },
            ],
          },
        })
        .expect(201);
      expect(r.body.entidade).toBe('negocio');
      await admin.post(`/api/v1/automacoes/${r.body.id}/ativar`).expect(200);
      return r.body.id as string;
    };
    const quente = await criar('Quente', { temperatura: 'QUENTE' });
    const frio = await criar('Frio', { temperatura: ['FRIO', 'MORNO'] });
    const canalCerto = await criar('Canal', {
      canalTipo: 'WEBCHAT',
      canalId: c.canal.id,
    });
    const outroCanal = await criar('Outro canal', {
      canalId: '00000000-0000-4000-8000-000000000001',
    });
    const invalida = await admin.post('/api/v1/automacoes', {
      nome: 'Inválida',
      tipoGatilho: 'EVENTO',
      evento: 'sdr.lead_qualificado',
      gatilhoConfig: { temperatura: 'MUITO_QUENTE' },
      definicao: { passos: [] },
    });
    expect([400, 422]).toContain(invalida.status);

    await qualificar();
    for (let i = 0; i < 6; i++) {
      await processarEventos(t);
      await avancarPassos(t);
    }
    const execucoes = (id: string) =>
      t.prisma.execucao.count({ where: { automacaoId: id } });
    expect(await execucoes(quente)).toBe(1);
    expect(await execucoes(canalCerto)).toBe(1);
    expect(await execucoes(frio)).toBe(0);
    expect(await execucoes(outroCanal)).toBe(0);
  });

  it('cenário 305 — R31.24 — BI do SDR: atendidas, qualificadas, desqualificadas, passadas por motivo, primeira resposta, conversão e tokens, por canal e por dia', async () => {
    const q = await qualificar('v-1', 'Ana');
    const estadoQ = await t.prisma.sdrConversa.findUniqueOrThrow({
      where: { conversaId: q },
    });
    await t.prisma.negocio.update({
      where: { id: estadoQ.negocioId ?? '' },
      data: { status: 'GANHO' },
    });
    falso.responder({
      resposta: 'Obrigada!',
      acao: 'desqualificado',
      motivo: 'Fora do catálogo.',
      resumo: 'x',
    });
    await lead('Quero Astronomia', 'v-2', 'Bia');
    falso.responder({
      resposta: 'Vou chamar uma pessoa.',
      acao: 'passar_humano',
      motivo: 'O lead pediu para falar com uma pessoa.',
      resumo: 'y',
    });
    await lead('Quero falar com alguém', 'v-3', 'Caio');
    await lead('Oi, tudo bem?', 'v-4', 'Dani');

    const painel = await consultarPainel(admin, 'sdr');
    expect(cartao(painel, 'atendidas').valor).toBe(4);
    expect(cartao(painel, 'qualificadas').valor).toBe(1);
    expect(cartao(painel, 'desqualificadas').valor).toBe(1);
    expect(cartao(painel, 'passadas').valor).toBe(1);
    expect(cartao(painel, 'negociosGanhos').valor).toBe(1);
    expect(cartao(painel, 'conversao').valor).toBe(100);
    expect(cartao(painel, 'emAtendimento').valor).toBe(1);
    expect(cartao(painel, 'primeiraResposta').valor).not.toBeNull();
    expect(cartao(painel, 'tokens').valor).toBeGreaterThan(0);
    expect(cartao(painel, 'tokensPorConversa').valor).toBeGreaterThan(0);
    const motivos = linhasDa(painel, 'passagensPorMotivo');
    expect(motivos).toEqual([
      expect.objectContaining({
        categoria: 'pedido_humano',
        total: 1,
        percentual: 100,
      }),
    ]);
    const canais = linhasDa(painel, 'porCanal');
    expect(canais).toHaveLength(1);
    expect(canais[0]).toMatchObject({
      id: c.canal.id,
      modo: 'AUTOMATICO',
      atendidas: 4,
      qualificadas: 1,
      desqualificadas: 1,
      passadas: 1,
      conversao: 100,
    });
    expect(Number(canais[0]!.tokens)).toBeGreaterThan(0);
    const dias = linhasDa(painel, 'porDia');
    const soma = (chave: string) =>
      dias.reduce((s, d) => s + Number(d[chave]), 0);
    expect(soma('atendidas')).toBe(4);
    expect(soma('qualificadas')).toBe(1);
    expect(soma('passadas')).toBe(1);
    expect(soma('tokens')).toBe(Number(canais[0]!.tokens));

    // Filtro de canal: outro canal não tem nada.
    const outro = await criarCanal(t, { tipo: 'WHATSAPP', nome: 'Outro' });
    const vazio = await consultarPainel(admin, 'sdr', { canalId: outro.id });
    expect(cartao(vazio, 'atendidas').valor).toBe(0);
    expect(cartao(vazio, 'conversao').valor).toBeNull();

    // Visibilidade: quem não vê conversas não vê o painel; o custo é só da diretoria.
    const marketing = await entrarComo(t, c.marketing);
    await consultarPainel(marketing, 'sdr', {}, 403);
    const cLevel = await entrarComo(t, c.comercial.cLevel);
    expect(
      cartao(await consultarPainel(cLevel, 'sdr'), 'atendidas').valor,
    ).toBe(4);
    const membro = await entrarComo(t, c.comercial.membros[0]);
    const doMembro = await consultarPainel(membro, 'sdr');
    expect(doMembro.cartoes.map((x) => x.chave)).not.toContain('tokens');
    expect(doMembro.meta).toMatchObject({ custoEmTokens: false });
    expect(doMembro.tabelas.porCanal.colunas.map((x) => x.chave)).not.toContain(
      'tokens',
    );
    expect(Number(cartao(doMembro, 'atendidas').valor)).toBeLessThanOrEqual(4);
    const lista = await membro.get('/api/v1/bi/paineis').expect(200);
    expect(lista.body.paineis).toContain('sdr');
    const csMembro = await entrarComo(t, c.cs.membros[0]);
    expect(
      cartao(await consultarPainel(csMembro, 'sdr'), 'atendidas').valor,
    ).toBe(0);
  });

  it('cenário 306 — R31.25 — a lista de conversas filtra as atendidas pela IA, pelo modo e pela situação', async () => {
    const q = await qualificar('v-1', 'Ana');
    const outra = await lead('Oi', 'v-2', 'Bia');
    await admin
      .put(`${API}/canais/${c.canal.id}`)
      .send({ modo: 'DESLIGADO' })
      .expect(200);
    const semIa = await lead('Olá', 'v-3', 'Caio');
    const ids = async (consulta: Record<string, unknown>) =>
      (
        (
          await admin
            .get('/api/v1/atendimento/conversas')
            .query({ status: 'ABERTA,PENDENTE,RESOLVIDA', ...consulta })
            .expect(200)
        ).body.itens as { id: string }[]
      )
        .map((i) => i.id)
        .sort();
    expect(await ids({ atendidasPelaIa: true })).toEqual(
      [q, outra.conversaId].sort(),
    );
    expect(await ids({ atendidasPelaIa: false })).toEqual([semIa.conversaId]);
    expect(await ids({ sdrModo: 'AUTOMATICO' })).toEqual(
      [q, outra.conversaId].sort(),
    );
    expect(await ids({ sdrModo: 'SUGESTAO' })).toEqual([]);
    expect(await ids({ sdrSituacao: 'ATIVA' })).toEqual([outra.conversaId]);
    expect(await ids({ sdrSituacao: 'QUALIFICADA' })).toEqual([q]);
    expect(await ids({ sdrSituacao: 'ATIVA,QUALIFICADA' })).toHaveLength(2);
    await admin
      .get('/api/v1/atendimento/conversas')
      .query({ sdrModo: 'X' })
      .expect(400);
    // O total da paginação respeita o filtro e a visibilidade (R12).
    const membro = await entrarComo(t, c.comercial.membros[0]);
    const doMembro = await membro
      .get('/api/v1/atendimento/conversas')
      .query({ atendidasPelaIa: true, escopo: 'TODAS' })
      .expect(200);
    for (const item of doMembro.body.itens as { sdr: unknown }[]) {
      expect(item.sdr).not.toBeNull();
    }
  });

  /** Quem não pode ver a conversa: Marketing nem usa o Atendimento (403); a área errada não a enxerga (404). */
  const semAcesso = (papel: string) => (papel === 'MARKETING' ? 403 : 404);

  it('cenário 307 — R31.15, R31.22 — matriz de acesso das rotas do SDR por papel', async () => {
    const q = await qualificar('v-1', 'Ana');
    const aberta = await lead('Oi', 'v-2', 'Bia');
    const papeis: [
      string,
      Awaited<ReturnType<typeof entrarComo>>,
      boolean,
      boolean,
    ][] = [
      ['ADMIN', admin, true, true],
      ['C_LEVEL', await entrarComo(t, c.comercial.cLevel), false, true],
      ['LIDER_COMERCIAL', await entrarComo(t, c.comercial.lider), false, true],
      ['COMERCIAL', await entrarComo(t, c.comercial.membros[0]), false, true],
      ['CS', await entrarComo(t, c.cs.membros[0]), false, false],
      ['MARKETING', await entrarComo(t, c.marketing), false, false],
    ];
    const rotasDeConfiguracao = [
      'configuracao',
      'canais',
      'artigos',
      'criterios',
      'campos-disponiveis',
      'uso',
      'decisoes',
    ];
    for (const [papel, cliente, configura, veConversa] of papeis) {
      for (const rota of rotasDeConfiguracao) {
        await cliente
          .get(`${API}/${rota}`)
          .expect(configura ? 200 : 403)
          .catch((e: Error) => {
            throw new Error(`${papel} GET ${rota}: ${e.message}`);
          });
      }
      // Conversa sem responsável na fila comercial (a IA atende): quem a vê, vê o estado do SDR.
      const r = await cliente.get(`${API}/conversas/${aberta.conversaId}`);
      expect([papel, r.status]).toEqual([
        papel,
        veConversa ? 200 : semAcesso(papel),
      ]);
      // Cartão de qualificação: segue a visibilidade das telas (contato).
      const contato = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: q },
        select: { contatoId: true },
      });
      const cartaoDoContato = await cliente.get(
        `${API}/contatos/${contato.contatoId}/qualificacao`,
      );
      if (configura) {
        expect(cartaoDoContato.status).toBe(200);
      }
    }
    // Assumir e Devolver: quem vê a conversa pode; quem não vê, não.
    for (const [papel, cliente, , veConversa] of papeis) {
      const assumir = await cliente.post(
        `${API}/conversas/${aberta.conversaId}/assumir`,
      );
      expect([papel, assumir.status]).toEqual([
        papel,
        veConversa ? 200 : semAcesso(papel),
      ]);
      const devolver = await cliente.post(
        `${API}/conversas/${aberta.conversaId}/devolver`,
      );
      expect([papel, devolver.status]).toEqual([
        papel,
        veConversa ? 200 : semAcesso(papel),
      ]);
    }
    // Sem sessão: 401.
    await clienteAnonimo(t)
      .get(`${API}/conversas/${aberta.conversaId}`)
      .expect(401);
  });
});
