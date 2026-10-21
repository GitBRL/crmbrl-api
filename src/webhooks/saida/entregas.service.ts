import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  NaoEncontradoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../../comum/paginacao/paginacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  type EventoPublicado,
  EventosDominioService,
} from '../../eventos/eventos-dominio.service';
import {
  EVENTOS_DE_WEBHOOK,
  ehEventoDeWebhook,
} from '../../eventos/tipos-eventos';
import { FilaService } from '../../fila/fila.service';
import type {
  Prisma,
  StatusEntrega,
  WebhookEntrega,
  WebhookSaida,
} from '../../generated/prisma/client';
import { NotificacoesService } from '../../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../../notificacoes/tipos-notificacao';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  EVENTO_DE_TESTE,
  FALHAS_PARA_DESATIVAR,
  FILA_ENTREGAR,
  PRAZO_DA_TENTATIVA_EM_ANDAMENTO_MS,
} from '../webhooks.constantes';
import {
  EntregaDetalheDto,
  EntregaDto,
  type FiltroEntregasDto,
  TentativaDeEntregaDto,
} from './dto/entrega.dto';
import {
  cabecalhosDaEntrega,
  conteudoAssinado,
  formatarAssinatura,
  montarEnvelope,
  proximaTentativaDepoisDe,
  serializarEnvelope,
  timestampDoEnvio,
} from './envelope';
import { enviarPost, type ResultadoDoEnvio } from './envio-http';
import { verificarDestino } from './protecao-ssrf';
import { WebhooksSaidaService } from './webhooks-saida.service';

/** Dados do job de uma tentativa. `agendadaPara` identifica a tentativa vigente da entrega. */
export interface TrabalhoDeEntrega {
  readonly entregaId: string;
  readonly agendadaPara: string;
}

interface OpcoesDoResultado {
  /** Não agenda nova tentativa (teste, destino desativado). */
  readonly semNovaTentativa: boolean;
  /** Conta (ou zera) as falhas seguidas do destino e avisa o Admin na falha final. */
  readonly envioReal: boolean;
}

const LINK_DO_DESTINO = (id: string) => `/integracoes?webhookSaida=${id}`;

/**
 * Entregas dos webhooks de saída (R9.2–R9.6).
 *
 * 1. Manipuladores da outbox (um por evento da R9.2, R10.1) criam, numa
 *    transação, uma entrega por destino ativo que assina o evento e o job de
 *    cada uma. É idempotente (única por destino e evento): a reentrega do
 *    evento não duplica nada.
 * 2. O job `webhooks-saida.entregar` faz uma tentativa: confere o destino de
 *    novo (SSRF, R9.1), assina `timestamp.corpo` (R9.3) e faz o `POST` com
 *    tempo limite de 10 s. 2xx é sucesso (R9.4).
 * 3. Falhou: nova tentativa em 1 min, 5 min, 30 min, 2 h, 6 h e 24 h (job
 *    novo, criado na transação do resultado); depois, a entrega fica como
 *    falha e os Admins são avisados. Com 20 falhas seguidas o destino é
 *    desativado e os Admins, notificados. Cada tentativa fica registrada (R9.5).
 *
 * O job leva o momento agendado da tentativa: um reenvio manual reagenda a
 * entrega e o job antigo, ao chegar, vê que não é mais a vez dele.
 */
