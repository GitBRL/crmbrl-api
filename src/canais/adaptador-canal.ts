/**
 * Interface entre o Atendimento e cada canal (§2.4 e §4 do contrato da Onda A).
 *
 * Cada módulo de canal (WhatsApp, chat do site, e-mail, Instagram, Messenger)
 * implementa um `AdaptadorCanal` e o registra no `RegistroCanais` no
 * `onModuleInit`. Na **saída**, o Atendimento grava a mensagem `PENDENTE`, põe
 * na fila de envio e o trabalhador chama `adaptador.enviar(...)`; o status muda
 * depois pelos eventos do canal (`AtendimentoService.atualizarStatus`). Na
 * **entrada**, o canal normaliza o que chegou e chama
 * `AtendimentoService.receber(...)`.
 *
 * ```ts
 * @Injectable()
 * export class AdaptadorEmail implements AdaptadorCanal, OnModuleInit {
 *   readonly tipo = 'EMAIL' as const;
 *   constructor(private readonly registro: RegistroCanais) {}
 *   onModuleInit() { this.registro.registrar(this); }
 *   async enviar(mensagem, conversa, canal) {
 *     const { messageId } = await this.smtp.enviar(...);
 *     return { idExterno: messageId };
 *   }
 * }
 * ```
 */
import type {
  Canal,
  Conversa,
  Mensagem,
  TipoCanal,
} from '../generated/prisma/client';

/**
 * O que o envio devolve. Grave o `idExterno` na mensagem (é por ele que os
 * status chegam em `AtendimentoService.atualizarStatus`).
 *
 * - Envio síncrono (e-mail, Meta): `{ idExterno, enviadaEm? }` → `ENVIADA`.
 * - Envio enfileirado (WhatsApp): `{ idExterno, enfileirado: true }` — o id já
 *   é o definitivo (gerado antes de enfileirar), mas a mensagem fica `PENDENTE`
 *   até o gateway informar `ENVIADA` ou `FALHOU`.
 */
export interface ResultadoEnvio {
  /** Id da mensagem no provedor (Message-ID do e-mail, mid da Meta, id do WhatsApp…). */
  idExterno?: string;
  /** Quando o provedor aceitou (padrão: agora). */
  enviadaEm?: Date;
  /**
   * O canal só pôs o envio numa fila própria (ex.: a fila do número no gateway
   * de WhatsApp): a mensagem fica `PENDENTE` até o evento do canal.
   */
  enfileirado?: boolean;
}

/** Se dá para responder agora (ex.: janela de 24 h da Meta, R14). */
export interface PermissaoDeResposta {
  pode: boolean;
  /** Em português, para a tela: por que não dá. */
  motivo?: string;
}

/** Um canal de atendimento. */
export interface AdaptadorCanal {
  readonly tipo: TipoCanal;
  /**
   * Envia uma mensagem de saída. Lança `FalhaDefinitivaDeEnvio` quando tentar de
   * novo não adianta (número sem WhatsApp, janela fechada, destinatário
   * inválido); qualquer outro erro é passageiro e o Atendimento tenta de novo.
   */
  enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio>;
  /** Se a conversa aceita resposta comum agora (padrão: sim). */
  podeResponder?(conversa: Conversa, canal: Canal): PermissaoDeResposta;
}

/**
 * Falha de envio que não se resolve tentando de novo. O Atendimento marca a
 * mensagem como `FALHOU` com `mensagem` (em português) como motivo.
 */
export class FalhaDefinitivaDeEnvio extends Error {
  constructor(
    mensagem: string,
    /** Código técnico opcional (ex.: `numero_sem_whatsapp`, `janela_fechada`). */
    readonly codigo?: string,
  ) {
    super(mensagem);
    this.name = 'FalhaDefinitivaDeEnvio';
  }
}
