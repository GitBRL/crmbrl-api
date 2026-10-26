/**
 * Contrato entre a API e o gateway de WhatsApp (§2.3 do contrato da Onda A).
 * O gateway é outro processo da mesma imagem (`node dist/whatsapp/main.js`,
 * código em `src/whatsapp/**`); a API fala com ele por três caminhos:
 *
 * 1. **Comandos síncronos** (conectar, desconectar, status, verificar número):
 *    HTTP interno em `WHATSAPP_URL_INTERNA`, com o cabeçalho
 *    `X-Token-Interno: <WHATSAPP_TOKEN_INTERNO>` (`ClienteGatewayWhatsapp`).
 * 2. **Envios**: um job por mensagem na fila pg-boss do número
 *    (`filaDeEnvio(numeroId)`), consumida pelo gateway uma mensagem por vez —
 *    durável a reinícios. O id da mensagem no WhatsApp é gerado pela API
 *    (`gerarIdDeMensagemWhatsapp`) e vai no job: o Atendimento já grava o
 *    `idExterno` e os status que chegarem depois casam por ele.
 * 3. **Eventos do gateway** (mensagem recebida, status de entrega/leitura,
 *    conexão): jobs na fila `whatsapp.evento`, consumida pela API. A mídia
 *    recebida já vem salva (`ArquivosService.salvar`, contexto `MENSAGEM`).
 *
 * Os dois lados importam este arquivo: mudou aqui, mudou nos dois processos.
 */
import { randomBytes } from 'node:crypto';
import type {
  Papel,
  StatusWhatsapp,
  TipoMensagem,
} from '../../generated/prisma/client';

/** Cabeçalho do token interno entre a API e o gateway. */
export const CABECALHO_TOKEN_INTERNO = 'x-token-interno';

/**
 * Quem pediu o comando na API (`AtorDoComando` em JSON, base64url): o gateway
 * grava a auditoria (conectado, desconectado…) em nome dessa pessoa.
 */
export const CABECALHO_ATOR = 'x-ator';

/** Usuário da API que pediu um comando ao gateway. */
export interface AtorDoComando {
  id: string;
  nome: string;
  papel: Papel;
}

/** `AtorDoComando` → valor do cabeçalho `x-ator`. */
export function codificarAtor(ator: AtorDoComando): string {
  return Buffer.from(JSON.stringify(ator), 'utf8').toString('base64url');
}

/** Valor do cabeçalho `x-ator` → `AtorDoComando`, ou `null` se não vier ou não fizer sentido. */
export function decodificarAtor(valor: unknown): AtorDoComando | null {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > 2_000) {
    return null;
  }
  try {
    const dados = JSON.parse(
      Buffer.from(valor, 'base64url').toString('utf8'),
    ) as Partial<AtorDoComando>;
    return typeof dados.id === 'string' &&
      typeof dados.nome === 'string' &&
      typeof dados.papel === 'string'
      ? { id: dados.id, nome: dados.nome, papel: dados.papel }
      : null;
  } catch {
    return null;
  }
}

/** Fila dos eventos gateway → API. */
export const FILA_EVENTOS_WHATSAPP = 'whatsapp.evento';

/** Prefixo das filas de envio (uma por número). */
export const PREFIXO_FILA_DE_ENVIO = 'whatsapp.envio.';

/** Fila de envio de um número: uma mensagem por vez, na ordem. */
export function filaDeEnvio(numeroId: string): string {
  return `${PREFIXO_FILA_DE_ENVIO}${numeroId}`;
}

/**
 * Novas tentativas de cada envio (número desconectado, falha passageira), com
 * espera crescente a partir de 15 s e teto de 15 min na fila configurada pelo
 * gateway (~45 min ao todo). A API grava as tentativas e a espera em cada job:
 * a fila de um número pode ter sido criada pela API, sem a configuração do
 * gateway, e o pg-boss copia a da fila para o job no momento do envio.
 */
export const TENTATIVAS_DE_ENVIO = 8;
export const ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS = 15;
export const ESPERA_MAXIMA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS = 900;

/**
 * Id de mensagem no formato do WhatsApp Web (o mesmo do `generateMessageID` do
 * Baileys): gerado pela API antes de enfileirar, usado pelo gateway no envio.
 */