@Injectable()
export class EntregasService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly eventos: EventosDominioService,
    private readonly auditoria: AuditoriaService,
    private readonly notificacoes: NotificacoesService,
    private readonly cripto: CriptografiaService,
    private readonly destinos: WebhooksSaidaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    // Um manipulador por evento assinável (R9.2): os internos (ex.:
    // `contato.reconvertido`) nem passam por aqui. O teste não vem da outbox.
    for (const tipo of EVENTOS_DE_WEBHOOK) {
      if (tipo === EVENTO_DE_TESTE) {
        continue;
      }
      this.eventos.registrarManipulador(
        tipo,
        async (evento) => {
          await this.criarEntregas(evento);
        },
        `webhooks-saida:${tipo}`,
      );
    }
    this.eventos.registrarManipulador(
      'contato.anonimizado',
      async (evento) => {
        await this.apagarDadosDoContato(evento);
      },
      'webhooks-saida:lgpd',
    );
    await this.fila.trabalhar<TrabalhoDeEntrega>(
      FILA_ENTREGAR,
      (trabalho) =>
        this.executarTentativa(
          trabalho.dados.entregaId,
          trabalho.dados.agendadaPara,
        ),
      {
        // A agenda da R9.4 é feita com jobs novos; estas retentativas só
        // cobrem falhas inesperadas (banco fora, API derrubada no meio).
        tentativas: 2,
        intervaloEntreTentativasSegundos: 180,
        prazoDeExecucaoSegundos: 60,
        concorrencia: 5,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Da outbox para as entregas
  // -------------------------------------------------------------------------

  /** Manipulador da outbox: uma entrega (e um job) por destino assinante. Devolve quantas criou. */
  async criarEntregas(evento: EventoPublicado): Promise<number> {
    if (!ehEventoDeWebhook(evento.tipo) || evento.tipo === EVENTO_DE_TESTE) {
      return 0;
    }
    return this.prisma.$transaction(async (tx) => {
      const destinos = await tx.webhookSaida.findMany({
        where: { ativo: true, excluidoEm: null, eventos: { has: evento.tipo } },
        select: { id: true },
      });
      if (destinos.length === 0) {
        return 0;
      }
      const agora = new Date();
      const payload = montarEnvelope(
        evento,
      ) as unknown as Prisma.InputJsonObject;
      const criadas = await tx.webhookEntrega.createManyAndReturn({
        data: destinos.map(({ id }) => ({
          webhookId: id,
          eventoId: evento.id,
          tipoEvento: evento.tipo,
          payload,
          status: 'PENDENTE' as const,
          proximaTentativaEm: agora,
        })),
        skipDuplicates: true,
        select: { id: true },
      });
      for (const { id } of criadas) {
        await this.agendar(tx, id, agora);
      }
      return criadas.length;
    });
  }

  // -------------------------------------------------------------------------
  // Tentativa (job)
  // -------------------------------------------------------------------------

  /**
   * Uma tentativa de entrega. Só roda se a entrega ainda estiver pendente e
   * agendada para `agendadaPara` (senão outro envio já assumiu); a marcação é
   * atômica, então dois jobs iguais não enviam duas vezes.
   */
  async executarTentativa(
    entregaId: string,
    agendadaPara: string,
  ): Promise<void> {
    const agendada = new Date(agendadaPara);
    if (Number.isNaN(agendada.getTime())) {
      return;
    }
    const agora = new Date();
    const perdidaAntesDe = new Date(
      agora.getTime() - PRAZO_DA_TENTATIVA_EM_ANDAMENTO_MS,
    );
    const marcadas = await this.prisma.$queryRaw<{ tentativas: number }[]>`
      UPDATE webhook_entregas
         SET tentativas = tentativas + 1,
             ultima_tentativa_em = ${agora}::timestamptz,
             atualizado_em = ${agora}::timestamptz
       WHERE id = ${entregaId}::uuid
         AND status = 'PENDENTE'::status_entrega
         AND proxima_tentativa_em = ${agendada}::timestamptz
         AND (ultima_tentativa_em IS NULL
              OR ultima_tentativa_em < proxima_tentativa_em
              OR ultima_tentativa_em < ${perdidaAntesDe}::timestamptz)
      RETURNING tentativas`;
    if (marcadas.length === 0) {
      return;
    }
    const tentativa = marcadas[0].tentativas;
    const entrega = await this.prisma.webhookEntrega.findUniqueOrThrow({
      where: { id: entregaId },
    });
    const destino = await this.prisma.webhookSaida.findUniqueOrThrow({
      where: { id: entrega.webhookId },
    });
    const teste = entrega.tipoEvento === EVENTO_DE_TESTE;
    const bloqueio = teste
      ? null
      : destino.excluidoEm
        ? 'Destino excluído: a entrega não foi enviada.'
        : !destino.ativo
          ? 'Destino desativado: a entrega não foi enviada.'
          : null;
    const resultado = bloqueio
      ? semEnvio(bloqueio)
      : await this.enviar(destino, entrega, agora);
    await this.registrarResultado(
      entrega,
      destino,
      tentativa,
      agendada,
      resultado,
      {
        semNovaTentativa: teste || bloqueio !== null,
        envioReal: !teste && !bloqueio,
      },
    );
  }

  /** Monta, assina e envia o envelope (R9.3), conferindo o destino antes (R9.1). */
  private async enviar(
    destino: WebhookSaida,
    entrega: WebhookEntrega,
    agora: Date,
  ): Promise<ResultadoDoEnvio> {
    const verificado = await verificarDestino(destino.url, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (!verificado.permitido) {
      return semEnvio(`Envio bloqueado: ${verificado.mensagem}`);
    }
    let segredo: string;
    let extras: Record<string, string>;
    try {
      segredo = this.cripto.decifrar(destino.segredoCifrado);
      extras = this.destinos.lerCabecalhos(destino);
    } catch {
      return semEnvio(
        'O segredo ou os cabeçalhos do destino não podem ser lidos (a CHAVE_CRIPTOGRAFIA mudou?): regenere o segredo e revise os cabeçalhos.',
      );
    }
    const corpo = serializarEnvelope(entrega.payload);
    const timestamp = timestampDoEnvio(agora);
    const assinatura = formatarAssinatura(
      this.cripto.assinarHmac(segredo, conteudoAssinado(timestamp, corpo)),
    );
    return enviarPost({
      url: destino.url,
      corpo,
      cabecalhos: cabecalhosDaEntrega({
        evento: entrega.tipoEvento,
        entregaId: entrega.id,
        timestamp,
        assinatura,
        extras,
      }),
    });
  }

  /** Grava a tentativa (R9.5) e decide o que vem depois (R9.4), numa transação. */
  private async registrarResultado(
    entrega: WebhookEntrega,
    destino: WebhookSaida,
    tentativa: number,
    agendada: Date,
    resultado: ResultadoDoEnvio,
    opcoes: OpcoesDoResultado,
  ): Promise<void> {
    const agora = new Date();
    await this.prisma.$transaction(async (tx) => {
      const [atual] = await tx.$queryRaw<
        { status: StatusEntrega; proxima_tentativa_em: Date | null }[]
      >`
        SELECT status, proxima_tentativa_em FROM webhook_entregas
         WHERE id = ${entrega.id}::uuid
           FOR UPDATE`;
      if (!atual) {
        return;
      }
      const { _max } = await tx.webhookEntregaTentativa.aggregate({
        where: { entregaId: entrega.id },
        _max: { numero: true },
      });
      await tx.webhookEntregaTentativa.create({
        data: {
          entregaId: entrega.id,
          numero: (_max.numero ?? 0) + 1,
          sucesso: resultado.sucesso,
          statusHttp: resultado.statusHttp,
          duracaoMs: resultado.duracaoMs,
          trechoResposta: resultado.trechoResposta,
          erro: resultado.erro,
          criadoEm: agora,
        },
      });
      const ultima = {
        statusHttp: resultado.statusHttp,
        duracaoMs: resultado.duracaoMs,
        trechoResposta: resultado.trechoResposta,
        erro: resultado.erro,
      };

      if (resultado.sucesso) {
        if (atual.status === 'PENDENTE') {
          await tx.webhookEntrega.update({
            where: { id: entrega.id },
            data: {
              ...ultima,
              status: 'ENTREGUE',
              entregueEm: agora,
              proximaTentativaEm: null,
            },
          });
        }
        if (opcoes.envioReal) {
          await tx.$executeRaw`
            UPDATE webhooks_saida SET falhas_consecutivas = 0
             WHERE id = ${destino.id}::uuid AND falhas_consecutivas <> 0`;
        }
        return;
      }

      if (opcoes.envioReal) {
        await this.contarFalha(tx, destino, agora);
      }
      const vigente =
        atual.status === 'PENDENTE' &&
        atual.proxima_tentativa_em?.getTime() === agendada.getTime();
      if (!vigente) {
        // Um reenvio assumiu a entrega (ou ela já terminou): fica só o registro.
        return;
      }
      const proxima = opcoes.semNovaTentativa
        ? null
        : proximaTentativaDepoisDe(tentativa, agora);
      if (proxima) {
        await tx.webhookEntrega.update({
          where: { id: entrega.id },
          data: { ...ultima, proximaTentativaEm: proxima },
        });
        await this.agendar(tx, entrega.id, proxima);
        return;
      }
      await tx.webhookEntrega.update({
        where: { id: entrega.id },
        data: { ...ultima, status: 'FALHOU', proximaTentativaEm: null },
      });
      if (opcoes.envioReal) {
        await this.notificacoes.notificarAdmins(tx, {
          tipo: TIPOS_NOTIFICACAO.WEBHOOK_SAIDA_FALHOU,
          titulo: `Webhook "${destino.nome}" não recebeu um evento`,
          texto: `A entrega de ${entrega.tipoEvento} falhou nas ${tentativa} tentativas (${resultado.erro ?? 'erro desconhecido'}). Dá para reenviar pela tela do destino.`,
          link: LINK_DO_DESTINO(destino.id),
          dados: {
            webhookSaidaId: destino.id,
            entregaId: entrega.id,
            eventoId: entrega.eventoId,
            evento: entrega.tipoEvento,
          },
        });
      }
    });
  }

  /** Soma uma falha seguida; na 20ª, desativa o destino e avisa os Admins (R9.4). */
  private async contarFalha(
    tx: Tx,
    destino: WebhookSaida,
    agora: Date,
  ): Promise<void> {
    const [linha] = await tx.$queryRaw<
      { falhas_consecutivas: number; ativo: boolean }[]
    >`
      UPDATE webhooks_saida SET falhas_consecutivas = falhas_consecutivas + 1
       WHERE id = ${destino.id}::uuid
      RETURNING falhas_consecutivas, ativo`;
    if (!linha?.ativo || linha.falhas_consecutivas < FALHAS_PARA_DESATIVAR) {
      return;
    }
    const { count } = await tx.webhookSaida.updateMany({
      where: { id: destino.id, ativo: true },
      data: { ativo: false, desativadoAutomaticamenteEm: agora },
    });
    if (count === 0) {
      return;
    }
    await this.auditoria.registrar(tx, {
      acao: 'webhook_saida.desativado_automaticamente',
      entidade: 'webhook_saida',
      entidadeId: destino.id,
      resumo: `Webhook de saída "${destino.nome}" desativado automaticamente depois de ${linha.falhas_consecutivas} falhas seguidas (R9.4)`,
      dados: { falhasConsecutivas: linha.falhas_consecutivas },
    });
    await this.notificacoes.notificarAdmins(tx, {
      tipo: TIPOS_NOTIFICACAO.WEBHOOK_SAIDA_DESATIVADO,
      titulo: `Webhook "${destino.nome}" desativado`,
      texto: `Depois de ${linha.falhas_consecutivas} falhas seguidas, o destino parou de receber eventos. Corrija o endereço e reative-o.`,
      link: LINK_DO_DESTINO(destino.id),
      dados: {
        webhookSaidaId: destino.id,
        falhasConsecutivas: linha.falhas_consecutivas,
      },
    });
  }

  private agendar(tx: Tx, entregaId: string, quando: Date): Promise<unknown> {
    const dados: TrabalhoDeEntrega = {
      entregaId,
      agendadaPara: quando.toISOString(),
    };
    return this.fila.enviar(FILA_ENTREGAR, dados, { tx, executarEm: quando });
  }

  // -------------------------------------------------------------------------
  // Admin (R9.5)
  // -------------------------------------------------------------------------

  async listar(
    webhookId: string,
    filtro: FiltroEntregasDto,
  ): Promise<Pagina<EntregaDto>> {
    await this.garantirDestino(webhookId);
    const where: Prisma.WebhookEntregaWhereInput = {
      webhookId,
      ...(filtro.status?.length ? { status: { in: filtro.status } } : {}),
      ...(filtro.evento?.length ? { tipoEvento: { in: filtro.evento } } : {}),
      ...(filtro.de || filtro.ate
        ? {
            criadoEm: {
              ...(filtro.de ? { gte: new Date(filtro.de) } : {}),
              ...(filtro.ate ? { lt: new Date(filtro.ate) } : {}),
            },
          }
        : {}),
    };
    const [entregas, total] = await Promise.all([
      this.prisma.webhookEntrega.findMany({
        where,
        omit: { payload: true },
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.webhookEntrega.count({ where }),
    ]);
    return montarPagina(
      entregas.map((entrega) => EntregaDto.de(entrega)),
      total,
      filtro,
    );
  }

  async detalhar(
    webhookId: string,
    entregaId: string,
  ): Promise<EntregaDetalheDto> {
    const entrega = await this.prisma.webhookEntrega.findFirst({
      where: { id: entregaId, webhookId, webhook: { excluidoEm: null } },
      include: { historicoTentativas: { orderBy: { numero: 'asc' } } },
    });
    if (!entrega) {
      throw new NaoEncontradoException('Entrega não encontrada.');
    }
    return Object.assign(EntregaDto.de(entrega), {
      payload: entrega.payload,
      historicoTentativas: entrega.historicoTentativas.map((tentativa) =>
        TentativaDeEntregaDto.de(tentativa),
      ),
    });
  }

  /**
   * Reenvia uma entrega (R9.5), em qualquer situação: começa um ciclo novo de
   * tentativas (R9.4) pela fila, agora. O envelope é o mesmo (mesmo `id`, R9.6).
   */
  async reenviar(
    webhookId: string,
    entregaId: string,
  ): Promise<EntregaDetalheDto> {
    await this.prisma.$transaction(async (tx) => {
      const destino = await tx.webhookSaida.findFirst({
        where: { id: webhookId, excluidoEm: null },
      });
      if (!destino) {
        throw new NaoEncontradoException('Webhook de saída não encontrado.');
      }
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM webhook_entregas
         WHERE id = ${entregaId}::uuid AND webhook_id = ${webhookId}::uuid
           FOR UPDATE`;
      if (!linha) {
        throw new NaoEncontradoException('Entrega não encontrada.');
      }
      const entrega = await tx.webhookEntrega.findUniqueOrThrow({
        where: { id: entregaId },
        omit: { payload: true },
      });
      if (!destino.ativo && entrega.tipoEvento !== EVENTO_DE_TESTE) {
        throw new RegraVioladaException(
          'R9.4',
          `O webhook "${destino.nome}" está desativado: reative-o antes de reenviar.`,
          { webhookSaidaId: destino.id },
        );
      }
      const agora = new Date();
      await tx.webhookEntrega.update({
        where: { id: entregaId },
        data: {
          status: 'PENDENTE',
          tentativas: 0,
          proximaTentativaEm: agora,
          entregueEm: null,
        },
      });
      await this.agendar(tx, entregaId, agora);
      await this.auditoria.registrar(tx, {
        acao: 'webhook_entrega.reenviada',
        entidade: 'webhook_entrega',
        entidadeId: entregaId,
        resumo: `Entrega de ${entrega.tipoEvento} para "${destino.nome}" reenviada (estava ${ROTULO_DO_STATUS[entrega.status]})`,
        dados: {
          statusAnterior: entrega.status,
          evento: entrega.tipoEvento,
          eventoId: entrega.eventoId,
        },
        relacionados: { webhook_saida: webhookId },
      });
    });
    return this.detalhar(webhookId, entregaId);
  }

  /**
   * Evento de teste (R9.5): `webhook.teste` só para este destino, numa única
   * tentativa feita agora (sem novas tentativas e sem contar falha). Vale
   * também para destino desativado, para conferir a correção antes de reativar.
   */
  async testar(
    usuario: UsuarioAutenticado,
    webhookId: string,
  ): Promise<EntregaDetalheDto> {
    const agora = new Date();
    const entregaId = await this.prisma.$transaction(async (tx) => {
      const destino = await tx.webhookSaida.findFirst({
        where: { id: webhookId, excluidoEm: null },
        select: { id: true, nome: true },
      });
      if (!destino) {
        throw new NaoEncontradoException('Webhook de saída não encontrado.');
      }
      const envelope = montarEnvelope({
        id: randomUUID(),
        tipo: EVENTO_DE_TESTE,
        ocorridoEm: agora,
        dados: {
          mensagem:
            'Evento de teste do BRL CRM: se chegou, o destino está configurado.',
          destino: { id: destino.id, nome: destino.nome },
          solicitadoPor: { id: usuario.id, nome: usuario.nome },
        },
      });
      const entrega = await tx.webhookEntrega.create({
        data: {
          webhookId: destino.id,
          eventoId: envelope.id,
          tipoEvento: EVENTO_DE_TESTE,
          payload: envelope as unknown as Prisma.InputJsonObject,
          status: 'PENDENTE',
          proximaTentativaEm: agora,
        },
        select: { id: true },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_saida.teste_enviado',
        entidade: 'webhook_saida',
        entidadeId: destino.id,
        resumo: `Evento de teste enviado ao webhook de saída "${destino.nome}"`,
        dados: { entregaId: entrega.id, eventoId: envelope.id },
      });
      return entrega.id;
    });
    await this.executarTentativa(entregaId, agora.toISOString());
    return this.detalhar(webhookId, entregaId);
  }

  // -------------------------------------------------------------------------
  // LGPD (R4.6)
  // -------------------------------------------------------------------------

  /**
   * Manipulador de `contato.anonimizado`: tira os dados pessoais dos envelopes
   * que citam o contato (o `dados` vira `{ contatoId, anonimizado: true }`).
   * As pendentes saem assim. O evento `contato.atualizado` da própria
   * anonimização já vem sem dados pessoais e fica como está. Audita quantas
   * (R3.1). Idempotente.
   */
  async apagarDadosDoContato(evento: EventoPublicado): Promise<number> {
    const contatoId = (evento.dados as { contatoId?: unknown } | null)
      ?.contatoId;
    if (typeof contatoId !== 'string' || !/^[0-9a-f-]{36}$/i.test(contatoId)) {
      return 0;
    }
    const contato = await this.prisma.contato.findUnique({
      where: { id: contatoId },
      select: { criadoEm: true },
    });
    const desde = contato?.criadoEm ?? new Date(0);
    const redigido = JSON.stringify({
      contatoId,
      anonimizado: true,
      motivo: 'Dados pessoais apagados na anonimização do contato (R4.6).',
    });
    return this.prisma.$transaction(async (tx) => {
      const redigidas = await tx.$executeRaw`
        UPDATE webhook_entregas
           SET payload = jsonb_set(payload, '{dados}', ${redigido}::jsonb),
               atualizado_em = now()
         WHERE criado_em >= ${desde}::timestamptz
           AND payload::text LIKE ${`%${contatoId}%`}
           AND NOT (COALESCE(payload->'dados', '{}'::jsonb) @> '{"anonimizado": true}'::jsonb)`;
      if (redigidas > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'webhook_entrega.dados_apagados',
          entidade: 'webhook_entrega',
          resumo: `Dados pessoais apagados de ${redigidas} entrega(s) de webhook de saída na anonimização do contato (R4.6)`,
          dados: { quantidade: redigidas },
          relacionados: { contato: contatoId },
        });
      }
      return redigidas;
    });
  }

  private async garantirDestino(id: string): Promise<void> {
    const existe = await this.prisma.webhookSaida.count({
      where: { id, excluidoEm: null },
    });
    if (existe === 0) {
      throw new NaoEncontradoException('Webhook de saída não encontrado.');
    }
  }
}

const ROTULO_DO_STATUS: Readonly<Record<StatusEntrega, string>> = {
  PENDENTE: 'pendente',
  ENTREGUE: 'entregue',
  FALHOU: 'com falha',
};

function semEnvio(erro: string): ResultadoDoEnvio {
  return {
    sucesso: false,
    statusHttp: null,
    duracaoMs: 0,
    trechoResposta: null,
    erro,
  };
}
