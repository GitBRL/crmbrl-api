import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import { AtendimentoService } from '../src/atendimento/atendimento.service';
import { partesLocais } from '../src/atendimento/horario';
import {
  AGRADECIMENTO_DA_AVALIACAO,
  PERGUNTA_PADRAO_DA_PESQUISA,
} from '../src/atendimento/satisfacao';
import {
  drenarEnvios,
  montarCenario,
  receberDoContato,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarCanal,
  criarConversa,
  criarFila,
  criarUsuario,
  entrarComo,
  esperarEvento,
  fecharSockets,
  processarEventos,
  type SocketDeTeste,
} from './utils';

/** Um horário que está fechado agora: só abre daqui a dois dias, das 8h às 18h. */
function horarioFechadoAgora() {
  const hoje = new Date(
    Date.UTC(
      partesLocais(new Date(), 'America/Sao_Paulo').ano,
      partesLocais(new Date(), 'America/Sao_Paulo').mes - 1,
      partesLocais(new Date(), 'America/Sao_Paulo').dia,
    ),
  ).getUTCDay();
  const dia = String((hoje + 2) % 7);
  return {
    fusoHorario: 'America/Sao_Paulo',
    dias: { [dia]: [{ inicio: '08:00', fim: '18:00' }] },
  };
}

/**
 * Entrada do Atendimento (R12): distribuição pela fila, SLA com o horário de
 * atendimento, resposta automática fora do horário, pesquisa de satisfação e
 * o aviso em tempo real.
 */
