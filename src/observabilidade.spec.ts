import { lerAmbiente } from './config/ambiente';
import { carregarObservabilidade } from './observabilidade';

const AMBIENTE_DE_TESTE = lerAmbiente({
  DATABASE_URL: 'postgresql://crmbrl:crmbrl@localhost:5434/crmbrl',
  NODE_ENV: 'test',
});

describe('carregarObservabilidade', () => {
  it('não liga nada sem as chaves', async () => {
    await expect(
      carregarObservabilidade(AMBIENTE_DE_TESTE),
    ).resolves.toBeNull();
  });

  it('com as chaves, entrega o módulo e o gancho de instrumentação', async () => {
    const observabilidade = await carregarObservabilidade({
      ...AMBIENTE_DE_TESTE,
      observe: { appKey: 'chave', appSecret: 'segredo' },
    });

    expect(observabilidade?.modulo.global).toBe(true);
    expect(observabilidade?.instrumento?.instanceDecorator).toEqual(
      expect.any(Function),
    );
  });
});
