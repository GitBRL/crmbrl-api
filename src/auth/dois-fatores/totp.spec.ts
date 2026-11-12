import {
  codificarBase32,
  decodificarBase32,
  gerarCodigoDeRecuperacao,
  gerarSegredoBase32,
  gerarTotp,
  hotp,
  normalizarCodigo,
  passoDe,
  urlOtpauth,
  verificarTotp,
} from './totp';

// Segredo ASCII "12345678901234567890" dos vetores da RFC 6238 (SHA-1).
const SEGREDO = codificarBase32(Buffer.from('12345678901234567890'));

describe('TOTP (R2.11)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('R2.11 — vetor da RFC 6238 em %i s (8 dígitos)', (segundos, esperado) => {
    expect(gerarTotp(SEGREDO, segundos * 1000, 8)).toBe(esperado);
  });

  it('R2.11 — 6 dígitos são os 6 últimos do vetor de 8', () => {
    expect(gerarTotp(SEGREDO, 59_000)).toBe('287082');
  });

  it('R2.11 — HOTP da RFC 4226 (contador 0 e 1)', () => {
    const segredo = Buffer.from('12345678901234567890');
    expect(hotp(segredo, 0)).toBe('755224');
    expect(hotp(segredo, 1)).toBe('287082');
  });

  describe('janela ±1', () => {
    const agora = 1_700_000_000_000;
    const passo = 30_000;
    it('R2.11 — aceita o passo atual, o anterior e o seguinte', () => {
      const atual = passoDe(agora);
      expect(verificarTotp(SEGREDO, gerarTotp(SEGREDO, agora), agora)).toBe(
        atual,
      );
      expect(
        verificarTotp(SEGREDO, gerarTotp(SEGREDO, agora - passo), agora),
      ).toBe(atual - 1);
      expect(
        verificarTotp(SEGREDO, gerarTotp(SEGREDO, agora + passo), agora),
      ).toBe(atual + 1);
    });

    it('R2.11 — recusa dois passos de distância, código curto e não numérico', () => {
      expect(
        verificarTotp(SEGREDO, gerarTotp(SEGREDO, agora - 2 * passo), agora),
      ).toBeNull();
      expect(
        verificarTotp(SEGREDO, gerarTotp(SEGREDO, agora + 2 * passo), agora),
      ).toBeNull();
      expect(verificarTotp(SEGREDO, '12345', agora)).toBeNull();
      expect(verificarTotp(SEGREDO, 'abcdef', agora)).toBeNull();
    });
  });

  describe('base32', () => {
    it('R2.11 — vetores da RFC 4648 (sem preenchimento)', () => {
      expect(codificarBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
      expect(codificarBase32(Buffer.from('fooba'))).toBe('MZXW6YTB');
      expect(codificarBase32(Buffer.from('f'))).toBe('MY');
      expect(decodificarBase32('MZXW6YTBOI======').toString()).toBe('foobar');
    });

    it('R2.11 — decodifica minúsculas e espaços; recusa caractere inválido', () => {
      expect(decodificarBase32('mzxw 6ytb-oi').toString()).toBe('foobar');
      expect(() => decodificarBase32('MZXW1')).toThrow();
    });

    it('R2.11 — o segredo gerado tem 32 caracteres e volta aos mesmos 20 bytes', () => {
      const segredo = gerarSegredoBase32();
      expect(segredo).toMatch(/^[A-Z2-7]{32}$/);
      expect(codificarBase32(decodificarBase32(segredo))).toBe(segredo);
    });
  });

  it('R2.11 — otpauth com emissor, conta e parâmetros', () => {
    const url = urlOtpauth(SEGREDO, 'ana@brl.com.br', 'BRL CRM');
    expect(url).toContain('otpauth://totp/BRL%20CRM:ana%40brl.com.br?');
    expect(url).toContain(`secret=${SEGREDO}`);
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });

  it('R2.11 — código de recuperação legível e normalização', () => {
    const codigo = gerarCodigoDeRecuperacao();
    expect(codigo).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    expect(normalizarCodigo(` ${codigo.toLowerCase()} `)).toBe(
      codigo.replace('-', ''),
    );
  });
});
