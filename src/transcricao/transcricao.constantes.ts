/**
 * Transcrição e resumo das ligações (R30): nomes das filas, estados e limites.
 * A gravação em partes e a leitura ficam em `src/ligacoes/gravacao`.
 */

/** Código da regra (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_TRANSCRICAO = 'R30';

/** Fila do processamento da gravação (ffmpeg + whisper): uma transcrição por vez. */
export const FILA_PROCESSAR_LIGACAO = 'transcricao.processar';
/** Fila do resumo pelo Claude (depois da transcrição). */
export const FILA_RESUMIR_LIGACAO = 'transcricao.resumir';

/** Tentativas do job de processamento e espera entre elas. */
export const TENTATIVAS_DO_PROCESSAMENTO = 3;
export const ESPERA_ENTRE_TENTATIVAS_S = 60;
export const TENTATIVAS_DO_RESUMO = 3;

/** Tempo máximo de cada comando do ffmpeg/ffprobe. */
export const TEMPO_LIMITE_DO_FFMPEG_MS = 15 * 60 * 1000;

/** Tempo da consulta de saúde ao whisper-server. */
export const TEMPO_DA_SAUDE_MS = 3_000;

/** Trechos do mesmo falante com uma pausa até este tamanho viram um só. */
export const JUNTAR_TRECHOS_ATE_S = 1.5;

/** Transcrições com menos palavras que isto não vão para o resumo. */
export const MINIMO_DE_PALAVRAS_PARA_RESUMIR = 15;

/** Limite do texto enviado ao Claude (caracteres): ligações de horas são cortadas no meio com aviso. */
export const MAXIMO_DE_CARACTERES_NO_RESUMO = 400_000;

/** Teto de tokens de saída do resumo. */
export const MAX_TOKENS_DO_RESUMO = 4_000;

/** Tempo máximo de uma tentativa do resumo. */
export const TIMEOUT_DO_RESUMO_MS = 120_000;

export type FalanteDoTrecho = 'atendente' | 'cliente' | 'participante';

export const ROTULO_DO_FALANTE: Readonly<Record<FalanteDoTrecho, string>> = {
  atendente: 'Atendente',
  cliente: 'Cliente',
  participante: 'Participante',
};

export const VERSAO_DA_TRANSCRICAO = 1;

/** Um trecho da conversa, com os tempos em segundos desde o início da gravação. */
export interface Trecho {
  falante: FalanteDoTrecho;
  inicio: number;
  fim: number;
  texto: string;
}

/** O que fica em `Ligacao.transcricao`. */
export interface TranscricaoGravada {
  versao: number;
  idioma: string;
  modelo: string;
  duracaoSegundos: number;
  trechos: Trecho[];
  /** Explica uma transcrição sem trechos (ex.: nenhuma fala na gravação). */
  aviso?: string;
}

/** Texto da transcrição pronta quando nenhum canal tem fala. */
export const AVISO_SEM_FALA =
  'Nenhuma fala foi detectada na gravação: os dois lados ficaram em silêncio.';

export type TipoDeSugestao =
  'LIGACAO' | 'TAREFA' | 'EMAIL' | 'WHATSAPP' | 'REUNIAO';
export const TIPOS_DE_SUGESTAO: readonly TipoDeSugestao[] = [
  'LIGACAO',
  'TAREFA',
  'EMAIL',
  'WHATSAPP',
  'REUNIAO',
];

export type SentimentoDaLigacao = 'positivo' | 'neutro' | 'negativo' | 'misto';
export const SENTIMENTOS: readonly SentimentoDaLigacao[] = [
  'positivo',
  'neutro',
  'negativo',
  'misto',
];

/** Sugestão de atividade dentro de `Ligacao.resumo`. */
export interface SugestaoDeAtividade {
  id: string;
  titulo: string;
  descricao: string;
  tipo: TipoDeSugestao;
  /** Prazo sugerido, em dias a partir de hoje (0 = hoje). */
  prazoEmDias: number;
  /** Preenchido quando o usuário confirmou (a atividade criada). */
  atividadeId: string | null;
  /** Preenchido quando o usuário descartou. */
  descartadaEm: string | null;
}

/** O que fica em `Ligacao.resumo`. */
export interface ResumoGravado {
  versao: number;
  assunto: string;
  pontosPrincipais: string[];
  combinados: string[];
  proximosPassos: string[];
  sentimento: SentimentoDaLigacao;
  sentimentoMotivo: string;
  sugestoes: SugestaoDeAtividade[];
  modelo: string;
}
