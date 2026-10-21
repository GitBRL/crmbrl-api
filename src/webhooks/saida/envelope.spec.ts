import { createHmac } from 'node:crypto';
import {
  cabecalhosDaEntrega,
  conteudoAssinado,
  formatarAssinatura,
  montarEnvelope,
  proximaTentativaDepoisDe,
  serializarEnvelope,
  timestampDoEnvio,
} from './envelope';
import { juntarCabecalhos, validarCabecalhos } from './cabecalhos-extras';

describe('envelope e assinatura das entregas (R9.3)', () => {
  it('R9.3 — envelope { id, evento, ocorridoEm, dados } na ordem do contrato', () => {
    const envelope = montarEnvelope({
      id: 'e1',
      tipo: 'negocio.ganho',
      ocorridoEm: new Date('2026-10-20T12:00:00.000Z'),
      dados: { negocioId: 'n1' },
    });
    // O jsonb devolve as chaves em outra ordem: o corpo sai sempre igual.
    const doBanco = {
      id: envelope.id,
      dados: envelope.dados,
      evento: envelope.evento,
      ocorridoEm: envelope.ocorridoEm,
    };
    expect(serializarEnvelope(doBanco)).toBe(
      '{"id":"e1","evento":"negocio.ganho","ocorridoEm":"2026-10-20T12:00:00.000Z","dados":{"negocioId":"n1"}}',
    );
  });

  it('R9.3 — assina HMAC-SHA256 de timestamp + "." + corpo; cabeçalhos do CRM vencem os extras', () => {
    const corpo = '{"id":"e1"}';
    const timestamp = timestampDoEnvio(new Date('2026-10-20T12:00:00.900Z'));
    expect(timestamp).toBe('1792497600');
    const hmac = createHmac('sha256', 'segredo')
      .update(conteudoAssinado(timestamp, corpo))
      .digest('hex');
    expect(conteudoAssinado(timestamp, corpo)).toBe(`1792497600.${corpo}`);
    const cabecalhos = cabecalhosDaEntrega({
      evento: 'negocio.ganho',
      entregaId: 'x1',
      timestamp,
      assinatura: formatarAssinatura(hmac),
      extras: { Authorization: 'Bearer abc', 'X-Outro': '1' },
    });
    expect(cabecalhos).toEqual({
      Authorization: 'Bearer abc',
      'X-Outro': '1',
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'CRM-BRL-Webhooks/1.0',
      'X-CRM-Evento': 'negocio.ganho',
      'X-CRM-Entrega': 'x1',
      'X-CRM-Timestamp': '1792497600',
      'X-CRM-Assinatura': `sha256=${hmac}`,
    });
  });

  it('R9.4 — novas tentativas em 1 min, 5 min, 30 min, 2 h, 6 h e 24 h; depois, falha', () => {
    const agora = new Date('2026-10-20T00:00:00.000Z');
    const esperas = [1, 2, 3, 4, 5, 6].map(
      (tentativa) =>
        ((proximaTentativaDepoisDe(tentativa, agora)?.getTime() ?? 0) -
          agora.getTime()) /
        1000,
    );
    expect(esperas).toEqual([60, 300, 1800, 7200, 21600, 86400]);
    expect(proximaTentativaDepoisDe(7, agora)).toBeNull();
    expect(proximaTentativaDepoisDe(0, agora)).toBeNull();
  });
});

describe('cabeçalhos extras dos destinos (R9.1)', () => {
  it('aceita cabeçalhos comuns e recusa os reservados, repetidos e com quebra de linha', () => {
    expect(
      validarCabecalhos({ Authorization: ' Bearer abc ', 'X-Tenant': '7' }),
    ).toEqual({
      validos: true,
      cabecalhos: { Authorization: 'Bearer abc', 'X-Tenant': '7' },
      removidos: [],
    });
    const ruim = validarCabecalhos({
      Host: 'x',
      'X-CRM-Evento': 'y',
      'nome inválido': 'z',
      'X-A': 'linha\nquebrada',
      'x-a': 'repetido',
      'X-Num': 1,
    });
    expect(ruim.validos).toBe(false);
    expect(!ruim.validos && ruim.problemas.map((p) => p.campo)).toEqual([
      'cabecalhos.Host',
      'cabecalhos.X-CRM-Evento',
      'cabecalhos.nome inválido',
      'cabecalhos.X-A',
      'cabecalhos.x-a',
      'cabecalhos.X-Num',
    ]);
    expect(validarCabecalhos([]).validos).toBe(false);
  });

  it('na atualização, null remove e o nome não diferencia maiúsculas', () => {
    const resultado = validarCabecalhos(
      { authorization: 'Bearer novo', 'X-Velho': null },
      { permitirNulos: true },
    );
    expect(resultado).toEqual({
      validos: true,
      cabecalhos: { authorization: 'Bearer novo' },
      removidos: ['X-Velho'],
    });
    expect(
      juntarCabecalhos(
        { Authorization: 'Bearer antigo', 'x-velho': '1', 'X-Fica': '2' },
        { authorization: 'Bearer novo' },
        ['X-Velho'],
      ),
    ).toEqual({ 'X-Fica': '2', authorization: 'Bearer novo' });
  });
});
