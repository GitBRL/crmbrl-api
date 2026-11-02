import {
  type AdaptadorFalso,
  drenarEnvios,
  montarCenario,
  type CenarioDoAtendimento,
  receberDoContato,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import { PassosService } from '../src/comum/passos/passos.service';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarCanal,
  criarFluxoChatbot,
  drenarTudo,
  entrarComo,
  funilBase,
  processarEventos,
} from './utils';

type Definicao = { passos: Array<Record<string, unknown>> };

describe('Chatbot — fluxos em passos (R18, e2e)', () => {
  let t: AppTeste;
  let cenario: CenarioDoAtendimento;
  let falso: AdaptadorFalso;
  let desfazer: () => void;
  let lider: ClienteHttp;
  let admin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    cenario = await montarCenario(t);
    const troca = usarAdaptadorFalso(t, 'WEBCHAT');
    falso = troca.adaptador;
    desfazer = troca.desfazer;
    lider = await entrarComo(t, cenario.comercial.lider);
    admin = await entrarComo(t, cenario.admin);
  });
  afterEach(() => desfazer());
  afterAll(() => t.fechar());

  /** O contato escreve e o evento chega ao chatbot. */
  async function contatoEscreve(
    texto: string,
    opcoes: { de?: string; canal?: typeof cenario.canal } = {},
  ) {
    const resultado = await receberDoContato(t, opcoes.canal ?? cenario.canal, {
      de: opcoes.de ?? 'visitante-1',
      texto,
    });
    await processarEventos(t);
    return resultado;
  }

  /** O prazo da espera venceu (o job agendado do pg-boss chamaria isto). */
  async function despertar(execucaoId: string, token: string | null) {
    await t
      .get(PassosService)
      .avancar(execucaoId, { motivo: 'tempo' }, token ?? undefined);
  }

  const mensagensDoBot = (conversaId: string) =>
    t.prisma.mensagem.findMany({
      where: { conversaId, autorTipo: 'BOT', direcao: 'SAIDA' },
      orderBy: { ocorridaEm: 'asc' },
    });

  async function execucaoDa(conversaId: string) {
    return t.prisma.execucao.findFirstOrThrow({
      where: { conversaId, tipo: 'CHATBOT' },
      orderBy: { criadoEm: 'desc' },
    });
  }

  const menu = (fila: string, filaCs: string): Definicao => ({
    passos: [
      {
        id: 'boas',
        tipo: 'mensagem',
        config: { texto: 'Olá, {{contato.primeiro_nome}}!' },
      },
      {
        id: 'menu',
        tipo: 'pergunta.opcoes',
        config: {
          texto: 'Como posso ajudar?',
          opcoes: [
            { id: 'vendas', rotulo: 'Comprar' },
            { id: 'suporte', rotulo: 'Suporte' },
          ],
          variavel: 'assunto',
          tentativas: 3,
        },
        ramos: [
          {
            id: 'vendas',
            passos: [
              {
                id: 'v1',
                tipo: 'acao.etiquetar',
                config: { adicionar: ['Lead chatbot'] },
              },
              {
                id: 'v2',
                tipo: 'transferir',
                config: { filaId: fila, mensagem: 'Chamando um vendedor.' },
              },
            ],
          },
          {
            id: 'suporte',
            passos: [
              {
                id: 's1',
                tipo: 'pergunta.aberta',
                config: {
                  texto: 'Qual é o seu e-mail?',
                  variavel: 'email',
                  validacao: 'email',
                  campoContato: 'email',
                },
              },
              { id: 's2', tipo: 'transferir', config: { filaId: filaCs } },
            ],
          },
        ],
      },
    ],
  });

  describe('permissões e ciclo de vida dos fluxos', () => {
    it('cenário 57 — R18.6 — membro não acessa o chatbot; líder cria na própria área; líder de outra área só lê', async () => {
      const membro = await entrarComo(t, cenario.comercial.membros[0]);
      await membro.get('/api/v1/chatbot/fluxos').expect(403);
      await membro.get('/api/v1/chatbot/passos').expect(403);

      const criado = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Triagem',
          gatilho: 'NOVA_CONVERSA',
          area: 'CS',
          canalIds: [cenario.canal.id],
        })
        .expect(201);
      expect(criado.body).toMatchObject({
        nome: 'Triagem',
        area: 'COMERCIAL',
        ativo: false,
        versaoPublicada: null,
        podeEditar: true,
      });

      const liderCs = await entrarComo(t, cenario.cs.lider);
      // R18.6 — o líder de outra área lê (só leitura) o fluxo, mas não altera.
      const lida = await liderCs
        .get(`/api/v1/chatbot/fluxos/${criado.body.id}`)
        .expect(200);
      expect(lida.body.podeEditar).toBe(false);
      const lista = await liderCs.get('/api/v1/chatbot/fluxos').expect(200);
      expect(lista.body.itens.map((f: { id: string }) => f.id)).toContain(
        criado.body.id,
      );
      await liderCs
        .patch(`/api/v1/chatbot/fluxos/${criado.body.id}`)
        .send({ nome: 'Invadido' })
        .expect(403);

      const global = await admin
        .post('/api/v1/chatbot/fluxos')
        .send({ nome: 'Geral', gatilho: 'SEMPRE' })
        .expect(201);
      expect(global.body.area).toBeNull();
      // O líder vê o de todas as áreas, mas não altera.
      const vista = await lider
        .get(`/api/v1/chatbot/fluxos/${global.body.id}`)
        .expect(200);
      expect(vista.body.podeEditar).toBe(false);
      await lider
        .patch(`/api/v1/chatbot/fluxos/${global.body.id}`)
        .send({ nome: 'Outro' })
        .expect(403);
      await lider
        .put(`/api/v1/chatbot/fluxos/${global.body.id}/rascunho`)
        .send({ definicao: { passos: [] } })
        .expect(403);
    });

    it('R18.6 — líder só liga o fluxo a canais da própria área (nunca a todos)', async () => {
      const semCanais = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({ nome: 'Para todos', gatilho: 'SEMPRE', prioridade: 99 })
        .expect(400);
      expect(semCanais.body.detalhes.regra).toBe('R18.6');
      const liderCs = await entrarComo(t, cenario.cs.lider);
      const deOutraArea = await liderCs
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Invasor',
          gatilho: 'SEMPRE',
          canalIds: [cenario.canal.id],
        })
        .expect(400);
      expect(deOutraArea.body.detalhes.regra).toBe('R18.6');
      await admin
        .post('/api/v1/chatbot/fluxos')
        .send({ nome: 'Diretoria', gatilho: 'SEMPRE' })
        .expect(201);
    });

    it('cenário 54 — R18.2 — rascunho aceita configuração incompleta, mas a publicação aponta cada problema', async () => {
      const { body } = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Rascunho',
          gatilho: 'NOVA_CONVERSA',
          canalIds: [cenario.canal.id],
        })
        .expect(201);
      const id = body.id as string;

      // Estrutura quebrada (tipo desconhecido) é recusada já ao salvar.
      await lider
        .put(`/api/v1/chatbot/fluxos/${id}/rascunho`)
        .send({ definicao: { passos: [{ id: 'a', tipo: 'voar' }] } })
        .expect(400);

      // Configuração incompleta passa no rascunho...
      await lider
        .put(`/api/v1/chatbot/fluxos/${id}/rascunho`)
        .send({
          definicao: {
            passos: [
              { id: 'a', tipo: 'pergunta.opcoes', config: { texto: 'Oi?' } },
            ],
          },
        })
        .expect(200);
      const validacao = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/validar`)
        .expect(200);
      expect(validacao.body.valido).toBe(false);
      expect(validacao.body.problemas[0]).toMatchObject({ passoId: 'a' });
      // ... mas não na publicação.
      const recusada = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/publicar`)
        .send({})
        .expect(400);
      expect(recusada.body.detalhes.regra).toBe('R18');
      expect(recusada.body.detalhes.problemas.length).toBeGreaterThan(0);
      // Fluxo vazio também não publica; ativar sem publicar é 422.
      await lider
        .put(`/api/v1/chatbot/fluxos/${id}/rascunho`)
        .send({ definicao: { passos: [] } })
        .expect(200);
      await lider
        .post(`/api/v1/chatbot/fluxos/${id}/publicar`)
        .send({})
        .expect(400);
      await lider.post(`/api/v1/chatbot/fluxos/${id}/ativar`).expect(422);
    });

    it('R18.1 — palavra-chave exige palavras; canal inexistente é recusado', async () => {
      await lider
        .post('/api/v1/chatbot/fluxos')
        .send({ nome: 'X', gatilho: 'PALAVRA_CHAVE' })
        .expect(400);
      await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'X',
          gatilho: 'SEMPRE',
          canalIds: ['6f3a9c3e-0a7e-4f0e-9a43-5f1f0c7a1111'],
        })
        .expect(400);
    });

    it('cenário 58 — R18.7 — publicar cria versões imutáveis; restaurar copia para o rascunho; duplicar e excluir', async () => {
      const { body } = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Versões',
          canalIds: [cenario.canal.id],
          gatilho: 'NOVA_CONVERSA',
          definicao: {
            passos: [{ id: 'm', tipo: 'mensagem', config: { texto: 'v1' } }],
          },
        })
        .expect(201);
      const id = body.id as string;
      expect(body.rascunhoNaoPublicado).toBe(true);

      const v1 = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/publicar`)
        .send({ ativar: true })
        .expect(200);
      expect(v1.body).toMatchObject({
        ativo: true,
        rascunhoNaoPublicado: false,
        versaoPublicada: { numero: 1 },
      });

      await lider
        .put(`/api/v1/chatbot/fluxos/${id}/rascunho`)
        .send({
          definicao: {
            passos: [{ id: 'm', tipo: 'mensagem', config: { texto: 'v2' } }],
          },
        })
        .expect(200);
      const editado = await lider
        .get(`/api/v1/chatbot/fluxos/${id}`)
        .expect(200);
      expect(editado.body.rascunhoNaoPublicado).toBe(true);
      // A publicada continua a v1.
      expect(editado.body.definicaoPublicada.passos[0].config.texto).toBe('v1');

      const v2 = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/publicar`)
        .send({})
        .expect(200);
      expect(v2.body.versaoPublicada.numero).toBe(2);
      const versoes = await lider
        .get(`/api/v1/chatbot/fluxos/${id}/versoes`)
        .expect(200);
      expect(
        versoes.body.map((v: { numero: number; emUso: boolean }) => [
          v.numero,
          v.emUso,
        ]),
      ).toEqual([
        [2, true],
        [1, false],
      ]);
      const antiga = await lider
        .get(`/api/v1/chatbot/fluxos/${id}/versoes/1`)
        .expect(200);
      expect(antiga.body.definicao.passos[0].config.texto).toBe('v1');
      await lider.get(`/api/v1/chatbot/fluxos/${id}/versoes/9`).expect(404);

      const restaurado = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/versoes/1/restaurar`)
        .expect(200);
      expect(restaurado.body.rascunho.passos[0].config.texto).toBe('v1');
      expect(restaurado.body.versaoPublicada.numero).toBe(2);
      expect(restaurado.body.rascunhoNaoPublicado).toBe(true);

      const copia = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/duplicar`)
        .expect(201);
      expect(copia.body).toMatchObject({
        nome: 'Versões (cópia)',
        ativo: false,
        versaoPublicada: null,
      });

      await lider.post(`/api/v1/chatbot/fluxos/${id}/desativar`).expect(200);
      await lider.post(`/api/v1/chatbot/fluxos/${id}/ativar`).expect(200);
      await lider.delete(`/api/v1/chatbot/fluxos/${id}`).expect(204);
      await lider.get(`/api/v1/chatbot/fluxos/${id}`).expect(404);

      const acoes = await t.prisma.eventoAuditoria.findMany({
        where: { entidade: 'fluxo_chatbot', entidadeId: id },
        select: { acao: true },
      });
      expect(acoes.map((a) => a.acao)).toEqual(
        expect.arrayContaining([
          'fluxo_chatbot.criado',
          'fluxo_chatbot.publicado',
          'fluxo_chatbot.rascunho_salvo',
          'fluxo_chatbot.versao_restaurada',
          'fluxo_chatbot.desativado',
          'fluxo_chatbot.ativado',
          'fluxo_chatbot.excluido',
        ]),
      );
    });

    it('R18.7 — o catálogo de passos descreve cada tipo para o editor', async () => {
      const { body } = await lider.get('/api/v1/chatbot/passos').expect(200);
      const tipos = body.map((p: { tipo: string }) => p.tipo);
      expect(tipos).toEqual(
        expect.arrayContaining([
          'mensagem',
          'pergunta.opcoes',
          'pergunta.aberta',
          'condicao',
          'acao.etiquetar',
          'acao.webhook',
          'transferir',
          'encerrar',
        ]),
      );
    });
  });

  describe('conversa de ponta a ponta', () => {
    it('cenário 55 — R18.2/R18.3/R18.4 — pergunta, resposta inválida, resposta aberta, ação e transferência com resumo; mensagens BOT; auditoria AUTOMACAO', async () => {
      const fluxo = await criarFluxoChatbot(t, {
        nome: 'Triagem do site',
        gatilho: 'NOVA_CONVERSA',
        definicao: menu(cenario.fila.id, cenario.filaCs.id) as never,
      });
      const { conversaId } = await contatoEscreve('oi');

      // Bot saiu falando: boas-vindas + pergunta (botões no chat do site).
      let bot = await mensagensDoBot(conversaId);
      expect(bot.map((m) => m.texto)).toEqual([
        'Olá, Maria!',
        // Chat do site: só o texto, as opções vão como botões (R18.2).
        'Como posso ajudar?',
      ]);
      expect(bot[1].metadados).toMatchObject({
        bot: true,
        botoes: [{ id: 'vendas' }, { id: 'suporte' }],
      });
      let execucao = await execucaoDa(conversaId);
      expect(execucao).toMatchObject({
        status: 'AGUARDANDO',
        aguardandoEntrada: true,
        fluxoId: fluxo.id,
        fluxoVersaoId: fluxo.versaoPublicadaId,
      });

      // Resposta que não é opção: avisa e pergunta de novo.
      await contatoEscreve('não sei');
      bot = await mensagensDoBot(conversaId);
      expect(bot).toHaveLength(3);
      expect(bot[2].texto).toContain('Não entendi');
      expect(bot[2].texto).not.toContain('1 - Comprar');
      expect(bot[2].metadados).toMatchObject({
        botoes: [{ id: 'vendas' }, { id: 'suporte' }],
      });

      // Escolhe "2" (suporte) → pergunta o e-mail.
      await contatoEscreve('2');
      bot = await mensagensDoBot(conversaId);
      expect(bot.at(-1)?.texto).toBe('Qual é o seu e-mail?');

      // E-mail inválido, depois válido → grava no contato e transfere para a fila de CS.
      await contatoEscreve('maria arroba exemplo');
      expect((await mensagensDoBot(conversaId)).at(-1)?.texto).toContain(
        'e-mail válido',
      );
      await contatoEscreve('Maria@Exemplo.com');

      execucao = await execucaoDa(conversaId);
      expect(execucao).toMatchObject({
        status: 'CONCLUIDA',
        motivoFim: 'transferida_para_humano',
      });
      expect(execucao.variaveis).toMatchObject({
        assunto: 'Suporte',
        assunto_id: 'suporte',
        email: 'maria@exemplo.com',
      });

      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      expect(conversa.filaId).toBe(cenario.filaCs.id);
      expect(conversa.responsavelId).toBe(cenario.cs.membros[0].id);
      const contato = await t.prisma.contato.findUniqueOrThrow({
        where: { id: conversa.contatoId },
      });
      expect(contato.email).toBe('maria@exemplo.com');

      // Resumo como nota interna (autor BOT), visível só à equipe.
      const nota = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId, direcao: 'INTERNA' },
      });
      expect(nota.autorTipo).toBe('BOT');
      expect(nota.texto).toContain('Triagem do site');
      expect(nota.texto).toContain('Como posso ajudar? → Suporte');
      expect(nota.texto).toContain('Qual é o seu e-mail? → maria@exemplo.com');

      // Evento para as automações e auditoria com ator AUTOMACAO (descrição = fluxo).
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'chatbot.transferida' },
      });
      expect(evento.dados).toMatchObject({
        conversaId,
        fluxoId: fluxo.id,
        execucaoId: execucao.id,
        filaId: cenario.filaCs.id,
      });
      const auditorias = await t.prisma.eventoAuditoria.findMany({
        where: { tipoAtor: 'AUTOMACAO', atorDescricao: 'Triagem do site' },
        select: { acao: true },
      });
      expect(auditorias.map((a) => a.acao)).toEqual(
        expect.arrayContaining([
          'contato.atualizado',
          'conversa.transferida_pelo_bot',
        ]),
      );

      // Sai pelo canal na ordem certa (a fila `atendimento.enviar`), todas como automáticas.
      await drenarEnvios(t);
      expect(falso.textos()).toEqual(
        (await mensagensDoBot(conversaId)).map((m) => m.texto),
      );
      // O responsável é avisado da transferência.
      const aviso = await t.prisma.notificacao.findFirst({
        where: { usuarioId: cenario.cs.membros[0].id },
      });
      expect(aviso).not.toBeNull();

      // Execução e histórico pela API.
      const lista = await admin
        .get(`/api/v1/chatbot/fluxos/${fluxo.id}/execucoes`)
        .expect(200);
      expect(lista.body.itens[0]).toMatchObject({
        id: execucao.id,
        motivoFim: 'transferida_para_humano',
        versao: 1,
      });
      const detalhe = await admin
        .get(`/api/v1/chatbot/fluxos/${fluxo.id}/execucoes/${execucao.id}`)
        .expect(200);
      expect(detalhe.body.passos.map((p: { tipo: string }) => p.tipo)).toEqual([
        'mensagem',
        'pergunta.opcoes',
        'pergunta.aberta',
        'transferir',
      ]);
      const contadores = (
        await admin.get(`/api/v1/chatbot/fluxos/${fluxo.id}`).expect(200)
      ).body.contadores;
      expect(contadores).toMatchObject({
        total: 1,
        transferidas: 1,
        emAndamento: 0,
      });
    });

    it('R18.4 — ações reais: etiqueta, negócio ligado à conversa e atividade; transferência por fila', async () => {
      const funil = await funilBase(t, 'COMERCIAL');
      await criarFluxoChatbot(t, {
        nome: 'Comercial',
        definicao: {
          passos: [
            {
              id: 'a',
              tipo: 'acao.etiquetar',
              config: { adicionar: ['Quente', 'Site'] },
            },
            {
              id: 'b',
              tipo: 'acao.definir_campo',
              config: {
                campo: 'campos.interesse',
                valor: 'Plano {{variaveis.canal}}',
              },
            },
            {
              id: 'c',
              tipo: 'acao.criar_negocio',
              config: { funilId: funil.id, titulo: 'Lead de {{contato.nome}}' },
            },
            {
              id: 'd',
              tipo: 'acao.criar_atividade',
              config: {
                tipo: 'LIGACAO',
                titulo: 'Ligar para {{contato.primeiro_nome}}',
                prazoHoras: 2,
              },
            },
            {
              id: 'e',
              tipo: 'acao.mover_fila',
              config: { filaId: cenario.filaCs.id },
            },
            { id: 'f', tipo: 'encerrar' },
          ],
        } as never,
      });
      const { conversaId } = await contatoEscreve('oi');
      const execucao = await execucaoDa(conversaId);
      expect(execucao.status).toBe('CONCLUIDA');
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const contato = await t.prisma.contato.findUniqueOrThrow({
        where: { id: conversa.contatoId },
      });
      expect(contato.etiquetas).toEqual(['Quente', 'Site']);
      expect(contato.camposPersonalizados).toMatchObject({
        interesse: 'Plano WEBCHAT',
      });
      const negocio = await t.prisma.negocio.findFirstOrThrow({
        where: { contatoId: contato.id },
      });
      expect(negocio.titulo).toBe('Lead de Maria Souza');
      expect(conversa.negocioId).toBe(negocio.id);
      const atividade = await t.prisma.atividade.findFirstOrThrow({
        where: { contatoId: contato.id },
      });
      expect(atividade).toMatchObject({
        tipo: 'LIGACAO',
        titulo: 'Ligar para Maria',
        criadoPorId: null,
      });
      expect(atividade.responsavelId).toBeTruthy();
      expect(conversa.filaId).toBe(cenario.filaCs.id);
      expect(conversa.responsavelId).toBe(cenario.cs.membros[0].id);

      const atores = await t.prisma.eventoAuditoria.findMany({
        where: { atorDescricao: 'Comercial' },
        select: { acao: true, tipoAtor: true },
      });
      expect(atores.every((a) => a.tipoAtor === 'AUTOMACAO')).toBe(true);
      expect(atores.map((a) => a.acao)).toEqual(
        expect.arrayContaining(['contato.atualizado', 'atividade.criada']),
      );
    });

    it('R18.4 — condição por etiqueta e por horário escolhe o ramo (e o "senão")', async () => {
      const contatoVip = await t.prisma.contato.create({
        data: {
          nome: 'Vera Vip',
          email: 'vera@exemplo.com',
          etiquetas: ['VIP'],
        },
      });
      await t.prisma.contatoIdentificador.create({
        data: {
          contatoId: contatoVip.id,
          tipo: 'WEBCHAT',
          valor: 'vera',
          canalId: cenario.canal.id,
        },
      });
      await criarFluxoChatbot(t, {
        nome: 'Roteador',
        definicao: {
          passos: [
            {
              id: 'se',
              tipo: 'condicao',
              ramos: [
                {
                  id: 'vip',
                  config: { condicao: { tipo: 'etiqueta', etiqueta: 'vip' } },
                  passos: [
                    {
                      id: 'mv',
                      tipo: 'mensagem',
                      config: { texto: 'Atendimento VIP' },
                    },
                  ],
                },
                {
                  id: 'senao',
                  passos: [
                    {
                      id: 'mn',
                      tipo: 'mensagem',
                      config: { texto: 'Atendimento comum' },
                    },
                  ],
                },
              ],
            },
          ],
        } as never,
      });
      const vip = await contatoEscreve('oi', { de: 'vera' });
      expect(
        (await mensagensDoBot(vip.conversaId)).map((m) => m.texto),
      ).toEqual(['Atendimento VIP']);
      const comum = await contatoEscreve('oi', { de: 'outro-visitante' });
      expect(
        (await mensagensDoBot(comum.conversaId)).map((m) => m.texto),
      ).toEqual(['Atendimento comum']);
    });

    it('cenário 56 — R18.5 — sem resposta: lembrete, depois encerramento (ramo sem_resposta)', async () => {
      await criarFluxoChatbot(t, {
        nome: 'Com prazo',
        definicao: {
          passos: [
            {
              id: 'q',
              tipo: 'pergunta.opcoes',
              config: {
                texto: 'Continua?',
                opcoes: [
                  { id: 's', rotulo: 'Sim' },
                  { id: 'n', rotulo: 'Não' },
                ],
                tempoSemResposta: {
                  lembreteAposMinutos: 5,
                  lembrete: 'Ainda está aí?',
                  encerrarAposMinutos: 15,
                },
              },
              ramos: [
                {
                  id: 'sem_resposta',
                  passos: [
                    {
                      id: 'adeus',
                      tipo: 'mensagem',
                      config: { texto: 'Encerrando por falta de resposta.' },
                    },
                  ],
                },
              ],
            },
          ],
        } as never,
      });
      const { conversaId } = await contatoEscreve('oi');
      let execucao = await execucaoDa(conversaId);
      expect(execucao.status).toBe('AGUARDANDO');
      expect(execucao.aguardandoAte!.getTime() - Date.now()).toBeGreaterThan(
        4 * 60_000,
      );
      expect(execucao.aguardandoAte!.getTime() - Date.now()).toBeLessThan(
        6 * 60_000,
      );

      await despertar(execucao.id, execucao.esperaToken);
      let textos = (await mensagensDoBot(conversaId)).map((m) => m.texto);
      expect(textos.at(-1)).toBe('Ainda está aí?');
      execucao = await execucaoDa(conversaId);
      expect(execucao.status).toBe('AGUARDANDO');
      // O encerramento fica 10 minutos depois do lembrete (15 − 5).
      expect(execucao.aguardandoAte!.getTime() - Date.now()).toBeGreaterThan(
        9 * 60_000,
      );

      await despertar(execucao.id, execucao.esperaToken);
      textos = (await mensagensDoBot(conversaId)).map((m) => m.texto);
      expect(textos.at(-1)).toBe('Encerrando por falta de resposta.');
      execucao = await execucaoDa(conversaId);
      expect(execucao.status).toBe('CONCLUIDA');
    });

    it('R18.5 — respostas inválidas além do limite encerram o fluxo', async () => {
      await criarFluxoChatbot(t, {
        definicao: {
          passos: [
            {
              id: 'q',
              tipo: 'pergunta.aberta',
              config: {
                texto: 'Qual seu e-mail?',
                variavel: 'e',
                validacao: 'email',
                tentativas: 2,
              },
            },
            { id: 'm', tipo: 'mensagem', config: { texto: 'nunca' } },
          ],
        } as never,
      });
      const { conversaId } = await contatoEscreve('oi');
      await contatoEscreve('x');
      await contatoEscreve('y');
      const execucao = await execucaoDa(conversaId);
      expect(execucao).toMatchObject({
        status: 'CONCLUIDA',
        motivoFim: 'respostas_invalidas',
      });
      expect(
        (await mensagensDoBot(conversaId)).map((m) => m.texto),
      ).not.toContain('nunca');
    });
  });

  describe('gatilhos e escolha do fluxo', () => {
    it('cenário 53 — R18.1 — palavra-chave, prioridade e canal restrito', async () => {
      const outroCanal = await criarCanal(t, {
        tipo: 'WEBCHAT',
        nome: 'Outro chat',
        filaPadrao: cenario.fila,
      });
      const msg = (texto: string) => ({
        definicao: {
          passos: [{ id: 'm', tipo: 'mensagem', config: { texto } }],
        } as never,
      });
      await criarFluxoChatbot(t, {
        nome: 'Geral',
        gatilho: 'NOVA_CONVERSA',
        prioridade: 0,
        ...msg('geral'),
      });
      await criarFluxoChatbot(t, {
        nome: 'Orçamento',
        gatilho: 'PALAVRA_CHAVE',
        palavrasChave: ['orçamento', 'cotação'],
        prioridade: 0,
        ...msg('orcamento'),
      });
      await criarFluxoChatbot(t, {
        nome: 'Só no outro',
        gatilho: 'NOVA_CONVERSA',
        canais: [outroCanal],
        prioridade: 10,
        ...msg('so-no-outro'),
      });
      await criarFluxoChatbot(t, {
        nome: 'Inativo',
        gatilho: 'NOVA_CONVERSA',
        ativo: false,
        prioridade: 99,
        ...msg('inativo'),
      });
      await criarFluxoChatbot(t, {
        nome: 'Rascunho',
        gatilho: 'NOVA_CONVERSA',
        publicar: false,
        prioridade: 99,
        ...msg('rascunho'),
      });

      const a = await contatoEscreve('olá', { de: 'a' });
      expect((await mensagensDoBot(a.conversaId)).map((m) => m.texto)).toEqual([
        'geral',
      ]);
      const b = await contatoEscreve('Preciso de uma COTAÇÃO', { de: 'b' });
      expect((await mensagensDoBot(b.conversaId)).map((m) => m.texto)).toEqual([
        'orcamento',
      ]);
      const c = await contatoEscreve('olá', { de: 'c', canal: outroCanal });
      expect((await mensagensDoBot(c.conversaId)).map((m) => m.texto)).toEqual([
        'so-no-outro',
      ]);
    });

    it('R18.1 — fora do horário só atende com o canal fechado; uma execução por conversa', async () => {
      const hoje = new Date();
      const horarioFechado = {
        fusoHorario: 'America/Sao_Paulo',
        dias: {
          [String((hoje.getUTCDay() + 3) % 7)]: [
            { inicio: '08:00', fim: '09:00' },
          ],
        },
      };
      const fechado = await criarCanal(t, {
        tipo: 'WEBCHAT',
        nome: 'Fechado',
        filaPadrao: cenario.fila,
        horarioAtendimento: horarioFechado,
      });
      await criarFluxoChatbot(t, {
        nome: 'Plantão',
        gatilho: 'FORA_DO_HORARIO',
        definicao: {
          passos: [
            {
              id: 'm',
              tipo: 'mensagem',
              config: { texto: 'Estamos fechados' },
            },
          ],
        } as never,
      });
      const aberto = await contatoEscreve('oi', { de: 'x' });
      expect(await mensagensDoBot(aberto.conversaId)).toHaveLength(0);
      const fora = await contatoEscreve('oi', { de: 'y', canal: fechado });
      expect(
        (await mensagensDoBot(fora.conversaId)).map((m) => m.texto),
      ).toEqual(['Estamos fechados']);
      // Mais mensagens na mesma conversa não reiniciam o fluxo.
      await contatoEscreve('alô?', { de: 'y', canal: fechado });
      expect(await mensagensDoBot(fora.conversaId)).toHaveLength(1);
      expect(
        await t.prisma.execucao.count({
          where: { conversaId: fora.conversaId },
        }),
      ).toBe(1);
    });

    it('R18.7 — editar ou publicar não muda a conversa em andamento; a nova já usa a nova versão', async () => {
      const fluxo = await criarFluxoChatbot(t, {
        nome: 'Versionado',
        area: 'COMERCIAL',
        definicao: {
          passos: [
            {
              id: 'q',
              tipo: 'pergunta.aberta',
              config: { texto: 'Seu nome?', variavel: 'n' },
            },
            {
              id: 'm',
              tipo: 'mensagem',
              config: { texto: 'Obrigado, {{variaveis.n}} (v1)' },
            },
          ],
        } as never,
      });
      const antiga = await contatoEscreve('oi', { de: 'antigo' });

      await lider
        .put(`/api/v1/chatbot/fluxos/${fluxo.id}/rascunho`)
        .send({
          definicao: {
            passos: [
              {
                id: 'q',
                tipo: 'pergunta.aberta',
                config: { texto: 'Seu nome?', variavel: 'n' },
              },
              {
                id: 'm',
                tipo: 'mensagem',
                config: { texto: 'Valeu, {{variaveis.n}} (v2)' },
              },
            ],
          },
        })
        .expect(200);
      await lider
        .post(`/api/v1/chatbot/fluxos/${fluxo.id}/publicar`)
        .send({})
        .expect(200);

      await contatoEscreve('Ana', { de: 'antigo' });
      expect((await mensagensDoBot(antiga.conversaId)).at(-1)?.texto).toBe(
        'Obrigado, Ana (v1)',
      );
      const nova = await contatoEscreve('oi', { de: 'novo' });
      await contatoEscreve('Bia', { de: 'novo' });
      expect((await mensagensDoBot(nova.conversaId)).at(-1)?.texto).toBe(
        'Valeu, Bia (v2)',
      );
      const versoes = await t.prisma.execucao.findMany({
        where: { fluxoId: fluxo.id },
        select: { fluxoVersao: { select: { numero: true } } },
        orderBy: { criadoEm: 'asc' },
      });
      expect(versoes.map((v) => v.fluxoVersao?.numero)).toEqual([1, 2]);
    });
  });

  describe('atendente assume', () => {
    async function comFluxoEsperando() {
      await criarFluxoChatbot(t, {
        nome: 'Espera',
        definicao: {
          passos: [
            {
              id: 'q',
              tipo: 'pergunta.aberta',
              config: { texto: 'Seu nome?', variavel: 'n' },
            },
            {
              id: 'm',
              tipo: 'mensagem',
              config: { texto: 'Oi, {{variaveis.n}}' },
            },
          ],
        } as never,
      });
      const { conversaId } = await contatoEscreve('oi');
      return conversaId;
    }

    it('cenário 59 — R18.8 — o atendente que responde cancela o fluxo; a resposta do contato depois já não é lida pelo bot', async () => {
      const conversaId = await comFluxoEsperando();
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const atendente = await entrarComo(
        t,
        [...cenario.comercial.membros].find(
          (m) => m.id === conversa.responsavelId,
        )!,
      );
      await atendente
        .post(`/api/v1/atendimento/conversas/${conversaId}/mensagens`)
        .send({ texto: 'Oi, aqui é a Ana, posso ajudar?' })
        .expect(201);
      // Mesmo antes de a mensagem do atendente sair pelo canal, a resposta do
      // contato já não vai para o bot.
      const antes = await mensagensDoBot(conversaId);
      await contatoEscreve('João');
      expect(await mensagensDoBot(conversaId)).toHaveLength(antes.length);
      expect(await execucaoDa(conversaId)).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'atendente_assumiu',
      });
      // E o evento "mensagem enviada" do atendente, que chega depois, não atrapalha.
      await drenarEnvios(t);
      await processarEventos(t);
    });

    it('R18.8 — assumir a conversa (sem responsável) e resolver também param o fluxo', async () => {
      const conversaId = await comFluxoEsperando();
      await t.prisma.conversa.update({
        where: { id: conversaId },
        data: { responsavelId: null },
      });
      const atendente = await entrarComo(t, cenario.comercial.membros[1]);
      await atendente
        .post(`/api/v1/atendimento/conversas/${conversaId}/assumir`)
        .expect(200);
      await processarEventos(t);
      expect(await execucaoDa(conversaId)).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'atendente_assumiu',
      });
    });

    it('R18.8 — resolver a conversa cancela o fluxo em andamento', async () => {
      const conversaId = await comFluxoEsperando();
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const atendente = await entrarComo(
        t,
        [...cenario.comercial.membros].find(
          (m) => m.id === conversa.responsavelId,
        )!,
      );
      await atendente
        .post(`/api/v1/atendimento/conversas/${conversaId}/resolver`)
        .send({})
        .expect(200);
      await processarEventos(t);
      expect(await execucaoDa(conversaId)).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'conversa_resolvida',
      });
    });

    it('R18.8 — conversa em que o atendente já atuou não inicia fluxo', async () => {
      await criarFluxoChatbot(t, {
        nome: 'Sempre',
        gatilho: 'SEMPRE',
        definicao: {
          passos: [{ id: 'm', tipo: 'mensagem', config: { texto: 'bot' } }],
        } as never,
      });
      // Conversa aberta e atendida antes de o bot ser ativado.
      const desativado = await t.prisma.fluxoChatbot.updateMany({
        data: { ativo: false },
      });
      expect(desativado.count).toBe(1);
      const { conversaId } = await contatoEscreve('oi');
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const atendente = await entrarComo(
        t,
        [...cenario.comercial.membros].find(
          (m) => m.id === conversa.responsavelId,
        )!,
      );
      await atendente
        .post(`/api/v1/atendimento/conversas/${conversaId}/mensagens`)
        .send({ texto: 'Olá!' })
        .expect(201);
      await t.prisma.fluxoChatbot.updateMany({ data: { ativo: true } });
      await contatoEscreve('e aí?');
      expect(await mensagensDoBot(conversaId)).toHaveLength(0);
    });

    it('R18.8 — fluxo excluído cancela as execuções em andamento', async () => {
      const conversaId = await comFluxoEsperando();
      const execucao = await execucaoDa(conversaId);
      await admin
        .delete(`/api/v1/chatbot/fluxos/${execucao.fluxoId}`)
        .expect(204);
      expect(await execucaoDa(conversaId)).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'fluxo_excluido',
      });
    });
  });

  describe('simulador', () => {
    it('cenário 60 — R18.9 — roda o rascunho sem efeitos reais: transcrição, opções, silêncio e resumo da transferência', async () => {
      const { body } = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Simulado',
          canalIds: [cenario.canal.id],
          gatilho: 'NOVA_CONVERSA',
          definicao: {
            passos: [
              {
                id: 'boas',
                tipo: 'mensagem',
                config: { texto: 'Oi, {{contato.primeiro_nome}}!' },
              },
              {
                id: 'menu',
                tipo: 'pergunta.opcoes',
                config: {
                  texto: 'Quer falar com a equipe?',
                  opcoes: [
                    { id: 'sim', rotulo: 'Sim' },
                    { id: 'nao', rotulo: 'Não' },
                  ],
                  tempoSemResposta: {
                    lembreteAposMinutos: 10,
                    lembrete: 'Alô?',
                  },
                },
                ramos: [
                  {
                    id: 'sim',
                    passos: [
                      {
                        id: 'et',
                        tipo: 'acao.etiquetar',
                        config: { adicionar: ['Simulado'] },
                      },
                      {
                        id: 'tr',
                        tipo: 'transferir',
                        config: {
                          filaId: cenario.fila.id,
                          mensagem: 'Já chamo alguém.',
                        },
                      },
                    ],
                  },
                  {
                    id: 'nao',
                    passos: [
                      {
                        id: 'fim',
                        tipo: 'mensagem',
                        config: { texto: 'Tudo bem!' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })
        .expect(201);
      const id = body.id as string;

      const inicio = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador`)
        .send({ contato: { nome: 'Carla Teste' }, canalTipo: 'WEBCHAT' })
        .expect(201);
      expect(inicio.body.status).toBe('AGUARDANDO');
      expect(inicio.body.aguardando).toMatchObject({
        tipo: 'opcoes',
        temTempo: true,
      });
      expect(
        inicio.body.aguardando.opcoes.map((o: { rotulo: string }) => o.rotulo),
      ).toEqual(['Sim', 'Não']);
      expect(
        inicio.body.transcricao.map((i: { de: string; texto: string }) => [
          i.de,
          i.texto.split('\n')[0],
        ]),
      ).toEqual([
        ['bot', 'Oi, Carla!'],
        ['bot', 'Quer falar com a equipe?'],
      ]);
      const execId = inicio.body.execucaoId as string;

      // O tempo passa: sai o lembrete e a espera por tempo acaba (sem encerramento configurado).
      const aposSilencio = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador/${execId}/silencio`)
        .expect(200);
      expect(aposSilencio.body.transcricao.at(-1)).toMatchObject({
        de: 'bot',
        texto: 'Alô?',
      });
      await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador/${execId}/silencio`)
        .expect(409);

      const fim = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador/${execId}/mensagens`)
        .send({ texto: '1' })
        .expect(200);
      expect(fim.body.status).toBe('CONCLUIDA');
      expect(fim.body.motivoFim).toBe('transferida_para_humano');
      const linhas = fim.body.transcricao.map(
        (i: { de: string; texto: string }) =>
          `${i.de}: ${i.texto.split('\n')[0]}`,
      );
      expect(linhas).toEqual(
        expect.arrayContaining([
          'contato: 1',
          'sistema: Etiquetas do contato (simulado)',
          'bot: Já chamo alguém.',
          'sistema: Transferido para a equipe (simulado).',
        ]),
      );
      await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador/${execId}/mensagens`)
        .send({ texto: 'x' })
        .expect(409);

      // Nada real aconteceu.
      expect(
        await t.prisma.mensagem.count({ where: { autorTipo: 'BOT' } }),
      ).toBe(0);
      expect(await t.prisma.conversa.count()).toBe(0);
      expect(
        await t.prisma.contato.count({
          where: { etiquetas: { has: 'Simulado' } },
        }),
      ).toBe(0);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'chatbot.transferida' },
        }),
      ).toBe(0);
      // As simulações não entram nos contadores nem no histórico.
      const execs = await lider
        .get(`/api/v1/chatbot/fluxos/${id}/execucoes`)
        .expect(200);
      expect(execs.body.itens).toHaveLength(0);

      // Outro usuário comum não acessa a simulação de alguém.
      const liderCs = await entrarComo(t, cenario.cs.lider);
      await liderCs
        .get(`/api/v1/chatbot/fluxos/${id}/simulador/${execId}`)
        .expect(404);
    });

    it('R18.9 — recusa simular fluxo com problemas e simula "fora do horário" na condição de horário', async () => {
      const { body } = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Horário',
          canalIds: [cenario.canal.id],
          gatilho: 'NOVA_CONVERSA',
          definicao: {
            passos: [
              {
                id: 'se',
                tipo: 'condicao',
                ramos: [
                  {
                    id: 'aberto',
                    config: { condicao: { tipo: 'horario' } },
                    passos: [
                      {
                        id: 'a',
                        tipo: 'mensagem',
                        config: { texto: 'Aberto' },
                      },
                    ],
                  },
                  {
                    id: 'fechado',
                    passos: [
                      {
                        id: 'f',
                        tipo: 'mensagem',
                        config: { texto: 'Fechado' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })
        .expect(201);
      const id = body.id as string;
      const aberto = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador`)
        .send({})
        .expect(201);
      expect(aberto.body.transcricao[0].texto).toBe('Aberto');
      const fechado = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador`)
        .send({ horarioAberto: false })
        .expect(201);
      expect(fechado.body.transcricao[0].texto).toBe('Fechado');
      expect(fechado.body.status).toBe('CONCLUIDA');

      await lider
        .put(`/api/v1/chatbot/fluxos/${id}/rascunho`)
        .send({
          definicao: {
            passos: [{ id: 'x', tipo: 'acao.etiquetar', config: {} }],
          },
        })
        .expect(200);
      const recusada = await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador`)
        .send({})
        .expect(400);
      expect(recusada.body.detalhes.problemas[0]).toMatchObject({
        passoId: 'x',
      });
      // A versão publicada pode ser simulada só se existir.
      await lider
        .post(`/api/v1/chatbot/fluxos/${id}/simulador`)
        .send({ origem: 'publicada' })
        .expect(422);
    });

    it('R18.9 — encerrar a simulação a cancela', async () => {
      const { body } = await lider
        .post('/api/v1/chatbot/fluxos')
        .send({
          nome: 'Parar',
          canalIds: [cenario.canal.id],
          gatilho: 'SEMPRE',
          definicao: {
            passos: [
              {
                id: 'q',
                tipo: 'pergunta.aberta',
                config: { texto: 'Nome?', variavel: 'n' },
              },
            ],
          },
        })
        .expect(201);
      const sim = await lider
        .post(`/api/v1/chatbot/fluxos/${body.id}/simulador`)
        .send({})
        .expect(201);
      await lider
        .delete(
          `/api/v1/chatbot/fluxos/${body.id}/simulador/${sim.body.execucaoId}`,
        )
        .expect(204);
      const estado = await lider
        .get(
          `/api/v1/chatbot/fluxos/${body.id}/simulador/${sim.body.execucaoId}`,
        )
        .expect(200);
      expect(estado.body).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'simulacao_encerrada',
      });
    });
  });

  describe('webhook de saída do passo', () => {
    it('R18.4 — destino em rede interna é bloqueado (mesma proteção dos webhooks de saída) e o fluxo segue', async () => {
      await criarFluxoChatbot(t, {
        nome: 'Webhook',
        definicao: {
          passos: [
            {
              id: 'w',
              tipo: 'acao.webhook',
              config: { url: 'http://127.0.0.1:9/gancho' },
            },
            { id: 'm', tipo: 'mensagem', config: { texto: 'seguiu' } },
          ],
        } as never,
      });
      const { conversaId } = await contatoEscreve('oi');
      const execucao = await execucaoDa(conversaId);
      expect(execucao.status).toBe('CONCLUIDA');
      const passo = await t.prisma.execucaoPasso.findFirstOrThrow({
        where: { execucaoId: execucao.id, passoId: 'w' },
      });
      expect(
        (passo.resultado as { saida: { bloqueado: boolean } }).saida.bloqueado,
      ).toBe(true);
      expect((await mensagensDoBot(conversaId)).map((m) => m.texto)).toEqual([
        'seguiu',
      ]);
    });
  });

  it('R18 — a fila de passos fica vazia depois de tudo (nada preso)', async () => {
    await criarFluxoChatbot(t, {
      definicao: {
        passos: [{ id: 'm', tipo: 'mensagem', config: { texto: 'oi' } }],
      } as never,
    });
    await contatoEscreve('oi');
    expect(await drenarTudo(t)).toBeGreaterThanOrEqual(0);
    expect(
      await t.prisma.execucao.count({
        where: { status: { in: ['EM_ANDAMENTO'] } },
      }),
    ).toBe(0);
  });
});
