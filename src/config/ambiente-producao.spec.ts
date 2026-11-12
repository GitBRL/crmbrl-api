import {
  AmbienteInvalidoError,
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

  it('URL_PUBLICA em http só avisa', () => {
    const http = lerAmbiente({
      ...PRODUCAO,
      URL_PUBLICA: 'http://crm.brl.com.br',
      COOKIE_SEGURO: 'false',
    });
    expect(http.avisos.join('\n')).toMatch(/URL_PUBLICA usa http/);
  });

  function problemasDe(variaveis: VariaveisDeAmbiente): string {
    try {
      lerAmbiente(variaveis);
    } catch (erro) {
      if (erro instanceof AmbienteInvalidoError) {
        return erro.problemas.join('\n');
      }
      throw erro;
    }
    throw new Error('a subida deveria ter sido recusada');
  }

  it('R2.2 — COOKIE_SEGURO=false com URL_PUBLICA em https recusa a subida', () => {
    expect(problemasDe({ ...PRODUCAO, COOKIE_SEGURO: 'false' })).toMatch(
      /COOKIE_SEGURO=false/,
    );
  });

  it('segredo do MinIO e senha do banco de desenvolvimento recusam a subida, sem mostrar o valor', () => {
    const texto = problemasDe({
      ...PRODUCAO,
      DATABASE_URL: 'postgresql://crmbrl:crmbrl@banco:5432/crmbrl',
      ARQUIVOS_SEGREDO: ARQUIVOS_SEGREDO_DESENVOLVIMENTO,
    });
    expect(texto).toMatch(/ARQUIVOS_SEGREDO/);
    expect(texto).toMatch(/senha do banco/);
    expect(texto).toMatch(/PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO/);
    expect(texto).not.toContain(ARQUIVOS_SEGREDO_DESENVOLVIMENTO);
  });

  it('chave de criptografia e token do gateway de desenvolvimento recusam a subida', () => {
    const texto = problemasDe({
      ...PRODUCAO,
      CHAVE_CRIPTOGRAFIA: 'QgJh7zlsW/dNWZEIgY5FuRfgyxtaDc6dfihpFVnoe+A=',
      WHATSAPP_TOKEN_INTERNO:
        'crmbrl-token-interno-de-desenvolvimento-nao-use-em-producao',
    });
    expect(texto).toMatch(/CHAVE_CRIPTOGRAFIA/);
    expect(texto).toMatch(/WHATSAPP_TOKEN_INTERNO/);
  });

  it('PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO=true deixa subir, com aviso alto', () => {
    const ambiente = lerAmbiente({
      ...PRODUCAO,
      PERMITIR_SEGREDOS_DE_DESENVOLVIMENTO: 'true',
      COOKIE_SEGURO: 'false',
      DATABASE_URL: 'postgresql://crmbrl:crmbrl@banco:5432/crmbrl',
      ARQUIVOS_SEGREDO: ARQUIVOS_SEGREDO_DESENVOLVIMENTO,
    });
    expect(ambiente.permitirSegredosDeDesenvolvimento).toBe(true);
    expect(ambiente.avisos).toHaveLength(3);
    for (const aviso of ambiente.avisos) {
      expect(aviso).toMatch(/^ATENÇÃO:/);
      expect(aviso).not.toContain(ARQUIVOS_SEGREDO_DESENVOLVIMENTO);
    }
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
