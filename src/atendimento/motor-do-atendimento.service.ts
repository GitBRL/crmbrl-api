import { Injectable } from '@nestjs/common';
import { registrarPrimeiraInteracao } from '../funis/primeira-interacao';
import { gerarIdDeMensagemWhatsapp } from '../canais/whatsapp/contrato-gateway';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { FilaService } from '../fila/fila.service';
import type {
  Canal,
  Conversa,
  MotivoAtribuicao,
  Prisma,
  TipoMensagem,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { NoBancoComoSistema } from '../prisma/no-banco-como-sistema';
import type { Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR } from '../tempo-real/catalogo';
import { TempoRealPublicador } from '../tempo-real/tempo-real.publicador';
import {
  ESPERA_ENTRE_ENVIOS_SEGUNDOS,
  EVENTO_CONTAGENS_ATENDIMENTO,
  EVENTOS_DO_ATENDIMENTO,
  FILA_ENVIO_ATENDIMENTO,
  linkDaConversa,
  RETENTATIVAS_DE_ENVIO,
  resumir,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';
import { salasDaConversa } from './cargas';
import { DistribuicaoDaFila } from './distribuicao-fila.service';
import {
  type ConversaCompleta,
  ConversaResumoDto,
  INCLUIR_CONVERSA,
} from './dto/conversa.dto';
import {
  INCLUIR_MENSAGEM,
  type MensagemCompleta,
  MensagemDaConversaDto,
} from './dto/mensagem.dto';
import type { Area } from '../comum/dominio/setores';

/** Pedido de envio de uma mensagem de saída (job da fila `atendimento.enviar`). */
export interface PedidoDeEnvioDoAtendimento {
  mensagemId: string;
}

/** Quem teve a contagem do menu mudada (evento `atendimento.contagens`). */
export interface ContagensAfetadas {
  usuarios: string[];
  areas: Area[];
}

export interface NovaSaida {
  tipo?: TipoMensagem;
  texto?: string | null;
  arquivoId?: string | null;
  respostaAId?: string | null;
  /** Quem escreve; nulo = resposta automática (fora do horário, pesquisa…). */
  autorId: string | null;
  metadados?: Prisma.InputJsonObject;
}

export interface NovaAtribuicao {
  /** Novo responsável (`null` = sem responsável). */
  usuarioId: string | null;
  /** Nova fila (ausente = a mesma). */
  filaId?: string | null;
  motivo: MotivoAtribuicao;
  nota?: string | null;
  /** Notifica o novo responsável (se não foi ele mesmo que fez). Padrão: sim. */
  notificar?: boolean;
  /** Título da notificação (padrão: "Conversa para você"). */
  tituloDaNotificacao?: string;
}

/**
 * Peças comuns das operações do Atendimento, sempre **dentro da transação**
 * de quem chama: atribuir (com o histórico e a notificação), distribuir pela
 * fila, mensagens de saída e de sistema (com o job de envio) e as emissões de
 * tempo real depois do commit (R10.1).
 */
@Injectable()
export class MotorDoAtendimento {
  constructor(
    private readonly eventos: EventosDominioService,
    private readonly publicador: TempoRealPublicador,
    private readonly notificacoes: NotificacoesService,
    private readonly fila: FilaService,
    private readonly distribuicao: DistribuicaoDaFila,
  ) {}

  carregar(tx: Tx, conversaId: string): Promise<ConversaCompleta> {
    return tx.conversa.findUniqueOrThrow({
      where: { id: conversaId },
      include: INCLUIR_CONVERSA,
    });
  }

  /** Salas que acompanham a conversa (R12). */
  salas(conversa: {
    id: string;
    responsavelId: string | null;
    fila: { area: Area } | null;
  }): string[] {
    return salasDaConversa({
      id: conversa.id,
      responsavelId: conversa.responsavelId,
      area: conversa.fila?.area ?? null,
    });
  }

  /**
   * `conversa.nova` / `conversa.atualizada` depois do commit, com o resumo
   * atual. `salasAntes` (quem acompanhava antes de mudar de mãos) também
   * recebe, para tirar a conversa da lista se não a vê mais.
   */
  @NoBancoComoSistema()
  async emitirConversa(
    tx: Tx,
    conversaId: string,
    opcoes: { nova?: boolean; salasAntes?: readonly string[] } = {},
  ): Promise<ConversaCompleta> {
    const conversa = await this.carregar(tx, conversaId);
    const salas = new Set([
      ...this.salas(conversa),
      ...(opcoes.salasAntes ?? []),
    ]);
    await this.publicador.emitirAposCommit(tx, {
      salas: [...salas],
      evento: opcoes.nova
        ? EVENTOS_DO_SERVIDOR.CONVERSA_NOVA
        : EVENTOS_DO_SERVIDOR.CONVERSA_ATUALIZADA,
      dados: { conversa: { ...ConversaResumoDto.de(conversa) } },
    });
    return conversa;
  }

  /** `mensagem.nova` depois do commit, para quem acompanha a conversa. */
  @NoBancoComoSistema()
  async emitirMensagem(
    tx: Tx,
    conversa: {
      id: string;
      responsavelId: string | null;
      fila: { area: Area } | null;
    },
    mensagemId: string,
  ): Promise<MensagemCompleta> {
    const mensagem = await tx.mensagem.findUniqueOrThrow({
      where: { id: mensagemId },
      include: INCLUIR_MENSAGEM,
    });
    await this.publicador.emitirAposCommit(tx, {
      salas: this.salas(conversa),
      evento: EVENTOS_DO_SERVIDOR.MENSAGEM_NOVA,
      dados: {
        conversaId: conversa.id,
        mensagem: { ...MensagemDaConversaDto.de(mensagem) },
      },
    });
    return mensagem;
  }

  /** `mensagem.status` depois do commit (envio, falha, nova tentativa). */
  @NoBancoComoSistema()
  async emitirStatus(
    tx: Tx,
    mensagem: {
      id: string;
      conversaId: string;
      status: MensagemCompleta['status'];
      erro: string | null;
    },
    em: Date = new Date(),
  ): Promise<void> {
    if (!mensagem.status) {
      return;
    }
    const conversa = await tx.conversa.findUniqueOrThrow({
      where: { id: mensagem.conversaId },
      select: {
        id: true,
        responsavelId: true,
        fila: { select: { area: true } },
      },
    });
    await this.publicador.emitirAposCommit(tx, {
      salas: this.salas(conversa),
      evento: EVENTOS_DO_SERVIDOR.MENSAGEM_STATUS,
      dados: {
        conversaId: mensagem.conversaId,
        mensagemId: mensagem.id,
        status: mensagem.status,
        erro: mensagem.erro,
        em: em.toISOString(),
      },
    });
  }

  /**
   * Aviso do sistema na conversa ("Ana transferiu para Bruno", "Conversa
   * resolvida"): só a equipe vê; não mexe na prévia da lista.
   */
  @NoBancoComoSistema()
  async avisoDeSistema(
    tx: Tx,
    conversa: {
      id: string;
      canalId: string;
      responsavelId: string | null;
      fila: { area: Area } | null;
    },
    texto: string,
    metadados?: Prisma.InputJsonObject,
  ): Promise<MensagemCompleta> {
    const contexto = contextoAtual();
    const mensagem = await tx.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: conversa.canalId,
        direcao: 'SISTEMA',
        tipo: 'TEXTO',
        texto,
        autorId: contexto.usuario?.id ?? null,
        autorTipo: contexto.tipoAtor,
        metadados,
      },
    });
    return this.emitirMensagem(tx, conversa, mensagem.id);
  }

  /**
   * Mensagem de saída `PENDENTE` + o job de envio (que só existe se a
   * transação confirmar). Do atendente: vira a última mensagem da conversa,
   * marca a primeira resposta (se o contato já tinha escrito), zera as não
   * lidas e o "aguardando". Automática (`autorId` nulo): só vai ao contato.
   */
  @NoBancoComoSistema()
  async criarSaida(
    tx: Tx,
    conversa: Conversa,
    canal: Pick<Canal, 'id' | 'tipo'>,
    dados: NovaSaida,
  ): Promise<MensagemCompleta> {
    const agora = new Date();
    const contexto = contextoAtual();
    const mensagem = await tx.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: canal.id,
        direcao: 'SAIDA',
        tipo: dados.tipo ?? 'TEXTO',
        texto: dados.texto ?? null,
        arquivoId: dados.arquivoId ?? null,
        respostaAId: dados.respostaAId ?? null,
        autorId: dados.autorId,
        autorTipo: dados.autorId ? 'USUARIO' : contexto.tipoAtor,
        status: 'PENDENTE',
        // O WhatsApp aceita o id escolhido por quem envia: gravá-lo antes evita
        // que o "enviada" do gateway chegue antes de a API conhecer o id.
        idExterno:
          canal.tipo === 'WHATSAPP' ? gerarIdDeMensagemWhatsapp() : null,
        metadados: dados.metadados,
        ocorridaEm: agora,
      },
    });
    if (dados.autorId) {
      await tx.conversa.update({
        where: { id: conversa.id },
        data: {
          ultimaMensagemId: mensagem.id,
          ultimaMensagemEm: agora,
          naoLidas: 0,
          aguardandoDesde: null,
          ...(conversa.primeiraRespostaEm === null &&
          conversa.ultimaEntradaEm !== null
            ? { primeiraRespostaEm: agora }
            : {}),
        },
      });
      if (conversa.naoLidas > 0) {
        await tx.mensagem.updateMany({
          where: { conversaId: conversa.id, direcao: 'ENTRADA', lidaEm: null },
          data: { lidaEm: agora },
        });
      }
    }
    await this.enfileirarEnvio(tx, mensagem.id);
    if (dados.autorId) {
      // R6.7 — mensagem ou e-mail de uma pessoa: primeira interação dos negócios abertos do contato.
      await registrarPrimeiraInteracao(tx, {
        contatoId: conversa.contatoId,
        tipo: canal.tipo === 'EMAIL' ? 'EMAIL' : 'MENSAGEM',
        usuarioId: dados.autorId,
        quando: agora,
      });
      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.MENSAGEM_DA_EQUIPE,
        {
          conversaId: conversa.id,
          mensagemId: mensagem.id,
          usuarioId: dados.autorId,
        },
      );
    }
    const atual = await tx.conversa.findUniqueOrThrow({
      where: { id: conversa.id },
      select: {
        id: true,
        responsavelId: true,
        fila: { select: { area: true } },
      },
    });
    return this.emitirMensagem(tx, atual, mensagem.id);
  }

  /** Job de envio da mensagem (na transação de quem chama). */
  @NoBancoComoSistema()
  async enfileirarEnvio(tx: Tx, mensagemId: string): Promise<void> {
    await this.fila.enviar<PedidoDeEnvioDoAtendimento>(
      FILA_ENVIO_ATENDIMENTO,
      { mensagemId },
      {
        tx,
        tentativas: RETENTATIVAS_DE_ENVIO,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_ENVIOS_SEGUNDOS,
        esperaExponencial: true,
      },
    );
  }

  /**
   * Muda o responsável (e/ou a fila) e grava o histórico. Notifica o novo
   * responsável quando não foi ele mesmo que fez. Devolve a conversa atualizada.
   */
  @NoBancoComoSistema()
  async atribuir(
    tx: Tx,
    conversa: Conversa,
    nova: NovaAtribuicao,
  ): Promise<Conversa> {
    const contexto = contextoAtual();
    const filaId = nova.filaId === undefined ? conversa.filaId : nova.filaId;
    const mudouResponsavel = nova.usuarioId !== conversa.responsavelId;
    const atualizada = await tx.conversa.update({
      where: { id: conversa.id },
      data: {
        responsavelId: nova.usuarioId,
        ...(mudouResponsavel
          ? { atribuidaEm: nova.usuarioId ? new Date() : null }
          : {}),
        filaId,
      },
    });
    await tx.conversaAtribuicao.create({
      data: {
        conversaId: conversa.id,
        motivo: nova.motivo,
        deUsuarioId: conversa.responsavelId,
        paraUsuarioId: nova.usuarioId,
        deFilaId: conversa.filaId,
        paraFilaId: filaId,
        nota: nova.nota ?? null,
        porUsuarioId: contexto.usuario?.id ?? null,
        tipoAtor: contexto.tipoAtor,
      },
    });
    if (
      nova.usuarioId &&
      mudouResponsavel &&
      nova.notificar !== false &&
      nova.usuarioId !== contexto.usuario?.id
    ) {
      const contato = await tx.contato.findUnique({
        where: { id: conversa.contatoId },
        select: { nome: true },
      });
      const canal = await tx.canal.findUnique({
        where: { id: conversa.canalId },
        select: { nome: true },
      });
      const transferencia = nova.motivo === 'TRANSFERENCIA';
      await this.notificacoes.notificar(tx, nova.usuarioId, {
        tipo: transferencia
          ? TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSA_TRANSFERIDA
          : TIPOS_NOTIFICACAO_ATENDIMENTO.CONVERSA_ATRIBUIDA,
        titulo:
          nova.tituloDaNotificacao ??
          (transferencia
            ? `${contexto.usuario?.nome ?? 'Alguém'} transferiu uma conversa para você`
            : 'Nova conversa para você'),
        texto: [
          `${contato?.nome ?? 'Contato'} (${canal?.nome ?? 'canal'})`,
          nova.nota ? `Nota: ${resumir(nova.nota)}` : null,
        ]
          .filter(Boolean)
          .join(' — '),
        link: linkDaConversa(conversa.id),
        dados: { conversaId: conversa.id, motivo: nova.motivo },
      });
    }
    return atualizada;
  }

  /**
   * Distribui a conversa pela estratégia da fila (R12). Sem ninguém
   * disponível (ou fila manual), ela fica na fila sem responsável. Devolve a
   * conversa (atualizada ou como estava).
   */
  @NoBancoComoSistema()
  async distribuir(
    tx: Tx,
    conversa: Conversa,
    motivo: MotivoAtribuicao = 'DISTRIBUICAO',
  ): Promise<Conversa> {
    if (!conversa.filaId) {
      return conversa;
    }
    const escolhido = await this.distribuicao.escolher(tx, conversa.filaId);
    if (!escolhido || escolhido.id === conversa.responsavelId) {
      return conversa;
    }
    return this.atribuir(tx, conversa, {
      usuarioId: escolhido.id,
      motivo,
    });
  }

  /**
   * Grava o pedido de recontagem do menu (`nao-lidas.atendimento`) de quem foi
   * afetado: as pessoas e, para conversas sem responsável, as áreas das filas.
   */
  @NoBancoComoSistema()
  async publicarContagens(
    tx: Tx,
    afetados: {
      usuarios?: ReadonlyArray<string | null | undefined>;
      areas?: ReadonlyArray<Area | null | undefined>;
    },
  ): Promise<void> {
    const usuarios = [
      ...new Set((afetados.usuarios ?? []).filter((id): id is string => !!id)),
    ];
    const areas = [
      ...new Set((afetados.areas ?? []).filter((area): area is Area => !!area)),
    ];
    if (usuarios.length === 0 && areas.length === 0) {
      return;
    }
    await this.eventos.publicar<ContagensAfetadas>(
      tx,
      EVENTO_CONTAGENS_ATENDIMENTO,
      { usuarios, areas },
    );
  }

  /** Quem é afetado nas contagens por uma conversa (responsável ou área da fila). */
  afetadosPor(conversa: {
    responsavelId: string | null;
    fila: { area: Area } | null;
  }): { usuarios: string[]; areas: Area[] } {
    return conversa.responsavelId
      ? { usuarios: [conversa.responsavelId], areas: [] }
      : { usuarios: [], areas: conversa.fila ? [conversa.fila.area] : [] };
  }
}
