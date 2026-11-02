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
  TipoMensagem,
} from '../generated/prisma/client';
import type { TemplateDoCanalDto } from './templates-canal.dto';

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
  /**
   * Não dá para mensagem livre, mas dá para enviar um template aprovado (WhatsApp
   * oficial fora da janela de 24 h, R28): a tela troca o compositor pela lista de templates.
   */
  apenasTemplate?: boolean;
}

/** Valores das variáveis de um template, por componente (na ordem em que aparecem). */
export interface VariaveisDoTemplate {
  cabecalho?: string[];
  corpo?: string[];
  /** Um valor por botão (`null` nos que não têm variável). */
  botoes?: Array<string | null>;
}

/** O template que o Atendimento pede para enviar (canais que aceitam templates). */
export interface PedidoDeTemplate {
  templateId: string;
  variaveis?: VariaveisDoTemplate;
}

/** O template validado e preenchido: o que o Atendimento grava na mensagem. */
export interface TemplatePreparado {
  /** `TEXTO`, ou o tipo da mídia do cabeçalho (o arquivo vai em `arquivoId`). */
  tipo: TipoMensagem;
  /** Texto como o contato o vê (cabeçalho, corpo e rodapé preenchidos). */
  texto: string;
  /** Vai em `mensagens.metadados` (`{ template: { id, nome, idioma, categoria, variaveis } }`). */
  metadados: Record<string, unknown>;
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
  /**
   * Só nos canais com templates (WhatsApp oficial): os templates do canal, para o
   * compositor (com as variáveis); `somenteUsaveis` deixa só os aprovados.
   */
  listarTemplates?(
    canal: Canal,
    opcoes?: { somenteUsaveis?: boolean },
  ): Promise<TemplateDoCanalDto[]>;
  /**
   * Só nos canais com templates (WhatsApp oficial): confere o template (existe,
   * aprovado, variáveis completas, arquivo do cabeçalho quando ele pede mídia) e
   * devolve o texto preenchido. Lança `DadosInvalidosException` (400) se não serve.
   */
  prepararTemplate?(
    canal: Canal,
    pedido: PedidoDeTemplate,
    opcoes: { arquivoMime?: string | null },
  ): Promise<TemplatePreparado>;
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
