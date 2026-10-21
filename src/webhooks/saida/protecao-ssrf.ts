/**
 * Proteção contra SSRF dos webhooks de saída (R9.1): o destino precisa ser
 * http(s), sem usuário e senha na URL, HTTPS em produção, e nenhum endereço
 * para o qual o nome resolve pode ser de rede interna ou localhost — salvo com
 * `WEBHOOKS_PERMITIR_REDE_INTERNA=true` (sistemas internos, como o TicketHub).
 *
 * A conferência roda ao cadastrar o destino e **de novo antes de cada envio**
 * (o DNS pode mudar depois do cadastro). Só `node:net` e `node:dns`.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { PRAZO_DO_DNS_MS } from '../webhooks.constantes';

/** Resolve um nome para os endereços IP (todas as famílias). */
export type Resolvedor = (nome: string) => Promise<string[]>;

export const resolverPeloSistema: Resolvedor = async (nome) => {
  const enderecos = await lookup(nome, { all: true, verbatim: true });
  return enderecos.map(({ address }) => address);
};

/**
 * Redes que não são destino público: privadas, loopback, link-local (inclui
 * o endereço de metadados das nuvens, 169.254.169.254), CGNAT, documentação,
 * multicast e reservadas. Endereços IPv6 que embutem um IPv4
 * (`::ffff:127.0.0.1`) são conferidos pelas regras de IPv4.
 */
const REDES_INTERNAS = criarRedesInternas();

function criarRedesInternas(): BlockList {
  const lista = new BlockList();
  const ipv4: readonly [string, number][] = [
    ['0.0.0.0', 8], // "esta" rede
    ['10.0.0.0', 8], // privada
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local (metadados de nuvem)
    ['172.16.0.0', 12], // privada (inclui as redes do Docker)
    ['192.0.0.0', 24], // atribuições do IETF
    ['192.0.2.0', 24], // documentação
    ['192.88.99.0', 24], // relay 6to4
    ['192.168.0.0', 16], // privada
    ['198.18.0.0', 15], // testes de desempenho
    ['198.51.100.0', 24], // documentação
    ['203.0.113.0', 24], // documentação
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reservada e broadcast
  ];
  for (const [rede, prefixo] of ipv4) {
    lista.addSubnet(rede, prefixo, 'ipv4');
  }
  const ipv6: readonly [string, number][] = [
    ['::', 96], // não especificado, loopback e IPv4 compatível (obsoleto)
    ['64:ff9b:1::', 48], // NAT64 de uso local
    ['100::', 64], // descarte
    ['2001::', 32], // Teredo
    ['2001:db8::', 32], // documentação
    ['2002::', 16], // 6to4
    ['fc00::', 7], // ULA (privada)
    ['fe80::', 10], // link-local
    ['fec0::', 10], // site-local (obsoleta)
    ['ff00::', 8], // multicast
  ];
  for (const [rede, prefixo] of ipv6) {
    lista.addSubnet(rede, prefixo, 'ipv6');
  }
  return lista;
}

/** O endereço IP é de rede interna, localhost ou reservado? (Texto que não é IP conta como interno.) */
export function ehEnderecoInterno(endereco: string): boolean {
  const ip = endereco.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const familia = isIP(ip);
  if (familia === 4) {
    return REDES_INTERNAS.check(ip, 'ipv4');
  }
  if (familia === 6) {
    if (REDES_INTERNAS.check(ip, 'ipv6')) {
      return true;
    }
    // NAT64 (64:ff9b::/96): o IPv4 de destino vai nos últimos 32 bits.
    const embutido = ipv4DoNat64(ip);
    return embutido !== null && REDES_INTERNAS.check(embutido, 'ipv4');
  }
  return true;
}

function ipv4DoNat64(ip: string): string | null {
  const partes = expandirIpv6(ip);
  if (
    !partes ||
    partes[0] !== 0x64 ||
    partes[1] !== 0xff9b ||
    partes.slice(2, 6).some((parte) => parte !== 0)
  ) {
    return null;
  }
  return [
    partes[6] >> 8,
    partes[6] & 0xff,
    partes[7] >> 8,
    partes[7] & 0xff,
  ].join('.');
}

