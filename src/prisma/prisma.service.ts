import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PapelDaConexao } from '../banco/papel-da-aplicacao';
import type { Ambiente } from '../config/ambiente';
import { AMBIENTE } from '../config/ambiente';
import { type Prisma, PrismaClient } from '../generated/prisma/client';
import { atorDoBanco } from './contexto-do-banco';
import { criarPoolComContexto } from './pool-com-contexto';

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
        // R35.2: cada consulta leva o contexto da RLS (usuário, sistema ou nenhum).
        criarPoolComContexto(
          {
            connectionString: ambiente.databaseUrl,
            connectionTimeoutMillis: PRAZO_DE_CONEXAO_MS,
          },
          { ator: atorDoBanco },
        ),
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
    separarLotesPorContexto(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // R35.1: avisa quando a aplicação usa um papel que ignora a RLS (o dono).
    // Sem esperar: a API sobe mesmo com o banco fora do ar.
    void this.papelDaConexao()
      .then(({ usuario, ignoraRls }) => {
        if (ignoraRls) {
          PrismaService.logger.warn(
            `A API conecta ao banco como "${usuario}" (superusuário ou BYPASSRLS): a RLS (R35) não vale. Defina BANCO_APP_SENHA para usar o papel próprio da aplicação.`,
          );
        }
      })
      .catch(() => undefined);
  }

  /** R35.1: com que papel esta conexão fala com o banco, e se ele ignora a RLS. */
  async papelDaConexao(): Promise<PapelDaConexao> {
    const [linha] = await this.$queryRaw<
      { usuario: string; ignora: boolean }[]
    >`SELECT current_user AS usuario, (r.rolsuper OR r.rolbypassrls) AS ignora
        FROM pg_roles r WHERE r.rolname = current_user`;
    return { usuario: linha.usuario, ignoraRls: linha.ignora };
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** O pedaço interno do Prisma que junta `findUnique` do mesmo instante numa consulta só. */
interface CarregadorEmLote {
  options: {
    batchBy: (pedido: {
      transaction?: { kind?: string };
    }) => string | undefined;
  };
}

/**
 * R35.2: o Prisma junta os `findUnique` feitos no mesmo instante numa consulta
 * só e a despacha no contexto assíncrono de quem chegou primeiro — pedidos de
 * duas requisições (dois usuários) iriam ao banco com o contexto de um deles.
 * Aqui o lote fica só para `$transaction([...])` (todas as consultas vêm de
 * quem chamou); o resto vai direto, cada uma no contexto de quem pediu.
 * Testado em `prisma.service.spec.ts`: se uma versão nova do Prisma mudar o
 * interno, o teste acusa.
 */
export function separarLotesPorContexto(cliente: PrismaClient): void {
  const carregador = (
    cliente as unknown as {
      _requestHandler?: { dataloader?: CarregadorEmLote };
    }
  )._requestHandler?.dataloader;
  const original = carregador?.options?.batchBy;
  if (!carregador || typeof original !== 'function') {
    throw new Error(
      'Prisma: não achei o agrupamento de consultas (_requestHandler.dataloader); revise separarLotesPorContexto (R35.2).',
    );
  }
  carregador.options.batchBy = (pedido) =>
    pedido.transaction?.kind === 'batch' ? original(pedido) : undefined;
}
