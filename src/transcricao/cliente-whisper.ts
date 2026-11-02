/**
 * Cliente do whisper-server (whisper.cpp, `POST /inference`) do serviço `transcricao`.
 * Manda um WAV 16 kHz mono por vez e devolve os trechos com tempo. Uma transcrição por
 * vez é garantido pela fila (concorrência 1) e pelo próprio servidor.
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type { TrechoBruto } from './trechos';
import { TEMPO_DA_SAUDE_MS } from './transcricao.constantes';

/** Falha ao falar com o serviço de transcrição; `transitoria` = vale tentar de novo. */
export class ErroDeTranscricao extends Error {
  constructor(
    mensagem: string,
    readonly transitoria: boolean,
  ) {
    super(mensagem);
    this.name = 'ErroDeTranscricao';
  }
}

export interface RespostaDoWhisper {
  idioma: string | null;
  trechos: TrechoBruto[];
}

function numero(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** Lê a resposta `verbose_json` do whisper-server (segmentos com `start`, `end` e `text`). */
export function lerRespostaDoWhisper(corpo: unknown): RespostaDoWhisper {
  if (typeof corpo !== 'object' || corpo === null) {
    throw new ErroDeTranscricao(
      'O serviço de transcrição respondeu num formato inesperado.',
      false,
    );
  }
  const r = corpo as Record<string, unknown>;
  if (typeof r.error === 'string') {
    throw new ErroDeTranscricao(
      'O serviço de transcrição recusou o áudio.',
      false,
    );
  }
  const idioma = typeof r.language === 'string' ? r.language : null;
  if (Array.isArray(r.segments)) {
    const trechos = r.segments
      .filter(
        (s): s is Record<string, unknown> =>
          typeof s === 'object' && s !== null,
      )
      .map((s) => ({
        inicio: numero(s.start),
        fim: numero(s.end),
        texto: typeof s.text === 'string' ? s.text : '',
      }));
    return { idioma, trechos };
  }
  if (typeof r.text === 'string') {
    return {
      idioma,
      trechos: [{ inicio: 0, fim: numero(r.duration), texto: r.text }],
    };
  }
  throw new ErroDeTranscricao(
    'O serviço de transcrição respondeu num formato inesperado.',
    false,
  );
}

@Injectable()
export class ClienteWhisper {
  constructor(@Inject(AMBIENTE) private readonly ambiente: Ambiente) {}

  /** A transcrição está ligada (`TRANSCRICAO_URL` preenchida)? */
  get ligado(): boolean {
    return this.ambiente.transcricao.url !== null;
  }

  /** Transcreve um WAV em português, dentro do prazo (os erros de rede e 5xx são transitórios). */
  async transcrever(
    caminhoDoWav: string,
    prazoMs: number,
  ): Promise<RespostaDoWhisper> {
    const base = this.ambiente.transcricao.url;
    if (!base) {
      throw new ErroDeTranscricao('A transcrição está desligada.', false);
    }
    const formulario = new FormData();
    formulario.set(
      'file',
      await openAsBlob(caminhoDoWav),
      basename(caminhoDoWav),
    );
    formulario.set('temperature', '0.0');
    formulario.set('response_format', 'verbose_json');
    formulario.set('language', 'pt');
    let resposta: Response;
    try {
      resposta = await fetch(new URL('/inference', `${base}/`), {
        method: 'POST',
        body: formulario,
        signal: AbortSignal.timeout(prazoMs),
      });
    } catch (erro) {
      const nome = (erro as { name?: unknown } | null)?.name;
      const esgotou = nome === 'TimeoutError' || nome === 'AbortError';
      throw new ErroDeTranscricao(
        esgotou
          ? 'A transcrição passou do tempo limite.'
          : 'Não foi possível falar com o serviço de transcrição.',
        true,
      );
    }
    if (!resposta.ok) {
      await resposta.body?.cancel().catch(() => undefined);
      throw new ErroDeTranscricao(
        `O serviço de transcrição respondeu com erro (HTTP ${resposta.status}).`,
        resposta.status >= 500 || resposta.status === 429,
      );
    }
    let corpo: unknown;
    try {
      corpo = await resposta.json();
    } catch {
      throw new ErroDeTranscricao(
        'O serviço de transcrição respondeu num formato inesperado.',
        true,
      );
    }
    return lerRespostaDoWhisper(corpo);
  }

  /** Consulta o `/health` do whisper-server (para a tela Saúde do sistema). */
  async saude(): Promise<'ok' | 'fora_do_ar' | 'desativada'> {
    const base = this.ambiente.transcricao.url;
    if (!base) {
      return 'desativada';
    }
    try {
      const resposta = await fetch(new URL('/health', `${base}/`), {
        signal: AbortSignal.timeout(TEMPO_DA_SAUDE_MS),
      });
      await resposta.body?.cancel().catch(() => undefined);
      return resposta.ok ? 'ok' : 'fora_do_ar';
    } catch {
      return 'fora_do_ar';
    }
  }
}
