/**
 * Configuração do canal de e-mail (R14), gravada em `canais.configuracao`
 * (sem senhas — elas vão cifradas em `segredos_cifrados`) e o estado da
 * leitura em `canais.estado`. Funções puras.
 */

/** Segurança da conexão SMTP. */
export type SegurancaSmtp = 'TLS' | 'STARTTLS' | 'NENHUMA';
export const SEGURANCAS_SMTP: readonly SegurancaSmtp[] = [
  'TLS',
  'STARTTLS',
  'NENHUMA',
];

export interface ConfiguracaoImap {
  host: string;
  porta: number;
  /** TLS desde a conexão (IMAPS, porta 993). Sem, conexão aberta (com STARTTLS se o servidor oferecer). */
  tls: boolean;
  usuario: string;
  /** Pasta lida (padrão `INBOX`). */
  pasta: string;
}

export interface ConfiguracaoSmtp {
  host: string;
  porta: number;
  seguranca: SegurancaSmtp;
  usuario: string;
}

export interface ConfiguracaoEmail {
  /** Endereço da caixa (o `idExterno` do canal): remetente das respostas. */
  endereco: string;
  /** Nome no "De:" das respostas (ex.: "Atendimento BRL"). */
  nomeRemetente: string | null;
  imap: ConfiguracaoImap;
  smtp: ConfiguracaoSmtp;
  /** Aceita certificado TLS inválido/autoassinado (só para servidores internos). */
  ignorarCertificado: boolean;
  /** Assinatura acrescentada às respostas (texto). */
  assinatura: string | null;
}

/** Senhas do canal, cifradas em `segredos_cifrados`. */
export interface SegredosEmail {
  senhaImap: string;
  /** Sem ela, o SMTP usa a do IMAP (a mesma caixa, o caso comum). */
  senhaSmtp: string;
}

/** Onde a leitura parou (`canais.estado`). */
export interface EstadoEmail {
  /** UIDVALIDITY da pasta: se mudar, a caixa foi recriada e o cursor recomeça. */
  uidValidity?: string;
  /** Último UID importado. */
  ultimoUid?: number;
  /** Fim da última varredura com sucesso (ISO). */
  ultimaVarreduraEm?: string;
}

/** Porta padrão de cada serviço. */
export const PORTA_PADRAO = {
  imap: { tls: 993, aberta: 143 },
  smtp: { TLS: 465, STARTTLS: 587, NENHUMA: 25 },
} as const;

/** Lê a configuração gravada (tolerante: campos quebrados viram o padrão). */
export function lerConfiguracaoEmail(
  valor: unknown,
  endereco: string | null,
): ConfiguracaoEmail {
  const gravada = objeto(valor);
  const imap = objeto(gravada.imap);
  const smtp = objeto(gravada.smtp);
  const tls = imap.tls !== false;
  const seguranca = SEGURANCAS_SMTP.includes(smtp.seguranca as SegurancaSmtp)
    ? (smtp.seguranca as SegurancaSmtp)
    : 'TLS';
  const usuarioImap = texto(imap.usuario) ?? endereco ?? '';
  return {
    endereco: endereco ?? texto(gravada.endereco) ?? '',
    nomeRemetente: texto(gravada.nomeRemetente),
    imap: {
      host: texto(imap.host) ?? '',
      porta:
        porta(imap.porta) ??
        (tls ? PORTA_PADRAO.imap.tls : PORTA_PADRAO.imap.aberta),
      tls,
      usuario: usuarioImap,
      pasta: texto(imap.pasta) ?? 'INBOX',
    },
    smtp: {
      host: texto(smtp.host) ?? texto(imap.host) ?? '',
      porta: porta(smtp.porta) ?? PORTA_PADRAO.smtp[seguranca],
      seguranca,
      usuario: texto(smtp.usuario) ?? usuarioImap,
    },
    ignorarCertificado: gravada.ignorarCertificado === true,
    assinatura: texto(gravada.assinatura),
  };
}

/** Lê o estado da leitura gravado no canal. */
export function lerEstadoEmail(valor: unknown): EstadoEmail {
  const estado = objeto(valor);
  return {
    uidValidity: texto(estado.uidValidity) ?? undefined,
    ultimoUid:
      typeof estado.ultimoUid === 'number' && Number.isInteger(estado.ultimoUid)
        ? estado.ultimoUid
        : undefined,
    ultimaVarreduraEm: texto(estado.ultimaVarreduraEm) ?? undefined,
  };
}

/** A senha do SMTP (a do IMAP quando não há uma própria). */
export function senhaDoSmtp(
  segredos: Partial<SegredosEmail>,
): string | undefined {
  return segredos.senhaSmtp || segredos.senhaImap;
}

/** O domínio do endereço (para o Message-ID das respostas). */
export function dominioDoEndereco(endereco: string): string {
  const arroba = endereco.lastIndexOf('@');
  const dominio = arroba >= 0 ? endereco.slice(arroba + 1) : '';
  return /^[a-z0-9.-]+$/i.test(dominio)
    ? dominio.toLowerCase()
    : 'crmbrl.local';
}

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

function porta(valor: unknown): number | null {
  return typeof valor === 'number' &&
    Number.isInteger(valor) &&
    valor > 0 &&
    valor < 65536
    ? valor
    : null;
}
