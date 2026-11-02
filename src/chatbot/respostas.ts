/**
 * Interpretação das respostas do contato às perguntas do bot (R18): opções
 * numeradas e validações de e-mail, telefone, número e data. Funções puras.
 */
import { ehEmailValido, normalizarEmail } from '../comum/dominio/email';
import { normalizarTelefone } from '../comum/dominio/telefone';

export type TipoDeValidacao =
  'texto' | 'email' | 'telefone' | 'numero' | 'data';

export const TIPOS_DE_VALIDACAO: readonly TipoDeValidacao[] = [
  'texto',
  'email',
  'telefone',
  'numero',
  'data',
];

/** Texto sem acento, minúsculo e com espaços simples (comparações do bot). */
export function normalizarParaComparar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OpcaoDePergunta {
  id: string;
  rotulo: string;
}

/**
 * Qual opção o contato escolheu: o número (`2`, `2.`, `2)`) ou o texto da
 * opção (sem acento nem caixa). Nulo = resposta que não é uma opção.
 */
export function casarOpcao(
  resposta: string,
  opcoes: readonly OpcaoDePergunta[],
): OpcaoDePergunta | null {
  const limpa = resposta.trim();
  const numero = /^(\d{1,2})\s*[.)\-:]?$/.exec(limpa);
  if (numero) {
    const posicao = Number(numero[1]);
    return opcoes[posicao - 1] ?? null;
  }
  const alvo = normalizarParaComparar(limpa);
  if (alvo === '') {
    return null;
  }
  return (
    opcoes.find((opcao) => normalizarParaComparar(opcao.rotulo) === alvo) ??
    opcoes.find((opcao) => opcao.id === limpa) ??
    null
  );
}

/** O texto das opções numeradas, como vai no WhatsApp e no e-mail. */
export function textoComOpcoes(
  pergunta: string,
  opcoes: readonly OpcaoDePergunta[],
): string {
  const linhas = opcoes.map(
    (opcao, indice) => `${indice + 1} - ${opcao.rotulo}`,
  );
  return `${pergunta.trim()}\n\n${linhas.join('\n')}\n\nResponda com o número da opção.`;
}

/** Pergunta com opções: numeradas no WhatsApp e no e-mail, só o texto no chat do site (botões à parte). */
export function textoDaPerguntaComOpcoes(
  webchat: boolean,
  texto: string,
  opcoes: readonly OpcaoDePergunta[],
): string {
  return webchat ? texto.trim() : textoComOpcoes(texto, opcoes);
}

export type ResultadoDaValidacao =
  { valido: true; valor: string | number } | { valido: false; motivo: string };

const MENSAGEM_DE_NUMERO = 'Informe um número válido.';

/** Número em formato brasileiro (`1.234,56`) ou simples (`1234.56`). */
export function lerNumero(texto: string): number | null {
  const limpo = texto.trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (limpo === '') {
    return null;
  }
  let normalizado = limpo;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(limpo)) {
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d+,\d+$/.test(limpo)) {
    normalizado = limpo.replace(',', '.');
  } else if (!/^-?\d+(\.\d+)?$/.test(limpo)) {
    return null;
  }
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

/** `dd/mm/aaaa` (ou `dd/mm/aa`, `dd-mm-aaaa`) → `aaaa-mm-dd`; nulo se a data não existe. */
export function lerData(texto: string): string | null {
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})$/.exec(texto.trim());
  if (!m) {
    return null;
  }
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return null;
  }
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Valida a resposta aberta conforme o tipo e devolve o valor normalizado. */
export function validarResposta(
  tipo: TipoDeValidacao,
  resposta: string,
): ResultadoDaValidacao {
  const texto = resposta.trim();
  switch (tipo) {
    case 'email':
      return ehEmailValido(texto)
        ? { valido: true, valor: normalizarEmail(texto) }
        : { valido: false, motivo: 'Informe um e-mail válido.' };
    case 'telefone': {
      const telefone = normalizarTelefone(texto);
      return telefone.valido
        ? { valido: true, valor: telefone.telefone }
        : { valido: false, motivo: telefone.motivo };
    }
    case 'numero': {
      const numero = lerNumero(texto);
      return numero === null
        ? { valido: false, motivo: MENSAGEM_DE_NUMERO }
        : { valido: true, valor: numero };
    }
    case 'data': {
      const data = lerData(texto);
      return data === null
        ? { valido: false, motivo: 'Informe uma data válida, como 25/12/2026.' }
        : { valido: true, valor: data };
    }
    default:
      return texto === ''
        ? { valido: false, motivo: 'Não entendi a resposta.' }
        : { valido: true, valor: texto.slice(0, 2_000) };
  }
}
