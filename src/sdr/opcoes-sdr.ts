import type { OpcoesDaChamada } from '../bi/analise/chamada-claude.service';
import {
  DIGITANDO_MAXIMO_MS,
  DIGITANDO_MINIMO_MS,
  DIGITANDO_POR_CARACTERE_MS,
} from './sdr.constantes';

/** Ajustes do motor que os testes trocam (`overrideProvider(OPCOES_SDR)`). */
export interface OpcoesDoSdr {
  /** Faz a pausa de "digitando…" antes de enviar a resposta (nos testes, não). */
  simularDigitacao: boolean;
  /** Pausa de digitação por caractere, mínimo e máximo, em ms. */
  digitandoPorCaractereMs: number;
  digitandoMinimoMs: number;
  digitandoMaximoMs: number;
}

export const OPCOES_SDR = Symbol('OPCOES_SDR');

export const OPCOES_SDR_PADRAO: OpcoesDoSdr = {
  simularDigitacao: true,
  digitandoPorCaractereMs: DIGITANDO_POR_CARACTERE_MS,
  digitandoMinimoMs: DIGITANDO_MINIMO_MS,
  digitandoMaximoMs: DIGITANDO_MAXIMO_MS,
};

/** Chamada ao Claude do SDR: uma resposta de chat não espera muito. */
export const OPCOES_CHAMADA_SDR: OpcoesDaChamada = {
  timeoutMs: 60_000,
  esperaMs: 1_500,
  tentativas: 2,
};
