import ExcelJS from 'exceljs';
import { criarNegocioBi, periodoDeTeste, quando } from './bi-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarAtividade,
  criarCanal,
  criarContato,
  criarEquipe,
  criarUsuario,
  entrarComo,
  funilBase,
} from './utils';
import type { Usuario } from '../src/generated/prisma/client';

const BASE = '/api/v1/indicadores';

interface Widget {
  id: string;
  indicador: string;
  ok: boolean;
  valor?: number | null;
  valorAnterior?: number | null;
  variacao?: number | null;
  linhas?: {
    id: string | null;
    rotulo: string;
    valor: number | null;
    conversao?: number | null;
    meta?: { progresso: number | null; atingida: boolean } | null;
  }[];
  pontos?: { chave: string; valor: number | null }[];
  meta?: { alvo: number; progresso: number | null; atingida: boolean } | null;
  clique?: { lista: string; filtros: Record<string, unknown> } | null;
  erro?: { mensagem: string; status: number };
}

describe('Indicadores configuráveis (R33, e2e)', () => {
  let t: AppTeste;
  let admin: Usuario;
  let cLevel: Usuario;
  let lider: Usuario;
  let v1: Usuario;
  let v2: Usuario;
  let marketing: Usuario;
  let cAdmin: ClienteHttp;
  let cLider: ClienteHttp;
  let cV1: ClienteHttp;
  let cV2: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  afterAll(() => t.fechar());

  const periodo = () => ({
    tipo: 'PERSONALIZADO',
    de: periodoDeTeste().de,
    ate: periodoDeTeste().ate,
  });

  /** Calcula widgets avulsos (quem monta painéis) sem cache. */
  async function calcular(
    cliente: ClienteHttp,
    widgets: Record<string, unknown>[],
    filtros: Record<string, unknown> = {},
  ): Promise<Widget[]> {
    const resposta = await cliente
      .post(`${BASE}/calcular`)
      .set('Cache-Control', 'no-cache')
      .send({
        widgets: widgets.map((w, i) => ({
          id: `w${i}`,
          visualizacao: 'NUMERO',
          parametros: {},
          ...w,
        })),
        filtros: { periodo: periodo(), ...filtros },
      })
      .expect(200);
    return resposta.body.widgets as Widget[];
  }

  /** Painel compartilhado com os membros: é por ele que o membro calcula (indicadores avulsos são de quem monta painéis). */
  let painelDosMembros: string | null = null;

  async function numero(
    cliente: ClienteHttp,
    indicador: string,
    parametros: Record<string, string> = {},
  ): Promise<number | null> {
    if (cliente.usuario?.papel !== 'MEMBRO') {
      const [w] = await calcular(cliente, [{ indicador, parametros }]);
      expect(w.ok).toBe(true);
      return w.valor ?? null;
    }
    const criado = await cAdmin
      .post(`${BASE}/paineis`)
      .send({
        nome: `Membros ${indicador}`,
        widgets: [{ id: 'x', indicador, visualizacao: 'NUMERO', parametros }],
        compartilhamento: { papeis: ['MEMBRO'] },
      })
      .expect(201);
    painelDosMembros = criado.body.id as string;
    const resposta = await cliente
      .post(`${BASE}/calcular`)
      .set('Cache-Control', 'no-cache')
      .send({ painelId: painelDosMembros, filtros: { periodo: periodo() } })
      .expect(200);
    const w = (resposta.body.widgets as Widget[])[0];
    expect(w.ok).toBe(true);
    return w.valor ?? null;
  }

  async function montar() {
    admin = await criarUsuario(t, { papel: 'ADMIN' });
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    ({ cLevel, lider } = equipe);
    [v1, v2] = equipe.membros as [Usuario, Usuario];
    const mkt = await criarEquipe(t, 'MARKETING', { membros: 1, cLevel });
    marketing = mkt.membros[0]!;
    cAdmin = await entrarComo(t, admin);
    cLider = await entrarComo(t, lider);
    cV1 = await entrarComo(t, v1);
    cV2 = await entrarComo(t, v2);

    const funil = await funilBase(t, 'COMERCIAL');
    const etapa = (chave: string) =>
      funil.etapas.find((e) => e.chave === chave)!;
    const n = (dados: Parameters<typeof criarNegocioBi>[1]) =>
      criarNegocioBi(t, { area: 'COMERCIAL', ...dados });
    const n1 = await n({
      etapa: 'novo',
      responsavel: v1,
      criadoEm: quando(3),
      origem: 'SITE',
    });
    const n2 = await n({
      etapa: 'qualificacao',
      responsavel: v1,
      criadoEm: quando(2),
      origem: 'SITE',
    });
    const n3 = await n({ etapa: 'novo', responsavel: v2, criadoEm: quando(1) });
    const n4 = await n({
      etapa: 'novo',
      responsavel: null,
      criadoEm: quando(1),
    });
    const n5 = await n({
      etapa: 'ganho',
      responsavel: v1,
      valor: '5000.00',
      criadoEm: quando(8),
      fechadoEm: quando(2),
    });
    const n6 = await n({
      etapa: 'ganho',
      responsavel: v2,
      valor: '3000.00',
      criadoEm: quando(6),
      fechadoEm: quando(1),
    });
    await n({
      etapa: 'perdido',
      responsavel: v2,
      criadoEm: quando(5),
      fechadoEm: quando(1),
      motivoPerda: 'Preço',
    });
    // Primeira interação (R6.7): 1 h, 3 h e 6 h depois da criação.
    const interacao = (
      id: string,
      criado: Date,
      horas: number,
      tipo: 'LIGACAO' | 'MENSAGEM',
      por: Usuario,
    ) =>
      t.prisma.negocio.update({
        where: { id },
        data: {
          primeiraInteracaoEm: new Date(criado.getTime() + horas * 3_600_000),
          primeiraInteracaoTipo: tipo,
          primeiraInteracaoPorId: por.id,
        },
      });
    await interacao(n1.id, quando(3), 1, 'LIGACAO', v1);
    await interacao(n2.id, quando(2), 3, 'MENSAGEM', v1);
    await interacao(n5.id, quando(8), 6, 'LIGACAO', v1);
    // Entradas no funil (movimentação inicial) e n2 → qualificação.
    for (const negocio of [n1, n2, n3, n4]) {
      await t.prisma.negocioMovimentacao.create({
        data: {
          negocioId: negocio.id,
          funilId: funil.id,
          deEtapaId: null,
          paraEtapaId: etapa('novo').id,
          tipoAtor: 'SISTEMA',
          criadoEm: negocio.criadoEm,
        },
      });
    }
    await t.prisma.negocioMovimentacao.create({
      data: {
        negocioId: n2.id,
        funilId: funil.id,
        deEtapaId: etapa('novo').id,
        paraEtapaId: etapa('qualificacao').id,
        tipoAtor: 'USUARIO',
        criadoEm: new Date(n2.criadoEm.getTime() + 3_600_000),
      },
    });
    void n6;

    // Reuniões.
    const reuniao = async (
      dono: Usuario,
      dias: number,
      resultado: 'COMPARECEU' | 'NAO_COMPARECEU' | 'REMARCADA' | null,
      status: 'CONCLUIDA' | 'PENDENTE' | 'CANCELADA' = 'CONCLUIDA',
    ) => {
      const inicio = quando(dias, 10);
      const atividade = await criarAtividade(t, {
        tipo: 'REUNIAO',
        responsavel: dono,
        inicioEm: inicio,
        fimEm: new Date(inicio.getTime() + 3_600_000),
        status,
      });
      await t.prisma.atividade.update({
        where: { id: atividade.id },
        data: { resultadoReuniao: resultado },
      });
    };
    await reuniao(v1, 4, 'COMPARECEU');
    await reuniao(v1, 3, 'COMPARECEU');
    await reuniao(v1, 2, 'NAO_COMPARECEU');
    await reuniao(v1, 2, 'REMARCADA');
    await reuniao(v1, 1, null, 'PENDENTE');
    await reuniao(v1, 1, null, 'CANCELADA');
    await reuniao(v2, 3, 'COMPARECEU');
    await reuniao(v2, 2, 'NAO_COMPARECEU');
    await criarAtividade(t, {
      tipo: 'TAREFA',
      responsavel: v2,
      venceEm: quando(2),
    });
    await criarAtividade(t, {
      tipo: 'TAREFA',
      responsavel: v1,
      status: 'CONCLUIDA',
    });

    // Ligações (a tabela é a mesma de qualquer provedor).
    const canal = await criarCanal(t, { tipo: 'WHATSAPP' });
    let seq = 0;
    const ligacao = async (
      atendente: Usuario,
      direcao: 'FEITA' | 'RECEBIDA',
      duracao: number | null,
    ) => {
      const contato = await criarContato(t);
      const inicio = quando(2, 11);
      await t.prisma.ligacao.create({
        data: {
          canalId: canal.id,
          contatoId: contato.id,
          direcao,
          estado: duracao === null ? 'SEM_RESPOSTA' : 'ENCERRADA',
          atendenteId: atendente.id,
          idMeta: `wacid.T3${(seq += 1)}`,
          iniciadaEm: inicio,
          atendidaEm: duracao === null ? null : inicio,
          encerradaEm: new Date(inicio.getTime() + (duracao ?? 0) * 1000),
          duracaoSegundos: duracao ?? 0,
        },
      });
    };
    await ligacao(v1, 'FEITA', 60);
    await ligacao(v1, 'FEITA', 120);
    await ligacao(v1, 'FEITA', null);
    await ligacao(v2, 'FEITA', 30);
    await ligacao(v2, 'RECEBIDA', 90);
  }

  beforeEach(async () => {
    await t.limparBanco();
    await montar();
  });

  it('R33.1 — o catálogo traz os grupos, os indicadores e o modelo, com sessão', async () => {
    await clienteAnonimo(t).get(`${BASE}/catalogo`).expect(401);
    const { body } = await cV1.get(`${BASE}/catalogo`).expect(200);
    expect(body.grupos.map((g: { chave: string }) => g.chave)).toEqual([
      'LEADS',
      'REUNIOES',
      'VENDAS',
      'LIGACOES',
      'ATIVIDADES',
    ]);
    expect(body.indicadores.length).toBeGreaterThanOrEqual(30);
    expect(body.modelos[0]).toMatchObject({ chave: 'time_comercial' });
  });

  describe('grupos de indicadores (a diretoria vê tudo)', () => {
    it('R33.1 — Leads: recebidos, atendidos, taxa, tempo (média e mediana) e sem atendimento', async () => {
      expect(await numero(cAdmin, 'leads_recebidos')).toBe(7);
      expect(await numero(cAdmin, 'leads_atendidos')).toBe(3);
      expect(await numero(cAdmin, 'taxa_atendimento')).toBe(42.86);
      expect(await numero(cAdmin, 'tempo_ate_atendimento')).toBe(12000);
      expect(
        await numero(cAdmin, 'tempo_ate_atendimento', {
          estatistica: 'MEDIANA',
        }),
      ).toBe(10800);
      // Abertos sem primeira interação, agora: n3 e n4.
      expect(await numero(cAdmin, 'leads_sem_atendimento')).toBe(2);
    });

    it('R33.1 — Reuniões: sem as canceladas; taxas só com compareceu e não compareceu', async () => {
      expect(await numero(cAdmin, 'reunioes_agendadas')).toBe(7);
      expect(await numero(cAdmin, 'reunioes_realizadas')).toBe(3);
      expect(await numero(cAdmin, 'reunioes_no_show')).toBe(2);
      expect(await numero(cAdmin, 'reunioes_remarcadas')).toBe(1);
      expect(await numero(cAdmin, 'reunioes_sem_resultado')).toBe(1);
      expect(await numero(cAdmin, 'taxa_comparecimento')).toBe(60);
      expect(await numero(cAdmin, 'taxa_no_show')).toBe(40);
    });

    it('R33.1 — Vendas: ganhos, valor, ticket, perdas, conversões, ciclo e carteira', async () => {
      expect(await numero(cAdmin, 'negocios_ganhos')).toBe(2);
      expect(await numero(cAdmin, 'valor_ganho')).toBe(8000);
      expect(await numero(cAdmin, 'ticket_medio')).toBe(4000);
      expect(await numero(cAdmin, 'negocios_perdidos')).toBe(1);
      expect(await numero(cAdmin, 'taxa_conversao')).toBe(66.67);
      expect(await numero(cAdmin, 'taxa_conversao_coorte')).toBe(28.57);
      // 6 dias e 5 dias: 5,5 dias em segundos.
      expect(await numero(cAdmin, 'ciclo_medio')).toBe(475200);
      expect(await numero(cAdmin, 'negocios_abertos')).toBe(4);
      expect(await numero(cAdmin, 'valor_em_aberto')).toBe(0);
      const [motivos] = await calcular(cAdmin, [
        {
          indicador: 'perdas_por_motivo',
          visualizacao: 'BARRAS',
          parametros: { por: 'MOTIVO' },
        },
      ]);
      expect(motivos.linhas).toEqual([
        { id: 'Preço', rotulo: 'Preço', valor: 1 },
      ]);
    });

    it('R33.1 — conversão entre etapas: número e funil (negócios que entraram no funil no período)', async () => {
      const funil = await funilBase(t, 'COMERCIAL');
      const id = (chave: string) =>
        funil.etapas.find((e) => e.chave === chave)!.id;
      expect(
        await numero(cAdmin, 'conversao_entre_etapas', {
          etapaOrigemId: id('novo'),
          etapaDestinoId: id('qualificacao'),
        }),
      ).toBe(25);
      const [w] = await calcular(cAdmin, [
        { indicador: 'conversao_entre_etapas', visualizacao: 'FUNIL' },
      ]);
      expect(
        w.linhas?.slice(0, 2).map((l) => [l.rotulo, l.valor, l.conversao]),
      ).toEqual([
        ['Novo', 4, null],
        ['Qualificação', 1, 25],
      ]);
    });

    it('R33.1 — Ligações: qualquer provedor, feitas e atendidas, taxa, duração e tempo falado', async () => {
      expect(await numero(cAdmin, 'ligacoes_feitas')).toBe(4);
      expect(await numero(cAdmin, 'ligacoes_atendidas')).toBe(3);
      expect(await numero(cAdmin, 'taxa_atendimento_ligacoes')).toBe(75);
      expect(await numero(cAdmin, 'duracao_media_ligacao')).toBe(75);
      expect(
        await numero(cAdmin, 'duracao_media_ligacao', { direcao: 'FEITA' }),
      ).toBe(70);
      expect(await numero(cAdmin, 'tempo_falado')).toBe(300);
    });

    it('R33.1 — Atividades: concluídas (com parâmetro de tipo) e atrasadas', async () => {
      expect(await numero(cAdmin, 'atividades_concluidas')).toBe(7);
      expect(
        await numero(cAdmin, 'atividades_concluidas', { tipo: 'REUNIAO' }),
      ).toBe(6);
      // Reunião de v1 pendente com início passado e a tarefa de v2 vencida.
      expect(await numero(cAdmin, 'atividades_atrasadas')).toBe(2);
    });
  });

  describe('visualizações', () => {
    it('R33.2 — número traz o período anterior de mesma duração e a variação (R20.4)', async () => {
      await criarNegocioBi(t, {
        area: 'COMERCIAL',
        etapa: 'novo',
        responsavel: v1,
        criadoEm: quando(15),
      });
      const [w] = await calcular(cAdmin, [{ indicador: 'leads_recebidos' }]);
      expect(w.valor).toBe(7);
      expect(w.valorAnterior).toBe(1);
      expect(w.variacao).toBe(600);
    });

    it('R33.2 — série por dia no fuso de São Paulo, sem buracos, e a soma bate com o número', async () => {
      const [w] = await calcular(cAdmin, [
        {
          indicador: 'leads_recebidos',
          visualizacao: 'SERIE',
          parametros: { agrupamento: 'DIA' },
        },
      ]);
      const pontos = w.pontos ?? [];
      expect(pontos.length).toBeGreaterThanOrEqual(10);
      expect(pontos.reduce((s, p) => s + (p.valor ?? 0), 0)).toBe(7);
      const mes = await calcular(cAdmin, [
        {
          indicador: 'leads_recebidos',
          visualizacao: 'SERIE',
          parametros: { agrupamento: 'MES' },
        },
      ]);
      expect(
        (mes[0].pontos ?? []).reduce((s, p) => s + (p.valor ?? 0), 0),
      ).toBe(7);
    });

    it('R33.2 — ranking por pessoa e barras por origem e por tipo', async () => {
      const [rank, origem, tipo, etapa] = await calcular(cAdmin, [
        { indicador: 'negocios_ganhos', visualizacao: 'RANKING' },
        {
          indicador: 'leads_recebidos',
          visualizacao: 'BARRAS',
          parametros: { por: 'ORIGEM' },
        },
        {
          indicador: 'atividades_concluidas',
          visualizacao: 'BARRAS',
          parametros: { por: 'TIPO' },
        },
        { indicador: 'negocios_abertos', visualizacao: 'POR_ETAPA' },
      ]);
      expect(rank.linhas?.map((l) => l.valor)).toEqual([1, 1]);
      expect(origem.linhas?.find((l) => l.rotulo === 'Site')?.valor).toBe(2);
      expect(tipo.linhas?.find((l) => l.rotulo === 'Reunião')?.valor).toBe(6);
      expect(etapa.linhas?.find((l) => l.rotulo === 'Novo')?.valor).toBe(3);
    });
  });

  describe('visibilidade (R33.4, R20.2): membro, líder e diretoria veem números diferentes', () => {
    it('R20.2 — leads: membro só o que é dele e os sem responsável; o número bate com a lista', async () => {
      expect(await numero(cV1, 'leads_recebidos')).toBe(4);
      expect(await numero(cV2, 'leads_recebidos')).toBe(4);
      expect(await numero(cLider, 'leads_recebidos')).toBe(7);
      expect(await numero(cAdmin, 'leads_recebidos')).toBe(7);
      const lista = await cV1
        .get('/api/v1/negocios')
        .query({ porPagina: 100 })
        .expect(200);
      expect(lista.body.total).toBe(4);
      expect(await numero(cV1, 'leads_sem_atendimento')).toBe(1);
      const abertos = await cV1
        .get('/api/v1/negocios')
        .query({ status: 'ABERTO', atendido: 'false', porPagina: 100 })
        .expect(200);
      expect(abertos.body.total).toBe(1);
    });

    it('R20.2 — reuniões: o número do membro bate com a lista de atividades dele; líder e diretoria veem a equipe', async () => {
      const lista = async (cliente: ClienteHttp, escopo: string) =>
        (
          await cliente
            .get('/api/v1/atividades')
            .query({
              tipo: 'REUNIAO',
              status: 'PENDENTE,CONCLUIDA',
              escopo,
              de: periodoDeTeste().de,
              ate: periodoDeTeste().ate,
              porPagina: 100,
            })
            .expect(200)
        ).body.total as number;
      expect(await numero(cV1, 'reunioes_agendadas')).toBe(5);
      expect(await lista(cV1, 'MINHAS')).toBe(5);
      expect(await numero(cV1, 'reunioes_no_show')).toBe(1);
      expect(await numero(cV1, 'taxa_comparecimento')).toBe(66.67);
      expect(await numero(cLider, 'reunioes_agendadas')).toBe(7);
      expect(await lista(cLider, 'EQUIPE')).toBe(7);
      expect(await numero(cAdmin, 'reunioes_agendadas')).toBe(7);
      expect(await lista(cAdmin, 'TODAS')).toBe(7);
    });

    it('R20.2 — vendas e ligações recortadas por quem vê', async () => {
      expect(await numero(cV1, 'taxa_conversao')).toBe(100);
      expect(await numero(cV1, 'valor_ganho')).toBe(5000);
      expect(await numero(cV2, 'valor_ganho')).toBe(3000);
      expect(await numero(cV1, 'ligacoes_feitas')).toBe(3);
      expect(await numero(cV1, 'taxa_atendimento_ligacoes')).toBe(66.67);
      expect(await numero(cV2, 'ligacoes_feitas')).toBe(1);
      expect(await numero(cV1, 'atividades_atrasadas')).toBe(1);
    });

    it('R20.2 — a conversão entre etapas do membro só conta os negócios que ele vê', async () => {
      const funil = await funilBase(t, 'COMERCIAL');
      const id = (chave: string) =>
        funil.etapas.find((e) => e.chave === chave)!.id;
      expect(
        await numero(cV1, 'conversao_entre_etapas', {
          etapaOrigemId: id('novo'),
          etapaDestinoId: id('qualificacao'),
        }),
      ).toBe(33.33);
    });

    it('R33.4 — avulsos só para quem monta painéis; o membro calcula pelo painel compartilhado', async () => {
      await cV1
        .post(`${BASE}/calcular`)
        .send({
          widgets: [{ indicador: 'leads_recebidos', visualizacao: 'NUMERO' }],
        })
        .expect(403);
      const painel = await cLider
        .post(`${BASE}/paineis`)
        .send({
          modelo: 'time_comercial',
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      const resposta = await cV1
        .post(`${BASE}/calcular`)
        .set('Cache-Control', 'no-cache')
        .send({ painelId: painel.body.id, filtros: { periodo: periodo() } })
        .expect(200);
      const leads = (resposta.body.widgets as Widget[]).find(
        (w) => w.indicador === 'leads_recebidos',
      );
      expect(leads?.valor).toBe(4);
      const dobro = await cLider
        .post(`${BASE}/calcular`)
        .set('Cache-Control', 'no-cache')
        .send({ painelId: painel.body.id, filtros: { periodo: periodo() } })
        .expect(200);
      expect(
        (dobro.body.widgets as Widget[]).find(
          (w) => w.indicador === 'leads_recebidos',
        )?.valor,
      ).toBe(7);
    });
  });

  describe('painéis: CRUD, compartilhamento e modelo (R33.6)', () => {
    it('R33.6 — o modelo "Time comercial" cria o painel com os indicadores prontos e audita', async () => {
      const { body } = await cLider
        .post(`${BASE}/paineis`)
        .send({ modelo: 'time_comercial' })
        .expect(201);
      expect(body).toMatchObject({
        nome: 'Time comercial',
        modelo: 'time_comercial',
        minha: true,
        podeEditar: true,
      });
      expect(body.widgets.length).toBeGreaterThanOrEqual(12);
      const eventos = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'indicadores.painel_criado' },
      });
      expect(eventos).toHaveLength(1);
    });

    it('R33.6 — membro não cria, edita nem exclui; e não vê painel que não foi compartilhado com ele', async () => {
      await cV1.post(`${BASE}/paineis`).send({ nome: 'Meu' }).expect(403);
      const { body } = await cLider
        .post(`${BASE}/paineis`)
        .send({ modelo: 'time_comercial' })
        .expect(201);
      expect((await cV1.get(`${BASE}/paineis`).expect(200)).body).toEqual([]);
      await cV1.get(`${BASE}/paineis/${body.id}`).expect(404);
      await cV1
        .patch(`${BASE}/paineis/${body.id}`)
        .send({ nome: 'x' })
        .expect(403);
      await cV1.delete(`${BASE}/paineis/${body.id}`).expect(403);
    });

    it('R33.6 — compartilhar por pessoa: só quem recebeu vê; quem vê não edita nem enxerga a lista de compartilhados', async () => {
      const { body } = await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'Só da Ana',
          widgets: [],
          compartilhamento: { pessoas: [v1.id] },
        })
        .expect(201);
      const visto = await cV1.get(`${BASE}/paineis/${body.id}`).expect(200);
      expect(visto.body).toMatchObject({
        podeEditar: false,
        minha: false,
        compartilhamento: null,
      });
      await cV2.get(`${BASE}/paineis/${body.id}`).expect(404);
      await cV1
        .patch(`${BASE}/paineis/${body.id}`)
        .send({ nome: 'x' })
        .expect(403);
      expect((await cV1.get(`${BASE}/paineis`).expect(200)).body).toHaveLength(
        1,
      );
      await cLider
        .patch(`${BASE}/paineis/${body.id}`)
        .send({ compartilhamento: { pessoas: [v1.id, v2.id] } })
        .expect(200);
      await cV2.get(`${BASE}/paineis/${body.id}`).expect(200);
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'indicadores.painel_compartilhado' },
      });
      expect(auditoria).toHaveLength(1);
    });

    it('R33.6 — compartilhar por papel (só Admin e C-level) e por setor', async () => {
      const { body } = await cAdmin
        .post(`${BASE}/paineis`)
        .send({
          nome: 'Para membros',
          widgets: [],
          compartilhamento: { papeis: ['MEMBRO'] },
        })
        .expect(201);
      await cV1.get(`${BASE}/paineis/${body.id}`).expect(200);
      const mkt = await entrarComo(t, marketing);
      await mkt.get(`${BASE}/paineis/${body.id}`).expect(200);
      await cLider.get(`${BASE}/paineis/${body.id}`).expect(404);
      const porSetor = await cAdmin
        .post(`${BASE}/paineis`)
        .send({
          nome: 'Comercial',
          widgets: [],
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      await cLider.get(`${BASE}/paineis/${porSetor.body.id}`).expect(200);
      await mkt.get(`${BASE}/paineis/${porSetor.body.id}`).expect(404);
    });

    it('R33.6 — o líder compartilha só com o próprio setor e pessoas dele, nunca por papel; compartilhar não amplia dados', async () => {
      const painel = { nome: 'X', widgets: [] };
      await cLider
        .post(`${BASE}/paineis`)
        .send({ ...painel, compartilhamento: { setores: ['MARKETING'] } })
        .expect(403);
      await cLider
        .post(`${BASE}/paineis`)
        .send({ ...painel, compartilhamento: { pessoas: [marketing.id] } })
        .expect(403);
      await cLider
        .post(`${BASE}/paineis`)
        .send({ ...painel, compartilhamento: { papeis: ['MEMBRO'] } })
        .expect(403);
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          ...painel,
          compartilhamento: { pessoas: [v1.id], setores: ['COMERCIAL'] },
        })
        .expect(201);
      await cLider
        .post(`${BASE}/paineis`)
        .send({ ...painel, compartilhamento: { setores: ['NAO_EXISTE'] } })
        .expect(404);
    });

    it('R33.6 — o líder edita só os seus; Admin e C-level editam todos', async () => {
      const doAdmin = await cAdmin
        .post(`${BASE}/paineis`)
        .send({
          nome: 'Do admin',
          widgets: [],
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      await cLider
        .patch(`${BASE}/paineis/${doAdmin.body.id}`)
        .send({ nome: 'Roubado' })
        .expect(403);
      await cLider.delete(`${BASE}/paineis/${doAdmin.body.id}`).expect(403);
      const doLider = await cLider
        .post(`${BASE}/paineis`)
        .send({ nome: 'Do líder', widgets: [] })
        .expect(201);
      const cC = await entrarComo(t, cLevel);
      await cC
        .patch(`${BASE}/paineis/${doLider.body.id}`)
        .send({ nome: 'Renomeado' })
        .expect(200);
      await cAdmin.delete(`${BASE}/paineis/${doLider.body.id}`).expect(204);
      await cLider.get(`${BASE}/paineis/${doLider.body.id}`).expect(404);
      const acoes = (
        await t.prisma.eventoAuditoria.findMany({
          where: { acao: { startsWith: 'indicadores.painel_' } },
        })
      ).map((e) => e.acao);
      expect(acoes).toEqual(
        expect.arrayContaining([
          'indicadores.painel_criado',
          'indicadores.painel_atualizado',
          'indicadores.painel_excluido',
        ]),
      );
    });

    it('R33.6 — duplicar copia indicadores e filtros, sem compartilhamento; membro não duplica', async () => {
      const origem = await cLider
        .post(`${BASE}/paineis`)
        .send({
          modelo: 'time_comercial',
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      await cV1
        .post(`${BASE}/paineis/${origem.body.id}/duplicar`)
        .send({})
        .expect(403);
      const copia = await cAdmin
        .post(`${BASE}/paineis/${origem.body.id}/duplicar`)
        .send({})
        .expect(201);
      expect(copia.body.nome).toBe('Time comercial (cópia)');
      expect(copia.body.widgets).toHaveLength(origem.body.widgets.length);
      expect(copia.body.compartilhamento).toEqual({
        setores: [],
        pessoas: [],
        papeis: [],
      });
      expect(copia.body.widgets[0].id).not.toBe(origem.body.widgets[0].id);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'indicadores.painel_duplicado' },
        }),
      ).toBe(1);
    });

    it('R33.6 — valida o painel: indicador inexistente, visualização que o indicador não aceita, nome vazio', async () => {
      await cLider
        .post(`${BASE}/paineis`)
        .send({ nome: ' ', widgets: [] })
        .expect(400);
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'A',
          widgets: [{ indicador: 'nada', visualizacao: 'NUMERO' }],
        })
        .expect(400);
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'A',
          widgets: [{ indicador: 'taxa_no_show', visualizacao: 'BARRAS' }],
        })
        .expect(400);
      await cLider
        .post(`${BASE}/paineis`)
        .send({ modelo: 'nao_existe' })
        .expect(400);
    });
  });

  describe('metas (R33.5)', () => {
    it('R33.5 — número com meta geral e ranking com meta por pessoa', async () => {
      const [num, rank] = await calcular(cAdmin, [
        { indicador: 'valor_ganho', meta: { geral: 16000 } },
        {
          indicador: 'valor_ganho',
          visualizacao: 'RANKING',
          meta: { porPessoa: 4000 },
        },
      ]);
      expect(num.meta).toMatchObject({
        alvo: 16000,
        progresso: 50,
        atingida: false,
      });
      expect(rank.linhas?.[0]).toMatchObject({
        rotulo: expect.any(String),
        valor: 5000,
      });
      expect(rank.linhas?.[0].meta).toMatchObject({
        progresso: 125,
        atingida: true,
      });
      expect(rank.linhas?.[1].meta).toMatchObject({
        progresso: 75,
        atingida: false,
      });
    });

    it('R33.5 — meta em visualização que não a aceita, ou negativa, é recusada ao salvar', async () => {
      const base = { nome: 'M' };
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          ...base,
          widgets: [
            {
              indicador: 'leads_recebidos',
              visualizacao: 'SERIE',
              meta: { geral: 1 },
            },
          ],
        })
        .expect(400);
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          ...base,
          widgets: [
            {
              indicador: 'leads_recebidos',
              visualizacao: 'NUMERO',
              meta: { geral: -5 },
            },
          ],
        })
        .expect(400);
      const ok = await cLider
        .post(`${BASE}/paineis`)
        .send({
          ...base,
          widgets: [
            {
              indicador: 'leads_recebidos',
              visualizacao: 'NUMERO',
              meta: { geral: 10 },
            },
          ],
        })
        .expect(201);
      expect(ok.body.widgets[0].meta).toEqual({ geral: 10 });
    });
  });

  describe('filtros (R33.3, R20.3)', () => {
    it('R33.3 — pessoa, origem, UTM e etiquetas reduzem o número; filtro do widget vence o do painel', async () => {
      // Os três negócios de v1; o sem responsável não é dele.
      expect(await calcularCom(cAdmin, { pessoaIds: [v1.id] })).toBe(3);
      expect(await calcularCom(cAdmin, { origens: ['SITE'] })).toBe(2);
      // A equipe do líder (ele e os liderados) não inclui o negócio sem responsável.
      expect(await calcularCom(cAdmin, { equipeId: lider.id })).toBe(6);
      expect(await calcularCom(cAdmin, { utmSource: ['inexistente'] })).toBe(0);
      expect(await calcularCom(cAdmin, { etiquetas: ['vip'] })).toBe(0);
      const [w] = await calcular(
        cAdmin,
        [{ indicador: 'leads_recebidos', filtros: { origens: ['SITE'] } }],
        { origens: ['WEBHOOK'] },
      );
      expect(w.valor).toBe(2);
    });

    async function calcularCom(
      cliente: ClienteHttp,
      filtros: Record<string, unknown>,
    ) {
      const [w] = await calcular(
        cliente,
        [{ indicador: 'leads_recebidos' }],
        filtros,
      );
      return w.valor;
    }

    it('R33.3 — funil e etapa filtram; funil de outra área dá 404 e pessoa de outra área, 404', async () => {
      const comercial = await funilBase(t, 'COMERCIAL');
      expect(await calcularCom(cAdmin, { funilIds: [comercial.id] })).toBe(7);
      const novo = comercial.etapas.find((e) => e.chave === 'novo')!;
      expect(await calcularCom(cAdmin, { etapaIds: [novo.id] })).toBe(3);
      const funilMkt = await funilBase(t, 'MARKETING');
      await cV1
        .post(`${BASE}/calcular`)
        .send({
          widgets: [],
          filtros: { funilIds: [funilMkt.id] },
          painelId: undefined,
        })
        .expect(403);
      const painel = await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'F',
          widgets: [],
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      await cV1
        .post(`${BASE}/calcular`)
        .send({
          painelId: painel.body.id,
          filtros: { funilIds: [funilMkt.id] },
        })
        .expect(404);
      await cV1
        .post(`${BASE}/calcular`)
        .send({
          painelId: painel.body.id,
          filtros: { pessoaIds: [marketing.id] },
        })
        .expect(404);
      await cV1
        .post(`${BASE}/calcular`)
        .send({ painelId: painel.body.id, filtros: { setor: 'MARKETING' } })
        .expect(403);
      await cLider
        .post(`${BASE}/calcular`)
        .send({
          widgets: [],
          filtros: {
            equipeId: (
              await criarEquipe(t, 'MARKETING', { membros: 0, cLevel })
            ).lider.id,
          },
        })
        .expect(403);
    });

    it('R33.3 — salvar painel com filtro fora do alcance de quem salva é recusado', async () => {
      const funilMkt = await funilBase(t, 'MARKETING');
      await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'F',
          widgets: [],
          filtrosPadrao: { funilIds: [funilMkt.id] },
        })
        .expect(404);
    });

    it('R20.3 — período de mais de 366 dias ou invertido é recusado', async () => {
      const [mal] = [
        await cAdmin.post(`${BASE}/calcular`).send({
          widgets: [],
          filtros: {
            periodo: {
              tipo: 'PERSONALIZADO',
              de: '2025-01-01T00:00:00Z',
              ate: '2026-11-01T00:00:00Z',
            },
          },
        }),
      ];
      expect(mal.status).toBe(400);
      const invertido = await cAdmin.post(`${BASE}/calcular`).send({
        widgets: [],
        filtros: {
          periodo: {
            tipo: 'PERSONALIZADO',
            de: '2026-11-10T00:00:00Z',
            ate: '2026-11-01T00:00:00Z',
          },
        },
      });
      expect(invertido.status).toBe(400);
    });

    it('R33.3 — períodos predefinidos funcionam', async () => {
      for (const tipo of [
        'HOJE',
        'ULTIMOS_7_DIAS',
        'ULTIMOS_30_DIAS',
        'MES_ATUAL',
        'MES_ANTERIOR',
        'TRIMESTRE',
        'ANO',
      ]) {
        const r = await cAdmin
          .post(`${BASE}/calcular`)
          .set('Cache-Control', 'no-cache')
          .send({
            widgets: [{ indicador: 'leads_recebidos', visualizacao: 'NUMERO' }],
            filtros: { periodo: { tipo } },
          })
          .expect(200);
        expect(r.body.widgets[0].ok).toBe(true);
      }
      const trinta = await cAdmin
        .post(`${BASE}/calcular`)
        .send({
          widgets: [{ indicador: 'leads_recebidos', visualizacao: 'NUMERO' }],
          filtros: { periodo: { tipo: 'ULTIMOS_30_DIAS' } },
        })
        .expect(200);
      expect(trinta.body.widgets[0].valor).toBe(7);
    });
  });

  describe('cálculo por widget, cache e cliques', () => {
    it('R33.7 — o erro de um widget não derruba os outros', async () => {
      const [bom, ruim] = await calcular(cAdmin, [
        { indicador: 'leads_recebidos' },
        {
          indicador: 'conversao_entre_etapas',
          parametros: {
            etapaOrigemId: '3f1f3a52-9a53-4d63-a7a3-5c8e0f6f2f10',
            etapaDestinoId: '3f1f3a52-9a53-4d63-a7a3-5c8e0f6f2f11',
          },
        },
      ]);
      expect(bom).toMatchObject({ ok: true, valor: 7 });
      expect(ruim).toMatchObject({ ok: false, erro: { status: 404 } });
    });

    it('R20.6 — cache de 30 s por pessoa e filtros; Cache-Control: no-cache recalcula', async () => {
      const corpo = {
        widgets: [{ indicador: 'leads_recebidos', visualizacao: 'NUMERO' }],
        filtros: { periodo: periodo() },
      };
      const primeira = await cAdmin
        .post(`${BASE}/calcular`)
        .set('Cache-Control', 'no-cache')
        .send(corpo)
        .expect(200);
      await criarNegocioBi(t, {
        area: 'COMERCIAL',
        etapa: 'novo',
        responsavel: v1,
        criadoEm: quando(1),
      });
      const guardada = await cAdmin
        .post(`${BASE}/calcular`)
        .send(corpo)
        .expect(200);
      expect(guardada.body.geradoEm).toBe(primeira.body.geradoEm);
      const nova = await cAdmin
        .post(`${BASE}/calcular`)
        .set('Cache-Control', 'no-cache')
        .send(corpo)
        .expect(200);
      expect(nova.body.widgets[0].valor).toBe(8);
    });

    it('R20.8 — o clique descreve a lista que sustenta o número, e some quando o filtro a tornaria diferente', async () => {
      const [aberto, noshow, comOrigem] = await calcular(cAdmin, [
        { indicador: 'leads_sem_atendimento' },
        { indicador: 'reunioes_no_show' },
        { indicador: 'reunioes_no_show', filtros: { origens: ['SITE'] } },
      ]);
      expect(aberto.clique).toEqual({
        lista: 'NEGOCIOS',
        filtros: { status: 'ABERTO', atendido: false },
      });
      expect(noshow.clique?.lista).toBe('ATIVIDADES');
      expect(noshow.clique?.filtros).toMatchObject({
        tipo: ['REUNIAO'],
        resultadoReuniao: ['NAO_COMPARECEU'],
      });
      expect(comOrigem.clique).toBeNull();
    });

    it('R33.7 — pedir sem painel nem indicadores é 400, painel desconhecido 404, sem sessão 401', async () => {
      await cAdmin.post(`${BASE}/calcular`).send({}).expect(400);
      await cAdmin
        .post(`${BASE}/calcular`)
        .send({ painelId: '3f1f3a52-9a53-4d63-a7a3-5c8e0f6f2f10' })
        .expect(404);
      await clienteAnonimo(t).post(`${BASE}/calcular`).send({}).expect(401);
    });
  });

  describe('exportação (R33.7)', () => {
    async function baixar(cliente: ClienteHttp, url: string): Promise<Buffer> {
      const resposta = await cliente
        .get(url)
        .buffer(true)
        .parse((res, fim) => {
          const partes: Buffer[] = [];
          res.on('data', (parte: Buffer) => partes.push(parte));
          res.on('end', () => fim(null, Buffer.concat(partes)));
        })
        .expect(200);
      return resposta.body as Buffer;
    }

    it('R33.7 — CSV com os números de quem exporta (membro vê o dele) e auditoria', async () => {
      const painel = await cLider
        .post(`${BASE}/paineis`)
        .send({
          nome: 'Exp',
          widgets: [
            {
              indicador: 'leads_recebidos',
              visualizacao: 'NUMERO',
              titulo: 'Leads',
            },
          ],
          compartilhamento: { setores: ['COMERCIAL'] },
        })
        .expect(201);
      const resposta = await cV1
        .post(`${BASE}/exportar`)
        .send({
          painelId: painel.body.id,
          filtros: { periodo: periodo() },
          formato: 'csv',
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        contexto: 'RELATORIO',
        mime: 'text/csv',
      });
      const csv = (await baixar(cV1, resposta.body.url)).toString('utf8');
      expect(csv.startsWith('﻿Indicador;Valor;')).toBe(true);
      expect(csv).toContain('Leads;4;');
      const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'indicadores.exportado' },
      });
      expect(evento.dados).toMatchObject({
        formato: 'csv',
        painelId: painel.body.id,
      });
    });

    it('R33.7 — XLSX com o resumo e uma aba por indicador que não é número; widgetId exporta uma só; formato inválido é recusado', async () => {
      const resposta = await cAdmin
        .post(`${BASE}/exportar`)
        .send({
          widgets: [
            {
              id: 'a',
              indicador: 'leads_recebidos',
              visualizacao: 'NUMERO',
              titulo: 'Leads',
            },
            {
              id: 'b',
              indicador: 'negocios_ganhos',
              visualizacao: 'RANKING',
              titulo: 'Ganhos por pessoa',
            },
          ],
          filtros: { periodo: periodo() },
          formato: 'xlsx',
        })
        .expect(200);
      const livro = new ExcelJS.Workbook();
      await livro.xlsx.load((await baixar(cAdmin, resposta.body.url)) as never);
      expect(livro.worksheets.map((s) => s.name)).toEqual([
        'Indicadores',
        'Ganhos por pessoa',
        'Período',
      ]);
      expect(livro.getWorksheet('Ganhos por pessoa')!.rowCount).toBe(3);
      const csv = await cAdmin
        .post(`${BASE}/exportar`)
        .send({
          widgets: [
            { id: 'b', indicador: 'negocios_ganhos', visualizacao: 'RANKING' },
          ],
          filtros: { periodo: periodo() },
          formato: 'csv',
          widgetId: 'b',
        })
        .expect(200);
      expect((await baixar(cAdmin, csv.body.url)).toString('utf8')).toContain(
        'Pessoa;Valor',
      );
      await cAdmin
        .post(`${BASE}/exportar`)
        .send({ widgets: [], formato: 'pdf' })
        .expect(400);
      await cAdmin
        .post(`${BASE}/exportar`)
        .send({
          widgets: [
            { id: 'a', indicador: 'leads_recebidos', visualizacao: 'NUMERO' },
          ],
          formato: 'csv',
          widgetId: 'a',
        })
        .expect(400);
    });
  });
});
