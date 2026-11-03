/**
 * Guarda das gravações (R30, LGPD): todo dia, às 03:30, apaga a gravação e a transcrição das
 * ligações mais antigas que o prazo do canal (`retencaoDias`, padrão 365). O registro, a duração e o
 * resumo ficam. Também limpa partes abandonadas (aba fechada e nenhuma finalização por 2 dias).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { FilaService } from '../../fila/fila.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REGRA_TRANSCRICAO } from '../../transcricao/transcricao.constantes';
import {
  AGENDA_DA_REMOCAO,
  FILA_REMOVER_GRAVACOES,
  LOTE_DA_REMOCAO,
  RETENCAO_PADRAO_DIAS,
} from './gravacao.constantes';
import { GravacaoService } from './gravacao.service';
import { apagarGravacoes } from './remocao';

@Injectable()
export class RetencaoDeGravacoesService implements OnModuleInit {
  private readonly logger = new Logger('RetencaoDeGravacoes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
    private readonly gravacao: GravacaoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(FILA_REMOVER_GRAVACOES, async () => {
      await this.executar();
    });
    await this.fila.agendar(FILA_REMOVER_GRAVACOES, AGENDA_DA_REMOCAO);
  }

  /** Uma rodada (a fila e os testes chamam). Devolve quantas ligações perderam a gravação. */
  async executar(agora: Date = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const vencidas = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT l.id
          FROM ligacoes l
          LEFT JOIN canais_ligacoes c ON c.canal_id = l.canal_id
         WHERE l.gravacao_removida_em IS NULL
           AND l.encerrada_em IS NOT NULL
           AND (l.gravacao_arquivo_id IS NOT NULL
                OR l.gravacao_original_arquivo_id IS NOT NULL
                OR l.transcricao_situacao IS NOT NULL)
           AND l.encerrada_em < ${agora}::timestamptz - make_interval(days => COALESCE(c.retencao_dias, ${RETENCAO_PADRAO_DIAS}))
         ORDER BY l.encerrada_em
         LIMIT ${LOTE_DA_REMOCAO}`;
      if (vencidas.length === 0) {
        break;
      }
      await this.prisma.$transaction(async (tx) => {
        const ligacoes = await tx.ligacao.findMany({
          where: { id: { in: vencidas.map((v) => v.id) } },
          select: { id: true, contatoId: true },
        });
        const resultado = await apagarGravacoes(
          tx,
          this.arquivos,
          { id: { in: vencidas.map((v) => v.id) } },
          'Prazo de guarda vencido (R30)',
        );
        for (const ligacao of ligacoes) {
          await this.auditoria.registrar(tx, {
            acao: 'ligacao.gravacao-removida',
            entidade: 'ligacao',
            entidadeId: ligacao.id,
            resumo: 'Gravação e transcrição apagadas pelo prazo de guarda',
            dados: { regra: REGRA_TRANSCRICAO, motivo: 'prazo_de_guarda' },
            relacionados: { contato: ligacao.contatoId },
          });
        }
        total += resultado.ligacaoIds.length;
      });
      if (vencidas.length < LOTE_DA_REMOCAO) {
        break;
      }
    }
    await this.limparPartesAbandonadas(agora);
    if (total > 0) {
      this.logger.log(
        `${total} gravação(ões) apagada(s) pelo prazo de guarda.`,
      );
    }
    return total;
  }

  /** Partes de ligações que ninguém finalizou, e partes de ligações já apagadas. */
  private async limparPartesAbandonadas(agora: Date): Promise<void> {
    const antigas = await this.prisma.$queryRaw<{ ligacao_id: string }[]>`
      SELECT DISTINCT p.ligacao_id
        FROM ligacoes_gravacao_partes p
        JOIN ligacoes l ON l.id = p.ligacao_id
       WHERE p.recebida_em < ${agora}::timestamptz - interval '2 days'
          OR l.gravacao_removida_em IS NOT NULL
       LIMIT 500`;
    for (const { ligacao_id } of antigas) {
      await this.gravacao.descartarPartes(ligacao_id);
    }
  }
}
