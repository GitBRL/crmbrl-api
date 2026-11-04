/**
 * Correções da revisão da Onda G (R31): elegibilidade do fluxo, corrida entre
 * turnos, falha ao aplicar o turno, falhas determinísticas, ordem dos bloqueios,
 * aviso de orçamento sem duplicar e LGPD (exportação e anonimização).
 */
import { OPCOES_CHAMADA_CLAUDE } from '../src/bi/analise/chamada-claude.service';
import { CLIENTE_ANTHROPIC } from '../src/bi/analise/cliente-anthropic';
import type { Trabalho } from '../src/fila/fila.service';
import { MotorSdr, type PedidoDoTurno } from '../src/sdr/motor-sdr.service';
import { OrcamentoSdrService } from '../src/sdr/orcamento-sdr.service';
import { OPCOES_SDR } from '../src/sdr/opcoes-sdr';
import {
  type AdaptadorFalso,
  type CenarioDoAtendimento,
  drenarEnvios,
  montarCenario,
  receberDoContato,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import { SdrAnthropicFalso } from './sdr-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarNegocio,
  drenarTudo,
  entrarComo,
  processarEventos,
} from './utils';
import { erroDaApi } from './utils/anthropic-falso';

const CHAVE_FALSA = 'sk-ant-chave-falsa-do-sdr-0123456789';
const API = '/api/v1/sdr';

interface MotorPorDentro {
  pegarTrava(estadoId: string): Promise<Date | null>;
}

