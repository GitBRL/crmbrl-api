import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ClienteGatewayWhatsapp } from '../canais/whatsapp/cliente-gateway';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { RegraVioladaException } from '../comum/erros/excecoes';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type { Campanha } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  AgendadorDeEnvio,
  type PedidoDeEnvioDeCampanha,
} from './agendador-de-envio.service';
import { CanaisDaCampanha } from './canais-da-campanha.service';
import { CicloDaCampanha } from './ciclo-da-campanha.service';
import {
  ESPERA_DE_CONFIRMACAO_SEGUNDOS,
  ESPERA_SEM_CANAL_SEGUNDOS,
  FILA_DISPAROS_ENVIAR,
  FILA_DISPAROS_VARREDURA,
  LIMITE_DE_PULOS_POR_RODADA,
} from './disparos.constantes';
import { EntregaDeCampanha } from './entrega-de-campanha.service';
import { ProgressoDaCampanha } from './progresso-da-campanha.service';
import { esperaDepoisDoEnvio, situacaoDaJanela } from './ritmo';
import { PublicoDaCampanha } from './publico.service';
import { SincronizacaoDaCampanha } from './sincronizacao-da-campanha.service';

type Resultado = 'pulou' | 'fim';

/** Margem para um job que dispara um instante antes da hora marcada. */
const MARGEM_MS = 1500;

/**
 * Motor de envio das campanhas (R17). Cada campanha em andamento tem uma
 * cadeia de jobs `disparos.enviar`: cada rodada envia **uma** mensagem e
 * agenda a seguinte (`startAfter` = intervalo aleatório do ritmo), então o
 * ritmo sobrevive a reinícios e nunca passa do que a campanha e o número (R13)
 * permitem. Tudo roda com o ator `AUTOMACAO` (descrição = nome da campanha).
 *
 * Uma rodada: ativa a agendada → monta o público (1ª vez) → sincroniza os status →
 * respeita a janela → escolhe o número do rodízio (limite diário/aquecimento,
 * conexão, pausa) → pula opt-out → verifica o WhatsApp do destinatário (cache
 * do gateway; sem WhatsApp = INVALIDO) → cria a mensagem na conversa do contato
 * (mesma transação que agenda a próxima rodada). Sem pendentes e com tudo
 * confirmado, conclui.
 *
 * A varredura de cada minuto ativa as agendadas, retoma as que perderam o
 * job (queda no meio) e sincroniza as que ainda esperam entrega/leitura.
 */
@Injectable()
export class EnvioDeCampanha implements OnModuleInit {
  private readonly logger = new Logger(EnvioDeCampanha.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly agendador: AgendadorDeEnvio,
    private readonly ciclo: CicloDaCampanha,
    private readonly publico: PublicoDaCampanha,
    private readonly canais: CanaisDaCampanha,
    private readonly entrega: EntregaDeCampanha,
    private readonly sincronizacao: SincronizacaoDaCampanha,
    private readonly progresso: ProgressoDaCampanha,
    private readonly gateway: ClienteGatewayWhatsapp,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<PedidoDeEnvioDeCampanha>(
      FILA_DISPAROS_ENVIAR,
      (trabalho) => this.processar(trabalho),
      {
        concorrencia: 4,
        intervaloDeConsultaSegundos: 1,
        tentativas: 3,
        intervaloEntreTentativasSegundos: 30,
        prazoDeExecucaoSegundos: 300,
      },
    );
    await this.fila.trabalhar(
      FILA_DISPAROS_VARREDURA,
      async () => {
        await this.varrer();
      },
      {
        tentativas: 0,
      },
    );
    await this.fila.agendar(FILA_DISPAROS_VARREDURA, '* * * * *');
  }

  /** O manipulador do job de envio. */
  async processar(trabalho: Trabalho<PedidoDeEnvioDeCampanha>): Promise<void> {
    const campanha = await this.prisma.campanha.findFirst({
      where: { id: trabalho.dados.campanhaId, excluidoEm: null },
    });
    if (!campanha) {
      return;
    }
    await executarComoAtor(
      { tipoAtor: 'AUTOMACAO', descricao: campanha.nome },
      () => this.rodada(campanha.id, trabalho.dados.quando),
    );
  }

