import { canalSemFalaPeloVolume } from './processador-de-audio';

const saida = (max: string) =>
  `[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: ${max} dB\n`;

describe('R30 — canal sem fala pelo volume', () => {
  it('R30.3 — pico muito baixo ou silêncio digital: sem fala', () => {
    expect(canalSemFalaPeloVolume(saida('-inf'))).toBe(true);
    expect(canalSemFalaPeloVolume(saida('-72.5'))).toBe(true);
    expect(canalSemFalaPeloVolume(saida('-50.0'))).toBe(true);
  });

  it('R30.3 — fala, tom ou saída ilegível: segue para o whisper', () => {
    expect(canalSemFalaPeloVolume(saida('-18.2'))).toBe(false);
    expect(canalSemFalaPeloVolume(saida('0.0'))).toBe(false);
    expect(canalSemFalaPeloVolume('ffmpeg falhou')).toBe(false);
    expect(canalSemFalaPeloVolume('max_volume: inf dB')).toBe(false);
  });
});