describe('Atendimento — entrada (e2e)', () => {
  let t: AppTeste;
  let desfazer: (() => void) | undefined;
  const abertos: SocketDeTeste[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
  });
  afterEach(() => {
    desfazer?.();
    desfazer = undefined;
    return fecharSockets(...abertos.splice(0));
  });
  afterAll(() => t.fechar());

  describe('distribuição pela fila', () => {
    it('cenário 19 — R12: rodízio entre os membros ativos da área que já ativaram o acesso; notifica quem recebe', async () => {
      const cenario = await montarCenario(t);
      const [ana, bia] = cenario.comercial.membros;
      // Convidado (sem senha) não entra no rodízio.
      await criarUsuario(t, {
        papel: 'COMERCIAL',
        lider: cenario.comercial.lider,
        senha: null,
      });
      const responsaveis: Array<string | null> = [];
      for (const de of ['v-1', 'v-2', 'v-3']) {
        const { conversaId } = await receberDoContato(t, cenario.canal, {
          de,
          email: `${de}@exemplo.com`,
        });
        const conversa = await t.prisma.conversa.findUniqueOrThrow({
          where: { id: conversaId },
        });
        responsaveis.push(conversa.responsavelId);
        expect(conversa).toMatchObject({ filaId: cenario.fila.id });
        expect(conversa.atribuidaEm).not.toBeNull();
      }
      expect(responsaveis).toEqual([ana.id, bia.id, ana.id]);

      const atribuicoes = await t.prisma.conversaAtribuicao.findMany({
        orderBy: { criadoEm: 'asc' },
      });
      expect(atribuicoes.map((a) => [a.motivo, a.paraUsuarioId])).toEqual([
        ['DISTRIBUICAO', ana.id],
        ['DISTRIBUICAO', bia.id],
        ['DISTRIBUICAO', ana.id],
      ]);
      const notificacoes = await t.prisma.notificacao.findMany({
        where: { tipo: 'conversa.atribuida' },
      });
      expect(notificacoes.map((n) => n.usuarioId).sort()).toEqual(
        [ana.id, ana.id, bia.id].sort(),
      );
      expect(notificacoes[0]).toMatchObject({
        titulo: 'Nova conversa para você',
        link: expect.stringMatching(/^\/atendimento\//),
      });
      // A segunda mensagem do mesmo contato fica na mesma conversa, sem redistribuir.
      await receberDoContato(t, cenario.canal, { de: 'v-1', texto: 'Alô?' });
      expect(await t.prisma.conversaAtribuicao.count()).toBe(3);
      expect(await t.prisma.conversa.count()).toBe(3);
    });

    it('MENOR_CARGA: quem tem menos conversas em aberto recebe', async () => {
      const cenario = await montarCenario(t, {
        fila: { estrategia: 'MENOR_CARGA' },
      });
      const [ana, bia] = cenario.comercial.membros;
      await criarConversa(t, { canal: cenario.canal, responsavel: ana });
      await criarConversa(t, { canal: cenario.canal, responsavel: ana });
      await criarConversa(t, { canal: cenario.canal, responsavel: bia });
      const { conversaId } = await receberDoContato(t, cenario.canal);
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: conversaId },
          })
        ).responsavelId,
      ).toBe(bia.id);
    });

    it('MANUAL, fila sem ninguém disponível ou canal sem fila: fica sem responsável', async () => {
      const cenario = await montarCenario(t, {
        fila: { estrategia: 'MANUAL' },
      });
      const manual = await receberDoContato(t, cenario.canal, { de: 'v-1' });
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: manual.conversaId },
          })
        ).responsavelId,
      ).toBeNull();

      const vazia = await criarFila(t, { area: 'CS', participantes: [] });
      await t.prisma.usuario.updateMany({
        where: { papel: 'CS' },
        data: { ativo: false },
      });
      const canalCs = await criarCanal(t, { filaPadrao: vazia });
      const semNinguem = await receberDoContato(t, canalCs, { de: 'v-2' });
      expect(
        await t.prisma.conversa.findUniqueOrThrow({
          where: { id: semNinguem.conversaId },
        }),
      ).toMatchObject({ responsavelId: null, filaId: vazia.id });

      const semFila = await criarCanal(t);
      const resultado = await receberDoContato(t, semFila, { de: 'v-3' });
      expect(
        await t.prisma.conversa.findUniqueOrThrow({
          where: { id: resultado.conversaId },
        }),
      ).toMatchObject({
        responsavelId: null,
        filaId: null,
        slaPrimeiraRespostaAte: null,
      });
      expect(await t.prisma.notificacao.count()).toBe(0);
    });

    it('fila com lista: só quem está nela (inclusive o líder)', async () => {
      const cenario = await montarCenario(t);
      await t.prisma.filaParticipante.create({
        data: {
          filaId: cenario.fila.id,
          usuarioId: cenario.comercial.lider.id,
          participa: true,
        },
      });
      const { conversaId } = await receberDoContato(t, cenario.canal);
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: conversaId },
          })
        ).responsavelId,
      ).toBe(cenario.comercial.lider.id);
    });
  });

  describe('SLA e horário de atendimento', () => {
    it('cenário 22 — R12: prazos do SLA contados da chegada; fora do horário, da abertura seguinte', async () => {
      const cenario = await montarCenario(t, {
        fila: { slaPrimeiraRespostaMinutos: 15, slaResolucaoMinutos: 240 },
      });
      const antes = Date.now();
      const noHorario = await receberDoContato(t, cenario.canal, { de: 'v-1' });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: noHorario.conversaId },
      });
      const prazo1 = conversa.slaPrimeiraRespostaAte!.getTime();
      expect(prazo1).toBeGreaterThanOrEqual(antes + 15 * 60_000);
      expect(prazo1).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
      expect(conversa.slaResolucaoAte!.getTime() - prazo1).toBe(225 * 60_000);

      const horario = horarioFechadoAgora();
      const fechado = await criarCanal(t, {
        filaPadrao: cenario.fila,
        horarioAtendimento: horario,
      });
      const foraDoHorario = await receberDoContato(t, fechado, { de: 'v-2' });
      const outra = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: foraDoHorario.conversaId },
      });
      const abertura = outra.slaPrimeiraRespostaAte!.getTime() - 15 * 60_000;
      const local = partesLocais(new Date(abertura), 'America/Sao_Paulo');
      expect([local.hora, local.minuto]).toEqual([8, 0]);
      expect(abertura).toBeGreaterThan(Date.now());
    });

    it('cenário 22 — fora do horário responde a mensagem automática uma vez por período', async () => {
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      const cenario = await montarCenario(t, {
        canal: {
          horarioAtendimento: horarioFechadoAgora(),
          mensagemForaHorario: 'Estamos fora do horário; respondemos às 8h.',
        },
      });
      const primeira = await receberDoContato(t, cenario.canal, {
        texto: 'Oi',
      });
      await receberDoContato(t, cenario.canal, { texto: 'Alguém?' });
      const saidas = await t.prisma.mensagem.findMany({
        where: { conversaId: primeira.conversaId, direcao: 'SAIDA' },
      });
      expect(saidas).toEqual([
        expect.objectContaining({
          texto: 'Estamos fora do horário; respondemos às 8h.',
          autorId: null,
          autorTipo: 'SISTEMA',
          status: 'PENDENTE',
        }),
      ]);
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: primeira.conversaId },
      });
      // A resposta automática não conta como primeira resposta nem tira o "aguardando".
      expect(conversa.primeiraRespostaEm).toBeNull();
      expect(conversa.aguardandoDesde).not.toBeNull();
      expect(conversa.naoLidas).toBe(2);
      expect(conversa.foraHorarioRespondidoEm).not.toBeNull();
      expect(await t.fila.listarTrabalhos(FILA_ENVIO_ATENDIMENTO)).toHaveLength(
        1,
      );
    });

    it('contato escreve numa conversa PENDENTE: volta a ABERTA', async () => {
      const cenario = await montarCenario(t);
      const { conversaId } = await receberDoContato(t, cenario.canal);
      await t.prisma.conversa.update({
        where: { id: conversaId },
        data: { status: 'PENDENTE' },
      });
      await receberDoContato(t, cenario.canal, { texto: 'Voltei' });
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: conversaId },
          })
        ).status,
      ).toBe('ABERTA');
    });
  });

  describe('pesquisa de satisfação', () => {
    it('cenário 24 — R12: nota de 1 a 5 na conversa resolvida (24 h); depois disso, conversa nova', async () => {
      const falso = usarAdaptadorFalso(t, 'WEBCHAT');
      desfazer = falso.desfazer;
      const cenario = await montarCenario(t, {
        canal: { pesquisaSatisfacao: true },
      });
      const { conversaId } = await receberDoContato(t, cenario.canal);
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const responsavel = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: conversa.responsavelId! },
      });
      const cliente = await entrarComo(t, responsavel);
      await cliente
        .post(`/api/v1/atendimento/conversas/${conversaId}/resolver`, {})
        .expect(200);
      await drenarEnvios(t);
      expect(falso.adaptador.textos()).toEqual([PERGUNTA_PADRAO_DA_PESQUISA]);

      const nota = await receberDoContato(t, cenario.canal, {
        texto: '4 - gostei, mas demorou',
      });
      expect(nota.conversaId).toBe(conversaId);
      const avaliada = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      expect(avaliada).toMatchObject({
        status: 'RESOLVIDA',
        satisfacaoNota: 4,
        satisfacaoComentario: 'gostei, mas demorou',
      });
      expect(avaliada.satisfacaoRespondidaEm).not.toBeNull();
      await drenarEnvios(t);
      expect(falso.adaptador.textos().at(-1)).toBe(AGRADECIMENTO_DA_AVALIACAO);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'conversa.avaliada', entidadeId: conversaId },
        }),
      ).toBe(1);
      // Nota 4 não é baixa: o líder não é avisado.
      expect(
        await t.prisma.notificacao.count({
          where: { tipo: 'conversa.avaliacao_baixa' },
        }),
      ).toBe(0);

      // Já avaliada: um "5" agora é uma conversa nova.
      const depois = await receberDoContato(t, cenario.canal, { texto: '5' });
      expect(depois.conversaId).not.toBe(conversaId);
    });

    it('cenário 24 — nota baixa (1 ou 2) avisa o líder de quem atendeu', async () => {
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      const cenario = await montarCenario(t, {
        canal: { pesquisaSatisfacao: true },
      });
      const { conversaId } = await receberDoContato(t, cenario.canal);
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const responsavel = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: conversa.responsavelId! },
      });
      await (
        await entrarComo(t, responsavel)
      )
        .post(`/api/v1/atendimento/conversas/${conversaId}/resolver`, {})
        .expect(200);

      const nota = await receberDoContato(t, cenario.canal, {
        texto: '1, ninguém resolveu',
      });
      expect(nota.conversaId).toBe(conversaId);
      const avisos = await t.prisma.notificacao.findMany({
        where: { tipo: 'conversa.avaliacao_baixa' },
      });
      expect(avisos.map((aviso) => aviso.usuarioId)).toEqual([
        cenario.comercial.lider.id,
      ]);
      expect(avisos[0]).toMatchObject({
        titulo: 'Avaliação 1 de 5 no atendimento',
        link: `/atendimento/${conversaId}`,
      });
      expect(avisos[0].texto).toContain(responsavel.nome);
      expect(avisos[0].texto).toContain('ninguém resolveu');
    });

    it('fora das 24 h, ou texto que não é nota, abre conversa nova; avaliar() pelo canal', async () => {
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      const cenario = await montarCenario(t);
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        status: 'RESOLVIDA',
      });
      await t.prisma.contatoIdentificador.create({
        data: {
          contatoId: conversa.contatoId,
          tipo: 'WEBCHAT',
          valor: 'visitante-9',
        },
      });
      await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: {
          satisfacaoSolicitadaEm: new Date(Date.now() - 25 * 3600_000),
        },
      });
      const atrasada = await receberDoContato(t, cenario.canal, {
        de: 'visitante-9',
        texto: '5',
      });
      expect(atrasada.conversaId).not.toBe(conversa.id);

      const atendimento = t.get(AtendimentoService);
      await expect(atendimento.avaliar(conversa.id, 5)).rejects.toMatchObject({
        status: 422,
      });
      await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { satisfacaoSolicitadaEm: new Date() },
      });
      await expect(atendimento.avaliar(conversa.id, 9)).rejects.toMatchObject({
        status: 400,
      });
      await atendimento.avaliar(conversa.id, 5, '  Excelente!  ');
      expect(
        await t.prisma.conversa.findUniqueOrThrow({
          where: { id: conversa.id },
        }),
      ).toMatchObject({
        satisfacaoNota: 5,
        satisfacaoComentario: 'Excelente!',
      });
    });
  });

  describe('aviso de mensagem nova', () => {
    it('notifica o responsável fora do CRM na primeira não lida (uma vez por sequência)', async () => {
      const cenario = await montarCenario(t);
      const { conversaId } = await receberDoContato(t, cenario.canal);
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      await t.prisma.conversa.update({
        where: { id: conversaId },
        data: { naoLidas: 0 },
      });
      await processarEventos(t);
      const avisos = () =>
        t.prisma.notificacao.findMany({
          where: { tipo: 'conversa.mensagem_recebida' },
        });
      expect(await avisos()).toHaveLength(0);

      await receberDoContato(t, cenario.canal, { texto: 'Ainda estou aqui' });
      await receberDoContato(t, cenario.canal, { texto: 'Olá?' });
      await processarEventos(t);
      expect(await avisos()).toEqual([
        expect.objectContaining({
          usuarioId: conversa.responsavelId,
          titulo: 'Nova mensagem de Maria Souza',
          link: `/atendimento/${conversaId}`,
        }),
      ]);
      // Reentrega não duplica.
      await processarEventos(t, { incluirAgendados: true });
      expect(await avisos()).toHaveLength(1);

      // Conectado: não notifica (já vê pelo tempo real).
      await t.prisma.conversa.update({
        where: { id: conversaId },
        data: { naoLidas: 0 },
      });
      const responsavel = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: conversa.responsavelId! },
      });
      abertos.push(
        await conectarTempoReal(t, await entrarComo(t, responsavel)),
      );
      await receberDoContato(t, cenario.canal, { texto: 'Voltei' });
      await processarEventos(t);
      expect(await avisos()).toHaveLength(1);
    });
  });

  describe('tempo real', () => {
    it('quem atende a fila recebe conversa.nova, mensagem.nova e a contagem do menu', async () => {
      const cenario = await montarCenario(t, {
        fila: { estrategia: 'MANUAL' },
      });
      const [ana] = cenario.comercial.membros;
      const socket = await conectarTempoReal(t, await entrarComo(t, ana));
      abertos.push(socket);
      const marketing = await conectarTempoReal(
        t,
        await entrarComo(t, cenario.marketing),
      );
      abertos.push(marketing);

      const nova = esperarEvento(socket, 'conversa.nova');
      const mensagem = esperarEvento(socket, 'mensagem.nova');
      const contagem = esperarEvento(socket, 'nao-lidas');
      const { conversaId } = await receberDoContato(t, cenario.canal, {
        texto: 'Primeira mensagem',
      });
      await processarEventos(t);
      expect(await nova).toMatchObject({
        conversa: {
          id: conversaId,
          responsavel: null,
          naoLidas: 1,
          fila: { id: cenario.fila.id, area: 'COMERCIAL' },
          canal: { id: cenario.canal.id, tipo: 'WEBCHAT' },
          ultimaMensagem: { direcao: 'ENTRADA', previa: 'Primeira mensagem' },
        },
      });
      expect(await mensagem).toMatchObject({
        conversaId,
        mensagem: { direcao: 'ENTRADA', texto: 'Primeira mensagem' },
      });
      expect(await contagem).toEqual({ atendimento: 1 });
    });
  });
});