  /**
   * Varredura (a cada minuto): agendadas na hora, em andamento sem job (queda
   * no meio) e sincronização de status das ativas e das concluídas há pouco.
   */
  async varrer(
    agora: Date = new Date(),
  ): Promise<{ ativadas: number; retomadas: number; sincronizadas: number }> {
    let ativadas = 0;
    let retomadas = 0;
    const agendadas = await this.prisma.campanha.findMany({
      where: {
        status: 'AGENDADA',
        excluidoEm: null,
        agendadaPara: { lte: agora },
      },
      select: { id: true, proximoEnvioEm: true, agendadaPara: true },
    });
    for (const { id, proximoEnvioEm, agendadaPara } of agendadas) {
      await this.agendador.agendar(id, proximoEnvioEm ?? agendadaPara ?? agora);
      ativadas++;
    }
    const paradas = await this.prisma.campanha.findMany({
      where: {
        status: 'EM_ANDAMENTO',
        excluidoEm: null,
        OR: [
          { proximoEnvioEm: null },
          { proximoEnvioEm: { lt: new Date(agora.getTime() - 2 * 60_000) } },
        ],
      },
      select: { id: true, proximoEnvioEm: true },
    });
    for (const { id, proximoEnvioEm } of paradas) {
      // Sem instante gravado (ou perdido na queda): marca "agora" e dispara.
      const quando = proximoEnvioEm ?? agora;
      if (!proximoEnvioEm) {
        await this.prisma.campanha.update({
          where: { id },
          data: { proximoEnvioEm: quando },
        });
      }
      await this.agendador.agendar(id, quando);
      retomadas++;
    }
    const recentes = new Date(agora.getTime() - 3 * 24 * 3_600_000);
    const aSincronizar = await this.prisma.campanha.findMany({
      where: {
        excluidoEm: null,
        OR: [
          { status: { in: ['EM_ANDAMENTO', 'PAUSADA'] } },
          {
            status: { in: ['CONCLUIDA', 'CANCELADA'] },
            atualizadoEm: { gte: recentes },
          },
        ],
      },
      select: { id: true, nome: true },
    });
    let sincronizadas = 0;
    for (const campanha of aSincronizar) {
      try {
        await executarComoAtor(
          { tipoAtor: 'AUTOMACAO', descricao: campanha.nome },
          () => this.sincronizacao.sincronizar(campanha.id),
        );
        sincronizadas++;
      } catch (erro) {
        this.logger.warn(
          `Sincronização da campanha ${campanha.id} falhou: ${mensagemDe(erro)}`,
        );
      }
    }
    return { ativadas, retomadas, sincronizadas };
  }

  // -------------------------------------------------------------------------

  private async rodada(id: string, quando: string): Promise<void> {
    let campanha = await this.carregar(id);
    if (!campanha) {
      return;
    }
    // Job velho ou repetido (pausa e retomada, varredura): a campanha já aguarda outro instante.
    if (campanha.proximoEnvioEm?.toISOString() !== quando) {
      return;
    }
    if (campanha.status === 'AGENDADA') {
      if (
        campanha.agendadaPara &&
        campanha.agendadaPara.getTime() > Date.now() + MARGEM_MS
      ) {
        return;
      }
      try {
        campanha = await this.ciclo.ativarAgendada(id);
      } catch (erro) {
        if (erro instanceof RegraVioladaException) {
          return;
        }
        throw erro;
      }
    }
    if (campanha.status !== 'EM_ANDAMENTO') {
      return;
    }
    if (campanha.totalDestinatarios === 0) {
      await this.publico.montar(campanha);
      await this.prisma.$transaction((tx) =>
        this.progresso.atualizar(tx, id, true),
      );
    }
    const sincronizada = await this.sincronizacao.sincronizar(id);
    if (sincronizada.pausou) {
      return;
    }
    for (let i = 0; i < LIMITE_DE_PULOS_POR_RODADA; i++) {
      if ((await this.tentarUm(id)) === 'fim') {
        return;
      }
    }
    // Muitos pulos seguidos: continua na próxima rodada, sem esperar o ritmo.
    await this.agendador.agendar(id, campanha.proximoEnvioEm ?? new Date());
  }

