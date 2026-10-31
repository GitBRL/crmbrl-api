import { AtendimentoService } from '../src/atendimento/atendimento.service';
import { FILA_DISPAROS_ENVIAR } from '../src/disparos/disparos.constantes';
import {
  type AppTeste,
  criarArquivo,
  criarContato,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  drenarTudo,
  entrarComo,
  processarEventos,
} from './utils';
import {
  cenarioWhatsapp,
  confirmarEntrega,
  criarAppDeDisparos,
  enviarTudo,
  GatewayFalso,
  varrer,
} from './disparos-apoio';

describe('Disparos — respostas, aprovação, relatório e modelos (e2e, R17)', () => {
  let t: AppTeste;
  const gateway = new GatewayFalso();

  beforeAll(async () => {
    t = await criarAppDeDisparos(gateway);
  });
  beforeEach(async () => {
    await t.limparBanco();
    gateway.semWhatsapp.clear();
    gateway.fora = false;
  });
  afterAll(() => t.fechar());

  type Cliente = Awaited<ReturnType<typeof entrarComo>>;

  async function campanhaEnviada(
    cliente: Cliente,
    canalId: string,
    extra: Record<string, unknown> = {},
  ) {
    const criada = await cliente
      .post('/api/v1/disparos/campanhas', {
        nome: 'Black Friday',
        canal: 'WHATSAPP',
        canalIds: [canalId],
        texto: 'Oi {{contato.primeiro_nome}}, tem oferta!',
        ...extra,
      })
      .expect(201);
    const id = criada.body.id as string;
    await cliente
      .post(`/api/v1/disparos/campanhas/${id}/iniciar`, {})
      .expect(200);
    await drenarTudo(t);
    await enviarTudo(t, id);
    await confirmarEntrega(t, id, 'ENVIADA');
    return id;
  }

  async function receber(
    canalId: string,
    telefone: string,
    texto: string,
    idExterno: string,
  ) {
    await t.get(AtendimentoService).receber({
      canalId,
      remetente: { tipo: 'WHATSAPP', valor: telefone },
      mensagem: { idExterno, tipo: 'TEXTO', texto, recebidaEm: new Date() },
    });
    await drenarTudo(t);
  }

  describe('respostas e opt-out (R17.9)', () => {
    it('R17.9 — a resposta cai no Atendimento, marca o destinatário como respondeu (uma vez) e publica campanha.respondida', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 2);
      const id = await campanhaEnviada(cliente, canal.id);
      await receber(
        canal.id,
        contatos[0]!.telefone!,
        'Oi, quero saber mais!',
        'in-1',
      );
      await receber(canal.id, contatos[0]!.telefone!, 'Pode me ligar?', 'in-2');

      const dest = await t.prisma.campanhaDestinatario.findFirstOrThrow({
        where: { campanhaId: id, contatoId: contatos[0]!.id },
      });
      expect(dest.respondeuEm).not.toBeNull();
      const outro = await t.prisma.campanhaDestinatario.findFirstOrThrow({
        where: { campanhaId: id, contatoId: contatos[1]!.id },
      });
      expect(outro.respondeuEm).toBeNull();
      const eventos = await t.prisma.eventoDominio.findMany({
        where: { tipo: 'campanha.respondida' },
      });
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.dados).toMatchObject({
        campanhaId: id,
        destinatarioId: dest.id,
        contatoId: contatos[0]!.id,
      });
      // A conversa do contato está no Atendimento, aberta, com a resposta.
      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { contatoId: contatos[0]!.id, status: { not: 'RESOLVIDA' } },
      });
      expect(
        await t.prisma.mensagem.count({
          where: { conversaId: conversa.id, direcao: 'ENTRADA' },
        }),
      ).toBe(2);
      const detalhe = await cliente
        .get(`/api/v1/disparos/campanhas/${id}`)
        .expect(200);
      expect(detalhe.body.contadores.respondidos).toBe(1);
      const respondeu = await cliente
        .get(`/api/v1/disparos/campanhas/${id}/destinatarios?respondeu=true`)
        .expect(200);
      expect(respondeu.body.total).toBe(1);
    });

    it('R17.9 — resposta depois de 7 dias do envio não conta; contato sem campanha é ignorado', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 1);
      const id = await campanhaEnviada(cliente, canal.id);
      await t.prisma.campanhaDestinatario.updateMany({
        where: { campanhaId: id },
        data: { enviadoEm: new Date(Date.now() - 8 * 24 * 3_600_000) },
      });
      await t.prisma.mensagem.updateMany({
        where: { destinatarioCampanha: { campanhaId: id } },
        data: { ocorridaEm: new Date(Date.now() - 8 * 24 * 3_600_000) },
      });
      await receber(canal.id, contatos[0]!.telefone!, 'Oi', 'in-1');
      expect(
        (
          await t.prisma.campanhaDestinatario.findFirstOrThrow({
            where: { campanhaId: id },
          })
        ).respondeuEm,
      ).toBeNull();
      const estranho = await criarContato(t, {
        telefone: '11955554444',
        email: null,
      });
      await receber(canal.id, estranho.telefone!, 'sair', 'in-2');
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: estranho.id },
          })
        ).optOutMarketing,
      ).toBe(false);
    });

    it('R17.9 — palavra de saída aplica o opt-out (R4.6), responde a confirmação e audita como AUTOMACAO', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 2);
      const id = await campanhaEnviada(cliente, canal.id);
      // Outra campanha ainda com este contato pendente.
      const outra = await cliente
        .post('/api/v1/disparos/campanhas', {
          nome: 'Outra',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Oi',
        })
        .expect(201);
      await t.prisma.campanhaDestinatario.create({
        data: {
          campanhaId: outra.body.id,
          contatoId: contatos[0]!.id,
          destino: contatos[0]!.telefone!,
          ordem: 0,
        },
      });

      await receber(canal.id, contatos[0]!.telefone!, ' Sair! ', 'in-1');
      const contato = await t.prisma.contato.findUniqueOrThrow({
        where: { id: contatos[0]!.id },
      });
      expect(contato.optOutMarketing).toBe(true);
      expect(contato.optOutEm).not.toBeNull();
      const dest = await t.prisma.campanhaDestinatario.findFirstOrThrow({
        where: { campanhaId: id, contatoId: contatos[0]!.id },
      });
      expect(dest.optOutEm).not.toBeNull();
      expect(dest.respondeuEm).toBeNull();
      const pendente = await t.prisma.campanhaDestinatario.findFirstOrThrow({
        where: { campanhaId: outra.body.id },
      });
      expect(pendente).toMatchObject({ status: 'EXCLUIDO' });

      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { contatoId: contato.id, status: { not: 'RESOLVIDA' } },
      });
      const confirmacao = await t.prisma.mensagem.findFirstOrThrow({
        where: { conversaId: conversa.id, direcao: 'SAIDA' },
      });
      expect(confirmacao.texto).toContain('não receberá mais mensagens');
      expect(confirmacao.autorTipo).toBe('AUTOMACAO');

      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.atualizado', entidadeId: contato.id },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'AUTOMACAO',
        atorDescricao: 'Black Friday',
      });
      const detalhe = await cliente
        .get(`/api/v1/disparos/campanhas/${id}`)
        .expect(200);
      expect(detalhe.body.contadores.optOuts).toBe(1);

      // Repetir o evento não envia outra confirmação.
      await processarEventos(t, { incluirAgendados: true });
      expect(
        await t.prisma.mensagem.count({
          where: { conversaId: conversa.id, direcao: 'SAIDA' },
        }),
      ).toBe(1);
      // Opt-out fora de qualquer campanha futura: a prévia do público já não o conta.
      const previa = await cliente
        .post('/api/v1/disparos/previa-publico', {
          canal: 'WHATSAPP',
          segmento: { condicoes: [] },
        })
        .expect(200);
      expect(previa.body.total).toBe(1);
    });

    it('R17.9 — palavras de saída configuráveis; "não quero cancelar" não é saída', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 2);
      await admin
        .put('/api/v1/disparos/configuracao', {
          palavrasDeSaida: ['basta'],
          mensagemDeSaida: 'Combinado, não escrevemos mais.',
        })
        .expect(200);
      await campanhaEnviada(admin, canal.id);
      await receber(
        canal.id,
        contatos[0]!.telefone!,
        'não quero cancelar',
        'in-1',
      );
      await receber(canal.id, contatos[0]!.telefone!, 'sair', 'in-2');
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contatos[0]!.id },
          })
        ).optOutMarketing,
      ).toBe(false);
      await receber(canal.id, contatos[1]!.telefone!, 'BASTA', 'in-3');
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contatos[1]!.id },
          })
        ).optOutMarketing,
      ).toBe(true);
      const conf = await t.prisma.mensagem.findFirstOrThrow({
        where: { texto: 'Combinado, não escrevemos mais.' },
      });
      expect(conf.direcao).toBe('SAIDA');
    });
  });

  describe('aprovação do líder e configuração (R17.10)', () => {
    it('R17.10 — com a aprovação ligada, a campanha do membro espera o líder; reprovar volta a rascunho; aprovar inicia', async () => {
      const equipe = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const admin = await entrarComo(t, await criarUsuario(t));
      const membro = await entrarComo(t, equipe.membros[0]!);
      const lider = await entrarComo(t, equipe.lider);
      const { canal } = await cenarioWhatsapp(t, 2);
      await membro
        .put('/api/v1/disparos/configuracao', { aprovacaoDoLider: true })
        .expect(403);
      expect(
        (
          await admin
            .put('/api/v1/disparos/configuracao', { aprovacaoDoLider: true })
            .expect(200)
        ).body.aprovacaoDoLider,
      ).toBe(true);
      await admin
        .put('/api/v1/disparos/configuracao', { palavrasDeSaida: [] })
        .expect(400);

      const criada = await membro
        .post('/api/v1/disparos/campanhas', {
          nome: 'Promo',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Oi',
        })
        .expect(201);
      const url = `/api/v1/disparos/campanhas/${criada.body.id}`;
      const pedida = await membro.post(`${url}/iniciar`, {}).expect(200);
      expect(pedida.body.status).toBe('AGUARDANDO_APROVACAO');
      expect(pedida.body.acoes).toMatchObject({
        aprovar: false,
        editar: false,
      });
      await membro.patch(url, { nome: 'Outro' }).expect(422);
      await membro.post(`${url}/aprovar`, {}).expect(403);
      const aviso = await t.prisma.notificacao.findFirstOrThrow({
        where: {
          usuarioId: equipe.lider.id,
          tipo: 'campanha.aprovacao_pedida',
        },
      });
      expect(aviso.link).toBe(`/disparos/${criada.body.id}`);

      await lider.post(`${url}/reprovar`, {}).expect(400);
      const reprovada = await lider
        .post(`${url}/reprovar`, { motivo: 'Falta o link de saída' })
        .expect(200);
      expect(reprovada.body).toMatchObject({
        status: 'RASCUNHO',
        aprovacao: { reprovacaoMotivo: 'Falta o link de saída' },
      });
      expect(
        await t.prisma.notificacao.count({
          where: {
            usuarioId: equipe.membros[0]!.id,
            tipo: 'campanha.reprovada',
          },
        }),
      ).toBe(1);

      await membro.post(`${url}/iniciar`, {}).expect(200);
      const aprovada = await lider.post(`${url}/aprovar`, {}).expect(200);
      expect(aprovada.body.status).toBe('EM_ANDAMENTO');
      expect(aprovada.body.aprovacao.aprovadaPor).toMatchObject({
        id: equipe.lider.id,
      });
      expect(
        await t.prisma.notificacao.count({
          where: {
            usuarioId: equipe.membros[0]!.id,
            tipo: 'campanha.aprovada',
          },
        }),
      ).toBe(1);
      await drenarTudo(t);
      expect(await t.prisma.mensagem.count()).toBe(1);

      // Líder e diretoria não precisam de aprovação.
      const propria = await lider
        .post('/api/v1/disparos/campanhas', {
          nome: 'Do líder',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Oi',
        })
        .expect(201);
      expect(
        (
          await lider
            .post(`/api/v1/disparos/campanhas/${propria.body.id}/iniciar`, {})
            .expect(200)
        ).body.status,
      ).toBe('EM_ANDAMENTO');
    });
  });

  describe('relatório e exportação (R17.11)', () => {
    it('R17.11 — relatório com taxas, por número, ao longo do tempo e motivos de falha', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const { canal, contatos } = await cenarioWhatsapp(t, 3);
      gateway.semWhatsapp.add(contatos[2]!.telefone!);
      const id = await campanhaEnviada(cliente, canal.id);
      await confirmarEntrega(t, id, 'ENTREGUE');
      const lidas = await t.prisma.mensagem.findMany({
        where: { destinatarioCampanha: { campanhaId: id } },
        take: 1,
        orderBy: { ocorridaEm: 'asc' },
      });
      await t
        .get(AtendimentoService)
        .atualizarStatus(canal.id, lidas[0]!.idExterno!, 'LIDA');
      await receber(canal.id, contatos[0]!.telefone!, 'Quero', 'in-1');
      await varrer(t);

      const r = (
        await cliente
          .get(`/api/v1/disparos/campanhas/${id}/relatorio`)
          .expect(200)
      ).body;
      expect(r.contadores).toMatchObject({
        total: 3,
        enviados: 2,
        entregues: 2,
        invalidos: 1,
        falhas: 0,
      });
      expect(r.taxas.entrega).toBe(100);
      expect(r.porNumero).toHaveLength(1);
      expect(r.porNumero[0]).toMatchObject({
        canalId: canal.id,
        enviados: 2,
        entregues: 2,
      });
      expect(r.serie.length).toBeGreaterThanOrEqual(1);
      expect(
        r.serie.reduce(
          (s: number, p: { enviados: number }) => s + p.enviados,
          0,
        ),
      ).toBe(2);
      expect(r.motivosDeFalha).toEqual([
        { motivo: 'Este número não tem WhatsApp.', quantidade: 1 },
      ]);
      const porDia = (
        await cliente
          .get(`/api/v1/disparos/campanhas/${id}/relatorio?agrupar=dia`)
          .expect(200)
      ).body;
      expect(porDia.serie[0].inicio).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await cliente
        .get(`/api/v1/disparos/campanhas/${id}/relatorio?agrupar=semana`)
        .expect(400);
    });

    it('R17.11 — exporta em XLSX e CSV; baixa quem enviou ou vê a campanha (líder), não os outros', async () => {
      const equipe = await criarEquipe(t, 'MARKETING', { membros: 2 });
      const dono = await entrarComo(t, equipe.membros[0]!);
      const colega = await entrarComo(t, equipe.membros[1]!);
      const lider = await entrarComo(t, equipe.lider);
      const { canal } = await cenarioWhatsapp(t, 2);
      await t.prisma.contato.updateMany({
        data: { nome: '=SOMA(1+1)' },
        where: { telefone: '5511988001000' },
      });
      const id = await campanhaEnviada(dono, canal.id);

      const xlsx = (
        await dono
          .post(`/api/v1/disparos/campanhas/${id}/exportar`, {})
          .expect(200)
      ).body;
      expect(xlsx).toMatchObject({
        contexto: 'RELATORIO',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(xlsx.nome).toMatch(
        /^campanha-black-friday-\d{4}-\d{2}-\d{2}\.xlsx$/,
      );
      const csv = (
        await dono
          .post(`/api/v1/disparos/campanhas/${id}/exportar`, { formato: 'csv' })
          .expect(200)
      ).body;
      const baixado = await dono.get(csv.url).expect(200);
      const texto =
        baixado.text ?? Buffer.from(baixado.body as Buffer).toString('utf8');
      const linhas = texto.replace(/^﻿/, '').trim().split('\r\n');
      expect(linhas[0]).toBe(
        'Contato;Telefone;Situação;Motivo;Enviado por;Enviado em;Entregue em;Lido em;Respondeu em;Opt-out em',
      );
      expect(linhas).toHaveLength(3);
      expect(texto).not.toContain(';=SOMA');
      expect(texto).toContain("'=SOMA(1+1)");
      await dono.get(xlsx.url).expect(200);

      await lider.get(csv.url).expect(200);
      await colega.get(csv.url).expect(404);
      await colega
        .post(`/api/v1/disparos/campanhas/${id}/exportar`, {})
        .expect(404);
      await dono
        .post(`/api/v1/disparos/campanhas/${id}/exportar`, { formato: 'pdf' })
        .expect(400);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'campanha.exportada' },
        }),
      ).toBe(2);
    });

    it('R17.11 — mídia da campanha (contexto CAMPANHA): vê quem vê a campanha; outro membro não', async () => {
      const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
      const dono = await entrarComo(t, equipe.membros[0]!);
      const colega = await entrarComo(t, equipe.membros[1]!);
      const lider = await entrarComo(t, equipe.lider);
      const { canal } = await cenarioWhatsapp(t, 1);
      const imagem = await criarArquivo(t, {
        contexto: 'CAMPANHA',
        mime: 'image/png',
        criadoPor: equipe.membros[0]!,
      });
      const campanha = await dono
        .post('/api/v1/disparos/campanhas', {
          nome: 'Com imagem',
          canal: 'WHATSAPP',
          canalIds: [canal.id],
          texto: 'Veja',
          arquivoId: imagem.id,
        })
        .expect(201);
      expect(campanha.body.arquivo).toMatchObject({
        id: imagem.id,
        contexto: 'CAMPANHA',
      });
      await dono.get(`/api/v1/arquivos/${imagem.id}`).expect(200);
      await lider.get(`/api/v1/arquivos/${imagem.id}`).expect(200);
      await colega.get(`/api/v1/arquivos/${imagem.id}`).expect(404);

      await dono
        .post(`/api/v1/disparos/campanhas/${campanha.body.id}/iniciar`, {})
        .expect(200);
      await drenarFilas(t, FILA_DISPAROS_ENVIAR);
      const mensagem = await t.prisma.mensagem.findFirstOrThrow({
        where: { direcao: 'SAIDA' },
      });
      expect(mensagem).toMatchObject({ tipo: 'IMAGEM', arquivoId: imagem.id });
    });
  });

  describe('modelos de mensagem e configuração (R17.3)', () => {
    it('R17.3 — CRUD de modelos: validação, escopo por área, edição por quem criou/líder/diretoria', async () => {
      const marketing = await criarEquipe(t, 'MARKETING', { membros: 1 });
      const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const dono = await entrarComo(t, marketing.membros[0]!);
      const lider = await entrarComo(t, marketing.lider);
      const outraArea = await entrarComo(t, comercial.membros[0]!);
      const admin = await entrarComo(t, await criarUsuario(t));

      await dono
        .post('/api/v1/modelos-mensagem', {
          nome: 'Ruim',
          texto: 'Oi {{inexistente.x}}',
        })
        .expect(400);
      await dono
        .post('/api/v1/modelos-mensagem', { nome: '', texto: 'Oi' })
        .expect(400);
      const criado = (
        await dono
          .post('/api/v1/modelos-mensagem', {
            nome: 'Boas-vindas',
            canal: 'WHATSAPP',
            texto: '{Oi|Olá} {{contato.primeiro_nome|amigo}}!',
          })
          .expect(201)
      ).body;
      expect(criado).toMatchObject({
        area: 'MARKETING',
        podeEditar: true,
        variaveis: expect.arrayContaining(['contato.primeiro_nome']),
      });
      const global = (
        await admin
          .post('/api/v1/modelos-mensagem', { nome: 'Geral', texto: 'Olá' })
          .expect(201)
      ).body;
      expect(global.area).toBeNull();

      const vistoPeloComercial = (
        await outraArea.get('/api/v1/modelos-mensagem').expect(200)
      ).body;
      expect(
        vistoPeloComercial.itens.map((m: { nome: string }) => m.nome),
      ).toEqual(['Geral']);
      await outraArea.get(`/api/v1/modelos-mensagem/${criado.id}`).expect(404);
      const doMarketing = (
        await lider.get('/api/v1/modelos-mensagem?canal=EMAIL').expect(200)
      ).body;
      expect(doMarketing.itens.map((m: { nome: string }) => m.nome)).toEqual([
        'Geral',
      ]); // o de WhatsApp fica fora
      await dono
        .patch(`/api/v1/modelos-mensagem/${global.id}`, { nome: 'Invadido' })
        .expect(403);
      await lider
        .patch(`/api/v1/modelos-mensagem/${criado.id}`, {
          nome: 'Boas-vindas v2',
        })
        .expect(200);
      await dono.delete(`/api/v1/modelos-mensagem/${criado.id}`).expect(204);
      await dono.get(`/api/v1/modelos-mensagem/${criado.id}`).expect(404);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: { startsWith: 'modelo_mensagem.' } },
        }),
      ).toBe(4);
    });

    it('R17.3 — configuração padrão e estimativa de duração para o assistente', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const config = (
        await admin.get('/api/v1/disparos/configuracao').expect(200)
      ).body;
      expect(config).toMatchObject({
        aprovacaoDoLider: false,
        palavrasDeSaida: ['SAIR', 'PARAR', 'CANCELAR'],
      });
      const { canal } = await cenarioWhatsapp(t, 0, { limiteDiario: 100 });
      const estimativa = (
        await admin
          .post('/api/v1/disparos/estimativa', {
            total: 300,
            canal: 'WHATSAPP',
            canalIds: [canal.id],
            ritmo: { intervaloMinimoSegundos: 30, intervaloMaximoSegundos: 30 },
          })
          .expect(200)
      ).body;
      expect(estimativa).toMatchObject({
        duracaoSegundos: 9000,
        dias: 3,
        limiteDiarioTotal: 100,
      });
      await admin
        .post('/api/v1/disparos/estimativa', { total: -1, canal: 'WHATSAPP' })
        .expect(400);
    });
  });
});
