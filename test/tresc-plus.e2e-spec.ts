import {
  createServer,
  type IncomingMessage,
  type Server as ServidorHttp,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server as ServidorSocketIo } from 'socket.io';
import type { Usuario } from '../src/generated/prisma/client';
import { OuvinteDeEventosTrescPlus } from '../src/tresc-plus/ouvinte-eventos.service';
import { FILA_BAIXAR_GRAVACAO } from '../src/tresc-plus/tresc-plus.constantes';
import {
  type AudioConvertido,
  ProcessadorDeAudio,
} from '../src/transcricao/processador-de-audio';
import {
  type AppTeste,
  type ClienteHttp,
  conectarTempoReal,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  drenarTudo,
  entrarComo,
  esperarEvento,
  fecharSockets,
  type SocketDeTeste,
} from './utils';

const BASE = '/api/v1/tresc-plus';
const TOKEN_GESTOR = 'token-do-gestor-3c-abcd1234';
const SENHA_3C = 'senha-secreta-do-3c-9876';

// ---------------------------------------------------------------------------
// 3C+ falso dentro do teste: HTTP (fetch da API) + socket.io (ouvinte da API)
// ---------------------------------------------------------------------------

interface Agente3c {
  id: number;
  nome: string;
  email: string;
  ramal: string;
  token: string;
}
const AGENTES: Agente3c[] = [
  {
    id: 101,
    nome: 'Ana 3C',
    email: 'ana@3c.teste',
    ramal: '1001',
    token: 'token-agente-101-wxyz',
  },
  {
    id: 102,
    nome: 'Bia 3C',
    email: 'bia@3c.teste',
    ramal: '1002',
    token: 'token-agente-102-qrst',
  },
];
const QUALIFICACOES = [
  {
    id: 1,
    name: 'Interessado',
    color: '#2e7d32',
    conversion: true,
    allow_schedule: false,
  },
  {
    id: 2,
    name: 'Retornar depois',
    color: '#f9a825',
    conversion: false,
    allow_schedule: true,
  },
];

interface Pedido3c {
  metodo: string;
  caminho: string;
  autorizacao: string | null;
  corpo: unknown;
  query: Record<string, string>;
}

async function subir3cFalso() {
  const pedidos: Pedido3c[] = [];
  const estado = {
    /** Respostas forçadas por `metodo caminho`: [status, corpo]. */
    forcar: new Map<string, [number, unknown]>(),
    historico: [] as Array<Record<string, unknown>>,
    listas: [] as Array<{ id: number; name: string }>,
    mailing: [] as Array<Record<string, unknown>>,
    gestorValido: true,
    gravacao: Buffer.from('RIFFfake-wav-do-3c'),
    chamadaSeq: 7000,
  };
  const lerCorpo = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolver) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        if ((req.headers['content-type'] ?? '').includes('json')) {
          resolver(texto ? (JSON.parse(texto) as unknown) : null);
        } else {
          resolver(Object.fromEntries(new URLSearchParams(texto)));
        }
      });
    });
  const servidor: ServidorHttp = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const corpo = await lerCorpo(req);
      const pedido: Pedido3c = {
        metodo: req.method ?? 'GET',
        caminho: url.pathname.replace('/api/v1', ''),
        autorizacao: (req.headers.authorization as string | undefined) ?? null,
        corpo,
        query: Object.fromEntries(url.searchParams),
      };
      pedidos.push(pedido);
      const responder = (
        status: number,
        dados?: unknown,
        tipo = 'application/json',
      ) => {
        res.writeHead(status, { 'content-type': tipo });
        res.end(
          dados === undefined
            ? ''
            : Buffer.isBuffer(dados)
              ? dados
              : JSON.stringify(dados),
        );
      };
      const forcada = estado.forcar.get(`${pedido.metodo} ${pedido.caminho}`);
      if (forcada) return responder(forcada[0], forcada[1]);
      const token = pedido.autorizacao?.replace('Bearer ', '') ?? '';
      const agente = AGENTES.find((a) => a.token === token);
      const gestor = token === TOKEN_GESTOR && estado.gestorValido;
      const c = pedido.corpo as Record<string, string> & unknown[];
      if (pedido.metodo === 'POST' && pedido.caminho === '/authenticate') {
        const a = AGENTES.find((x) => x.email === c.user || x.ramal === c.user);
        if (!a || c.password !== SENHA_3C)
          return responder(401, { message: 'Credenciais inválidas.' });
        return responder(200, {
          id: a.id,
          name: a.nome,
          email: a.email,
          extension: a.ramal,
          role: 'agent',
          api_token: a.token,
        });
      }
      if (!agente && !gestor)
        return responder(401, { message: 'Unauthenticated.' });
      if (pedido.caminho === '/me') {
        return responder(
          200,
          gestor
            ? { id: 100, name: 'Gestor 3C', role: 'manager' }
            : { id: agente?.id, name: agente?.nome, role: 'agent' },
        );
      }
      if (pedido.caminho === '/campaigns' && pedido.metodo === 'GET') {
        return responder(200, {
          data: [{ id: 1, name: 'Prospecção', paused: false }],
        });
      }
      if (pedido.caminho === '/campaigns/1' && pedido.metodo === 'GET') {
        return responder(200, {
          data: { id: 1, name: 'Prospecção', qualifications: QUALIFICACOES },
        });
      }
      if (pedido.caminho === '/campaigns/1/lists') {
        if (pedido.metodo === 'POST') {
          const lista = {
            id: 40 + estado.listas.length,
            name: (c as Record<string, string>).name,
          };
          estado.listas.push(lista);
          return responder(201, { data: lista });
        }
        return responder(200, { data: estado.listas });
      }
      const mailing = /^\/campaigns\/1\/lists\/(\d+)\/mailing\.json$/.exec(
        pedido.caminho,
      );
      if (mailing && pedido.metodo === 'POST') {
        const registros = c as unknown as Array<{
          phone: string;
          identifier: string;
        }>;
        const importados = registros.filter((r) => !r.phone.endsWith('0000'));
        const filtrados = registros.filter((r) => r.phone.endsWith('0000'));
        estado.mailing.push(...importados);
        return responder(200, {
          data: {
            total: registros.length,
            imported: {
              quantity: importados.length,
              numbers: importados.map((r) => r.phone),
            },
            filtered: {
              quantity: filtrados.length,
              details: filtrados.map((r) => ({
                phone: r.phone,
                reason: 'check_dnd',
              })),
            },
          },
        });
      }
      if (!agente && pedido.caminho.startsWith('/agent'))
        return responder(403, { message: 'Só agentes.' });
      if (pedido.caminho === '/agent/campaigns')
        return responder(200, { data: [{ id: 1, name: 'Prospecção' }] });
      if (pedido.caminho === '/agent/loggedCampaign')
        return responder(200, { data: { id: 1, name: 'Prospecção' } });
      if (pedido.caminho === '/agent/work_break_intervals')
        return responder(200, {
          data: [{ id: 2, name: 'Almoço', minutes: 60, color: '#00f' }],
        });
      if (
        pedido.metodo === 'POST' &&
        [
          '/agent/login',
          '/agent/logout',
          '/agent/manual_call/enter',
          '/agent/work_break/2/enter',
          '/agent/work_break/exit',
        ].includes(pedido.caminho)
      ) {
        return responder(204);
      }
      if (
        pedido.metodo === 'POST' &&
        pedido.caminho === '/agent/manual_call/dial'
      ) {
        estado.chamadaSeq += 1;
        return responder(200, {
          call: { id: String(estado.chamadaSeq), number: c.phone },
          agent: { name: agente?.nome },
        });
      }
      if (
        pedido.metodo === 'POST' &&
        /^\/agent\/call\/[^/]+\/(hangup|qualify)$/.test(pedido.caminho)
      )
        return responder(204);
      if (pedido.caminho === '/calls' && pedido.metodo === 'GET') {
        return responder(200, {
          data: estado.historico,
          meta: {
            pagination: { total: estado.historico.length, total_pages: 1 },
          },
        });
      }
      const gravacao = /^\/calls\/([^/]+)\/recording$/.exec(pedido.caminho);
      if (gravacao) return responder(200, estado.gravacao, 'audio/wav');
      return responder(404, { message: 'Rota não encontrada.' });
    })();
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const io = new ServidorSocketIo(servidor, {
    path: '/socket.io',
    transports: ['websocket'],
  });
  io.use((socket, proximo) => {
    const token = String(socket.handshake.query.token ?? '');
    if (token === TOKEN_GESTOR) return proximo();
    proximo(new Error('unauthorized'));
  });
  const porta = (servidor.address() as AddressInfo).port;
  return {
    pedidos,
    estado,
    io,
    url: `http://127.0.0.1:${porta}`,
    /** Emite um evento do 3C+ (formato `OBJETO`: o nome do evento e o objeto com `type`). */
    emitir: (tipo: string, dados: Record<string, unknown>) =>
      io.emit(tipo, { type: tipo, company: 1, ...dados }),
    fechar: async () => {
      await io.close();
      servidor.closeAllConnections();
    },
    vezes: (metodo: string, caminho: string) =>
      pedidos.filter((p) => p.metodo === metodo && p.caminho === caminho),
  };
}

