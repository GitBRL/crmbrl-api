import { isIP } from 'node:net';
import { ehEnderecoInterno } from '../webhooks/saida/protecao-ssrf';

/**
 * Hosts que podem receber o token do gestor e as credenciais dos vendedores (R34.1, anti-SSRF e anti-captura):
 * o 3C+ (`3c.plus`) e o domínio da Fluxo (`3c.fluxoti.com`), com seus subdomínios. Outros hosts entram pela
 * variável `TRESC_PLUS_HOSTS_PERMITIDOS` (separados por vírgula; `*.dominio` libera os subdomínios).
 */
export const HOSTS_PADRAO_TRESC_PLUS: readonly string[] = [
  '3c.plus',
  '*.3c.plus',
  '3c.fluxoti.com',
  '*.3c.fluxoti.com',
];

export interface RegraDeHostsTrescPlus {
  /** `NODE_ENV=production`: os hosts padrão só aceitam `https`/`wss`. */
  readonly producao: boolean;
  /** Hosts acrescentados pelo operador (`TRESC_PLUS_HOSTS_PERMITIDOS`). */
  readonly extras: readonly string[];
}

/** Um item da lista (`dominio`, `*.dominio` ou IP) em forma canônica; `null` se for inválido. */
export function normalizarHostPermitido(item: string): string | null {
  const texto = item.trim().toLowerCase().replace(/\.$/, '');
  if (!texto) return null;
  const curinga = texto.startsWith('*.');
  const base = curinga ? texto.slice(2) : texto;
  if (isIP(base)) return curinga ? null : base;
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
      base,
    )
  )
    return null;
  return texto;
}

function combina(padrao: string, host: string): boolean {
  if (padrao.startsWith('*.')) return host.endsWith(padrao.slice(1));
  return padrao === host;
}

/**
 * Confere uma URL antes de guardá-la ou de usá-la. Devolve o motivo (em português) quando for recusada,
 * ou `null` quando está tudo certo. Hosts padrão: só https em produção e nunca IP; hosts acrescentados
 * pelo operador valem como ele os escreveu (inclusive IP e http, para o 3C+ simulado do desenvolvimento).
 */
export function motivoDaUrlRecusada(
  valor: string,
  protocolos: readonly string[],
  regra: RegraDeHostsTrescPlus,
): string | null {
  if (!URL.canParse(valor)) return 'endereço inválido';
  const url = new URL(valor);
  if (!protocolos.includes(url.protocol)) return 'endereço inválido';
  if (url.username || url.password)
    return 'o endereço não pode ter usuário e senha';
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const extra = regra.extras.some((padrao) => combina(padrao, host));
  const padrao = HOSTS_PADRAO_TRESC_PLUS.some((p) => combina(p, host));
  if (isIP(host) && !extra) {
    return ehEnderecoInterno(host)
      ? 'o endereço aponta para a rede interna'
      : 'use o nome do servidor do 3C+, não um endereço IP';
  }
  if (!padrao && !extra) {
    return `o servidor ${host} não está entre os permitidos para o 3C+ (peça ao responsável pela instalação para incluí-lo em TRESC_PLUS_HOSTS_PERMITIDOS)`;
  }
  const seguro = url.protocol === 'https:' || url.protocol === 'wss:';
  if (regra.producao && !seguro && !extra) return 'use https em produção';
  return null;
}

/** O host (sem porta) da URL, em minúsculas. */
export function hostDaUrl(valor: string): string | null {
  return URL.canParse(valor)
    ? new URL(valor).hostname.toLowerCase().replace(/\.$/, '')
    : null;
}
