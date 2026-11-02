import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { enviarPost } from './envio-http';

type Manipulador = (req: IncomingMessage, res: ServerResponse) => void;

describe('envio HTTP das entregas (R9.3–R9.5)', () => {
  let servidor: Server;
  let base: string;
  let manipulador: Manipulador = (_req, res) => res.end();
  const recebidos: { cabecalhos: IncomingMessage['headers']; corpo: string }[] =
    [];

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (parte: Buffer) => partes.push(parte));
      req.on('end', () => {
        recebidos.push({
          cabecalhos: req.headers,
          corpo: Buffer.concat(partes).toString('utf8'),
        });
        manipulador(req, res);
      });
    });
    await new Promise<void>((resolver) =>
      servidor.listen(0, '127.0.0.1', resolver),
    );
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(
    () =>
      new Promise<void>((resolver) => {
        servidor.closeAllConnections();
        servidor.close(() => resolver());
      }),
  );

  beforeEach(() => {
    recebidos.length = 0;
  });

  it('R9.4 — 2xx é sucesso; manda o corpo e os cabeçalhos como vieram', async () => {
    manipulador = (_req, res) => {
      res.statusCode = 204;
      res.end();
    };
    const resultado = await enviarPost({
      url: `${base}/ok`,
      corpo: '{"a":1}',
      cabecalhos: { 'Content-Type': 'application/json', 'X-Teste': 'sim' },
    });
    expect(resultado).toMatchObject({
      sucesso: true,
      statusHttp: 204,
      trechoResposta: null,
      erro: null,
    });
    expect(recebidos[0].corpo).toBe('{"a":1}');
    expect(recebidos[0].cabecalhos['x-teste']).toBe('sim');
  });

  it('R9.5 — guarda só os 2 KB iniciais da resposta; não-2xx é falha', async () => {
    manipulador = (_req, res) => {
      res.statusCode = 500;
      res.end('é'.repeat(5_000));
    };
    const resultado = await enviarPost({
      url: `${base}/erro`,
      corpo: '{}',
      cabecalhos: {},
    });
    expect(resultado.sucesso).toBe(false);
    expect(resultado.statusHttp).toBe(500);
    expect(resultado.erro).toBe('HTTP 500 Internal Server Error');
    expect(
      Buffer.byteLength(resultado.trechoResposta ?? ''),
    ).toBeLessThanOrEqual(2_048 + 3);
    expect(resultado.trechoResposta?.startsWith('éé')).toBe(true);
  });

  it('R9.1 — não segue redirecionamentos', async () => {
    manipulador = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'http://169.254.169.254/');
      res.end();
    };
    const resultado = await enviarPost({
      url: `${base}/redireciona`,
      corpo: '{}',
      cabecalhos: {},
    });
    expect(resultado.sucesso).toBe(false);
    expect(resultado.statusHttp).toBe(302);
    expect(resultado.erro).toMatch(/redirecionamentos não são seguidos/);
    expect(recebidos).toHaveLength(1);
  });

  it('R9.3 — tempo limite: sem resposta no prazo é falha', async () => {
    manipulador = () => undefined; // nunca responde
    const resultado = await enviarPost({
      url: `${base}/lento`,
      corpo: '{}',
      cabecalhos: {},
      prazoMs: 300,
    });
    expect(resultado).toMatchObject({
      sucesso: false,
      statusHttp: null,
      erro: 'Sem resposta em 300 ms (tempo limite).',
    });
    expect(resultado.duracaoMs).toBeGreaterThanOrEqual(250);
  });

  it('falha de conexão vira mensagem com o código do erro', async () => {
    // Uma porta que acabou de ficar livre: ninguém escuta nela.
    const temporario = createServer();
    await new Promise<void>((resolver) =>
      temporario.listen(0, '127.0.0.1', resolver),
    );
    const porta = (temporario.address() as AddressInfo).port;
    await new Promise<void>((resolver) => temporario.close(() => resolver()));
    const resultado = await enviarPost({
      url: `http://127.0.0.1:${porta}/x`,
      corpo: '{}',
      cabecalhos: {},
    });
    expect(resultado.sucesso).toBe(false);
    expect(resultado.erro).toMatch(/^Falha de conexão \(ECONNREFUSED\)/);
  });
});
