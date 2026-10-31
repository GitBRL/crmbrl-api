import { lerConfiguracaoAssistente } from './configuracao-assistente';

describe('R25 — configuração do assistente', () => {
  it('R25.5 — padrões e valores inválidos voltam ao padrão', () => {
    expect(lerConfiguracaoAssistente(undefined)).toEqual({
      perguntasPorDia: 30,
      orcamentoMensalTokens: 20_000_000,
      destino: 'TICKETHUB',
      ticketHub: {
        url: null,
        urlPublica: null,
        email: null,
        senhaCifrada: null,
        prioridade: 'media',
        sistemaId: null,
      },
      webhook: {
        url: null,
        cabecalhosCifrados: null,
        segredoCifrado: null,
        modeloCorpo: null,
      },
    });
    const c = lerConfiguracaoAssistente({
      perguntasPorDia: -1,
      orcamentoMensalTokens: null,
      destino: 'EMAIL',
      ticketHub: { prioridade: 'urgente', sistemaId: 'x' },
    });
    expect(c.perguntasPorDia).toBe(30);
    expect(c.orcamentoMensalTokens).toBeNull();
    expect(c.destino).toBe('TICKETHUB');
    expect(c.ticketHub.prioridade).toBe('media');
    expect(c.ticketHub.sistemaId).toBeNull();
  });
});
