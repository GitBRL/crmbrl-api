import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { Logger } from '@nestjs/common';
import type { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { TIPO_DAS_CREDENCIAIS } from './estado-de-autenticacao';
import {
  LimiteDoWhatsapp,
  type MensagemDoTransporte,
  type MotivoDaQueda,
  type OuvinteDaSessao,
  type SessaoWhatsapp,
} from './transporte';
import { type ModuloBaileys, TransporteBaileys } from './transporte-baileys';

/** Socket do Baileys de mentira: eventos pelo `ev` e as chamadas registradas. */
class SocketFalso {
  readonly ev = new EventEmitter();
  user?: { id: string; lid?: string };
  readonly sendMessage = jest.fn(
    (
      _jid: string,
      conteudo: { text?: string },
      opcoes?: { messageId?: string },
    ) =>
      Promise.resolve({
        key: { id: opcoes?.messageId },
        message: { conversation: conteudo.text ?? '' },
      }),
  );
  readonly onWhatsApp = jest.fn((telefone: string) =>
    Promise.resolve(
      telefone.endsWith('0000')
        ? [{ jid: `${telefone}@s.whatsapp.net`, exists: false }]
        : [
            {
              jid: `${telefone.slice(0, 4)}${telefone.slice(5)}@s.whatsapp.net`,
              exists: true,
            },
          ],
    ),
  );
  readonly sendPresenceUpdate = jest.fn(() => Promise.resolve());
  readonly presenceSubscribe = jest.fn(() => Promise.resolve());
  readonly logout = jest.fn(() => Promise.resolve());
  readonly end = jest.fn(() => Promise.resolve());
  readonly updateMediaMessage = jest.fn((mensagem: unknown) =>
    Promise.resolve(mensagem),
  );
  readonly signalRepository = {
    lidMapping: {
      getPNForLID: jest.fn((lid: string) =>
        Promise.resolve(
          lid === '99887766554433@lid'
            ? '5511944443333:2@s.whatsapp.net'
            : null,
        ),
      ),
    },
  };

  constructor(readonly config: Record<string, unknown>) {}

  emitir(evento: string, dados: unknown): void {
    this.ev.emit(evento, dados);
  }

  get creds(): Record<string, unknown> {
    return (this.config.auth as { creds: Record<string, unknown> }).creds;
  }
}

function bufferJson() {
  const replacer = (_chave: string, valor: unknown): unknown => {
    if (
      valor &&
      typeof valor === 'object' &&
      (valor as { type?: string }).type === 'Buffer' &&
      Array.isArray((valor as { data?: unknown }).data)
    ) {
      return {
        type: 'Buffer',
        data: Buffer.from((valor as { data: number[] }).data).toString(
          'base64',
        ),
      };
    }
    return valor;
  };
  const reviver = (_chave: string, valor: unknown): unknown =>
    valor &&
    typeof valor === 'object' &&
    (valor as { type?: string }).type === 'Buffer' &&
    typeof (valor as { data?: unknown }).data === 'string'
      ? Buffer.from((valor as { data: string }).data, 'base64')
      : valor;
  return { replacer, reviver };
}

/** Prisma de mentira, só com o que o estado de autenticação usa. */
function prismaFalso() {
  const linhas = new Map<
    string,
    { tipo: string; chaveId: string; valorCifrado: string }
  >();
  const chave = (numeroId: string, tipo: string, id: string) =>
    `${numeroId}|${tipo}|${id}`;
  const prisma = {
    linhas,
    whatsappChave: {
      findUnique: ({
        where: {
          numeroId_tipo_chaveId: { numeroId, tipo, chaveId },
        },
      }: {
        where: {
          numeroId_tipo_chaveId: {
            numeroId: string;
            tipo: string;
            chaveId: string;
          };
        };
      }) => Promise.resolve(linhas.get(chave(numeroId, tipo, chaveId)) ?? null),
      findMany: ({
        where,
      }: {
        where: { numeroId: string; tipo: string; chaveId: { in: string[] } };
      }) =>
        Promise.resolve(
          where.chaveId.in
            .map((id) => linhas.get(chave(where.numeroId, where.tipo, id)))
            .filter(Boolean),
        ),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    $executeRaw: (sql: TemplateStringsArray, ...valores: unknown[]) => {
      const texto = sql.join('?');
      if (texto.includes('INSERT')) {
        const [numeroId, tipos, ids, cifrados] = valores as [
          string,
          string[],
          string[],
          string[],
        ];
        tipos.forEach((tipo, indice) =>
          linhas.set(chave(numeroId, tipo, ids[indice]), {
            tipo,
            chaveId: ids[indice],
            valorCifrado: cifrados[indice],
          }),
        );
      } else {
        const [tipos, ids, numeroId] = valores as [string[], string[], string];
        tipos.forEach((tipo, indice) =>
          linhas.delete(chave(numeroId, tipo, ids[indice])),
        );
      }
      return Promise.resolve(1);
    },
  };
  return prisma;
}

const cripto = {
  cifrar: (texto: string) => `c:${Buffer.from(texto).toString('base64')}`,
  decifrar: (cifrado: string) => {
    if (!cifrado.startsWith('c:')) {
      throw new Error('não decifra');
    }
    return Buffer.from(cifrado.slice(2), 'base64').toString();
  },
} as unknown as CriptografiaService;

function ouvinteFalso() {
  const avisos: Array<{ tipo: string; dados: unknown }> = [];
  const ouvinte: OuvinteDaSessao = {
    aoQr: (qr) => avisos.push({ tipo: 'qr', dados: qr }),
    aoConectar: (conta) => avisos.push({ tipo: 'conectar', dados: conta }),
    aoCair: (queda) => avisos.push({ tipo: 'cair', dados: queda }),
    aoReceber: (mensagem) => avisos.push({ tipo: 'receber', dados: mensagem }),
    aoStatus: (idExterno, status, _em, erro) =>
      avisos.push({ tipo: 'status', dados: { idExterno, status, erro } }),
    aoDigitando: (jid, telefone, ativo) =>
      avisos.push({ tipo: 'digitando', dados: { jid, telefone, ativo } }),
  };
  return { ouvinte, avisos };
}

const esperarCiclos = async (vezes = 5) => {
  for (let i = 0; i < vezes; i++) {
    await new Promise((resolver) => setImmediate(resolver));
  }
};

const fechar = (codigo: number, mensagem = 'fechou') => ({
  connection: 'close',
  lastDisconnect: {
    error: Object.assign(new Error(mensagem), {
      output: { statusCode: codigo },
    }),
    date: new Date(),
  },
});

describe('TransporteBaileys (com o Baileys de mentira)', () => {
  const numeroId = '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10';
  let sockets: SocketFalso[];
  let modulo: ModuloBaileys;
  let prisma: ReturnType<typeof prismaFalso>;
  let logger: Logger;
  let sessao: SessaoWhatsapp;
  let avisos: Array<{ tipo: string; dados: unknown }>;

  const iniciar = async (opcoes: { buscarVersao?: boolean } = {}) => {
    const transporte = new TransporteBaileys({
      prisma: prisma as unknown as PrismaService,
      cripto,
      logger,
      carregar: () => Promise.resolve(modulo),
      buscarVersao: opcoes.buscarVersao,
    });
    const falso = ouvinteFalso();
    avisos = falso.avisos;
    sessao = transporte.criar(
      { numeroId, canalId: 'canal', telefone: null, jaConectado: false },
      falso.ouvinte,
    );
    await sessao.iniciar();
    return sockets.at(-1) as SocketFalso;
  };

  /** Socket aberto, como depois da leitura do QR. */
  const conectado = async () => {
    const socket = await iniciar();
    socket.creds.me = { id: '5511999990000:7@s.whatsapp.net' };
    socket.user = {
      id: '5511999990000:7@s.whatsapp.net',
      lid: '1234567890:7@lid',
    };
    socket.emitir('connection.update', { connection: 'open' });
    return socket;
  };

  const ultimo = (tipo: string) =>
    avisos.filter((aviso) => aviso.tipo === tipo).at(-1)?.dados;

  beforeEach(() => {
    sockets = [];
    prisma = prismaFalso();
    logger = {
      warn: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    modulo = {
      makeWASocket: jest.fn((config: Record<string, unknown>) => {
        const socket = new SocketFalso(config);
        sockets.push(socket);
        return socket;
      }),
      initAuthCreds: () => ({
        noiseKey: { public: Buffer.from('pub'), private: Buffer.from('priv') },
        registered: false,
      }),
      BufferJSON: bufferJson(),
      proto: {
        Message: {
          AppStateSyncKeyData: {
            fromObject: (valor: object) => ({ ...valor, revivido: true }),
          },
        },
      },
      makeCacheableSignalKeyStore: (chaves: unknown) => chaves,
      fetchLatestWaWebVersion: jest.fn(() =>
        Promise.resolve({ version: [2, 3000, 123], isLatest: true }),
      ),
      normalizeMessageContent: (conteudo: unknown) => conteudo,
      downloadMediaMessage: jest.fn(() =>
        Promise.resolve(Readable.from([Buffer.from('midia')])),
      ),
      jidNormalizedUser: (jid: string) => {
        const [usuario, servidor] = jid.split('@');
        return `${usuario.split(':')[0]}@${servidor}`;
      },
    } as unknown as ModuloBaileys;
  });

  it('abre o socket sem "online", sem histórico completo, com a versão atual e ignorando grupos', async () => {
    const socket = await iniciar();
    expect(socket.config).toMatchObject({
      markOnlineOnConnect: false,
      syncFullHistory: false,
      version: [2, 3000, 123],
    });
    const ignorar = socket.config.shouldIgnoreJid as (jid: string) => boolean;
    expect(ignorar('120363@g.us')).toBe(true);
    expect(ignorar('status@broadcast')).toBe(true);
    expect(ignorar('5511999990000@s.whatsapp.net')).toBe(false);
    // A sincronização inicial fica com o padrão do Baileys (mapeamento LID).
    expect(socket.config.shouldSyncHistoryMessage).toBeUndefined();

    await iniciar({ buscarVersao: false });
    expect(sockets.at(-1)?.config.version).toBeUndefined();
  });

  it('QR → aoQr; credenciais gravadas cifradas a cada creds.update', async () => {
    const socket = await iniciar();
    socket.emitir('connection.update', { qr: 'QR-1' });
    expect(ultimo('qr')).toBe('QR-1');
    socket.creds.me = { id: '5511999990000:7@s.whatsapp.net' };
    socket.emitir('creds.update', {});
    await esperarCiclos();
    const gravada = prisma.linhas.get(`${numeroId}|${TIPO_DAS_CREDENCIAIS}|`);
    expect(gravada?.valorCifrado).toMatch(/^c:/);
    expect(gravada?.valorCifrado).not.toContain('5511999990000');
    expect(cripto.decifrar(gravada?.valorCifrado ?? '')).toContain(
      '5511999990000',
    );
  });

  it('conecta com o telefone e o LID da conta; o 515 reabre o socket sem avisar', async () => {
    const socket = await iniciar();
    socket.creds.me = { id: '5511999990000:7@s.whatsapp.net' };
    socket.emitir('connection.update', fechar(515, 'restart required'));
    expect(sockets).toHaveLength(2);
    expect(avisos.filter((aviso) => aviso.tipo === 'cair')).toHaveLength(0);
    const novo = sockets[1];
    novo.user = { id: '5511999990000:7@s.whatsapp.net', lid: '123:7@lid' };
    novo.emitir('connection.update', { connection: 'open' });
    expect(ultimo('conectar')).toEqual({
      telefone: '5511999990000',
      jid: '5511999990000@s.whatsapp.net',
      lid: '123@lid',
    });
    // Eventos do socket velho são ignorados.
    socket.emitir('connection.update', { qr: 'velho' });
    expect(avisos.some((aviso) => aviso.dados === 'velho')).toBe(false);
  });

  it.each([
    [401, { logout: true }],
    [403, { banido: true }],
    [440, { erroGrave: true }],
    [428, {}],
  ])('queda %i depois de conectado', async (codigo, esperado) => {
    const socket = await conectado();
    socket.emitir('connection.update', fechar(codigo));
    const queda = ultimo('cair') as MotivoDaQueda;
    expect(queda).toMatchObject(esperado);
    expect(queda.semLeituraDoQr).toBeUndefined();
    expect(sockets).toHaveLength(1);
  });

  it('QR que expirou sem leitura não reconecta', async () => {
    const socket = await iniciar();
    socket.emitir('connection.update', fechar(408, 'QR refs attempts ended'));
    expect(ultimo('cair')).toMatchObject({ semLeituraDoQr: true });
  });

  it('credenciais que não decifram: erro grave, sem abrir socket', async () => {
    prisma.linhas.set(`${numeroId}|${TIPO_DAS_CREDENCIAIS}|`, {
      tipo: TIPO_DAS_CREDENCIAIS,
      chaveId: '',
      valorCifrado: 'outra-chave',
    });
    await iniciar();
    expect(sockets).toHaveLength(0);
    expect(ultimo('cair')).toMatchObject({ erroGrave: true });
  });

  it('recebe texto pelo telefone, pelo @lid (com o alternativo ou o mapeamento) e ignora o resto', async () => {
    const socket = await conectado();
    const mensagem = (chave: Record<string, unknown>, conteudo: object) => ({
      key: { id: `ID-${String(chave.remoteJid)}`, fromMe: false, ...chave },
      message: conteudo,
      pushName: 'Maria',
      messageTimestamp: 1_760_000_000,
    });
    socket.emitir('messages.upsert', {
      type: 'notify',
      messages: [
        mensagem(
          { remoteJid: '5511955554444@s.whatsapp.net' },
          { conversation: 'Oi' },
        ),
        mensagem(
          {
            remoteJid: '11223344@lid',
            remoteJidAlt: '5511966665555@s.whatsapp.net',
          },
          { conversation: 'Pelo LID' },
        ),
        mensagem(
          { remoteJid: '99887766554433@lid' },
          { conversation: 'Mapeado' },
        ),
        mensagem(
          { remoteJid: '55667788@lid' },
          { conversation: 'Sem telefone' },
        ),
        mensagem({ remoteJid: '120363@g.us' }, { conversation: 'Grupo' }),
        mensagem(
          { remoteJid: '5511955554444@s.whatsapp.net', fromMe: true },
          { conversation: 'Eu mesmo' },
        ),
        mensagem(
          { remoteJid: '5511955554444@s.whatsapp.net' },
          { protocolMessage: {} },
        ),
      ],
    });
    socket.emitir('messages.upsert', {
      type: 'append',
      messages: [
        mensagem(
          { remoteJid: '5511955554444@s.whatsapp.net' },
          { conversation: 'Histórico' },
        ),
      ],
    });
    await esperarCiclos();
    const recebidas = avisos
      .filter((aviso) => aviso.tipo === 'receber')
      .map((aviso) => aviso.dados as MensagemDoTransporte);
    expect(
      recebidas.map(({ remetenteJid, telefone, texto }) => ({
        remetenteJid,
        telefone,
        texto,
      })),
    ).toEqual([
      {
        remetenteJid: '5511955554444@s.whatsapp.net',
        telefone: '5511955554444',
        texto: 'Oi',
      },
      {
        remetenteJid: '5511966665555@s.whatsapp.net',
        telefone: '5511966665555',
        texto: 'Pelo LID',
      },
      {
        remetenteJid: '5511944443333@s.whatsapp.net',
        telefone: '5511944443333',
        texto: 'Mapeado',
      },
      { remetenteJid: '55667788@lid', telefone: null, texto: 'Sem telefone' },
    ]);
    expect(recebidas[0]).toMatchObject({
      idExterno: 'ID-5511955554444@s.whatsapp.net',
      nome: 'Maria',
      tipo: 'TEXTO',
      recebidaEm: new Date(1_760_000_000_000),
    });
    expect(recebidas[1].metadados).toEqual({ lid: '11223344@lid' });
    // Pede a presença de cada contato uma vez só.
    expect(socket.presenceSubscribe).toHaveBeenCalledWith(
      '5511955554444@s.whatsapp.net',
    );
  });

  it('mídia recebida só é baixada quando o gerenciador pede', async () => {
    const socket = await conectado();
    socket.emitir('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'IMG', remoteJid: '5511955554444@s.whatsapp.net' },
          message: {
            imageMessage: { mimetype: 'image/jpeg', caption: 'Foto' },
          },
        },
      ],
    });
    await esperarCiclos();
    const recebida = ultimo('receber') as MensagemDoTransporte;
    expect(recebida).toMatchObject({ tipo: 'IMAGEM', texto: 'Foto' });
    expect(modulo.downloadMediaMessage).not.toHaveBeenCalled();
    const conteudo = await recebida.midia?.baixar?.();
    expect(modulo.downloadMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.objectContaining({ id: 'IMG' }) }),
      'stream',
      {},
      expect.objectContaining({ reuploadRequest: expect.any(Function) }),
    );
    expect(conteudo).toBeInstanceOf(Readable);
  });

  it('recibos das mensagens enviadas viram status; "digitando…" do contato vira aviso', async () => {
    const socket = await conectado();
    socket.emitir('messages.update', [
      { key: { id: 'A', fromMe: true }, update: { status: 3 } },
      { key: { id: 'A', fromMe: true }, update: { status: 4 } },
      { key: { id: 'B', fromMe: true }, update: { status: 0 } },
      { key: { id: 'C', fromMe: false }, update: { status: 4 } },
      { key: { id: 'D', fromMe: true }, update: { status: 2 } },
    ]);
    expect(
      avisos
        .filter((aviso) => aviso.tipo === 'status')
        .map((aviso) => aviso.dados),
    ).toEqual([
      { idExterno: 'A', status: 'ENTREGUE', erro: undefined },
      { idExterno: 'A', status: 'LIDA', erro: undefined },
      {
        idExterno: 'B',
        status: 'FALHOU',
        erro: 'O WhatsApp não conseguiu entregar a mensagem.',
      },
    ]);
    socket.emitir('presence.update', {
      id: '5511955554444@s.whatsapp.net',
      presences: {
        '5511955554444@s.whatsapp.net': { lastKnownPresence: 'composing' },
      },
    });
    socket.emitir('presence.update', {
      id: '120363@g.us',
      presences: { x: { lastKnownPresence: 'composing' } },
    });
    await esperarCiclos();
    expect(avisos.filter((aviso) => aviso.tipo === 'digitando')).toEqual([
      {
        tipo: 'digitando',
        dados: {
          jid: '5511955554444@s.whatsapp.net',
          telefone: '5511955554444',
          ativo: true,
        },
      },
    ]);
  });

  it('envia com o id da API e a citação; guarda a mensagem para o reenvio', async () => {
    const socket = await conectado();
    await sessao.enviar({
      idExterno: '3EB0ABC',
      para: '5511955554444@s.whatsapp.net',
      tipo: 'TEXTO',
      texto: 'Olá',
      respondeAIdExterno: '3EB0CITADA',
      citada: { texto: 'Pergunta', deMim: false },
    });
    expect(socket.sendMessage).toHaveBeenCalledWith(
      '5511955554444@s.whatsapp.net',
      { text: 'Olá' },
      {
        messageId: '3EB0ABC',
        quoted: {
          key: {
            remoteJid: '5511955554444@s.whatsapp.net',
            id: '3EB0CITADA',
            fromMe: false,
          },
          message: { conversation: 'Pergunta' },
        },
      },
    );
    const getMessage = socket.config.getMessage as (chave: {
      id: string;
    }) => Promise<unknown>;
    expect(await getMessage({ id: '3EB0ABC' })).toEqual({
      conversation: 'Olá',
    });
    expect(await getMessage({ id: 'outro' })).toBeUndefined();

    await sessao.enviar({
      idExterno: '3EB0IMG',
      para: '5511955554444@s.whatsapp.net',
      tipo: 'IMAGEM',
      texto: null,
      midia: {
        conteudo: Buffer.from('png'),
        nome: 'a.png',
        mime: 'image/png',
        miniatura: 'BASE64',
      },
    });
    expect(socket.sendMessage).toHaveBeenLastCalledWith(
      '5511955554444@s.whatsapp.net',
      expect.objectContaining({
        image: Buffer.from('png'),
        jpegThumbnail: 'BASE64',
      }),
      { messageId: '3EB0IMG' },
    );
  });

  it('limite do WhatsApp vira LimiteDoWhatsapp; sem conexão, erro passageiro', async () => {
    const socket = await conectado();
    socket.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error('rate-overlimit'), { data: 429 }),
    );
    const envio = {
      idExterno: 'X',
      para: '5511955554444@s.whatsapp.net',
      tipo: 'TEXTO' as const,
      texto: 'oi',
    };
    await expect(sessao.enviar(envio)).rejects.toBeInstanceOf(LimiteDoWhatsapp);
    socket.emitir('connection.update', fechar(428));
    await expect(sessao.enviar(envio)).rejects.toThrow(/não está conectado/);
  });

  it('verifica o número e mostra "digitando…"/"gravando…"', async () => {
    const socket = await conectado();
    expect(await sessao.verificar('5511988887777')).toEqual({
      existe: true,
      jid: '551188887777@s.whatsapp.net',
    });
    expect(await sessao.verificar('5511988880000')).toEqual({
      existe: false,
      jid: null,
    });
    await sessao.digitando('5511955554444@s.whatsapp.net', true);
    await sessao.digitando('5511955554444@s.whatsapp.net', true, true);
    await sessao.digitando('5511955554444@s.whatsapp.net', false);
    expect(socket.sendPresenceUpdate.mock.calls).toEqual([
      ['composing', '5511955554444@s.whatsapp.net'],
      ['recording', '5511955554444@s.whatsapp.net'],
      ['paused', '5511955554444@s.whatsapp.net'],
    ]);
  });

  it('encerrar com sair faz logout e não grava mais nada; sem sair, só fecha', async () => {
    let socket = await conectado();
    await sessao.encerrar({ sair: true });
    expect(socket.logout).toHaveBeenCalled();
    socket.creds.me = { id: 'mudou@s.whatsapp.net' };
    socket.emitir('creds.update', {});
    await esperarCiclos();
    expect(prisma.linhas.size).toBe(0);
    // Fechamento depois de encerrar não vira queda.
    socket.emitir('connection.update', fechar(401));
    expect(ultimo('cair')).toBeUndefined();

    socket = await conectado();
    await sessao.encerrar();
    expect(socket.end).toHaveBeenCalled();
    expect(socket.logout).not.toHaveBeenCalled();
  });
});
