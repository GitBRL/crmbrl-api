/**
 * Chamadas OAuth do Typeform (R32.25) e do RD Station Marketing (R32.26), por `fetch` com tempo
 * limite, sem seguir redirecionamentos e com a leitura da resposta limitada (`chamarAplicativo`).
 * Os caminhos e os formatos são os reais (pesquisa em `login-facilitado.md`); nos testes e no
 * ambiente dos agentes só a base muda (`TYPEFORM_*`, `RD_STATION_*`). Nenhum token ou segredo
 * entra em mensagem de erro.
 */
import { chamarAplicativo } from '../aplicativos/chamadas-http';
import { ehObjeto } from '../aplicativos/comum';
import {
  CredencialRecusadaError,
  FalhaNoAplicativoError,
} from '../aplicativos/tipos';

/** Os serviços com conexão por login (o app `META` é do Facebook, R32.24). */
export type AplicativoDeConexao = 'TYPEFORM' | 'RD_STATION';

/** Escopos pedidos ao Typeform (R32.25). */
export const ESCOPOS_DO_TYPEFORM = [
  'accounts:read',
  'forms:read',
  'webhooks:read',
  'webhooks:write',
  'offline',
] as const;

export const NOME_DO_SERVICO: Readonly<Record<AplicativoDeConexao, string>> = {
  TYPEFORM: 'Typeform',
  RD_STATION: 'RD Station',
};

export interface BasesDoOAuth {
  readonly typeformDialogoUrl: string;
  readonly typeformApiUrl: string;
  readonly rdStationDialogoUrl: string;
  readonly rdStationApiUrl: string;
}

export interface AppDoServico {
  readonly clientId: string;
  readonly segredo: string;
}

export interface TokensRecebidos {
  readonly access: string;
  readonly refresh: string | null;
  readonly expiraEmSegundos: number | null;
}

/** O endereço do diálogo do serviço, aberto no navegador do Admin. */
export function urlDoDialogo(
  aplicativo: AplicativoDeConexao,
  bases: BasesDoOAuth,
  dados: { clientId: string; redirectUri: string; state: string },
): string {
  if (aplicativo === 'TYPEFORM') {
    const parametros = new URLSearchParams({
      client_id: dados.clientId,
      redirect_uri: dados.redirectUri,
      scope: ESCOPOS_DO_TYPEFORM.join(' '),
      state: dados.state,
    });
    // Espaço como %20 (o Typeform documenta os escopos assim).
    return `${bases.typeformDialogoUrl}/oauth/authorize?${parametros.toString().replace(/\+/g, '%20')}`;
  }
  const parametros = new URLSearchParams({
    client_id: dados.clientId,
    redirect_uri: dados.redirectUri,
    state: dados.state,
  });
  return `${bases.rdStationDialogoUrl}/auth/dialog?${parametros.toString()}`;
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;
}

/** A resposta de token (`{access_token, refresh_token, expires_in}`) → `TokensRecebidos`. */
function lerTokens(dados: unknown, servico: string): TokensRecebidos {
  const resposta = ehObjeto(dados) ? dados : {};
  const access = texto(resposta.access_token);
  if (!access) {
    throw new FalhaNoAplicativoError(
      `O ${servico} não devolveu o token de acesso.`,
    );
  }
  const expira = Number(resposta.expires_in);
  return {
    access,
    refresh: texto(resposta.refresh_token),
    expiraEmSegundos: Number.isFinite(expira) && expira > 0 ? expira : null,
  };
}

/**
 * Uma chamada ao endpoint de token: o serviço respondeu 4xx (código usado, vencido, refresh
 * invalidado, app errado) → credencial recusada; falha de rede, tempo esgotado e 5xx seguem como
 * falha passageira (quem chama decide se tenta de novo).
 */
async function chamarToken(
  aplicativo: AplicativoDeConexao,
  pedido: Parameters<typeof chamarAplicativo>[0],
): Promise<TokensRecebidos> {
  const servico = NOME_DO_SERVICO[aplicativo];
  try {
    const { dados } = await chamarAplicativo(pedido);
    return lerTokens(dados, servico);
  } catch (erro) {
    if (
      erro instanceof FalhaNoAplicativoError &&
      erro.status !== null &&
      erro.status >= 400 &&
      erro.status < 500 &&
      erro.status !== 408 &&
      erro.status !== 429
    ) {
      throw new CredencialRecusadaError(
        `O ${servico} recusou o pedido de token (HTTP ${erro.status}).`,
      );
    }
    throw erro;
  }
}

