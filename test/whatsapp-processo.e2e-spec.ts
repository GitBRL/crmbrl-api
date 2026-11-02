import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptadorWhatsapp } from '../src/canais/whatsapp/adaptador-whatsapp';
import { CABECALHO_TOKEN_INTERNO } from '../src/canais/whatsapp/contrato-gateway';
import type { StatusWhatsapp } from '../src/generated/prisma/client';
import { telefoneSimulado } from '../src/whatsapp/transporte/transporte-simulado';
import {
  type AppTeste,
  CHAVE_DE_TESTE,
  criarAppTeste,
  criarCanalWhatsapp,
  criarMensagem,
  criarUsuario,
  drenarEventosDoGateway,
  entrarComo,
  ORIGEM_DE_TESTE,
  TOKEN_INTERNO_DE_TESTE,
  urlDoBancoDeTeste,
} from './utils';

/** O gateway compilado (`npm run build`): sem ele, a suíte é pulada. */
const PROCESSO_DO_GATEWAY = join(
  __dirname,
  '..',
  'dist',
  'whatsapp',
  'main.js',
);
const descrever = existsSync(PROCESSO_DO_GATEWAY) ? describe : describe.skip;

function portaLivre(): Promise<number> {
  return new Promise((resolver, rejeitar) => {
    const servidor = createServer();
    servidor.once('error', rejeitar);
    servidor.listen(0, '127.0.0.1', () => {
      const endereco = servidor.address();
      servidor.close(() =>
        typeof endereco === 'object' && endereco
          ? resolver(endereco.port)
          : rejeitar(new Error('sem porta')),
      );
    });
  });
}

async function aguardar<T>(
  descricao: string,
  verificar: () => Promise<T | null | undefined | false>,
  prazoMs = 20_000,
): Promise<T> {
  const limite = Date.now() + prazoMs;
  for (;;) {
    const resultado = await verificar().catch(() => null);
    if (resultado) {
      return resultado;
    }
    if (Date.now() > limite) {
      throw new Error(`Tempo esgotado esperando: ${descricao}`);
    }
    await new Promise((resolver) => setTimeout(resolver, 200));
  }
}

/**
 * Ponta a ponta com o **processo** do gateway (`node dist/whatsapp/main.js`)
 * em modo simulado contra o Postgres de teste, como no compose: a API manda
 * os comandos pelo HTTP interno (com o token), o gateway consome a fila de
 * envio do número sozinho (`PROCESSAR_FILAS=true`) e a API drena os eventos
 * da fila `whatsapp.evento`. Rode `npm run build` antes.
 */
