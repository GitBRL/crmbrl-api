/**
 * Apoio dos testes de integração dos webhooks (`test/webhooks*.e2e-spec.ts`):
 * um servidor HTTP local que faz o papel do destino dos webhooks de saída, a
 * conferência da assinatura como um consumidor faria (R9.3) e o envio de
 * leads ao endereço público de entrada.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { AppTeste } from './utils';

export const FILA_PROCESSAR = 'webhooks-entrada.processar';
export const FILA_ENTREGAR = 'webhooks-saida.entregar';

export interface PedidoRecebido {
  readonly metodo: string;
  readonly caminho: string;
  readonly cabecalhos: IncomingHttpHeaders;
  readonly corpo: string;
}

export interface RespostaProgramada {
  readonly status: number;
  readonly corpo?: string;
}

/**
 * Destino de teste: grava cada pedido e responde com as respostas
 * programadas, na ordem (acabando, usa a `padrao`).
 */
export class ServidorDeTeste {
  readonly recebidos: PedidoRecebido[] = [];
  padrao: RespostaProgramada = { status: 200, corpo: 'ok' };
  url = '';
  private programadas: RespostaProgramada[] = [];
  private servidor?: Server;

  async iniciar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (parte: Buffer) => partes.push(parte));
      req.on('end', () => {
        this.recebidos.push({
          metodo: req.method ?? '',
          caminho: req.url ?? '',
          cabecalhos: req.headers,
          corpo: Buffer.concat(partes).toString('utf8'),
        });
        const resposta = this.programadas.shift() ?? this.padrao;
        res.statusCode = resposta.status;
        res.end(resposta.corpo ?? '');
      });
    });
    await new Promise<void>((resolver) =>
      this.servidor?.listen(0, '127.0.0.1', resolver),
    );
    const { port } = this.servidor.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  responder(...respostas: RespostaProgramada[]): void {
    this.programadas.push(...respostas);
  }

  limpar(): void {
    this.recebidos.length = 0;
    this.programadas = [];
    this.padrao = { status: 200, corpo: 'ok' };
  }

  async parar(): Promise<void> {
    const servidor = this.servidor;
    if (!servidor) {
      return;
    }
    servidor.closeAllConnections();
    await new Promise<void>((resolver) => servidor.close(() => resolver()));
  }
}

/** Uma porta TCP em que ninguém escuta (acabou de ser liberada). */
export async function portaFechada(): Promise<number> {
  const temporario = createServer();
  await new Promise<void>((resolver) =>
    temporario.listen(0, '127.0.0.1', resolver),
  );
  const { port } = temporario.address() as AddressInfo;
  await new Promise<void>((resolver) => temporario.close(() => resolver()));
  return port;
}

/** A assinatura que o destino calcula para conferir (R9.3), sem usar o código da API. */
export function assinaturaEsperada(
  segredo: string,
  timestamp: string,
  corpo: string,
): string {
  return `sha256=${createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex')}`;
}

/** O token no fim da URL do ponto de entrada. */
export function tokenDaUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

/**
 * `POST /api/v1/webhooks/entrada/:token` como um sistema externo: sem cookie e
 * sem `Origin` (R2.9 não se aplica). `corpo` texto vai como veio (bruto).
 */
export function enviarLead(
  t: AppTeste,
  token: string,
  corpo?: string | object,
  cabecalhos: Record<string, string> = {},
): request.Test {
  let pedido = request(t.servidor).post(`/api/v1/webhooks/entrada/${token}`);
  for (const [nome, valor] of Object.entries(cabecalhos)) {
    pedido = pedido.set(nome, valor);
  }
  if (typeof corpo === 'string' && !cabecalhos['Content-Type']) {
    pedido = pedido.set('Content-Type', 'application/json');
  }
  return corpo === undefined ? pedido : pedido.send(corpo);
}

/** HMAC-SHA256 do corpo bruto, como o sistema de origem assina (R8.3). */
export function assinarCorpo(segredo: string, corpo: string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;
}
