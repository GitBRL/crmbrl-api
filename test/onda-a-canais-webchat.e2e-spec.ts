import { runInNewContext } from 'node:vm';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { FILA_ENVIO_ATENDIMENTO } from '../src/atendimento/atendimento.constantes';
import { AdaptadorWebchat } from '../src/canais/webchat/adaptador-webchat';
import { LimitadorDeRequisicoes } from '../src/canais/comum/limitador';
import { TAMANHO_MAXIMO_DO_WIDGET } from '../src/canais/webchat/widget.service';
import { CAMINHO_SOCKET_IO } from '../src/tempo-real/catalogo';
import type { Canal } from '../src/generated/prisma/client';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarContato,
  criarUsuario,
  drenarFilas,
  entrarComo,
  esperarEvento,
  fecharSockets,
  ORIGEM_DE_TESTE,
  PNG_DE_TESTE,
  pedirAoTempoReal,
} from './utils';

const SITE = 'https://www.loja-teste.com.br';
const PUBLICO = '/api/v1/publico/webchat';

/**
 * Chat do site (§2.5, R14): configuração pelo Admin, widget, rotas públicas
 * (origem/CORS, limite, token no corpo), contato com consentimento (R4.6),
 * entrada pelo Atendimento, anexos com link assinado, Socket.IO `/webchat`
 * (mensagens da equipe, "digitando", lidas) e o protocolo que o widget fala.
 */
