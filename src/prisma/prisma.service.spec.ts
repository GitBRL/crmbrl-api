import type { Ambiente } from '../config/ambiente';
import { PrismaService } from './prisma.service';

type Carregador = {
  options: { batchBy: (pedido: object) => string | undefined };
};

describe('PrismaService (R35.2)', () => {
  it('não junta findUnique de contextos diferentes num lote; $transaction([...]) continua em lote', async () => {
    const prisma = new PrismaService({
      databaseUrl: 'postgresql://ninguem:nada@127.0.0.1:1/nenhum',
    } as Ambiente);
    try {
      const carregador = (
        prisma as unknown as { _requestHandler: { dataloader: Carregador } }
      )._requestHandler.dataloader;
      const consulta = {
        modelName: 'Negocio',
        action: 'findUnique',
        query: { arguments: { where: { id: '1' } }, selection: {} },
      };
      expect(
        carregador.options.batchBy({ protocolQuery: consulta }),
      ).toBeUndefined();
      expect(
        carregador.options.batchBy({
          protocolQuery: consulta,
          transaction: { kind: 'itx', id: 't1' },
        }),
      ).toBeUndefined();
      expect(
        carregador.options.batchBy({
          protocolQuery: consulta,
          transaction: { kind: 'batch', id: 7, index: 0 },
        }),
      ).toBe('transaction-7');
    } finally {
      await prisma.$disconnect();
    }
  });
});
