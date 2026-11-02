/**
 * Transporte do gateway de WhatsApp: a conexão de UM número com o WhatsApp.
 * Duas implementações com a mesma interface:
 *
 * - `TransporteBaileys` (`WHATSAPP_SIMULADO=false`): Baileys, WebSocket direto,
 *   com o estado de autenticação cifrado no Postgres (`whatsapp_chaves`);
 * - `TransporteSimulado` (`WHATSAPP_SIMULADO=true`): QR de mentira, conecta em
 *   segundos, envios com status progressivo e entrada pelo simulador.
 *
 * O `GerenciadorDeNumeros` cria uma sessão por número e reage aos avisos do
 * `OuvinteDaSessao` (grava o status, publica os eventos para a API).
 */
import type { Readable } from 'node:stream';
import type { TipoMensagem } from '../../generated/prisma/client';

/** Token de injeção da fábrica de transporte em uso. */
export const FABRICA_DE_TRANSPORTE = Symbol('FABRICA_DE_TRANSPORTE');

/** O número, como a sessão o recebe ao ser criada. */
export interface NumeroDaSessao {
  readonly numeroId: string;
  readonly canalId: string;
  /** Telefone já conectado antes (reconexão), se houver. */
  readonly telefone: string | null;
  /** Já tinha conectado antes (há credenciais guardadas): reconecta sem QR. */
  readonly jaConectado: boolean;
}

/**
 * Mídia de uma mensagem recebida. O transporte simulado já entrega o
 * `conteudo`; o Baileys entrega `baixar`, chamado só se o tipo e o tamanho
 * cabem na política de arquivos (R11) — mídia recusada nem é baixada.
 */
export interface MidiaRecebida {
  nome: string;
  mime: string;
  /** Tamanho anunciado pelo WhatsApp, em bytes (quando conhecido). */
  tamanho?: number | null;
  conteudo?: Buffer;
  baixar?: () => Promise<Readable | Buffer>;
  /** Duração do áudio/vídeo, em segundos. */
  duracaoSegundos?: number | null;
  largura?: number | null;
  altura?: number | null;
}

/** Mensagem recebida, como o transporte a entrega. */
export interface MensagemDoTransporte {
  idExterno: string;
  remetenteJid: string;
  telefone: string | null;
  nome?: string | null;
  tipo: TipoMensagem;
  texto?: string | null;
  midia?: MidiaRecebida | null;
  respondeAIdExterno?: string | null;
  metadados?: Record<string, unknown>;
  recebidaEm: Date;
}

/** Envio pronto para o transporte (mídia já lida do armazenamento e, no áudio, convertida). */
export interface EnvioDoTransporte {
  idExterno: string;
  para: string;
  tipo: TipoMensagem;
  texto?: string | null;
  midia?: {
    conteudo: Buffer;
    nome: string;
    mime: string;
    /** Miniatura JPEG em base64 (imagem e vídeo), quando deu para gerar. */
    miniatura?: string | null;
  } | null;
  /** Áudio como mensagem de voz (PTT). */
  voz?: boolean;
  respondeAIdExterno?: string | null;
  /** A mensagem citada, para montar a citação quando o transporte não a tem na memória. */
  citada?: { texto: string | null; deMim: boolean } | null;
  /** Localização `{ latitude, longitude, nome?, endereco? }`, contato `{ vcard, nome? }`… */
  metadados?: Record<string, unknown> | null;
}

/** Por que a conexão caiu. */
export interface MotivoDaQueda {
  /** Em português, para a tela. */
  motivo: string;
  /** Logout pelo celular (ou pedido): as chaves são apagadas, precisa de QR novo. */
  logout?: boolean;
  /** O WhatsApp baniu o número. */
  banido?: boolean;
  /** Erro grave que não se resolve reconectando (fica em `ERRO`). */
  erroGrave?: boolean;
  /**
   * A conexão nova terminou sem a leitura do QR (os QRs acabaram ou a rede
   * caiu antes): volta a `DESCONECTADO`, sem reconectar sozinho.
   */
  semLeituraDoQr?: boolean;
}

/** Avisos da sessão para o gerenciador. Os métodos não lançam. */
export interface OuvinteDaSessao {
  aoQr(qr: string): void;
  aoConectar(conta: {
    telefone: string;
    jid: string;
    lid?: string | null;
  }): void;
  aoCair(queda: MotivoDaQueda): void;
  aoReceber(mensagem: MensagemDoTransporte): void;
  aoStatus(
    idExterno: string,
    status: 'ENTREGUE' | 'LIDA' | 'FALHOU',
    em: Date,
    erro?: string,
  ): void;
  aoDigitando(
    remetenteJid: string,
    telefone: string | null,
    ativo: boolean,
  ): void;
}

/** A conexão de um número. */
export interface SessaoWhatsapp {
  /** Abre a conexão (QR pelo `aoQr`, ou direto `aoConectar` com credenciais). */
  iniciar(): Promise<void>;
  /** Fecha. Com `sair`, faz logout no WhatsApp (o celular desvincula o aparelho). */
  encerrar(opcoes?: { sair?: boolean }): Promise<void>;
  /**
   * Envia; devolve quando o WhatsApp aceitou. Lança `FalhaDefinitivaDeEnvio` se
   * não adianta tentar de novo e `LimiteDoWhatsapp` se o WhatsApp mandou parar.
   */
  enviar(envio: EnvioDoTransporte): Promise<{ enviadaEm: Date }>;
  /** O telefone tem WhatsApp? `jid` é o endereço que o WhatsApp devolveu (pode diferir do telefone, como no nono dígito). */
  verificar(telefone: string): Promise<{ existe: boolean; jid: string | null }>;
  /** "Digitando…" (ou "gravando…") para o contato. */
  digitando(para: string, ativo: boolean, gravando?: boolean): Promise<void>;
}

/** Cria as sessões dos números. */
export interface FabricaDeTransporte {
  readonly nome: 'baileys' | 'simulado';
  criar(numero: NumeroDaSessao, ouvinte: OuvinteDaSessao): SessaoWhatsapp;
}

/**
 * O WhatsApp limitou os envios do número (`rate-overlimit` e afins): o
 * gerenciador pausa o número sozinho e o envio volta para a fila.
 */
export class LimiteDoWhatsapp extends Error {
  constructor(mensagem = 'O WhatsApp limitou os envios deste número.') {
    super(mensagem);
    this.name = 'LimiteDoWhatsapp';
  }
}
