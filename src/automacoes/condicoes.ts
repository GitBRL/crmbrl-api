/**
 * Condições da automação (R19): `{ segmento?, horario? }`.
 * - `segmento`: o contato da execução precisa estar no segmento (§2.1) quando o
 *   gatilho dispara — e, com o critério SAIU_DO_SEGMENTO, antes de cada ação;
 * - `horario`: janela no formato de `canais.horario_atendimento`; fora dela as
 *   ações esperam a próxima abertura.
 */
import {
  type HorarioDeAtendimento,
  situacaoDoHorario,
  validarHorario,
} from '../atendimento/horario';
import {
  problemasDoSegmento,
  type Segmento,
  validarSegmento,
} from '../comum/segmentos/segmentos';

export interface CondicoesDaAutomacao {
  segmento?: Segmento;
  horario?: HorarioDeAtendimento;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Confere e normaliza as condições; devolve os erros em português. */
export function conferirCondicoes(entrada: unknown): {
  condicoes: CondicoesDaAutomacao;
  erros: string[];
} {
  const erros: string[] = [];
  const condicoes: CondicoesDaAutomacao = {};
  if (entrada === undefined || entrada === null) {
    return { condicoes, erros };
  }
  if (!ehObjeto(entrada)) {
    return { condicoes, erros: ['As condições devem ser um objeto.'] };
  }
  for (const chave of Object.keys(entrada)) {
    if (chave !== 'segmento' && chave !== 'horario') {
      erros.push(`Condição desconhecida: "${chave}".`);
    }
  }
  if (entrada.segmento !== undefined && entrada.segmento !== null) {
    const problemas = problemasDoSegmento(entrada.segmento);
    if (problemas.length > 0) {
      erros.push(
        ...problemas.map((p) => `Público: ${p.mensagem} (${p.caminho})`),
      );
    } else {
      condicoes.segmento = validarSegmento(entrada.segmento);
    }
  }
  if (entrada.horario !== undefined && entrada.horario !== null) {
    const resultado = validarHorario(entrada.horario);
    if (resultado.erros) {
      erros.push(...resultado.erros.map((e) => `Horário: ${e}`));
    } else {
      condicoes.horario = resultado.horario;
    }
  }
  return { condicoes, erros };
}

/** Lê as condições gravadas (já validadas ao salvar). */
export function lerCondicoes(valor: unknown): CondicoesDaAutomacao {
  return conferirCondicoes(valor).condicoes;
}

/**
 * Pode agir agora? `{ pode: true }` ou, fora do horário, a próxima abertura
 * (nula se não abre nos próximos 8 dias).
 */
export function situacaoDoHorarioDaAutomacao(
  condicoes: CondicoesDaAutomacao,
  agora: Date,
): { pode: true } | { pode: false; proximaAbertura: Date | null } {
  if (!condicoes.horario) {
    return { pode: true };
  }
  const situacao = situacaoDoHorario(condicoes.horario, agora);
  return situacao.aberto
    ? { pode: true }
    : { pode: false, proximaAbertura: situacao.proximaAbertura };
}
