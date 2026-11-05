import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { lerAmbiente } from '../../config/ambiente';
import { ConexoesFacebookService } from './conexoes-facebook.service';

const ambiente = lerAmbiente({
  DATABASE_URL: 'postgresql://a:b@localhost:5432/c',
  NODE_ENV: 'test',
  CHAVE_CRIPTOGRAFIA: '0f'.repeat(32),
  URL_PUBLICA: 'https://crm.exemplo.com.br',
});
const cripto = new CriptografiaService(ambiente);

const servico = (linhas: { tokenVerificacaoCifrado: string | null }[]) =>
  new ConexoesFacebookService(
    { conexaoFacebook: { findMany: () => Promise.resolve(linhas) } } as never,
    cripto,
    {} as never,
    {} as never,
    {} as never,
    { tokenDeVerificacaoValido: () => Promise.resolve(false) } as never,
    ambiente,
  );

describe('Facebook Lead Ads — token de verificação do webhook (R32.14)', () => {
  it('R32.14 — o token de qualquer conexão vale; outro, vazio ou ilegível não', async () => {
    const s = servico([
      { tokenVerificacaoCifrado: cripto.cifrar('token-a') },
      { tokenVerificacaoCifrado: 'lixo-que-nao-decifra' },
      { tokenVerificacaoCifrado: cripto.cifrar('token-b') },
    ]);
    expect(await s.tokenDeVerificacaoValido('token-a')).toBe(true);
    expect(await s.tokenDeVerificacaoValido('token-b')).toBe(true);
    expect(await s.tokenDeVerificacaoValido('token-c')).toBe(false);
    expect(await s.tokenDeVerificacaoValido('')).toBe(false);
  });

  it('R32.14 — sem conexões nenhum token vale; o endereço do webhook é o da Meta', async () => {
    const s = servico([]);
    expect(await s.tokenDeVerificacaoValido('qualquer')).toBe(false);
    expect(s.urlDoWebhook).toBe(
      'https://crm.exemplo.com.br/api/v1/publico/meta/webhook',
    );
  });
});
