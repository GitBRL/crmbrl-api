/**
 * Catálogo do tempo real (§2.2 do contrato da Onda A): caminho, namespace,
 * salas e eventos — com o formato dos dados de cada um. É o contrato com o
 * front (`TempoRealService` do crmbrl): mudou aqui, mudou lá.
 *
 * Conexão: `io('/tempo-real', { path: '/api/socket.io', withCredentials: true })`
 * na mesma origem do front (o Caddy e o `ng serve` encaminham `/api/*`, com
 * websocket). A sessão vem do cookie `crmbrl_sessao`; a origem precisa estar em
 * `ORIGENS_PERMITIDAS`.
 */
import type {
  Area,
  Papel,
  StatusMensagem,
  StatusWhatsapp,
} from '../generated/prisma/client';
import type { NotificacaoDto } from '../notificacoes/notificacoes.dto';

/** Caminho do Socket.IO (dentro de `/api`, que o proxy do front já encaminha). */
export const CAMINHO_SOCKET_IO = '/api/socket.io';

/** Namespace dos usuários logados. (O chat do site usa `/webchat`, no mesmo caminho.) */
export const NAMESPACE_TEMPO_REAL = '/tempo-real';

/** Opções do servidor Socket.IO, iguais em todos os gateways do caminho. */
export const OPCOES_DO_SOCKET_IO = {
  path: CAMINHO_SOCKET_IO,
  serveClient: false,
  /** Mensagens do cliente são pequenas (entrar em sala, "digitando"). */
  maxHttpBufferSize: 1_000_000,
  pingInterval: 25_000,
  pingTimeout: 20_000,
} as const;

/**
 * Salas. Ao conectar, o socket entra sozinho em `usuario:<id>`, `papel:<papel>`
 * e, se tiver área, `area:<area>`. Em `conversa:<id>` e `chat:<canalId>` ele
 * entra pedindo (`conversa.entrar`, `chat.entrar`), com verificação de
 * permissão. `sessao:<id>` é interna (para derrubar os sockets de uma sessão).
 */
export const salas = {
  usuario: (usuarioId: string) => `usuario:${usuarioId}`,
  papel: (papel: Papel) => `papel:${papel}`,
  area: (area: Area) => `area:${area}`,
  conversa: (conversaId: string) => `conversa:${conversaId}`,
  chat: (canalId: string) => `chat:${canalId}`,
  sessao: (sessaoId: string) => `sessao:${sessaoId}`,
} as const;

/** Salas em que o cliente entra pedindo, com o autorizador registrado pelo módulo dono. */
export type TipoDeSalaPedida = 'conversa' | 'chat';

// ---------------------------------------------------------------------------
// Servidor → cliente
// ---------------------------------------------------------------------------

