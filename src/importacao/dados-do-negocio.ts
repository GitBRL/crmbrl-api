/**
 * Leitura dos campos de negócio fechado e de datas da planilha (R16.14,
 * R16.15): status por sinônimos (sem acento, caixa nem espaços extras) e datas
 * em `dd/mm/aaaa [hh:mm[:ss]]`, `aaaa-mm-dd[Thh:mm[:ss]]` ou número de série do
 * Excel, no horário de America/Sao_Paulo. Funções puras.
 */
import { deslocamentoDoFuso } from '../atividades/fuso-horario';
import { normalizarTextoDoFiltro } from './filtro-de-linhas';

export type StatusDoNegocioImportado = 'ABERTO' | 'GANHO' | 'PERDIDO';

const FUSO = 'America/Sao_Paulo';

const SINONIMOS_DE_STATUS: Record<string, StatusDoNegocioImportado> = {
  aberto: 'ABERTO',
  'em aberto': 'ABERTO',
  open: 'ABERTO',
  'em andamento': 'ABERTO',
  ganho: 'GANHO',
  won: 'GANHO',
  vendido: 'GANHO',
  perdido: 'PERDIDO',
  lost: 'PERDIDO',
  perda: 'PERDIDO',
};

/** Status da coluna: vazio → ABERTO; desconhecido → ABERTO com `aviso`. */
export function lerStatusDoNegocio(texto: string | undefined): {
  status: StatusDoNegocioImportado;
  aviso?: string;
} {
  const bruto = (texto ?? '').trim();
  if (bruto === '') {
    return { status: 'ABERTO' };
  }
  const status = SINONIMOS_DE_STATUS[normalizarTextoDoFiltro(bruto)];
  return status
    ? { status }
    : {
        status: 'ABERTO',
        aviso: `Status "${bruto}" desconhecido: o negócio entrou aberto.`,
      };
}

/** Instante de uma data e hora "de parede" de São Paulo. */
function instanteDeSaoPaulo(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  segundo: number,
): Date | null {
  const parede = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo);
  const verificacao = new Date(parede);
  if (
    verificacao.getUTCFullYear() !== ano ||
    verificacao.getUTCMonth() !== mes - 1 ||
    verificacao.getUTCDate() !== dia ||
    hora > 23 ||
    minuto > 59 ||
    segundo > 59
  ) {
    return null;
  }
  const primeira = parede - deslocamentoDoFuso(new Date(parede), FUSO);
  const segunda = parede - deslocamentoDoFuso(new Date(primeira), FUSO);
  return new Date(segunda);
}

const BR =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SERIE = /^\d{4,6}(?:[.,]\d+)?$/;

/**
 * Data da planilha → instante, ou `null` quando inválida. Sem hora, meia-noite
 * de São Paulo. Número de série do Excel (dias desde 30/12/1899).
 */
export function lerDataDaPlanilha(texto: string): Date | null {
  const t = texto.trim();
  let m = BR.exec(t);
  if (m) {
    return instanteDeSaoPaulo(
      Number(m[3]),
      Number(m[2]),
      Number(m[1]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  }
  m = ISO.exec(t);
  if (m) {
    return instanteDeSaoPaulo(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  }
  if (SERIE.test(t)) {
    const serie = Number(t.replace(',', '.'));
    if (serie < 1 || serie > 2_958_465) {
      return null;
    }
    const segundos = Math.round(serie * 86_400);
    const parede = new Date(Date.UTC(1899, 11, 30) + segundos * 1000);
    return instanteDeSaoPaulo(
      parede.getUTCFullYear(),
      parede.getUTCMonth() + 1,
      parede.getUTCDate(),
      parede.getUTCHours(),
      parede.getUTCMinutes(),
      parede.getUTCSeconds(),
    );
  }
  return null;
}

/** Data lida ou aviso: inválida ou no futuro vira aviso e o campo é ignorado. */
export function lerDataDoNegocio(
  rotulo: string,
  texto: string,
  agora: Date,
): { data?: Date; aviso?: string } {
  const data = lerDataDaPlanilha(texto);
  if (!data) {
    return { aviso: `${rotulo} inválida ("${texto}"); ignorada.` };
  }
  if (data.getTime() > agora.getTime()) {
    return { aviso: `${rotulo} no futuro ("${texto}"); ignorada.` };
  }
  return { data };
}
