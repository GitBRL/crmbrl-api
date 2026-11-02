import { SlaDoAtendimento } from '../src/atendimento/sla.service';
import {
  type CenarioDoAtendimento,
  drenarEnvios,
  montarCenario,
  receberDoContato,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import {
  type AppTeste,
  criarAppTeste,
  criarArquivo,
  criarConversa,
  criarMensagem,
  criarRespostaRapida,
  criarUsuario,
  entrarComo,
} from './utils';

const BASE = '/api/v1/atendimento';

/**
 * Configuração do Atendimento (R12): filas (SLA, estratégia, participantes),
 * respostas rápidas com variáveis, atendimento nos canais (fila padrão,
 * horário, satisfação), o aviso de SLA estourado ao líder e as métricas.
 */
describe('Atendimento — configuração, SLA e métricas (e2e)', () => {
  let t: AppTeste;
  let cenario: CenarioDoAtendimento;
  let desfazer: (() => void) | undefined;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    cenario = await montarCenario(t);
  });
  afterEach(() => {
    desfazer?.();
    desfazer = undefined;
  });
  afterAll(() => t.fechar());

  describe('filas', () => {
    it('líder cria e altera as da sua área; membro e outra área: 403; Marketing fora', async () => {
      const lider = await entrarComo(t, cenario.comercial.lider);
      const criada = await lider
        .post(`${BASE}/filas`, {
          nome: 'Comercial — vendas',
          area: 'comercial',
          slaPrimeiraRespostaMinutos: 10,
          slaResolucaoMinutos: 480,
          estrategia: 'MENOR_CARGA',
        })
        .expect(201);
      expect(criada.body).toMatchObject({
        area: 'COMERCIAL',
        estrategia: 'MENOR_CARGA',
        slaPrimeiraRespostaMinutos: 10,
        modoParticipantes: 'AREA',
        podeEditar: true,
        proximo: expect.objectContaining({}),
      });
      expect(
        criada.body.pessoas.map(
          (p: { id: string; motivo: string }) => p.motivo,
        ),
      ).toEqual(['LIDER', 'AREA', 'AREA']);
      await lider.post(`${BASE}/filas`, { nome: 'CS', area: 'CS' }).expect(403);
      await lider
        .post(`${BASE}/filas`, { nome: 'Mkt', area: 'MARKETING' })
        .expect(400);
      await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .post(`${BASE}/filas`, { nome: 'X', area: 'COMERCIAL' })
        .expect(403);
      await (
        await entrarComo(t, cenario.marketing)
      )
        .get(`${BASE}/filas`)
        .expect(403);

      const alterada = await lider
        .patch(`${BASE}/filas/${criada.body.id}`, {
          slaPrimeiraRespostaMinutos: null,
          estrategia: 'RODIZIO',
        })
        .expect(200);
      expect(alterada.body).toMatchObject({
        slaPrimeiraRespostaMinutos: null,
        estrategia: 'RODIZIO',
      });
      // Membro lista todas (para filtrar e transferir), sem editar.
      const lista = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .get(`${BASE}/filas`)
        .expect(200);
      expect(lista.body).toHaveLength(3);
      expect(
        lista.body.every((f: { podeEditar: boolean }) => !f.podeEditar),
      ).toBe(true);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { entidade: 'fila_atendimento', entidadeId: criada.body.id },
        }),
      ).toBe(2);
    });

    it('participantes: retirar, devolver, incluir o líder (vira lista) e desfazer', async () => {
      const lider = cenario.comercial.lider;
      const [ana, bia] = cenario.comercial.membros;
      const cliente = await entrarComo(t, cenario.admin);
      const url = `${BASE}/filas/${cenario.fila.id}/participantes`;
      const retirada = await cliente
        .put(`${url}/${ana.id}`, { participa: false })
        .expect(200);
      const motivos = (corpo: {
        pessoas: Array<{ id: string; motivo: string }>;
      }) => Object.fromEntries(corpo.pessoas.map((p) => [p.id, p.motivo]));
      expect(motivos(retirada.body)).toMatchObject({
        [ana.id]: 'RETIRADO',
        [bia.id]: 'AREA',
      });
      const comLider = await cliente
        .put(`${url}/${lider.id}`, { participa: true })
        .expect(200);
      expect(comLider.body.modoParticipantes).toBe('LISTA');
      expect(motivos(comLider.body)).toMatchObject({
        [lider.id]: 'NA_LISTA',
        [bia.id]: 'NA_LISTA',
        [ana.id]: 'FORA_DA_LISTA',
      });
      await cliente.delete(`${url}/${lider.id}`).expect(200);
      await cliente.delete(`${url}/${lider.id}`).expect(404);
      await cliente
        .put(`${url}/${cenario.cs.membros[0].id}`, { participa: true })
        .expect(422);
    });

    it('lista de participantes na criação e na edição (vazia volta à área inteira)', async () => {
      const cliente = await entrarComo(t, cenario.comercial.cLevel);
      const [ana, bia] = cenario.comercial.membros;
      const criada = await cliente
        .post(`${BASE}/filas`, {
          nome: 'Só a Ana',
          area: 'COMERCIAL',
          participantes: [ana.id, ana.id],
        })
        .expect(201);
      expect(criada.body).toMatchObject({
        modoParticipantes: 'LISTA',
        proximo: { id: ana.id },
      });
      await cliente
        .patch(`${BASE}/filas/${criada.body.id}`, {
          participantes: [cenario.cs.membros[0].id],
        })
        .expect(422);
      const area = await cliente
        .patch(`${BASE}/filas/${criada.body.id}`, { participantes: [] })
        .expect(200);
      expect(area.body.modoParticipantes).toBe('AREA');
      expect(
        area.body.pessoas
          .filter((p: { participa: boolean }) => p.participa)
          .map((p: { id: string }) => p.id)
          .sort(),
      ).toEqual([ana.id, bia.id].sort());
      const detalhe = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .get(`${BASE}/canais/${cenario.canal.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({
        filaPadrao: { id: cenario.fila.id },
        horarioAtendimento: null,
        situacaoHorario: { aberto: true },
        perguntaPadrao: expect.stringContaining('1 (ruim) a 5 (ótimo)'),
      });
    });

    it('exclusão: 422 com conversas em aberto; os canais ficam sem fila padrão', async () => {
      const cliente = await entrarComo(t, cenario.admin);
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        fila: cenario.fila,
      });
      await cliente.delete(`${BASE}/filas/${cenario.fila.id}`).expect(422);
      await cliente
        .patch(`${BASE}/filas/${cenario.fila.id}`, { area: 'CS' })
        .expect(422);
      await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { status: 'RESOLVIDA', resolvidaEm: new Date() },
      });
      await cliente.delete(`${BASE}/filas/${cenario.fila.id}`).expect(204);
      expect(
        (
          await t.prisma.canal.findUniqueOrThrow({
            where: { id: cenario.canal.id },
          })
        ).filaPadraoId,
      ).toBeNull();
      await cliente.get(`${BASE}/filas/${cenario.fila.id}`).expect(404);
    });
  });

  describe('respostas rápidas', () => {
    it('R12 — cria com variáveis, aplica na conversa e recusa atalho repetido ou variável desconhecida', async () => {
      const lider = await entrarComo(t, cenario.comercial.lider);
      const anexo = await criarArquivo(t, {
        mime: 'application/pdf',
        criadoPor: cenario.comercial.lider,
      });
      const criada = await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: '/Boas-Vindas',
          titulo: 'Boas-vindas',
          texto:
            '{{saudacao}}, {{contato.primeiroNome}}! Sou {{usuario.primeiroNome}}.',
          area: 'COMERCIAL',
          arquivoId: anexo.id,
        })
        .expect(201);
      expect(criada.body).toMatchObject({
        atalho: 'boas-vindas',
        area: 'COMERCIAL',
        variaveis: ['saudacao', 'contato.primeiroNome', 'usuario.primeiroNome'],
        arquivo: { id: anexo.id },
        podeEditar: true,
      });
      const repetida = await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: 'boas-vindas',
          titulo: 'X',
          texto: 'Y',
          area: 'COMERCIAL',
        })
        .expect(409);
      expect(repetida.body.erro).toBe('conflito');
      const desconhecida = await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: 'pedido',
          titulo: 'Pedido',
          texto: 'Seu pedido {{pedido.numero}}',
          area: 'COMERCIAL',
        })
        .expect(400);
      expect(desconhecida.body.mensagem).toContain('{{pedido.numero}}');
      await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: 'com espaco',
          titulo: 'X',
          texto: 'Y',
          area: 'COMERCIAL',
        })
        .expect(400);
      // Global só Admin/C-level; o líder não cria para todas as áreas.
      await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: 'oi',
          titulo: 'Oi',
          texto: 'Oi',
        })
        .expect(403);
      await criarRespostaRapida(t, { atalho: 'global', area: null });
      await criarRespostaRapida(t, { atalho: 'so-cs', area: 'CS' });

      const ana = cenario.comercial.membros[0];
      const membro = await entrarComo(t, ana);
      const lista = await membro.get(`${BASE}/respostas-rapidas`).expect(200);
      expect(lista.body.map((r: { atalho: string }) => r.atalho)).toEqual([
        'boas-vindas',
        'global',
      ]);
      expect(lista.body[0].podeEditar).toBe(false);
      await membro
        .patch(`${BASE}/respostas-rapidas/${criada.body.id}`, { titulo: 'Z' })
        .expect(403);

      const contato = await t.prisma.contato.create({
        data: {
          nome: 'Maria Souza',
          email: 'maria@exemplo.com',
          primeiraOrigem: 'MANUAL',
          ultimaOrigem: 'MANUAL',
        },
      });
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        contato,
        fila: cenario.fila,
        responsavel: ana,
      });
      const aplicada = await membro
        .post(`${BASE}/respostas-rapidas/${criada.body.id}/aplicar`, {
          conversaId: conversa.id,
        })
        .expect(200);
      expect(aplicada.body.texto).toMatch(
        new RegExp(
          `^(Bom dia|Boa tarde|Boa noite), Maria! Sou ${ana.nome.split(' ')[0]}\\.$`,
        ),
      );
      expect(aplicada.body.arquivo).toMatchObject({ id: anexo.id });
      // O anexo da resposta rápida pode ser enviado por quem usa o Atendimento.
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      await membro
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          texto: aplicada.body.texto,
          arquivoId: anexo.id,
        })
        .expect(201);

      await lider
        .delete(`${BASE}/respostas-rapidas/${criada.body.id}`)
        .expect(204);
      await lider
        .post(`${BASE}/respostas-rapidas`, {
          atalho: 'boas-vindas',
          titulo: 'De novo',
          texto: 'Oi',
          area: 'COMERCIAL',
        })
        .expect(201);
      const variaveis = await membro
        .get(`${BASE}/respostas-rapidas/variaveis`)
        .expect(200);
      expect(variaveis.body.map((v: { nome: string }) => v.nome)).toContain(
        'contato.primeiroNome',
      );
    });
  });

  describe('atendimento nos canais', () => {
    it('Admin define fila padrão, horário (validado), fora do horário e satisfação', async () => {
      const admin = await entrarComo(t, cenario.admin);
      const invalido = await admin
        .patch(`${BASE}/canais/${cenario.canal.id}`, {
          horarioAtendimento: {
            fusoHorario: 'America/Sao_Paulo',
            dias: { '1': [{ inicio: '18:00', fim: '08:00' }] },
          },
        })
        .expect(400);
      expect(invalido.body.detalhes.campos[0]).toMatchObject({
        campo: 'horarioAtendimento',
      });
      const alterado = await admin
        .patch(`${BASE}/canais/${cenario.canal.id}`, {
          filaPadraoId: cenario.filaCs.id,
          horarioAtendimento: {
            fusoHorario: 'America/Sao_Paulo',
            dias: {
              '1': [
                { inicio: '13:00', fim: '18:00' },
                { inicio: '08:00', fim: '12:00' },
              ],
            },
          },
          mensagemForaHorario: 'Voltamos às 8h.',
          pesquisaSatisfacao: true,
          mensagemSatisfacao: '  ',
        })
        .expect(200);
      expect(alterado.body).toMatchObject({
        filaPadrao: { id: cenario.filaCs.id },
        horarioAtendimento: {
          dias: {
            '1': [
              { inicio: '08:00', fim: '12:00' },
              { inicio: '13:00', fim: '18:00' },
            ],
          },
        },
        mensagemForaHorario: 'Voltamos às 8h.',
        pesquisaSatisfacao: true,
        mensagemSatisfacao: null,
        podeEditar: true,
      });
      expect(typeof alterado.body.situacaoHorario.aberto).toBe('boolean');
      await admin
        .patch(`${BASE}/canais/${cenario.canal.id}`, {
          horarioAtendimento: null,
        })
        .expect(200);
      expect(
        (
          await t.prisma.canal.findUniqueOrThrow({
            where: { id: cenario.canal.id },
          })
        ).horarioAtendimento,
      ).toBeNull();
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'canal.atualizado', entidadeId: cenario.canal.id },
        }),
      ).toBe(2);
      await (
        await entrarComo(t, cenario.comercial.lider)
      )
        .patch(`${BASE}/canais/${cenario.canal.id}`, {
          pesquisaSatisfacao: false,
        })
        .expect(403);
      const lista = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .get(`${BASE}/canais`)
        .expect(200);
      expect(lista.body).toEqual([
        expect.objectContaining({ id: cenario.canal.id, podeEditar: false }),
      ]);
    });
  });

  describe('SLA estourado (job a cada minuto)', () => {
    it('cenário 23 — R12: avisa o líder uma vez por prazo; responder antes evita o aviso', async () => {
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { slaPrimeiraRespostaMinutos: 5, slaResolucaoMinutos: 60 },
      });
      const atrasada = await receberDoContato(t, cenario.canal, { de: 'v-1' });
      const emDia = await receberDoContato(t, cenario.canal, { de: 'v-2' });
      // A segunda foi respondida.
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      const responsavel = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: emDia.conversaId },
        include: { responsavel: true },
      });
      await (
        await entrarComo(t, responsavel.responsavel!)
      )
        .post(`${BASE}/conversas/${emDia.conversaId}/mensagens`, {
          texto: 'Oi!',
        })
        .expect(201);
      await drenarEnvios(t);

      const sla = t.get(SlaDoAtendimento);
      const daqui10min = new Date(Date.now() + 10 * 60_000);
      expect(await sla.varrer(daqui10min)).toEqual({
        primeiraResposta: 1,
        resolucao: 0,
      });
      expect(await sla.varrer(daqui10min)).toEqual({
        primeiraResposta: 0,
        resolucao: 0,
      });
      const avisos = await t.prisma.notificacao.findMany({
        where: { tipo: 'conversa.sla_primeira_resposta' },
      });
      expect(avisos).toEqual([
        expect.objectContaining({
          usuarioId: cenario.comercial.lider.id,
          link: `/atendimento/${atrasada.conversaId}`,
        }),
      ]);
      expect(avisos[0].texto).toContain('prazo de 5 min');
      expect(await sla.varrer(new Date(Date.now() + 2 * 3600_000))).toEqual({
        primeiraResposta: 0,
        resolucao: 2,
      });
      // O SLA estourado aparece no resumo e no filtro da lista.
      const lista = await (
        await entrarComo(t, cenario.comercial.lider)
      )
        .get(`${BASE}/conversas?slaEstourado=true`)
        .expect(200);
      expect(lista.body.itens).toEqual([]);
    });
  });

  describe('métricas para o BI', () => {
    it('indicadores gerais, por fila, por canal e por pessoa; líder vê a área; membro 403', async () => {
      ({ desfazer } = usarAdaptadorFalso(t, 'WEBCHAT'));
      const [ana] = cenario.comercial.membros;
      await t.prisma.filaAtendimento.update({
        where: { id: cenario.fila.id },
        data: { slaPrimeiraRespostaMinutos: 30, slaResolucaoMinutos: 600 },
      });
      await t.prisma.canal.update({
        where: { id: cenario.canal.id },
        data: { pesquisaSatisfacao: true },
      });
      const primeira = await receberDoContato(t, cenario.canal, { de: 'v-1' });
      await receberDoContato(t, cenario.canal, { de: 'v-2' });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: primeira.conversaId },
        include: { responsavel: true },
      });
      const atendente = await entrarComo(t, conversa.responsavel!);
      await atendente
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Olá!' })
        .expect(201);
      await atendente
        .post(`${BASE}/conversas/${conversa.id}/resolver`, {})
        .expect(200);
      await receberDoContato(t, cenario.canal, { de: 'v-1', texto: '5' });
      // Conversa de CS, fora da área do líder comercial.
      const cs = await criarConversa(t, {
        canal: cenario.canal,
        fila: cenario.filaCs,
      });
      await criarMensagem(t, { conversa: cs });

      const admin = await entrarComo(t, cenario.admin);
      const metricas = await admin.get(`${BASE}/metricas`).expect(200);
      expect(metricas.body.geral).toMatchObject({
        conversas: 3,
        respondidas: 1,
        resolvidas: 1,
        mensagensEnviadas: 1,
        slaPrimeiraResposta: { comPrazo: 2, cumpridos: 1, estourados: 0 },
        slaResolucao: { comPrazo: 1, cumpridos: 1, percentualCumprido: 100 },
        satisfacao: {
          solicitadas: 1,
          respondidas: 1,
          media: 5,
          distribuicao: [0, 0, 0, 0, 1],
          csat: 100,
        },
      });
      expect(metricas.body.geral.primeiraResposta.mediaSegundos).toEqual(
        expect.any(Number),
      );
      expect(metricas.body.agora).toMatchObject({
        emAberto: 2,
        aguardandoResposta: 2,
      });
      const porFila = Object.fromEntries(
        metricas.body.porFila.map(
          (linha: { fila: { nome: string }; conversas: number }) => [
            linha.fila.nome,
            linha.conversas,
          ],
        ),
      );
      expect(porFila).toEqual({ Comercial: 2, 'Customer Success': 1 });
      expect(metricas.body.porCanal).toEqual([
        expect.objectContaining({
          canal: expect.objectContaining({ id: cenario.canal.id }),
          conversas: 3,
        }),
      ]);
      const pessoa = metricas.body.porPessoa.find(
        (linha: { pessoa: { id: string } }) =>
          linha.pessoa.id === conversa.responsavelId,
      );
      expect(pessoa).toMatchObject({
        recebidas: 1,
        primeirasRespostas: 1,
        resolvidas: 1,
        mensagensEnviadas: 1,
        satisfacao: { respondidas: 1, media: 5 },
      });

      const lider = await (
        await entrarComo(t, cenario.comercial.lider)
      )
        .get(`${BASE}/metricas?area=CS`)
        .expect(200);
      expect(lider.body.geral.conversas).toBe(2);
      await (await entrarComo(t, ana)).get(`${BASE}/metricas`).expect(403);
      await admin
        .get(
          `${BASE}/metricas?de=2026-10-10T00:00:00Z&ate=2026-10-01T00:00:00Z`,
        )
        .expect(400);
      const vazio = await admin
        .get(
          `${BASE}/metricas?de=2020-01-01T00:00:00Z&ate=2020-02-01T00:00:00Z`,
        )
        .expect(200);
      expect(vazio.body.geral.conversas).toBe(0);
      expect(vazio.body.porPessoa).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ emAberto: expect.any(Number) }),
        ]),
      );
    });

    it('usuário sem acesso ativado não entra na conta de quem recebe', async () => {
      const convidado = await criarUsuario(t, {
        papel: 'COMERCIAL',
        lider: cenario.comercial.lider,
        senha: null,
      });
      const fila = await (
        await entrarComo(t, cenario.admin)
      )
        .get(`${BASE}/filas/${cenario.fila.id}`)
        .expect(200);
      expect(
        fila.body.pessoas.find((p: { id: string }) => p.id === convidado.id),
      ).toMatchObject({ participa: false, motivo: 'CONVITE_PENDENTE' });
    });
  });
});
