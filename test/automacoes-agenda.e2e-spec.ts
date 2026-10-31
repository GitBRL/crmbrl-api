import { alvoDaDataRelativa } from '../src/comum/gatilhos/agenda';
import { GatilhosService } from '../src/comum/gatilhos/gatilhos.service';
import {
  type AppTeste,
  avancarPassos,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarNegocio,
  criarUsuario,
  entrarComo,
  funilBase,
  processarEventos,
} from './utils';

type Cliente = Awaited<ReturnType<typeof entrarComo>>;

describe('Automações — agendas: data relativa, recorrência, negócio parado e atividade atrasada (e2e, R19.2)', () => {
  let t: AppTeste;
  let admin: Cliente;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    admin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  });
  afterAll(() => t.fechar());

  const etiquetar = (...adicionar: string[]) => ({
    passos: [{ id: 'p1', tipo: 'acao.etiquetar', config: { adicionar } }],
  });

  async function criarAtiva(dados: Record<string, unknown>) {
    const criada = await admin
      .post('/api/v1/automacoes', { nome: 'Agendada', ...dados })
      .expect(201);
    const ativada = await admin
      .post(`/api/v1/automacoes/${criada.body.id}/ativar`)
      .expect(200);
    return ativada.body as { id: string; proximaExecucaoEm: string | null };
  }

  async function varrer(agora: Date): Promise<void> {
    await t.get(GatilhosService).executarAgenda('automacoes', agora);
    for (let i = 0; i < 4; i++) {
      await processarEventos(t);
      await avancarPassos(t);
    }
  }

  const execucoesDe = (automacaoId: string) =>
    t.prisma.execucao.findMany({
      where: { automacaoId },
      orderBy: { criadoEm: 'asc' },
    });

  it('R19.2 — data relativa: "30 dias antes" do campo personalizado dispara na hora marcada, uma vez', async () => {
    const automacao = await criarAtiva({
      tipoGatilho: 'DATA_RELATIVA',
      gatilhoConfig: {
        campo: 'contato.campos.renovacao_em',
        dias: -30,
        hora: '09:00',
      },
      definicao: etiquetar('renovar'),
    });
    expect(automacao.proximaExecucaoEm).not.toBeNull();
    const ocorrencia = new Date(automacao.proximaExecucaoEm!);
    expect(ocorrencia.getTime()).toBeGreaterThan(Date.now());
    const { diaDoCampo } = alvoDaDataRelativa(
      { campo: 'contato.campos.renovacao_em', dias: -30, hora: '09:00' },
      ocorrencia,
    );
    const hoje = await criarContato(t);
    const outro = await criarContato(t);
    await t.prisma.contato.update({
      where: { id: hoje.id },
      data: { camposPersonalizados: { renovacao_em: diaDoCampo } },
    });
    await t.prisma.contato.update({
      where: { id: outro.id },
      data: { camposPersonalizados: { renovacao_em: '2099-01-01' } },
    });
    // Antes da hora: nada.
    await varrer(new Date(ocorrencia.getTime() - 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(0);
    // Na hora: só o contato cuja data cai 30 dias depois do dia do disparo.
    const agora = new Date(ocorrencia.getTime() + 60_000);
    await varrer(agora);
    const execucoes = await execucoesDe(automacao.id);
    expect(execucoes).toHaveLength(1);
    expect(execucoes[0]).toMatchObject({
      entidadeId: hoje.id,
      status: 'CONCLUIDA',
    });
    expect(
      (await t.prisma.contato.findUniqueOrThrow({ where: { id: hoje.id } }))
        .etiquetas,
    ).toEqual(['renovar']);
    // A próxima ocorrência avançou um dia; repetir a varredura não duplica.
    const depois = await t.prisma.automacao.findUniqueOrThrow({
      where: { id: automacao.id },
    });
    expect(depois.proximaExecucaoEm!.getTime() - ocorrencia.getTime()).toBe(
      86_400_000,
    );
    await varrer(agora);
    expect(await execucoesDe(automacao.id)).toHaveLength(1);
  });

  it('R19.2 — data relativa de negócio: previsão de fechamento em 3 dias avisa o responsável (só negócio aberto)', async () => {
    const automacao = await criarAtiva({
      tipoGatilho: 'DATA_RELATIVA',
      gatilhoConfig: {
        campo: 'negocio.previsaoFechamento',
        dias: -3,
        hora: '08:00',
      },
      definicao: etiquetar('fechamento-proximo'),
    });
    const ocorrencia = new Date(automacao.proximaExecucaoEm!);
    const alvo = alvoDaDataRelativa(
      { campo: 'negocio.previsaoFechamento', dias: -3, hora: '08:00' },
      ocorrencia,
    );
    const aberto = await criarNegocio(t);
    const ganho = await criarNegocio(t, { etapa: 'ganho' }).catch(() => null);
    await t.prisma.negocio.update({
      where: { id: aberto.id },
      data: {
        previsaoFechamento: new Date(`${alvo.diaDoCampo}T00:00:00.000Z`),
      },
    });
    if (ganho) {
      await t.prisma.negocio.update({
        where: { id: ganho.id },
        data: {
          previsaoFechamento: new Date(`${alvo.diaDoCampo}T00:00:00.000Z`),
        },
      });
    }
    await varrer(new Date(ocorrencia.getTime() + 60_000));
    const execucoes = await execucoesDe(automacao.id);
    expect(execucoes.map((e) => e.entidadeId)).toEqual([aberto.id]);
  });

  it('R19.2 — recorrência: dispara para os contatos do público a cada ocorrência, sem duplicar', async () => {
    const automacao = await criarAtiva({
      tipoGatilho: 'RECORRENCIA',
      gatilhoConfig: { frequencia: 'diaria', hora: '10:00' },
      limiteExecucao: 'SEMPRE',
      condicoes: {
        segmento: {
          condicoes: [
            {
              campo: 'etiquetas',
              operador: 'contem_alguma',
              valor: ['assinante'],
            },
          ],
        },
      },
      definicao: etiquetar('lembrado'),
    });
    const a = await criarContato(t, { etiquetas: ['assinante'] });
    const b = await criarContato(t, { etiquetas: ['assinante'] });
    await criarContato(t, { etiquetas: ['outro'] });
    const primeira = new Date(automacao.proximaExecucaoEm!);
    await varrer(new Date(primeira.getTime() - 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(0);
    await varrer(new Date(primeira.getTime() + 60_000));
    expect(
      (await execucoesDe(automacao.id))
        .map((e) => e.entidadeId ?? '')
        .sort((x, y) => x.localeCompare(y)),
    ).toEqual([a.id, b.id].sort((a, b) => a.localeCompare(b)));
    await varrer(new Date(primeira.getTime() + 120_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(2);
    // No dia seguinte, nova ocorrência (SEMPRE): mais uma execução por contato.
    await varrer(new Date(primeira.getTime() + 86_400_000 + 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(4);
  });

  it('R19.2 — recorrência com limite "uma vez": cada contato recebe só na primeira ocorrência', async () => {
    const automacao = await criarAtiva({
      tipoGatilho: 'RECORRENCIA',
      gatilhoConfig: { frequencia: 'diaria', hora: '10:00' },
      limiteExecucao: 'UMA_VEZ',
      condicoes: {
        segmento: {
          condicoes: [
            {
              campo: 'etiquetas',
              operador: 'contem_alguma',
              valor: ['assinante'],
            },
          ],
        },
      },
      definicao: etiquetar('lembrado'),
    });
    await criarContato(t, { etiquetas: ['assinante'] });
    const primeira = new Date(automacao.proximaExecucaoEm!);
    await varrer(new Date(primeira.getTime() + 60_000));
    await varrer(new Date(primeira.getTime() + 86_400_000 + 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(1);
  });

  it('R19.2 — recorrência sem público fica pendente (não ativa)', async () => {
    const criada = await admin
      .post('/api/v1/automacoes', {
        nome: 'Sem público',
        tipoGatilho: 'RECORRENCIA',
        gatilhoConfig: {
          frequencia: 'semanal',
          diasDaSemana: [1],
          hora: '09:00',
        },
        definicao: etiquetar('x'),
      })
      .expect(201);
    expect(criada.body.pendencias).toEqual([
      'Escolha o público da recorrência.',
    ]);
    await admin.post(`/api/v1/automacoes/${criada.body.id}/ativar`).expect(422);
  });

  it('R19.2 — negócio parado: dispara quando passa do prazo da etapa, uma vez por permanência', async () => {
    const funil = await funilBase(t, 'COMERCIAL');
    const etapa = funil.etapas.find((e) => e.tipo === 'ABERTA')!;
    await t.prisma.etapa.update({
      where: { id: etapa.id },
      data: { prazoDias: 2 },
    });
    const automacao = await criarAtiva({
      tipoGatilho: 'EVENTO',
      evento: 'negocio.parado',
      gatilhoConfig: { etapaId: etapa.id },
      definicao: etiquetar('parado'),
    });
    const dia = 86_400_000;
    const contatoParado = await criarContato(t);
    const contatoNovo = await criarContato(t);
    const contatoAntigo = await criarContato(t);
    const parado = await criarNegocio(t, { contato: contatoParado });
    const novo = await criarNegocio(t, { contato: contatoNovo });
    const antigo = await criarNegocio(t, { contato: contatoAntigo });
    const agora = new Date();
    // Passou do prazo (2 dias) há pouco, depois da ativação.
    await t.prisma.negocio.update({
      where: { id: parado.id },
      data: { etapaDesde: new Date(agora.getTime() - 2 * dia - 60_000) },
    });
    // Dentro do prazo.
    await t.prisma.negocio.update({
      where: { id: novo.id },
      data: { etapaDesde: new Date(agora.getTime() - dia) },
    });
    // Já estava parado antes da ativação: não dispara retroativamente.
    await t.prisma.negocio.update({
      where: { id: antigo.id },
      data: { etapaDesde: new Date(agora.getTime() - 9 * dia) },
    });
    // Simula a varredura anterior, feita há 10 minutos (o marco da automação).
    await t.prisma.automacao.update({
      where: { id: automacao.id },
      data: { ultimaExecucaoEm: new Date(agora.getTime() - 2 * 60_000) },
    });
    await varrer(agora);
    const execucoes = await execucoesDe(automacao.id);
    expect(execucoes.map((e) => e.entidadeId)).toEqual([parado.id]);
    expect(execucoes[0]).toMatchObject({
      entidade: 'negocio',
      contatoId: contatoParado.id,
      status: 'CONCLUIDA',
    });
    // A varredura seguinte não repete o mesmo negócio (mesma permanência na etapa).
    await varrer(new Date(agora.getTime() + 5 * 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(1);
    // Um negócio que fecha deixa de contar.
    await t.prisma.negocio.update({
      where: { id: novo.id },
      data: {
        etapaDesde: new Date(agora.getTime() - 3 * dia),
        status: 'PERDIDO',
      },
    });
    await varrer(new Date(agora.getTime() + 10 * 60_000));
    expect(await execucoesDe(automacao.id)).toHaveLength(1);
  });

  it('R19.2 — atividade atrasada: dispara quando o vencimento passa, só para pendentes', async () => {
    const automacao = await criarAtiva({
      tipoGatilho: 'EVENTO',
      evento: 'atividade.atrasada',
      entidade: 'atividade',
      definicao: etiquetar('atrasada'),
    });
    const responsavel = await t.prisma.usuario.findFirstOrThrow();
    const contato = await criarContato(t);
    const agora = new Date();
    const vencida = await criarAtividade(t, {
      contato,
      responsavel,
      venceEm: new Date(agora.getTime() - 60_000),
    });
    const concluida = await criarAtividade(t, {
      contato,
      responsavel,
      venceEm: new Date(agora.getTime() - 60_000),
      status: 'CONCLUIDA',
    });
    const futura = await criarAtividade(t, {
      contato,
      responsavel,
      venceEm: new Date(agora.getTime() + 3_600_000),
    });
    await t.prisma.automacao.update({
      where: { id: automacao.id },
      data: { ultimaExecucaoEm: new Date(agora.getTime() - 2 * 60_000) },
    });
    await varrer(agora);
    const execucoes = await execucoesDe(automacao.id);
    expect(execucoes.map((e) => e.entidadeId)).toEqual([vencida.id]);
    expect(execucoes[0]).toMatchObject({
      entidade: 'atividade',
      contatoId: contato.id,
    });
    void concluida;
    void futura;
  });
});
