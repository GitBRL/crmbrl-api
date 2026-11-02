import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  linkDaConversa,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';
import { MotorDoAtendimento } from './motor-do-atendimento.service';

/** O que o evento `usuario.desligado` traz (R7.4). */
interface UsuarioDesligado {
  usuario: { id: string; nome: string };
  destinatario: { id: string; nome: string };
}

/**
 * Desligamento (R7) no Atendimento: as conversas em aberto de quem saiu vão
 * para o mesmo destinatário dos outros itens (o líder, ou o C-level), com o
 * histórico `DESLIGAMENTO`, um aviso em cada conversa e uma notificação só
 * com o total. Roda pela outbox, depois do commit do desligamento
 * (manipulador idempotente: o que já foi encaminhado não é tocado de novo).
 */
@Injectable()
export class DesligamentoNoAtendimento implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EventosDominioService,
    private readonly motor: MotorDoAtendimento,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  onModuleInit(): void {
    this.eventos.registrarManipulador<UsuarioDesligado>(
      'usuario.desligado',
      async (evento) => {
        await this.encaminhar(evento.dados);
      },
      'atendimento:desligamento',
    );
  }

  /** Encaminha as conversas em aberto do desligado. Devolve quantas. */
  async encaminhar(dados: UsuarioDesligado): Promise<number> {
    const { usuario, destinatario } = dados;
    if (!usuario?.id || !destinatario?.id) {
      return 0;
    }
    return executarComoAtor(
      { tipoAtor: 'SISTEMA', descricao: `Desligamento de ${usuario.nome}` },
      () =>
        this.prisma.$transaction(async (tx) => {
          const conversas = await tx.conversa.findMany({
            where: { responsavelId: usuario.id, status: { not: 'RESOLVIDA' } },
            include: {
              fila: { select: { area: true } },
              contato: { select: { nome: true } },
            },
            orderBy: { criadoEm: 'asc' },
          });
          for (const conversa of conversas) {
            const salasAntes = this.motor.salas(conversa);
            const atualizada = await this.motor.atribuir(tx, conversa, {
              usuarioId: destinatario.id,
              motivo: 'DESLIGAMENTO',
              nota: `${usuario.nome} foi desligado(a).`,
              notificar: false,
            });
            await this.motor.avisoDeSistema(
              tx,
              { ...atualizada, fila: conversa.fila },
              `Conversa encaminhada para ${destinatario.nome}: ${usuario.nome} foi desligado(a).`,
              { evento: 'desligamento', de: usuario.id, para: destinatario.id },
            );
            await this.auditoria.registrar(tx, {
              acao: 'conversa.encaminhada',
              entidade: 'conversa',
              entidadeId: conversa.id,
              resumo: `Conversa com "${conversa.contato.nome}" encaminhada de ${usuario.nome} para ${destinatario.nome} (desligamento)`,
              dados: { de: usuario.id, para: destinatario.id },
              relacionados: {
                contato: conversa.contatoId,
                usuario: usuario.id,
              },
            });
            await this.motor.emitirConversa(tx, conversa.id, { salasAntes });
          }
          if (conversas.length > 0) {
            await this.notificacoes.notificar(tx, destinatario.id, {
              tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSAS_ENCAMINHADAS,
              titulo:
                conversas.length === 1
                  ? `Você recebeu 1 conversa de ${usuario.nome}`
                  : `Você recebeu ${conversas.length} conversas de ${usuario.nome}`,
              texto: `${usuario.nome} foi desligado(a); as conversas em aberto passaram para você.`,
              link:
                conversas.length === 1
                  ? linkDaConversa(conversas[0].id)
                  : '/atendimento',
              dados: {
                usuarioId: usuario.id,
                conversas: conversas.length,
              },
            });
            await this.motor.publicarContagens(tx, {
              usuarios: [destinatario.id],
            });
          }
          return conversas.length;
        }),
    );
  }
}
