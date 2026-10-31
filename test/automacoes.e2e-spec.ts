import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { seguir } from '../src/comum/passos/tipos';
import {
  type AppTeste,
  avancarPassos,
  criarAppTeste,
  criarCanalWhatsapp,
  criarContato,
  criarConversa,
  criarEquipe,
  criarFluxoChatbot,
  criarNegocio,
  criarUsuario,
  drenarTudo,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
  passoDeTeste,
  processarEventos,
} from './utils';

type Cliente = Awaited<ReturnType<typeof entrarComo>>;

const GATILHO_CONTATO_CRIADO = {
  tipoGatilho: 'EVENTO',
  evento: 'contato.criado',
} as const;

describe('Automações e cadências (e2e, R19)', () => {
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

  async function criarAtiva(
    cliente: Cliente,
    dados: Record<string, unknown>,
  ): Promise<{ id: string; [chave: string]: unknown }> {
    const criada = await cliente
      .post('/api/v1/automacoes', {
        nome: 'Automação de teste',
        ...GATILHO_CONTATO_CRIADO,
        ...dados,
      })
      .expect(201);
    const ativada = await cliente
      .post(`/api/v1/automacoes/${criada.body.id}/ativar`)
      .expect(200);
    return ativada.body;
  }

  /** Entrega os eventos e roda os passos até assentar (as esperas só com `incluirAgendados`). */
  async function assentar(incluirAgendados = false): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await processarEventos(t, { incluirAgendados });
      await avancarPassos(t, { incluirAgendados });
    }
  }

  const etiquetar = (...adicionar: string[]) => ({
    passos: [{ id: 'p1', tipo: 'acao.etiquetar', config: { adicionar } }],
  });

  async function execucoesDe(automacaoId: string) {
    return t.prisma.execucao.findMany({
      where: { automacaoId },
      orderBy: { criadoEm: 'asc' },
    });
  }

  // ---------------------------------------------------------------------
  describe('permissões (R19.1)', () => {
    it('cenário 61 — R19.1 — membro não usa as automações (403); Admin, C-level e líder usam', async () => {
      const equipe = await criarEquipe(t, 'COMERCIAL');
      const membro = await entrarComo(t, equipe.membros[0]);
      await membro.get('/api/v1/automacoes').expect(403);
      await membro
        .post('/api/v1/automacoes', { nome: 'x', ...GATILHO_CONTATO_CRIADO })
        .expect(403);
      const lider = await entrarComo(t, equipe.lider);
      await lider.get('/api/v1/automacoes').expect(200);
      const cLevel = await entrarComo(t, equipe.cLevel);
      await cLevel.get('/api/v1/automacoes/catalogo').expect(200);
    });

    it('R19.1 — o líder só cria e vê automações da própria área; a diretoria vê todas', async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      const marketing = await criarEquipe(t, 'MARKETING', {
        cLevel: comercial.cLevel,
      });
      const liderComercial = await entrarComo(t, comercial.lider);
      const liderMarketing = await entrarComo(t, marketing.lider);
      const criada = await liderComercial
        .post('/api/v1/automacoes', {
          nome: 'Do comercial',
          area: 'MARKETING',
          ...GATILHO_CONTATO_CRIADO,
        })
        .expect(201);
      expect(criada.body.area).toBe('COMERCIAL');
      await liderMarketing
        .get(`/api/v1/automacoes/${criada.body.id}`)
        .expect(404);
      await liderMarketing
        .patch(`/api/v1/automacoes/${criada.body.id}`, { nome: 'x' })
        .expect(404);
      const lista = await liderMarketing.get('/api/v1/automacoes').expect(200);
      expect(lista.body.total).toBe(0);
      const todas = await admin.get('/api/v1/automacoes').expect(200);
      expect(todas.body.total).toBe(1);
      const global = await admin
        .post('/api/v1/automacoes', {
          nome: 'Global',
          ...GATILHO_CONTATO_CRIADO,
        })
        .expect(201);
      expect(global.body.area).toBeNull();
      await liderComercial
        .get(`/api/v1/automacoes/${global.body.id}`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  describe('cadastro, validação e ativação (R19.10)', () => {
    it('R19.10 — nasce pausada; ativar sem ações dá 422 com as pendências', async () => {
      const criada = await admin
        .post('/api/v1/automacoes', {
          nome: 'Vazia',
          ...GATILHO_CONTATO_CRIADO,
        })
        .expect(201);
      expect(criada.body.ativa).toBe(false);
      expect(criada.body.entidade).toBe('contato');
      expect(criada.body.pendencias).toEqual(['Adicione ao menos uma ação.']);
      const resposta = await admin
        .post(`/api/v1/automacoes/${criada.body.id}/ativar`)
        .expect(422);
      expect(resposta.body.detalhes.regra).toBe('R19');
      expect(resposta.body.detalhes.pendencias).toHaveLength(1);
    });

    it('R19.2 — gatilho, filtro e passo inválidos são recusados (400)', async () => {
      await admin
        .post('/api/v1/automacoes', {
          nome: 'x',
          tipoGatilho: 'EVENTO',
          evento: 'nao.existe',
        })
        .expect(400);
      await admin
        .post('/api/v1/automacoes', {
          nome: 'x',
          ...GATILHO_CONTATO_CRIADO,
          gatilhoConfig: { etapaId: 'abc' },
        })
        .expect(400);
      await admin
        .post('/api/v1/automacoes', {
          nome: 'x',
          ...GATILHO_CONTATO_CRIADO,
          definicao: { passos: [{ id: 'a', tipo: 'acao.inexistente' }] },
        })
        .expect(400);
      const corpo = await admin
        .post('/api/v1/automacoes', {
          nome: 'x',
          ...GATILHO_CONTATO_CRIADO,
          definicao: {
            passos: [{ id: 'a', tipo: 'acao.etiquetar', config: {} }],
          },
        })
        .expect(400);
      expect(corpo.body.detalhes.problemas[0].mensagem).toMatch(/etiqueta/i);
      const previa = await admin
        .post('/api/v1/automacoes/validar', {
          nome: 'x',
          tipoGatilho: 'EVENTO',
          evento: 'negocio.movido',
          definicao: etiquetar('vip'),
        })
        .expect(200);
      expect(previa.body).toMatchObject({ valido: true, entidade: 'negocio' });
      expect(previa.body.pendencias[0]).toMatch(/etapa/);
    });

    it('R19.10 — editar muda a versão; execução em andamento segue na versão em que começou', async () => {
      const contato = await criarContato(t);
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'aguardar',
              config: { quantidade: 1, unidade: 'horas' },
            },
            { id: 'p2', tipo: 'acao.etiquetar', config: { adicionar: ['v1'] } },
          ],
        },
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Ana', email: 'ana@teste.local' })
        .expect(201);
      await assentar();
      const [primeira] = await execucoesDe(automacao.id as string);
      expect(primeira.automacaoVersao).toBe(1);
      const editada = await admin
        .patch(`/api/v1/automacoes/${automacao.id}`, {
          definicao: {
            passos: [
              {
                id: 'p1',
                tipo: 'acao.etiquetar',
                config: { adicionar: ['v2'] },
              },
            ],
          },
        })
        .expect(200);
      expect(editada.body.versao).toBe(2);
      await admin
        .patch(`/api/v1/automacoes/${automacao.id}`, { nome: 'Só o nome' })
        .expect(200)
        .expect((r) => expect(r.body.versao).toBe(2));
      await assentar(true);
      const ana = await t.prisma.contato.findFirstOrThrow({
        where: { nome: 'Ana' },
      });
      expect(ana.etiquetas).toEqual(['v1']);
      expect(contato.etiquetas).toEqual([]);
      // Uma ativa não pode ficar incompleta.
      await admin
        .patch(`/api/v1/automacoes/${automacao.id}`, {
          definicao: { passos: [] },
        })
        .expect(422);
    });

    it('R19.10 — duplicar cria uma cópia pausada; excluir cancela as execuções em andamento', async () => {
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'aguardar',
              config: { quantidade: 2, unidade: 'dias' },
            },
            { id: 'p2', tipo: 'acao.etiquetar', config: { adicionar: ['x'] } },
          ],
        },
      });
      const copia = await admin
        .post(`/api/v1/automacoes/${automacao.id}/duplicar`)
        .expect(201);
      expect(copia.body).toMatchObject({
        ativa: false,
        nome: 'Automação de teste (cópia)',
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Bia', email: 'bia@teste.local' })
        .expect(201);
      await assentar();
      expect((await execucoesDe(automacao.id as string))[0].status).toBe(
        'AGUARDANDO',
      );
      await admin.delete(`/api/v1/automacoes/${automacao.id}`).expect(204);
      expect((await execucoesDe(automacao.id as string))[0]).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'automacao_excluida',
      });
      await admin.get(`/api/v1/automacoes/${automacao.id}`).expect(404);
      const lista = await admin.get('/api/v1/automacoes').expect(200);
      expect(lista.body.itens.map((i: { id: string }) => i.id)).toEqual([
        copia.body.id,
      ]);
    });

    it('R19.10 — pausar impede novas execuções; as em andamento ficam suspensas até reativar', async () => {
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'aguardar',
              config: { quantidade: 1, unidade: 'horas' },
            },
            {
              id: 'p2',
              tipo: 'acao.etiquetar',
              config: { adicionar: ['depois'] },
            },
          ],
        },
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Caio', email: 'caio@teste.local' })
        .expect(201);
      await assentar();
      await admin
        .post(`/api/v1/automacoes/${automacao.id}/pausar`, {})
        .expect(200);
      await admin
        .post('/api/v1/contatos', { nome: 'Duda', email: 'duda@teste.local' })
        .expect(201);
      await assentar(true);
      expect(await execucoesDe(automacao.id as string)).toHaveLength(1);
      const caio = () =>
        t.prisma.contato.findFirstOrThrow({ where: { nome: 'Caio' } });
      expect((await caio()).etiquetas).toEqual([]);
      await admin.post(`/api/v1/automacoes/${automacao.id}/ativar`).expect(200);
      await assentar(true);
      expect((await caio()).etiquetas).toEqual(['depois']);
    });
  });

  // ---------------------------------------------------------------------
  describe('gatilhos, condições e ações (R19.2 a R19.4)', () => {
    it('cenário 62 — R19.2 e R19.4 — contato novo dispara a automação; a ação passa pelo serviço com ator AUTOMACAO', async () => {
      const automacao = await criarAtiva(admin, {
        nome: 'Etiqueta de boas-vindas',
        definicao: etiquetar('novo-lead'),
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Eva', email: 'eva@teste.local' })
        .expect(201);
      await assentar();
      const eva = await t.prisma.contato.findFirstOrThrow({
        where: { nome: 'Eva' },
      });
      expect(eva.etiquetas).toEqual(['novo-lead']);
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao).toMatchObject({
        status: 'CONCLUIDA',
        entidade: 'contato',
        entidadeId: eva.id,
      });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.atualizado', entidadeId: eva.id },
        orderBy: { id: 'desc' },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        atorDescricao: 'Etiqueta de boas-vindas',
      });
      // Histórico por automação e por entidade.
      const porAutomacao = await admin
        .get(`/api/v1/automacoes/execucoes?automacaoId=${automacao.id}`)
        .expect(200);
      expect(porAutomacao.body.total).toBe(1);
      const porEntidade = await admin
        .get(
          `/api/v1/automacoes/execucoes?entidade=contato&entidadeId=${eva.id}`,
        )
        .expect(200);
      expect(porEntidade.body.itens[0]).toMatchObject({
        id: execucao.id,
        status: 'CONCLUIDA',
      });
      const detalhe = await admin
        .get(`/api/v1/automacoes/execucoes/${execucao.id}`)
        .expect(200);
      expect(detalhe.body.passos).toMatchObject([
        { passoId: 'p1', tipo: 'acao.etiquetar', status: 'CONCLUIDO' },
      ]);
      // "Última vez" da lista: toda execução nova a atualiza (não só os gatilhos de agenda).
      const lista = await admin.get('/api/v1/automacoes').expect(200);
      const linha = (
        lista.body.itens as Array<{
          id: string;
          ultimaExecucaoEm: string | null;
        }>
      ).find((a) => a.id === automacao.id);
      expect(linha?.ultimaExecucaoEm).not.toBeNull();
    });

    it('R19.2 — filtro do gatilho: só o negócio movido para a etapa escolhida dispara', async () => {
      const [, destino, outra] = (
        await funilBase(t, 'COMERCIAL')
      ).etapas.filter((e) => e.tipo === 'ABERTA');
      const automacao = await criarAtiva(admin, {
        tipoGatilho: 'EVENTO',
        evento: 'negocio.movido',
        gatilhoConfig: { etapaId: destino.id },
        definicao: etiquetar('proposta'),
      });
      const contatoA = await criarContato(t);
      const contatoB = await criarContato(t);
      const negocioA = await criarNegocio(t, { contato: contatoA });
      const negocioB = await criarNegocio(t, { contato: contatoB });
      await admin
        .post(`/api/v1/negocios/${negocioA.id}/mover`, { etapaId: destino.id })
        .expect(200);
      await admin
        .post(`/api/v1/negocios/${negocioB.id}/mover`, { etapaId: outra.id })
        .expect(200);
      await assentar();
      const execucoes = await execucoesDe(automacao.id as string);
      expect(execucoes).toHaveLength(1);
      expect(execucoes[0]).toMatchObject({
        entidade: 'negocio',
        entidadeId: negocioA.id,
        contatoId: contatoA.id,
      });
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contatoA.id },
          })
        ).etiquetas,
      ).toEqual(['proposta']);
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contatoB.id },
          })
        ).etiquetas,
      ).toEqual([]);
    });

    it('R19.2 — mensagem recebida contendo a palavra dispara (sem acento nem caixa)', async () => {
      const { canal } = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511900000000',
      });
      const automacao = await criarAtiva(admin, {
        tipoGatilho: 'EVENTO',
        evento: 'mensagem.recebida',
        entidade: 'conversa',
        gatilhoConfig: { palavras: ['cotação'] },
        definicao: etiquetar('quer-cotacao'),
      });
      const contato = await criarContato(t);
      const conversa = await criarConversa(t, { canal, contato });
      const publicar = async (texto: string) => {
        const mensagem = await t.prisma.mensagem.create({
          data: {
            conversaId: conversa.id,
            canalId: canal.id,
            direcao: 'ENTRADA',
            texto,
            autorTipo: 'USUARIO',
          },
        });
        await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
          t.prisma.$transaction((tx) =>
            t.eventos.publicar(tx, 'mensagem.recebida', {
              mensagemId: mensagem.id,
              conversaId: conversa.id,
              canalId: canal.id,
              canalTipo: 'WHATSAPP',
              contatoId: contato.id,
            }),
          ),
        );
      };
      await publicar('Bom dia, tudo bem?');
      await publicar('Gostaria de uma COTACAO, por favor');
      await assentar();
      const execucoes = await execucoesDe(automacao.id as string);
      expect(execucoes).toHaveLength(1);
      expect(execucoes[0]).toMatchObject({
        entidade: 'conversa',
        entidadeId: conversa.id,
        contatoId: contato.id,
      });
    });

    it('R19.3 — a condição de segmento deixa de fora quem não está nele', async () => {
      const automacao = await criarAtiva(admin, {
        condicoes: {
          segmento: {
            condicoes: [
              { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
            ],
          },
        },
        definicao: etiquetar('tratado'),
      });
      await admin
        .post('/api/v1/contatos', {
          nome: 'Vip',
          email: 'vip@teste.local',
          etiquetas: ['vip'],
        })
        .expect(201);
      await admin
        .post('/api/v1/contatos', { nome: 'Comum', email: 'comum@teste.local' })
        .expect(201);
      await assentar();
      const execucoes = await execucoesDe(automacao.id as string);
      expect(execucoes).toHaveLength(1);
      const vip = await t.prisma.contato.findFirstOrThrow({
        where: { nome: 'Vip' },
      });
      expect(execucoes[0].entidadeId).toBe(vip.id);
    });

    it('R19.3 — fora do horário permitido, as ações esperam a próxima abertura', async () => {
      const hoje = new Date();
      const outroDia = String((hoje.getUTCDay() + 3) % 7);
      const automacao = await criarAtiva(admin, {
        condicoes: {
          horario: {
            fusoHorario: 'America/Sao_Paulo',
            dias: { [outroDia]: [{ inicio: '09:00', fim: '10:00' }] },
          },
        },
        definicao: etiquetar('no-horario'),
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Fabio', email: 'fabio@teste.local' })
        .expect(201);
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('AGUARDANDO');
      expect(execucao.aguardandoAte!.getTime()).toBeGreaterThan(Date.now());
      const fabio = await t.prisma.contato.findFirstOrThrow({
        where: { nome: 'Fabio' },
      });
      expect(fabio.etiquetas).toEqual([]);
    });

    it('R19.4 — WhatsApp por modelo: renderiza para o contato e cria a mensagem pelo Atendimento (autor AUTOMACAO)', async () => {
      const { canal } = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511900000000',
      });
      const modelo = await admin
        .post('/api/v1/modelos-mensagem', {
          nome: 'Boas-vindas',
          canal: 'WHATSAPP',
          texto: 'Olá, {{contato.primeiro_nome}}! Bem-vindo.',
        })
        .expect(201);
      const automacao = await criarAtiva(admin, {
        marketing: true,
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'acao.whatsapp',
              config: { modeloId: modelo.body.id },
            },
          ],
        },
      });
      await admin
        .post('/api/v1/contatos', {
          nome: 'Gabriela Souza',
          telefone: '11988887777',
        })
        .expect(201);
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('CONCLUIDA');
      const mensagem = await t.prisma.mensagem.findFirstOrThrow({
        where: { canalId: canal.id },
      });
      expect(mensagem).toMatchObject({
        direcao: 'SAIDA',
        texto: 'Olá, Gabriela! Bem-vindo.',
        autorTipo: 'AUTOMACAO',
        autorId: null,
      });
      expect(mensagem.metadados).toMatchObject({
        automacaoId: automacao.id,
        execucaoId: execucao.id,
      });
      // Reentrega do passo não duplica a mensagem (idempotência).
      const total = await t.prisma.mensagem.count();
      await t.prisma.execucao.update({
        where: { id: execucao.id },
        data: { status: 'FALHOU', passoAtualId: 'p1', concluidaEm: null },
      });
      await t.prisma.execucaoPasso.updateMany({
        where: { execucaoId: execucao.id },
        data: { status: 'ERRO' },
      });
      await admin
        .post(`/api/v1/automacoes/execucoes/${execucao.id}/reexecutar`)
        .expect(200);
      await avancarPassos(t);
      expect(await t.prisma.mensagem.count()).toBe(total);
    });

    it('cenário 63 — R19.4 — cadência: ações intercaladas por esperas, com atividade, notificação e etiqueta', async () => {
      const equipe = await criarEquipe(t, 'COMERCIAL');
      const contato = await criarContato(t, { responsavel: equipe.membros[0] });
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'a1',
              tipo: 'acao.notificar',
              config: {
                para: 'responsavel',
                titulo: 'Novo lead: {{contato.nome}}',
              },
            },
            {
              id: 'a2',
              tipo: 'aguardar',
              config: { quantidade: 2, unidade: 'dias' },
            },
            {
              id: 'a3',
              tipo: 'acao.atividade',
              config: {
                tipo: 'LIGACAO',
                titulo: 'Ligar para {{contato.primeiro_nome}}',
                prazo: { quantidade: 1, unidade: 'dias' },
              },
            },
            {
              id: 'a4',
              tipo: 'acao.etiquetar',
              config: { adicionar: ['cadencia'], remover: ['frio'] },
            },
          ],
        },
      });
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { etiquetas: ['frio'] },
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: contato.id }),
        ),
      );
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('AGUARDANDO');
      expect(
        await t.prisma.notificacao.count({
          where: { usuarioId: equipe.membros[0].id },
        }),
      ).toBe(1);
      expect(await t.prisma.atividade.count()).toBe(0);
      await assentar(true);
      const final = await t.prisma.execucao.findUniqueOrThrow({
        where: { id: execucao.id },
      });
      expect(final.status).toBe('CONCLUIDA');
      const atividade = await t.prisma.atividade.findFirstOrThrow();
      expect(atividade).toMatchObject({
        titulo: `Ligar para ${contato.nome.split(' ')[0]}`,
        responsavelId: equipe.membros[0].id,
        contatoId: contato.id,
        tipo: 'LIGACAO',
      });
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contato.id },
          })
        ).etiquetas,
      ).toEqual(['cadencia']);
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'atividade.criada' },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        atorDescricao: automacao.nome,
      });
    });

    it('R19.4 — mover etapa, atribuir (rodízio) e criar negócio em outro funil usam as regras de funis', async () => {
      const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
      const contato = await criarContato(t);
      const negocio = await criarNegocio(t, { contato, responsavel: null });
      const funilMarketing = await funilBase(t, 'MARKETING');
      const proposta = (await funilBase(t, 'COMERCIAL')).etapas.filter(
        (e) => e.tipo === 'ABERTA',
      )[1];
      const automacao = await criarAtiva(admin, {
        tipoGatilho: 'EVENTO',
        evento: 'negocio.criado',
        definicao: {
          passos: [
            {
              id: 'm',
              tipo: 'acao.mover_etapa',
              config: { etapaId: proposta.id },
            },
            {
              id: 'r',
              tipo: 'acao.atribuir',
              config: { estrategia: 'RODIZIO' },
            },
            {
              id: 'n',
              tipo: 'acao.criar_negocio',
              config: {
                funilId: funilMarketing.id,
                titulo: 'Nutrir {{contato.nome}}',
              },
            },
          ],
        },
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'negocio.criado', {
            negocioId: negocio.id,
            contatoId: contato.id,
          }),
        ),
      );
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao).toMatchObject({
        status: 'CONCLUIDA',
        entidade: 'negocio',
      });
      const depois = await t.prisma.negocio.findUniqueOrThrow({
        where: { id: negocio.id },
      });
      expect(depois.etapaId).toBe(proposta.id);
      expect(
        equipe.membros
          .map((m) => m.id)
          .concat(equipe.lider.id, equipe.cLevel.id),
      ).toContain(depois.responsavelId);
      const novo = await t.prisma.negocio.findFirstOrThrow({
        where: { funilId: funilMarketing.id },
      });
      expect(novo).toMatchObject({
        contatoId: contato.id,
        titulo: `Nutrir ${contato.nome}`,
      });
      const movimentacao = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'negocio.movido' },
      });
      expect(movimentacao.tipoAtor).toBe('AUTOMACAO');
    });

    it('R19.4 — iniciar fluxo do chatbot na conversa em aberto do contato', async () => {
      const contato = await criarContato(t);
      const conversa = await criarConversa(t, { contato });
      const fluxo = await criarFluxoChatbot(t, {
        definicao: { passos: [{ id: 'f1', tipo: 'encerrar' }] },
      });
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            { id: 'p1', tipo: 'acao.chatbot', config: { fluxoId: fluxo.id } },
          ],
        },
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: contato.id }),
        ),
      );
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('CONCLUIDA');
      const doFluxo = await t.prisma.execucao.findFirstOrThrow({
        where: { tipo: 'CHATBOT', fluxoId: fluxo.id },
      });
      expect(doFluxo).toMatchObject({
        conversaId: conversa.id,
        contatoId: contato.id,
        status: 'CONCLUIDA',
      });
    });

    it('R19.4 — webhook de saída: cria a entrega do evento "automacao.acionada" uma única vez', async () => {
      const destino = await t.prisma.webhookSaida.create({
        data: {
          nome: 'Destino',
          url: 'https://exemplo.invalid/hook',
          eventos: ['contato.criado'],
          segredoCifrado: 'x',
        },
      });
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'acao.webhook',
              config: { webhookId: destino.id },
            },
          ],
        },
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Hugo', email: 'hugo@teste.local' })
        .expect(201);
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('CONCLUIDA');
      const entregas = await t.prisma.webhookEntrega.findMany({
        where: { tipoEvento: 'automacao.acionada' },
      });
      expect(entregas).toHaveLength(1);
      expect(entregas[0].payload).toMatchObject({
        evento: 'automacao.acionada',
        dados: { automacao: { nome: automacao.nome } },
      });
    });
  });

  // ---------------------------------------------------------------------
  describe('critérios de parada (R19.5)', () => {
    const esperaEEtiqueta = {
      passos: [
        {
          id: 'p1',
          tipo: 'aguardar',
          config: { quantidade: 1, unidade: 'dias' },
        },
        { id: 'p2', tipo: 'acao.etiquetar', config: { adicionar: ['seguiu'] } },
      ],
    };

    async function comExecucaoEsperando(
      criterios: string[],
      extra: Record<string, unknown> = {},
    ) {
      const contato = await criarContato(t);
      const automacao = await criarAtiva(admin, {
        criteriosParada: criterios,
        definicao: esperaEEtiqueta,
        ...extra,
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: contato.id }),
        ),
      );
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao.status).toBe('AGUARDANDO');
      return { contato, automacao, execucao };
    }

    it('cenário 64 — R19.5 — RESPONDEU: a resposta do contato cancela a execução em espera', async () => {
      const { contato, execucao } = await comExecucaoEsperando(['RESPONDEU']);
      const conversa = await criarConversa(t, { contato });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'mensagem.recebida', {
            conversaId: conversa.id,
            contatoId: contato.id,
            canalTipo: 'WEBCHAT',
          }),
        ),
      );
      await assentar();
      expect(
        await t.prisma.execucao.findUniqueOrThrow({
          where: { id: execucao.id },
        }),
      ).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'criterio:RESPONDEU',
      });
      await assentar(true);
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contato.id },
          })
        ).etiquetas,
      ).toEqual([]);
    });

    it('R19.5 — sem o critério, a resposta não interrompe a cadência', async () => {
      const { contato, execucao } = await comExecucaoEsperando([]);
      const conversa = await criarConversa(t, { contato });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'mensagem.recebida', {
            conversaId: conversa.id,
            contatoId: contato.id,
            canalTipo: 'WEBCHAT',
          }),
        ),
      );
      await assentar(true);
      expect(
        (
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          })
        ).status,
      ).toBe('CONCLUIDA');
    });

    it('R19.5 — GANHOU e PERDEU: o negócio fechado cancela a cadência', async () => {
      for (const [criterio, evento, etapa] of [
        ['GANHOU', 'negocio.ganho', 'ganho'],
        ['PERDEU', 'negocio.perdido', 'perdido'],
      ] as const) {
        await t.limparBanco();
        admin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
        const { contato, execucao } = await comExecucaoEsperando([criterio]);
        const negocio = await criarNegocio(t, { contato });
        void etapa;
        await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
          t.prisma.$transaction((tx) =>
            t.eventos.publicar(tx, evento, {
              negocioId: negocio.id,
              contatoId: contato.id,
            }),
          ),
        );
        await assentar();
        expect(
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          }),
        ).toMatchObject({
          status: 'CANCELADA',
          motivoFim: `criterio:${criterio}`,
        });
      }
    });

    it('R19.5 — SAIU_DO_SEGMENTO: ao acordar, quem saiu do público não recebe a ação', async () => {
      const { contato, execucao } = await comExecucaoEsperando(
        ['SAIU_DO_SEGMENTO'],
        {
          condicoes: {
            segmento: {
              condicoes: [
                {
                  campo: 'etiquetas',
                  operador: 'contem_alguma',
                  valor: ['vip'],
                },
              ],
            },
          },
        },
      ).catch(() => ({ contato: null, execucao: null }));
      // O contato precisa estar no segmento ao iniciar: refazemos o cenário com a etiqueta.
      expect(contato).toBeNull();
      expect(execucao).toBeNull();
      const vip = await criarContato(t, { etiquetas: ['vip'] });
      const automacao = await criarAtiva(admin, {
        criteriosParada: ['SAIU_DO_SEGMENTO'],
        definicao: esperaEEtiqueta,
        condicoes: {
          segmento: {
            condicoes: [
              { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
            ],
          },
        },
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: vip.id }),
        ),
      );
      await assentar();
      const execucoes = await t.prisma.execucao.findMany({
        where: { automacaoId: automacao.id as string, contatoId: vip.id },
      });
      expect(execucoes).toHaveLength(1);
      await t.prisma.contato.update({
        where: { id: vip.id },
        data: { etiquetas: [] },
      });
      await assentar(true);
      expect(
        await t.prisma.execucao.findUniqueOrThrow({
          where: { id: execucoes[0].id },
        }),
      ).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'criterio:SAIU_DO_SEGMENTO',
      });
      expect(
        (await t.prisma.contato.findUniqueOrThrow({ where: { id: vip.id } }))
          .etiquetas,
      ).toEqual([]);
    });

    it('cenário 68 — R19.9 — marketing: contato com opt-out fica de fora, também no meio da cadência (R4.6)', async () => {
      const automacao = await criarAtiva(admin, {
        marketing: true,
        definicao: esperaEEtiqueta,
      });
      const sai = await criarContato(t);
      const fica = await criarContato(t);
      const optOut = await criarContato(t);
      await t.prisma.contato.update({
        where: { id: optOut.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      for (const c of [sai, fica, optOut]) {
        await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
          t.prisma.$transaction((tx) =>
            t.eventos.publicar(tx, 'contato.criado', { contatoId: c.id }),
          ),
        );
      }
      await assentar();
      const execucoes = await execucoesDe(automacao.id as string);
      expect(
        execucoes
          .map((e) => e.contatoId ?? '')
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([sai.id, fica.id].sort((a, b) => a.localeCompare(b)));
      await t.prisma.contato.update({
        where: { id: sai.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      await assentar(true);
      const porContato = Object.fromEntries(
        (await execucoesDe(automacao.id as string)).map((e) => [
          e.contatoId,
          e,
        ]),
      );
      expect(porContato[sai.id]).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'opt_out',
      });
      expect(porContato[fica.id].status).toBe('CONCLUIDA');
    });

    it('R19.9 — automação que não é de marketing atende também quem fez opt-out', async () => {
      const automacao = await criarAtiva(admin, {
        marketing: false,
        definicao: etiquetar('operacional'),
      });
      const optOut = await criarContato(t);
      await t.prisma.contato.update({
        where: { id: optOut.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: optOut.id }),
        ),
      );
      await assentar();
      expect((await execucoesDe(automacao.id as string))[0].status).toBe(
        'CONCLUIDA',
      );
    });
  });

  // ---------------------------------------------------------------------
  describe('limite por entidade e laços (R19.6, R19.7)', () => {
    async function dispararDuasVezes(contatoId: string) {
      for (let i = 0; i < 2; i++) {
        await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
          t.prisma.$transaction((tx) =>
            t.eventos.publicar(tx, 'contato.atualizado', { contatoId }),
          ),
        );
      }
      await assentar();
    }

    it.each([
      ['UMA_VEZ', undefined, 1],
      ['SEMPRE', undefined, 2],
      ['UMA_VEZ_POR_PERIODO', 7, 1],
    ])(
      'R19.6 — limite %s: duas ocorrências do mesmo contato geram %i execução(ões)',
      async (limite, periodo, esperado) => {
        const automacao = await criarAtiva(admin, {
          tipoGatilho: 'EVENTO',
          evento: 'contato.atualizado',
          limiteExecucao: limite,
          ...(periodo ? { limitePeriodoDias: periodo } : {}),
          definicao: {
            passos: [
              {
                id: 'p1',
                tipo: 'acao.atividade',
                config: {
                  tipo: 'TAREFA',
                  titulo: 'Revisar',
                  responsavelId: (await t.prisma.usuario.findFirstOrThrow()).id,
                },
              },
            ],
          },
        });
        const contato = await criarContato(t);
        await dispararDuasVezes(contato.id);
        expect(await execucoesDe(automacao.id as string)).toHaveLength(
          esperado,
        );
      },
    );

    it('cenário 65 — R19.6 — UMA_VEZ_POR_PERIODO volta a valer depois do período; limite por contato, não global', async () => {
      const automacao = await criarAtiva(admin, {
        tipoGatilho: 'EVENTO',
        evento: 'contato.atualizado',
        limiteExecucao: 'UMA_VEZ_POR_PERIODO',
        limitePeriodoDias: 7,
        definicao: etiquetar('periodo'),
      });
      const a = await criarContato(t);
      const b = await criarContato(t);
      await dispararDuasVezes(a.id);
      await dispararDuasVezes(b.id);
      expect(await execucoesDe(automacao.id as string)).toHaveLength(2);
      await t.prisma.execucao.updateMany({
        where: { automacaoId: automacao.id as string },
        data: {
          criadoEm: new Date(Date.now() - 8 * 86_400_000),
          chaveUnica: null,
        },
      });
      await dispararDuasVezes(a.id);
      expect(await execucoesDe(automacao.id as string)).toHaveLength(3);
    });

    it('cenário 66 — R19.7 — uma automação que dispara a si mesma em cadeia para na terceira vez', async () => {
      const dono = await t.prisma.usuario.findFirstOrThrow();
      const automacao = await criarAtiva(admin, {
        tipoGatilho: 'EVENTO',
        evento: 'atividade.criada',
        entidade: 'atividade',
        limiteExecucao: 'SEMPRE',
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'acao.atividade',
              config: {
                tipo: 'TAREFA',
                titulo: 'De novo',
                responsavelId: dono.id,
              },
            },
          ],
        },
      });
      const contato = await criarContato(t);
      await admin
        .post('/api/v1/atividades', {
          tipo: 'TAREFA',
          titulo: 'Semente',
          contatoId: contato.id,
        })
        .expect(201);
      await drenarTudo(t);
      await assentar();
      await assentar();
      const execucoes = await execucoesDe(automacao.id as string);
      expect(execucoes).toHaveLength(3);
      expect(
        execucoes.map(
          (e) => (e.cadeia as { profundidade: number }).profundidade,
        ),
      ).toEqual([1, 2, 3]);
      expect(await t.prisma.atividade.count()).toBe(4);
    });
  });

  // ---------------------------------------------------------------------
  describe('histórico, reexecução e modo teste (R19.8)', () => {
    it('R19.8 — passo com erro falha a execução; reexecutar o passo conclui', async () => {
      let falhar = true;
      passoDeTeste(
        t,
        'teste.instavel',
        () => {
          if (falhar) {
            throw new Error('Serviço indisponível');
          }
          return Promise.resolve(seguir({ saida: { ok: true } }));
        },
        ['AUTOMACAO'],
      );
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            { id: 'p1', tipo: 'acao.etiquetar', config: { adicionar: ['a'] } },
            { id: 'p2', tipo: 'teste.instavel' },
          ],
        },
      });
      const contato = await criarContato(t);
      await executarComoAtor({ tipoAtor: 'SISTEMA' }, () =>
        t.prisma.$transaction((tx) =>
          t.eventos.publicar(tx, 'contato.criado', { contatoId: contato.id }),
        ),
      );
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      expect(execucao).toMatchObject({ status: 'FALHOU', passoAtualId: 'p2' });
      const falhada = await admin
        .get(
          `/api/v1/automacoes/execucoes?status=FALHOU&automacaoId=${automacao.id}`,
        )
        .expect(200);
      expect(falhada.body.total).toBe(1);
      const detalhe = await admin
        .get(`/api/v1/automacoes/execucoes/${execucao.id}`)
        .expect(200);
      expect(
        detalhe.body.passos.map((p: { passoId: string; status: string }) => [
          p.passoId,
          p.status,
        ]),
      ).toEqual([
        ['p1', 'CONCLUIDO'],
        ['p2', 'ERRO'],
      ]);
      expect(detalhe.body.erro).toMatch(/indisponível/);
      falhar = false;
      await admin
        .post(`/api/v1/automacoes/execucoes/${execucao.id}/reexecutar`)
        .expect(200);
      await assentar();
      expect(
        (
          await t.prisma.execucao.findUniqueOrThrow({
            where: { id: execucao.id },
          })
        ).status,
      ).toBe('CONCLUIDA');
      await admin
        .post(`/api/v1/automacoes/execucoes/${execucao.id}/reexecutar`)
        .expect(422);
      await admin
        .post(`/api/v1/automacoes/execucoes/${execucao.id}/cancelar`)
        .expect(422);
    });

    it('R19.8 — cancelar uma execução em espera', async () => {
      const automacao = await criarAtiva(admin, {
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'aguardar',
              config: { quantidade: 1, unidade: 'dias' },
            },
            { id: 'p2', tipo: 'acao.etiquetar', config: { adicionar: ['x'] } },
          ],
        },
      });
      await admin
        .post('/api/v1/contatos', { nome: 'Iara', email: 'iara@teste.local' })
        .expect(201);
      await assentar();
      const [execucao] = await execucoesDe(automacao.id as string);
      const resposta = await admin
        .post(`/api/v1/automacoes/execucoes/${execucao.id}/cancelar`)
        .expect(200);
      expect(resposta.body).toMatchObject({
        status: 'CANCELADA',
        motivoFim: 'cancelada_manualmente',
      });
    });

    it('cenário 67 — R19.8 — modo teste: simula as ações (sem efeito), pula as esperas e não conta como execução real', async () => {
      const { canal } = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511900000000',
      });
      const contato = await criarContato(t, {
        nome: 'Joana Lima',
        telefone: '11977776666',
      });
      const automacao = await criarAtiva(admin, {
        marketing: true,
        definicao: {
          passos: [
            {
              id: 'p1',
              tipo: 'acao.whatsapp',
              config: {
                texto: 'Oi {{contato.primeiro_nome}}, {tudo bem|como vai}?',
              },
            },
            {
              id: 'p2',
              tipo: 'aguardar',
              config: { quantidade: 3, unidade: 'dias' },
            },
            {
              id: 'p3',
              tipo: 'acao.etiquetar',
              config: { adicionar: ['testado'] },
            },
            {
              id: 'p4',
              tipo: 'acao.atividade',
              config: { tipo: 'TAREFA', titulo: 'Acompanhar' },
            },
          ],
        },
      });
      const resposta = await admin
        .post(`/api/v1/automacoes/${automacao.id}/testar`, {
          entidadeId: contato.id,
        })
        .expect(200);
      expect(resposta.body.condicoesAtendidas).toBe(true);
      const execucao = resposta.body.execucao;
      expect(execucao).toMatchObject({ teste: true, status: 'CONCLUIDA' });
      expect(execucao.passos[0].resultado.saida).toMatchObject({
        simulado: true,
        canal: 'WHATSAPP',
      });
      expect(execucao.passos[0].resultado.saida.texto).toMatch(
        /^Oi Joana, (tudo bem|como vai)\?$/,
      );
      expect(execucao.passos[2].resultado.saida).toMatchObject({
        simulado: true,
        etiquetas: ['testado'],
      });
      expect(
        await t.prisma.mensagem.count({ where: { canalId: canal.id } }),
      ).toBe(0);
      expect(await t.prisma.atividade.count()).toBe(0);
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contato.id },
          })
        ).etiquetas,
      ).toEqual([]);
      const lista = await admin
        .get(`/api/v1/automacoes/execucoes?automacaoId=${automacao.id}`)
        .expect(200);
      expect(lista.body.total).toBe(0);
      const testes = await admin
        .get(
          `/api/v1/automacoes/execucoes?automacaoId=${automacao.id}&teste=true`,
        )
        .expect(200);
      expect(testes.body.total).toBe(1);
      // O teste não ocupa o limite "uma vez" da entidade.
      const real = await criarContato(t);
      await t.prisma.$transaction((tx) =>
        t.eventos.publicar(tx, 'contato.criado', { contatoId: contato.id }),
      );
      await assentar();
      expect(await execucoesDe(automacao.id as string)).toHaveLength(2);
      void real;
    });

    it('R19.8 — teste informa quando a entidade não atenderia às condições', async () => {
      const automacao = await criarAtiva(admin, {
        condicoes: {
          segmento: {
            condicoes: [
              { campo: 'etiquetas', operador: 'contem_alguma', valor: ['vip'] },
            ],
          },
        },
        definicao: etiquetar('x'),
      });
      const contato = await criarContato(t);
      const resposta = await admin
        .post(`/api/v1/automacoes/${automacao.id}/testar`, {
          entidadeId: contato.id,
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        condicoesAtendidas: false,
        motivoDasCondicoes: 'fora_do_segmento',
      });
      await admin
        .post(`/api/v1/automacoes/${automacao.id}/testar`, {
          entidadeId: '11111111-1111-4111-8111-111111111111',
        })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------
  describe('modelos prontos e catálogo', () => {
    it('R19 — lista os 4 modelos prontos e cria uma automação pausada a partir de cada um', async () => {
      const lista = await admin
        .get('/api/v1/automacoes/modelos-prontos')
        .expect(200);
      expect(lista.body.map((m: { chave: string }) => m.chave)).toEqual([
        'boas_vindas_lead',
        'follow_up_proposta',
        'lembrete_renovacao',
        'reativacao',
      ]);
      for (const modelo of lista.body) {
        const criada = await admin
          .post(`/api/v1/automacoes/modelos-prontos/${modelo.chave}`, {})
          .expect(201);
        expect(criada.body).toMatchObject({
          ativa: false,
          modelo: modelo.chave,
        });
      }
      const etapa = await etapaDoFunilBase(
        t,
        'COMERCIAL',
        (await funilBase(t, 'COMERCIAL')).etapas[1].chave!,
      );
      const followUp = await admin
        .post('/api/v1/automacoes/modelos-prontos/follow_up_proposta', {
          nome: 'Follow-up',
          gatilhoConfig: { etapaId: etapa.id },
        })
        .expect(201);
      expect(followUp.body.pendencias).toEqual([]);
      await admin
        .post(`/api/v1/automacoes/${followUp.body.id}/ativar`)
        .expect(200);
      await admin
        .post('/api/v1/automacoes/modelos-prontos/nao_existe', {})
        .expect(404);
    });

    it('R19 — o catálogo lista gatilhos, campos de data e tipos de passo das automações', async () => {
      const catalogo = await admin
        .get('/api/v1/automacoes/catalogo')
        .expect(200);
      expect(
        catalogo.body.gatilhos.map((g: { evento: string }) => g.evento),
      ).toEqual(
        expect.arrayContaining([
          'contato.criado',
          'negocio.parado',
          'atividade.atrasada',
          'campanha.respondida',
        ]),
      );
      expect(catalogo.body.tiposDePasso).toEqual(
        expect.arrayContaining([
          'acao.whatsapp',
          'acao.email',
          'acao.atividade',
          'aguardar',
          'condicao',
          'encerrar',
        ]),
      );
      expect(
        catalogo.body.camposDeData.map((c: { campo: string }) => c.campo),
      ).toContain('negocio.previsaoFechamento');
    });
  });

  // ---------------------------------------------------------------------
  it('R19 — criação, ativação e exclusão são auditadas (entidade automacao)', async () => {
    const criada = await admin
      .post('/api/v1/automacoes', {
        nome: 'Auditada',
        ...GATILHO_CONTATO_CRIADO,
        definicao: etiquetar('a'),
      })
      .expect(201);
    await admin.post(`/api/v1/automacoes/${criada.body.id}/ativar`).expect(200);
    await admin
      .post(`/api/v1/automacoes/${criada.body.id}/pausar`, {})
      .expect(200);
    await admin.delete(`/api/v1/automacoes/${criada.body.id}`).expect(204);
    const acoes = await t.prisma.eventoAuditoria.findMany({
      where: { entidade: 'automacao', entidadeId: criada.body.id },
      orderBy: { id: 'asc' },
    });
    expect(acoes.map((a) => a.acao)).toEqual([
      'automacao.criada',
      'automacao.ativada',
      'automacao.pausada',
      'automacao.excluida',
    ]);
    expect(acoes.every((a) => a.tipoAtor === 'USUARIO')).toBe(true);
  });
});
