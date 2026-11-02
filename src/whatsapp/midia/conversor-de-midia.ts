/**
 * Conversões de mídia do gateway com o `ffmpeg` (instalado na imagem pelo
 * `apk`, §2.3):
 *
 * - **voz**: o áudio gravado no navegador (webm/opus no Chrome e no Firefox,
 *   mp4/aac no Safari) vira ogg/opus mono a 48 kHz — o formato das mensagens de
 *   voz do WhatsApp (o celular mostra a onda e toca como recado);
 * - **miniatura**: JPEG pequeno da primeira imagem/quadro, que o WhatsApp
 *   mostra enquanto a foto ou o vídeo baixa (melhor esforço).
 *
 * A entrada vai para um arquivo temporário (o mp4 do Safari não é lido por um
 * pipe: o índice fica no fim do arquivo) e é apagada em seguida; a saída sai
 * pelo stdout. Cada conversão tem prazo e teto de tamanho.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** MIME das mensagens de voz do WhatsApp. */
export const MIME_DA_VOZ = 'audio/ogg; codecs=opus';

/** O `ffmpeg` não está instalado (ou não executa). */
export class ConversorIndisponivelError extends Error {
  constructor() {
    super('O ffmpeg não está disponível neste servidor.');
    this.name = 'ConversorIndisponivelError';
  }
}

/** O `ffmpeg` rodou e falhou (arquivo corrompido, formato desconhecido, prazo). */
export class FalhaDeConversaoError extends Error {
  constructor(detalhe: string) {
    super(`A conversão da mídia falhou: ${detalhe}`);
    this.name = 'FalhaDeConversaoError';
  }
}

export interface OpcoesDoConversor {
  /** Caminho do executável (padrão: `ffmpeg` do PATH). */
  executavel?: string;
  /** Prazo de cada conversão de áudio (padrão: 60 s). */
  prazoMs?: number;
  /** Teto da saída (padrão: 30 MB). */
  maximoBytes?: number;
}

const PRAZO_PADRAO_MS = 60_000;
const PRAZO_DA_MINIATURA_MS = 10_000;
const MAXIMO_PADRAO_BYTES = 30 * 1024 * 1024;
/** Lado maior da miniatura, em pixels (o WhatsApp usa miniaturas pequenas e borradas). */
const LADO_DA_MINIATURA = 72;

export class ConversorDeMidia {
  private readonly executavel: string;
  private readonly prazoMs: number;
  private readonly maximoBytes: number;

  constructor(opcoes: OpcoesDoConversor = {}) {
    this.executavel = opcoes.executavel ?? 'ffmpeg';
    this.prazoMs = opcoes.prazoMs ?? PRAZO_PADRAO_MS;
    this.maximoBytes = opcoes.maximoBytes ?? MAXIMO_PADRAO_BYTES;
  }

  /** Áudio qualquer → ogg/opus mono 48 kHz (mensagem de voz). */
  paraVoz(conteudo: Buffer, nome = 'audio'): Promise<Buffer> {
    return this.converter(
      conteudo,
      nome,
      [
        '-vn',
        '-map_metadata',
        '-1',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-application',
        'voip',
        '-f',
        'ogg',
      ],
      this.prazoMs,
    );
  }

  /**
   * Miniatura JPEG (base64) da imagem ou do primeiro quadro do vídeo, ou
   * `undefined` se não deu (melhor esforço: o envio segue sem ela).
   */
  async miniatura(
    conteudo: Buffer,
    nome = 'midia',
  ): Promise<string | undefined> {
    try {
      const jpeg = await this.converter(
        conteudo,
        nome,
        [
          '-frames:v',
          '1',
          '-vf',
          `scale=${LADO_DA_MINIATURA}:${LADO_DA_MINIATURA}:force_original_aspect_ratio=decrease`,
          '-q:v',
          '8',
          '-f',
          'image2',
          '-c:v',
          'mjpeg',
        ],
        PRAZO_DA_MINIATURA_MS,
      );
      return jpeg.length > 0 ? jpeg.toString('base64') : undefined;
    } catch {
      return undefined;
    }
  }

  private async converter(
    conteudo: Buffer,
    nome: string,
    argumentosDeSaida: string[],
    prazoMs: number,
  ): Promise<Buffer> {
    const pasta = await mkdtemp(join(tmpdir(), 'crmbrl-midia-'));
    const entrada = join(pasta, `entrada${extensaoSegura(nome)}`);
    try {
      await writeFile(entrada, conteudo, { mode: 0o600 });
      return await this.executar(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-i',
          entrada,
          ...argumentosDeSaida,
          'pipe:1',
        ],
        prazoMs,
      );
    } finally {
      await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private executar(argumentos: string[], prazoMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolver, rejeitar) => {
      const processo = spawn(this.executavel, argumentos, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(prazoMs),
      });
      const partes: Buffer[] = [];
      let tamanho = 0;
      let erros = '';
      let estourou = false;
      processo.stdout.on('data', (parte: Buffer) => {
        tamanho += parte.length;
        if (tamanho > this.maximoBytes) {
          estourou = true;
          processo.kill('SIGKILL');
          return;
        }
        partes.push(parte);
      });
      processo.stderr.on('data', (parte: Buffer) => {
        if (erros.length < 2_000) {
          erros += parte.toString('utf8');
        }
      });
      processo.on('error', (erro: NodeJS.ErrnoException) => {
        if (erro.code === 'ENOENT' || erro.code === 'EACCES') {
          rejeitar(new ConversorIndisponivelError());
          return;
        }
        rejeitar(
          new FalhaDeConversaoError(
            erro.name === 'AbortError' ? 'demorou demais' : erro.message,
          ),
        );
      });
      processo.on('close', (codigo) => {
        if (estourou) {
          rejeitar(
            new FalhaDeConversaoError('o resultado ficou grande demais'),
          );
          return;
        }
        if (codigo !== 0) {
          rejeitar(
            new FalhaDeConversaoError(
              erros.trim().split('\n').at(-1) || `código ${codigo}`,
            ),
          );
          return;
        }
        resolver(Buffer.concat(partes));
      });
    });
  }
}

/** Só a extensão do nome, e só se for simples (o ffmpeg usa a extensão como dica de formato). */
function extensaoSegura(nome: string): string {
  const extensao = /\.([a-z0-9]{1,8})$/i.exec(nome)?.[1];
  return extensao ? `.${extensao.toLowerCase()}` : '';
}
