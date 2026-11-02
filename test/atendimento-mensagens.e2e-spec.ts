import { AtendimentoService } from '../src/atendimento/atendimento.service';
import { FALHA_DEPOIS_DAS_TENTATIVAS } from '../src/atendimento/envio.service';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import type { Conversa } from '../src/generated/prisma/client';
import {
  type AdaptadorFalso,
  type CenarioDoAtendimento,
  drenarEnvios,
  montarCenario,
  usarAdaptadorFalso,
} from './atendimento-apoio';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarArquivo,
  criarCanal,
  criarCanalWhatsapp,
  criarContato,
  criarConversa,
  criarFila,
  criarMensagem,
  entrarComo,
  esperarEvento,
  fecharSockets,
  pedirAoTempoReal,
  processarEventos,
  type SocketDeTeste,
} from './utils';

const BASE = '/api/v1/atendimento';

/**
 * Mensagens do Atendimento (§2.4): envio pela fila do canal com o adaptador
 * (síncrono, enfileirado, falha definitiva e passageira), nova tentativa,
 * janela de 24 h da Meta, anexos, notas internas, histórico por cursor,
 * início de conversa pela equipe e o status em tempo real.
 */
describe('Atendimento — mensagens (e2e)', () => {
  let t: AppTeste;
  let cenario: CenarioDoAtendimento;
  let falso: AdaptadorFalso;
  const desfazeres: Array<() => void> = [];
  const abertos: SocketDeTeste[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    cenario = await montarCenario(t);
    const troca = usarAdaptadorFalso(t, 'WEBCHAT');
    falso = troca.adaptador;
    desfazeres.push(troca.desfazer);
  });
  afterEach(() => {
    for (const desfazer of desfazeres.splice(0).reverse()) {
      desfazer();
    }
    fecharSockets(...abertos.splice(0));
  });
  afterAll(() => t.fechar());

  /** Conversa da Ana com uma mensagem do contato. */
  async function conversaDaAna(): Promise<Conversa> {
    const conversa = await criarConversa(t, {
      canal: cenario.canal,
      fila: cenario.fila,
      responsavel: cenario.comercial.membros[0],
    });
    await criarMensagem(t, { conversa, texto: 'Quanto custa?' });
    return t.prisma.conversa.findUniqueOrThrow({ where: { id: conversa.id } });
  }

  describe('envio pela fila do canal', () => {
    it('síncrono: PENDENTE → ENVIADA com o id do provedor; marca a primeira resposta', async () => {
      const conversa = await conversaDaAna();
      const ana = await entrarComo(t, cenario.comercial.membros[0]);
      const enviada = await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          texto: '  Custa R$ 100.  ',
        })
        .expect(201);
      expect(enviada.body).toMatchObject({
        direcao: 'SAIDA',
        tipo: 'TEXTO',
        texto: 'Custa R$ 100.',
        status: 'PENDENTE',
        autor: { id: cenario.comercial.membros[0].id },
        automatica: false,
      });
      const resumo = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversa.id },
      });
      expect(resumo).toMatchObject({
        naoLidas: 0,
        aguardandoDesde: null,
        ultimaMensagemId: enviada.body.id,
      });
      expect(resumo.primeiraRespostaEm).not.toBeNull();

      expect(await drenarEnvios(t)).toBe(1);
      expect(falso.textos()).toEqual(['Custa R$ 100.']);
      const depois = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: enviada.body.id },
      });
      expect(depois).toMatchObject({
        status: 'ENVIADA',
        idExterno: 'FALSO-1',
        tentativas: 1,
        erro: null,
      });
      expect(depois.enviadaEm).not.toBeNull();
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'mensagem.enviada' },
        }),
      ).toBe(1);
      // A segunda resposta não muda a primeira resposta.
      await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          texto: 'Mais algo?',
        })
        .expect(201);
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: conversa.id },
          })
        ).primeiraRespostaEm,
      ).toEqual(resumo.primeiraRespostaEm);
    });

    it('enfileirado: fica PENDENTE até o canal informar o status', async () => {
      falso.modo = 'enfileirado';
      const conversa = await conversaDaAna();
      const { body } = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
      await drenarEnvios(t);
      const pendente = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(pendente).toMatchObject({
        status: 'PENDENTE',
        idExterno: 'FALSO-1',
      });
      await executarComoAtor({ tipoAtor: 'SISTEMA', descricao: 'teste' }, () =>
        t
          .get(AtendimentoService)
          .atualizarStatus(cenario.canal.id, 'FALSO-1', 'ENTREGUE'),
      );
      expect(
        (await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }))
          .status,
      ).toBe('ENTREGUE');
    });

    it('cenário 25 — falha definitiva: FALHOU com o motivo; "tentar de novo" volta a PENDENTE e envia', async () => {
      falso.modo = 'definitiva';
      const conversa = await conversaDaAna();
      const ana = await entrarComo(t, cenario.comercial.membros[0]);
      const { body } = await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
      await drenarEnvios(t);
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }),
      ).toMatchObject({ status: 'FALHOU', erro: 'O destinatário não existe.' });

      falso.modo = 'sincrono';
      const outra = await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Outra' })
        .expect(201);
      await ana
        .post(
          `${BASE}/conversas/${conversa.id}/mensagens/${outra.body.id}/reenviar`,
        )
        .expect(409);
      const novaTentativa = await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens/${body.id}/reenviar`)
        .expect(200);
      expect(novaTentativa.body).toMatchObject({
        status: 'PENDENTE',
        erro: null,
      });
      await drenarEnvios(t);
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }),
      ).toMatchObject({ status: 'ENVIADA', tentativas: 2 });
    });

    it('falha passageira: tenta de novo e, esgotadas as tentativas, FALHOU', async () => {
      falso.modo = 'passageira';
      const conversa = await conversaDaAna();
      const { body } = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
      await drenarEnvios(t);
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }),
      ).toMatchObject({ status: 'PENDENTE', tentativas: 1 });
      await drenarEnvios(t, { incluirAgendados: true });
      expect(falso.enviados).toHaveLength(4);
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }),
      ).toMatchObject({
        status: 'FALHOU',
        erro: FALHA_DEPOIS_DAS_TENTATIVAS,
        tentativas: 4,
      });
    });

    it('WhatsApp: o id da mensagem é gravado antes de ir para o gateway', async () => {
      const troca = usarAdaptadorFalso(t, 'WHATSAPP');
      desfazeres.push(troca.desfazer);
      troca.adaptador.modo = 'enfileirado';
      const { canal } = await criarCanalWhatsapp(t, {
        filaPadrao: cenario.fila,
      });
      const conversa = await criarConversa(t, {
        canal,
        responsavel: cenario.comercial.membros[0],
        fila: cenario.fila,
      });
      const { body } = await (
        await entrarComo(t, cenario.comercial.membros[0])
      )
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
      const gravada = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(gravada.idExterno).toMatch(/^3EB0[0-9A-F]+$/);
      await drenarEnvios(t);
      expect(troca.adaptador.enviados[0].mensagem.idExterno).toBe(
        gravada.idExterno,
      );
      expect(
        (await t.prisma.mensagem.findUniqueOrThrow({ where: { id: body.id } }))
          .idExterno,
      ).toBe(gravada.idExterno);
    });
  });

  describe('regras do envio', () => {
    it('400 sem texto nem anexo; 422 resolvida, canal desativado ou janela da Meta fechada', async () => {
      const conversa = await conversaDaAna();
      const ana = await entrarComo(t, cenario.comercial.membros[0]);
      await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: '   ' })
        .expect(400);
      const outraConversa = await criarConversa(t, { canal: cenario.canal });
      const citadaDeFora = await criarMensagem(t, { conversa: outraConversa });
      await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          texto: 'Oi',
          respostaAId: citadaDeFora.id,
        })
        .expect(400);

      await t.prisma.canal.update({
        where: { id: cenario.canal.id },
        data: { ativo: false },
      });
      await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(422);
      await t.prisma.canal.update({
        where: { id: cenario.canal.id },
        data: { ativo: true },
      });
      await t.prisma.conversa.update({
        where: { id: conversa.id },
        data: { status: 'RESOLVIDA', resolvidaEm: new Date() },
      });
      await ana
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(422);

      // Instagram com o adaptador real: janela de 24 h (R14).
      const instagram = await criarCanal(t, { tipo: 'INSTAGRAM' });
      const meta = await criarConversa(t, {
        canal: instagram,
        fila: cenario.fila,
        responsavel: cenario.comercial.membros[0],
        janelaAte: new Date(Date.now() - 60_000),
        ultimaEntradaEm: new Date(Date.now() - 25 * 3600_000),
      });
      const fechada = await ana
        .post(`${BASE}/conversas/${meta.id}/mensagens`, { texto: 'Oi' })
        .expect(422);
      expect(fechada.body.detalhes).toMatchObject({ regra: 'R14' });
      const detalhe = await ana.get(`${BASE}/conversas/${meta.id}`).expect(200);
      expect(detalhe.body.podeResponder).toMatchObject({ pode: false });
      expect(detalhe.body.acoes.responder).toBe(false);
      await t.prisma.conversa.update({
        where: { id: meta.id },
        data: { janelaAte: new Date(Date.now() + 3600_000) },
      });
      await ana
        .post(`${BASE}/conversas/${meta.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
    });

    it('responder conversa sem responsável: quem respondeu assume', async () => {
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        fila: cenario.fila,
      });
      const [, bia] = cenario.comercial.membros;
      await (
        await entrarComo(t, bia)
      )
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Olá!' })
        .expect(201);
      expect(
        await t.prisma.conversa.findUniqueOrThrow({
          where: { id: conversa.id },
        }),
      ).toMatchObject({ responsavelId: bia.id });
      expect(
        await t.prisma.conversaAtribuicao.findFirstOrThrow({
          where: { conversaId: conversa.id },
        }),
      ).toMatchObject({ motivo: 'ASSUMIDA', paraUsuarioId: bia.id });
    });

    it('anexo: só de mensagem e que a pessoa pode usar; o tipo vem do MIME', async () => {
      const conversa = await conversaDaAna();
      const ana = cenario.comercial.membros[0];
      const cliente = await entrarComo(t, ana);
      const imagem = await criarArquivo(t, {
        mime: 'image/png',
        criadoPor: ana,
      });
      const resposta = await cliente
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          arquivoId: imagem.id,
        })
        .expect(201);
      expect(resposta.body).toMatchObject({
        tipo: 'IMAGEM',
        texto: null,
        arquivo: { id: imagem.id, url: `/api/v1/arquivos/${imagem.id}` },
      });
      const doChat = await criarArquivo(t, {
        contexto: 'CHAT',
        criadoPor: ana,
      });
      await cliente
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          arquivoId: doChat.id,
        })
        .expect(400);
      const deOutro = await criarArquivo(t, {
        criadoPor: cenario.comercial.membros[1],
      });
      await cliente
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          arquivoId: deOutro.id,
        })
        .expect(400);
    });
  });

  describe('notas internas e histórico', () => {
    it('nota interna: não vai ao contato; avisa o responsável quando é de outra pessoa', async () => {
      const conversa = await conversaDaAna();
      const lider = await entrarComo(t, cenario.comercial.lider);
      const nota = await lider
        .post(`${BASE}/conversas/${conversa.id}/notas`, {
          texto: 'Ofereça o plano anual.',
        })
        .expect(201);
      expect(nota.body).toMatchObject({
        direcao: 'INTERNA',
        status: null,
        autor: { id: cenario.comercial.lider.id },
      });
      await drenarEnvios(t);
      expect(falso.enviados).toHaveLength(0);
      expect(
        await t.prisma.notificacao.findFirstOrThrow({
          where: {
            usuarioId: cenario.comercial.membros[0].id,
            tipo: 'conversa.nota_interna',
          },
        }),
      ).toMatchObject({ link: `/atendimento/${conversa.id}` });
      await lider
        .post(`${BASE}/conversas/${conversa.id}/notas`, { texto: '' })
        .expect(400);
    });

    it('histórico por cursor: das mais novas para as mais antigas, cada página em ordem', async () => {
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        fila: cenario.fila,
        responsavel: cenario.comercial.membros[0],
      });
      const base = Date.now() - 10 * 60_000;
      for (let indice = 1; indice <= 5; indice++) {
        await criarMensagem(t, {
          conversa,
          texto: `m${indice}`,
          ocorridaEm: new Date(base + indice * 1000),
        });
      }
      const cliente = await entrarComo(t, cenario.comercial.membros[0]);
      const pagina1 = await cliente
        .get(`${BASE}/conversas/${conversa.id}/mensagens?limite=2`)
        .expect(200);
      expect(pagina1.body.itens.map((m: { texto: string }) => m.texto)).toEqual(
        ['m4', 'm5'],
      );
      const pagina2 = await cliente
        .get(
          `${BASE}/conversas/${conversa.id}/mensagens?limite=2&cursor=${pagina1.body.proximoCursor}`,
        )
        .expect(200);
      expect(pagina2.body.itens.map((m: { texto: string }) => m.texto)).toEqual(
        ['m2', 'm3'],
      );
      const pagina3 = await cliente
        .get(
          `${BASE}/conversas/${conversa.id}/mensagens?limite=2&cursor=${pagina2.body.proximoCursor}`,
        )
        .expect(200);
      expect(pagina3.body).toMatchObject({
        itens: [expect.objectContaining({ texto: 'm1' })],
        proximoCursor: null,
      });
      await cliente
        .get(`${BASE}/conversas/${conversa.id}/mensagens?cursor=xyz`)
        .expect(400);
    });
  });

  describe('início de conversa pela equipe', () => {
    it('começa no WhatsApp (fica com quem começou) e continua na mesma; recusa sem destino', async () => {
      const troca = usarAdaptadorFalso(t, 'WHATSAPP');
      desfazeres.push(troca.desfazer);
      const { canal } = await criarCanalWhatsapp(t, {
        filaPadrao: cenario.fila,
      });
      const ana = cenario.comercial.membros[0];
      const cliente = await entrarComo(t, ana);
      const contato = await criarContato(t, { telefone: '11988887777' });
      const criada = await cliente
        .post(`${BASE}/conversas`, {
          canalId: canal.id,
          contatoId: contato.id,
          texto: 'Olá! Vi seu cadastro.',
        })
        .expect(201);
      expect(criada.body).toMatchObject({
        responsavel: { id: ana.id },
        fila: { id: cenario.fila.id },
        contato: { id: contato.id },
        primeiraRespostaEm: null,
        ultimaMensagem: { direcao: 'SAIDA', previa: 'Olá! Vi seu cadastro.' },
      });
      const mesma = await cliente
        .post(`${BASE}/conversas`, {
          canalId: canal.id,
          contatoId: contato.id,
          texto: 'Conseguiu ver?',
        })
        .expect(201);
      expect(mesma.body.id).toBe(criada.body.id);
      expect(
        await t.prisma.conversa.count({ where: { canalId: canal.id } }),
      ).toBe(1);
      expect(
        await t.prisma.conversaAtribuicao.findFirstOrThrow({
          where: { conversaId: criada.body.id },
        }),
      ).toMatchObject({ motivo: 'MANUAL', paraUsuarioId: ana.id });

      const semTelefone = await criarContato(t);
      await cliente
        .post(`${BASE}/conversas`, {
          canalId: canal.id,
          contatoId: semTelefone.id,
          texto: 'Oi',
        })
        .expect(422);
      await cliente
        .post(`${BASE}/conversas`, {
          canalId: cenario.canal.id,
          contatoId: contato.id,
          texto: 'Oi',
        })
        .expect(422);
      await cliente
        .post(`${BASE}/conversas`, { canalId: canal.id, contatoId: contato.id })
        .expect(400);
    });

    it('começada pela equipe: só o prazo de resolução vale, também depois de transferir', async () => {
      const troca = usarAdaptadorFalso(t, 'WHATSAPP');
      desfazeres.push(troca.desfazer);
      const filaComSla = await criarFila(t, {
        area: 'COMERCIAL',
        slaPrimeiraRespostaMinutos: 30,
        slaResolucaoMinutos: 240,
      });
      const outraFila = await criarFila(t, {
        area: 'COMERCIAL',
        slaPrimeiraRespostaMinutos: 60,
        slaResolucaoMinutos: 480,
        estrategia: 'MANUAL',
      });
      const { canal } = await criarCanalWhatsapp(t, { filaPadrao: filaComSla });
      const cliente = await entrarComo(t, cenario.comercial.membros[0]);
      const contato = await criarContato(t, { telefone: '11977776666' });
      const antes = Date.now();
      const criada = await cliente
        .post(`${BASE}/conversas`, {
          canalId: canal.id,
          contatoId: contato.id,
          texto: 'Olá!',
        })
        .expect(201);
      expect(criada.body.sla.primeiraRespostaAte).toBeNull();
      const resolucao = new Date(criada.body.sla.resolucaoAte).getTime();
      expect(resolucao).toBeGreaterThanOrEqual(antes + 240 * 60_000);
      expect(resolucao).toBeLessThanOrEqual(Date.now() + 240 * 60_000);

      const transferida = await cliente
        .post(`${BASE}/conversas/${criada.body.id}/transferir`, {
          filaId: outraFila.id,
        })
        .expect(200);
      expect(transferida.body.sla).toMatchObject({
        primeiraRespostaAte: null,
        primeiraRespostaEstourada: false,
      });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: criada.body.id },
      });
      expect(conversa.slaResolucaoAte?.getTime()).toBe(
        conversa.criadoEm.getTime() + 480 * 60_000,
      );
    });
  });

  describe('tempo real', () => {
    it('quem está na conversa recebe mensagem.nova e mensagem.status', async () => {
      const conversa = await conversaDaAna();
      const ana = cenario.comercial.membros[0];
      const cliente = await entrarComo(t, ana);
      const socket = await conectarTempoReal(t, cliente);
      abertos.push(socket);
      expect(
        await pedirAoTempoReal(socket, 'conversa.entrar', {
          conversaId: conversa.id,
        }),
      ).toEqual({ ok: true });
      const nova = esperarEvento(socket, 'mensagem.nova');
      const { body } = await cliente
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, { texto: 'Oi' })
        .expect(201);
      await processarEventos(t);
      expect(await nova).toMatchObject({
        conversaId: conversa.id,
        mensagem: { id: body.id, status: 'PENDENTE' },
      });
      const status = esperarEvento(socket, 'mensagem.status');
      await drenarEnvios(t);
      await processarEventos(t);
      expect(await status).toMatchObject({
        conversaId: conversa.id,
        mensagemId: body.id,
        status: 'ENVIADA',
      });
    });

    it('quem responde e assume tira da sala os colegas que deixam de ver a conversa', async () => {
      const conversa = await criarConversa(t, {
        canal: cenario.canal,
        fila: cenario.fila,
      });
      await criarMensagem(t, { conversa, texto: 'Alguém aí?' });
      const [ana, bia] = cenario.comercial.membros;
      const socketDaBia = await conectarTempoReal(t, await entrarComo(t, bia));
      abertos.push(socketDaBia);
      expect(
        await pedirAoTempoReal(socketDaBia, 'conversa.entrar', {
          conversaId: conversa.id,
        }),
      ).toEqual({ ok: true });
      const mensagensDaBia: unknown[] = [];
      socketDaBia.on('mensagem.nova', (dados: unknown) =>
        mensagensDaBia.push(dados),
      );

      await (
        await entrarComo(t, ana)
      )
        .post(`${BASE}/conversas/${conversa.id}/mensagens`, {
          texto: 'Eu atendo!',
        })
        .expect(201);
      const atualizada = esperarEvento(socketDaBia, 'conversa.atualizada');
      await processarEventos(t);
      // A Bia fica sabendo que a conversa tem dono (pela sala da área)…
      expect(await atualizada).toMatchObject({
        conversa: { id: conversa.id, responsavel: { id: ana.id } },
      });
      // …mas não recebe mais as mensagens dela, nem volta à sala.
      await new Promise((resolver) => setTimeout(resolver, 200));
      expect(mensagensDaBia).toEqual([]);
      expect(
        await pedirAoTempoReal(socketDaBia, 'conversa.entrar', {
          conversaId: conversa.id,
        }),
      ).toMatchObject({ ok: false });
    });
  });
});