  private carregar(id: string): Promise<Campanha | null> {
    return this.prisma.campanha.findFirst({ where: { id, excluidoEm: null } });
  }

  /** Tenta enviar para o próximo destinatário. `pulou` = só mexeu num destinatário (invalido, opt-out). */
  private async tentarUm(id: string): Promise<Resultado> {
    const agora = new Date();
    const campanha = await this.carregar(id);
    if (!campanha || campanha.status !== 'EM_ANDAMENTO') {
      return 'fim';
    }
    if (
      campanha.proximoEnvioEm &&
      campanha.proximoEnvioEm.getTime() > agora.getTime() + MARGEM_MS
    ) {
      return 'fim';
    }
    const janela = situacaoDaJanela(campanha.janelaEnvio, agora);
    if (!janela.aberta) {
      await this.adiar(
        id,
        janela.proximaAbertura ?? new Date(agora.getTime() + 3_600_000),
      );
      return 'fim';
    }
    const destinatario = await this.prisma.campanhaDestinatario.findFirst({
      where: { campanhaId: id, status: 'PENDENTE' },
      orderBy: { ordem: 'asc' },
      include: {
        contato: {
          select: { id: true, optOutMarketing: true, excluidoEm: true },
        },
      },
    });
    if (!destinatario) {
      return this.fechar(id);
    }
    if (
      destinatario.contato.excluidoEm ||
      destinatario.contato.optOutMarketing
    ) {
      await this.marcar(
        destinatario.id,
        'EXCLUIDO',
        destinatario.contato.excluidoEm
          ? 'O contato foi excluído antes do envio.'
          : 'O contato pediu para não receber mensagens (opt-out).',
      );
      return 'pulou';
    }
    const escolha = await this.canais.escolher(campanha, agora);
    if (escolha.tipo === 'limite') {
      await this.adiar(id, escolha.ate);
      return 'fim';
    }
    if (escolha.tipo === 'indisponivel') {
      await this.semCanal(id, escolha.motivo);
      return 'fim';
    }
    const { canal } = escolha;

    if (campanha.canal === 'WHATSAPP' && canal.whatsappNumero) {
      try {
        const verificacao = await this.gateway.verificar(
          canal.whatsappNumero.id,
          destinatario.destino,
        );
        if (!verificacao.existe) {
          await this.marcar(
            destinatario.id,
            'INVALIDO',
            'Este número não tem WhatsApp.',
          );
          return 'pulou';
        }
      } catch (erro) {
        await this.semCanal(
          id,
          `Não foi possível verificar o número (${mensagemDe(erro)}).`,
        );
        return 'fim';
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await travarChave(tx, 'disparos-campanha', id);
        const atual = await tx.campanha.findFirstOrThrow({
          where: { id, excluidoEm: null },
        });
        if (
          atual.status !== 'EM_ANDAMENTO' ||
          (atual.proximoEnvioEm &&
            atual.proximoEnvioEm.getTime() > Date.now() + MARGEM_MS)
        ) {
          return;
        }
        const reservado = await tx.campanhaDestinatario.updateMany({
          where: { id: destinatario.id, status: 'PENDENTE' },
          data: {
            status: 'ENVIANDO',
            canalId: canal.id,
            tentativas: { increment: 1 },
            motivo: null,
          },
        });
        if (reservado.count === 0) {
          return;
        }
        const arquivo = atual.arquivoId
          ? await tx.arquivo.findUnique({
              where: { id: atual.arquivoId },
              select: { id: true, mime: true, removidoEm: true },
            })
          : null;
        const entregue = await this.entrega.entregar(tx, {
          campanha: atual,
          canal,
          contatoId: destinatario.contatoId,
          semente: destinatario.id,
          destinatarioId: destinatario.id,
          arquivo: arquivo && !arquivo.removidoEm ? arquivo : null,
        });
        await tx.campanhaDestinatario.update({
          where: { id: destinatario.id },
          data: { mensagemId: entregue.mensagemId },
        });
        const espera = esperaDepoisDoEnvio(
          atual,
          atual.enviadosNoLote,
          escolha.piso,
        );
        const proximo = new Date(Date.now() + espera.esperaMs);
        await tx.campanha.update({
          where: { id },
          data: {
            ultimoCanalId: canal.id,
            enviadosNoLote: espera.enviadosNoLote,
            proximoEnvioEm: proximo,
          },
        });
        await this.agendador.agendar(id, proximo, tx);
      });
    } catch (erro) {
      // Erro ao montar esta mensagem (contato apagado no meio, modelo quebrado…):
      // falha deste destinatário, sem travar a campanha.
      this.logger.warn(
        `Campanha ${id}: envio ao destinatário ${destinatario.id} falhou: ${mensagemDe(erro)}`,
      );
      await this.marcar(
        destinatario.id,
        'FALHOU',
        `Não foi possível preparar a mensagem: ${mensagemDe(erro)}`,
      );
      await this.prisma.campanha.update({
        where: { id },
        data: { falhasSeguidas: { increment: 1 } },
      });
      return 'pulou';
    }
    return 'fim';
  }

  /** Sem pendentes: espera as confirmações do gateway ou conclui. */
  private async fechar(id: string): Promise<Resultado> {
    const emEnvio = await this.prisma.campanhaDestinatario.count({
      where: { campanhaId: id, status: 'ENVIANDO' },
    });
    if (emEnvio > 0) {
      await this.adiar(
        id,
        new Date(Date.now() + ESPERA_DE_CONFIRMACAO_SEGUNDOS * 1000),
      );
      return 'fim';
    }
    try {
      await this.ciclo.concluir(id);
    } catch (erro) {
      if (!(erro instanceof RegraVioladaException)) {
        throw erro;
      }
    }
    return 'fim';
  }

  /** Marca o destinatário (sem tocar nos demais) e atualiza o progresso. */
  private async marcar(
    destinatarioId: string,
    status: 'INVALIDO' | 'EXCLUIDO' | 'FALHOU',
    motivo: string,
  ): Promise<void> {
    const agora = new Date();
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.campanhaDestinatario.updateMany({
        where: { id: destinatarioId, status: { in: ['PENDENTE', 'ENVIANDO'] } },
        data: {
          status,
          motivo,
          ...(status === 'FALHOU' ? { falhouEm: agora } : {}),
        },
      });
      if (d.count > 0) {
        const linha = await tx.campanhaDestinatario.findUniqueOrThrow({
          where: { id: destinatarioId },
          select: { campanhaId: true },
        });
        await this.progresso.atualizar(tx, linha.campanhaId);
      }
    });
  }

  /** Próxima rodada só em `quando` (janela fechada, limite do dia, confirmações). */
  private async adiar(id: string, quando: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'disparos-campanha', id);
      const atual = await tx.campanha.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!atual || atual.status !== 'EM_ANDAMENTO') {
        return;
      }
      await tx.campanha.update({
        where: { id },
        data: { proximoEnvioEm: quando },
      });
      await this.agendador.agendar(id, quando, tx);
    });
  }

  /** Nenhum número utilizável: conta como falha seguida e, no limite, pausa. */
  private async semCanal(id: string, motivo: string): Promise<void> {
    const pausar = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'disparos-campanha', id);
      const atual = await tx.campanha.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!atual || atual.status !== 'EM_ANDAMENTO') {
        return false;
      }
      const seguidas = atual.falhasSeguidas + 1;
      if (seguidas >= atual.pausarAposFalhas) {
        await tx.campanha.update({
          where: { id },
          data: { falhasSeguidas: seguidas },
        });
        return true;
      }
      const quando = new Date(Date.now() + ESPERA_SEM_CANAL_SEGUNDOS * 1000);
      await tx.campanha.update({
        where: { id },
        data: { falhasSeguidas: seguidas, proximoEnvioEm: quando },
      });
      await this.agendador.agendar(id, quando, tx);
      return false;
    });
    if (pausar) {
      try {
        await this.ciclo.pausar(
          id,
          `Nenhum canal de envio disponível: ${motivo}`,
          true,
        );
      } catch (erro) {
        if (!(erro instanceof RegraVioladaException)) {
          throw erro;
        }
      }
    }
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
