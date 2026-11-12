import type { TipoPrimeiraInteracao } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';

/** Uma ação feita por uma pessoa com o contato (R6.7). */
export interface InteracaoHumana {
  contatoId: string;
  tipo: TipoPrimeiraInteracao;
  /** A pessoa que agiu. Sem ela (bot, automação, IA, sistema) nada é registrado. */
  usuarioId: string | null | undefined;
  /** Quando aconteceu (padrão: agora). */
  quando?: Date;
}

/**
 * R6.7 — ponto único de registro da primeira interação do negócio. Chame-o na
 * mesma transação da ação, SÓ quando uma pessoa agiu (ligação feita ou atendida,
 * mensagem ou e-mail enviado por ela, atividade concluída que não seja nota):
 * ligação do WhatsApp, mensagem do atendimento, atividade concluída e, na T4,
 * ligação do 3C+. Bot, automação, chatbot, SDR com IA e sistema não contam.
 *
 * Grava, de uma vez só, em todos os negócios abertos do contato criados antes
 * da ação e ainda sem primeira interação. É idempotente: o que já foi gravado
 * nunca muda. Usa SQL direto para não mexer em `atualizado_em` do negócio.
 */
export async function registrarPrimeiraInteracao(
  tx: Tx,
  interacao: InteracaoHumana,
): Promise<number> {
  if (!interacao.usuarioId) {
    return 0;
  }
  const quando = interacao.quando ?? new Date();
  // Horários de fora (Meta, 3C+) vêm truncados no segundo: um negócio criado no mesmo segundo da ação
  // ainda é "anterior" a ela. A tolerância de 1 s cobre isso, e o registro nunca fica antes da criação
  // (o tempo até o atendimento não sai negativo).
  return tx.$executeRaw`
    UPDATE negocios
       SET primeira_interacao_em = greatest(${quando}::timestamptz, criado_em),
           primeira_interacao_tipo = ${interacao.tipo}::tipo_primeira_interacao,
           primeira_interacao_por_id = ${interacao.usuarioId}::uuid
     WHERE contato_id = ${interacao.contatoId}::uuid
       AND status = 'ABERTO'
       AND excluido_em IS NULL
       AND primeira_interacao_em IS NULL
       AND criado_em < ${quando}::timestamptz + interval '1 second'`;
}