/** Eventos que a API emite. */
export const EVENTOS_DO_SERVIDOR = {
  /** Notificação nova do usuário (sala `usuario:<id>`), logo depois de gravada. */
  NOTIFICACAO_NOVA: 'notificacao.nova',
  /** Conversa nova visível para quem está na sala (área da fila, responsável, Admin…). */
  CONVERSA_NOVA: 'conversa.nova',
  /** Conversa mudou (responsável, status, fila, etiquetas, não lidas, última mensagem…). */
  CONVERSA_ATUALIZADA: 'conversa.atualizada',
  /** Mensagem nova numa conversa (sala `conversa:<id>`, e a lista de quem vê a conversa). */
  MENSAGEM_NOVA: 'mensagem.nova',
  /** Status de entrega de uma mensagem de saída mudou. */
  MENSAGEM_STATUS: 'mensagem.status',
  /** Alguém está digitando (atendente na conversa, colega no chat, contato no canal). */
  DIGITANDO: 'digitando',
  /** Mensagem nova (ou editada/excluída) no chat interno (sala `chat:<canalId>`). */
  CHAT_MENSAGEM: 'chat.mensagem',
  /** Canal do chat interno mudou (nome, membros) ou a pessoa entrou/saiu dele. */
  CHAT_ATUALIZADO: 'chat.atualizado',
  /** Conexão de um número de WhatsApp: status e QR (só para quem gerencia canais). */
  WHATSAPP_CONEXAO: 'whatsapp.conexao',
  /** Progresso de uma campanha de disparos (status e contadores), para quem vê a campanha. */
  CAMPANHA_PROGRESSO: 'campanha.progresso',
  /** Contagens do menu: notificações, Atendimento e Chat (campos ausentes = sem mudança). */
  NAO_LIDAS: 'nao-lidas',
  /** Progresso de uma importação de planilha (sala `usuario:<quem importou>`). */
  IMPORTACAO_PROGRESSO: 'importacao.progresso',
  /** Financeiro (Onda C): parcela paga, atrasada, alterada ou renegociada (salas dos gestores e do CS responsável). */
  PARCELA_ATUALIZADA: 'parcela.atualizada',
  /** Financeiro (Onda C): andamento de uma execução da régua e dos envios (salas dos gestores). */
  REGUA_PROGRESSO: 'regua.progresso',
  /** A sessão foi encerrada (sair, desligamento, troca de senha): o socket cai em seguida. */
  SESSAO_ENCERRADA: 'sessao.encerrada',
} as const;

export type EventoDoServidor =
  (typeof EVENTOS_DO_SERVIDOR)[keyof typeof EVENTOS_DO_SERVIDOR];

/** Objeto do domínio com `id` e o resto definido pelo módulo dono (o DTO dele). */
export type Recurso = { id: string } & Record<string, unknown>;

export interface CargaNotificacaoNova {
  notificacao: NotificacaoDto;
}

export interface CargaConversa {
  /** O resumo da conversa como a lista do Atendimento mostra (DTO do módulo de atendimento). */
  conversa: Recurso;
}

export interface CargaMensagemNova {
  conversaId: string;
  /** A mensagem como a conversa mostra (DTO do módulo de atendimento). */
  mensagem: Recurso;
}

export interface CargaMensagemStatus {
  conversaId: string;
  mensagemId: string;
  status: StatusMensagem;
  /** Motivo da falha, em português (só com `FALHOU`). */
  erro?: string | null;
  /** Quando mudou (ISO 8601). */
  em: string;
}

export interface CargaDigitando {
  /** Um dos dois: a conversa do Atendimento ou o canal do chat interno. */
  conversaId?: string;
  canalId?: string;
  /** `false` = parou de digitar. O cliente também apaga sozinho depois de ~6 s sem novo aviso. */
  ativo: boolean;
  /** Quem digita, quando é alguém da equipe. */
  usuario?: { id: string; nome: string };
  /** `true` quando é o contato digitando (WhatsApp, chat do site). */
  contato?: boolean;
}

export interface CargaChatMensagem {
  canalId: string;
  /** A mensagem como o chat mostra (DTO do módulo de chat interno). */
  mensagem: Recurso;
}

export interface CargaChatAtualizado {
  canalId: string;
  /** O canal como a lista do chat mostra; ausente com `removido`. */
  canal?: Recurso;
  /** A pessoa saiu (ou foi tirada) do canal. */
  removido?: boolean;
}

export interface CargaWhatsappConexao {
  numeroId: string;
  canalId: string;
  status: StatusWhatsapp;
  /** QR em data URL (`data:image/png;base64,…`) enquanto `AGUARDANDO_QR`. */
  qr?: string | null;
  /** Quando o QR expira (ISO 8601); um novo chega antes disso. */
  qrExpiraEm?: string | null;
  telefone?: string | null;
  /** Motivo do status, em português (erro, banimento, desconectado pelo celular…). */
  motivo?: string | null;
}

