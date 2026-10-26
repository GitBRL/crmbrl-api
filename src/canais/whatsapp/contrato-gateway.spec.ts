import {
  codificarAtor,
  decodificarAtor,
  ehJidDeContato,
  filaDeEnvio,
  gerarIdDeMensagemWhatsapp,
  jidDoTelefone,
  ROTAS_DO_GATEWAY,
  telefoneDoJid,
} from './contrato-gateway';

describe('contrato API ↔ gateway de WhatsApp', () => {
  it('gera ids no formato do WhatsApp Web, sem repetir', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => gerarIdDeMensagemWhatsapp()),
    );
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^3EB0[0-9A-F]{36}$/);
    }
  });

  it('converte telefone ↔ JID', () => {
    expect(jidDoTelefone('+55 11 98888-7777')).toBe(
      '5511988887777@s.whatsapp.net',
    );
    expect(telefoneDoJid('5511988887777@s.whatsapp.net')).toBe('5511988887777');
    expect(telefoneDoJid('5511988887777:12@s.whatsapp.net')).toBe(
      '5511988887777',
    );
    expect(telefoneDoJid('123456789012345@lid')).toBeNull();
    expect(telefoneDoJid('120363025@g.us')).toBeNull();
  });

  it('nomes de fila e rotas aceitos pelo pg-boss e pelo HTTP interno', () => {
    const id = '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10';
    expect(filaDeEnvio(id)).toMatch(/^[\w.\-/]+$/);
    expect(ROTAS_DO_GATEWAY.conectar(id)).toBe(`/numeros/${id}/conectar`);
  });

  it('só JIDs de contato (telefone ou @lid) entram no atendimento', () => {
    expect(ehJidDeContato('5511988887777@s.whatsapp.net')).toBe(true);
    expect(ehJidDeContato('123456789012345@lid')).toBe(true);
    expect(ehJidDeContato('120363025@g.us')).toBe(false);
    expect(ehJidDeContato('status@broadcast')).toBe(false);
    expect(ehJidDeContato('123@newsletter')).toBe(false);
    expect(ehJidDeContato(null)).toBe(false);
  });

  it('quem pediu o comando vai e volta pelo cabeçalho x-ator', () => {
    const ator = {
      id: '6f1c2b0e-8a3d-4c55-9a51-2d8f8d7c1e10',
      nome: 'Ana Admin',
      papel: 'ADMIN' as const,
    };
    const valor = codificarAtor(ator);
    expect(valor).toMatch(/^[\w-]+$/);
    expect(decodificarAtor(valor)).toEqual(ator);
    expect(decodificarAtor(undefined)).toBeNull();
    expect(decodificarAtor('não-é-base64-json')).toBeNull();
    expect(
      decodificarAtor(Buffer.from('{"id":1}').toString('base64url')),
    ).toBeNull();
  });
});
