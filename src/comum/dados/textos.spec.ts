import { semCodigoDeRegra } from './textos';

describe('semCodigoDeRegra', () => {
  it('tira o parêntese que é só o código, com ou sem pontuação depois', () => {
    expect(semCodigoDeRegra('Contato "Ana" ganhou responsável (R4.5)')).toBe(
      'Contato "Ana" ganhou responsável',
    );
    expect(
      semCodigoDeRegra('O contato precisa de e-mail ou telefone (R4.1).'),
    ).toBe('O contato precisa de e-mail ou telefone.');
    expect(
      semCodigoDeRegra(
        'Assinatura inválida (R8.3): X-Assinatura não confere com o HMAC-SHA256 do corpo.',
      ),
    ).toBe(
      'Assinatura inválida: X-Assinatura não confere com o HMAC-SHA256 do corpo.',
    );
    expect(semCodigoDeRegra('Itens encaminhados (R7.3, R7.4)')).toBe(
      'Itens encaminhados',
    );
    expect(semCodigoDeRegra('Fora do rodízio (regra R5.8).')).toBe(
      'Fora do rodízio.',
    );
    expect(semCodigoDeRegra('O funil está arquivado. [R5.2]')).toBe(
      'O funil está arquivado.',
    );
  });

  it('mantém o resto do parêntese quando o código vem no fim dele', () => {
    expect(
      semCodigoDeRegra('Contato anonimizado pelo Admin (LGPD, R4.6)'),
    ).toBe('Contato anonimizado pelo Admin (LGPD)');
    expect(
      semCodigoDeRegra(
        'Contato "Ana" reconvertido (já existia, R4.2); negócio criado.',
      ),
    ).toBe('Contato "Ana" reconvertido (já existia); negócio criado.');
  });

  it('texto sem código (ou nulo) volta igual', () => {
    const texto = 'Negócio "ACME" movido de Proposta (R$ 1.500,00) para Ganho';
    expect(semCodigoDeRegra(texto)).toBe(texto);
    expect(semCodigoDeRegra('Rota R2 , antiga')).toBe('Rota R2 , antiga');
    expect(semCodigoDeRegra(null)).toBeNull();
  });
});
