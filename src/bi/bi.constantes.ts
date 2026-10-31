/**
 * Nomes e limites estáveis do BI (R20): código da regra, fuso dos agrupamentos,
 * período e cache.
 */
import { FUSO_HORARIO_PADRAO } from '../fila/fila.service';

/** Código da regra do BI (vai em `detalhes.regra`, nunca no texto). */
export const REGRA_BI = 'R20';

/** Fuso dos agrupamentos por dia e por hora (o mesmo das atividades e dos agendamentos). */
export const FUSO_DO_BI = FUSO_HORARIO_PADRAO;

export const DIA_MS = 24 * 60 * 60 * 1000;

/** Período padrão de um painel: os últimos 30 dias. */
export const PERIODO_PADRAO_DIAS = 30;

/** Período máximo de uma consulta (a série por dia tem no máximo isso de pontos). */
export const PERIODO_MAXIMO_DIAS = 366;

/** Cache curto por filtro e por pessoa: vence só por tempo. */
export const CACHE_BI_SEGUNDOS = 30;

/** Máximo de respostas guardadas no cache (as mais antigas saem primeiro). */
export const CACHE_BI_MAXIMO = 300;

/** Linhas devolvidas nas tabelas com "top N" (próximas renovações, campanhas). */
export const LIMITE_DE_LINHAS = 50;
