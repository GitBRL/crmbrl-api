/**
 * Leitura da base de conhecimento do assistente (R25): os artigos `*.md` da
 * pasta, em ordem alfabética, num único bloco delimitado (byte a byte igual
 * entre as perguntas: é o prefixo em cache). Funções puras, sem Nest.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_CARACTERES_ARTIGO,
  MAX_CARACTERES_BASE,
} from './assistente.constantes';
import { neutralizarMarcadores } from './prompt-assistente';

export interface ArtigoLido {
  arquivo: string;
  /** O primeiro título `# …` do artigo (ou o nome do arquivo). */
  titulo: string;
  caracteres: number;
}

export interface BaseLida {
  artigos: ArtigoLido[];
  /** O bloco `<base_de_conhecimento>…</base_de_conhecimento>` (vazio sem artigos). */
  texto: string;
  /** Problemas da leitura (pasta ausente, artigo cortado…), para o log e o estado. */
  avisos: string[];
}

function tituloDe(conteudo: string, arquivo: string): string {
  const linha = /^#\s+(.+)$/m.exec(conteudo)?.[1]?.trim();
  return linha || arquivo.replace(/\.md$/i, '');
}

/** Lê a pasta e monta o bloco da base. Nunca lança. */
export function lerBaseDeConhecimento(diretorio: string): BaseLida {
  const avisos: string[] = [];
  let nomes: string[];
  try {
    nomes = readdirSync(diretorio)
      .filter((nome) => /\.md$/i.test(nome))
      .filter((nome) => statSync(join(diretorio, nome)).isFile())
      .sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return {
      artigos: [],
      texto: '',
      avisos: [`A pasta da base de conhecimento não foi encontrada.`],
    };
  }
  const artigos: ArtigoLido[] = [];
  const blocos: string[] = [];
  let total = 0;
  for (const arquivo of nomes) {
    let conteudo = readFileSync(join(diretorio, arquivo), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    if (!conteudo) {
      continue;
    }
    if (conteudo.length > MAX_CARACTERES_ARTIGO) {
      avisos.push(
        `O artigo ${arquivo} passa de ${MAX_CARACTERES_ARTIGO} caracteres e foi cortado.`,
      );
      conteudo = conteudo.slice(0, MAX_CARACTERES_ARTIGO);
    }
    if (total + conteudo.length > MAX_CARACTERES_BASE) {
      avisos.push(
        `A base passa de ${MAX_CARACTERES_BASE} caracteres: ${arquivo} e os seguintes ficaram de fora.`,
      );
      break;
    }
    total += conteudo.length;
    const nomeSeguro = arquivo.replace(/[^\w.-]/g, '_');
    blocos.push(
      `<artigo arquivo="${nomeSeguro}">\n${neutralizarMarcadores(conteudo)}\n</artigo>`,
    );
    artigos.push({
      arquivo,
      titulo: tituloDe(conteudo, arquivo),
      caracteres: conteudo.length,
    });
  }
  if (artigos.length === 0 && avisos.length === 0) {
    avisos.push('A base de conhecimento não tem artigos.');
  }
  return {
    artigos,
    texto: artigos.length
      ? `<base_de_conhecimento>\n${blocos.join('\n\n')}\n</base_de_conhecimento>`
      : '',
    avisos,
  };
}
