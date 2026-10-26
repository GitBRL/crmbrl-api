import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  cabecalhoContentDisposition,
  podeExibirNoNavegador,
} from '../../arquivos/politica';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import type { Arquivo } from '../../generated/prisma/client';

/** Assinatura de um link público de arquivo. */
export interface LinkAssinado {
  /** Expira em (segundos desde 1970). */
  e: number;
  /** HMAC-SHA256 (hex) de `escopo:arquivoId:e`. */
  a: string;
}

/**
 * Links públicos e temporários de arquivos (R11): o visitante do chat do site
 * (sem sessão) vê os anexos da conversa, e a Meta baixa o anexo que enviamos,
 * sem que o arquivo fique aberto. O link leva a validade e um HMAC do arquivo e
 * do escopo (`webchat:<visitanteId>`, `meta:<canalId>`) com uma chave derivada
 * da `CHAVE_CRIPTOGRAFIA`; quem não tem o link não baixa nada.
 */
@Injectable()
export class ArquivosPublicos {
  private readonly segredo: string;

  constructor(
    @Inject(AMBIENTE) ambiente: Ambiente,
    private readonly cripto: CriptografiaService,
  ) {
    this.segredo = `${ambiente.chaveCriptografia.toString('hex')}:arquivos-publicos`;
  }

  /** Assina o link do arquivo para o escopo, válido por `validadeMs`. */
  assinar(arquivoId: string, escopo: string, validadeMs: number): LinkAssinado {
    const e = Math.ceil((Date.now() + validadeMs) / 1000);
    return {
      e,
      a: this.cripto.assinarHmac(this.segredo, `${escopo}:${arquivoId}:${e}`),
    };
  }

  /** A assinatura confere e ainda vale? */
  conferir(arquivoId: string, escopo: string, e: unknown, a: unknown): boolean {
    const expira = typeof e === 'string' ? Number(e) : e;
    if (
      typeof expira !== 'number' ||
      !Number.isInteger(expira) ||
      expira * 1000 < Date.now() ||
      typeof a !== 'string'
    ) {
      return false;
    }
    return this.cripto.verificarHmac(
      this.segredo,
      `${escopo}:${arquivoId}:${expira}`,
      a,
    );
  }
}

/**
 * Responde o conteúdo de um arquivo numa rota pública com os mesmos cuidados
 * do download da API (nome seguro, `nosniff`, CSP `sandbox`), mas podendo ser
 * embutido em outro site (`Cross-Origin-Resource-Policy: cross-origin`).
 */
export async function responderArquivoPublico(
  resposta: Response,
  arquivo: Arquivo,
  conteudo: Readable,
): Promise<void> {
  resposta.set({
    'Content-Type': arquivo.mime,
    'Content-Length': String(arquivo.tamanho),
    'Content-Disposition': cabecalhoContentDisposition(
      arquivo.nome,
      podeExibirNoNavegador(arquivo.mime) ? 'inline' : 'attachment',
    ),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ETag: `"${arquivo.sha256}"`,
    ...(arquivo.mime === 'application/pdf'
      ? {}
      : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
  });
  await pipeline(conteudo, resposta);
}
