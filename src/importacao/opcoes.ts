/**
 * Opções da importação guardadas em `Importacao.opcoes` (Json) e em
 * `ImportacaoModelo.opcoes`: filtro, negócio para todos e DDI. Leitura
 * defensiva: registros antigos têm `{}` e valores soltos são ignorados.
 */
import { DDI_PADRAO, PADRAO_DDI } from './ddi';
import {
  type FiltroDaPlanilha,
  MAXIMO_DE_REGRAS_DO_FILTRO,
  OPERADORES_DO_FILTRO,
  type OperadorFiltro,
} from './filtro-de-linhas';

export interface NegocioParaTodos {
  funilId: string;
  etapaId: string;
  titulo?: string | null;
  valor?: string | null;
}

export interface OpcoesDaImportacao {
  filtro: FiltroDaPlanilha | null;
  negocio: NegocioParaTodos | null;
  ddiPadrao: string;
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

export function lerFiltro(bruto: unknown): FiltroDaPlanilha | null {
  if (!bruto || typeof bruto !== 'object') {
    return null;
  }
  const f = bruto as { combinacao?: unknown; regras?: unknown };
  if (!Array.isArray(f.regras)) {
    return null;
  }
  const regras = f.regras
    .filter(
      (r): r is { coluna: string; operador: OperadorFiltro; valor?: unknown } =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as { coluna?: unknown }).coluna === 'string' &&
        (OPERADORES_DO_FILTRO as readonly unknown[]).includes(
          (r as { operador?: unknown }).operador,
        ),
    )
    .slice(0, MAXIMO_DE_REGRAS_DO_FILTRO)
    .map((r) => ({
      coluna: r.coluna,
      operador: r.operador,
      valor: typeof r.valor === 'string' ? r.valor : null,
    }));
  return regras.length === 0
    ? null
    : {
        combinacao: f.combinacao === 'QUALQUER' ? 'QUALQUER' : 'TODAS',
        regras,
      };
}

export function lerNegocio(bruto: unknown): NegocioParaTodos | null {
  if (!bruto || typeof bruto !== 'object') {
    return null;
  }
  const n = bruto as Record<string, unknown>;
  const funilId = texto(n.funilId);
  const etapaId = texto(n.etapaId);
  if (!funilId || !etapaId) {
    return null;
  }
  return {
    funilId,
    etapaId,
    titulo: texto(n.titulo),
    valor: texto(n.valor),
  };
}

export function lerOpcoes(bruto: unknown): OpcoesDaImportacao {
  const o =
    bruto && typeof bruto === 'object'
      ? (bruto as Record<string, unknown>)
      : {};
  return {
    filtro: lerFiltro(o.filtro),
    negocio: lerNegocio(o.negocio),
    ddiPadrao:
      typeof o.ddiPadrao === 'string' && PADRAO_DDI.test(o.ddiPadrao)
        ? o.ddiPadrao
        : DDI_PADRAO,
  };
}