export interface CargaCampanhaProgresso {
  campanhaId: string;
  status: string;
  /** Contadores do relatório: total, enviados, entregues, lidos, respondidos, falhas, invalidos, optOuts. */
  contadores: Record<string, number>;
  /** Próximo envio previsto (ISO 8601), se a campanha está em andamento. */
  proximoEnvioEm: string | null;
  /** Motivo da pausa, se pausada. */
  pausaMotivo: string | null;
  em: string;
}

export interface CargaNaoLidas {
  /** Notificações não lidas (o sino). */
  notificacoes?: number;
  /** Conversas com mensagens não lidas que a pessoa atende. */
  atendimento?: number;
  /** Mensagens não lidas no chat interno (fora dos canais silenciados). */
  chat?: number;
}

export interface CargaSessaoEncerrada {
  motivo: 'sessao_revogada' | 'sessao_expirada' | 'usuario_inativo';
}

export interface CargaImportacaoProgresso {
  importacaoId: string;
  status: string;
  totalLinhas: number | null;
  processadas: number;
  criados: number;
  atualizados: number;
  ignorados: number;
  erros: number;
  /** Id do relatório XLSX, quando a importação terminou. */
  relatorioId?: string | null;
}

export interface CargaParcelaAtualizada {
  parcelaId: string;
  numero: string;
  contratoId: string | null;
  contatoId: string | null;
  /** Status já considerando o vencimento. */
  status: string;
  motivo:
    'paga' | 'atrasada' | 'alterada' | 'cancelada' | 'renegociada' | 'promessa';
}

export interface CargaReguaProgresso {
  /** Execução em andamento ou concluída; nulo quando é só um envio avulso. */
  execucaoId: string | null;
  status: string;
  /** `{ titulos, etapas, mensagens, ligacoes, pulados, erros }`. */
  resumo: Record<string, number>;
  /** Envio que mudou de situação (WhatsApp, e-mail ou ligação). */
  envioId?: string;
  situacao?: string;
}

/** O formato dos dados de cada evento do servidor. */
export interface CargasDoServidor {
  'notificacao.nova': CargaNotificacaoNova;
  'conversa.nova': CargaConversa;
  'conversa.atualizada': CargaConversa;
  'mensagem.nova': CargaMensagemNova;
  'mensagem.status': CargaMensagemStatus;
  digitando: CargaDigitando;
  'chat.mensagem': CargaChatMensagem;
  'chat.atualizado': CargaChatAtualizado;
  'whatsapp.conexao': CargaWhatsappConexao;
  'campanha.progresso': CargaCampanhaProgresso;
  'nao-lidas': CargaNaoLidas;
  'importacao.progresso': CargaImportacaoProgresso;
  'parcela.atualizada': CargaParcelaAtualizada;
  'regua.progresso': CargaReguaProgresso;
  'sessao.encerrada': CargaSessaoEncerrada;
}

// ---------------------------------------------------------------------------
// Cliente → servidor (com confirmação: o último argumento é a função de ack)
// ---------------------------------------------------------------------------

export const EVENTOS_DO_CLIENTE = {
  /** `{ conversaId }` → ack `{ ok }`. Exige poder ver a conversa (R12). */
  CONVERSA_ENTRAR: 'conversa.entrar',
  /** `{ conversaId }` → ack `{ ok: true }`. */
  CONVERSA_SAIR: 'conversa.sair',
  /** `{ canalId }` → ack `{ ok }`. Só membros do canal (R15). */
  CHAT_ENTRAR: 'chat.entrar',
  /** `{ canalId }` → ack `{ ok: true }`. */
  CHAT_SAIR: 'chat.sair',
  /** `{ conversaId | canalId, ativo? }` → repassado à sala (sem ack). Precisa estar na sala. */
  DIGITANDO: 'digitando',
} as const;

/** Resposta (ack) dos pedidos do cliente. */
export type RespostaDoTempoReal =
  | { ok: true }
  | {
      ok: false;
      erro: 'dados_invalidos' | 'sem_permissao' | 'erro_interno';
      mensagem: string;
    };