describe('SDR com IA — correções da revisão (e2e)', () => {
  let t: AppTeste;
  const falso = new SdrAnthropicFalso();
  let desfazer: () => void = () => undefined;
  let adaptador: AdaptadorFalso;
  let c: CenarioDoAtendimento;
  let admin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: { ANTHROPIC_API_KEY: CHAVE_FALSA },
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
  afterAll(() => t.fechar());

  beforeEach(async () => {
    await t.limparBanco();
    falso.limpar();
    desfazer();
    ({ adaptador, desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
    c = await montarCenario(t);
    admin = await entrarComo(t, c.admin);
  });
  afterEach(() => desfazer());

  async function ligar(
    modo: 'AUTOMATICO' | 'SUGESTAO' | 'DESLIGADO' = 'AUTOMATICO',
  ) {
    await admin
      .put(`${API}/configuracao`)
      .send({ esperaAgrupamentoSegundos: 0 })
      .expect(200);
    await admin.put(`${API}/canais/${c.canal.id}`).send({ modo }).expect(200);
  }

  async function lead(
    texto: string,
    opcoes: { de?: string; nome?: string } = {},
  ) {
    const r = await receberDoContato(t, c.canal, { texto, ...opcoes });
    await drenarTudo(t);
    await drenarEnvios(t);
    return r;
  }

  const estadoDe = (conversaId: string) =>
    t.prisma.sdrConversa.findUnique({ where: { conversaId } });

  it('cenário 308 — R31.1 — o fluxo do chatbot só passa para a IA quem a IA pode atender', async () => {
    await ligar('AUTOMATICO');
    const motor = t.get(MotorSdr);
    // Lead novo: a IA atende; depois ele ganha um negócio aberto no CS (vira aluno).
    const a = await lead('Oi', { de: 'v-a' });
    const conversaA = await t.prisma.conversa.findUniqueOrThrow({
      where: { id: a.conversaId },
    });
    await criarNegocio(t, { contato: conversaA.contatoId, area: 'CS' });
    const chamadasAntes = falso.chamadas.length;
    const rA = await motor.chamarPeloFluxo(a.conversaId);
    expect(rA.ativado).toBe(false);
    expect(rA.motivo).toContain('negócio');
    expect(await estadoDe(a.conversaId)).toMatchObject({ origem: 'novo' });
    await drenarTudo(t, { incluirAgendados: true });
    expect(falso.chamadas).toHaveLength(chamadasAntes);

    // Contato com opt-out.
    const b = await lead('Oi', { de: 'v-b', nome: 'Bia' });
    const conversaB = await t.prisma.conversa.findUniqueOrThrow({
      where: { id: b.conversaId },
    });
    await t.prisma.contato.update({
      where: { id: conversaB.contatoId },
      data: { optOutMarketing: true, optOutEm: new Date() },
    });
    expect((await motor.chamarPeloFluxo(b.conversaId)).ativado).toBe(false);

    // Desqualificada: um novo fluxo não põe a IA de volta (só "Devolver").
    falso.responder({ acao: 'desqualificado', motivo: 'Sem perfil.' });
    const d = await lead('Quero Astronomia', { de: 'v-d', nome: 'Duda' });
    expect((await estadoDe(d.conversaId))?.situacao).toBe('DESQUALIFICADA');
    const rD = await motor.chamarPeloFluxo(d.conversaId);
    expect(rD.ativado).toBe(false);
    expect((await estadoDe(d.conversaId))?.situacao).toBe('DESQUALIFICADA');

    // Conversa que já tem responsável humano (automático): a IA não entra.
    const e = await lead('Oi', { de: 'v-e', nome: 'Edu' });
    await lead('quero falar com um humano', { de: 'v-e', nome: 'Edu' });
    expect((await estadoDe(e.conversaId))?.situacao).toBe('PASSADA_HUMANO');
    const rE = await motor.chamarPeloFluxo(e.conversaId);
    expect(rE.ativado).toBe(false);
    expect((await estadoDe(e.conversaId))?.situacao).toBe('PASSADA_HUMANO');
  });

  it('cenário 309 — R31.2 — dois jobs da mesma conversa: o que pega a trava depois do outro terminar não responde de novo', async () => {
    await ligar('AUTOMATICO');
    const { conversaId } = await receberDoContato(t, c.canal, { texto: 'Oi' });
    const motor = t.get(MotorSdr);
    const porDentro = motor as unknown as MotorPorDentro;
    const original = porDentro.pegarTrava.bind(motor);
    let aninhado = false;
    // O job J3 já leu o estado e as mensagens; antes de pegar a trava, o J2 faz o turno inteiro.
    porDentro.pegarTrava = async (estadoId) => {
      if (!aninhado) {
        aninhado = true;
        const j2: Trabalho<PedidoDoTurno> = {
          id: 'j2',
          fila: 'sdr.turno',
          dados: { conversaId },
          tentativa: 1,
        };
        await motor.executarTurno(j2);
      }
      return original(estadoId);
    };
    try {
      await drenarTudo(t);
      await drenarEnvios(t);
    } finally {
      delete (porDentro as Partial<MotorPorDentro>).pegarTrava;
    }
    expect(aninhado).toBe(true);
    expect(falso.chamadas).toHaveLength(1);
    expect(adaptador.textos()).toHaveLength(1);
    expect(await estadoDe(conversaId)).toMatchObject({
      mensagensIa: 1,
      execucaoDesde: null,
    });
    expect(
      await t.prisma.sdrDecisao.count({ where: { conversaId, tipo: 'TURNO' } }),
    ).toBe(1);
  });

  it('cenário 310 — R31.7 — Assumir e Devolver durante um turno: o turno antigo é descartado e só o novo responde', async () => {
    await ligar('AUTOMATICO');
    const { conversaId } = await receberDoContato(t, c.canal, { texto: 'Oi' });
    const atendente = await entrarComo(t, c.comercial.membros[0]);
    falso.atrasoMs = 50;
    const turnoAntigo = drenarTudo(t);
    for (let i = 0; i < 100 && falso.chamadas.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(falso.chamadas).toHaveLength(1);
    await atendente.post(`${API}/conversas/${conversaId}/assumir`).expect(200);
    await processarEventos(t);
    await atendente.post(`${API}/conversas/${conversaId}/devolver`).expect(200);
    await processarEventos(t);
    const turnoNovo = drenarTudo(t);
    await Promise.all([turnoAntigo, turnoNovo]);
    falso.atrasoMs = 0;
    await drenarTudo(t, { incluirAgendados: true });
    await drenarEnvios(t);
    expect(adaptador.textos()).toHaveLength(1);
    expect((await estadoDe(conversaId))?.situacao).toBe('ATIVA');
    const descartes = await t.prisma.sdrDecisao.findMany({
      where: { conversaId, tipo: 'BLOQUEIO' },
    });
    expect(descartes).toHaveLength(1);
    expect(descartes[0].titulo).toContain('descartada');
    // Os tokens do turno descartado contam no registro.
    expect(descartes[0].tokensEntrada).toBe(1200);
  });

  it('cenário 311 — R31.11 — erro ao aplicar o turno (funil-base do Comercial inativo): guarda os tokens, passa para a equipe e avisa o Admin, sem refazer a chamada', async () => {
    await ligar('AUTOMATICO');
    await t.prisma.funil.updateMany({
      where: { area: 'COMERCIAL' },
      data: { ativo: false },
    });
    const { conversaId } = await lead('quero me matricular');
    expect(falso.chamadas).toHaveLength(1);
    expect(await estadoDe(conversaId)).toMatchObject({
      situacao: 'PASSADA_HUMANO',
    });
    expect(
      await t.prisma.sdrDecisao.count({
        where: { conversaId, tipo: 'FALHA', tokensEntrada: 1200 },
      }),
    ).toBeGreaterThan(0);
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: c.admin.id, tipo: 'sdr.falha' },
      }),
    ).toBe(1);
    expect(adaptador.textos().at(-1)).toContain(
      'Vou chamar uma pessoa da nossa equipe',
    );
    await drenarTudo(t, { incluirAgendados: true });
    expect(falso.chamadas).toHaveLength(1);
  });

  it('cenário 312 — R31.11 — erro 400 da API e resposta cortada (max_tokens) passam para a equipe na hora, sem refazer o job', async () => {
    await ligar('AUTOMATICO');
    falso.roteiro({ tipo: 'erro', erro: erroDaApi(400, 'prompt is too long') });
    const a = await lead('Oi', { de: 'v-a' });
    expect(falso.chamadas).toHaveLength(1);
    expect((await estadoDe(a.conversaId))?.situacao).toBe('PASSADA_HUMANO');
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: c.admin.id, tipo: 'sdr.falha' },
      }),
    ).toBe(1);
    falso.roteiro({
      tipo: 'resposta',
      stopReason: 'max_tokens',
      corpo: '{"res',
    });
    const antes = falso.chamadas.length;
    const b = await lead('Oi', { de: 'v-b', nome: 'Bia' });
    expect(falso.chamadas).toHaveLength(antes + 1);
    expect((await estadoDe(b.conversaId))?.situacao).toBe('PASSADA_HUMANO');
    await drenarTudo(t, { incluirAgendados: true });
    expect(falso.chamadas).toHaveLength(antes + 1);
  });

  it('cenário 313 — R31.10 — janela fechada e orçamento esgotado: a mensagem de passagem não é enviada fora da janela', async () => {
    await ligar('AUTOMATICO');
    await admin
      .put(`${API}/configuracao`)
      .send({ orcamentoMensalTokens: 100_000 })
      .expect(200);
    await t.prisma.sdrDecisao.create({
      data: {
        tipo: 'TURNO',
        titulo: 'Gasto de teste',
        tokensEntrada: 150_000,
        simulador: true,
      },
    });
    adaptador.bloqueio = {
      pode: false,
      motivo: 'A janela de 24 horas fechou.',
    };
    const { conversaId } = await lead('Oi');
    expect(adaptador.enviados).toHaveLength(0);
    expect(falso.chamadas).toHaveLength(0);
    expect(await estadoDe(conversaId)).toMatchObject({
      situacao: 'PASSADA_HUMANO',
      motivo: 'A janela de 24 horas fechou.',
    });
  });

  it('cenário 314 — R31.8 — duas transações que passam dos 80% juntas notificam o Admin uma vez só', async () => {
    await admin
      .put(`${API}/configuracao`)
      .send({ orcamentoMensalTokens: 100_000 })
      .expect(200);
    await t.prisma.sdrDecisao.create({
      data: {
        tipo: 'TURNO',
        titulo: 'Gasto de teste',
        tokensEntrada: 85_000,
        simulador: true,
      },
    });
    const orcamento = t.get(OrcamentoSdrService);
    await Promise.all(
      [1, 2, 3].map(() =>
        t.prisma.$transaction((tx) => orcamento.avisarSeNecessario(tx)),
      ),
    );
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: c.admin.id, tipo: 'sdr.orcamento' },
      }),
    ).toBe(1);
  });

  it('cenário 315 — R31.9 — LGPD: a exportação traz o que o SDR guarda e o motivo da IA não fica no título nem na auditoria', async () => {
    await ligar('AUTOMATICO');
    falso.responder({
      acao: 'desqualificado',
      motivo: 'Lead mora em Campinas e só pode pagar R$ 200 por mês',
      resumo: 'Lead de Campinas com pouca verba.',
      criterios: [{ chave: 'cidade', valor: 'Campinas', confianca: 0.9 }],
    });
    const { conversaId } = await lead('Oi! cidade: Campinas');
    const conversa = await t.prisma.conversa.findUniqueOrThrow({
      where: { id: conversaId },
    });
    const decisao = await t.prisma.sdrDecisao.findFirstOrThrow({
      where: { conversaId, tipo: 'DESQUALIFICADO' },
    });
    expect(decisao.titulo).toBe('Desqualificou o lead');
    expect(decisao.motivo).toContain('Campinas');
    const auditorias = await t.prisma.eventoAuditoria.findMany({
      where: { entidadeId: conversaId, acao: { startsWith: 'sdr.' } },
    });
    expect(auditorias.length).toBeGreaterThan(0);
    const textoAuditado = JSON.stringify(
      auditorias.map((a) => [a.resumo, a.dados]),
    );
    expect(textoAuditado).not.toContain('Campinas');
    expect(textoAuditado).not.toContain('R$ 200');

    const exportado = await admin
      .get(`/api/v1/contatos/${conversa.contatoId}/dados-pessoais`)
      .expect(200);
    const sdr = exportado.body.sdr;
    expect(sdr.conversas).toHaveLength(1);
    expect(sdr.conversas[0]).toMatchObject({
      situacao: 'DESQUALIFICADA',
      resumo: 'Lead de Campinas com pouca verba.',
    });
    expect(
      sdr.conversas[0].valores.map((v: { chave: string }) => v.chave),
    ).toContain('cidade');
    const exportada = sdr.decisoes.find(
      (d: { tipo: string }) => d.tipo === 'DESQUALIFICADO',
    );
    expect(exportada.motivo).toContain('Campinas');
    expect(
      sdr.decisoes.find((d: { tipo: string }) => d.tipo === 'TURNO').criterios,
    ).toBeTruthy();
    const registro = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: {
        acao: 'contato.dados-exportados',
        entidadeId: conversa.contatoId,
      },
    });
    expect(registro.dados).toMatchObject({ sdrConversas: 1 });
    expect(JSON.stringify(registro.dados)).not.toContain('Campinas');

    // Anonimizar apaga o texto: o título já era neutro e as decisões antigas com motivo no título são limpas.
    await t.prisma.sdrDecisao.update({
      where: { id: decisao.id },
      data: { titulo: 'Desqualificou o lead: Lead mora em Campinas' },
    });
    await admin
      .post(`/api/v1/contatos/${conversa.contatoId}/anonimizar`)
      .send({ motivo: 'Pedido do titular' })
      .expect(204);
    const depois = await t.prisma.sdrDecisao.findUniqueOrThrow({
      where: { id: decisao.id },
    });
    expect(depois.titulo).toBe('Desqualificou o lead');
    expect(depois.motivo).toBeNull();
  });
});
