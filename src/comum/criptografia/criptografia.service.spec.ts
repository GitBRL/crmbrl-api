import { createHmac } from 'node:crypto';
import { lerAmbiente } from '../../config/ambiente';
import { CriptografiaService, PARAMETROS_SCRYPT } from './criptografia.service';

const ambiente = lerAmbiente({
  DATABASE_URL: 'postgresql://a:b@localhost:5432/c',
  NODE_ENV: 'test',
  CHAVE_CRIPTOGRAFIA: '0f'.repeat(32),
});

describe('CriptografiaService', () => {
  const cripto = new CriptografiaService(ambiente);

  describe('senhas (R2.1)', () => {
    let hash: string;

    beforeAll(async () => {
      hash = await cripto.hashSenha('minha senha secreta');
    });

    it('grava scrypt$N$r$p$sal$hash com N=32768, r=8, p=3, sal de 16 e chave de 64 bytes', () => {
      const [algoritmo, N, r, p, sal, chave] = hash.split('$');
      expect([algoritmo, N, r, p]).toEqual(['scrypt', '32768', '8', '3']);
      expect(Buffer.from(sal, 'base64')).toHaveLength(16);
      expect(Buffer.from(chave, 'base64')).toHaveLength(64);
      expect(PARAMETROS_SCRYPT).toMatchObject({ N: 32_768, r: 8, p: 3 });
    });

    it('confere a senha certa e recusa a errada', async () => {
      await expect(
        cripto.verificarSenha('minha senha secreta', hash),
      ).resolves.toBe(true);
      await expect(
        cripto.verificarSenha('minha senha secret', hash),
      ).resolves.toBe(false);
    });

    it('usa sal aleatório: a mesma senha gera hashes diferentes', async () => {
      expect(await cripto.hashSenha('minha senha secreta')).not.toBe(hash);
    });

    it('sem hash (usuário inexistente ou sem senha) devolve falso, gastando o mesmo trabalho', async () => {
      await expect(cripto.verificarSenha('qualquer', null)).resolves.toBe(
        false,
      );
      await expect(
        cripto.verificarSenha('qualquer', 'formato-estranho'),
      ).resolves.toBe(false);
    });

    it('sabe quando o hash foi feito com outros parâmetros', () => {
      expect(cripto.precisaRefazerHash(hash)).toBe(false);
      expect(
        cripto.precisaRefazerHash(hash.replace('$32768$', '$16384$')),
      ).toBe(true);
      expect(cripto.precisaRefazerHash('bcrypt$xyz')).toBe(true);
    });
  });

  describe('tokens', () => {
    it('gera tokens de 32 bytes em base64url, sempre diferentes', () => {
      const token = cripto.gerarToken();
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(cripto.gerarToken()).not.toBe(token);
    });

    it('calcula o SHA-256 em hexadecimal', () => {
      expect(cripto.sha256('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('cifra AES-256-GCM (R10.3)', () => {
    it('cifra e decifra, com IV aleatório', () => {
      const cifrado = cripto.cifrar('segredo-do-webhook');
      expect(cifrado).toMatch(/^v1\./);
      expect(cifrado).not.toContain('segredo');
      expect(cripto.cifrar('segredo-do-webhook')).not.toBe(cifrado);
      expect(cripto.decifrar(cifrado)).toBe('segredo-do-webhook');
    });

    it('recusa texto adulterado e chave diferente', () => {
      const cifrado = cripto.cifrar('segredo');
      const partes = cifrado.split('.');
      const adulterado = [
        ...partes.slice(0, 3),
        Buffer.from('outra coisa').toString('base64url'),
      ].join('.');
      expect(() => cripto.decifrar(adulterado)).toThrow();
      const outra = new CriptografiaService(
        lerAmbiente({
          DATABASE_URL: 'postgresql://a:b@localhost:5432/c',
          CHAVE_CRIPTOGRAFIA: 'aa'.repeat(32),
        }),
      );
      expect(() => outra.decifrar(cifrado)).toThrow();
      expect(() => cripto.decifrar('formato-invalido')).toThrow(
        'formato desconhecido',
      );
    });

    it('mascara segredos mostrando só o fim', () => {
      expect(cripto.mascarar('abcdefghijklmnop')).toBe('••••••••mnop');
      expect(cripto.mascarar('curto')).toBe('••••••••');
    });
  });

  describe('HMAC (R8.3, R9.3)', () => {
    const esperado = createHmac('sha256', 'segredo')
      .update('corpo')
      .digest('hex');

    it('assina e confere, aceitando o prefixo sha256=', () => {
      expect(cripto.assinarHmac('segredo', 'corpo')).toBe(esperado);
      expect(
        cripto.verificarHmac('segredo', 'corpo', `sha256=${esperado}`),
      ).toBe(true);
      expect(
        cripto.verificarHmac(
          'segredo',
          Buffer.from('corpo'),
          esperado.toUpperCase(),
        ),
      ).toBe(true);
    });

    it('recusa assinatura errada, ausente ou malformada', () => {
      expect(cripto.verificarHmac('outro', 'corpo', esperado)).toBe(false);
      expect(cripto.verificarHmac('segredo', 'corpo alterado', esperado)).toBe(
        false,
      );
      expect(cripto.verificarHmac('segredo', 'corpo', undefined)).toBe(false);
      expect(cripto.verificarHmac('segredo', 'corpo', 'sha256=xyz')).toBe(
        false,
      );
    });

    it('compara textos com segurança', () => {
      expect(cripto.compararSeguro('abc', 'abc')).toBe(true);
      expect(cripto.compararSeguro('abc', 'abd')).toBe(false);
      expect(cripto.compararSeguro('abc', 'abcd')).toBe(false);
    });
  });
});
