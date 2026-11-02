/**
 * Conexões do canal de e-mail: IMAP (`imapflow`) para ler e SMTP
 * (`nodemailer`) para responder, com prazos curtos e erros traduzidos para a
 * tela (sem repetir senha nem detalhe técnico desnecessário).
 */
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import type { ConfiguracaoEmail } from './configuracao-email';

export type TransporteSmtp = ReturnType<typeof createTransport>;

/** Prazos das conexões (ms). */
const PRAZOS = {
  conexao: 15_000,
  saudacao: 10_000,
  socket: 60_000,
} as const;

/** Cliente IMAP do canal (sem log; IDLE automático desligado: a leitura é por varredura). */
export function criarClienteImap(
  config: ConfiguracaoEmail,
  senha: string,
): ImapFlow {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.porta,
    secure: config.imap.tls,
    auth: { user: config.imap.usuario, pass: senha },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: PRAZOS.conexao,
    greetingTimeout: PRAZOS.saudacao,
    socketTimeout: PRAZOS.socket,
    tls: { rejectUnauthorized: !config.ignorarCertificado },
    clientInfo: { name: 'BRL CRM' },
  });
}

/** Transporte SMTP do canal. */
export function criarTransporteSmtp(
  config: ConfiguracaoEmail,
  senha: string | undefined,
): TransporteSmtp {
  const { smtp } = config;
  return createTransport({
    host: smtp.host,
    port: smtp.porta,
    secure: smtp.seguranca === 'TLS',
    requireTLS: smtp.seguranca === 'STARTTLS',
    ignoreTLS: smtp.seguranca === 'NENHUMA',
    auth: senha ? { user: smtp.usuario, pass: senha } : undefined,
    connectionTimeout: PRAZOS.conexao,
    greetingTimeout: PRAZOS.saudacao,
    socketTimeout: PRAZOS.socket,
    tls: { rejectUnauthorized: !config.ignorarCertificado },
  });
}

/** Um erro de IMAP/SMTP em português, e se tentar de novo adianta. */
export interface ErroDeEmail {
  mensagem: string;
  /** Tentar de novo sem mudar a configuração não resolve (senha errada, destinatário recusado…). */
  definitivo: boolean;
}

interface ErroTecnico {
  code?: string;
  responseCode?: number;
  authenticationFailed?: boolean;
  response?: string;
  message?: string;
  serverResponseCode?: string;
}

const CERTIFICADO = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Traduz o erro do `imapflow`/`nodemailer`. */
export function traduzirErroDeEmail(
  erro: unknown,
  servico: 'IMAP' | 'SMTP',
): ErroDeEmail {
  const tecnico = (erro ?? {}) as ErroTecnico;
  const codigo = tecnico.code ?? '';
  if (
    tecnico.authenticationFailed ||
    codigo === 'EAUTH' ||
    tecnico.serverResponseCode === 'AUTHENTICATIONFAILED'
  ) {
    return {
      mensagem: `O servidor ${servico} recusou o usuário ou a senha do canal.`,
      definitivo: true,
    };
  }
  if (CERTIFICADO.has(codigo)) {
    return {
      mensagem: `O certificado TLS do servidor ${servico} não é válido (${codigo}). Corrija o servidor ou marque "ignorar certificado" se ele for interno.`,
      definitivo: true,
    };
  }
  if (codigo === 'ENOTFOUND' || codigo === 'EDNS') {
    return {
      mensagem: `O endereço do servidor ${servico} não foi encontrado. Confira o host.`,
      definitivo: false,
    };
  }
  if (codigo === 'ECONNREFUSED') {
    return {
      mensagem: `O servidor ${servico} recusou a conexão. Confira o host, a porta e a segurança (TLS).`,
      definitivo: false,
    };
  }
  if (
    [
      'ETIMEDOUT',
      'ETIMEOUT',
      'ECONNRESET',
      'ESOCKET',
      'ECONNECTION',
      'NoConnection',
    ].includes(codigo)
  ) {
    return {
      mensagem: `Não foi possível falar com o servidor ${servico} (${codigo}). Tente de novo em instantes.`,
      definitivo: false,
    };
  }
  if (
    codigo === 'EENVELOPE' ||
    (tecnico.responseCode && tecnico.responseCode >= 500)
  ) {
    const resposta = (tecnico.response ?? tecnico.message ?? '').slice(0, 200);
    return {
      mensagem: `O servidor ${servico} recusou o e-mail${resposta ? `: ${resposta}` : '.'}`,
      definitivo: true,
    };
  }
  if (tecnico.responseCode && tecnico.responseCode >= 400) {
    return {
      mensagem: `O servidor ${servico} pediu para tentar mais tarde (${tecnico.responseCode}).`,
      definitivo: false,
    };
  }
  return {
    mensagem: `Falha no servidor ${servico}: ${(tecnico.message ?? String(erro)).slice(0, 200)}`,
    definitivo: false,
  };
}

/** Resultado do teste de um dos lados. */
export interface ResultadoDoTeste {
  ok: boolean;
  mensagem: string;
}

/** Conecta, autentica e abre a pasta (sem ler nada). */
export async function testarImap(
  config: ConfiguracaoEmail,
  senha: string,
): Promise<ResultadoDoTeste> {
  const cliente = criarClienteImap(config, senha);
  cliente.on('error', () => undefined);
  try {
    await cliente.connect();
    const caixa = await cliente.mailboxOpen(config.imap.pasta, {
      readOnly: true,
    });
    return {
      ok: true,
      mensagem: `Conectado. A pasta ${config.imap.pasta} tem ${caixa.exists} mensagem(ns); só as que chegarem a partir de agora entram no Atendimento.`,
    };
  } catch (erro) {
    const tecnico = erro as ErroTecnico;
    if (
      tecnico.serverResponseCode === 'NONEXISTENT' ||
      /mailbox|pasta|nonexistent/i.test(tecnico.response ?? '')
    ) {
      return {
        ok: false,
        mensagem: `A pasta "${config.imap.pasta}" não existe nesta caixa.`,
      };
    }
    return { ok: false, mensagem: traduzirErroDeEmail(erro, 'IMAP').mensagem };
  } finally {
    await cliente.logout().catch(() => cliente.close());
  }
}

/** Conecta e autentica no SMTP (sem enviar nada). */
export async function testarSmtp(
  config: ConfiguracaoEmail,
  senha: string | undefined,
): Promise<ResultadoDoTeste> {
  const transporte = criarTransporteSmtp(config, senha);
  try {
    await transporte.verify();
    return {
      ok: true,
      mensagem: 'Conectado: o envio das respostas está pronto.',
    };
  } catch (erro) {
    return { ok: false, mensagem: traduzirErroDeEmail(erro, 'SMTP').mensagem };
  } finally {
    transporte.close();
  }
}
