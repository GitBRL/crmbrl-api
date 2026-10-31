import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { liderDaArea } from '../comum/dominio/papeis';
import {
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { EVENTOS_DA_ONDA_B } from '../comum/gatilhos/catalogo';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { Campanha, StatusCampanha } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { AgendadorDeEnvio } from './agendador-de-envio.service';
import {
  linkDaCampanha,
  REGRA_DISPAROS,
  TIPOS_NOTIFICACAO_DISPAROS,
} from './disparos.constantes';
import { ProgressoDaCampanha } from './progresso-da-campanha.service';

const ROTULO_DO_STATUS: Readonly<Record<StatusCampanha, string>> = {
  RASCUNHO: 'rascunho',
  AGUARDANDO_APROVACAO: 'aguardando aprovação',
  AGENDADA: 'agendada',
  EM_ANDAMENTO: 'em andamento',
  PAUSADA: 'pausada',
  CONCLUIDA: 'concluída',
  CANCELADA: 'cancelada',
};

/**
 * Transições do ciclo de vida da campanha (R17):
 * rascunho → (aguardando aprovação) → agendada → em andamento ⇄ pausada →
 * concluída/cancelada. Cada transição trava a campanha, confere o status de
 * origem (422 se não cabe), audita e avisa o progresso em tempo real.
 * Quem chama define o ator (a pessoa, ou `AUTOMACAO` nas feitas pelo envio).
 */
@Injectable()
export class CicloDaCampanha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly progresso: ProgressoDaCampanha,
    private readonly agendador: AgendadorDeEnvio,
  ) {}

  /** RASCUNHO → AGUARDANDO_APROVACAO (e avisa os líderes). */
  solicitarAprovacao(id: string, agendadaPara: Date | null): Promise<Campanha> {
    return this.transitar(
      id,
      ['RASCUNHO'],
      'pedir a aprovação de',
      async (tx, campanha) => {
        const atual = await tx.campanha.update({
          where: { id },
          data: {
            status: 'AGUARDANDO_APROVACAO',
            aprovacaoSolicitadaEm: new Date(),
            agendadaPara,
            reprovacaoMotivo: null,
          },
        });
        await this.registrar(
          tx,
          atual,
          'campanha.aprovacao_solicitada',
          `Aprovação da campanha "${atual.nome}" solicitada`,
          { agendadaPara },
        );
        const destinos = await tx.usuario.findMany({
          where: {
            ativo: true,
            OR: [
              { papel: 'ADMIN' },
              { papel: 'C_LEVEL' },
              ...(campanha.area ? [{ papel: liderDaArea(campanha.area) }] : []),
            ],
            NOT: { id: campanha.criadoPorId ?? undefined },
          },
          select: { id: true },
        });
        await this.notificacoes.notificarVarios(
          tx,
          destinos.map((u) => u.id),
          {
            tipo: TIPOS_NOTIFICACAO_DISPAROS.APROVACAO_PEDIDA,
            titulo: 'Campanha esperando aprovação',
            texto: `A campanha "${atual.nome}" precisa da sua aprovação para começar.`,
            link: linkDaCampanha(id),
          },
        );
        return atual;
      },
    );
  }

  /**
   * RASCUNHO/AGUARDANDO_APROVACAO → AGENDADA (data futura) ou EM_ANDAMENTO.
   * `aprovadaPorId` marca a aprovação do líder.
   */
  liberar(
    id: string,
    agendadaPara: Date | null,
    aprovadaPorId: string | null = null,
  ): Promise<Campanha> {
    return this.transitar(
      id,
      ['RASCUNHO', 'AGUARDANDO_APROVACAO'],
      'iniciar',
      async (tx) => {
        const agora = new Date();
        const futura =
          agendadaPara !== null &&
          agendadaPara.getTime() > agora.getTime() + 1000;
        const atual = await tx.campanha.update({
          where: { id },
          data: {
            status: futura ? 'AGENDADA' : 'EM_ANDAMENTO',
            agendadaPara: futura ? agendadaPara : null,
            iniciadaEm: futura ? null : agora,
            proximoEnvioEm: futura ? agendadaPara : agora,
            falhasSeguidas: 0,
            enviadosNoLote: 0,
            pausaMotivo: null,
            ...(aprovadaPorId ? { aprovadaPorId, aprovadaEm: agora } : {}),
          },
        });
        await this.registrar(
          tx,
          atual,
          futura ? 'campanha.agendada' : 'campanha.iniciada',
          futura
            ? `Campanha "${atual.nome}" agendada`
            : `Campanha "${atual.nome}" iniciada`,
          { agendadaPara: futura ? agendadaPara : null },
        );
        await this.agendador.agendar(
          id,
          futura ? (agendadaPara as Date) : agora,
          tx,
        );
        await this.progresso.atualizar(tx, id, true);
        return atual;
      },
    );
  }

  /** AGUARDANDO_APROVACAO → RASCUNHO com o motivo. */
  reprovar(id: string, motivo: string): Promise<Campanha> {
    return this.transitar(
      id,
      ['AGUARDANDO_APROVACAO'],
      'reprovar',
      async (tx) => {
        const atual = await tx.campanha.update({
          where: { id },
          data: {
            status: 'RASCUNHO',
            reprovacaoMotivo: motivo,
            aprovacaoSolicitadaEm: null,
          },
        });
        await this.registrar(
          tx,
          atual,
          'campanha.reprovada',
          `Campanha "${atual.nome}" reprovada: ${motivo}`,
          { motivo },
        );
        if (atual.criadoPorId) {
          await this.notificacoes.notificar(tx, atual.criadoPorId, {
            tipo: TIPOS_NOTIFICACAO_DISPAROS.REPROVADA,
            titulo: 'Campanha reprovada',
            texto: `"${atual.nome}": ${motivo}`,
            link: linkDaCampanha(id),
          });
        }
        await this.progresso.atualizar(tx, id, true);
        return atual;
      },
    );
  }

  /** Avisa o criador de que a campanha foi aprovada (a aprovação em si é `liberar`). */
  async avisarAprovacao(campanha: Campanha, aprovador: string): Promise<void> {
    if (!campanha.criadoPorId) {
      return;
    }
    await this.prisma.$transaction((tx) =>
      this.notificacoes.notificar(tx, campanha.criadoPorId as string, {
        tipo: TIPOS_NOTIFICACAO_DISPAROS.APROVADA,
        titulo: 'Campanha aprovada',
        texto: `${aprovador} aprovou "${campanha.nome}".`,
        link: linkDaCampanha(campanha.id),
      }),
    );
  }

  /** AGENDADA → EM_ANDAMENTO (a hora chegou). */
  ativarAgendada(id: string): Promise<Campanha> {
    return this.transitar(id, ['AGENDADA'], 'começar', async (tx) => {
      const agora = new Date();
      const atual = await tx.campanha.update({
        where: { id },
        data: {
          status: 'EM_ANDAMENTO',
          iniciadaEm: agora,
          proximoEnvioEm: agora,
        },
      });
      await this.registrar(
        tx,
        atual,
        'campanha.iniciada',
        `Campanha "${atual.nome}" iniciada no horário agendado`,
        {},
      );
      await this.progresso.atualizar(tx, id, true);
      return atual;
    });
  }

  /** EM_ANDAMENTO → PAUSADA. `automatica`: pausa do sistema (avisa o criador). */
  pausar(
    id: string,
    motivo: string | null,
    automatica = false,
  ): Promise<Campanha> {
    return this.transitar(id, ['EM_ANDAMENTO'], 'pausar', async (tx) => {
      const atual = await tx.campanha.update({
        where: { id },
        data: {
          status: 'PAUSADA',
          pausadaEm: new Date(),
          pausaMotivo: motivo ?? (automatica ? null : 'Pausada manualmente.'),
          proximoEnvioEm: null,
        },
      });
      await this.registrar(
        tx,
        atual,
        'campanha.pausada',
        `Campanha "${atual.nome}" pausada${automatica ? ' automaticamente' : ''}${motivo ? `: ${motivo}` : ''}`,
        { automatica, motivo },
      );
      if (automatica && atual.criadoPorId) {
        await this.notificacoes.notificar(tx, atual.criadoPorId, {
          tipo: TIPOS_NOTIFICACAO_DISPAROS.PAUSADA,
          titulo: 'Campanha pausada',
          texto: `"${atual.nome}" foi pausada${motivo ? `: ${motivo}` : '.'}`,
          link: linkDaCampanha(id),
        });
      }
      await this.progresso.atualizar(tx, id, true);
      return atual;
    });
  }

  /** PAUSADA → EM_ANDAMENTO. */
  retomar(id: string): Promise<Campanha> {
    return this.transitar(id, ['PAUSADA'], 'retomar', async (tx) => {
      const agora = new Date();
      const atual = await tx.campanha.update({
        where: { id },
        data: {
          status: 'EM_ANDAMENTO',
          pausadaEm: null,
          pausaMotivo: null,
          falhasSeguidas: 0,
          proximoEnvioEm: agora,
        },
      });
      await this.registrar(
        tx,
        atual,
        'campanha.retomada',
        `Campanha "${atual.nome}" retomada`,
        {},
      );
      await this.agendador.agendar(id, agora, tx);
      await this.progresso.atualizar(tx, id, true);
      return atual;
    });
  }

  /** Qualquer status ativo → CANCELADA; o que ainda não saiu fica `EXCLUIDO`. */
  cancelar(id: string): Promise<Campanha> {
    return this.transitar(
      id,
      [
        'RASCUNHO',
        'AGUARDANDO_APROVACAO',
        'AGENDADA',
        'EM_ANDAMENTO',
        'PAUSADA',
      ],
      'cancelar',
      async (tx) => {
        const cancelados = await tx.campanhaDestinatario.updateMany({
          where: { campanhaId: id, status: 'PENDENTE' },
          data: {
            status: 'EXCLUIDO',
            motivo: 'Campanha cancelada antes do envio.',
          },
        });
        const atual = await tx.campanha.update({
          where: { id },
          data: {
            status: 'CANCELADA',
            canceladaEm: new Date(),
            proximoEnvioEm: null,
          },
        });
        await this.registrar(
          tx,
          atual,
          'campanha.cancelada',
          `Campanha "${atual.nome}" cancelada`,
          { naoEnviados: cancelados.count },
        );
        await this.progresso.atualizar(tx, id, true);
        return atual;
      },
    );
  }

  /** EM_ANDAMENTO → CONCLUIDA (publica `campanha.concluida`). */
  concluir(id: string): Promise<Campanha> {
    return this.transitar(id, ['EM_ANDAMENTO'], 'concluir', async (tx) => {
      const contadores = await this.progresso.atualizar(tx, id, true);
      const atual = await tx.campanha.update({
        where: { id },
        data: {
          status: 'CONCLUIDA',
          concluidaEm: new Date(),
          proximoEnvioEm: null,
        },
      });
      await this.registrar(
        tx,
        atual,
        'campanha.concluida',
        `Campanha "${atual.nome}" concluída: ${contadores.enviados} enviadas, ${contadores.falhas} falhas`,
        { ...contadores },
      );
      await this.eventos.publicar(tx, EVENTOS_DA_ONDA_B.CAMPANHA_CONCLUIDA, {
        campanhaId: id,
        enviados: contadores.enviados,
        falhas: contadores.falhas,
      });
      if (atual.criadoPorId) {
        await this.notificacoes.notificar(tx, atual.criadoPorId, {
          tipo: TIPOS_NOTIFICACAO_DISPAROS.CONCLUIDA,
          titulo: 'Campanha concluída',
          texto: `"${atual.nome}": ${contadores.enviados} mensagens enviadas.`,
          link: linkDaCampanha(id),
        });
      }
      await this.progresso.atualizar(tx, id, true);
      return atual;
    });
  }

  /** Reenviar falhas: devolve os `FALHOU` para a fila e reabre a campanha. */
  reabrirParaReenvio(
    id: string,
  ): Promise<{ campanha: Campanha; reenfileirados: number }> {
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'disparos-campanha', id);
      const campanha = await this.carregar(tx, id);
      this.exigir(
        campanha,
        ['EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA'],
        'reenviar as falhas de',
      );
      const { count } = await tx.campanhaDestinatario.updateMany({
        where: { campanhaId: id, status: 'FALHOU' },
        data: {
          status: 'PENDENTE',
          motivo: null,
          falhouEm: null,
          mensagemId: null,
        },
      });
      if (count === 0) {
        throw new RegraVioladaException(
          REGRA_DISPAROS,
          'Não há falhas para reenviar.',
          {
            motivo: 'sem_falhas',
          },
        );
      }
      const agora = new Date();
      const atual = await tx.campanha.update({
        where: { id },
        data: {
          status: 'EM_ANDAMENTO',
          concluidaEm: null,
          pausadaEm: null,
          pausaMotivo: null,
          falhasSeguidas: 0,
          proximoEnvioEm: agora,
        },
      });
      await this.registrar(
        tx,
        atual,
        'campanha.falhas_reenviadas',
        `${count} falhas da campanha "${atual.nome}" voltaram para a fila`,
        { reenfileirados: count },
      );
      await this.agendador.agendar(id, agora, tx);
      await this.progresso.atualizar(tx, id, true);
      return { campanha: atual, reenfileirados: count };
    });
  }

  // -------------------------------------------------------------------------

  private async transitar<T>(
    id: string,
    origem: readonly StatusCampanha[],
    acao: string,
    fn: (tx: Tx, campanha: Campanha) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'disparos-campanha', id);
      const campanha = await this.carregar(tx, id);
      this.exigir(campanha, origem, acao);
      return fn(tx, campanha);
    });
  }

  private async carregar(tx: Tx, id: string): Promise<Campanha> {
    const campanha = await tx.campanha.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!campanha) {
      throw new NaoEncontradoException('Campanha não encontrada.');
    }
    return campanha;
  }

  private exigir(
    campanha: Campanha,
    origem: readonly StatusCampanha[],
    acao: string,
  ): void {
    if (!origem.includes(campanha.status)) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        `Não é possível ${acao} uma campanha ${ROTULO_DO_STATUS[campanha.status]}.`,
        { motivo: 'status_invalido', status: campanha.status },
      );
    }
  }

  private async registrar(
    tx: Tx,
    campanha: Campanha,
    acao: string,
    resumo: string,
    dados: Record<string, unknown>,
  ): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao,
      entidade: 'campanha',
      entidadeId: campanha.id,
      resumo,
      dados: {
        campanha: campanha.nome,
        canal: campanha.canal,
        regra: REGRA_DISPAROS,
        ...dados,
      },
    });
  }
}
