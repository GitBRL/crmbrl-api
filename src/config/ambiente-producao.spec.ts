import {
  ARQUIVOS_SEGREDO_DESENVOLVIMENTO,
  lerAmbiente,
  type VariaveisDeAmbiente,
} from './ambiente';

const PRODUCAO: VariaveisDeAmbiente = {
  DATABASE_URL: 'postgresql://crmbrl:senha-forte-123@banco:5432/crmbrl',
  NODE_ENV: 'production',
  URL_PUBLICA: 'https://crm.brl.com.br',
  CHAVE_CRIPTOGRAFIA: Buffer.alloc(32, 9).toString('base64'),
  ARQUIVOS_ENDPOINT: 'http://arquivos:9000',
  ARQUIVOS_CHAVE: 'chave-do-minio',
  ARQUIVOS_SEGREDO: 'segredo-forte-do-minio',
  WHATSAPP_TOKEN_INTERNO: 't'.repeat(40),
};

describe('Ambiente — avisos de produção', () => {
  it('configuração segura: nenhum aviso', () => {
    expect(lerAmbiente(PRODUCAO).avisos).toEqual([]);
  });

  it('URL_PUBLICA em http avisa; em https com COOKIE_SEGURO=false também', () => {
    const http = lerAmbiente({
      ...PRODUCAO,
      URL_PUBLICA: 'http://crm.brl.com.br',
      COOKIE_SEGURO: 'false',
    });
    expect(http.avisos.join('\n')).toMatch(/URL_PUBLICA usa http/);
    const cookie = lerAmbiente({ ...PRODUCAO, COOKIE_SEGURO: 'false' });
    expect(cookie.avisos.join('\n')).toMatch(/COOKIE_SEGURO=false/);
  });

  it('segredo do MinIO e senha do banco de desenvolvimento avisam, sem mostrar o valor', () => {
    const ambiente = lerAmbiente({
      ...PRODUCAO,
      DATABASE_URL: 'postgresql://crmbrl:crmbrl@banco:5432/crmbrl',
      ARQUIVOS_SEGREDO: ARQUIVOS_SEGREDO_DESENVOLVIMENTO,
    });
    const texto = ambiente.avisos.join('\n');
    expect(texto).toMatch(/ARQUIVOS_SEGREDO/);
    expect(texto).toMatch(/senha do banco/);
    expect(texto).not.toContain(ARQUIVOS_SEGREDO_DESENVOLVIMENTO);
  });

  it('fora de produção, nenhum desses avisos', () => {
    const ambiente = lerAmbiente({
      DATABASE_URL: 'postgresql://crmbrl:crmbrl@localhost:5434/crmbrl',
      ARQUIVOS_CHAVE: 'a',
      ARQUIVOS_SEGREDO: ARQUIVOS_SEGREDO_DESENVOLVIMENTO,
    });
    expect(ambiente.avisos.join('\n')).not.toMatch(/senha do banco/);
  });
});
