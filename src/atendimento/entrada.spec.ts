import { normalizarIdentificador, ORDEM_DO_STATUS } from './entrada';

describe('entrada do Atendimento', () => {
  it('normaliza o identificador como o banco exige', () => {
    expect(normalizarIdentificador('WHATSAPP', '+55 (11) 98888-7777')).toBe(
      '5511988887777',
    );
    expect(normalizarIdentificador('EMAIL', '  Maria@Exemplo.COM ')).toBe(
      'maria@exemplo.com',
    );
    expect(normalizarIdentificador('INSTAGRAM', ' 1784 ')).toBe('1784');
    expect(() => normalizarIdentificador('WEBCHAT', '   ')).toThrow(TypeError);
    expect(() => normalizarIdentificador('WHATSAPP', '123')).toThrow(TypeError);
  });

  it('o status de entrega só avança', () => {
    expect(ORDEM_DO_STATUS.LIDA).toBeGreaterThan(ORDEM_DO_STATUS.ENTREGUE);
    expect(ORDEM_DO_STATUS.ENTREGUE).toBeGreaterThan(ORDEM_DO_STATUS.ENVIADA);
    expect(ORDEM_DO_STATUS.ENVIADA).toBeGreaterThan(ORDEM_DO_STATUS.PENDENTE);
  });
});
