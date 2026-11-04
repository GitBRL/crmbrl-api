import { categoriaDaPassagem } from './categoria-passagem';

describe('Categoria da passagem para a equipe (R31.22)', () => {
  it('R31.22 — só as decisões de passagem têm categoria', () => {
    expect(categoriaDaPassagem('TURNO', null, 'x')).toBeNull();
    expect(categoriaDaPassagem('FALHA', null, 'nova tentativa')).toBeNull();
    expect(
      categoriaDaPassagem('QUALIFICADO', 'QUALIFICADO', 'critérios'),
    ).toBeNull();
  });

  it('R31.22 — agrupa o motivo (texto livre) em categorias estáveis', () => {
    const c = (tipo: 'PASSOU_HUMANO' | 'BLOQUEIO' | 'FALHA', motivo: string) =>
      categoriaDaPassagem(tipo, 'PASSAR_HUMANO', motivo);
    expect(c('PASSOU_HUMANO', 'O lead pediu para falar com uma pessoa.')).toBe(
      'pedido_humano',
    );
    expect(c('PASSOU_HUMANO', 'Assunto sensível: jurídico.')).toBe(
      'assunto_sensivel',
    );
    expect(c('PASSOU_HUMANO', 'O lead reclama do atendimento.')).toBe(
      'reclamacao',
    );
    expect(c('PASSOU_HUMANO', 'Baixa confiança na resposta.')).toBe(
      'baixa_confianca',
    );
    expect(
      c('PASSOU_HUMANO', 'Limite de 8 mensagens sem avanço na qualificação.'),
    ).toBe('sem_avanco');
    expect(
      c('PASSOU_HUMANO', 'Limite de 30 mensagens da IA nesta conversa.'),
    ).toBe('limite_conversa');
    expect(c('BLOQUEIO', 'O orçamento mensal de tokens do SDR acabou.')).toBe(
      'orcamento',
    );
    expect(
      c('BLOQUEIO', 'O canal não aceita resposta agora (janela de 24 h).'),
    ).toBe('janela_24h');
    expect(c('BLOQUEIO', 'O contato está com opt-out: a IA não envia.')).toBe(
      'opt_out',
    );
    expect(c('BLOQUEIO', 'O SDR com IA foi desligado neste canal.')).toBe(
      'canal_ou_ia_indisponivel',
    );
    expect(c('FALHA', 'A Anthropic está sobrecarregada.')).toBe('falha_da_ia');
    expect(c('PASSOU_HUMANO', 'Qualquer outra coisa.')).toBe('outro');
  });
});