descrever('WhatsApp — processo do gateway de verdade (e2e)', () => {
  let t: AppTeste;
  let porta: number;
  let pasta: string;
  let processo: ChildProcess | null = null;
  let saida = '';

  const subir = async () => {
    saida = '';
    processo = spawn(process.execPath, [PROCESSO_DO_GATEWAY], {
      // Pasta vazia: o main.ts não acha um .env por engano.
      cwd: pasta,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'test',
        DATABASE_URL: urlDoBancoDeTeste(),
        CHAVE_CRIPTOGRAFIA: CHAVE_DE_TESTE,
        URL_PUBLICA: ORIGEM_DE_TESTE,
        ORIGENS_PERMITIDAS: ORIGEM_DE_TESTE,
        PROCESSAR_FILAS: 'true',
        LOG_FORMATO: 'texto',
        ARQUIVOS_DRIVER: 'memoria',
        WHATSAPP_SIMULADO: 'true',
        WHATSAPP_TOKEN_INTERNO: TOKEN_INTERNO_DE_TESTE,
        WHATSAPP_PORTA: String(porta),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processo.stdout?.on('data', (parte: Buffer) => {
      saida += parte.toString();
    });
    processo.stderr?.on('data', (parte: Buffer) => {
      saida += parte.toString();
    });
    await aguardar('o gateway responder /saude', async () => {
      const resposta = await fetch(`http://127.0.0.1:${porta}/saude`);
      return resposta.ok;
    });
  };

  /**
   * SIGTERM e espera sair. O Nest fecha os módulos (sessões, fila, banco) e
   * repassa o sinal: sai pelo SIGTERM (ou com código 0).
   */
  const descer = async (): Promise<string | null> => {
    const atual = processo;
    processo = null;
    if (!atual || atual.exitCode !== null || atual.signalCode !== null) {
      return null;
    }
    let temporizador: NodeJS.Timeout | undefined;
    const saiu = new Promise<string>((resolver) =>
      atual.once('exit', (codigo, sinal) =>
        resolver(sinal ?? `código ${codigo}`),
      ),
    );
    atual.kill('SIGTERM');
    try {
      return await Promise.race([
        saiu,
        new Promise<string>((_, rejeitar) => {
          temporizador = setTimeout(() => {
            atual.kill('SIGKILL');
            rejeitar(new Error(`O gateway não saiu com SIGTERM.\n${saida}`));
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(temporizador);
    }
  };

  const statusDo = async (numeroId: string): Promise<StatusWhatsapp> =>
    (
      await t.prisma.whatsappNumero.findUniqueOrThrow({
        where: { id: numeroId },
      })
    ).status;

  beforeAll(async () => {
    porta = await portaLivre();
    pasta = await mkdtemp(join(tmpdir(), 'gateway-whatsapp-'));
    t = await criarAppTeste({
      variaveis: { WHATSAPP_URL_INTERNA: `http://127.0.0.1:${porta}` },
    });
  });
  afterAll(async () => {
    await descer().catch(() => undefined);
    await rm(pasta, { recursive: true, force: true });
    // Não deixa número "conectado" para o próximo gateway retomar.
    await t.limparBanco();
    await t.fechar();
  });

  it('cenário 26 — sobe, conecta pelo comando da API, recebe pelo simulador, envia pela fila até LIDA, desce e retoma', async () => {
    await t.limparBanco();
    await subir();
    const cliente = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    const { canal, numero } = await criarCanalWhatsapp(t);

    // Conectar pela API → HTTP interno → QR de mentira → CONECTADO (≈ 4,5 s).
    await cliente
      .post(`/api/v1/whatsapp/numeros/${numero.id}/conectar`)
      .expect(202);
    await aguardar(
      'o número conectar',
      async () => (await statusDo(numero.id)) === 'CONECTADO',
    );
    expect(
      (await cliente.get(`/api/v1/whatsapp/numeros/${numero.id}`).expect(200))
        .body,
    ).toMatchObject({
      status: 'CONECTADO',
      telefone: telefoneSimulado(numero.id),
    });

    // Recebimento pelo simulador (HTTP interno com o token) → Atendimento.
    const recebido = await fetch(
      `http://127.0.0.1:${porta}/simulador/receber`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CABECALHO_TOKEN_INTERNO]: TOKEN_INTERNO_DE_TESTE,
        },
        body: JSON.stringify({
          numeroId: numero.id,
          de: '11 95555-4444',
          nome: 'Paulo',
          texto: 'Olá pelo processo',
        }),
      },
    );
    expect(recebido.status).toBe(202);
    await drenarEventosDoGateway(t);
    const conversa = await t.prisma.conversa.findFirstOrThrow({
      where: { canalId: canal.id },
      include: { mensagens: true, contato: true },
    });
    expect(conversa).toMatchObject({
      idExterno: '5511955554444@s.whatsapp.net',
      contato: { telefone: '5511955554444', nome: 'Paulo' },
    });
    expect(conversa.mensagens.map((mensagem) => mensagem.texto)).toEqual([
      'Olá pelo processo',
    ]);

    // Resposta: o adaptador põe na fila; o processo do gateway envia sozinho.
    const resposta = await criarMensagem(t, {
      conversa: conversa.id,
      direcao: 'SAIDA',
      texto: 'Oi, Paulo!',
    });
    const { idExterno } = await t
      .get(AdaptadorWhatsapp)
      .enviar(resposta, conversa, canal);
    await t.prisma.mensagem.update({
      where: { id: resposta.id },
      data: { idExterno },
    });
    await aguardar(
      'a resposta chegar a LIDA',
      async () => {
        await drenarEventosDoGateway(t);
        const atual = await t.prisma.mensagem.findUniqueOrThrow({
          where: { id: resposta.id },
        });
        return atual.status === 'LIDA' ? atual : null;
      },
      25_000,
    );
    const enviada = await t.prisma.mensagem.findUniqueOrThrow({
      where: { id: resposta.id },
    });
    expect(enviada.enviadaEm).not.toBeNull();
    expect(enviada.entregueEm).not.toBeNull();

    // SIGTERM: sai limpo e o número continua marcado como conectado.
    expect(await descer()).toMatch(/^(SIGTERM|código 0)$/);
    expect(await statusDo(numero.id)).toBe('CONECTADO');

    // Ao subir de novo, retoma o número sem QR.
    await subir();
    await aguardar('o número ser retomado', async () => {
      const resposta = await fetch(
        `http://127.0.0.1:${porta}/numeros/${numero.id}/status`,
        { headers: { [CABECALHO_TOKEN_INTERNO]: TOKEN_INTERNO_DE_TESTE } },
      );
      const estado = (await resposta.json()) as { status: string };
      return estado.status === 'CONECTADO';
    });
    const saude = (await (
      await fetch(`http://127.0.0.1:${porta}/saude`)
    ).json()) as { numeros: Record<string, number>; simulado: boolean };
    expect(saude).toMatchObject({ simulado: true, numeros: { CONECTADO: 1 } });
    expect(await descer()).toMatch(/^(SIGTERM|código 0)$/);
    expect(saida).not.toMatch(/ERROR|Error:/);
  }, 90_000);
});
