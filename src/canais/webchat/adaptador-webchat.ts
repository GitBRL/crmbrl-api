import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import type { Canal, Conversa, Mensagem } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type ResultadoEnvio,
} from '../adaptador-canal';
import { RegistroCanais } from '../registro-canais';
import { WebchatTempoReal } from './webchat-tempo-real';
import { ATOR_DO_WEBCHAT, WebchatService } from './webchat.service';

/** Esperas para gravar o "entregue" depois que o widget confirma (o id externo é gravado logo após o envio). */
const ESPERAS_DO_ENTREGUE_MS = [500, 3_000] as const;

/**
 * Chat do site (§2.5, R14): a mensagem da equipe vai ao widget pelo Socket.IO
 * (namespace `/webchat`, sala do visitante que escreveu por último — cada
 * navegador é um visitante, e só ele vê a resposta). O envio é
 * imediato (`ENVIADA`); quando uma aba confirma o recebimento, vira
 * `ENTREGUE` — e `LIDA` se ela já mostrou na tela (painel aberto, aba
 * visível) ou quando o visitante abre a conversa depois (`lido`). Visitante fora do
 * ar recebe na próxima vez que abrir o chat (histórico).
 *
 * O id externo da saída é o próprio id da mensagem.
 */
@Injectable()
export class AdaptadorWebchat
  implements AdaptadorCanal, OnModuleInit, OnModuleDestroy
{
  readonly tipo = 'WEBCHAT' as const;
  private readonly logger = new Logger('Webchat');
  private readonly temporizadores = new Set<NodeJS.Timeout>();

  constructor(
    private readonly registro: RegistroCanais,
    private readonly prisma: PrismaService,
    private readonly webchat: WebchatService,
    private readonly tempoReal: WebchatTempoReal,
    private readonly atendimento: AtendimentoService,
  ) {}

  onModuleInit(): void {
    this.registro.registrar(this);
  }

  onModuleDestroy(): void {
    for (const temporizador of this.temporizadores) {
      clearTimeout(temporizador);
    }
    this.temporizadores.clear();
  }

  async enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    const visitante =
      (await this.webchat.visitanteAtualDaConversa(conversa.id)) ??
      // Conversa antiga: o visitante do mesmo contato no canal.
      (await this.prisma.webchatVisitante.findFirst({
        where: { canalId: canal.id, contatoId: conversa.contatoId },
        orderBy: { ultimoAcessoEm: 'desc' },
      }));
    if (!visitante) {
      throw new FalhaDefinitivaDeEnvio(
        'O visitante do chat do site não está mais ligado a esta conversa.',
        'visitante_ausente',
      );
    }
    // Só esse visitante vê a resposta (privacidade, ver `WebchatService`).
    await this.webchat.dirigirAoVisitante(mensagem, visitante.id);
    const completa = await this.webchat.carregarMensagem(mensagem.id);
    if (!completa) {
      throw new FalhaDefinitivaDeEnvio(
        'A mensagem não existe mais.',
        'mensagem_ausente',
      );
    }
    const idExterno = mensagem.idExterno ?? mensagem.id;
    const enviadaEm = new Date();
    // A mensagem já conta como enviada; o "entregue" chega com a confirmação.
    const dto = this.webchat.paraVisitante(completa, canal, visitante.id);
    void this.tempoReal
      .entregar([visitante.id], dto)
      .then(({ entregue, vista }) => {
        if (entregue) {
          this.marcarEntregue(canal.id, idExterno, vista, 0);
        }
      });
    return { idExterno, enviadaEm };
  }

  /**
   * Grava `ENTREGUE` (e `LIDA`, se o widget já mostrou na tela) assim que o id
   * externo estiver gravado — o Atendimento grava logo depois do envio, e a
   * confirmação do widget pode chegar antes disso.
   */
  private marcarEntregue(
    canalId: string,
    idExterno: string,
    vista: boolean,
    tentativa: number,
  ): void {
    const espera = ESPERAS_DO_ENTREGUE_MS[tentativa];
    if (espera === undefined) {
      return;
    }
    const temporizador = setTimeout(() => {
      this.temporizadores.delete(temporizador);
      void this.gravarEntregue(canalId, idExterno, vista, tentativa);
    }, espera);
    temporizador.unref();
    this.temporizadores.add(temporizador);
  }

  private async gravarEntregue(
    canalId: string,
    idExterno: string,
    vista: boolean,
    tentativa: number,
  ): Promise<void> {
    try {
      const existe = await this.prisma.mensagem.findUnique({
        where: { canalId_idExterno: { canalId, idExterno } },
        select: { id: true },
      });
      if (!existe) {
        this.marcarEntregue(canalId, idExterno, vista, tentativa + 1);
        return;
      }
      await executarComoAtor(ATOR_DO_WEBCHAT, async () => {
        await this.atendimento.atualizarStatus(canalId, idExterno, 'ENTREGUE');
        if (vista) {
          await this.atendimento.atualizarStatus(canalId, idExterno, 'LIDA');
        }
      });
    } catch (erro) {
      this.logger.warn(
        `Não foi possível marcar a mensagem ${idExterno} como entregue: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
  }
}
