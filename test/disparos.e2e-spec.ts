import { filaDeEnvio } from '../src/canais/whatsapp/contrato-gateway';
import { inicioDoProximoDia } from '../src/canais/whatsapp/protecoes';
import { FILA_DISPAROS_ENVIAR } from '../src/disparos/disparos.constantes';
import {
  type AppTeste,
  criarArquivo,
  criarCanal,
  criarCanalWhatsapp,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  drenarTudo,
  entrarComo,
} from './utils';
import {
  cenarioWhatsapp,
  confirmarEntrega,
  criarAppDeDisparos,
  enviarTudo,
  GatewayFalso,
  proximaRodada,
  varrer,
} from './disparos-apoio';

describe('Disparos — campanhas (e2e, R17)', () => {
  let t: AppTeste;
  const gateway = new GatewayFalso();

  beforeAll(async () => {
    t = await criarAppDeDisparos(gateway);
  });
  beforeEach(async () => {
    await t.limparBanco();
    gateway.semWhatsapp.clear();
    gateway.fora = false;
    gateway.verificados.length = 0;
  });
  afterAll(() => t.fechar());

  async function criarPelaApi(
    cliente: Awaited<ReturnType<typeof entrarComo>>,
    canalId: string,
    extra: Record<string, unknown> = {},
  ) {
    const resposta = await cliente
      .post('/api/v1/disparos/campanhas', {
        nome: 'Reativação',
        canal: 'WHATSAPP',
        canalIds: [canalId],
        texto: '{Olá|Oi} {{contato.primeiro_nome|tudo bem}}!',
        ...extra,
      })
      .expect(201);
    return resposta.body as { id: string; status: string };
  }

  describe('permissões e validação (R17.1)', () => {
    it('cenário 41 — R17.1 — membro vê só as próprias campanhas; líder as da área; outra área e Admin conforme o recorte', async () => {
      const marketing = await criarEquipe(t, 'MARKETING', { membros: 2 });
      const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const admin = await criarUsuario(t, { papel: 'ADMIN' });
      const { canal } = await cenarioWhatsapp(t, 0);
      const dono = await entrarComo(t, marketing.membros[0]!);
      const outro = await entrarComo(t, marketing.membros[1]!);
      const lider = await entrarComo(t, marketing.lider);
      const liderOutraArea = await entrarComo(t, comercial.lider);
      const diretoria = await entrarComo(t, admin);

      const campanha = await criarPelaApi(dono, canal.id);
      expect((campanha as unknown as { area: string }).area).toBe('MARKETING');

      await outro.get(`/api/v1/disparos/campanhas/${campanha.id}`).expect(404);
      await liderOutraArea
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(404);
      await lider.get(`/api/v1/disparos/campanhas/${campanha.id}`).expect(200);
      await diretoria
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      await dono.get(`/api/v1/disparos/campanhas/${campanha.id}`).expect(200);

      const doOutro = await outro.get('/api/v1/disparos/campanhas').expect(200);
      expect(doOutro.body.total).toBe(0);
      const doLider = await lider.get('/api/v1/disparos/campanhas').expect(200);
      expect(doLider.body.total).toBe(1);
      expect(doLider.body.itens[0]).toMatchObject({
        id: campanha.id,
        status: 'RASCUNHO',
        progresso: 0,
      });
      await outro
        .post(`/api/v1/disparos/campanhas/${campanha.id}/pausar`, {})
        .expect(404);
    });

    it('R17.1 — Marketing escolhe número e cria/inicia a campanha sem passar pelo Atendimento; Chatbot e Automações têm rotas de opções próprias', async () => {
      const marketing = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const { canal } = await cenarioWhatsapp(t, 2);
      const membro = await entrarComo(t, marketing.membros[0]!);
      const lider = await entrarComo(t, marketing.lider);

      // O Atendimento continua fechado para o papel (R12)...
      await membro.get('/api/v1/atendimento/canais').expect(403);
      // ...mas os canais dos Disparos vêm da rota do próprio módulo.
      const canais = await membro.get('/api/v1/disparos/canais').expect(200);
      const doNumero = (canais.body as Array<Record<string, unknown>>).find(
        (c) => c.id === canal.id,
      );
      expect(doNumero).toMatchObject({
        tipo: 'WHATSAPP',
        ativo: true,
        disponivel: true,
        status: 'CONECTADO',
        pausado: false,
      });
      expect(Object.keys(doNumero!).sort()).toEqual(
        [
          'ativo',
          'disponivel',
          'id',
          'nome',
          'pausado',
          'status',
          'tipo',
        ].sort(),
      );

      const campanha = await criarPelaApi(membro, canal.id);
      const iniciada = await membro
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      expect(iniciada.body.status).toBe('EM_ANDAMENTO');

      // Chatbot e Automações: só líderes e diretoria, com canais e filas.
      await membro.get('/api/v1/chatbot/opcoes').expect(403);
      await membro.get('/api/v1/automacoes/opcoes').expect(403);
      for (const rota of ['chatbot', 'automacoes']) {
        const { body } = await lider.get(`/api/v1/${rota}/opcoes`).expect(200);
        expect(body.canais.map((c: { id: string }) => c.id)).toContain(
          canal.id,
        );
        expect(Array.isArray(body.filas)).toBe(true);
      }
    });

    it('R5.9 — o construtor de segmentos não revela negócios de funil que a pessoa não vê', async () => {
      const marketing = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const admin = await criarUsuario(t, { papel: 'ADMIN' });
      const comercial = await criarNegocio(t, { area: 'COMERCIAL' });
      const doMarketing = await criarNegocio(t, { area: 'MARKETING' });
      const membro = await entrarComo(t, marketing.membros[0]!);
      const diretoria = await entrarComo(t, admin);
      const previa = (segmento: unknown) => ({ segmento });
      const negocio = (valor: Record<string, unknown>) =>
        previa({
          condicoes: [{ campo: 'negocio', operador: 'tem', valor }],
        });

      const recusada = await membro
        .post(
          '/api/v1/segmentos/previa',
          negocio({ funilId: comercial.funilId }),
        )
        .expect(400);
      expect(recusada.body.detalhes.regra).toBe('R5.9');
      await membro
        .post(
          '/api/v1/segmentos/previa',
          negocio({ area: 'COMERCIAL', status: ['GANHO'] }),
        )
        .expect(400);
      await membro
        .post(
          '/api/v1/segmentos/previa',
          negocio({ etapaIds: [comercial.etapaId] }),
        )
        .expect(400);
      // Também na campanha (criar) e na prévia do público.
      const { canal } = await cenarioWhatsapp(t, 0);
      await membro
        .post('/api/v1/disparos/campanhas', {
          nome: 'Espiã',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Oi',
          tipoPublico: 'SEGMENTO',
          segmento: negocio({ funilId: comercial.funilId }).segmento,
        })
        .expect(400);
      await membro
        .post('/api/v1/disparos/previa-publico', {
          canal: 'WHATSAPP',
          segmento: negocio({ funilId: comercial.funilId }).segmento,
        })
        .expect(400);

      // O funil da própria área passa; sem funil, só conta o que é da área dele.
      const propria = await membro
        .post(
          '/api/v1/segmentos/previa',
          negocio({ funilId: doMarketing.funilId }),
        )
        .expect(200);
      expect(propria.body.total).toBe(1);
      const qualquer = await membro
        .post('/api/v1/segmentos/previa', negocio({}))
        .expect(200);
      expect(qualquer.body.total).toBe(1);
      const todos = await diretoria
        .post('/api/v1/segmentos/previa', negocio({}))
        .expect(200);
      expect(todos.body.total).toBe(2);
    });

    it('R17.3 — recusa modelo com variável desconhecida, ritmo invertido, janela e canal inválidos', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 0);
      const email = await criarCanal(t, { tipo: 'EMAIL' });
      const base = {
        nome: 'X',
        canal: 'WHATSAPP',
        canalIds: [canal.id],
        texto: 'Oi',
      };
      await admin
        .post('/api/v1/disparos/campanhas', {
          ...base,
          texto: 'Olá {{contato.inexistente}}',
        })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', {
          ...base,
          intervaloMinimoSegundos: 90,
          intervaloMaximoSegundos: 30,
        })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', { ...base, loteTamanho: 10 })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', {
          ...base,
          janelaEnvio: { fusoHorario: 'Marte/Olympus', dias: {} },
        })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', { ...base, canalIds: [email.id] })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', { ...base, canal: 'SMS' })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', { ...base, nome: '' })
        .expect(400);
      await admin
        .post('/api/v1/disparos/campanhas', {
          ...base,
          segmento: { condicoes: [{ campo: 'x', operador: 'y' }] },
        })
        .expect(400);
    });

    it('R17.3 — mídia só com contexto CAMPANHA; modelo salvo copia o texto para a campanha', async () => {
      const admin = await criarUsuario(t);
      const cliente = await entrarComo(t, admin);
      const { canal } = await cenarioWhatsapp(t, 0);
      const mensagem = await criarArquivo(t, {
        contexto: 'MENSAGEM',
        mime: 'image/png',
        criadoPor: admin,
      });
      await cliente
        .post('/api/v1/disparos/campanhas', {
          nome: 'X',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Oi',
          arquivoId: mensagem.id,
        })
        .expect(400);
      const modelo = await cliente
        .post('/api/v1/modelos-mensagem', {
          nome: 'Oferta',
          canal: 'WHATSAPP',
          texto: 'Oi {{contato.primeiro_nome}}, temos uma oferta.',
        })
        .expect(201);
      const campanha = await cliente
        .post('/api/v1/disparos/campanhas', {
          nome: 'Com modelo',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          modeloId: modelo.body.id,
        })
        .expect(201);
      expect(campanha.body.texto).toBe(
        'Oi {{contato.primeiro_nome}}, temos uma oferta.',
      );
      expect(campanha.body.modeloId).toBe(modelo.body.id);
      // Editar o modelo não muda a campanha (o texto é copiado).
      await cliente
        .patch(`/api/v1/modelos-mensagem/${modelo.body.id}`, {
          texto: 'Outro texto',
        })
        .expect(200);
      const depois = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.body.id}`)
        .expect(200);
      expect(depois.body.texto).toBe(
        'Oi {{contato.primeiro_nome}}, temos uma oferta.',
      );
    });
  });

  describe('público (R17.2)', () => {
    it('cenário 42 — R17.2 — a prévia exclui opt-out e conta quem não tem telefone', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      await criarContato(t, { telefone: '11988001001', email: null });
      await criarContato(t, { telefone: '11988001002', email: null });
      await criarContato(t, { telefone: null, email: 'sem-telefone@x.com' });
      const optOut = await criarContato(t, {
        telefone: '11988001003',
        email: null,
      });
      await t.prisma.contato.update({
        where: { id: optOut.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      const resposta = await admin
        .post('/api/v1/disparos/previa-publico', {
          canal: 'WHATSAPP',
          segmento: { condicoes: [] },
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        total: 3,
        elegiveis: 2,
        semDestino: 1,
        optOutExcluidos: 1,
      });
      expect(resposta.body.amostra).toHaveLength(3);
      const email = await admin
        .post('/api/v1/disparos/previa-publico', {
          canal: 'EMAIL',
          segmento: { condicoes: [] },
        })
        .expect(200);
      expect(email.body).toMatchObject({ total: 3, elegiveis: 1 });
    });

    it('R17.2 — lista importada: só quem a importação criou ou atualizou', async () => {
      const admin = await criarUsuario(t);
      const cliente = await entrarComo(t, admin);
      const a = await criarContato(t, { telefone: '11988002001', email: null });
      const b = await criarContato(t, { telefone: '11988002002', email: null });
      await criarContato(t, { telefone: '11988002003', email: null }); // fora da lista
      const importacao = await t.prisma.importacao.create({
        data: {
          tipo: 'CONTATOS',
          status: 'CONCLUIDA',
          nome: 'lista.csv',
          arquivoId: (await criarArquivo(t, { contexto: 'IMPORTACAO' })).id,
          formato: 'csv',
          criadoPorId: admin.id,
        },
      });
      await t.prisma.importacaoLinha.createMany({
        data: [
          {
            importacaoId: importacao.id,
            numero: 2,
            resultado: 'CRIADO',
            entidadeId: a.id,
          },
          {
            importacaoId: importacao.id,
            numero: 3,
            resultado: 'ATUALIZADO',
            entidadeId: b.id,
          },
          {
            importacaoId: importacao.id,
            numero: 4,
            resultado: 'ERRO',
            motivo: 'inválido',
          },
        ],
      });
      const resposta = await cliente
        .post('/api/v1/disparos/previa-publico', {
          canal: 'WHATSAPP',
          tipoPublico: 'IMPORTACAO',
          importacaoId: importacao.id,
        })
        .expect(200);
      expect(resposta.body).toMatchObject({ total: 2, elegiveis: 2 });
    });
  });

  describe('envio, ritmo e ciclo de vida (R17.4)', () => {
    it('cenário 43 — R17.4 — envia um por vez no ritmo, cria a mensagem na conversa do contato como AUTOMACAO e conclui', async () => {
      const dono = await criarUsuario(t);
      const cliente = await entrarComo(t, dono);
      const { canal, whatsapp, contatos } = await cenarioWhatsapp(t, 3);
      const campanha = await criarPelaApi(cliente, canal.id);

      const revisao = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}/revisao`)
        .expect(200);
      expect(revisao.body).toMatchObject({
        podeIniciar: true,
        exigeAprovacao: false,
      });
      expect(revisao.body.publico.elegiveis).toBe(3);
      expect(revisao.body.estimativa.duracaoSegundos).toBeGreaterThan(0);
      expect(revisao.body.previa.texto).toMatch(/^(Olá|Oi) /);

      const iniciada = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      expect(iniciada.body.status).toBe('EM_ANDAMENTO');
      await drenarTudo(t);

      // Primeira rodada: uma única mensagem; a próxima só depois do intervalo.
      const depoisDa1 = await t.prisma.campanhaDestinatario.findMany({
        where: { campanhaId: campanha.id },
        orderBy: { ordem: 'asc' },
      });
      expect(depoisDa1.map((d) => d.status)).toEqual([
        'ENVIANDO',
        'PENDENTE',
        'PENDENTE',
      ]);
      const registro = await t.prisma.campanha.findUniqueOrThrow({
        where: { id: campanha.id },
      });
      const espera = (registro.proximoEnvioEm?.getTime() ?? 0) - Date.now();
      expect(espera).toBeGreaterThan(18_000);
      expect(espera).toBeLessThanOrEqual(61_000);
      expect(registro.ultimoCanalId).toBe(canal.id);
      expect(gateway.verificados).toEqual([depoisDa1[0]!.destino]);

      const mensagem = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: depoisDa1[0]!.mensagemId! },
        include: { conversa: true },
      });
      expect(mensagem).toMatchObject({
        direcao: 'SAIDA',
        autorTipo: 'AUTOMACAO',
        autorId: null,
        canalId: canal.id,
      });
      expect(contatos.map((c) => c.id)).toContain(mensagem.conversa.contatoId);
      expect(mensagem.texto).toMatch(/^(Olá|Oi) Pessoa!$/);
      expect(mensagem.metadados).toMatchObject({ campanhaId: campanha.id });
      expect(mensagem.conversa.status).toBe('RESOLVIDA');
      // O adaptador do WhatsApp pôs o envio na fila do número no gateway.
      expect(
        await t.fila.listarTrabalhos(filaDeEnvio(whatsapp.id)),
      ).toHaveLength(1);

      // Passa o relógio do ritmo: os outros dois saem, um por rodada.
      await proximaRodada(t, campanha.id);
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: campanha.id, status: 'ENVIANDO' },
        }),
      ).toBe(2);
      await proximaRodada(t, campanha.id);
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: campanha.id, status: 'PENDENTE' },
        }),
      ).toBe(0);

      // O gateway confirma; a próxima rodada conclui.
      await confirmarEntrega(t, campanha.id, 'ENVIADA');
      await confirmarEntrega(t, campanha.id, 'ENTREGUE');
      await confirmarEntrega(t, campanha.id, 'LIDA');
      await proximaRodada(t, campanha.id);
      const fim = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      expect(fim.body.status).toBe('CONCLUIDA');
      expect(fim.body.contadores).toMatchObject({
        total: 3,
        enviados: 3,
        entregues: 3,
        lidos: 3,
        falhas: 0,
        pendentes: 0,
      });
      expect(fim.body.progresso).toBe(100);

      // Auditoria: início pela pessoa; conclusão pela automação (descrição = campanha).
      const iniciou = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'campanha.iniciada' },
      });
      expect(iniciou).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: dono.id,
      });
      const concluiu = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'campanha.concluida' },
      });
      expect(concluiu).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        atorDescricao: 'Reativação',
      });
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'campanha.concluida' },
      });
      expect(evento.dados).toMatchObject({
        campanhaId: campanha.id,
        enviados: 3,
        falhas: 0,
      });
      expect(evento.tipoAtor).toBe('AUTOMACAO');
      // Progresso ao vivo para quem acompanha.
      const emissoes = await t.prisma.eventoDominio.findMany({
        where: { tipo: 'tempo-real.emissao' },
      });
      expect(JSON.stringify(emissoes.map((e) => e.dados))).toContain(
        'campanha.progresso',
      );
    });

    it('R17.4 — número sem WhatsApp vira INVALIDO (verificação do gateway) e não consome o ritmo', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 3);
      gateway.semWhatsapp.add(contatos[0]!.telefone!);
      const campanha = await criarPelaApi(cliente, canal.id);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      await enviarTudo(t, campanha.id);
      const invalido = await t.prisma.campanhaDestinatario.findFirstOrThrow({
        where: { campanhaId: campanha.id, contatoId: contatos[0]!.id },
      });
      expect(invalido).toMatchObject({
        status: 'INVALIDO',
        motivo: 'Este número não tem WhatsApp.',
        mensagemId: null,
      });
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: campanha.id, status: 'ENVIANDO' },
        }),
      ).toBe(2);
      const detalhe = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      expect(detalhe.body.contadores).toMatchObject({
        invalidos: 1,
        enviando: 2,
        pendentes: 0,
      });
    });

    it('R17.4 — opt-out depois da montagem do público também não recebe', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 2);
      const campanha = await criarPelaApi(cliente, canal.id);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      const ultimaDaFila = await t.prisma.campanhaDestinatario.findFirstOrThrow(
        {
          where: { campanhaId: campanha.id, status: 'PENDENTE' },
          orderBy: { ordem: 'desc' },
        },
      );
      await t.prisma.contato.update({
        where: { id: ultimaDaFila.contatoId },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      await enviarTudo(t, campanha.id);
      const ultimo = await t.prisma.campanhaDestinatario.findUniqueOrThrow({
        where: { id: ultimaDaFila.id },
      });
      expect(ultimo.status).toBe('EXCLUIDO');
      expect(ultimo.motivo).toContain('opt-out');
      expect(contatos).toHaveLength(2);
    });

    it('cenário 44 — R17.6 — fora da janela de envio nada sai; a campanha espera a abertura (America/Sao_Paulo)', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 2);
      // Janela só amanhã (em São Paulo): agora está fechada.
      const amanha = new Date(Date.now() + 24 * 3_600_000);
      const dia = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        weekday: 'short',
      }).format(amanha);
      const indice = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
        dia,
      );
      const campanha = await criarPelaApi(cliente, canal.id, {
        janelaEnvio: {
          fusoHorario: 'America/Sao_Paulo',
          dias: { [String(indice)]: [{ inicio: '08:00', fim: '20:00' }] },
        },
      });
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(0);
      const detalhe = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      expect(detalhe.body.status).toBe('EM_ANDAMENTO');
      expect(detalhe.body.aguardando.motivo).toBe('janela_de_envio');
      const abertura = new Date(detalhe.body.aguardando.ate as string);
      expect(abertura.getTime()).toBeGreaterThan(Date.now());
      expect(new Date(detalhe.body.proximoEnvioEm as string).getTime()).toBe(
        abertura.getTime(),
      );
    });

    it('cenário 45 — R17.4 — limite diário do número (R13): atingido, espera o dia seguinte', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, whatsapp } = await cenarioWhatsapp(t, 2, {
        limiteDiario: 1,
      });
      const hoje = new Date();
      await t.prisma.whatsappEnvioDiario.create({
        data: {
          numeroId: whatsapp.id,
          dia: new Date(
            `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(hoje)}T00:00:00.000Z`,
          ),
          enviados: 1,
        },
      });
      const campanha = await criarPelaApi(cliente, canal.id);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(0);
      const registro = await t.prisma.campanha.findUniqueOrThrow({
        where: { id: campanha.id },
      });
      expect(registro.proximoEnvioEm?.getTime()).toBe(
        inicioDoProximoDia(hoje).getTime(),
      );
      expect(registro.status).toBe('EM_ANDAMENTO');
    });

    it('R17.4 — rodízio entre números: alterna a cada envio', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const a = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511911110001',
      });
      const b = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511911110002',
      });
      for (let i = 0; i < 4; i++) {
        await criarContato(t, { telefone: `1198800${3000 + i}`, email: null });
      }
      const campanha = await criarPelaApi(cliente, a.canal.id, {
        canalIds: [a.canal.id, b.canal.id],
      });
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      await enviarTudo(t, campanha.id);
      const linhas = await t.prisma.campanhaDestinatario.findMany({
        where: { campanhaId: campanha.id },
        orderBy: { ordem: 'asc' },
      });
      expect(linhas.map((l) => l.canalId)).toEqual([
        a.canal.id,
        b.canal.id,
        a.canal.id,
        b.canal.id,
      ]);
    });

    it('R17.5 — número desconectado: espera e, no limite de falhas seguidas, pausa sozinha e avisa o criador', async () => {
      const dono = await criarUsuario(t);
      const cliente = await entrarComo(t, dono);
      const { canal, whatsapp } = await cenarioWhatsapp(t, 2);
      await t.prisma.whatsappNumero.update({
        where: { id: whatsapp.id },
        data: { status: 'DESCONECTADO' },
      });
      const campanha = await criarPelaApi(cliente, canal.id, {
        pausarAposFalhas: 2,
      });
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      expect(
        (
          await t.prisma.campanha.findUniqueOrThrow({
            where: { id: campanha.id },
          })
        ).falhasSeguidas,
      ).toBe(1);
      await proximaRodada(t, campanha.id);
      const pausada = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      expect(pausada.body.status).toBe('PAUSADA');
      expect(pausada.body.pausaMotivo).toContain('número desconectado');
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'campanha.pausada' },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        atorDescricao: 'Reativação',
      });
      const aviso = await t.prisma.notificacao.findFirstOrThrow({
        where: { usuarioId: dono.id, tipo: 'campanha.pausada' },
      });
      expect(aviso.link).toBe(`/disparos/${campanha.id}`);

      // Reconecta e retoma: os envios seguem.
      await t.prisma.whatsappNumero.update({
        where: { id: whatsapp.id },
        data: { status: 'CONECTADO' },
      });
      const retomada = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/retomar`, {})
        .expect(200);
      expect(retomada.body.status).toBe('EM_ANDAMENTO');
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(1);
    });

    it('cenário 46 — R17.5 — falhas seguidas pausam a campanha; reenviar falhas devolve os destinatários à fila', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 4);
      const campanha = await criarPelaApi(cliente, canal.id, {
        pausarAposFalhas: 2,
      });
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      await proximaRodada(t, campanha.id);
      await confirmarEntrega(
        t,
        campanha.id,
        'FALHOU',
        'Número bloqueado pelo WhatsApp',
      );
      await varrer(t);
      const pausada = await cliente
        .get(`/api/v1/disparos/campanhas/${campanha.id}`)
        .expect(200);
      expect(pausada.body.status).toBe('PAUSADA');
      expect(pausada.body.contadores.falhas).toBe(2);
      expect(pausada.body.pausaMotivo).toContain('2 falhas seguidas');
      const falhos = await t.prisma.campanhaDestinatario.findMany({
        where: { campanhaId: campanha.id, status: 'FALHOU' },
      });
      expect(falhos.map((f) => f.motivo)).toEqual([
        'Número bloqueado pelo WhatsApp',
        'Número bloqueado pelo WhatsApp',
      ]);

      const reenvio = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/reenviar-falhas`, {})
        .expect(200);
      expect(reenvio.body.reenfileirados).toBe(2);
      expect(reenvio.body.campanha.status).toBe('EM_ANDAMENTO');
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: campanha.id, status: 'PENDENTE' },
        }),
      ).toBe(4);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/reenviar-falhas`, {})
        .expect(422);
    });

    it('R17.7 — pausar, retomar, cancelar e as transições inválidas (422)', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 3);
      const campanha = await criarPelaApi(cliente, canal.id);
      const url = `/api/v1/disparos/campanhas/${campanha.id}`;
      await cliente.post(`${url}/pausar`, {}).expect(422);
      await cliente.post(`${url}/retomar`, {}).expect(422);
      await cliente.post(`${url}/iniciar`, {}).expect(200);
      await cliente.post(`${url}/iniciar`, {}).expect(422);
      await drenarTudo(t);
      const pausada = await cliente
        .post(`${url}/pausar`, { motivo: 'Revisar o texto' })
        .expect(200);
      expect(pausada.body).toMatchObject({
        status: 'PAUSADA',
        pausaMotivo: 'Revisar o texto',
      });
      // Pausada, o motor não envia mais.
      await proximaRodada(t, campanha.id);
      expect(await t.prisma.mensagem.count()).toBe(1);
      await cliente.patch(url, { texto: 'Mudou' }).expect(422); // conteúdo travado depois de iniciada
      await cliente
        .patch(url, {
          intervaloMinimoSegundos: 30,
          intervaloMaximoSegundos: 45,
        })
        .expect(200);
      await cliente.delete(url).expect(422);
      const cancelada = await cliente.post(`${url}/cancelar`, {}).expect(200);
      expect(cancelada.body.status).toBe('CANCELADA');
      expect(cancelada.body.contadores).toMatchObject({
        excluidos: 2,
        pendentes: 0,
      });
      await cliente.post(`${url}/cancelar`, {}).expect(422);
      await cliente.delete(url).expect(204);
      await cliente.get(url).expect(404);
    });

    it('R17.4 — pausar e retomar logo depois de um envio não antecipa o próximo', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 3);
      const campanha = await criarPelaApi(cliente, canal.id);
      const url = `/api/v1/disparos/campanhas/${campanha.id}`;
      await cliente.post(`${url}/iniciar`, {}).expect(200);
      await drenarTudo(t);
      const antes = await t.prisma.campanha.findUniqueOrThrow({
        where: { id: campanha.id },
      });
      expect(antes.proximoEnvioEm!.getTime()).toBeGreaterThan(
        Date.now() + 15_000,
      );
      await cliente.post(`${url}/pausar`, {}).expect(200);
      await cliente.post(`${url}/retomar`, {}).expect(200);
      const depois = await t.prisma.campanha.findUniqueOrThrow({
        where: { id: campanha.id },
      });
      expect(depois.status).toBe('EM_ANDAMENTO');
      expect(depois.proximoEnvioEm!.getTime()).toBe(
        antes.proximoEnvioEm!.getTime(),
      );
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(1);
    });

    it('R17.7 — agendamento: fica AGENDADA e começa na hora marcada (varredura)', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 2);
      const campanha = await criarPelaApi(cliente, canal.id);
      const futuro = new Date(Date.now() + 3_600_000).toISOString();
      const agendada = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {
          agendadaPara: futuro,
        })
        .expect(200);
      expect(agendada.body.status).toBe('AGENDADA');
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(0);
      // A hora chega.
      const agora = new Date(Date.now() - 1000);
      await t.prisma.campanha.update({
        where: { id: campanha.id },
        data: { agendadaPara: agora, proximoEnvioEm: agora },
      });
      expect(await varrer(t)).toMatchObject({ ativadas: 1 });
      await drenarFilas(t, FILA_DISPAROS_ENVIAR);
      await drenarTudo(t);
      const depois = await t.prisma.campanha.findUniqueOrThrow({
        where: { id: campanha.id },
      });
      expect(depois.status).toBe('EM_ANDAMENTO');
      expect(depois.iniciadaEm).not.toBeNull();
      expect(await t.prisma.mensagem.count()).toBe(1);
      await cliente
        .post('/api/v1/disparos/campanhas/' + campanha.id + '/iniciar', {
          agendadaPara: '2020-01-01T00:00:00Z',
        })
        .expect(422);
    });

    it('R17.7 — retomada após reinício: a varredura religa a campanha que perdeu o job; jobs velhos não duplicam o ritmo', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal } = await cenarioWhatsapp(t, 3);
      const campanha = await criarPelaApi(cliente, canal.id);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/iniciar`, {})
        .expect(200);
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(1);
      // Queda: os jobs somem e o instante marcado ficou para trás.
      await t.fila.limparTrabalhos();
      await t.prisma.campanha.update({
        where: { id: campanha.id },
        data: { proximoEnvioEm: new Date(Date.now() - 5 * 60_000) },
      });
      expect(await varrer(t)).toMatchObject({ retomadas: 1 });
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(2);
      // Pausa e retoma: o job antigo (instante velho) é ignorado.
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/pausar`, {})
        .expect(200);
      // O intervalo do ritmo já passou durante a pausa (retomar o respeita, R17.4).
      await t.prisma.campanha.update({
        where: { id: campanha.id },
        data: { proximoEnvioEm: new Date(Date.now() - 1_000) },
      });
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/retomar`, {})
        .expect(200);
      await drenarTudo(t, { incluirAgendados: true });
      expect(await t.prisma.mensagem.count()).toBe(3);
    });

    it('R17.8 — e-mail: monta a mensagem com o assunto renderizado na conversa do contato', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const caixa = await criarCanal(t, {
        tipo: 'EMAIL',
        nome: 'Caixa vendas',
      });
      const contato = await criarContato(t, {
        nome: 'Maria Souza',
        email: 'maria@cliente.com',
      });
      const campanha = await cliente
        .post('/api/v1/disparos/campanhas', {
          nome: 'Newsletter',
          canal: 'EMAIL',
          canalIds: [caixa.id],
          assunto: 'Novidades, {{contato.primeiro_nome}}',
          texto: 'Olá {{contato.primeiro_nome}}!',
        })
        .expect(201);
      await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.body.id}/iniciar`, {})
        .expect(200);
      await drenarFilas(t, FILA_DISPAROS_ENVIAR);
      const destinatario = await t.prisma.campanhaDestinatario.findFirstOrThrow(
        {
          where: { campanhaId: campanha.body.id },
          include: { mensagem: { include: { conversa: true } } },
        },
      );
      expect(destinatario).toMatchObject({
        contatoId: contato.id,
        destino: 'maria@cliente.com',
        status: 'ENVIANDO',
      });
      expect(destinatario.mensagem?.texto).toBe('Olá Maria!');
      expect(destinatario.mensagem?.conversa.assunto).toBe('Novidades, Maria');
      // Sem assunto, a revisão barra.
      const sem = await cliente
        .post('/api/v1/disparos/campanhas', {
          nome: 'Sem assunto',
          canal: 'EMAIL',
          canalIds: [caixa.id],
          texto: 'Oi',
        })
        .expect(201);
      const revisao = await cliente
        .get(`/api/v1/disparos/campanhas/${sem.body.id}/revisao`)
        .expect(200);
      expect(revisao.body.podeIniciar).toBe(false);
      await cliente
        .post(`/api/v1/disparos/campanhas/${sem.body.id}/iniciar`, {})
        .expect(422);
    });

    it('R17.3 — prévia por contato e envio de teste para o próprio número', async () => {
      const dono = await criarUsuario(t, { telefone: '11977776666' });
      const cliente = await entrarComo(t, dono);
      const { canal } = await cenarioWhatsapp(t, 1);
      const campanha = await criarPelaApi(cliente, canal.id, {
        texto: 'Oi {{contato.primeiro_nome}}, {{empresa.nome|sua empresa}}',
      });
      const alvo = await criarContato(t, {
        nome: 'Carlos Lima',
        telefone: '11999995555',
        email: null,
      });
      const previa = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/previa`, {
          contatoId: alvo.id,
        })
        .expect(200);
      expect(previa.body.texto).toBe('Oi Carlos, sua empresa');
      const teste = await cliente
        .post(`/api/v1/disparos/campanhas/${campanha.id}/teste`, {})
        .expect(200);
      expect(teste.body.texto).toBe('Oi Teste, sua empresa');
      const contatoDeTeste = await t.prisma.contato.findFirstOrThrow({
        where: { telefone: '5511977776666' },
      });
      expect(contatoDeTeste.etiquetas).toContain('teste-de-campanha');
      const mensagem = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: teste.body.mensagemId },
      });
      expect(mensagem).toMatchObject({
        autorTipo: 'AUTOMACAO',
        direcao: 'SAIDA',
      });
      expect(mensagem.metadados).toMatchObject({ teste: true });
      // O teste não entra no público nem nos contadores.
      expect(
        await t.prisma.campanhaDestinatario.count({
          where: { campanhaId: campanha.id },
        }),
      ).toBe(0);
    });

    it('R17.3 — duplicar copia a configuração como novo rascunho do usuário', async () => {
      const equipe = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const lider = await entrarComo(t, equipe.lider);
      const dono = await entrarComo(t, equipe.membros[0]!);
      const { canal } = await cenarioWhatsapp(t, 0);
      const original = await criarPelaApi(dono, canal.id, {
        intervaloMinimoSegundos: 33,
        intervaloMaximoSegundos: 77,
      });
      const copia = await lider
        .post(`/api/v1/disparos/campanhas/${original.id}/duplicar`, {})
        .expect(201);
      expect(copia.body).toMatchObject({
        nome: 'Reativação (cópia)',
        status: 'RASCUNHO',
        campanhaOrigemId: original.id,
        criadoPor: { id: equipe.lider.id },
      });
      expect(copia.body.ritmo).toMatchObject({
        intervaloMinimoSegundos: 33,
        intervaloMaximoSegundos: 77,
      });
      expect(copia.body.canais.map((c: { id: string }) => c.id)).toEqual([
        canal.id,
      ]);
    });
  });
});