export function gerarIdDeMensagemWhatsapp(): string {
  return `3EB0${randomBytes(18).toString('hex').toUpperCase()}`;
}

/** JID de um telefone em E.164 só com dígitos (`5511999990000@s.whatsapp.net`). */
export function jidDoTelefone(telefone: string): string {
  return `${telefone.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** Telefone (só dígitos) de um JID de usuário, ou `null` para grupos, `@lid` e afins. */
export function telefoneDoJid(jid: string): string | null {
  const [usuario, servidor] = jid.split('@');
  if (servidor !== 's.whatsapp.net' || !usuario) {
    return null;
  }
  const telefone = usuario.split(':')[0];
  return /^\d{8,15}$/.test(telefone) ? telefone : null;
}

/** O JID é de um contato (`…@s.whatsapp.net` ou `…@lid`), e não de grupo, lista, status ou canal? */
export function ehJidDeContato(jid: string | null | undefined): jid is string {
  return Boolean(jid && /@(s\.whatsapp\.net|lid)$/.test(jid));
}

// ---------------------------------------------------------------------------
// Rotas do HTTP interno do gateway (todas exigem o token, menos `GET /saude`)
// ---------------------------------------------------------------------------

export const ROTAS_DO_GATEWAY = {
  /** `GET` → 200 `SaudeDoGateway` (sem token: é o healthcheck do container). */
  saude: '/saude',
  /** `POST` → 202 `EstadoDoNumero`: inicia a conexão (QR pelo evento `conexao`). */
  conectar: (numeroId: string) => `/numeros/${numeroId}/conectar`,
  /** `POST { sair?: boolean }` → 200 `EstadoDoNumero`: `sair` = logout (apaga as chaves). */
  desconectar: (numeroId: string) => `/numeros/${numeroId}/desconectar`,
  /** `GET` → 200 `EstadoDoNumero`. */
  status: (numeroId: string) => `/numeros/${numeroId}/status`,
  /** `POST { telefone }` → 200 `ResultadoDaVerificacao` (com cache). */
  verificar: (numeroId: string) => `/numeros/${numeroId}/verificar`,
  /** `POST { para, ativo }` → 204: "digitando…" do atendente para o contato (melhor esforço). */
  digitando: (numeroId: string) => `/numeros/${numeroId}/digitando`,
  /** `POST EntradaDoSimulador` → 202 `{ idExterno }`. Só com `WHATSAPP_SIMULADO=true`. */
  simuladorReceber: '/simulador/receber',
} as const;

/** Resposta de `GET /saude` do gateway. */
export interface SaudeDoGateway {
  status: 'ok' | 'degradado';
  simulado: boolean;
  /** Números com sessão aberta neste processo, por status. */
  numeros: Partial<Record<StatusWhatsapp, number>>;
  banco: 'ok' | 'erro';
  fila: 'ok' | 'erro';
}

/** Estado de um número no gateway. */
export interface EstadoDoNumero {
  numeroId: string;
  canalId: string;
  status: StatusWhatsapp;
  telefone: string | null;
  motivo: string | null;
  /** QR atual (data URL) enquanto `AGUARDANDO_QR`. */
  qr: string | null;
  qrExpiraEm: string | null;
}

export interface ResultadoDaVerificacao {
  telefone: string;
  existe: boolean;
  jid: string | null;
  /** A resposta veio do cache (`whatsapp_verificacoes`). */
  doCache: boolean;
}

/** Corpo de `POST /numeros/:id/digitando`. */
export interface PedidoDeDigitando {
  /** JID do contato (`…@s.whatsapp.net` ou `…@lid`). */
  para: string;
  ativo: boolean;
}

/** Corpo de `POST /simulador/receber` (modo simulado). */
export interface EntradaDoSimulador {
  numeroId: string;
  /** Telefone de quem "manda" (qualquer formato; vira E.164). */
  de: string;
  nome?: string;
  tipo?: TipoMensagem;
  texto?: string;
  /** Mídia em base64 (imagem, áudio, documento…), com nome e MIME. */
  midia?: { base64: string; nome: string; mime: string };
  /** Id externo da mensagem citada. */
  respondeA?: string;
}

// ---------------------------------------------------------------------------
// Envio (API → gateway, pela fila do número)
// ---------------------------------------------------------------------------

/** Job da fila `whatsapp.envio.<numeroId>`. */
export interface PedidoDeEnvio {
  /** Mensagem do Atendimento (`mensagens.id`) — para logs e para não enviar duas vezes. */
  mensagemId: string;
  conversaId: string;
  canalId: string;
  numeroId: string;
  /** Id da mensagem no WhatsApp, gerado pela API (`gerarIdDeMensagemWhatsapp`). */
  idExterno: string;
  /** Destino: JID (`…@s.whatsapp.net` ou `…@lid`). */
  para: string;
  tipo: TipoMensagem;
  texto?: string | null;
  /** Mídia já guardada (`arquivos.id`); áudio webm/opus é convertido para ogg/opus (voz). */
  arquivoId?: string | null;
  /** Áudio gravado no navegador: enviar como mensagem de voz (PTT). */
  voz?: boolean;
  /** Id externo da mensagem citada. */
  respondeAIdExterno?: string | null;
  /** Detalhes por tipo: localização `{ latitude, longitude, nome? }`, contato `{ vcard, nome? }`… */
  metadados?: Record<string, unknown> | null;
  /**
   * `true` quando é resposta numa conversa aberta pelo contato: o opt-out de
   * marketing (R4.6) não bloqueia. Mensagens ativas (`false`) respeitam o opt-out.
   */
  respostaAoContato: boolean;
  /** Contato da conversa, para conferir o opt-out. */
  contatoId: string;
  /** Mostrar "digitando…" antes de enviar (padrão: sim). */
  digitando?: boolean;
  /**
   * Preenchido pelo gateway: desde quando o envio espera o número sair da
   * pausa (ISO 8601). Passado o prazo, falha.
   */
  adiadoDesde?: string | null;
}

// ---------------------------------------------------------------------------
// Eventos (gateway → API, pela fila `whatsapp.evento`)
// ---------------------------------------------------------------------------

/** Mensagem recebida por um número. */
export interface EventoMensagemRecebida {
  tipo: 'mensagem';
  numeroId: string;
  canalId: string;
  /** Id da mensagem no WhatsApp (idempotência). */
  idExterno: string;
  /** JID do remetente (`…@s.whatsapp.net` ou `…@lid`). */
  remetenteJid: string;
  /** Telefone do remetente (E.164 só com dígitos), quando conhecido. */
  telefone: string | null;
  /** pushName do remetente. */
  nome?: string | null;
  tipoMensagem: TipoMensagem;
  texto?: string | null;
  /** Mídia já salva pelo gateway (`ArquivosService.salvar`, contexto `MENSAGEM`). */
  arquivoId?: string | null;
  respondeAIdExterno?: string | null;
  /** Localização, vcard, emoji da reação… */
  metadados?: Record<string, unknown>;
  /** Horário do WhatsApp (ISO 8601). */
  recebidaEm: string;
}

/** Status de uma mensagem enviada. */
export interface EventoStatusDeMensagem {
  tipo: 'status';
  numeroId: string;
  canalId: string;
  idExterno: string;
  status: 'ENVIADA' | 'ENTREGUE' | 'LIDA' | 'FALHOU';
  /** Motivo da falha, em português (com `FALHOU`). */
  erro?: string | null;
  /** ISO 8601. */
  em: string;
}

/** Conexão do número mudou (QR novo, conectado, caiu, banido…). */
export interface EventoConexao {
  tipo: 'conexao';
  numeroId: string;
  canalId: string;
  status: StatusWhatsapp;
  /** QR em data URL (`data:image/png;base64,…`) enquanto `AGUARDANDO_QR`. */
  qr?: string | null;
  qrExpiraEm?: string | null;
  telefone?: string | null;
  motivo?: string | null;
  /** ISO 8601. */
  em: string;
}

/** "Digitando…" do contato. */
export interface EventoDigitando {
  tipo: 'digitando';
  numeroId: string;
  canalId: string;
  remetenteJid: string;
  telefone: string | null;
  ativo: boolean;
}

export type EventoDoGateway =
  | EventoMensagemRecebida
  | EventoStatusDeMensagem
  | EventoConexao
  | EventoDigitando;
