/**
 * Gatilho das automações (R19): confere `tipoGatilho` + `evento` + `gatilhoConfig`
 * contra o catálogo (`src/comum/gatilhos/catalogo.ts`) e decide se um evento
 * casa com os filtros. Funções puras.
 */
import {
  type EntidadeDeGatilho,
  CATALOGO_DE_GATILHOS,
  type GatilhoDoCatalogo,
} from '../comum/gatilhos/catalogo';
import {
  CAMPOS_DE_DATA_RELATIVA,
  problemaDaDataRelativa,
  problemaDaRecorrencia,
} from '../comum/gatilhos/agenda';
import {
  RESULTADOS_DE_LIGACAO,
  type ResultadoDaLigacao,
} from '../ligacoes/ligacoes.constantes';
import { OrigemContato, TipoAtividade } from '../generated/prisma/client';

export type TipoDeGatilho = 'EVENTO' | 'DATA_RELATIVA' | 'RECORRENCIA';

/** Filtros extras (além dos do catálogo) aceitos nos gatilhos de agenda. */
const FILTROS_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  /** Dias além do prazo da etapa (R5.10) para considerar parado (padrão 0). */
  'negocio.parado': ['diasAlemDoPrazo'],
  /** Horas depois do vencimento para considerar atrasada (padrão 0). */
  'atividade.atrasada': ['horasAlemDoVencimento'],
};

