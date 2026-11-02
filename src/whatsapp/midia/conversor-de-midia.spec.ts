import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversorDeMidia,
  ConversorIndisponivelError,
  FalhaDeConversaoError,
} from './conversor-de-midia';

/**
 * Um `ffmpeg` de mentira (script de shell): grava os argumentos num arquivo,
 * falha se a entrada contém "FALHAR", demora se contém "DEMORAR" e, senão,
 * escreve "CONVERTIDO:" + a entrada no stdout.
 */
const SCRIPT = `#!/bin/sh
entrada=""
anterior=""
for argumento in "$@"; do
  if [ "$anterior" = "-i" ]; then entrada="$argumento"; fi
  anterior="$argumento"
done
printf '%s\\n' "$@" > "$(dirname "$0")/argumentos.txt"
if grep -q FALHAR "$entrada"; then
  echo "Invalid data found when processing input" >&2
  exit 1
fi
if grep -q DEMORAR "$entrada"; then
  exec sleep 5
fi
printf 'CONVERTIDO:'
cat "$entrada"
`;

describe('ConversorDeMidia (ffmpeg)', () => {
  let pasta: string;
  let executavel: string;
  let argumentos: string;

  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'ffmpeg-falso-'));
    executavel = join(pasta, 'ffmpeg');
    argumentos = join(pasta, 'argumentos.txt');
    await writeFile(executavel, SCRIPT);
    await chmod(executavel, 0o755);
  });

  afterAll(async () => {
    await rm(pasta, { recursive: true, force: true });
  });

  const lerArgumentos = async () =>
    (await readFile(argumentos, 'utf8')).trim().split('\n');

  it('voz: ogg/opus mono 48 kHz pelo stdout, e o temporário some', async () => {
    const conversor = new ConversorDeMidia({ executavel });
    const saida = await conversor.paraVoz(Buffer.from('webm'), 'gravacao.webm');
    expect(saida.toString()).toBe('CONVERTIDO:webm');
    const lista = await lerArgumentos();
    const entrada = lista[lista.indexOf('-i') + 1];
    expect(entrada).toMatch(/entrada\.webm$/);
    expect(existsSync(entrada)).toBe(false);
    expect(lista).toEqual(
      expect.arrayContaining(['-c:a', 'libopus', '-ac', '1', '-ar', '48000']),
    );
    expect(lista.slice(-3)).toEqual(['-f', 'ogg', 'pipe:1']);
  });

  it('falha do ffmpeg vira FalhaDeConversaoError com a última linha do erro', async () => {
    const conversor = new ConversorDeMidia({ executavel });
    await expect(
      conversor.paraVoz(Buffer.from('FALHAR'), 'x.webm'),
    ).rejects.toThrow(
      new FalhaDeConversaoError('Invalid data found when processing input'),
    );
  });

  it('sem o executável: ConversorIndisponivelError', async () => {
    const conversor = new ConversorDeMidia({
      executavel: join(pasta, 'nao-existe'),
    });
    await expect(conversor.paraVoz(Buffer.from('x'))).rejects.toBeInstanceOf(
      ConversorIndisponivelError,
    );
  });

  it('prazo e teto de tamanho', async () => {
    await expect(
      new ConversorDeMidia({ executavel, prazoMs: 200 }).paraVoz(
        Buffer.from('DEMORAR'),
      ),
    ).rejects.toBeInstanceOf(FalhaDeConversaoError);
    await expect(
      new ConversorDeMidia({ executavel, maximoBytes: 5 }).paraVoz(
        Buffer.from('conteúdo grande'),
      ),
    ).rejects.toThrow(/grande demais/);
  });

  it('miniatura em base64, ou undefined se não deu', async () => {
    const conversor = new ConversorDeMidia({ executavel });
    expect(await conversor.miniatura(Buffer.from('png'), 'foto.png')).toBe(
      Buffer.from('CONVERTIDO:png').toString('base64'),
    );
    expect((await lerArgumentos()).slice(-3)).toEqual([
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    expect(
      await conversor.miniatura(Buffer.from('FALHAR'), 'foto.png'),
    ).toBeUndefined();
    expect(
      await new ConversorDeMidia({
        executavel: join(pasta, 'nao-existe'),
      }).miniatura(Buffer.from('png')),
    ).toBeUndefined();
  });
});
