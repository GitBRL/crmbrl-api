import { Injectable } from '@nestjs/common';
import {
  linkDaConversa,
  resumir,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from '../atendimento/atendimento.constantes';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { EVENTOS_DA_ONDA_B } from '../comum/gatilhos/catalogo';
import type { ExecucaoAtual } from '../comum/passos/tipos';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcoesDoBot, type SaidaDeAcao } from './acoes-do-bot.service';

export interface ConfigDeTransferir {
  /** Fila de destino (ausente = mantém a da conversa). */
  filaId?: string;
  /** Pessoa de destino (ausente = a fila distribui). */
  usuarioId?: string;
  /** Aviso ao contato antes de passar para a equipe. */
  mensagem?: string;
  /** Padrão `true`: deixa o resumo das respostas como nota interna. */
  incluirResumo?: boolean;
}

interface PassoDoHistorico {
  tipo: string;
  status: string;
  resultado: Prisma.JsonValue;
}

/** O resumo das perguntas e respostas do bot, para a nota interna. */
export function montarResumo(
  nomeDoFluxo: string,
  historico: readonly PassoDoHistorico[],
): string {
  const linhas: string[] = [];
  for (const passo of historico) {
    if (passo.status !== 'CONCLUIDO' || !passo.tipo.startsWith('pergunta.')) {
      continue;
    }
    const saida = (
      passo.resultado as { saida?: Record<string, unknown> } | null
    )?.saida;
    if (saida && typeof saida.pergunta === 'string') {
      const resposta =
        typeof saida.resposta === 'string' || typeof saida.resposta === 'number'
          ? String(saida.resposta)
          : '(sem resposta)';
      linhas.push(`• ${saida.pergunta.split('\n')[0]} → ${resposta}`);
    }
  }
  return [
    `Atendimento automático (fluxo "${nomeDoFluxo}") encerrado e passado para a equipe.`,
    linhas.length > 0
      ? 'Respostas do contato:'
      : 'O contato não respondeu a perguntas.',
    ...linhas,
  ].join('\n');
}

/**
 * Passo `transferir` (R18): passa a conversa para a equipe. Deixa o resumo das
 * respostas como nota interna, move/atribui pela fila (mesma distribuição do
 * Atendimento), notifica o responsável e publica `chatbot.transferida`.
 */