const FILTROS_DE_ID = ['funilId', 'etapaId', 'canalId', 'campanhaId'];
const TIPOS_DE_CANAL = [
  'WHATSAPP',
  'EMAIL',
  'WEBCHAT',
  'INSTAGRAM',
  'MESSENGER',
  'WHATSAPP_OFICIAL',
];
const TEMPERATURAS_DO_SDR = ['QUENTE', 'MORNO', 'FRIO'];
const DIRECOES_DE_LIGACAO = ['RECEBIDA', 'FEITA'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function gatilhoDoCatalogo(
  evento: string | null | undefined,
): GatilhoDoCatalogo | undefined {
  return CATALOGO_DE_GATILHOS.find((g) => g.evento === evento);
}

export interface EntradaDeGatilho {
  tipoGatilho: TipoDeGatilho;
  evento?: string | null;
  gatilhoConfig?: unknown;
  entidade?: string | null;
}

export interface ResultadoDoGatilho {
  /** Impedem salvar. */
  erros: string[];
  /** Impedem ativar (faltou configurar algo). */
  pendencias: string[];
  /** Entidade que o gatilho implica (a gravada em `automacoes.entidade`). */
  entidade: EntidadeDeGatilho | null;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function comoLista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [valor];
}

/** Confere o gatilho. A entidade devolvida vem do catálogo (a enviada deve coincidir). */
export function conferirGatilho(entrada: EntradaDeGatilho): ResultadoDoGatilho {
  const erros: string[] = [];
  const pendencias: string[] = [];
  let entidade: EntidadeDeGatilho | null = null;
  const config = entrada.gatilhoConfig ?? {};

  if (!ehObjeto(config)) {
    return {
      erros: ['A configuração do gatilho deve ser um objeto.'],
      pendencias,
      entidade,
    };
  }

  if (entrada.tipoGatilho === 'EVENTO') {
    const gatilho = gatilhoDoCatalogo(entrada.evento);
    if (!gatilho) {
      erros.push('Escolha um gatilho válido.');
    } else {
      entidade = gatilho.entidade;
      const aceitos = [
        ...gatilho.filtros,
        ...(FILTROS_EXTRAS[gatilho.evento] ?? []),
      ];
      for (const chave of Object.keys(config)) {
        if (!aceitos.includes(chave)) {
          erros.push(`O filtro "${chave}" não vale para "${gatilho.rotulo}".`);
        }
      }
      erros.push(...problemasDosFiltros(config));
      if (gatilho.evento === 'negocio.movido' && !config.etapaId) {
        pendencias.push('Escolha a etapa de destino do negócio.');
      }
      if (
        gatilho.evento === 'mensagem.recebida' &&
        !(Array.isArray(config.palavras) && config.palavras.length > 0)
      ) {
        pendencias.push('Informe ao menos uma palavra.');
      }
    }
  } else if (entrada.tipoGatilho === 'DATA_RELATIVA') {
    const problema = problemaDaDataRelativa(config);
    if (problema) {
      erros.push(problema);
    } else {
      const campo = config.campo as string;
      entidade = campo.startsWith('contato.campos.')
        ? 'contato'
        : CAMPOS_DE_DATA_RELATIVA[campo as keyof typeof CAMPOS_DE_DATA_RELATIVA]
            .entidade;
    }
  } else {
    const problema = problemaDaRecorrencia(config);
    if (problema) {
      erros.push(problema);
    }
    entidade = 'contato';
  }

  if (
    entidade &&
    entrada.entidade &&
    entrada.entidade !== entidade &&
    erros.length === 0
  ) {
    erros.push(
      `Este gatilho trabalha com ${entidade}, não com ${entrada.entidade}.`,
    );
  }
  return { erros, pendencias, entidade };
}

function problemasDosFiltros(config: Record<string, unknown>): string[] {
  const erros: string[] = [];
  for (const [chave, valor] of Object.entries(config)) {
    if (valor === undefined || valor === null || valor === '') {
      continue;
    }
    if (FILTROS_DE_ID.includes(chave)) {
      if (
        !comoLista(valor).every((v) => typeof v === 'string' && UUID.test(v))
      ) {
        erros.push(`"${chave}" deve ser um id válido.`);
      }
    } else if (chave === 'origem') {
      if (
        !comoLista(valor).every((v) =>
          Object.values(OrigemContato).includes(v as OrigemContato),
        )
      ) {
        erros.push('A origem do filtro é inválida.');
      }
    } else if (chave === 'tipo') {
      if (
        !comoLista(valor).every((v) =>
          Object.values(TipoAtividade).includes(v as TipoAtividade),
        )
      ) {
        erros.push('O tipo de atividade do filtro é inválido.');
      }
    } else if (chave === 'canalTipo') {
      if (
        !comoLista(valor).every((v) => TIPOS_DE_CANAL.includes(v as string))
      ) {
        erros.push('O tipo de canal do filtro é inválido.');
      }
    } else if (chave === 'palavras') {
      if (
        !Array.isArray(valor) ||
        !valor.every((v) => typeof v === 'string' && v.trim() !== '')
      ) {
        erros.push('As palavras do filtro devem ser uma lista de textos.');
      }
    } else if (chave === 'direcao') {
      if (
        !comoLista(valor).every((v) =>
          DIRECOES_DE_LIGACAO.includes(v as string),
        )
      ) {
        erros.push(
          'A direção da ligação do filtro é inválida (RECEBIDA ou FEITA).',
        );
      }
    } else if (chave === 'resultado') {
      if (
        !comoLista(valor).every((v) =>
          RESULTADOS_DE_LIGACAO.includes(v as ResultadoDaLigacao),
        )
      ) {
        erros.push(
          `O resultado da ligação do filtro é inválido (${RESULTADOS_DE_LIGACAO.join(', ')}).`,
        );
      }
    } else if (chave === 'temperatura') {
      if (
        !comoLista(valor).every((v) =>
          TEMPERATURAS_DO_SDR.includes(v as string),
        )
      ) {
        erros.push(
          `A temperatura do filtro é inválida (${TEMPERATURAS_DO_SDR.join(', ')}).`,
        );
      }
    } else if (chave === 'notaMinima' || chave === 'notaMaxima') {
      if (
        !Number.isInteger(valor) ||
        (valor as number) < 1 ||
        (valor as number) > 5
      ) {
        erros.push('A nota do filtro deve ir de 1 a 5.');
      }
    } else if (
      chave === 'diasAlemDoPrazo' ||
      chave === 'horasAlemDoVencimento'
    ) {
      if (
        !Number.isInteger(valor) ||
        (valor as number) < 0 ||
        (valor as number) > 3650
      ) {
        erros.push(`"${chave}" deve ser um número inteiro de 0 a 3650.`);
      }
    }
  }
  return erros;
}

/** Remove acentos, caixa e espaços repetidos (a busca por palavra ignora isso). */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O texto contém alguma das palavras (inteiras ou parte, sem acento nem caixa)? */
export function contemPalavra(
  texto: string | null | undefined,
  palavras: readonly string[],
): boolean {
  if (!texto) {
    return false;
  }
  const alvo = normalizarTexto(texto);
  return palavras.some((p) => {
    const palavra = normalizarTexto(p);
    return palavra !== '' && alvo.includes(palavra);
  });
}

function valorNaLista(valor: unknown, esperado: unknown): boolean {
  if (esperado === undefined || esperado === null || esperado === '') {
    return true;
  }
  return comoLista(esperado).includes(valor);
}

/**
 * O evento casa com os filtros da automação? `dados` é o `dados` do evento de
 * domínio; `texto` é o texto da mensagem recebida (carregado por quem chama).
 */
export function casaComFiltros(
  evento: string,
  dados: unknown,
  config: unknown,
  extras: { texto?: string | null } = {},
): boolean {
  const filtros = ehObjeto(config) ? config : {};
  const d = ehObjeto(dados) ? dados : {};
  const primeira = ehObjeto(d.primeiraOrigem) ? d.primeiraOrigem : {};
  if (evento === 'contato.criado' || evento === 'contato.atualizado') {
    if (!valorNaLista(primeira.tipo, filtros.origem)) {
      return false;
    }
  }
  if (!valorNaLista(d.funilId, filtros.funilId)) {
    return false;
  }
  if (!valorNaLista(d.etapaId, filtros.etapaId)) {
    return false;
  }
  if (!valorNaLista(d.tipo, filtros.tipo) && evento.startsWith('atividade.')) {
    return false;
  }
  if (!valorNaLista(d.canalTipo, filtros.canalTipo)) {
    return false;
  }
  if (!valorNaLista(d.canalId, filtros.canalId)) {
    return false;
  }
  if (!valorNaLista(d.campanhaId, filtros.campanhaId)) {
    return false;
  }
  if (
    evento.startsWith('sdr.') &&
    !valorNaLista(d.temperatura, filtros.temperatura)
  ) {
    return false;
  }
  if (evento.startsWith('ligacao.')) {
    if (
      !valorNaLista(d.direcao, filtros.direcao) ||
      !valorNaLista(d.resultado, filtros.resultado)
    ) {
      return false;
    }
  }
  if (
    Array.isArray(filtros.palavras) &&
    filtros.palavras.length > 0 &&
    !contemPalavra(extras.texto, filtros.palavras as string[])
  ) {
    return false;
  }
  if (evento === 'conversa.avaliada') {
    const nota = Number(d.nota);
    if (
      typeof filtros.notaMinima === 'number' &&
      !(nota >= filtros.notaMinima)
    ) {
      return false;
    }
    if (
      typeof filtros.notaMaxima === 'number' &&
      !(nota <= filtros.notaMaxima)
    ) {
      return false;
    }
  }
  return true;
}