class ProcessadorFalso extends ProcessadorDeAudio {
  async converter(entrada: string, pasta: string): Promise<AudioConvertido> {
    void (await readFile(entrada));
    const ogg = join(pasta, 'ouvir.ogg');
    const esquerdo = join(pasta, 'esquerdo.wav');
    await writeFile(ogg, Buffer.from('OggS-0123456789-abcdefghij-KLMNOP'));
    await writeFile(esquerdo, Buffer.from('RIFF-esquerdo'));
    return {
      duracaoSegundos: 42,
      canais: 1,
      ogg,
      esquerdo,
      direito: null,
      esquerdoSemFala: false,
      direitoSemFala: false,
    };
  }
}

async function subirWhisperFalso() {
  const servidor: ServidorHttp = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/health')
        return void res.writeHead(200).end('{"status":"ok"}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          language: 'portuguese',
          segments: [
            { start: 0, end: 3, text: ' Bom dia, aqui é da BRL, tudo bem?' },
          ],
        }),
      );
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
    fechar: () => new Promise<void>((ok) => servidor.close(() => ok())),
  };
}

/** JSON com bigint (os ids da auditoria). */
const json = (valor: unknown): string =>
  JSON.stringify(valor, (_chave, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

const esperar = async (
  condicao: () => Promise<boolean> | boolean,
  ms = 6000,
): Promise<void> => {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('A condição não aconteceu a tempo.');
};

describe('3C+ — ligações pelo discador (R34)', () => {
  let t: AppTeste;
  let falso: Awaited<ReturnType<typeof subir3cFalso>>;
  let whisper: Awaited<ReturnType<typeof subirWhisperFalso>>;
  let admin: Usuario;
  let lider: Usuario;
  let cLevel: Usuario;
  let ana: Usuario;
  let bia: Usuario;
  let clienteAdmin: ClienteHttp;
  let clienteAna: ClienteHttp;
  let clienteBia: ClienteHttp;
  let clienteLider: ClienteHttp;
  const sockets: SocketDeTeste[] = [];

  beforeAll(async () => {
    falso = await subir3cFalso();
    whisper = await subirWhisperFalso();
    t = await criarAppTeste({
      variaveis: {
        TRESC_PLUS_OUVINTE: 'true',
        TRANSCRICAO_URL: whisper.url,
        WHISPER_MODELO: 'base',
      },
      ajustar: (b) =>
        b.overrideProvider(ProcessadorDeAudio).useValue(new ProcessadorFalso()),
    });
  });
  afterAll(async () => {
    t.get(OuvinteDeEventosTrescPlus).parar();
    await t.fechar();
    await falso.fechar();
    await whisper.fechar();
  });

  beforeEach(async () => {
    t.get(OuvinteDeEventosTrescPlus).parar();
    await t.limparBanco();
    falso.pedidos.length = 0;
    falso.estado.forcar.clear();
    falso.estado.historico = [];
    falso.estado.listas = [];
    falso.estado.mailing = [];
    falso.estado.gestorValido = true;
    admin = await criarUsuario(t, { papel: 'ADMIN' });
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    cLevel = equipe.cLevel;
    lider = equipe.lider;
    [ana, bia] = equipe.membros;
    clienteAdmin = await entrarComo(t, admin);
    clienteAna = await entrarComo(t, ana);
    clienteBia = await entrarComo(t, bia);
    clienteLider = await entrarComo(t, lider);
  });
  afterEach(() => fecharSockets(...sockets.splice(0)));

  /** Admin liga a integração apontando para o 3C+ falso e espera o ouvinte conectar. */
  async function ativarIntegracao(extra: Record<string, unknown> = {}) {
    const resposta = await clienteAdmin
      .patch(`${BASE}/conexao`, {
        ativa: true,
        urlApi: `${falso.url}/api/v1`,
        urlSocket: falso.url,
        token: TOKEN_GESTOR,
        campanhaPadraoId: 1,
        campanhaPadraoNome: 'Prospecção',
        ...extra,
      })
      .expect(200);
    await esperar(
      async () =>
        (await t.prisma.trescPlusConfig.findUniqueOrThrow({ where: { id: 1 } }))
          .ouvinteEstado === 'conectado',
    );
    return resposta.body as Record<string, unknown>;
  }

  function vincular(cliente: ClienteHttp, agente: Agente3c) {
    return cliente.post(`${BASE}/vinculo`, {
      usuario: agente.email,
      senha: SENHA_3C,
    });
  }

  async function prepararVendedora() {
    await ativarIntegracao();
    await vincular(clienteAna, AGENTES[0]).expect(201);
    const contato = await criarContato(t, {
      nome: 'Maria da Silva',
      telefone: '5511987654321',
      responsavel: ana,
    });
    const negocio = await criarNegocio(t, {
      contato,
      responsavel: ana,
      titulo: 'Plano anual',
    });
    return { contato, negocio };
  }

  const ligacaoPorExterno = (id: string) =>
    t.prisma.ligacao.findFirstOrThrow({
      where: { provedor: 'TRESC_PLUS', idExterno: id },
    });

  /** Liga pelo CRM como a Ana e devolve a ligação. */
  async function ligarComoAna(negocioId: string) {
    const r = await clienteAna
      .post(`${BASE}/ligacoes`, { negocioId })
      .expect(201);
    return r.body as {
      id: string;
      idExterno: string;
      estado: string;
      negocioId: string;
      provedor: string;
    };
  }

  describe('R34.1 — conexão da empresa', () => {
    it('R34.1 — o token fica cifrado e nunca volta inteiro; só o Admin vê e altera', async () => {
      const corpo = await ativarIntegracao();
      expect(corpo).toMatchObject({
        ativa: true,
        tokenConfigurado: true,
        token: '••••1234',
        campanhaPadrao: { id: 1, nome: 'Prospecção' },
        urlApi: `${falso.url}/api/v1`,
      });
      expect(JSON.stringify(corpo)).not.toContain(TOKEN_GESTOR);
      const linha = await t.prisma.trescPlusConfig.findUniqueOrThrow({
        where: { id: 1 },
      });
      expect(linha.tokenCifrado).not.toBeNull();
      expect(linha.tokenCifrado).not.toContain(TOKEN_GESTOR);
      expect(JSON.stringify(linha)).not.toContain(TOKEN_GESTOR);
      const lido = await clienteAdmin.get(`${BASE}/conexao`).expect(200);
      expect(JSON.stringify(lido.body)).not.toContain(TOKEN_GESTOR);
      // Auditoria sem o token.
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'tresc-plus.conexao-atualizada' },
      });
      expect(auditoria.length).toBeGreaterThan(0);
      expect(json(auditoria)).not.toContain(TOKEN_GESTOR);
      // Só Admin.
      await clienteAna.get(`${BASE}/conexao`).expect(403);
      await clienteLider.patch(`${BASE}/conexao`, { ativa: false }).expect(403);
      await clienteAna.post(`${BASE}/conexao/testar`).expect(403);
    });

    it('R34.1 — validações: URL inválida (400), ativar sem token (422) e limpar o token desativa', async () => {
      await clienteAdmin
        .patch(`${BASE}/conexao`, { urlApi: 'não é url' })
        .expect(400);
      await clienteAdmin.patch(`${BASE}/conexao`, { ativa: true }).expect(422);
      await ativarIntegracao();
      const r = await clienteAdmin
        .patch(`${BASE}/conexao`, { limparToken: true })
        .expect(200);
      expect(r.body).toMatchObject({
        ativa: false,
        tokenConfigurado: false,
        token: null,
      });
    });

    it('R34.1 — testar conexão: sucesso (GET /me com o token do gestor) e token recusado em português', async () => {
      await ativarIntegracao();
      const ok = await clienteAdmin.post(`${BASE}/conexao/testar`).expect(200);
      expect(ok.body).toMatchObject({
        ok: true,
        usuario: { nome: 'Gestor 3C', papel: 'manager' },
      });
      expect(falso.vezes('GET', '/me').at(-1)?.autorizacao).toBe(
        `Bearer ${TOKEN_GESTOR}`,
      );
      falso.estado.gestorValido = false;
      const ruim = await clienteAdmin
        .post(`${BASE}/conexao/testar`)
        .expect(200);
      expect(ruim.body.ok).toBe(false);
      expect(ruim.body.mensagem).toMatch(/token/i);
      const lido = await clienteAdmin.get(`${BASE}/conexao`).expect(200);
      expect(lido.body.teste).toMatchObject({ ok: false });
    });

    it('R34.1 — lista as campanhas para o Admin, C-level e líder (token do gestor); membro não', async () => {
      await ativarIntegracao();
      const r = await clienteLider.get(`${BASE}/campanhas`).expect(200);
      expect(r.body).toEqual([{ id: 1, nome: 'Prospecção', pausada: false }]);
      await clienteAna.get(`${BASE}/campanhas`).expect(403);
    });
  });

  describe('R34.2 — vínculo do vendedor', () => {
    it('R34.2 — guarda só o token (cifrado), o ramal e o id; a senha nunca é guardada', async () => {
      await ativarIntegracao();
      const r = await vincular(clienteAna, AGENTES[0]).expect(201);
      expect(r.body).toMatchObject({
        vinculado: true,
        ramal: '1001',
        trescUsuarioId: 101,
        token: '••••wxyz',
      });
      expect(JSON.stringify(r.body)).not.toContain(AGENTES[0].token);
      const linha = await t.prisma.trescPlusVinculo.findUniqueOrThrow({
        where: { usuarioId: ana.id },
      });
      expect(linha.tokenCifrado).not.toContain(AGENTES[0].token);
      expect(JSON.stringify(linha)).not.toContain(SENHA_3C);
      // Nada no banco carrega a senha: auditoria, eventos de domínio e jobs.
      const auditoria = await t.prisma.eventoAuditoria.findMany();
      expect(json(auditoria)).not.toContain(SENHA_3C);
      expect(json(auditoria)).not.toContain(AGENTES[0].token);
      const dump = await t.prisma.$queryRawUnsafe<Array<{ t: string }>>(
        `SELECT (tresc_plus_vinculos::text) AS t FROM tresc_plus_vinculos`,
      );
      expect(JSON.stringify(dump)).not.toContain(SENHA_3C);
      // A senha foi só para o `POST /authenticate`, uma única vez, e o corpo não repete o token.
      const auth = falso.vezes('POST', '/authenticate');
      expect(auth).toHaveLength(1);
      expect(auth[0].autorizacao).toBeNull();
      const lido = await clienteAna.get(`${BASE}/vinculo`).expect(200);
      expect(lido.body).toMatchObject({ vinculado: true, ramal: '1001' });
      expect(JSON.stringify(lido.body)).not.toContain(AGENTES[0].token);
    });

    it('R34.2 — senha errada, integração inativa e usuário do 3C+ já ligado a outra pessoa', async () => {
      await clienteAna
        .post(`${BASE}/vinculo`, { usuario: AGENTES[0].email, senha: SENHA_3C })
        .expect(422);
      await ativarIntegracao();
      const errada = await clienteAna
        .post(`${BASE}/vinculo`, { usuario: AGENTES[0].email, senha: 'outra' })
        .expect(422);
      expect(errada.body.mensagem).toMatch(/usuário e a senha/);
      expect(JSON.stringify(errada.body)).not.toContain('outra');
      await vincular(clienteAna, AGENTES[0]).expect(201);
      const conflito = await vincular(clienteBia, AGENTES[0]).expect(409);
      expect(conflito.body.mensagem).toMatch(/outra pessoa/);
      // Refazer o próprio vínculo é permitido.
      await vincular(clienteAna, AGENTES[0]).expect(201);
      expect(await t.prisma.trescPlusVinculo.count()).toBe(1);
    });

    it('R34.2 — desconectar (o próprio) e o Admin desvincula; os outros não', async () => {
      await ativarIntegracao();
      await vincular(clienteAna, AGENTES[0]).expect(201);
      await vincular(clienteBia, AGENTES[1]).expect(201);
      const lista = await clienteAdmin.get(`${BASE}/vinculos`).expect(200);
      expect(lista.body).toHaveLength(2);
      await clienteAna.get(`${BASE}/vinculos`).expect(403);
      await clienteAna.delete(`${BASE}/vinculos/${bia.id}`).expect(403);
      await clienteAna.delete(`${BASE}/vinculo`).expect(204);
      await clienteAna.delete(`${BASE}/vinculo`).expect(404);
      await clienteAdmin.delete(`${BASE}/vinculos/${bia.id}`).expect(204);
      expect(await t.prisma.trescPlusVinculo.count()).toBe(0);
      const sem = await clienteAna.get(`${BASE}/vinculo`).expect(200);
      expect(sem.body).toEqual({ vinculado: false });
      // Sem vínculo, as rotas do agente pedem para conectar.
      const r = await clienteAna.post(`${BASE}/agente/entrar`, {}).expect(422);
      expect(r.body.mensagem).toMatch(/Conecte seu usuário ao 3C\+/);
    });
  });

  describe('R34.3 a R34.5 — ligar, eventos, qualificar e histórico', () => {
    it('R34.5 — liga (entra na campanha e no modo manual), registra no contato e no negócio, e a primeira interação', async () => {
      const { contato, negocio } = await prepararVendedora();
      const socket = await conectarTempoReal(t, clienteAna);
      sockets.push(socket);
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).primeiraInteracaoEm,
      ).toBeNull();
      const aoEstado = esperarEvento<{
        estado: string;
        campanhaId: number | null;
      }>(socket, 'tresc.ligacao');
      const ligacao = await ligarComoAna(negocio.id);
      expect(ligacao).toMatchObject({
        provedor: 'TRESC_PLUS',
        estado: 'CHAMANDO',
        negocioId: negocio.id,
        idExterno: '7001',
      });
      await aoEstado;
      // Entrou na campanha padrão, no modo manual, e discou com o token da Ana (número nacional, sem o 55).
      const login = falso.vezes('POST', '/agent/login');
      expect(login).toHaveLength(1);
      expect(login[0].autorizacao).toBe(`Bearer ${AGENTES[0].token}`);
      expect(login[0].corpo).toEqual({ campaign: '1', mode: 'manual' });
      expect(
        falso.vezes('POST', '/agent/manual_call/enter').length,
      ).toBeGreaterThan(0);
      const discagem = falso.vezes('POST', '/agent/manual_call/dial');
      expect(discagem).toHaveLength(1);
      expect(discagem[0].corpo).toEqual({ phone: '11987654321' });
      expect(discagem[0].autorizacao).toBe(`Bearer ${AGENTES[0].token}`);
      // Registro e primeira interação (R6.7).
      const linha = await ligacaoPorExterno('7001');
      expect(linha).toMatchObject({
        contatoId: contato.id,
        negocioId: negocio.id,
        atendenteId: ana.id,
        direcao: 'FEITA',
        canalId: null,
        campanhaId: 1,
        telefone: '5511987654321',
      });
      const gravado = await t.prisma.negocio.findUniqueOrThrow({
        where: { id: negocio.id },
      });
      expect(gravado).toMatchObject({
        primeiraInteracaoTipo: 'LIGACAO',
        primeiraInteracaoPorId: ana.id,
      });
      // Já em campanha e em modo manual: a segunda ligação não entra de novo.
      const estado = await clienteAna.get(`${BASE}/agente`).expect(200);
      expect(estado.body).toMatchObject({
        vinculado: true,
        estado: 'manual',
        campanha: { id: 1 },
        modo: 'manual',
      });
    });

    it('R34.4 — eventos de chamada e de agente atualizam a ligação, avisam o vendedor e geram a atividade', async () => {
      const { contato, negocio } = await prepararVendedora();
      const socket = await conectarTempoReal(t, clienteAna);
      sockets.push(socket);
      const ligacao = await ligarComoAna(negocio.id);
      const chamada = {
        id: ligacao.idExterno,
        phone: '11987654321',
        mode: 'manual',
        agent: { id: 101, name: 'Ana 3C' },
        campaign: { id: 1, name: 'Prospecção' },
      };
      const proximo = (estado: string) =>
        new Promise<Record<string, unknown>>((resolver) => {
          const ouvir = (c: Record<string, unknown>) => {
            if (c.estado === estado) {
              socket.off('tresc.ligacao', ouvir);
              resolver(c);
            }
          };
          socket.on('tresc.ligacao', ouvir);
        });

      const tocando = proximo('TOCANDO');
      falso.emitir('call-was-answered', { call: chamada });
      expect(await tocando).toMatchObject({
        ligacaoId: ligacao.id,
        estado: 'TOCANDO',
      });

      const emAndamento = proximo('EM_ANDAMENTO');
      falso.emitir('call-was-connected', { call: chamada });
      falso.emitir('call-was-connected', { call: chamada }); // duplicado: deduplicado
      const c = await emAndamento;
      expect(c.atendidaEm).not.toBeNull();
      await t.get(OuvinteDeEventosTrescPlus).aguardarFila();
      expect((await clienteAna.get(`${BASE}/agente`)).body.estado).toBe(
        'em_ligacao',
      );
      // Estados que só avançam: um `answered` atrasado não faz a ligação voltar.
      falso.emitir('call-was-answered', { call: chamada });
      await t.get(OuvinteDeEventosTrescPlus).aguardarFila();
      expect((await ligacaoPorExterno(ligacao.idExterno)).estado).toBe(
        'EM_ANDAMENTO',
      );

      const qualificar = esperarEvento<{
        ligacaoId: string;
        campanhaId: number;
      }>(socket, 'tresc.qualificar');
      const encerrada = proximo('ENCERRADA');
      falso.emitir('call-was-ended', { call: chamada });
      falso.emitir('call-was-finished', { call: chamada });
      await encerrada;
      expect(await qualificar).toEqual({
        ligacaoId: ligacao.id,
        campanhaId: 1,
      });
      falso.emitir('agent-in-acw', { agent: { id: 101, name: 'Ana 3C' } });
      await esperar(
        async () =>
          (await clienteAna.get(`${BASE}/agente`)).body.estado ===
          'pos_atendimento',
      );

      const final = await ligacaoPorExterno(ligacao.idExterno);
      expect(final.estado).toBe('ENCERRADA');
      expect(final.atividadeId).not.toBeNull();
      const atividade = await t.prisma.atividade.findUniqueOrThrow({
        where: { id: final.atividadeId ?? '' },
      });
      expect(atividade).toMatchObject({
        tipo: 'LIGACAO',
        status: 'CONCLUIDA',
        negocioId: negocio.id,
        contatoId: contato.id,
        concluidaPorId: ana.id,
      });
      // Deduplicação: cada evento de chamada ficou registrado uma vez.
      expect(
        await t.prisma.trescPlusEvento.count({
          where: { chave: `call-was-connected:${ligacao.idExterno}` },
        }),
      ).toBe(1);
      expect(
        await t.prisma.ligacao.count({ where: { provedor: 'TRESC_PLUS' } }),
      ).toBe(1);
      // Evento de domínio ligacao.encerrada (automações e webhooks) sem canal.
      const eventos = await t.prisma.eventoDominio.findMany({
        where: { tipo: 'ligacao.encerrada' },
      });
      expect(eventos).toHaveLength(1);
      expect(eventos[0].dados).toMatchObject({
        ligacaoId: ligacao.id,
        canalId: null,
        resultado: 'atendida',
        negocioId: negocio.id,
      });
    });

    it('R34.5 — lista as qualificações e qualifica (com observação); depois o histórico completa e baixa a gravação (R30)', async () => {
      const { negocio } = await prepararVendedora();
      const ligacao = await ligarComoAna(negocio.id);
      const chamada = {
        id: ligacao.idExterno,
        phone: '11987654321',
        mode: 'manual',
        agent: { id: 101, name: 'Ana 3C' },
        campaign: { id: 1, name: 'Prospecção' },
      };
      for (const tipo of [
        'call-was-answered',
        'call-was-connected',
        'call-was-ended',
        'call-was-finished',
      ])
        falso.emitir(tipo, { call: chamada });
      await esperar(
        async () =>
          (await ligacaoPorExterno(ligacao.idExterno)).estado === 'ENCERRADA',
      );

      const lista = await clienteAna
        .get(`${BASE}/ligacoes/${ligacao.id}/qualificacoes`)
        .expect(200);
      expect(lista.body).toEqual([
        {
          id: 1,
          nome: 'Interessado',
          cor: '#2e7d32',
          conversao: true,
          permiteAgendar: false,
        },
        {
          id: 2,
          nome: 'Retornar depois',
          cor: '#f9a825',
          conversao: false,
          permiteAgendar: true,
        },
      ]);
      // Só quem ligou qualifica; qualificação inexistente e agendamento sem permissão são recusados.
      await vincular(clienteBia, AGENTES[1]).expect(201);
      await clienteBia
        .post(`${BASE}/ligacoes/${ligacao.id}/qualificar`, {
          qualificacaoId: 1,
        })
        .expect(404);
      await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/qualificar`, {
          qualificacaoId: 99,
        })
        .expect(422);
      await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/qualificar`, {
          qualificacaoId: 1,
          agendarPara: '2026-12-01T13:00:00.000Z',
        })
        .expect(422);
      const q = await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/qualificar`, {
          qualificacaoId: 1,
          observacao: 'Pediu a proposta',
        })
        .expect(200);
      expect(q.body.qualificacao).toMatchObject({
        id: 1,
        nome: 'Interessado',
        observacao: 'Pediu a proposta',
        conversao: true,
      });
      const envio = falso
        .vezes('POST', `/agent/call/${ligacao.idExterno}/qualify`)
        .at(-1);
      expect(envio?.autorizacao).toBe(`Bearer ${AGENTES[0].token}`);
      expect(envio?.corpo).toEqual({
        qualification_id: '1',
        qualification_note: 'Pediu a proposta',
      });
      const atividade = await t.prisma.atividade.findFirstOrThrow({
        where: { tipo: 'LIGACAO', negocioId: negocio.id },
      });
      expect(atividade.descricao).toContain('Qualificação: Interessado.');
      // Agendar numa qualificação que permite: a data vai no formato do 3C+ (horário de Brasília).
      await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/qualificar`, {
          qualificacaoId: 2,
          agendarPara: '2026-12-01T13:00:00.000Z',
        })
        .expect(200);
      expect(
        falso.vezes('POST', `/agent/call/${ligacao.idExterno}/qualify`).at(-1)
          ?.corpo,
      ).toMatchObject({ qualification_id: '2', date: '2026-12-01 10:00:00' });

      // call-history-was-created: completa e baixa a gravação para o armazenamento.
      const registro = {
        id: ligacao.idExterno,
        number: '11987654321',
        agent: { id: 101, name: 'Ana 3C' },
        campaign: { id: 1, name: 'Prospecção' },
        call_date_rfc3339: new Date().toISOString(),
        speaking_time: 95,
        billed_time: 100,
        hangup_cause: 'NORMAL_CLEARING',
        qualification: { id: 1, name: 'Interessado', conversion: true },
        qualification_note: 'Pediu a proposta',
        recording: `${falso.url}/api/v1/calls/${ligacao.idExterno}/recording`,
      };
      falso.emitir('call-history-was-created', { call: registro });
      falso.emitir('call-history-was-created', { call: registro }); // duplicado
      await esperar(
        async () =>
          (await ligacaoPorExterno(ligacao.idExterno)).tempoFaladoSegundos ===
          95,
      );
      await t.get(OuvinteDeEventosTrescPlus).aguardarFila();
      const completa = await ligacaoPorExterno(ligacao.idExterno);
      expect(completa).toMatchObject({
        duracaoSegundos: 95,
        qualificacaoNome: 'Interessado',
        gravar: true,
        gravacaoSituacao: 'ENVIANDO',
        estado: 'ENCERRADA',
      });
      // Duas qualificações manuais + a do histórico (que mudou); o histórico repetido não audita de novo.
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: 'ligacao.qualificada',
            entidade: 'ligacao',
            entidadeId: ligacao.id,
          },
        }),
      ).toBe(3);
      expect(await drenarFilas(t, FILA_BAIXAR_GRAVACAO)).toBe(1);
      await drenarTudo(t);
      const baixada = await ligacaoPorExterno(ligacao.idExterno);
      expect(baixada.gravacaoOriginalArquivoId).not.toBeNull();
      expect(baixada).toMatchObject({
        gravacaoSituacao: 'PRONTA',
        transcricaoSituacao: 'PRONTA',
      });
      expect(
        falso.vezes('GET', `/calls/${ligacao.idExterno}/recording`),
      ).toHaveLength(1);
      expect(
        falso.vezes('GET', `/calls/${ligacao.idExterno}/recording`)[0]
          .autorizacao,
      ).toBe(`Bearer ${TOKEN_GESTOR}`);

      // Histórico (R29/R30): provedor, qualificação, gravação disponível e transcrição.
      const detalhe = await clienteAna
        .get(`/api/v1/ligacoes/${ligacao.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({
        provedor: 'TRESC_PLUS',
        canal: null,
        idExterno: ligacao.idExterno,
        negocioId: negocio.id,
        estado: 'ENCERRADA',
        duracaoSegundos: 95,
        qualificacao: { nome: 'Interessado' },
        campanha: { id: 1, nome: 'Prospecção', modo: 'manual' },
        gravacao: { disponivel: true, situacao: 'pronta' },
        transcricao: { situacao: 'pronta' },
      });
      const transcricao = await clienteAna
        .get(`/api/v1/ligacoes/${ligacao.id}/transcricao`)
        .expect(200);
      expect(transcricao.body.trechos[0].texto).toContain('Bom dia');
      await clienteAna.get(`/api/v1/ligacoes/${ligacao.id}/audio`).expect(200);
      const historico = await clienteAna
        .get('/api/v1/ligacoes')
        .query({ contatoId: completa.contatoId })
        .expect(200);
      expect(historico.body.itens.map((i: { id: string }) => i.id)).toEqual([
        ligacao.id,
      ]);
    });

    it('R34.3 — a ligação aparece na linha do tempo do contato e do negócio, com a visibilidade do R29', async () => {
      const { contato, negocio } = await prepararVendedora();
      const ligacao = await ligarComoAna(negocio.id);
      const chamada = {
        id: ligacao.idExterno,
        phone: '11987654321',
        mode: 'manual',
        agent: { id: 101 },
      };
      for (const tipo of ['call-was-connected', 'call-was-finished'])
        falso.emitir(tipo, { call: chamada });
      await esperar(
        async () =>
          (await ligacaoPorExterno(ligacao.idExterno)).estado === 'ENCERRADA',
      );
      const itens = async (cliente: ClienteHttp, rota: string) =>
        (await cliente.get(rota).query({ incluir: 'ligacoes' }).expect(200))
          .body.itens as Array<{
          tipo: string;
          ligacao: { id: string; provedor: string; negocioId: string } | null;
        }>;
      const doContato = await itens(
        clienteAna,
        `/api/v1/contatos/${contato.id}/linha-do-tempo`,
      );
      expect(doContato).toHaveLength(1);
      expect(doContato[0].ligacao).toMatchObject({
        id: ligacao.id,
        provedor: 'TRESC_PLUS',
        negocioId: negocio.id,
      });
      const doNegocio = await itens(
        clienteAna,
        `/api/v1/negocios/${negocio.id}/linha-do-tempo`,
      );
      expect(doNegocio.map((i) => i.ligacao?.id)).toEqual([ligacao.id]);
      // Visibilidade: a Ana (atendente), o líder dela (responsável do contato) e o C-level veem; a Bia não.
      await clienteAna.get(`/api/v1/ligacoes/${ligacao.id}`).expect(200);
      await clienteLider.get(`/api/v1/ligacoes/${ligacao.id}`).expect(200);
      await (
        await entrarComo(t, cLevel)
      )
        .get(`/api/v1/ligacoes/${ligacao.id}`)
        .expect(200);
      await clienteBia.get(`/api/v1/ligacoes/${ligacao.id}`).expect(404);
      const daBia = await clienteBia.get('/api/v1/ligacoes').expect(200);
      expect(daBia.body.itens).toHaveLength(0);
      const lider = await clienteLider.get('/api/v1/ligacoes').expect(200);
      expect(lider.body.itens).toHaveLength(1);
    });

    it('R34.5 — desligar manda o hangup com o token do vendedor; ligação já terminada é recusada', async () => {
      const { negocio } = await prepararVendedora();
      const ligacao = await ligarComoAna(negocio.id);
      await vincular(clienteBia, AGENTES[1]).expect(201);
      await vincular(clienteBia, AGENTES[1]).expect(201);
      await clienteBia
        .post(`${BASE}/ligacoes/${ligacao.id}/desligar`)
        .expect(404);
      await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/desligar`)
        .expect(200);
      const hangup = falso.vezes(
        'POST',
        `/agent/call/${ligacao.idExterno}/hangup`,
      );
      expect(hangup).toHaveLength(1);
      expect(hangup[0].autorizacao).toBe(`Bearer ${AGENTES[0].token}`);
      falso.emitir('call-was-not-answered', {
        call: {
          id: ligacao.idExterno,
          phone: '11987654321',
          agent: { id: 101 },
        },
      });
      await esperar(
        async () =>
          (await ligacaoPorExterno(ligacao.idExterno)).estado ===
          'SEM_RESPOSTA',
      );
      const de = await clienteAna
        .post(`${BASE}/ligacoes/${ligacao.id}/desligar`)
        .expect(422);
      expect(de.body.mensagem).toMatch(/já terminou/);
      // Não atendida: sem duração, a atividade fica registrada como tentativa.
      const linha = await ligacaoPorExterno(ligacao.idExterno);
      expect(linha.duracaoSegundos).toBe(0);
    });

    it('R34.3 — as rotas do WhatsApp (encerrar, atender, recusar, gravação) e a ligação ativa não tocam nas ligações do 3C+', async () => {
      const { negocio } = await prepararVendedora();
      const ligacao = await ligarComoAna(negocio.id);
      const encerrar = await clienteAna
        .post(`/api/v1/ligacoes/${ligacao.id}/encerrar`)
        .expect(422);
      expect(encerrar.body.mensagem).toMatch(/3C\+/);
      await clienteAna
        .post(`/api/v1/ligacoes/${ligacao.id}/atender`, { sdp: 'v=0' })
        .expect(422);
      await clienteAna
        .post(`/api/v1/ligacoes/${ligacao.id}/recusar`)
        .expect(422);
      await clienteAna
        .post(`/api/v1/ligacoes/${ligacao.id}/gravacao/finalizar`, {
          totalPartes: 0,
        })
        .expect(422);
      // O softphone do WhatsApp não enxerga a ligação do 3C+ como "em andamento".
      const ativas = await clienteAna
        .get('/api/v1/ligacoes/ativas')
        .expect(200);
      expect(ativas.body).toEqual({ emAndamento: null, tocando: [] });
      // Cair o socket do CRM não encerra a ligação do 3C+ (não há `terminate` da Meta).
      expect((await ligacaoPorExterno(ligacao.idExterno)).estado).toBe(
        'CHAMANDO',
      );
    });

    it('R34.5 — os erros do 3C+ viram mensagens claras em português (nunca 401)', async () => {
      const { negocio } = await prepararVendedora();
      falso.estado.forcar.set('POST /agent/manual_call/dial', [
        422,
        { message: 'The agent is not idle.' },
      ]);
      const naoOcioso = await clienteAna
        .post(`${BASE}/ligacoes`, { negocioId: negocio.id })
        .expect(422);
      expect(naoOcioso.body.mensagem).toMatch(/não está ocioso/);
      expect(await t.prisma.ligacao.count()).toBe(0);
      falso.estado.forcar.set('POST /agent/manual_call/dial', [
        401,
        { message: 'Unauthenticated.' },
      ]);
      const token = await clienteAna
        .post(`${BASE}/ligacoes`, { negocioId: negocio.id })
        .expect(422);
      expect(token.body.mensagem).toMatch(/token/i);
      falso.estado.forcar.set('POST /agent/manual_call/dial', [
        422,
        { message: 'The agent must be logged in a campaign.' },
      ]);
      const campanha = await clienteAna
        .post(`${BASE}/ligacoes`, { negocioId: negocio.id })
        .expect(422);
      expect(campanha.body.mensagem).toMatch(/campanha/);
      falso.estado.forcar.set('POST /agent/manual_call/dial', [503, {}]);
      const fora = await clienteAna
        .post(`${BASE}/ligacoes`, { negocioId: negocio.id })
        .expect(503);
      expect(fora.body.mensagem).toMatch(/indisponível/);
      // Sem telefone e sem destino.
      const semTelefone = await criarContato(t, {
        nome: 'Sem fone',
        email: 'semfone@teste.local',
      });
      const r = await clienteAna
        .post(`${BASE}/ligacoes`, { contatoId: semTelefone.id })
        .expect(422);
      expect(r.body.mensagem).toMatch(/não tem telefone/);
      await clienteAna.post(`${BASE}/ligacoes`, {}).expect(422);
    });

    it('R34.5 — entrar e sair da campanha, estado e pausas', async () => {
      await prepararVendedora();
      const campanhas = await clienteAna
        .get(`${BASE}/agente/campanhas`)
        .expect(200);
      expect(campanhas.body).toEqual([
        { id: 1, nome: 'Prospecção', pausada: null },
      ]);
      const socket = await conectarTempoReal(t, clienteAna);
      sockets.push(socket);
      const aviso = esperarEvento<{ estado: string }>(socket, 'tresc.agente');
      const entrou = await clienteAna
        .post(`${BASE}/agente/entrar`, { campanhaId: 1, modo: 'dialer' })
        .expect(200);
      expect(entrou.body).toMatchObject({
        estado: 'ocioso',
        campanha: { id: 1, nome: 'Prospecção' },
        modo: 'dialer',
      });
      expect(await aviso).toMatchObject({ estado: 'ocioso' });
      const pausas = await clienteAna.get(`${BASE}/agente/pausas`).expect(200);
      expect(pausas.body).toEqual([
        { id: 2, nome: 'Almoço', minutos: 60, cor: '#00f' },
      ]);
      const emPausa = await clienteAna
        .post(`${BASE}/agente/pausa`, { intervaloId: 2 })
        .expect(200);
      expect(emPausa.body).toMatchObject({
        estado: 'pausa',
        pausa: { id: 2, nome: 'Almoço' },
      });
      falso.emitir('agent-is-idle', { agent: { id: 101 } });
      await esperar(
        async () =>
          (await clienteAna.get(`${BASE}/agente`)).body.estado === 'ocioso',
      );
      await clienteAna.delete(`${BASE}/agente/pausa`).expect(200);
      const saiu = await clienteAna.post(`${BASE}/agente/sair`).expect(200);
      expect(saiu.body).toMatchObject({
        estado: 'desconectado',
        campanha: null,
      });
      falso.emitir('agent-entered-work-break', {
        agent: { id: 101 },
        work_break: { id: 2, name: 'Almoço' },
      });
      await esperar(
        async () =>
          (await clienteAna.get(`${BASE}/agente`)).body.estado === 'pausa',
      );
      falso.emitir('agent-was-logged-out', { agent: { id: 101 } });
      await esperar(
        async () =>
          (await clienteAna.get(`${BASE}/agente`)).body.estado ===
          'desconectado',
      );
      const sincronizado = await clienteAna
        .get(`${BASE}/agente`)
        .query({ atualizar: 'true' })
        .expect(200);
      expect(sincronizado.body).toMatchObject({
        estado: 'ocioso',
        campanha: { id: 1 },
      });
    });
  });

  describe('R34.4 — reconciliação e reconexão', () => {
    it('R34.4 — a reconciliação por GET /calls cobre eventos perdidos e não duplica; fecha as ligações presas', async () => {
      const { contato, negocio } = await prepararVendedora();
      // Uma ligação presa em CHAMANDO há 4 h (os eventos se perderam).
      const presa = await t.prisma.ligacao.create({
        data: {
          provedor: 'TRESC_PLUS',
          idExterno: '1111',
          contatoId: contato.id,
          negocioId: negocio.id,
          direcao: 'FEITA',
          estado: 'CHAMANDO',
          atendenteId: ana.id,
          telefone: '5511987654321',
          iniciadaEm: new Date(Date.now() - 4 * 3_600_000),
        },
      });
      // Uma ligação que o CRM nunca viu (o número é do contato) e o histórico dela.
      falso.estado.historico = [
        {
          id: '2222',
          number: '11987654321',
          agent: { id: 101, name: 'Ana 3C' },
          campaign: { id: 1, name: 'Prospecção' },
          call_date_rfc3339: new Date(Date.now() - 600_000).toISOString(),
          speaking_time: 30,
          billed_time: 33,
          hangup_cause: 'NORMAL_CLEARING',
          qualification: { id: 2, name: 'Retornar depois', conversion: false },
          recording: 'x',
          mailing_data: { identifier: negocio.id },
        },
        // De outro número: sem contato no CRM, não entra.
        {
          id: '3333',
          number: '11900000001',
          agent: { id: 101 },
          speaking_time: 10,
        },
      ];
      const r = await clienteAdmin.post(`${BASE}/reconciliar`).expect(200);
      expect(r.body).toEqual({ consultadas: 2, fechadas: 1 });
      const nova = await ligacaoPorExterno('2222');
      expect(nova).toMatchObject({
        estado: 'ENCERRADA',
        duracaoSegundos: 30,
        contatoId: contato.id,
        negocioId: negocio.id,
        atendenteId: ana.id,
        qualificacaoNome: 'Retornar depois',
        gravar: true,
      });
      expect(
        await t.prisma.ligacao.count({ where: { idExterno: '3333' } }),
      ).toBe(0);
      expect(
        (await t.prisma.ligacao.findUniqueOrThrow({ where: { id: presa.id } }))
          .estado,
      ).toBe('SEM_RESPOSTA');
      expect(falso.vezes('GET', '/calls').at(-1)?.autorizacao).toBe(
        `Bearer ${TOKEN_GESTOR}`,
      );
      expect(falso.vezes('GET', '/calls').at(-1)?.query).toMatchObject({
        per_page: '100',
        with_mailing: 'false',
      });
      // Segunda rodada: nada de novo e o job agendado também funciona.
      const segunda = await clienteAdmin
        .post(`${BASE}/reconciliar`)
        .expect(200);
      expect(segunda.body.fechadas).toBe(0);
      expect(
        await t.prisma.ligacao.count({ where: { provedor: 'TRESC_PLUS' } }),
      ).toBe(2);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: 'ligacao.qualificada',
            entidade: 'ligacao',
            entidadeId: nova.id,
          },
        }),
      ).toBe(1);
      await clienteAna.post(`${BASE}/reconciliar`).expect(403);
      // A atividade da ligação reconciliada e o job da gravação.
      expect(nova.atividadeId).not.toBeNull();
      expect(await drenarFilas(t, FILA_BAIXAR_GRAVACAO)).toBe(1);
      expect(
        (await ligacaoPorExterno('2222')).gravacaoOriginalArquivoId,
      ).not.toBeNull();
    });

    it('R34.4 — o ouvinte reconecta com backoff quando o 3C+ derruba o socket', async () => {
      await ativarIntegracao();
      falso.io.disconnectSockets(true);
      await esperar(
        async () =>
          (
            await t.prisma.trescPlusConfig.findUniqueOrThrow({
              where: { id: 1 },
            })
          ).ouvinteEstado === 'reconectando',
        3000,
      );
      await esperar(
        async () =>
          (
            await t.prisma.trescPlusConfig.findUniqueOrThrow({
              where: { id: 1 },
            })
          ).ouvinteEstado === 'conectado',
        5000,
      );
      const conf = await clienteAdmin.get(`${BASE}/conexao`).expect(200);
      expect(conf.body.ouvinte.estado).toBe('conectado');
    });

    it('R34.4 — o formato do envelope é configurável ({event, data})', async () => {
      await ativarIntegracao({ formatoEnvelope: 'EVENTO_DADOS' });
      await vincular(clienteAna, AGENTES[0]).expect(201);
      falso.io.emit('mensagem', {
        event: 'agent-is-idle',
        data: { type: 'agent-is-idle', agent: { id: 101 } },
      });
      await esperar(
        async () =>
          (await clienteAna.get(`${BASE}/agente`)).body.estado === 'ocioso',
      );
    });
  });

  describe('R34.6 — discador', () => {
    async function negociosParaEnviar() {
      const bom = await criarContato(t, {
        nome: 'Carla Boa',
        telefone: '5511988880001',
      });
      const dnd = await criarContato(t, {
        nome: 'Davi DND',
        telefone: '5511988880000',
      });
      const sem = await criarContato(t, {
        nome: 'Sem Fone',
        email: 'sem@teste.local',
      });
      const n1 = await criarNegocio(t, {
        contato: bom,
        titulo: 'Negócio Carla',
      });
      const n2 = await criarNegocio(t, {
        contato: dnd,
        titulo: 'Negócio Davi',
      });
      const n3 = await criarNegocio(t, {
        contato: sem,
        titulo: 'Negócio Sem Fone',
      });
      return { bom, dnd, sem, n1, n2, n3 };
    }

    it('R34.6 — envia o mailing.json com identifier e data e devolve o relatório de importados e filtrados', async () => {
      await ativarIntegracao();
      const { n1, n2, n3 } = await negociosParaEnviar();
      const r = await clienteLider
        .post(`${BASE}/discador/enviar`, {
          campanhaId: 1,
          nomeLista: 'Leads de novembro',
          negocioIds: [n1.id, n2.id, n3.id],
        })
        .expect(200);
      expect(r.body).toMatchObject({
        campanhaId: 1,
        listaNome: 'Leads de novembro',
        enviados: 2,
        importados: 1,
        filtrados: 2,
      });
      expect(r.body.detalhes).toEqual(
        expect.arrayContaining([
          {
            identifier: n3.id,
            telefone: null,
            motivo: 'O contato do negócio não tem um telefone válido.',
          },
          {
            identifier: n2.id,
            telefone: '11988880000',
            motivo: 'Número na lista de não perturbe (DND).',
          },
        ]),
      );
      const lista = falso.vezes('POST', '/campaigns/1/lists');
      expect(lista).toHaveLength(1);
      expect(lista[0].autorizacao).toBe(`Bearer ${TOKEN_GESTOR}`);
      const envio = falso.vezes(
        'POST',
        `/campaigns/1/lists/${r.body.listaId}/mailing.json`,
      );
      expect(envio[0].query.return_data).toBe('true');
      expect(envio[0].corpo).toEqual([
        {
          phone: '11988880001',
          identifier: n1.id,
          data: {
            nome: 'Carla Boa',
            empresa: '',
            funil: expect.any(String),
            etapa: expect.any(String),
            negocio: 'Negócio Carla',
            email: expect.any(String),
          },
        },
        {
          phone: '11988880000',
          identifier: n2.id,
          data: expect.objectContaining({ nome: 'Davi DND' }),
        },
      ]);
      const guardado = await t.prisma.trescPlusEnvio.findUniqueOrThrow({
        where: { id: r.body.envioId },
      });
      expect(guardado).toMatchObject({
        enviados: 2,
        importados: 1,
        filtrados: 2,
        usuarioId: lider.id,
      });
      // Lista existente + contatos: só Admin, C-level e líder.
      const c = await criarContato(t, {
        nome: 'Contato Avulso',
        telefone: '5511988880002',
      });
      await clienteAdmin
        .post(`${BASE}/discador/enviar`, {
          campanhaId: 1,
          listaId: 40,
          contatoIds: [c.id],
        })
        .expect(200);
      await (
        await entrarComo(t, cLevel)
      )
        .post(`${BASE}/discador/enviar`, {
          campanhaId: 1,
          listaId: 40,
          contatoIds: [c.id],
        })
        .expect(200);
      await clienteAna
        .post(`${BASE}/discador/enviar`, {
          campanhaId: 1,
          listaId: 40,
          contatoIds: [c.id],
        })
        .expect(403);
      await clienteLider
        .post(`${BASE}/discador/enviar`, { campanhaId: 1, negocioIds: [n1.id] })
        .expect(400);
      await clienteLider
        .post(`${BASE}/discador/enviar`, { campanhaId: 1, listaId: 40 })
        .expect(400);
    });

    it('R34.6 — ação em massa DISCADOR no quadro: só Admin, C-level e líder; sucesso = importados e falhas com o motivo', async () => {
      await ativarIntegracao();
      const { n1, n2, n3 } = await negociosParaEnviar();
      const corpo = {
        acao: 'DISCADOR',
        negocioIds: [n1.id, n2.id, n3.id],
        dados: { campanhaId: 1, nomeLista: 'Quadro' },
      };
      await clienteAna.post('/api/v1/negocios/em-massa', corpo).expect(403);
      await clienteLider
        .post('/api/v1/negocios/em-massa', {
          ...corpo,
          dados: { campanhaId: 1 },
        })
        .expect(400);
      const r = await clienteLider
        .post('/api/v1/negocios/em-massa', corpo)
        .expect(200);
      expect(r.body).toMatchObject({
        total: 3,
        sucesso: 1,
        discador: { importados: 1, enviados: 2, filtrados: 2 },
      });
      expect(
        r.body.falhas.map((f: { negocioId: string }) => f.negocioId).sort(),
      ).toEqual([n2.id, n3.id].sort());
      expect(
        r.body.falhas.find((f: { negocioId: string }) => f.negocioId === n3.id),
      ).toMatchObject({
        titulo: 'Negócio Sem Fone',
        statusCode: 422,
        regra: 'R34',
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'negocio.acao_em_massa' },
        }),
      ).toBe(1);
      // As outras ações continuam como eram.
      const atividade = await clienteLider
        .post('/api/v1/negocios/em-massa', {
          acao: 'ATIVIDADE',
          negocioIds: [n1.id],
          dados: { tipo: 'TAREFA', titulo: 'Ligar de novo' },
        })
        .expect(200);
      expect(atividade.body).toMatchObject({ sucesso: 1, falhas: [] });
    });
  });

  describe('R34.7 — receptivo', () => {
    it('R34.7 — casa o número com o contato, avisa o vendedor que atende e registra a ligação recebida', async () => {
      const { contato, negocio } = await prepararVendedora();
      await ativarIntegracao();
      await vincular(clienteBia, AGENTES[1]).expect(201);
      const socketAna = await conectarTempoReal(t, clienteAna);
      const socketBia = await conectarTempoReal(t, clienteBia);
      sockets.push(socketAna, socketBia);
      const aviso = esperarEvento<{
        ligacaoId: string;
        contato: { id: string; nome: string };
        negocios: Array<{ id: string }>;
        novoContato: boolean;
      }>(socketAna, 'tresc.recebida');
      const chamada = {
        id: '5555',
        phone: '11987654321',
        mode: 'receptive',
        agent: { id: 101, name: 'Ana 3C' },
      };
      falso.emitir('call-was-created', { call: chamada });
      const recebido = await aviso;
      expect(recebido).toMatchObject({
        contato: { id: contato.id, nome: 'Maria da Silva' },
        novoContato: false,
      });
      expect(recebido.negocios.map((n) => n.id)).toEqual([negocio.id]);
      let ligacao = await ligacaoPorExterno('5555');
      expect(ligacao).toMatchObject({
        direcao: 'RECEBIDA',
        estado: 'TOCANDO',
        contatoId: contato.id,
        negocioId: negocio.id,
        atendenteId: ana.id,
        canalId: null,
      });
      expect(recebido.ligacaoId).toBe(ligacao.id);
      // A recebida só vira interação humana quando a Ana atende.
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).primeiraInteracaoEm,
      ).toBeNull();
      falso.emitir('call-was-connected', { call: chamada });
      await esperar(
        async () => (await ligacaoPorExterno('5555')).estado === 'EM_ANDAMENTO',
      );
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).primeiraInteracaoTipo,
      ).toBe('LIGACAO');
      falso.emitir('call-was-finished', { call: chamada });
      await esperar(
        async () => (await ligacaoPorExterno('5555')).estado === 'ENCERRADA',
      );
      ligacao = await ligacaoPorExterno('5555');
      expect(ligacao.atividadeId).not.toBeNull();
    });

    it('R34.7 — número desconhecido avisa "novo contato" sem registrar ligação; a Bia não recebe o aviso da Ana', async () => {
      await prepararVendedora();
      await vincular(clienteBia, AGENTES[1]).expect(201);
      const socketAna = await conectarTempoReal(t, clienteAna);
      const socketBia = await conectarTempoReal(t, clienteBia);
      sockets.push(socketAna, socketBia);
      const aviso = esperarEvento<{
        ligacaoId: string | null;
        contato: unknown;
        telefone: string;
        novoContato: boolean;
      }>(socketAna, 'tresc.recebida');
      const naoChega = new Promise<boolean>((ok) => {
        socketBia.once('tresc.recebida', () => ok(false));
        setTimeout(() => ok(true), 600);
      });
      falso.emitir('call-was-created', {
        call: {
          id: '6666',
          phone: '21955554444',
          mode: 'receptive',
          agent: { id: 101 },
        },
      });
      expect(await aviso).toMatchObject({
        ligacaoId: null,
        contato: null,
        novoContato: true,
        telefone: '5521955554444',
      });
      expect(await naoChega).toBe(true);
      expect(
        await t.prisma.ligacao.count({ where: { provedor: 'TRESC_PLUS' } }),
      ).toBe(0);
    });

    it('R34.3 — chamada do discador identificada pelo identifier (id do negócio), mesmo com outro telefone', async () => {
      const { negocio, contato } = await prepararVendedora();
      falso.emitir('call-was-created', {
        call: {
          id: '8888',
          phone: '11911112222',
          mode: 'dialer',
          agent: { id: 101 },
          mailing_data: { identifier: negocio.id },
        },
      });
      await esperar(
        async () =>
          (await t.prisma.ligacao.count({ where: { idExterno: '8888' } })) ===
          1,
      );
      const ligacao = await ligacaoPorExterno('8888');
      expect(ligacao).toMatchObject({
        contatoId: contato.id,
        negocioId: negocio.id,
        modoChamada: 'dialer',
        direcao: 'FEITA',
      });
      // Discador: a pessoa só interage quando a chamada conecta ao agente.
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).primeiraInteracaoEm,
      ).toBeNull();
      falso.emitir('call-was-connected', {
        call: {
          id: '8888',
          phone: '11911112222',
          mode: 'dialer',
          agent: { id: 101 },
        },
      });
      await esperar(
        async () =>
          (
            await t.prisma.negocio.findUniqueOrThrow({
              where: { id: negocio.id },
            })
          ).primeiraInteracaoEm !== null,
      );
    });
  });
});
