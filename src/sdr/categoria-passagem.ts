/**
 * Categoria da passagem de uma conversa para a equipe (R31.22): agrupa os motivos
 * (texto livre) das decisões `PASSOU_HUMANO`, `BLOQUEIO` e `FALHA` para o BI.
 * Função pura; a categoria é gravada junto com a decisão.
 */
import type { AcaoSdr, TipoDecisaoSdr } from '../generated/prisma/client';

export const CATEGORIAS_DE_PASSAGEM = {
  pedido_humano: 'O lead pediu uma pessoa',
  assunto_sensivel: 'Assunto sensível ou fora do escopo',
  baixa_confianca: 'A IA sem confiança',
  reclamacao: 'Reclamação ou insatisfação',
  sem_avanco: 'Muitas mensagens sem avanço',
  limite_conversa: 'Limite de mensagens ou tokens da conversa',
  orcamento: 'Orçamento mensal de tokens esgotado',
  janela_24h: 'Fora da janela de resposta do canal (24 h)',
  opt_out: 'Contato com opt-out',
  canal_ou_ia_indisponivel: 'Canal desativado, SDR desligado ou IA sem chave',
  fluxo: 'Fluxo automático passou para a equipe',
  falha_da_ia: 'Falha da IA',
  outro: 'Outro motivo',
} as const;

export type CategoriaDePassagem = keyof typeof CATEGORIAS_DE_PASSAGEM;

const TIPOS_DE_PASSAGEM: ReadonlySet<TipoDecisaoSdr> = new Set([
  'PASSOU_HUMANO',
  'BLOQUEIO',
  'FALHA',
]);

function semAcento(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR');
}

/**
 * `null` quando a decisão não é uma passagem para a equipe (só as de ação
 * `PASSAR_HUMANO` contam: as tentativas que falharam e o registro de tokens não).
 */
export function categoriaDaPassagem(
  tipo: TipoDecisaoSdr,
  acao: AcaoSdr | null | undefined,
  motivo: string | null | undefined,
  titulo?: string | null,
): CategoriaDePassagem | null {
  if (!TIPOS_DE_PASSAGEM.has(tipo) || acao !== 'PASSAR_HUMANO') {
    return null;
  }
  const t = semAcento(`${motivo ?? ''} ${titulo ?? ''}`);
  if (t.includes('orcamento mensal')) return 'orcamento';
  if (t.includes('sem avanco')) return 'sem_avanco';
  if (t.includes('limite') && (t.includes('token') || t.includes('mensagens')))
    return 'limite_conversa';
  if (t.includes('opt-out')) return 'opt_out';
  if (t.includes('janela')) return 'janela_24h';
  if (t.includes('fluxo automatico')) return 'fluxo';
  if (
    t.includes('desligado neste canal') ||
    t.includes('canal desta conversa') ||
    t.includes('canal esta desativado') ||
    t.includes('nao esta configurada')
  )
    return 'canal_ou_ia_indisponivel';
  if (tipo === 'FALHA') return 'falha_da_ia';
  if (/(humano|atendente|pessoa|vendedor|alguem)/.test(t))
    return 'pedido_humano';
  if (/(reclam|insatisf|absurdo)/.test(t)) return 'reclamacao';
  if (/(sensivel|escopo|juridic|saude|excecao)/.test(t))
    return 'assunto_sensivel';
  if (t.includes('confian')) return 'baixa_confianca';
  return 'outro';
}
