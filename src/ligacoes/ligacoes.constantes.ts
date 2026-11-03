import type { EstadoLigacao } from '../generated/prisma/client';

/** Regra de negócio das ligações pelo WhatsApp (REGRAS-DE-NEGOCIO, R29). */
export const REGRA_LIGACOES = 'R29';

/** Jobs (pg-boss) das ligações. */
export const FILA_TOQUE_ESGOTADO = 'ligacoes.toque-esgotado';
export const FILA_VIGIAR_LIGACAO = 'ligacoes.vigiar';
export const FILA_FECHAR_ENCERRAMENTO = 'ligacoes.fechar-encerramento';
export const FILA_CONEXAO_PERDIDA = 'ligacoes.conexao-perdida';
export const FILA_LIMPAR_DEDUPE = 'ligacoes.limpar-dedupe';

/** Os webhooks da Meta podem ser reentregues por até 7 dias: a chave de dedupe vale isso. */
export const VALIDADE_DO_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
/** Limpeza diária das chaves vencidas, às 04:00 (fuso de São Paulo). */
export const AGENDA_DA_LIMPEZA = '0 4 * * *';

/** Tempo de toque: padrão e limites (sempre abaixo do prazo de 30 a 60 s da Meta para atender). */
export const TOQUE_PADRAO_SEGUNDOS = 25;
export const TOQUE_MINIMO_SEGUNDOS = 10;
export const TOQUE_MAXIMO_SEGUNDOS = 40;

/** Webhook `connect` mais velho que isto: a Meta já desistiu da ligação, ninguém consegue atender. */
export const IDADE_MAXIMA_DO_CONNECT_MS = 50_000;

/** Depois de o navegador cair durante a ligação, quanto esperar a reconexão do socket antes de encerrar. */
export const TOLERANCIA_DE_DESCONEXAO_S = 15;

/** Ligação feita presa em CHAMANDO/TOCANDO além disto é fechada (a Meta costuma mandar o `terminate` antes). */
export const VIGIA_DA_LIGACAO_FEITA_S = 120;

/** Depois de pedir o `terminate`, quanto esperar o webhook antes de fechar a ligação sozinho. */
export const ESPERA_DO_TERMINATE_S = 20;

/** Ligações feitas seguidas sem resposta que fazem a Meta revogar a permissão (produção). */
export const SEM_RESPOSTA_QUE_REVOGAM = 4;

/** Limites de pedido de permissão por cliente (referência §3.3). */
export const LIMITE_DE_PEDIDOS_24H = 1;
export const LIMITE_DE_PEDIDOS_7D = 2;

/** Prazo da atividade "Retornar ligação", em horas. */
export const PRAZO_DE_RETORNO_HORAS = 4;

export const ESTADOS_ATIVOS: readonly EstadoLigacao[] = [
  'CHAMANDO',
  'TOCANDO',
  'EM_ANDAMENTO',
];

export const ESTADOS_TERMINAIS: readonly EstadoLigacao[] = [
  'ENCERRADA',
  'PERDIDA',
  'RECUSADA',
  'SEM_RESPOSTA',
  'FALHOU',
];

/** Tipos das notificações internas das ligações (e do push, R26). */
export const TIPOS_NOTIFICACAO_LIGACAO = {
  /** Ligação recebida tocando (some da lista quando alguém atende ou ela termina). */
  TOCANDO: 'ligacao.tocando',
  /** Ligação perdida: há uma atividade "Retornar ligação". */
  PERDIDA: 'ligacao.perdida',
} as const;

/** Motivos do desfecho (`Ligacao.motivo`), com o texto mostrado ao atendente. */
export const MOTIVOS_DA_LIGACAO = {
  concluida: 'Ligação concluída.',
  encerrada_pelo_atendente: 'Encerrada pelo atendente.',
  encerrada_pelo_cliente: 'Encerrada pelo cliente.',
  tempo_esgotado: 'Ninguém atendeu no tempo de toque.',
  recusada_pelos_atendentes:
    'Todos os atendentes chamados recusaram a ligação.',
  fora_do_horario: 'Ligação recebida fora do horário de ligações.',
  sem_atendente: 'Nenhum atendente disponível no momento.',
  ligacoes_desativadas: 'As ligações estão desativadas neste canal.',
  atrasada: 'A ligação chegou depois de a Meta desistir dela.',
  cliente_desligou: 'O cliente desligou antes de alguém atender.',
  recusada_pelo_cliente: 'O cliente recusou a ligação.',
  sem_resposta: 'O cliente não atendeu.',
  cancelada_pelo_atendente: 'O atendente cancelou antes de o cliente atender.',
  conexao_perdida: 'O navegador do atendente perdeu a conexão.',
  falha_ao_atender: 'A Meta não aceitou a ligação (ela pode ter expirado).',
  falha_ao_ligar: 'A Meta não conseguiu completar a ligação.',
  falha_de_midia: 'Não foi possível conectar o áudio da ligação.',
  falha_na_meta: 'A Meta encerrou a ligação com erro.',
  sem_resposta_da_meta: 'A Meta não completou a ligação a tempo.',
} as const;

export type MotivoDaLigacao = keyof typeof MOTIVOS_DA_LIGACAO;

export function textoDoMotivo(
  motivo: string | null | undefined,
): string | null {
  if (!motivo) {
    return null;
  }
  return (MOTIVOS_DA_LIGACAO as Record<string, string>)[motivo] ?? motivo;
}

/** Resultado de uma ligação nos eventos (`ligacao.encerrada`), nos filtros dos gatilhos e no webhook de saída. */
export type ResultadoDaLigacao =
  'atendida' | 'perdida' | 'recusada' | 'sem_resposta' | 'falhou';

export const RESULTADOS_POR_ESTADO: Partial<
  Record<EstadoLigacao, ResultadoDaLigacao>
> = {
  ENCERRADA: 'atendida',
  PERDIDA: 'perdida',
  RECUSADA: 'recusada',
  SEM_RESPOSTA: 'sem_resposta',
  FALHOU: 'falhou',
};

export const RESULTADOS_DE_LIGACAO: readonly ResultadoDaLigacao[] = [
  'atendida',
  'perdida',
  'recusada',
  'sem_resposta',
  'falhou',
];

export function resultadoDaLigacao(estado: EstadoLigacao): ResultadoDaLigacao {
  return RESULTADOS_POR_ESTADO[estado] ?? 'falhou';
}
