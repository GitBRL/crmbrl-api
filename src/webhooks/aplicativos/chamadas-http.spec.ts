import { chamarAplicativo } from './chamadas-http';
import { FalhaNoAplicativoError } from './tipos';

function pedido(buscar: typeof fetch) {
  return {
    buscar,
    url: 'https://conta.exemplo.com/api',
    cabecalhos: {},
    aplicativo: 'ActiveCampaign',
  };
}

describe('chamarAplicativo — tamanho da resposta', () => {
  it('lê uma resposta JSON pequena', async () => {
    const buscar = (async () =>
      new Response('{"a":1}', { status: 200 })) as typeof fetch;
    await expect(chamarAplicativo(pedido(buscar))).resolves.toEqual({
      status: 200,
      dados: { a: 1 },
    });
  });

  it('corta o fluxo e falha quando a resposta passa de 1 MB, sem ler o resto', async () => {
    let lidos = 0;
    let cancelado = false;
    // Fluxo FINITO (50 × 200 KB = 10 MB): sem o corte, o teste falha sem esgotar a memória.
    const fluxo = new ReadableStream<Uint8Array>({
      pull(controle) {
        lidos += 1;
        if (lidos > 50) {
          controle.close();
          return;
        }
        controle.enqueue(new Uint8Array(200_000).fill(32));
      },
      cancel() {
        cancelado = true;
      },
    });
    const buscar = (async () =>
      new Response(fluxo, { status: 200 })) as typeof fetch;
    await expect(chamarAplicativo(pedido(buscar))).rejects.toThrow(
      FalhaNoAplicativoError,
    );
    expect(cancelado).toBe(true);
    expect(lidos).toBeLessThan(20);
  });

  it('recusa antes de ler quando Content-Length já passa do limite', async () => {
    const resposta = new Response('x', {
      status: 200,
      headers: { 'content-length': '5000000' },
    });
    const buscar = (async () => resposta) as typeof fetch;
    await expect(chamarAplicativo(pedido(buscar))).rejects.toThrow(
      /grande demais/,
    );
  });
});