/** `64:ff9b::7f00:1` → oito grupos de 16 bits (aceita o IPv4 no fim, `::ffff:1.2.3.4`). */
export function expandirIpv6(ip: string): number[] | null {
  let texto = ip.toLowerCase();
  const ipv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(texto);
  if (ipv4) {
    const bytes = ipv4[1].split('.').map(Number);
    if (bytes.some((byte) => byte > 255)) {
      return null;
    }
    texto = `${texto.slice(0, ipv4.index)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [esquerda, direita, ...resto] = texto.split('::');
  if (resto.length > 0) {
    return null;
  }
  const grupos = (parte: string | undefined) =>
    parte ? parte.split(':').map((grupo) => Number.parseInt(grupo, 16)) : [];
  const inicio = grupos(esquerda);
  const fim = grupos(direita);
  const faltando = 8 - inicio.length - fim.length;
  if (direita === undefined ? faltando !== 0 : faltando < 1) {
    return null;
  }
  const partes = [...inicio, ...Array<number>(faltando).fill(0), ...fim];
  return partes.every(
    (parte) => Number.isInteger(parte) && parte >= 0 && parte <= 0xffff,
  )
    ? partes
    : null;
}

export interface OpcoesDoDestino {
  /** `NODE_ENV=production`: exige HTTPS (R9.1). */
  readonly producao: boolean;
  /** `WEBHOOKS_PERMITIR_REDE_INTERNA` (R9.1). */
  readonly permitirRedeInterna: boolean;
  readonly resolver?: Resolvedor;
  readonly prazoDoDnsMs?: number;
}

/** Por que o destino foi recusado. */
export type MotivoDaRecusa =
  /** Não é URL, protocolo diferente de http(s), usuário/senha na URL. */
  | 'formato'
  /** HTTP em produção (R9.1). */
  | 'https_obrigatorio'
  /** Rede interna ou localhost sem a liberação (R9.1). */
  | 'rede_interna'
  /** O nome não resolveu. */
  | 'dns';

export type DestinoVerificado =
  | {
      readonly permitido: true;
      readonly url: URL;
      /** Endereços para os quais o nome resolveu. */
      readonly enderecos: readonly string[];
    }
  | {
      readonly permitido: false;
      readonly motivo: MotivoDaRecusa;
      /** Mensagem em português, pronta para mostrar. */
      readonly mensagem: string;
    };

/**
 * Confere se a URL pode ser destino de webhook (R9.1). Resolve o nome no DNS
 * e recusa se **qualquer** endereço for interno (um nome com um endereço
 * público e outro interno é recusado inteiro).
 *
 * Em produção, `http://` só passa para destinos internos liberados por
 * `WEBHOOKS_PERMITIR_REDE_INTERNA` (rede do Docker, sem TLS); para os demais, HTTPS.
 */
export async function verificarDestino(
  texto: string,
  opcoes: OpcoesDoDestino,
): Promise<DestinoVerificado> {
  const recusa = (motivo: MotivoDaRecusa, mensagem: string) =>
    ({ permitido: false, motivo, mensagem }) as const;

  if (!URL.canParse(texto)) {
    return recusa('formato', 'O endereço não é uma URL válida.');
  }
  const url = new URL(texto);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return recusa('formato', 'Use um endereço http:// ou https://.');
  }
  if (url.username || url.password) {
    return recusa(
      'formato',
      'Não coloque usuário e senha na URL: use os cabeçalhos extras (ex.: Authorization).',
    );
  }
  const nome = url.hostname.replace(/^\[|\]$/g, '');
  if (!nome) {
    return recusa('formato', 'O endereço não tem o nome do servidor.');
  }
  if (
    opcoes.producao &&
    url.protocol === 'http:' &&
    !opcoes.permitirRedeInterna
  ) {
    return recusa(
      'https_obrigatorio',
      'Em produção o destino precisa ser HTTPS (R9.1).',
    );
  }

  let enderecos: string[];
  if (isIP(nome)) {
    enderecos = [nome];
  } else if (nome === 'localhost' || nome.endsWith('.localhost')) {
    enderecos = ['127.0.0.1'];
  } else {
    try {
      enderecos = await comPrazo(
        (opcoes.resolver ?? resolverPeloSistema)(nome),
        opcoes.prazoDoDnsMs ?? PRAZO_DO_DNS_MS,
      );
    } catch {
      enderecos = [];
    }
    if (enderecos.length === 0) {
      return recusa(
        'dns',
        `Não foi possível encontrar o servidor "${nome}" (DNS).`,
      );
    }
  }

  const internos = enderecos.filter(ehEnderecoInterno);
  if (internos.length > 0 && !opcoes.permitirRedeInterna) {
    return recusa(
      'rede_interna',
      `O destino aponta para rede interna ou localhost (${internos.join(', ')}): recusado para proteger a rede (R9.1). ` +
        'Para sistemas internos, ligue WEBHOOKS_PERMITIR_REDE_INTERNA.',
    );
  }
  if (
    opcoes.producao &&
    url.protocol === 'http:' &&
    internos.length !== enderecos.length
  ) {
    return recusa(
      'https_obrigatorio',
      'Em produção o destino precisa ser HTTPS (R9.1); http:// só vale para sistemas da rede interna.',
    );
  }
  return { permitido: true, url, enderecos };
}

function comPrazo<T>(promessa: Promise<T>, prazoMs: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_resolver, rejeitar) => {
    temporizador = setTimeout(
      () => rejeitar(new Error('Tempo esgotado ao consultar o DNS.')),
      prazoMs,
    );
    temporizador.unref();
  });
  return Promise.race([promessa, limite]).finally(() =>
    clearTimeout(temporizador),
  );
}