describe('Canais — chat do site (e2e)', () => {
  let t: AppTeste;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    t.get(LimitadorDeRequisicoes).zerar();
  });
  afterEach(() => {
    fecharSockets(...sockets.splice(0));
  });
  afterAll(() => t.fechar());

  async function admin() {
    return entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  }

  async function criarCanalPelaApi(corpo: object = {}): Promise<{
    id: string;
    chavePublica: string;
    [campo: string]: unknown;
  }> {
    const resposta = await (
      await admin()
    )
      .post('/api/v1/webchat/canais', {
        nome: 'Site da loja',
        dominios: ['www.loja-teste.com.br'],
        ...corpo,
      })
      .expect(201);
    return resposta.body as { id: string; chavePublica: string };
  }

  const publico = (
    metodo: 'get' | 'post',
    caminho: string,
    origem: string | null = SITE,
  ) => {
    const pedido = request(t.servidor)[metodo](`${PUBLICO}${caminho}`);
    return origem ? pedido.set('Origin', origem) : pedido;
  };

  async function novoVisitante(
    chave: string,
    dados: Record<string, string> = {},
  ): Promise<{ token: string; visitanteId: string }> {
    const resposta = await publico('post', `/${chave}/visitantes`)
      .type('form')
      .send({
        nome: 'Maria Visitante',
        email: 'maria@cliente.com',
        consentimento: 'true',
        pagina: `${SITE}/planos?utm_source=google&utm_campaign=outubro`,
        ...dados,
      })
      .expect(201);
    return resposta.body as { token: string; visitanteId: string };
  }

  function conectarVisitante(
    base: string,
    chave: string,
    token: string,
    origem = SITE,
  ): Promise<{ socket: Socket } | { erro: string }> {
    const socket = io(`${base}/webchat`, {
      path: CAMINHO_SOCKET_IO,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { chave, token },
      extraHeaders: { Origin: origem },
    });
    sockets.push(socket);
    return new Promise((resolver) => {
      socket.once('connect', () => resolver({ socket }));
      socket.once('connect_error', (erro: Error) =>
        resolver({ erro: erro.message }),
      );
    });
  }

  describe('configuração (Admin)', () => {
    it('cria com chave pública, domínios normalizados e trecho de instalação; audita', async () => {
      const canal = await criarCanalPelaApi({
        dominios: ['www.loja-teste.com.br/', '*.loja-teste.com.br'],
        aparencia: { corPrimaria: '#166534', titulo: 'Fale com a loja' },
      });
      expect(canal).toMatchObject({
        tipo: 'WEBCHAT',
        nome: 'Site da loja',
        ativo: true,
        dominios: [SITE, 'https://*.loja-teste.com.br'],
        aparencia: {
          titulo: 'Fale com a loja',
          corPrimaria: '#166534',
          corTextoPrimaria: '#FFFFFF',
        },
        contato: 'EMAIL_OU_TELEFONE',
        permitirAnexos: true,
        instalacao: {
          urlDoWidget: `${ORIGEM_DE_TESTE}/api/v1/publico/webchat/widget.js`,
          trecho: `<script src="${ORIGEM_DE_TESTE}/api/v1/publico/webchat/widget.js" data-chave="${canal.chavePublica}" async></script>`,
        },
      });
      expect(canal.chavePublica).toMatch(/^wc_[A-Za-z0-9_-]{24}$/);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'canal.criado', entidadeId: canal.id },
        }),
      ).toBe(1);

      const cliente = await admin();
      await cliente
        .patch(`/api/v1/webchat/canais/${canal.id}`, {
          aparencia: { tema: 'escuro' },
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body.aparencia).toMatchObject({
            tema: 'escuro',
            corPrimaria: '#166534',
          });
        });
      expect(
        (await cliente.get('/api/v1/webchat/canais').expect(200)).body,
      ).toHaveLength(1);
    });

    it('recusa domínio inválido, fila inexistente e quem não é Admin', async () => {
      const cliente = await admin();
      const invalido = await cliente
        .post('/api/v1/webchat/canais', { nome: 'X', dominios: ['ftp://site'] })
        .expect(400);
      expect(invalido.body.detalhes.campos[0].campo).toBe('dominios.0');
      await cliente
        .post('/api/v1/webchat/canais', {
          nome: 'X',
          filaPadraoId: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
        })
        .expect(400);
      const membro = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'COMERCIAL' }),
      );
      await membro.get('/api/v1/webchat/canais').expect(403);
    });

    it('exclui: o widget passa a responder 404', async () => {
      const canal = await criarCanalPelaApi();
      await (
        await admin()
      )
        .delete(`/api/v1/webchat/canais/${canal.id}`)
        .expect(204);
      await publico('get', `/${canal.chavePublica}/configuracao`).expect(404);
    });
  });

  describe('widget e rotas públicas', () => {
    it('serve o widget.js (< 40 KB) com cache e ETag', async () => {
      const resposta = await request(t.servidor)
        .get(`${PUBLICO}/widget.js`)
        .expect(200);
      expect(resposta.headers['content-type']).toMatch(
        /application\/javascript/,
      );
      expect(resposta.headers['cross-origin-resource-policy']).toBe(
        'cross-origin',
      );
      expect(Buffer.byteLength(resposta.text)).toBeLessThan(
        TAMANHO_MAXIMO_DO_WIDGET,
      );
      expect(resposta.text).toContain('CrmBrlChat');
      expect(resposta.text).not.toContain('sourceMappingURL');
      // Roda como script de página (sem `exports`/`require`): o preâmbulo
      // CommonJS do build não pode quebrar no navegador.
      const avisos: unknown[] = [];
      expect(() =>
        runInNewContext(resposta.text, {
          window: {},
          document: { currentScript: null },
          console: { warn: (...args: unknown[]) => avisos.push(args) },
        }),
      ).not.toThrow();
      const semChave = {
        window: {} as Record<string, unknown>,
        document: {
          currentScript: { dataset: {}, src: 'https://crm.test/w.js' },
        },
        console: { warn: (...args: unknown[]) => avisos.push(args) },
      };
      runInNewContext(resposta.text, semChave);
      expect(avisos).toEqual([
        ['[CRM BRL] Chat do site: falta o atributo data-chave.'],
      ]);
      await request(t.servidor)
        .get(`${PUBLICO}/widget.js`)
        .set('If-None-Match', resposta.headers.etag)
        .expect(304);
    });

    it('configuração: CORS só para os domínios do canal (e o próprio CRM); horário e anexos', async () => {
      const canal = await criarCanalPelaApi({
        horarioAtendimento: {
          fusoHorario: 'America/Sao_Paulo',
          dias: { '0': [{ inicio: '00:00', fim: '00:01' }] },
        },
        mensagemForaHorario: 'Voltamos amanhã às 8h.',
      });
      const resposta = await publico(
        'get',
        `/${canal.chavePublica}/configuracao`,
      ).expect(200);
      expect(resposta.headers['access-control-allow-origin']).toBe(SITE);
      expect(
        resposta.headers['access-control-allow-credentials'],
      ).toBeUndefined();
      expect(resposta.body).toMatchObject({
        nome: 'Site da loja',
        contato: 'EMAIL_OU_TELEFONE',
        permitirAnexos: true,
        mensagemForaHorario: 'Voltamos amanhã às 8h.',
        limites: {
          tamanhoMaximoTexto: 4000,
          tamanhoMaximoAnexo: 10 * 1024 * 1024,
        },
      });
      expect(typeof resposta.body.horario.aberto).toBe('boolean');

      await publico(
        'get',
        `/${canal.chavePublica}/configuracao`,
        ORIGEM_DE_TESTE,
      )
        .expect(200)
        .expect('access-control-allow-origin', ORIGEM_DE_TESTE);
      await publico('get', `/${canal.chavePublica}/configuracao`, null).expect(
        200,
      );
      const recusada = await publico(
        'get',
        `/${canal.chavePublica}/configuracao`,
        'https://golpe.example.com',
      ).expect(403);
      expect(recusada.headers['access-control-allow-origin']).toBeUndefined();
      await publico('get', '/wc_naoexiste123/configuracao').expect(404);

      await t.prisma.canal.update({
        where: { id: canal.id },
        data: { ativo: false },
      });
      await publico('get', `/${canal.chavePublica}/configuracao`).expect(404);
    });

    it('limite de requisições por IP (429 com Retry-After)', async () => {
      const canal = await criarCanalPelaApi();
      for (let i = 0; i < 120; i++) {
        await publico('get', `/${canal.chavePublica}/configuracao`).expect(200);
      }
      const limitada = await publico(
        'get',
        `/${canal.chavePublica}/configuracao`,
      ).expect(429);
      expect(Number(limitada.headers['retry-after'])).toBeGreaterThan(0);
      expect(limitada.body.erro).toBe('muitas_tentativas');
    });
  });

  describe('visitante', () => {
    it('cenário 28 — formulário: exige consentimento e o meio de contato do canal', async () => {
      const canal = await criarCanalPelaApi({ contato: 'TELEFONE' });
      const sem = await publico('post', `/${canal.chavePublica}/visitantes`)
        .type('form')
        .send({ nome: 'Ana', telefone: '11988887777' })
        .expect(400);
      expect(sem.body.detalhes.campos[0].campo).toBe('consentimento');
      await publico('post', `/${canal.chavePublica}/visitantes`)
        .type('form')
        .send({ nome: 'Ana', email: 'ana@x.com', consentimento: 'true' })
        .expect(400)
        .expect(({ body }) => expect(body.mensagem).toMatch(/telefone/));
      await publico('post', `/${canal.chavePublica}/visitantes`)
        .type('form')
        .send({
          nome: 'Ana',
          telefone: '(20) 98888-7777',
          consentimento: 'true',
        })
        .expect(400);
      await publico(
        'post',
        `/${canal.chavePublica}/visitantes`,
        'https://outro.site',
      )
        .type('form')
        .send({ nome: 'Ana', telefone: '11988887777', consentimento: 'true' })
        .expect(403);
    });

    it('R4.2/R4.6 — cria o contato com consentimento, UTMs e o identificador; reconverte quem já existe', async () => {
      const canal = await criarCanalPelaApi();
      const { visitanteId, token } = await novoVisitante(canal.chavePublica);
      expect(token.length).toBeGreaterThanOrEqual(40);
      const visitante = await t.prisma.webchatVisitante.findUniqueOrThrow({
        where: { id: visitanteId },
        include: { contato: { include: { identificadores: true } } },
      });
      expect(visitante.tokenHash).not.toBe(token);
      expect(visitante.consentimentoEm).toBeInstanceOf(Date);
      expect(visitante.pagina).toBe(
        `${SITE}/planos?utm_source=google&utm_campaign=outubro`,
      );
      expect(visitante.contato).toMatchObject({
        nome: 'Maria Visitante',
        email: 'maria@cliente.com',
        primeiraOrigem: 'SITE',
        consentimentoOrigem: 'Chat do site — Site da loja',
        primeiraOrigemUtm: { source: 'google', campaign: 'outubro' },
      });
      expect(visitante.contato?.consentimentoEm).toBeInstanceOf(Date);
      expect(visitante.contato?.identificadores).toEqual([
        expect.objectContaining({
          tipo: 'WEBCHAT',
          valor: visitanteId,
          canalId: canal.id,
        }),
      ]);

      const existente = await criarContato(t, {
        email: 'joao@cliente.com',
        nome: 'João',
      });
      const segundo = await novoVisitante(canal.chavePublica, {
        nome: 'Joãozinho',
        email: 'JOAO@cliente.com',
      });
      const ligado = await t.prisma.webchatVisitante.findUniqueOrThrow({
        where: { id: segundo.visitanteId },
      });
      expect(ligado.contatoId).toBe(existente.id);
      expect(await t.prisma.contato.count()).toBe(2);
    });

    it('mensagens: entram no Atendimento, idempotentes pelo idCliente; token inválido 401', async () => {
      const canal = await criarCanalPelaApi();
      const { token, visitanteId } = await novoVisitante(canal.chavePublica);
      const primeira = await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({
          token,
          texto: 'Oi! Quero saber dos planos.',
          idCliente: 'cliente-0001',
        })
        .expect(201);
      expect(primeira.headers['access-control-allow-origin']).toBe(SITE);
      expect(primeira.body.mensagem).toMatchObject({
        de: 'visitante',
        tipo: 'TEXTO',
        texto: 'Oi! Quero saber dos planos.',
        idCliente: 'cliente-0001',
        arquivo: null,
      });
      const repetida = await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({
          token,
          texto: 'Oi! Quero saber dos planos.',
          idCliente: 'cliente-0001',
        })
        .expect(201);
      expect(repetida.body.mensagem.id).toBe(primeira.body.mensagem.id);

      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { canalId: canal.id },
        include: { mensagens: true },
      });
      expect(conversa).toMatchObject({
        status: 'ABERTA',
        naoLidas: 1,
        idExterno: visitanteId,
      });
      expect(conversa.mensagens).toHaveLength(1);
      expect(conversa.mensagens[0]).toMatchObject({
        direcao: 'ENTRADA',
        idExterno: `wc:${visitanteId}:cliente-0001`,
      });
      expect(
        (
          await t.prisma.webchatVisitante.findUniqueOrThrow({
            where: { id: visitanteId },
          })
        ).conversaId,
      ).toBe(conversa.id);

      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token: 'x'.repeat(43), texto: 'Oi' })
        .expect(401);
      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token, texto: '   ' })
        .expect(400);

      // Encerrar: o token deixa de valer.
      await publico('post', `/${canal.chavePublica}/sair`)
        .type('form')
        .send({ token })
        .expect(204);
      await publico('post', `/${canal.chavePublica}/sessao`)
        .type('form')
        .send({ token })
        .expect(401);
    });

    it('limite de mensagens por visitante', async () => {
      const canal = await criarCanalPelaApi();
      const { token } = await novoVisitante(canal.chavePublica);
      for (let i = 0; i < 20; i++) {
        await publico('post', `/${canal.chavePublica}/mensagens`)
          .type('form')
          .send({ token, texto: `Mensagem ${i}` })
          .expect(201);
      }
      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token, texto: 'Mais uma' })
        .expect(429);
    });

    it('cenário 28 — sessão: só a conversa do visitante e só desde quando ele entrou (outro navegador com o mesmo e-mail não lê o passado)', async () => {
      const canal = await criarCanalPelaApi();
      const primeiro = await novoVisitante(canal.chavePublica);
      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token: primeiro.token, texto: 'Meu CPF é 123' })
        .expect(201);
      const sessao = await publico('post', `/${canal.chavePublica}/sessao`)
        .type('form')
        .send({ token: primeiro.token })
        .expect(200);
      expect(sessao.body).toMatchObject({
        visitanteId: primeiro.visitanteId,
        conversa: { status: 'ABERTA' },
        haMais: false,
      });
      expect(
        sessao.body.mensagens.map((m: { texto: string }) => m.texto),
      ).toEqual(['Meu CPF é 123']);

      const intruso = await novoVisitante(canal.chavePublica);
      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token: intruso.token, texto: 'Olá' })
        .expect(201);
      const visto = await publico('post', `/${canal.chavePublica}/sessao`)
        .type('form')
        .send({ token: intruso.token })
        .expect(200);
      expect(
        visto.body.mensagens.map((m: { texto: string }) => m.texto),
      ).toEqual(['Olá']);

      // R12: os dois caem na mesma conversa aberta do contato, mas nenhum lê
      // o que o outro escreve dali em diante, e a equipe responde a quem
      // escreveu por último.
      const conversas = await t.prisma.conversa.findMany();
      expect(conversas).toHaveLength(1);
      const [conversa] = conversas;
      const registrado = await t.prisma.canal.findUniqueOrThrow({
        where: { id: canal.id },
      });
      const responder = async (texto: string) => {
        const mensagem = await t.prisma.mensagem.create({
          data: {
            conversaId: conversa.id,
            canalId: canal.id,
            direcao: 'SAIDA',
            texto,
            status: 'PENDENTE',
          },
        });
        const { idExterno } = await t
          .get(AdaptadorWebchat)
          .enviar(mensagem, conversa, registrado);
        await t.prisma.mensagem.update({
          where: { id: mensagem.id },
          data: { idExterno, status: 'ENVIADA', enviadaEm: new Date() },
        });
      };
      const textos = async (token: string) =>
        (
          await publico('post', `/${canal.chavePublica}/sessao`)
            .type('form')
            .send({ token })
            .expect(200)
        ).body.mensagens.map((m: { texto: string }) => m.texto);

      await responder('Resposta para quem disse Olá');
      await publico('post', `/${canal.chavePublica}/mensagens`)
        .type('form')
        .send({ token: primeiro.token, texto: 'Meu endereço é Rua X' })
        .expect(201);
      await responder('Resposta para a Maria de verdade');
      expect(await textos(intruso.token)).toEqual([
        'Olá',
        'Resposta para quem disse Olá',
      ]);
      expect(await textos(primeiro.token)).toEqual([
        'Meu CPF é 123',
        'Meu endereço é Rua X',
        'Resposta para a Maria de verdade',
      ]);
    });

    it('anexos: token antes do arquivo, link assinado para baixar, política de tipos (R11)', async () => {
      const canal = await criarCanalPelaApi();
      const { token, visitanteId } = await novoVisitante(canal.chavePublica);
      const resposta = await publico('post', `/${canal.chavePublica}/anexos`)
        .field('token', token)
        .field('idCliente', 'anexo-000001')
        .attach('arquivo', PNG_DE_TESTE, {
          filename: 'comprovante.png',
          contentType: 'image/png',
        });
      expect(resposta.status).toBe(201);
      const mensagem = resposta.body.mensagem;
      expect(mensagem).toMatchObject({
        de: 'visitante',
        tipo: 'IMAGEM',
        arquivo: {
          nome: 'comprovante.png',
          mime: 'image/png',
          tamanho: PNG_DE_TESTE.length,
        },
      });
      expect(mensagem.arquivo.url).toMatch(
        new RegExp(
          `^${PUBLICO}/${canal.chavePublica}/arquivos/[0-9a-f-]{36}\\?v=${visitanteId}&e=\\d+&a=[0-9a-f]{64}$`,
        ),
      );
      const arquivo = await t.prisma.arquivo.findFirstOrThrow();
      expect(arquivo).toMatchObject({
        contexto: 'MENSAGEM',
        criadoPorId: null,
      });

      const baixado = await publico(
        'get',
        mensagem.arquivo.url.replace(PUBLICO, ''),
      )
        .buffer(true)
        .parse((res, callback) => {
          const partes: Buffer[] = [];
          res.on('data', (parte: Buffer) => partes.push(parte));
          res.on('end', () => callback(null, Buffer.concat(partes)));
        })
        .expect(200);
      expect(Buffer.compare(baixado.body as Buffer, PNG_DE_TESTE)).toBe(0);
      expect(baixado.headers['x-content-type-options']).toBe('nosniff');
      expect(baixado.headers['cross-origin-resource-policy']).toBe(
        'cross-origin',
      );
      const adulterado = mensagem.arquivo.url.replace(
        /a=[0-9a-f]{4}/,
        'a=0000',
      );
      await publico('get', adulterado.replace(PUBLICO, '')).expect(404);

      // Token depois do arquivo: recusa antes de guardar.
      const antes = t.arquivos.quantidade;
      await publico('post', `/${canal.chavePublica}/anexos`)
        .attach('arquivo', PNG_DE_TESTE, {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .field('token', token)
        .expect(400);
      expect(t.arquivos.quantidade).toBe(antes);
      await publico('post', `/${canal.chavePublica}/anexos`)
        .field('token', token)
        .attach(
          'arquivo',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          {
            filename: 'x.svg',
            contentType: 'image/svg+xml',
          },
        )
        .expect(415);

      await (
        await admin()
      )
        .patch(`/api/v1/webchat/canais/${canal.id}`, { permitirAnexos: false })
        .expect(200);
      await publico('post', `/${canal.chavePublica}/anexos`)
        .field('token', token)
        .attach('arquivo', PNG_DE_TESTE, {
          filename: 'y.png',
          contentType: 'image/png',
        })
        .expect(403);
    });
  });

  describe('tempo real (/webchat) e envio da equipe', () => {
    async function preparar(): Promise<{
      canal: Canal;
      chave: string;
      token: string;
      visitanteId: string;
      conversaId: string;
    }> {
      const criado = await criarCanalPelaApi();
      const { token, visitanteId } = await novoVisitante(criado.chavePublica);
      await publico('post', `/${criado.chavePublica}/mensagens`)
        .type('form')
        .send({ token, texto: 'Oi' })
        .expect(201);
      const canal = await t.prisma.canal.findUniqueOrThrow({
        where: { id: criado.id },
      });
      const conversa = await t.prisma.conversa.findFirstOrThrow({
        where: { canalId: canal.id },
      });
      return {
        canal,
        chave: criado.chavePublica,
        token,
        visitanteId,
        conversaId: conversa.id,
      };
    }

    it('handshake recusa token inválido, origem de fora e chave inexistente', async () => {
      const base = await t.escutar();
      const { chave, token } = await preparar();
      expect(await conectarVisitante(base, chave, 'y'.repeat(43))).toEqual({
        erro: 'nao_autenticado',
      });
      expect(
        await conectarVisitante(base, chave, token, 'https://golpe.com'),
      ).toEqual({
        erro: 'origem_nao_permitida',
      });
      expect(await conectarVisitante(base, 'wc_semcanal000', token)).toEqual({
        erro: 'nao_encontrado',
      });
    });

    it('a mensagem da equipe chega ao visitante; a confirmação vira ENTREGUE e o "lido", LIDA', async () => {
      const base = await t.escutar();
      const { canal, chave, token, conversaId, visitanteId } = await preparar();
      const conectado = await conectarVisitante(base, chave, token);
      if (!('socket' in conectado)) {
        throw new Error(conectado.erro);
      }
      const atendente = await criarUsuario(t, {
        papel: 'COMERCIAL',
        nome: 'Ana Paula Souza',
      });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const mensagem = await t.prisma.mensagem.create({
        data: {
          conversaId,
          canalId: canal.id,
          direcao: 'SAIDA',
          tipo: 'TEXTO',
          texto: 'Olá, Maria! Posso ajudar.',
          autorId: atendente.id,
          autorTipo: 'USUARIO',
          status: 'PENDENTE',
        },
      });
      const chegou = new Promise<Record<string, unknown>>((resolver) => {
        conectado.socket.once(
          'mensagem',
          (dados: Record<string, unknown>, ack?: (r: unknown) => void) => {
            ack?.({ ok: true });
            resolver(dados);
          },
        );
      });
      const resultado = await t
        .get(AdaptadorWebchat)
        .enviar(mensagem, conversa, canal);
      expect(resultado).toEqual({
        idExterno: mensagem.id,
        enviadaEm: expect.any(Date),
      });
      // O Atendimento grava o id externo e ENVIADA logo depois do envio.
      await t.prisma.mensagem.update({
        where: { id: mensagem.id },
        data: {
          idExterno: resultado.idExterno,
          status: 'ENVIADA',
          enviadaEm: new Date(),
        },
      });
      expect(await chegou).toMatchObject({
        id: mensagem.id,
        de: 'equipe',
        texto: 'Olá, Maria! Posso ajudar.',
        autor: { nome: 'Ana' },
      });
      await esperarStatus(mensagem.id, 'ENTREGUE');

      const resposta = await new Promise<unknown>((resolver) =>
        conectado.socket.emit('lido', {}, resolver),
      );
      expect(resposta).toEqual({ ok: true });
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status,
      ).toBe('LIDA');

      // Na sessão, a mensagem da equipe aparece (já enviada).
      const sessao = await publico('post', `/${chave}/sessao`)
        .type('form')
        .send({ token })
        .expect(200);
      expect(sessao.body.mensagens.map((m: { de: string }) => m.de)).toEqual([
        'visitante',
        'equipe',
      ]);
      expect(visitanteId).toBeDefined();
    });

    it('fluxo real: a equipe responde pela API; o widget com o painel aberto confirma e a mensagem vira LIDA', async () => {
      const base = await t.escutar();
      const { chave, token, conversaId } = await preparar();
      const conectado = await conectarVisitante(base, chave, token);
      if (!('socket' in conectado)) {
        throw new Error(conectado.erro);
      }
      const chegou = new Promise<Record<string, unknown>>((resolver) => {
        conectado.socket.once(
          'mensagem',
          (dados: Record<string, unknown>, ack?: (r: unknown) => void) => {
            // Como o widget: confirma na hora, com a mensagem na tela.
            ack?.({ ok: true, vista: true });
            resolver(dados);
          },
        );
      });
      const atendente = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'ADMIN', nome: 'Carla Dias' }),
      );
      const enviada = await atendente
        .post(`/api/v1/atendimento/conversas/${conversaId}/mensagens`, {
          texto: 'Oi! Em que posso ajudar?',
        })
        .expect(201);
      const mensagemId = (enviada.body as { id: string }).id;
      // O envio do Atendimento: o adaptador entrega antes de o status virar ENVIADA.
      await drenarFilas(t, FILA_ENVIO_ATENDIMENTO);
      expect(await chegou).toMatchObject({
        id: mensagemId,
        de: 'equipe',
        autor: { nome: 'Carla' },
      });
      await esperarStatus(mensagemId, 'LIDA');
      const gravada = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: mensagemId },
      });
      expect(gravada.entregueEm).not.toBeNull();
      expect(gravada.lidaEm).not.toBeNull();
    });

    it('sem visitante ligado, o envio falha de vez', async () => {
      const { canal, conversaId } = await preparar();
      await t.prisma.webchatVisitante.deleteMany();
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const mensagem = await t.prisma.mensagem.create({
        data: {
          conversaId,
          canalId: canal.id,
          direcao: 'SAIDA',
          texto: 'Oi',
          status: 'PENDENTE',
        },
      });
      await expect(
        t.get(AdaptadorWebchat).enviar(mensagem, conversa, canal),
      ).rejects.toMatchObject({
        name: 'FalhaDefinitivaDeEnvio',
        codigo: 'visitante_ausente',
      });
    });

    it('"digitando" vai do visitante para a conversa e da equipe para o visitante', async () => {
      const base = await t.escutar();
      const { chave, token, conversaId } = await preparar();
      const conectado = await conectarVisitante(base, chave, token);
      if (!('socket' in conectado)) {
        throw new Error(conectado.erro);
      }
      const atendente = await criarUsuario(t, {
        papel: 'ADMIN',
        nome: 'Bruno Lima',
      });
      const equipe = await conectarTempoReal(t, await entrarComo(t, atendente));
      sockets.push(equipe);
      expect(
        await pedirAoTempoReal(equipe, 'conversa.entrar', { conversaId }),
      ).toEqual({ ok: true });

      const doContato = esperarEvento(equipe, 'digitando');
      conectado.socket.emit('digitando', { ativo: true });
      expect(await doContato).toEqual({
        conversaId,
        ativo: true,
        contato: true,
      });

      const daEquipe = new Promise((resolver) =>
        conectado.socket.once('digitando', resolver),
      );
      equipe.emit('digitando', { conversaId, ativo: true });
      expect(await daEquipe).toEqual({ ativo: true, nome: 'Bruno' });
    });

    it('o protocolo do widget (Engine.IO 4 por WebSocket puro) conecta, recebe e confirma', async () => {
      const base = await t.escutar();
      const { canal, chave, token, conversaId } = await preparar();
      const WebSocketDoNode = (
        globalThis as unknown as {
          WebSocket: new (url: string, opcoes?: unknown) => WebSocket;
        }
      ).WebSocket;
      const ws = new WebSocketDoNode(
        `${base.replace(/^http/, 'ws')}/api/socket.io/?EIO=4&transport=websocket`,
        { headers: { Origin: SITE } },
      );
      const recebidos: string[] = [];
      const conectado = new Promise<void>((resolver, rejeitar) => {
        ws.onmessage = (evento: MessageEvent) => {
          const pacote = String(evento.data);
          recebidos.push(pacote);
          if (pacote.startsWith('0')) {
            ws.send(`40/webchat,${JSON.stringify({ chave, token })}`);
          } else if (pacote.startsWith('40/webchat,')) {
            resolver();
          } else if (pacote.startsWith('44/webchat,')) {
            rejeitar(new Error(pacote));
          } else if (pacote.startsWith('42/webchat,')) {
            const id = /^42\/webchat,(\d+)\[/.exec(pacote)?.[1];
            if (id) {
              ws.send(`43/webchat,${id}[{"ok":true}]`);
            }
          }
        };
      });
      await conectado;
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: conversaId },
      });
      const mensagem = await t.prisma.mensagem.create({
        data: {
          conversaId,
          canalId: canal.id,
          direcao: 'SAIDA',
          texto: 'Pelo widget',
          status: 'PENDENTE',
        },
      });
      await t.get(AdaptadorWebchat).enviar(mensagem, conversa, canal);
      await t.prisma.mensagem.update({
        where: { id: mensagem.id },
        data: { idExterno: mensagem.id, status: 'ENVIADA' },
      });
      await esperarStatus(mensagem.id, 'ENTREGUE');
      const evento = recebidos.find((pacote) =>
        pacote.startsWith('42/webchat,'),
      );
      expect(evento).toMatch(
        /^42\/webchat,\d+\["mensagem",\{.*"texto":"Pelo widget"/,
      );
      ws.close();
    });
  });

  async function esperarStatus(
    mensagemId: string,
    status: string,
  ): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const atual = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: mensagemId },
      });
      if (atual.status === status) {
        return;
      }
      await new Promise((resolver) => setTimeout(resolver, 100));
    }
    throw new Error(`A mensagem não chegou a ${status}.`);
  }
});
