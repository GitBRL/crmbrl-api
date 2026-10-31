/**
 * Apoio dos testes do assistente (R25): leitura do SSE, um TicketHub falso
 * (login + `POST /api/chamados` no formato do TicketHub real) e um receptor de
 * webhooks, os dois em HTTP local numa porta livre.
 */
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClienteHttp } from './utils';

export interface EventoSse {
  evento: string;
  dados: Record<string, unknown>;
}

/** Faz o POST e lê o corpo `text/event-stream` inteiro. */
export async function transmitir(
  cliente: ClienteHttp,
  url: string,
  corpo: object,
): Promise<{ status: number; eventos: EventoSse[]; corpoJson: unknown }> {
  const resposta = await cliente
    .post(url, corpo)
    .buffer(true)
    .parse((res, fim) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (parte: string) => (texto += parte));
      res.on('end', () => fim(null, texto));
    });
  const bruto = resposta.body as string;
  const eventos: EventoSse[] = [];
  for (const bloco of bruto.split('\n\n')) {
    const evento = /^event: (.+)$/m.exec(bloco)?.[1];
    const dados = /^data: (.+)$/m.exec(bloco)?.[1];
    if (evento && dados) {
      eventos.push({
        evento,
        dados: JSON.parse(dados) as Record<string, unknown>,
      });
    }
  }
  let corpoJson: unknown = null;
  if (!eventos.length) {
    try {
      corpoJson = JSON.parse(bruto);
    } catch {
      corpoJson = null;
    }
  }
  return { status: resposta.status, eventos, corpoJson };
}

export function evento(eventos: EventoSse[], nome: string): EventoSse['dados'] {
  const achado = eventos.find((e) => e.evento === nome);
  if (!achado) {
    throw new Error(
      `Evento ${nome} não veio (vieram: ${eventos.map((e) => e.evento).join(', ')})`,
    );
  }
  return achado.dados;
}

async function lerCorpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = [];
  for await (const parte of req) {
    partes.push(parte as Buffer);
  }
  return Buffer.concat(partes).toString('utf8');
}

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

async function ouvir(
  tratar: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ servidor: Server; url: string }> {
  const servidor = createServer((req, res) => {
    tratar(req, res).catch(() => json(res, 500, { message: 'erro' }));
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address() as AddressInfo;
  return { servidor, url: `http://127.0.0.1:${port}` };
}

export interface ChamadoRecebido {
  id: string;
  titulo: string;
  descricao: string;
  prioridade: string;
  sistema_id: string | null;
  autorizacao: string;
}

/** TicketHub falso: conta `servico@tickethub.local` / `SenhaDoServico1`. */
export class TicketHubFalso {
  static readonly EMAIL = 'servico@tickethub.local';
  static readonly SENHA = 'SenhaDoServico1';
  url = '';
  logins = 0;
  readonly recebidos: ChamadoRecebido[] = [];
  /** Próximas respostas do `POST /api/chamados` com este status (depois, 201). */
  readonly falhas: number[] = [];
  private servidor?: Server;
  private readonly tokens = new Set<string>();

  async iniciar(): Promise<void> {
    const { servidor, url } = await ouvir(async (req, res) => {
      const corpo = await lerCorpo(req);
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        this.logins++;
        const dados = JSON.parse(corpo || '{}') as Record<string, string>;
        if (
          dados.email !== TicketHubFalso.EMAIL ||
          dados.senha !== TicketHubFalso.SENHA
        ) {
          json(res, 401, {
            message: 'E-mail ou senha inválidos.',
            code: 'credenciais_invalidas',
          });
          return;
        }
        const token = `jwt-${randomUUID()}`;
        this.tokens.add(token);
        json(res, 200, { token, user: { userId: 'u1', email: dados.email } });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chamados') {
        const auth = req.headers.authorization ?? '';
        if (!this.tokens.has(auth.replace(/^Bearer /, ''))) {
          json(res, 401, { message: 'Faça login para continuar.' });
          return;
        }
        const falha = this.falhas.shift();
        if (falha) {
          json(res, falha, { message: 'Erro interno no servidor.' });
          return;
        }
        const dados = JSON.parse(corpo) as Record<string, string>;
        if (
          !dados.titulo ||
          dados.titulo.length < 3 ||
          dados.titulo.length > 200 ||
          !dados.descricao ||
          dados.descricao.length < 6 ||
          dados.descricao.length > 10000
        ) {
          json(res, 400, {
            message: 'titulo: inválido',
            code: 'dados_invalidos',
          });
          return;
        }
        const id = randomUUID();
        this.recebidos.push({
          id,
          titulo: dados.titulo,
          descricao: dados.descricao,
          prioridade: dados.prioridade,
          sistema_id: dados.sistema_id ?? null,
          autorizacao: auth,
        });
        json(res, 201, {
          id,
          titulo: dados.titulo,
          descricao: dados.descricao,
          prioridade: dados.prioridade ?? 'media',
          status: 'aberto',
        });
        return;
      }
      json(res, 404, { message: 'Rota inexistente.' });
    });
    this.servidor = servidor;
    this.url = url;
  }

  /** Invalida os tokens (simula expiração). */
  expirarTokens(): void {
    this.tokens.clear();
  }

  limpar(): void {
    this.logins = 0;
    this.recebidos.length = 0;
    this.falhas.length = 0;
    this.tokens.clear();
  }

  parar(): Promise<void> {
    return new Promise((r) =>
      this.servidor ? this.servidor.close(() => r()) : r(),
    );
  }
}

export interface WebhookRecebido {
  cabecalhos: Record<string, string | string[] | undefined>;
  corpo: string;
}

/** Receptor de webhooks: responde `{protocolo, link}`. */
export class ReceptorFalso {
  url = '';
  readonly recebidos: WebhookRecebido[] = [];
  private servidor?: Server;

  async iniciar(): Promise<void> {
    const { servidor, url } = await ouvir(async (req, res) => {
      const corpo = await lerCorpo(req);
      this.recebidos.push({ cabecalhos: req.headers, corpo });
      json(res, 200, {
        protocolo: `P-${this.recebidos.length}`,
        link: `https://suporte.exemplo.com/p/${this.recebidos.length}`,
      });
    });
    this.servidor = servidor;
    this.url = url;
  }

  limpar(): void {
    this.recebidos.length = 0;
  }

  parar(): Promise<void> {
    return new Promise((r) =>
      this.servidor ? this.servidor.close(() => r()) : r(),
    );
  }
}
