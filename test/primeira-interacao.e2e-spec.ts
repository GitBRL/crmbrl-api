import { MotorDoAtendimento } from '../src/atendimento/motor-do-atendimento.service';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { registrarPrimeiraInteracao } from '../src/funis/primeira-interacao';
import {
  type CenarioDoAtendimento,
  montarCenario,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarConversa,
  criarMensagem,
  criarNegocio,
  entrarComo,
} from './utils';

const BASE = '/api/v1/atendimento';
const horas = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

/** R6.7 — primeira interação humana do negócio. */
describe('Negócios — primeira interação (e2e)', () => {
  let t: AppTeste;
  let cenario: CenarioDoAtendimento;
  const desfazeres: Array<() => void> = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    cenario = await montarCenario(t);
    desfazeres.push(usarAdaptadorFalso(t, 'WEBCHAT').desfazer);
    desfazeres.push(usarAdaptadorFalso(t, 'EMAIL').desfazer);
  });
  afterEach(() => {
    for (const desfazer of desfazeres.splice(0).reverse()) {
      desfazer();
    }
  });
  afterAll(() => t.fechar());

  const ana = () => cenario.comercial.membros[0]!;
  const primeira = async (id: string) =>
    (await t.prisma.negocio.findUniqueOrThrow({ where: { id } }))
      .primeiraInteracaoEm;

  async function conversaComNegocio(
    opcoes: { canal?: typeof cenario.canal } = {},
  ) {
    const contato = await criarContato(t);
    const negocio = await criarNegocio(t, { contato, responsavel: ana() });
    const conversa = await criarConversa(t, {
      canal: opcoes.canal ?? cenario.canal,
      fila: cenario.fila,
      responsavel: ana(),
      contato,
    });
    await criarMensagem(t, { conversa, texto: 'Oi' });
    return { contato, negocio, conversa };
  }

  it('R6.7 — mensagem enviada por uma pessoa grava a primeira interação uma única vez, e a segunda ação não muda nada', async () => {
    const { negocio, conversa } = await conversaComNegocio();
    expect(await primeira(negocio.id)).toBeNull();
    const cliente = await entrarComo(t, ana());
    await cliente
      .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Olá!' })
      .expect(201);
    const gravado = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: negocio.id },
    });
    expect(gravado).toMatchObject({
      primeiraInteracaoTipo: 'MENSAGEM',
      primeiraInteracaoPorId: ana().id,
    });
    expect(gravado.primeiraInteracaoEm).not.toBeNull();

    // Uma atividade concluída depois não sobrescreve.
    const atividade = await cliente
      .post('/api/v1/atividades', {
        tipo: 'TAREFA',
        titulo: 'Ligar',
        negocioId: negocio.id,
        concluida: true,
      })
      .expect(201);
    expect(atividade.body.status).toBe('CONCLUIDA');
    const depois = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: negocio.id },
    });
    expect(depois.primeiraInteracaoEm).toEqual(gravado.primeiraInteracaoEm);
    expect(depois.primeiraInteracaoTipo).toBe('MENSAGEM');
  });

  it('R6.7 — mensagem de bot, automação ou sistema (sem autor) não conta', async () => {
    const { negocio, conversa } = await conversaComNegocio();
    const atual = await t.prisma.conversa.findUniqueOrThrow({
      where: { id: conversa.id },
    });
    await executarComoAtor(
      { tipoAtor: 'AUTOMACAO', descricao: 'Chatbot' },
      () =>
        t.prisma.$transaction((tx) =>
          t.get(MotorDoAtendimento).criarSaida(tx, atual, cenario.canal, {
            texto: 'Sou o bot',
            autorId: null,
          }),
        ),
    );
    expect(await primeira(negocio.id)).toBeNull();
    // Nem a função aceita registrar sem pessoa.
    await t.prisma.$transaction((tx) =>
      registrarPrimeiraInteracao(tx, {
        contatoId: conversa.contatoId,
        tipo: 'MENSAGEM',
        usuarioId: null,
      }),
    );
    expect(await primeira(negocio.id)).toBeNull();
  });

  it('R6.7 — mensagem pelo canal de e-mail grava o tipo EMAIL', async () => {
    const canalEmail = await t.prisma.canal.create({
      data: { tipo: 'EMAIL', nome: 'Caixa', idExterno: 'vendas@brl.test' },
    });
    const { negocio, conversa } = await conversaComNegocio({
      canal: canalEmail,
    });
    const cliente = await entrarComo(t, ana());
    await cliente
      .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Segue' })
      .expect(201);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: negocio.id } }))
        .primeiraInteracaoTipo,
    ).toBe('EMAIL');
  });

  it('R6.7 — atividade concluída conta (menos NOTA); a pendente e a nota não', async () => {
    const contato = await criarContato(t);
    const negocio = await criarNegocio(t, { contato, responsavel: ana() });
    const cliente = await entrarComo(t, ana());
    await cliente
      .post('/api/v1/atividades', {
        tipo: 'NOTA',
        titulo: 'Anotação',
        negocioId: negocio.id,
      })
      .expect(201);
    const tarefa = await cliente
      .post('/api/v1/atividades', {
        tipo: 'TAREFA',
        titulo: 'Enviar proposta',
        contatoId: contato.id,
        venceEm: horas(2),
      })
      .expect(201);
    expect(await primeira(negocio.id)).toBeNull();
    await cliente
      .post(`/api/v1/atividades/${tarefa.body.id}/concluir`)
      .expect(200);
    expect(
      await t.prisma.negocio.findUniqueOrThrow({ where: { id: negocio.id } }),
    ).toMatchObject({
      primeiraInteracaoTipo: 'ATIVIDADE',
      primeiraInteracaoPorId: ana().id,
    });
  });

  it('R6.7 — reunião NAO_COMPARECEU ou REMARCADA não conta; COMPARECEU conta (só contato real)', async () => {
    const cliente = await entrarComo(t, ana());
    const reuniao = async (contatoId: string, titulo: string) =>
      (
        await cliente
          .post('/api/v1/atividades', {
            tipo: 'REUNIAO',
            titulo,
            contatoId,
            inicioEm: horas(-2),
            fimEm: horas(-1),
          })
          .expect(201)
      ).body as { id: string };
    const naoCompareceu = await criarContato(t);
    const remarcada = await criarContato(t);
    const compareceu = await criarContato(t);
    const n1 = await criarNegocio(t, {
      contato: naoCompareceu,
      responsavel: ana(),
    });
    const n2 = await criarNegocio(t, {
      contato: remarcada,
      responsavel: ana(),
    });
    const n3 = await criarNegocio(t, {
      contato: compareceu,
      responsavel: ana(),
    });
    const r1 = await reuniao(naoCompareceu.id, 'Não veio');
    const r2 = await reuniao(remarcada.id, 'Remarcou');
    const r3 = await reuniao(compareceu.id, 'Veio');
    await cliente
      .post(`/api/v1/atividades/${r1.id}/concluir`, {
        resultadoReuniao: 'NAO_COMPARECEU',
      })
      .expect(200);
    await cliente
      .post(`/api/v1/atividades/${r2.id}/concluir`, {
        resultadoReuniao: 'REMARCADA',
        novaData: horas(48),
      })
      .expect(200);
    expect(await primeira(n1.id)).toBeNull();
    expect(await primeira(n2.id)).toBeNull();
    await cliente
      .post(`/api/v1/atividades/${r3.id}/concluir`, {
        resultadoReuniao: 'COMPARECEU',
      })
      .expect(200);
    expect(await primeira(n3.id)).not.toBeNull();
    // Criar a reunião já concluída segue a mesma regra.
    const outro = await criarContato(t);
    const n4 = await criarNegocio(t, { contato: outro, responsavel: ana() });
    await cliente
      .post('/api/v1/atividades', {
        tipo: 'REUNIAO',
        titulo: 'Já concluída',
        contatoId: outro.id,
        inicioEm: horas(-2),
        fimEm: horas(-1),
        concluida: true,
        resultadoReuniao: 'NAO_COMPARECEU',
      })
      .expect(201);
    expect(await primeira(n4.id)).toBeNull();
  });

  it('R6.7 — ponto de registro: só negócios abertos, criados antes da ação, do contato; ligação do 3C+ usa o mesmo ponto', async () => {
    const contato = await criarContato(t);
    const aberto = await criarNegocio(t, { contato });
    const ganho = await criarNegocio(t, { contato });
    await t.prisma.negocio.update({
      where: { id: ganho.id },
      data: { status: 'GANHO', ganhoEm: new Date() },
    });
    const outro = await criarNegocio(t, { contato: await criarContato(t) });
    const quando = new Date();
    const depois = await criarNegocio(t, { contato });
    await t.prisma.negocio.update({
      where: { id: depois.id },
      data: { criadoEm: new Date(quando.getTime() + 60_000) },
    });
    const afetados = await t.prisma.$transaction((tx) =>
      registrarPrimeiraInteracao(tx, {
        contatoId: contato.id,
        tipo: 'LIGACAO',
        usuarioId: ana().id,
        quando,
      }),
    );
    expect(afetados).toBe(1);
    expect(await primeira(aberto.id)).toEqual(quando);
    expect(await primeira(outro.id)).toBeNull();
    expect(await primeira(depois.id)).toBeNull();
    expect(await primeira(ganho.id)).toBeNull();
  });

  it('R6.7 — GET /negocios traz primeiraInteracao e filtra por atendido', async () => {
    const { negocio, conversa } = await conversaComNegocio();
    const parado = await criarNegocio(t, { responsavel: ana() });
    const cliente = await entrarComo(t, ana());
    await cliente
      .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Olá!' })
      .expect(201);
    const atendidos = await cliente
      .get('/api/v1/negocios')
      .query({ atendido: 'true' })
      .expect(200);
    expect(atendidos.body.itens.map((n: { id: string }) => n.id)).toEqual([
      negocio.id,
    ]);
    expect(atendidos.body.itens[0].primeiraInteracao).toMatchObject({
      tipo: 'MENSAGEM',
      por: { id: ana().id },
    });
    const nao = await cliente
      .get('/api/v1/negocios')
      .query({ atendido: 'false' })
      .expect(200);
    expect(nao.body.itens.map((n: { id: string }) => n.id)).toEqual([
      parado.id,
    ]);
    expect(nao.body.itens[0].primeiraInteracao).toBeNull();
    const detalhe = await cliente
      .get(`/api/v1/negocios/${parado.id}`)
      .expect(200);
    expect(detalhe.body.primeiraInteracao).toBeNull();
  });
});
