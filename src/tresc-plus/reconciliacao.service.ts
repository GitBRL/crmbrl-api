import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { FilaService } from '../fila/fila.service';
import { PrismaService } from '../prisma/prisma.service';
import { comoObjeto, listaDe, numeroDe } from './cliente-tresc-plus';
import { ConexaoTrescPlusService } from './conexao.service';
import { dataParaTresc, traduzindo } from './agente.service';
import { LigacoesTrescService } from './ligacoes-tresc.service';
import {
  FILA_RECONCILIAR,
  JANELA_DA_RECONCILIACAO_HORAS,
} from './tresc-plus.constantes';

const MAX_PAGINAS = 20;
const MARGEM_MS = 15 * 60_000;

export interface ResultadoDaReconciliacao {
  /** Chamadas lidas no `GET /calls`. */
  consultadas: number;
  /** Ligações presas que a reconciliação fechou. */
  fechadas: number;
}

/**
 * Reconciliação periódica (R34.4): `GET /calls` com o token do gestor cobre os eventos perdidos
 * (socket caído, API fora do ar). Cada registro passa pelo mesmo caminho do
 * `call-history-was-created` (deduplicado: o que o evento já trouxe não se repete). Roda num job do
 * pg-boss a cada `TRESC_PLUS_RECONCILIACAO_MIN` minutos e sob demanda (`POST /tresc-plus/reconciliar`).
 */
@Injectable()
export class ReconciliacaoTrescPlusService implements OnModuleInit {
  private readonly logger = new Logger('TrescPlusReconciliacao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly conexao: ConexaoTrescPlusService,
    private readonly ligacoes: LigacoesTrescService,
    private readonly fila: FilaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(FILA_RECONCILIAR, async () => {
      await this.reconciliar().catch((erro: unknown) =>
        this.logger.warn(
          `Reconciliação do 3C+ falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        ),
      );
    });
    const minutos = this.ambiente.trescPlus.reconciliacaoMinutos;
    await this.fila.agendar(
      FILA_RECONCILIAR,
      minutos >= 60
        ? `0 */${Math.floor(minutos / 60)} * * *`
        : `*/${minutos} * * * *`,
    );
  }

  async reconciliar(
    agora: Date = new Date(),
  ): Promise<ResultadoDaReconciliacao> {
    const config = await this.conexao.ler();
    if (!config.ativa || !config.tokenCifrado)
      return { consultadas: 0, fechadas: 0 };
    const cliente = this.conexao.clienteDaEmpresa(config);
    const desde = config.reconciliadaEm
      ? new Date(
          Math.max(
            config.reconciliadaEm.getTime() - MARGEM_MS,
            agora.getTime() - 24 * 3_600_000,
          ),
        )
      : new Date(agora.getTime() - JANELA_DA_RECONCILIACAO_HORAS * 3_600_000);
    const inicio = dataParaTresc(desde);
    let consultadas = 0;
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina += 1) {
      const corpo = await traduzindo(() =>
        cliente.chamadas({ inicio, pagina, porPagina: 100 }),
      );
      const itens = listaDe(corpo);
      for (const item of itens) {
        const registro = comoObjeto(item);
        if (!registro) continue;
        consultadas += 1;
        await this.ligacoes.processarHistorico(registro);
      }
      const paginacao = comoObjeto(
        comoObjeto(comoObjeto(corpo)?.meta)?.pagination,
      );
      const total = numeroDe(paginacao?.total_pages);
      if (itens.length === 0 || total === null || pagina >= total) break;
    }
    const fechadas = await this.ligacoes.fecharPresas(agora);
    await this.prisma.trescPlusConfig.update({
      where: { id: 1 },
      data: { reconciliadaEm: agora },
    });
    return { consultadas, fechadas };
  }
}
