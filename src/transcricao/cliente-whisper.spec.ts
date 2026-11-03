import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ambiente } from '../config/ambiente';
import {
  ClienteWhisper,
  ErroDeTranscricao,
  lerRespostaDoWhisper,
} from './cliente-whisper';

describe('R30 — cliente do whisper-server', () => {
  it('R30.22 — lê os segmentos do verbose_json', () => {
    expect(
      lerRespostaDoWhisper({
        language: 'portuguese',
        segments: [
          { start: 0.5, end: 2, text: ' Oi' },
          { start: 'x', end: null, text: 7 },
        ],
      }),
    ).toEqual({
      idioma: 'portuguese',
      trechos: [
        { inicio: 0.5, fim: 2, texto: ' Oi' },
        { inicio: 0, fim: 0, texto: '' },
      ],
    });
    expect(
      lerRespostaDoWhisper({ text: 'Só texto', duration: 3 }).trechos,
    ).toEqual([{ inicio: 0, fim: 3, texto: 'Só texto' }]);
    expect(() => lerRespostaDoWhisper(null)).toThrow(ErroDeTranscricao);
    expect(() => lerRespostaDoWhisper({ error: 'x' })).toThrow(
      ErroDeTranscricao,
    );
    expect(() => lerRespostaDoWhisper({})).toThrow(ErroDeTranscricao);
  });

  describe('contra um servidor falso', () => {
    let servidor: Server;
    let url: string;
    let pasta: string;
    let wav: string;
    let modo: 'ok' | 'lento' | '500' | '400' | 'lixo' = 'ok';
    let corpoRecebido = '';

    beforeAll(async () => {
      servidor = createServer((req, res) => {
        const partes: Buffer[] = [];
        req.on('data', (p: Buffer) => partes.push(p));
        req.on('end', () => {
          if (req.url === '/health') {
            res.writeHead(200).end('{"status":"ok"}');
            return;
          }
          corpoRecebido = Buffer.concat(partes).toString('latin1');
          if (modo === 'lento') {
            setTimeout(() => res.writeHead(200).end('{}'), 2000);
            return;
          }
          if (modo === '500') {
            res.writeHead(500).end('erro');
            return;
          }
          if (modo === '400') {
            res.writeHead(400).end('erro');
            return;
          }
          if (modo === 'lixo') {
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end('não é json');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              segments: [{ start: 0, end: 1, text: ' Olá' }],
            }),
          );
        });
      });
      await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
      url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
      pasta = await mkdtemp(join(tmpdir(), 'whisper-spec-'));
      wav = join(pasta, 'esquerdo.wav');
      await writeFile(wav, Buffer.from('RIFFfake'));
    });
    afterAll(async () => {
      servidor.close();
      await rm(pasta, { recursive: true, force: true });
    });

    const cliente = (urlDoServico: string | null) =>
      new ClienteWhisper({
        transcricao: { url: urlDoServico },
      } as unknown as Ambiente);

    it('R30.22 — manda o WAV em português com tempos e lê a resposta', async () => {
      modo = 'ok';
      const r = await cliente(url).transcrever(wav, 5000);
      expect(r.trechos).toEqual([{ inicio: 0, fim: 1, texto: ' Olá' }]);
      expect(corpoRecebido).toContain('name="language"');
      expect(corpoRecebido).toContain('pt');
      expect(corpoRecebido).toContain('verbose_json');
      expect(corpoRecebido).toContain('filename="esquerdo.wav"');
    });

    it('R30.22 — tempo limite e 5xx são transitórios; 4xx e resposta ilegível, não', async () => {
      modo = 'lento';
      await expect(cliente(url).transcrever(wav, 150)).rejects.toMatchObject({
        transitoria: true,
        message: expect.stringContaining('tempo limite'),
      });
      modo = '500';
      await expect(cliente(url).transcrever(wav, 2000)).rejects.toMatchObject({
        transitoria: true,
      });
      modo = '400';
      await expect(cliente(url).transcrever(wav, 2000)).rejects.toMatchObject({
        transitoria: false,
      });
      modo = 'lixo';
      await expect(cliente(url).transcrever(wav, 2000)).rejects.toBeInstanceOf(
        ErroDeTranscricao,
      );
    });

    it('R30.22 — serviço fora do ar é falha transitória; desligado recusa', async () => {
      await expect(
        cliente('http://127.0.0.1:1').transcrever(wav, 1000),
      ).rejects.toMatchObject({ transitoria: true });
      await expect(cliente(null).transcrever(wav, 1000)).rejects.toMatchObject({
        transitoria: false,
      });
    });

    it('R30.22 — saúde: ok, fora do ar e desativada', async () => {
      expect(await cliente(url).saude()).toBe('ok');
      expect(await cliente('http://127.0.0.1:1').saude()).toBe('fora_do_ar');
      expect(await cliente(null).saude()).toBe('desativada');
      expect(cliente(null).ligado).toBe(false);
    });
  });
});
