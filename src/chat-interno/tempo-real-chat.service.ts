import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVENTOS_DO_SERVIDOR,
  type Recurso,
  salas,
} from '../tempo-real/catalogo';
import {
  type Emissao,
  TempoRealPublicador,
} from '../tempo-real/tempo-real.publicador';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  INCLUIR_NA_MENSAGEM,
  MontagemChatService,
} from './montagem-chat.service';
import {
  type DadosDoEventoDeCanal,
  type DadosDoEventoDeMensagem,
  EVENTOS_DO_CHAT,
} from './regras-chat';

/** O DTO como `Recurso` do catálogo (objeto simples com `id`). */
function comoRecurso<T extends { id: string }>(dto: T): Recurso {
  return { ...dto };
}

/**
 * Tempo real do chat interno (§2.2, R15). Traduz os eventos da outbox do chat
 * em emissões, **depois do commit**, montando os dados na hora (estado atual):
 *
 * | Evento da outbox         | Emissões                                                                 |
 * | ------------------------ | ------------------------------------------------------------------------ |
 * | `chat_mensagem.*`        | `chat.mensagem` na sala `chat:<canalId>`; para cada membro conectado, `chat.atualizado` (o canal do ponto de vista dele: prévia, não lidas) e `nao-lidas.chat` |
 * | `chat_canal.atualizado`  | `chat.atualizado` para cada membro conectado; quem saiu recebe `{ removido: true }`, a contagem nova e sai da sala `chat:<canalId>` |
 *
 * Só os membros **conectados** recebem (as emissões vão para `usuario:<id>`);
 * quem chega depois busca pela API (`GET /chat/canais`, `GET /chat/nao-lidas`).
 * Leitura e silenciamento (estados pessoais, sem transação de negócio) emitem
 * direto para a pessoa (`atualizarParaUsuario`).
 */
@Injectable()
export class TempoRealChatService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tempoReal: TempoRealService,
    private readonly publicador: TempoRealPublicador,
    private readonly montagem: MontagemChatService,
  ) {}

  onModuleInit(): void {
    for (const tipo of [
      EVENTOS_DO_CHAT.MENSAGEM_CRIADA,
      EVENTOS_DO_CHAT.MENSAGEM_EDITADA,
      EVENTOS_DO_CHAT.MENSAGEM_EXCLUIDA,
    ]) {
      this.publicador.registrarTradutor<DadosDoEventoDeMensagem>(
        tipo,
        (evento) => this.emissoesDaMensagem(evento.dados),
        `chat-interno:${tipo}`,
      );
    }
    this.publicador.registrarTradutor<DadosDoEventoDeCanal>(
      EVENTOS_DO_CHAT.CANAL_ATUALIZADO,
      (evento) => this.emissoesDoCanal(evento.dados),
      'chat-interno:canal',
    );
  }

  /** A mensagem (nova, editada ou excluída) para a sala e a lista de cada membro. */
  async emissoesDaMensagem({
    canalId,
    mensagemId,
  }: DadosDoEventoDeMensagem): Promise<Emissao[]> {
    const mensagem = await this.prisma.chatMensagem.findUnique({
      where: { id: mensagemId },
      include: INCLUIR_NA_MENSAGEM,
    });
    if (!mensagem) {
      return [];
    }
    const dto = await this.montagem.mensagem(mensagem);
    return [
      {
        salas: salas.chat(canalId),
        evento: EVENTOS_DO_SERVIDOR.CHAT_MENSAGEM,
        dados: { canalId, mensagem: comoRecurso(dto) },
      },
      ...(await this.emissoesDaLista(canalId)),
    ];
  }

  /** O canal mudou: a lista de cada membro conectado e o aviso a quem saiu. */
  async emissoesDoCanal({
    canalId,
    sairam = [],
  }: DadosDoEventoDeCanal): Promise<Emissao[]> {
    const emissoes = await this.emissoesDaLista(canalId);
    if (sairam.length === 0) {
      return emissoes;
    }
    // Reentrega da outbox: quem voltou ao canal depois não é tirado de novo.
    const aindaMembros = new Set(
      (
        await this.prisma.chatMembro.findMany({
          where: { canalId, usuarioId: { in: sairam } },
          select: { usuarioId: true },
        })
      ).map(({ usuarioId }) => usuarioId),
    );
    const foram = sairam.filter((id) => !aindaMembros.has(id));
    for (const usuarioId of foram) {
      this.tempoReal.removerDaSala(usuarioId, salas.chat(canalId));
    }
    const conectados = new Set(await this.tempoReal.usuariosConectados());
    const avisar = foram.filter((id) => conectados.has(id));
    if (avisar.length === 0) {
      return emissoes;
    }
    const totais = await this.montagem.totaisDoMenu(avisar);
    for (const usuarioId of avisar) {
      emissoes.push(
        {
          salas: salas.usuario(usuarioId),
          evento: EVENTOS_DO_SERVIDOR.CHAT_ATUALIZADO,
          dados: { canalId, removido: true },
        },
        {
          salas: salas.usuario(usuarioId),
          evento: EVENTOS_DO_SERVIDOR.NAO_LIDAS,
          dados: { chat: totais.get(usuarioId) ?? 0 },
        },
      );
    }
    return emissoes;
  }

  /**
   * Para uma pessoa só (todas as abas dela), agora: o canal do ponto de vista
   * dela e a contagem do menu. Usado depois de marcar como lido e de silenciar.
   */
  async atualizarParaUsuario(
    usuarioId: string,
    canalId: string,
  ): Promise<void> {
    if (!(await this.tempoReal.estaConectado(usuarioId))) {
      return;
    }
    for (const emissao of await this.emissoesParaMembros(canalId, [
      usuarioId,
    ])) {
      this.tempoReal.emitir(emissao.salas, emissao.evento, emissao.dados);
    }
  }

  /** `chat.atualizado` + `nao-lidas` para cada membro conectado do canal. */
  private async emissoesDaLista(canalId: string): Promise<Emissao[]> {
    const conectados = await this.tempoReal.usuariosConectados();
    if (conectados.length === 0) {
      return [];
    }
    const membros = await this.prisma.chatMembro.findMany({
      where: { canalId, usuarioId: { in: conectados } },
      select: { usuarioId: true },
    });
    return this.emissoesParaMembros(
      canalId,
      membros.map(({ usuarioId }) => usuarioId),
    );
  }

  private async emissoesParaMembros(
    canalId: string,
    usuarioIds: readonly string[],
  ): Promise<Emissao[]> {
    if (usuarioIds.length === 0) {
      return [];
    }
    const [visoes, totais] = await Promise.all([
      this.montagem.canalParaMembros(canalId, usuarioIds),
      this.montagem.totaisDoMenu(usuarioIds),
    ]);
    const emissoes: Emissao[] = [];
    for (const usuarioId of usuarioIds) {
      const canal = visoes.get(usuarioId);
      if (!canal) {
        continue;
      }
      emissoes.push(
        {
          salas: salas.usuario(usuarioId),
          evento: EVENTOS_DO_SERVIDOR.CHAT_ATUALIZADO,
          dados: { canalId, canal: comoRecurso(canal) },
        },
        {
          salas: salas.usuario(usuarioId),
          evento: EVENTOS_DO_SERVIDOR.NAO_LIDAS,
          dados: { chat: totais.get(usuarioId) ?? 0 },
        },
      );
    }
    return emissoes;
  }
}