@Injectable()
export class TransferenciaDoBot {
  constructor(
    private readonly prisma: PrismaService,
    private readonly motor: MotorDoAtendimento,
    private readonly acoes: AcoesDoBot,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async transferir(
    execucao: ExecucaoAtual,
    config: ConfigDeTransferir,
    chaveIdempotencia: string,
  ): Promise<SaidaDeAcao & { resumo: string }> {
    const historico = await this.prisma.execucaoPasso.findMany({
      where: { execucaoId: execucao.id },
      orderBy: { ordem: 'asc' },
      select: { tipo: true, status: true, resultado: true },
    });
    const resumo = montarResumo(execucao.nome, historico);
    if (execucao.teste) {
      return { simulado: true, resumo, filaId: config.filaId ?? null };
    }
    const conversaId = this.acoes.exigirConversa(execucao);
    const chave = `${chaveIdempotencia}:resumo`;
    return this.prisma.$transaction(async (tx) => {
      const conversa = await this.acoes.conversaAberta(tx, conversaId);
      const ja = await tx.mensagem.findFirst({
        where: { conversaId, metadados: { path: ['chaveBot'], equals: chave } },
        select: { id: true },
      });
      if (ja) {
        return { jaTransferida: true, resumo };
      }
      const antes = await this.motor.carregar(tx, conversaId);
      const salasAntes = this.motor.salas(antes);
      const filaDestino = config.filaId
        ? await tx.filaAtendimento.findFirst({
            where: { id: config.filaId, ativa: true, excluidoEm: null },
            select: { id: true, nome: true },
          })
        : null;
      const usuarioDestino = config.usuarioId
        ? await tx.usuario.findFirst({
            where: { id: config.usuarioId, ativo: true },
            select: { id: true },
          })
        : null;

      if (config.incluirResumo !== false) {
        const nota = await tx.mensagem.create({
          data: {
            conversaId,
            canalId: conversa.canalId,
            direcao: 'INTERNA',
            tipo: 'TEXTO',
            texto: resumo,
            autorId: null,
            autorTipo: 'BOT',
            metadados: { chaveBot: chave, bot: true, resumoDoBot: true },
          },
        });
        await this.motor.emitirMensagem(tx, antes, nota.id);
      } else {
        // Marca a transferência como feita (idempotência) sem criar nota visível.
        await tx.mensagem.create({
          data: {
            conversaId,
            canalId: conversa.canalId,
            direcao: 'SISTEMA',
            tipo: 'TEXTO',
            texto: 'Conversa passada para a equipe pelo chatbot.',
            autorTipo: 'BOT',
            metadados: { chaveBot: chave, bot: true },
          },
        });
      }

      const nota = `Transferida pelo fluxo "${execucao.nome}"`;
      let atual = conversa;
      if (usuarioDestino) {
        atual = await this.motor.atribuir(tx, atual, {
          usuarioId: usuarioDestino.id,
          filaId: filaDestino?.id,
          motivo: 'TRANSFERENCIA',
          nota,
          tituloDaNotificacao: 'O chatbot passou uma conversa para você',
        });
      } else if (filaDestino && filaDestino.id !== conversa.filaId) {
        atual = await this.motor.atribuir(tx, atual, {
          usuarioId: null,
          filaId: filaDestino.id,
          motivo: 'TRANSFERENCIA',
          nota,
          notificar: false,
        });
        atual = await this.motor.distribuir(tx, atual);
      } else if (!atual.responsavelId) {
        atual = await this.motor.distribuir(tx, atual);
      }
      // Responsável que já era dele: avisa que o bot terminou e passou a vez.
      if (
        atual.responsavelId &&
        atual.responsavelId === conversa.responsavelId
      ) {
        const contato = await tx.contato.findUnique({
          where: { id: conversa.contatoId },
          select: { nome: true },
        });
        await this.notificacoes.notificar(tx, atual.responsavelId, {
          tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSA_TRANSFERIDA,
          titulo: 'O chatbot passou uma conversa para você',
          texto: `${contato?.nome ?? 'Contato'}: ${resumir(resumo)}`,
          link: linkDaConversa(conversaId),
          dados: { conversaId, motivo: 'TRANSFERENCIA' },
        });
      }
      await this.auditoria.registrar(tx, {
        acao: 'conversa.transferida_pelo_bot',
        entidade: 'conversa',
        entidadeId: conversaId,
        resumo: `Conversa passada para a equipe pelo fluxo "${execucao.nome}"`,
        dados: {
          fluxoId: execucao.fluxoId,
          execucaoId: execucao.id,
          filaId: atual.filaId,
          responsavelId: atual.responsavelId,
        },
        relacionados: { contato: conversa.contatoId },
      });
      await this.eventos.publicar(tx, EVENTOS_DA_ONDA_B.CHATBOT_TRANSFERIDA, {
        conversaId,
        contatoId: conversa.contatoId,
        fluxoId: execucao.fluxoId,
        execucaoId: execucao.id,
        filaId: atual.filaId,
      });
      await this.motor.emitirConversa(tx, conversaId, { salasAntes });
      const depois = await this.motor.carregar(tx, conversaId);
      await this.motor.publicarContagens(tx, {
        usuarios: [conversa.responsavelId, atual.responsavelId],
        areas: [antes.fila?.area, depois.fila?.area],
      });
      return {
        transferida: true,
        filaId: atual.filaId,
        responsavelId: atual.responsavelId,
        resumo,
      };
    });
  }
}
