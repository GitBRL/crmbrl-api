import { ehSenhaComum, SENHAS_COMUNS } from './senhas-comuns';

describe('R2.12 — senhas comuns', () => {
  it('reconhece senhas da lista sem diferença de maiúsculas', () => {
    expect(ehSenhaComum('12345678')).toBe(true);
    expect(ehSenhaComum('Senha@123')).toBe(true);
    expect(ehSenhaComum('PASSWORD')).toBe(true);
    expect(ehSenhaComum('Flamengo')).toBe(true);
  });

  it('aceita senhas fora da lista', () => {
    expect(ehSenhaComum('cavalo-bateria-grampo-37')).toBe(false);
    expect(ehSenhaComum('Senha@Teste123')).toBe(false);
  });

  it('a lista só tem entradas em minúsculas e com 8 ou mais caracteres', () => {
    for (const senha of SENHAS_COMUNS) {
      expect(senha).toBe(senha.toLowerCase());
      expect(senha.length).toBeGreaterThanOrEqual(8);
    }
    expect(SENHAS_COMUNS.length).toBeGreaterThanOrEqual(200);
  });
});
