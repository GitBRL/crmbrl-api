import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { FilaService, FUSO_HORARIO_PADRAO } from '../fila/fila.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';

/** Fila do job de retenção. */
export const FILA_RETENCAO = 'administracao.retencao';

/** Todo dia às 3h30 (fuso de São Paulo), fora do horário de uso. */
export const AGENDA_RETENCAO = '30 3 * * *';

/** Logs técnicos (R3.6) e recebimentos de webhook (R8.6) ficam 90 dias. */
export const DIAS_DE_RETENCAO = 90;

/** Ação de auditoria de cada lote apagado. */
export const ACAO_DA_RETENCAO = 'retencao.executada';

const MILISSEGUNDOS_POR_DIA = 86_400_000;

/** Linhas apagadas por tabela em cada transação, para não segurar travas por muito tempo. */
export const TAMANHO_DO_LOTE = 5_000;

/** Prazo de cada lote: mais folgado que o padrão das transações (20 s), por ser manutenção. */
const PRAZO_DO_LOTE_MS = 60_000;

/** Teto de lotes por execução (5 milhões de linhas por tabela); o resto fica para o dia seguinte. */
const MAXIMO_DE_LOTES = 1_000;

export interface OpcoesDaRetencao {
  /** Momento de referência (padrão: agora). */
  agora?: Date;
  /** Linhas por tabela em cada lote (padrão 5.000; menor nos testes). */
  tamanhoDoLote?: number;
}

export interface ResultadoDaRetencao {
  /** Tudo o que era anterior a este momento foi apagado. */
  readonly limite: Date;
  readonly logsTecnicosApagados: number;
  readonly recebimentosWebhookApagados: number;
}

/** O momento antes do qual logs técnicos e recebimentos de webhook são apagados. */
export function limiteDaRetencao(agora: Date = new Date()): Date {
  return new Date(agora.getTime() - DIAS_DE_RETENCAO * MILISSEGUNDOS_POR_DIA);
}

/**
 * Job diário de retenção (R3.6, R8.6): apaga os logs técnicos e os recebimentos
 * de webhook com mais de 90 dias. Agendado no pg-boss (`FilaService.agendar`);
 * com `PROCESSAR_FILAS=false` não roda sozinho (nos testes, drene a fila).
 *
 * Apaga em lotes; cada lote é uma transação com o próprio evento de auditoria
 * (`retencao.executada`, ator `SISTEMA`, com as contagens). Um lote sem nada a
 * apagar não gera evento. A auditoria em si nunca é apagada (R3.3), nem as
 * demais tabelas (sessões, tentativas de login, outbox: retenção ainda não
 * definida pelas regras).
 */
@Injectable()
export class RetencaoService implements OnModuleInit {
  private readonly logger = new Logger('Retencao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(
      FILA_RETENCAO,
      async () => {
        await this.executar();
      },
      {
        tentativas: 3,
        intervaloEntreTentativasSegundos: 600,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 1_800,
      },
    );
    await this.fila.agendar(FILA_RETENCAO, AGENDA_RETENCAO);
  }

  /** Executa a retenção agora (é o que o job faz). */
  executar(opcoes: OpcoesDaRetencao = {}): Promise<ResultadoDaRetencao> {
    const limite = limiteDaRetencao(opcoes.agora);
    const tamanhoDoLote = Math.max(
      1,
      Math.floor(opcoes.tamanhoDoLote ?? TAMANHO_DO_LOTE),
    );
    return executarComoAtor(
      { tipoAtor: 'SISTEMA', descricao: 'Retenção de dados' },
      async () => {
        let logsTecnicosApagados = 0;
        let recebimentosWebhookApagados = 0;
        for (let lote = 0; lote < MAXIMO_DE_LOTES; lote++) {
          const apagados = await this.prisma.$transaction(
            (tx) => this.apagarLote(tx, limite, tamanhoDoLote),
            { timeout: PRAZO_DO_LOTE_MS },
          );
          logsTecnicosApagados += apagados.logsTecnicos;
          recebimentosWebhookApagados += apagados.recebimentos;
          if (
            apagados.logsTecnicos < tamanhoDoLote &&
            apagados.recebimentos < tamanhoDoLote
          ) {
            break;
          }
        }
        if (logsTecnicosApagados + recebimentosWebhookApagados > 0) {
          this.logger.log(
            `Retenção de ${DIAS_DE_RETENCAO} dias: ${descreverApagados(logsTecnicosApagados, recebimentosWebhookApagados)}.`,
          );
        }
        return { limite, logsTecnicosApagados, recebimentosWebhookApagados };
      },
    );
  }

  private async apagarLote(
    tx: Tx,
    limite: Date,
    tamanhoDoLote: number,
  ): Promise<{ logsTecnicos: number; recebimentos: number }> {
    // Duas réplicas rodando juntas fazem um lote de cada vez.
    await travarChave(tx, FILA_RETENCAO);
    const logsTecnicos = await tx.$executeRaw`
      DELETE FROM logs_tecnicos
       WHERE id IN (SELECT id FROM logs_tecnicos
                     WHERE criado_em < ${limite}::timestamptz
                     ORDER BY criado_em
                     LIMIT ${tamanhoDoLote})`;
    const recebimentos = await tx.$executeRaw`
      DELETE FROM webhook_recebimentos
       WHERE id IN (SELECT id FROM webhook_recebimentos
                     WHERE recebido_em < ${limite}::timestamptz
                     ORDER BY recebido_em
                     LIMIT ${tamanhoDoLote})`;
    if (logsTecnicos + recebimentos > 0) {
      await this.auditoria.registrar(tx, {
        acao: ACAO_DA_RETENCAO,
        entidade: 'retencao',
        resumo: `Retenção de ${DIAS_DE_RETENCAO} dias: ${descreverApagados(logsTecnicos, recebimentos)} (anteriores a ${formatarData(limite)})`,
        dados: {
          dias: DIAS_DE_RETENCAO,
          limite,
          logsTecnicosApagados: logsTecnicos,
          recebimentosWebhookApagados: recebimentos,
        },
      });
    }
    return { logsTecnicos, recebimentos };
  }
}

function contar(quantidade: number, singular: string, plural: string): string {
  return `${quantidade.toLocaleString('pt-BR')} ${quantidade === 1 ? singular : plural}`;
}

/** "3 logs técnicos e 1 recebimento de webhook apagados" (só o que houve). */
function descreverApagados(logs: number, recebimentos: number): string {
  const partes = [
    ...(logs > 0 ? [contar(logs, 'log técnico', 'logs técnicos')] : []),
    ...(recebimentos > 0
      ? [
          contar(
            recebimentos,
            'recebimento de webhook',
            'recebimentos de webhook',
          ),
        ]
      : []),
  ];
  const verbo = logs + recebimentos === 1 ? 'apagado' : 'apagados';
  return `${partes.length > 0 ? partes.join(' e ') : 'nada'} ${verbo}`;
}

function formatarData(data: Date): string {
  return data.toLocaleDateString('pt-BR', { timeZone: FUSO_HORARIO_PADRAO });
}
