import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type ComPapel, setorDaPessoa } from '../comum/dominio/papeis';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { EVENTO_CONTAGENS_ATENDIMENTO } from './atendimento.constantes';
import type { ContagensAfetadas } from './motor-do-atendimento.service';
import { podeUsarAtendimento } from './visibilidade';

/**
 * A contagem do menu do Atendimento (`nao-lidas.atendimento`): conversas em
 * aberto com mensagens não lidas que estão com a pessoa ou, sem responsável,
 * nas filas da área dela (aguardando alguém assumir).
 *
 * Depois de cada mudança (entrada, leitura, atribuição…) o motor grava o
 * evento `atendimento.contagens` com quem foi afetado; aqui, depois do commit,
 * a contagem é refeita e emitida para quem está conectado.
 */
@Injectable()
export class ContagensDoAtendimento implements OnModuleInit {
  private readonly logger = new Logger('Atendimento');

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EventosDominioService,
    private readonly tempoReal: TempoRealService,
  ) {}

  onModuleInit(): void {
    this.eventos.registrarManipulador<ContagensAfetadas>(
      EVENTO_CONTAGENS_ATENDIMENTO,
      (evento) => this.entregar(evento.dados),
      'atendimento:contagens',
    );
  }

  /** Filtro das conversas que contam para a pessoa. */
  filtro(usuario: ComPapel & { id: string }): Prisma.ConversaWhereInput | null {
    if (!podeUsarAtendimento(usuario)) {
      return null;
    }
    const area = setorDaPessoa(usuario);
    return {
      status: { not: 'RESOLVIDA' },
      naoLidas: { gt: 0 },
      OR: [
        { responsavelId: usuario.id },
        ...(area ? [{ responsavelId: null, fila: { area } }] : []),
      ],
    };
  }

  async contar(usuario: ComPapel & { id: string }): Promise<number> {
    const filtro = this.filtro(usuario);
    return filtro ? this.prisma.conversa.count({ where: filtro }) : 0;
  }

  /** Refaz e emite a contagem de quem foi afetado e está conectado. */
  async entregar(afetados: ContagensAfetadas): Promise<void> {
    if (!this.tempoReal.ativo) {
      return;
    }
    const conectados = new Set(await this.tempoReal.usuariosConectados());
    if (conectados.size === 0) {
      return;
    }
    const ids = new Set(
      (afetados.usuarios ?? []).filter((id) => conectados.has(id)),
    );
    const areas = afetados.areas ?? [];
    const usuarios = await this.prisma.usuario.findMany({
      where: {
        ativo: true,
        id: { in: [...conectados] },
        OR: [
          { id: { in: [...ids] } },
          ...(areas.length > 0 ? [{ area: { in: [...areas] } }] : []),
        ],
      },
      select: { id: true, papel: true, area: true },
    });
    for (const usuario of usuarios) {
      try {
        this.tempoReal.emitirNaoLidas(usuario.id, {
          atendimento: await this.contar(usuario),
        });
      } catch (erro) {
        this.logger.warn(
          `Contagem do Atendimento de ${usuario.id} falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
  }
}