export function trocarCodigo(
  aplicativo: AplicativoDeConexao,
  bases: BasesDoOAuth,
  buscar: typeof fetch,
  app: AppDoServico,
  redirectUri: string,
  codigo: string,
): Promise<TokensRecebidos> {
  if (aplicativo === 'TYPEFORM') {
    return chamarToken(aplicativo, {
      buscar,
      url: `${bases.typeformApiUrl}/oauth/token`,
      metodo: 'POST',
      cabecalhos: {},
      corpoFormulario: {
        grant_type: 'authorization_code',
        code: codigo,
        client_id: app.clientId,
        client_secret: app.segredo,
        redirect_uri: redirectUri,
      },
      aplicativo: 'Typeform',
    });
  }
  return chamarToken(aplicativo, {
    buscar,
    url: `${bases.rdStationApiUrl}/auth/token?token_by=code`,
    metodo: 'POST',
    cabecalhos: {},
    corpo: {
      client_id: app.clientId,
      client_secret: app.segredo,
      code: codigo,
    },
    aplicativo: 'RD Station',
  });
}

export function renovarToken(
  aplicativo: AplicativoDeConexao,
  bases: BasesDoOAuth,
  buscar: typeof fetch,
  app: AppDoServico,
  refresh: string,
): Promise<TokensRecebidos> {
  if (aplicativo === 'TYPEFORM') {
    return chamarToken(aplicativo, {
      buscar,
      url: `${bases.typeformApiUrl}/oauth/token`,
      metodo: 'POST',
      cabecalhos: {},
      corpoFormulario: {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: app.clientId,
        client_secret: app.segredo,
      },
      aplicativo: 'Typeform',
    });
  }
  return chamarToken(aplicativo, {
    buscar,
    url: `${bases.rdStationApiUrl}/auth/token`,
    metodo: 'POST',
    cabecalhos: {},
    corpo: {
      client_id: app.clientId,
      client_secret: app.segredo,
      refresh_token: refresh,
    },
    aplicativo: 'RD Station',
  });
}

/** O nome da conta (e-mail ou apelido no Typeform, nome da conta no RD), ou `null` se o serviço não disser. Nunca lança. */
export async function nomeDaConta(
  aplicativo: AplicativoDeConexao,
  bases: BasesDoOAuth,
  buscar: typeof fetch,
  acesso: string,
): Promise<string | null> {
  try {
    const { dados } = await chamarAplicativo({
      buscar,
      url:
        aplicativo === 'TYPEFORM'
          ? `${bases.typeformApiUrl}/me`
          : `${bases.rdStationApiUrl}/marketing/account_info`,
      cabecalhos: { Authorization: `Bearer ${acesso}` },
      aplicativo: NOME_DO_SERVICO[aplicativo],
    });
    const conta = ehObjeto(dados) ? dados : {};
    const nome =
      aplicativo === 'TYPEFORM'
        ? (texto(conta.email) ?? texto(conta.alias))
        : texto(conta.name);
    return nome ? nome.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Revoga o acesso no RD Station (`POST /auth/revoke`); o Typeform não tem endpoint. Nunca lança. */
export async function revogarNoRdStation(
  bases: BasesDoOAuth,
  buscar: typeof fetch,
  tokens: { access: string; refresh: string | null },
): Promise<void> {
  try {
    await chamarAplicativo({
      buscar,
      url: `${bases.rdStationApiUrl}/auth/revoke`,
      metodo: 'POST',
      cabecalhos: { Authorization: `Bearer ${tokens.access}` },
      corpoFormulario: {
        token: tokens.refresh ?? tokens.access,
        token_type_hint: tokens.refresh ? 'refresh_token' : 'access_token',
      },
      aplicativo: 'RD Station',
      aceitar: [400, 404],
    });
  } catch {
    // Melhor esforço: o acesso some do CRM de qualquer forma.
  }
}
