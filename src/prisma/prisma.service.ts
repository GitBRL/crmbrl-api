import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Ambiente } from '../config/ambiente';
import { AMBIENTE } from '../config/ambiente';
import { type Prisma, PrismaClient } from '../generated/prisma/client';

/** Quanto esperar por uma conexão nova antes de desistir (o padrão do `pg` é esperar para sempre). */
const PRAZO_DE_CONEXAO_MS = 5_000;

/**
 * Prazos das transações interativas (`prisma.$transaction(async (tx) => …)`).
 * O padrão do Prisma (5 s) é curto para operações grandes, como o desligamento
 * com encaminhamento (R7.3) ou a configuração inicial.
 */
const OPCOES_DE_TRANSACAO = { maxWait: 5_000, timeout: 20_000 } as const;

/**
 * Client de uma transação interativa — o `tx` de `prisma.$transaction(async (tx) => …)`.
 * Os serviços da base (auditoria, eventos, notificações, fila) recebem um `Tx`
 * para gravar na mesma transação da alteração. O próprio `PrismaService`
 * também serve onde se espera um `Tx` (grava fora de transação).
 */
export type Tx = Prisma.TransactionClient;

/**
 * O client do Prisma como provider do Nest, falando com o PostgreSQL pelo
 * driver `pg` (adapter obrigatório no Prisma 7).
 *
 * A API sobe mesmo com o banco fora do ar: o pool conecta sob demanda e volta
 * sozinho quando o banco volta. Quem acompanha isso é o `GET /api/saude`.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(AMBIENTE) ambiente: Ambiente) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: ambiente.databaseUrl,
          connectionTimeoutMillis: PRAZO_DE_CONEXAO_MS,
        },
        {
          // Conexões ociosas caem quando o banco reinicia. O pool descarta a
          // conexão e abre outra no próximo uso; aqui só fica o registro.
          onPoolError: (erro) =>
            PrismaService.logger.warn(
              `Conexão ociosa com o banco caiu: ${erro.message}`,
            ),
        },
      ),
      transactionOptions: OPCOES_DE_TRANSACAO,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
