/**
 * Pesquisa de satisfação (R12): ao resolver a conversa, o canal com a pesquisa
 * ligada pergunta a nota de 1 a 5; a resposta vale por 24 horas. A nota chega
 * como a próxima mensagem do contato ("5", "nota 4", "3 - demorou", "⭐⭐⭐⭐")
 * ou pelo próprio canal (o chat do site pode mostrar botões).
 */

/** A pesquisa aceita resposta por 24 horas depois de enviada. */
export const VALIDADE_DA_PESQUISA_MS = 24 * 60 * 60 * 1000;

/** Pergunta padrão (quando o canal não define a sua). */
export const PERGUNTA_PADRAO_DA_PESQUISA =
  'Como você avalia o nosso atendimento? Responda com uma nota de 1 (ruim) a 5 (ótimo).';

/** Resposta depois de uma avaliação recebida. */
export const AGRADECIMENTO_DA_AVALIACAO =
  'Obrigado pela avaliação! Ela nos ajuda a melhorar.';

/** Tamanho máximo do comentário guardado. */
export const TAMANHO_MAXIMO_COMENTARIO = 1000;

/** Nota até esta avisa o líder (avaliação baixa). */
export const NOTA_BAIXA = 2;

export interface Avaliacao {
  nota: number;
  comentario: string | null;
}

/**
 * Número de 1 a 5 no começo, seguido do fim do texto ou de um separador
 * ("5", "5!", "4/5", "nota 3", "5 estrelas", "2 - demorou"). "5 minutos de
 * espera" não é nota: depois do número precisa vir pontuação.
 */
const NOTA_NUMERICA =
  /^(?:(?:minha\s+)?nota\s*[:=]?\s*)?([1-5])(?:\s*\/\s*5)?(?:\s*(?:estrelas?|pontos?))?\s*(?:$|[-–—,.:;!)]\s*([\s\S]*)$)/i;

const NOTA_POR_EXTENSO: Readonly<Record<string, number>> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
};

/** Só estrelas (1 a 5). */
const ESTRELAS = /^(?:⭐|★|🌟){1,5}$/u;

/**
 * A mensagem é uma nota? Devolve a nota e o comentário (o resto do texto), ou
 * `null` quando não parece uma avaliação.
 */
export function lerAvaliacao(
  texto: string | null | undefined,
): Avaliacao | null {
  const limpo = (texto ?? '').trim();
  if (!limpo || limpo.length > TAMANHO_MAXIMO_COMENTARIO + 20) {
    return null;
  }
  // "⭐️" costuma vir com o seletor de variação (U+FE0F) e espaços no meio.
  const estrelas = limpo.replace(/[\uFE0F\s]/g, '');
  if (ESTRELAS.test(estrelas)) {
    return { nota: Array.from(estrelas).length, comentario: null };
  }
  const extenso = limpo
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!]+$/, '');
  if (extenso in NOTA_POR_EXTENSO) {
    return { nota: NOTA_POR_EXTENSO[extenso], comentario: null };
  }
  const encontrado = NOTA_NUMERICA.exec(limpo);
  if (!encontrado) {
    return null;
  }
  const comentario = (encontrado[2] ?? '').trim();
  return {
    nota: Number(encontrado[1]),
    comentario: comentario
      ? comentario.slice(0, TAMANHO_MAXIMO_COMENTARIO)
      : null,
  };
}

/** A pesquisa ainda aceita resposta? */
export function pesquisaValida(
  solicitadaEm: Date | null,
  respondidaEm: Date | null,
  agora: Date = new Date(),
): boolean {
  return (
    solicitadaEm !== null &&
    respondidaEm === null &&
    agora.getTime() - solicitadaEm.getTime() <= VALIDADE_DA_PESQUISA_MS
  );
}
