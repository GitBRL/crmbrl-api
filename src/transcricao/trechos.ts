/**
 * Junta os trechos transcritos de cada canal numa conversa só, na ordem do tempo (R30).
 * Funções puras: o canal esquerdo da gravação é o atendente; o direito, o cliente.
 */
import {
  type FalanteDoTrecho,
  JUNTAR_TRECHOS_ATE_S,
  ROTULO_DO_FALANTE,
  type Trecho,
} from './transcricao.constantes';

/** Trecho como o whisper devolve (um canal só, tempos em segundos). */
export interface TrechoBruto {
  inicio: number;
  fim: number;
  texto: string;
}

/** Alucinações conhecidas do Whisper em silêncio ou música, e marcações sem fala. */
const RUIDOS = [
  /^\s*[[(*♪].*[\])*♪]\s*$/s,
  /amara\.org/i,
  /legendas?\s+(pela|por|da)\s+comunidade/i,
  /transcri(ç|c)(ã|a)o\s+e\s+legendas?\s+por/i,
  /^[\s.,!?…-]*$/,
];

export function limparTexto(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

export function ehRuido(texto: string): boolean {
  const limpo = limparTexto(texto);
  return limpo === '' || RUIDOS.some((regex) => regex.test(limpo));
}

/** Trechos de um canal, já limpos e sem ruído, nunca com fim antes do início. */
export function prepararCanal(
  falante: FalanteDoTrecho,
  trechos: readonly TrechoBruto[],
): Trecho[] {
  const resultado: Trecho[] = [];
  for (const trecho of trechos) {
    const texto = limparTexto(trecho.texto);
    if (ehRuido(texto)) {
      continue;
    }
    const inicio = Math.max(0, Number(trecho.inicio) || 0);
    const fim = Math.max(inicio, Number(trecho.fim) || inicio);
    resultado.push({ falante, inicio, fim, texto });
  }
  return resultado;
}

/**
 * Intercala os canais por tempo de início (empate: atendente primeiro). Trechos
 * seguidos do mesmo falante, com pausa de até `JUNTAR_TRECHOS_ATE_S`, viram um.
 */
export function intercalar(canais: readonly (readonly Trecho[])[]): Trecho[] {
  const todos = canais
    .flat()
    .map((trecho) => ({ ...trecho }))
    .sort(
      (a, b) =>
        a.inicio - b.inicio ||
        Number(b.falante === 'atendente') - Number(a.falante === 'atendente') ||
        a.fim - b.fim,
    );
  const resultado: Trecho[] = [];
  for (const trecho of todos) {
    const anterior = resultado[resultado.length - 1];
    if (
      anterior &&
      anterior.falante === trecho.falante &&
      trecho.inicio - anterior.fim <= JUNTAR_TRECHOS_ATE_S
    ) {
      anterior.fim = Math.max(anterior.fim, trecho.fim);
      anterior.texto = `${anterior.texto} ${trecho.texto}`;
    } else {
      resultado.push(trecho);
    }
  }
  return resultado;
}

/** `m:ss` (ou `h:mm:ss`) de um tempo em segundos. */
export function marcaDeTempo(segundos: number): string {
  const total = Math.max(0, Math.floor(segundos));
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const resto = String(total % 60).padStart(2, '0');
  return horas > 0
    ? `${horas}:${String(minutos).padStart(2, '0')}:${resto}`
    : `${minutos}:${resto}`;
}

/** A conversa como texto, uma linha por trecho: `[0:12] Atendente: …`. */
export function textoDaConversa(trechos: readonly Trecho[]): string {
  return trechos
    .map(
      (t) =>
        `[${marcaDeTempo(t.inicio)}] ${ROTULO_DO_FALANTE[t.falante]}: ${t.texto}`,
    )
    .join('\n');
}

export function contarPalavras(trechos: readonly Trecho[]): number {
  return trechos.reduce(
    (soma, t) => soma + t.texto.split(/\s+/).filter(Boolean).length,
    0,
  );
}
