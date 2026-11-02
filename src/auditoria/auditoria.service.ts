import { Injectable } from '@nestjs/common';
import {
  type Ator,
  contextoAtual,
} from '../comum/contexto/contexto-requisicao';
import { sanitizarObjeto } from '../comum/dados/sanitizar';
import type { EventoAuditoria, Prisma } from '../generated/prisma/client';
import type { Tx } from '../prisma/prisma.service';

/** Entidades que aparecem em linhas do tempo (R3.5) e nas referências `relacionados`. */
export type EntidadeRelacionavel =
  | 'usuario'
  | 'contato'
  | 'empresa'
  | 'negocio'
  | 'atividade'
  | 'funil'
  | 'webhook_entrada'
  | 'webhook_saida';

export interface NovoEventoAuditoria {
  /** `entidade.verbo` no particípio: `negocio.movido`, `contato.reconvertido`, `usuario.desligado`. */
  acao: string;
  /** Nome da entidade em snake_case singular: `negocio`, `contato`, `regra_distribuicao`. */
  entidade: string;
  entidadeId?: string | null;
  /** Frase legível em português: "Negócio "ACME" movido de Proposta para Negociação". */
  resumo: string;
  /**
   * Detalhes: campos alterados (`{ alteracoes: calcularAlteracoes(antes, depois) }`),
   * contagens etc. Senhas, tokens e segredos são retirados automaticamente.
   */
  dados?: Record<string, unknown> | null;
  /**
   * Outras entidades ligadas ao evento, para a linha do tempo (R3.5): o evento
   * aparece também na delas. A própria entidade entra sozinha.
   *
   * ```ts
   * relacionados: { contato: negocio.contatoId, empresa: negocio.empresaId }
   * ```
   */
  relacionados?: Partial<
    Record<EntidadeRelacionavel, string | null | undefined>
  >;
  /** Sobrescreve o ator do contexto (ex.: o usuário que acabou de fazer login). */
  ator?: Ator;
}

/** Referência gravada em `eventos_auditoria.relacionados`: `contato:<uuid>`. */
export function referenciaDeAuditoria(entidade: string, id: string): string {
  return `${entidade}:${id}`;
}

/**
 * Filtro Prisma dos eventos ligados a uma entidade (ela mesma ou como
 * relacionada) — a base da linha do tempo (R3.5).
 *
 * ```ts
 * prisma.eventoAuditoria.findMany({ where: filtroDeLinhaDoTempo('contato', id), orderBy: { id: 'desc' } })
 * ```
 */
export function filtroDeLinhaDoTempo(
  entidade: string,
  id: string,
): Prisma.EventoAuditoriaWhereInput {
  return { relacionados: { has: referenciaDeAuditoria(entidade, id) } };
}

/**
 * Auditoria (R3.1–R3.3): grava um evento **na mesma transação** da alteração.
 * Ator (usuário, `SISTEMA`, `WEBHOOK`, `AUTOMACAO`, `IA`), IP, user agent e id
 * da requisição vêm do contexto da requisição (ou do job).
 *
 * ```ts
 * await this.prisma.$transaction(async (tx) => {
 *   const negocio = await tx.negocio.update({ … });
 *   await this.auditoria.registrar(tx, {
 *     acao: 'negocio.movido', entidade: 'negocio', entidadeId: negocio.id,
 *     resumo: `Negócio "${negocio.titulo}" movido para ${etapa.nome}`,
 *     dados: { deEtapaId, paraEtapaId },
 *     relacionados: { contato: negocio.contatoId },
 *   });
 * });
 * ```
 */
@Injectable()
export class AuditoriaService {
  async registrar(
    tx: Tx,
    evento: NovoEventoAuditoria,
  ): Promise<EventoAuditoria> {
    const contexto = contextoAtual();
    const ator = evento.ator;
    const usuario = ator ? ator.usuario : contexto.usuario;
    const dados = sanitizarObjeto(evento.dados ?? undefined);
    const relacionados = new Set<string>();
    if (evento.entidadeId) {
      relacionados.add(
        referenciaDeAuditoria(evento.entidade, evento.entidadeId),
      );
    }
    for (const [entidade, id] of Object.entries(evento.relacionados ?? {})) {
      if (id) {
        relacionados.add(referenciaDeAuditoria(entidade, id));
      }
    }
    return tx.eventoAuditoria.create({
      data: {
        tipoAtor: ator?.tipoAtor ?? contexto.tipoAtor,
        usuarioId: usuario?.id ?? null,
        atorDescricao:
          (ator
            ? (ator.descricao ?? ator.usuario?.nome)
            : contexto.atorDescricao) ?? null,
        acao: evento.acao,
        entidade: evento.entidade,
        entidadeId: evento.entidadeId ?? null,
        resumo: evento.resumo,
        dados:
          dados && Object.keys(dados).length > 0
            ? (dados as Prisma.InputJsonObject)
            : undefined,
        relacionados: [...relacionados],
        ip: contexto.ip ?? null,
        userAgent: contexto.userAgent ?? null,
        requisicaoId: contexto.requisicaoId,
      },
    });
  }
}
