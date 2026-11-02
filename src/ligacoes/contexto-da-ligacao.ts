import { Logger } from '@nestjs/common';
import type { Tx } from '../prisma/prisma.service';
import type { TempoRealService } from '../tempo-real/tempo-real.service';

/**
 * O que uma operação sobre ligações acumula dentro da transação e só executa
 * **depois do commit**: emissões do tempo real (ligação tocando, estado,
 * encerrada…) e chamadas à Meta (reject, terminate), que nunca devem sair se a
 * transação falhar.
 */
export class ContextoDaLigacao {
  private readonly emissoes: Array<{
    sala: string | readonly string[];
    evento: string;
    dados: unknown;
  }> = [];
  private readonly depois: Array<() => Promise<void>> = [];
  private readonly logger = new Logger('Ligacoes');

  emitir(
    sala: string | readonly string[],
    evento: string,
    dados: unknown,
  ): void {
    this.emissoes.push({ sala, evento, dados });
  }

  /** Executa `acao` depois do commit; a falha só é registrada (a ligação já foi gravada). */
  aposCommit(acao: () => Promise<void>): void {
    this.depois.push(acao);
  }

  async concluir(tempoReal: TempoRealService): Promise<void> {
    for (const { sala, evento, dados } of this.emissoes) {
      tempoReal.emitir(sala, evento, dados);
    }
    for (const acao of this.depois) {
      try {
        await acao();
      } catch (erro) {
        this.logger.warn(
          `Ação pós-commit da ligação falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
  }
}

/**
 * Grava a chave de dedupe do webhook (a Meta reentrega por até 7 dias, R29.2)
 * **na mesma transação** que aplica o evento: se o evento falhar, a chave
 * volta junto e a retentativa o processa. `false` = já processado.
 */
export async function registrarChaveDeDedupe(
  tx: Tx,
  chave: string,
): Promise<boolean> {
  const { count } = await tx.ligacaoWebhookEvento.createMany({
    data: [{ chave }],
    skipDuplicates: true,
  });
  return count === 1;
}
