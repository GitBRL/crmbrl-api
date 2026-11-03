/**
 * Conversão da gravação com o ffmpeg (já instalado na imagem da API): a versão para ouvir
 * (mono, ogg/opus) e um WAV 16 kHz mono por canal (o canal esquerdo é o atendente; o direito,
 * o cliente) para o whisper. Atrás de uma classe abstrata para os testes trocarem por um falso
 * (o ffmpeg não existe na máquina de desenvolvimento, só no contêiner).
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { TEMPO_LIMITE_DO_FFMPEG_MS } from './transcricao.constantes';

export interface AudioConvertido {
  duracaoSegundos: number;
  canais: number;
  /** Versão para ouvir (mono, ogg/opus). */
  ogg: string;
  /** WAV 16 kHz mono do canal esquerdo (atendente); com áudio mono, o único canal. */
  esquerdo: string;
  /** WAV do canal direito (cliente); `null` se a gravação é mono. */
  direito: string | null;
  /** O volume do canal esquerdo é nulo ou quase: não há fala para transcrever. */
  esquerdoSemFala: boolean;
  /** Idem para o direito; `false` se a gravação é mono. */
  direitoSemFala: boolean;
}

/** Pico (dBFS) abaixo do qual um canal é tratado como mudo: fala fica bem acima, ruído de linha não. */
export const PICO_MINIMO_DE_FALA_DB = -50;

/**
 * Lê a saída do filtro `volumedetect` do ffmpeg e diz se o canal está mudo. Sem a linha de
 * `max_volume` (ou com `-inf`, silêncio digital), só o silêncio digital conta como mudo; o que não
 * der para medir segue para o whisper, que tem o veredito final.
 */
export function canalSemFalaPeloVolume(saidaDoFfmpeg: string): boolean {
  const achado = /max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i.exec(
    saidaDoFfmpeg,
  );
  if (!achado) {
    return false;
  }
  const valor = achado[1].toLowerCase();
  if (valor.endsWith('inf')) {
    return valor.startsWith('-');
  }
  return Number(valor) <= PICO_MINIMO_DE_FALA_DB;
}

export abstract class ProcessadorDeAudio {
  /** Converte `entrada` (webm) e grava os resultados em `pasta`. Lança se o ffmpeg falhar. */
  abstract converter(entrada: string, pasta: string): Promise<AudioConvertido>;
}

function executar(
  programa: string,
  argumentos: readonly string[],
): Promise<string> {
  return new Promise((resolver, rejeitar) => {
    execFile(
      programa,
      [...argumentos],
      { timeout: TEMPO_LIMITE_DO_FFMPEG_MS, maxBuffer: 4 * 1024 * 1024 },
      (erro, saida) => {
        if (erro) {
          // O stderr do ffmpeg pode citar caminhos; só o motivo segue adiante.
          const motivo =
            (erro as NodeJS.ErrnoException).code ??
            (erro.killed ? 'tempo' : 'erro');
          rejeitar(new Error(`${programa} falhou (${String(motivo)})`));
          return;
        }
        resolver(saida);
      },
    );
  });
}

/** Mede o pico do WAV com `volumedetect`; se a medição falhar, devolve `false` (o whisper decide). */
function medirSemFala(wav: string): Promise<boolean> {
  return new Promise((resolver) => {
    execFile(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-i',
        wav,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ],
      { timeout: TEMPO_LIMITE_DO_FFMPEG_MS, maxBuffer: 4 * 1024 * 1024 },
      (erro, _saida, saidaDeErro) => {
        resolver(erro ? false : canalSemFalaPeloVolume(saidaDeErro));
      },
    );
  });
}

const BASE = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'] as const;

@Injectable()
export class ProcessadorFfmpeg extends ProcessadorDeAudio {
  async converter(entrada: string, pasta: string): Promise<AudioConvertido> {
    const sonda = await executar('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'json',
      entrada,
    ]);
    const dados = JSON.parse(sonda) as { streams?: { channels?: number }[] };
    const canais = dados.streams?.[0]?.channels ?? 1;
    const ogg = join(pasta, 'ouvir.ogg');
    const esquerdo = join(pasta, 'esquerdo.wav');
    const direito = canais >= 2 ? join(pasta, 'direito.wav') : null;

    await executar('ffmpeg', [
      ...BASE,
      '-i',
      entrada,
      '-vn',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      ogg,
    ]);
    // O webm do MediaRecorder não traz a duração no cabeçalho: ela vem do ogg já gerado.
    const duracao = JSON.parse(
      await executar('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        ogg,
      ]),
    ) as { format?: { duration?: string } };
    const segundos = Number(duracao.format?.duration);
    const duracaoSegundos = Number.isFinite(segundos)
      ? Math.max(0, Math.round(segundos))
      : 0;
    const wav = ['-vn', '-ar', '16000', '-c:a', 'pcm_s16le'] as const;
    if (direito) {
      await executar('ffmpeg', [
        ...BASE,
        '-i',
        entrada,
        '-af',
        'pan=mono|c0=c0',
        ...wav,
        esquerdo,
      ]);
      await executar('ffmpeg', [
        ...BASE,
        '-i',
        entrada,
        '-af',
        'pan=mono|c0=c1',
        ...wav,
        direito,
      ]);
    } else {
      await executar('ffmpeg', [
        ...BASE,
        '-i',
        entrada,
        '-ac',
        '1',
        ...wav,
        esquerdo,
      ]);
    }
    return {
      duracaoSegundos,
      canais,
      ogg,
      esquerdo,
      direito,
      esquerdoSemFala: await medirSemFala(esquerdo),
      direitoSemFala: direito ? await medirSemFala(direito) : false,
    };
  }
}
