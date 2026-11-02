/**
 * Server-Sent Events na resposta de um `POST` (R21). O front lê com `fetch` e
 * `ReadableStream` (o `EventSource` só faz `GET`). Cada evento é
 * `event: <nome>\ndata: <json>\n\n`; um comentário `: batimento` a cada 15 s
 * mantém proxies e o Caddy com a conexão aberta enquanto o modelo pensa.
 */
import type { Response } from 'express';
import { INTERVALO_BATIMENTO_MS } from './analise.constantes';

export interface CanalDeEventos {
  enviar(evento: string, dados: unknown): void;
}

export class EmissorSse implements CanalDeEventos {
  private batimento: NodeJS.Timeout | null = null;
  private fechado = false;

  constructor(private readonly resposta: Response) {}

  abrir(): void {
    const r = this.resposta;
    r.status(200);
    r.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    r.setHeader('Cache-Control', 'no-cache, no-transform');
    r.setHeader('Connection', 'keep-alive');
    r.setHeader('X-Accel-Buffering', 'no');
    r.flushHeaders();
    this.batimento = setInterval(() => {
      if (!this.fechado) {
        r.write(': batimento\n\n');
      }
    }, INTERVALO_BATIMENTO_MS);
    r.on('close', () => this.parar());
  }

  enviar(evento: string, dados: unknown): void {
    if (this.fechado || this.resposta.writableEnded) {
      return;
    }
    this.resposta.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  }

  fechar(): void {
    this.parar();
    if (!this.resposta.writableEnded) {
      this.resposta.end();
    }
  }

  private parar(): void {
    this.fechado = true;
    if (this.batimento) {
      clearInterval(this.batimento);
      this.batimento = null;
    }
  }
}
