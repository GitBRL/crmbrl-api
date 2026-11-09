/**
 * Serviços de terceiros falsos dos testes do login facilitado (H4), em processo e em portas livres:
 * o Typeform (token com rotação do refresh, formulários e webhooks), o RD Station (token, webhooks e
 * campos) e a Graph da Meta (validação do app e o login do Facebook). Cada falso guarda os pedidos
 * (sem corpos de token) e deixa o teste programar as falhas.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PedidoFalso {
  metodo: string;
  caminho: string;
  autorizacao?: string;
  corpo?: Record<string, unknown>;
}

abstract class ServidorFalso {
  url = '';
  pedidos: PedidoFalso[] = [];
  protected servidor?: Server;

  async iniciar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (parte: Buffer) => partes.push(parte));
      req.on('end', () => {
        const bruto = Buffer.concat(partes).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://falso');
        let corpo: Record<string, unknown> | undefined;
        if (bruto) {
          try {
            corpo = req.headers['content-type']?.includes(
              'application/x-www-form-urlencoded',
            )
              ? Object.fromEntries(new URLSearchParams(bruto))
              : (JSON.parse(bruto) as Record<string, unknown>);
          } catch {
            corpo = undefined;
          }
        }
        this.pedidos.push({
          metodo: req.method ?? 'GET',
          caminho: `${url.pathname}${url.search}`,
          autorizacao: req.headers.authorization,
          corpo,
        });
        this.tratar(req, res, url, corpo ?? {});
      });
    });
    await new Promise<void>((resolver) =>
      this.servidor?.listen(0, '127.0.0.1', resolver),
    );
    this.url = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
  }

  async parar(): Promise<void> {
    this.servidor?.closeAllConnections();
    await new Promise<void>((resolver) =>
      this.servidor ? this.servidor.close(() => resolver()) : resolver(),
    );
  }

  protected abstract tratar(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    corpo: Record<string, unknown>,
  ): void;

  protected responder(
    res: ServerResponse,
    status: number,
    corpo?: unknown,
  ): void {
    if (corpo === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corpo));
  }

  /** Os pedidos de um método e caminho (o caminho pode ser um prefixo). */
  quais(metodo: string, caminho: string): PedidoFalso[] {
    return this.pedidos.filter(
      (p) => p.metodo === metodo && p.caminho.startsWith(caminho),
    );
  }
}

/** O app OAuth que o Typeform "conhece" (o mesmo cadastrado nos testes em Configurações). */
export const APP_TYPEFORM = {
  id: 'tf-client-id',
  segredo: 'tf-segredo-0123456789',
};
export const APP_RD = {
  id: '5a6b7c8d-1111-2222-3333-444455556666',
  segredo: 'rd-segredo-0123456789',
};

export class TypeformFalso extends ServidorFalso {
  /** Códigos de autorização ainda não usados: código → redirect_uri do diálogo. */
  private codigos = new Map<string, string>();
  acessos = new Set<string>();
  refreshes = new Set<string>();
  webhooks = new Map<string, Record<string, unknown>>();
  /** Segundos de validade devolvidos em `expires_in`. */
  expiraEm = 604800;
  /** O endpoint de token recusa a renovação (refresh revogado). */
  recusarRenovacao = false;
  /** A renovação do token (refresh) demora tanto para responder. */
  atrasoDaRenovacaoMs = 0;
  /** As chamadas de webhook respondem 503 (o Typeform fora do ar). */
  foraDoAr = false;
  private sequencia = 0;

  limpar(): void {
    this.pedidos = [];
    this.codigos.clear();
    this.acessos.clear();
    this.refreshes.clear();
    this.webhooks.clear();
    this.expiraEm = 604800;
    this.recusarRenovacao = false;
    this.atrasoDaRenovacaoMs = 0;
    this.foraDoAr = false;
  }

  /** O que o diálogo faz ao clicar em "Aceitar": um `code` de uso único para o `redirect_uri`. */
  novoCodigo(redirectUri: string): string {
    const codigo = `tf-code-${++this.sequencia}`;
    this.codigos.set(codigo, redirectUri);
    return codigo;
  }

  /** Todos os tokens de acesso passam a ser recusados (401), como se tivessem vencido. */
  invalidarAcessos(): void {
    this.acessos.clear();
  }

  private emitir() {
    const access = `tf-acesso-${++this.sequencia}`;
    const refresh = `tf-refresh-${++this.sequencia}`;
    this.acessos.add(access);
    this.refreshes.add(refresh);
    return {
      token_type: 'Bearer',
      access_token: access,
      expires_in: this.expiraEm,
      refresh_token: refresh,
    };
  }

  protected tratar(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    corpo: Record<string, unknown>,
  ): void {
    const metodo = req.method ?? 'GET';
    if (url.pathname === '/oauth/token' && metodo === 'POST') {
      if (
        corpo.client_id !== APP_TYPEFORM.id ||
        corpo.client_secret !== APP_TYPEFORM.segredo
      ) {
        return this.responder(res, 400, {
          code: 'invalid_client',
          description: 'client inválido',
        });
      }
      if (corpo.grant_type === 'authorization_code') {
        const codigo = String(corpo.code);
        const esperado = this.codigos.get(codigo);
        if (!esperado || esperado !== corpo.redirect_uri) {
          return this.responder(res, 400, {
            code: 'invalid_grant',
            description: 'code inválido',
          });
        }
        this.codigos.delete(codigo);
        return this.responder(res, 200, this.emitir());
      }
      if (corpo.grant_type === 'refresh_token') {
        const refresh = String(corpo.refresh_token);
        if (this.recusarRenovacao || !this.refreshes.has(refresh)) {
          return this.responder(res, 400, {
            code: 'invalid_grant',
            description: 'refresh inválido',
          });
        }
        // Rotação: o refresh anterior deixa de valer.
        this.refreshes.delete(refresh);
        const emitido = this.emitir();
        if (this.atrasoDaRenovacaoMs > 0) {
          setTimeout(
            () => this.responder(res, 200, emitido),
            this.atrasoDaRenovacaoMs,
          );
          return;
        }
        return this.responder(res, 200, emitido);
      }
      return this.responder(res, 400, { code: 'unsupported_grant_type' });
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.acessos.has(token)) {
      return this.responder(res, 401, {
        code: 'AUTHENTICATION_FAILED',
        description: 'token inválido',
      });
    }
    if (url.pathname === '/me') {
      return this.responder(res, 200, {
        alias: 'maria',
        email: 'maria@escola.com.br',
        language: 'pt',
      });
    }
    if (url.pathname === '/forms' && metodo === 'GET') {
      return this.responder(res, 200, {
        total_items: 1,
        items: [
          {
            id: 'abc123',
            title: 'Interesse em matrícula',
            last_updated_at: '2026-10-01T10:00:00Z',
            _links: { display: 'https://form.typeform.com/to/abc123' },
          },
        ],
      });
    }
    const formulario = /^\/forms\/([^/]+)$/.exec(url.pathname);
    if (formulario && metodo === 'GET') {
      return this.responder(res, 200, {
        id: formulario[1],
        fields: [
          { id: 'f1', ref: 'nome_completo', title: 'Nome', type: 'short_text' },
          { id: 'f2', ref: 'email_contato', title: 'E-mail', type: 'email' },
        ],
      });
    }
    const webhook = /^\/forms\/([^/]+)\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (webhook && this.foraDoAr) {
      return this.responder(res, 503, { code: 'UNAVAILABLE' });
    }
    if (webhook && metodo === 'PUT') {
      this.webhooks.set(`${webhook[1]}/${webhook[2]}`, corpo);
      return this.responder(res, 200, {
        id: 'wh-1',
        tag: webhook[2],
        form_id: webhook[1],
        ...corpo,
      });
    }
    if (webhook && metodo === 'DELETE') {
      const existia = this.webhooks.delete(`${webhook[1]}/${webhook[2]}`);
      return this.responder(res, existia ? 204 : 404);
    }
    return this.responder(res, 404, { code: 'NOT_FOUND' });
  }
}

export class RdStationFalso extends ServidorFalso {
  private codigos = new Map<string, string>();
  acessos = new Set<string>();
  refreshes = new Set<string>();
  /** uuid → corpo enviado na criação. */
  webhooks = new Map<string, Record<string, unknown>>();
  /** A criação do webhook é recusada com 401 (o RD não conseguiu testar o endereço do CRM). */
  recusarCriacao = false;
  recusarRenovacao = false;
  /** A criação demora tanto para responder (o RD testa o endereço antes de criar). */
  atrasoDaCriacaoMs = 0;
  /** Quantas das próximas criações criam o webhook mas perdem a resposta (a conexão cai). */
  perderRespostaDaCriacao = 0;
  /** As chamadas de webhook respondem 503 (o RD fora do ar). */
  foraDoAr = false;
  revogados: string[] = [];
  private sequencia = 0;

  limpar(): void {
    this.pedidos = [];
    this.codigos.clear();
    this.acessos.clear();
    this.refreshes.clear();
    this.webhooks.clear();
    this.recusarCriacao = false;
    this.recusarRenovacao = false;
    this.atrasoDaCriacaoMs = 0;
    this.perderRespostaDaCriacao = 0;
    this.foraDoAr = false;
    this.revogados = [];
  }

  novoCodigo(): string {
    const codigo = `rd-code-${++this.sequencia}`;
    this.codigos.set(codigo, 'valido');
    return codigo;
  }

  invalidarAcessos(): void {
    this.acessos.clear();
  }

  private emitir() {
    const access = `rd-acesso-${++this.sequencia}`;
    const refresh = `rd-refresh-${++this.sequencia}`;
    this.acessos.add(access);
    this.refreshes.add(refresh);
    return { access_token: access, expires_in: 86400, refresh_token: refresh };
  }

  protected tratar(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    corpo: Record<string, unknown>,
  ): void {
    const metodo = req.method ?? 'GET';
    if (url.pathname === '/auth/token' && metodo === 'POST') {
      if (
        corpo.client_id !== APP_RD.id ||
        corpo.client_secret !== APP_RD.segredo
      ) {
        return this.responder(res, 400, { error: 'invalid_client' });
      }
      if (url.searchParams.get('token_by') === 'code') {
        const codigo = String(corpo.code);
        if (!this.codigos.delete(codigo)) {
          return this.responder(res, 400, { error: 'EXPIRED_CODE_GRANT' });
        }
        return this.responder(res, 200, this.emitir());
      }
      const refresh = String(corpo.refresh_token);
      if (this.recusarRenovacao || !this.refreshes.has(refresh)) {
        return this.responder(res, 400, { error: 'invalid_grant' });
      }
      return this.responder(res, 200, this.emitir());
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.acessos.has(token)) {
      return this.responder(res, 401, { error: 'unauthorized' });
    }
    if (url.pathname === '/auth/revoke' && metodo === 'POST') {
      this.revogados.push(String(corpo.token_type_hint));
      return this.responder(res, 200, {});
    }
    if (url.pathname === '/marketing/account_info') {
      return this.responder(res, 200, { name: 'Escola Demo RD' });
    }
    if (url.pathname === '/platform/contacts/fields') {
      return this.responder(res, 200, {
        fields: [
          {
            uuid: 'u1',
            api_identifier: 'name',
            custom_field: false,
            data_type: 'STRING',
            presentation_type: 'TEXT_INPUT',
            label: { default: 'Name', 'pt-BR': 'Nome' },
          },
          {
            uuid: 'u2',
            api_identifier: 'company_name',
            custom_field: false,
            data_type: 'STRING',
            presentation_type: 'TEXT_INPUT',
            label: { default: 'Company' },
          },
          {
            uuid: 'u3',
            api_identifier: 'cf_serie_de_interesse',
            custom_field: true,
            data_type: 'STRING',
            presentation_type: 'COMBO_BOX',
            label: { default: 'Série de interesse' },
          },
        ],
      });
    }
    if (url.pathname.startsWith('/integrations/webhooks') && this.foraDoAr) {
      return this.responder(res, 503, { error: 'unavailable' });
    }
    if (url.pathname === '/integrations/webhooks' && metodo === 'POST') {
      if (this.recusarCriacao) {
        return this.responder(res, 401, { error: 'webhook_validation_failed' });
      }
      const criar = (): void => {
        const uuid = `rd-wh-${++this.sequencia}`;
        this.webhooks.set(uuid, corpo);
        if (this.perderRespostaDaCriacao > 0) {
          this.perderRespostaDaCriacao -= 1;
          res.destroy();
          return;
        }
        this.responder(res, 201, { uuid, status: 'active', ...corpo });
      };
      if (this.atrasoDaCriacaoMs > 0) {
        setTimeout(criar, this.atrasoDaCriacaoMs);
        return;
      }
      return criar();
    }
    if (url.pathname === '/integrations/webhooks' && metodo === 'GET') {
      return this.responder(res, 200, {
        webhooks: [...this.webhooks.entries()].map(([uuid, c]) => ({
          uuid,
          ...c,
        })),
      });
    }
    const webhook = /^\/integrations\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (webhook && metodo === 'DELETE') {
      return this.responder(res, this.webhooks.delete(webhook[1]) ? 204 : 404);
    }
    return this.responder(res, 404, { error: 'not_found' });
  }
}

/** O app da Meta que a Graph falsa "conhece". */
export const APP_META = {
  id: '1234567890123456',
  segredo: 'meta-segredo-0123456789',
};
export const APP_META_2 = {
  id: '6543210987654321',
  segredo: 'meta-segredo-2-0123456',
};

export class GraphFalsa extends ServidorFalso {
  private codigos = new Map<string, string>();
  private sequencia = 0;
  apps = [APP_META, APP_META_2];

  limpar(): void {
    this.pedidos = [];
    this.codigos.clear();
    this.apps = [APP_META, APP_META_2];
  }

  novoCodigo(redirectUri: string): string {
    const codigo = `fb-code-${++this.sequencia}`;
    this.codigos.set(codigo, redirectUri);
    return codigo;
  }

  protected tratar(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const partes = url.pathname
      .replace(/^\/v\d+\.\d+/, '')
      .split('/')
      .filter(Boolean);
    const erro = (codigo: number, mensagem: string) =>
      this.responder(res, 400, {
        error: { message: mensagem, type: 'OAuthException', code: codigo },
      });
    const [a, b] = partes;
    if (a === 'oauth' && b === 'access_token') {
      const app = this.apps.find(
        (x) => x.id === url.searchParams.get('client_id'),
      );
      if (!app || app.segredo !== url.searchParams.get('client_secret')) {
        return erro(1, 'Invalid client_id or client_secret');
      }
      if (url.searchParams.get('grant_type') === 'fb_exchange_token') {
        return this.responder(res, 200, {
          access_token: `longo-${++this.sequencia}`,
          token_type: 'bearer',
          expires_in: 5183944,
        });
      }
      const codigo = url.searchParams.get('code') ?? '';
      if (this.codigos.get(codigo) !== url.searchParams.get('redirect_uri')) {
        return erro(100, 'Error validating verification code');
      }
      this.codigos.delete(codigo);
      return this.responder(res, 200, {
        access_token: `curto-${++this.sequencia}`,
        token_type: 'bearer',
        expires_in: 5400,
      });
    }
    if (a === 'me' && !b) {
      return this.responder(res, 200, { id: 'u-1', name: 'Maria Gestora' });
    }
    if (a === 'me' && b === 'accounts') {
      return this.responder(res, 200, {
        data: [
          {
            id: '300000000000001',
            name: 'Escola Demo',
            category: 'Education',
            access_token: 'pg-300000000000001',
          },
        ],
      });
    }
    if (a === '300000000000001' && !b) {
      return this.responder(res, 200, {
        id: a,
        name: 'Escola Demo',
        category: 'Education',
      });
    }
    // Validação do app: GET /{app-id}?fields=id,name&access_token={id}|{segredo}
    const app = this.apps.find((x) => x.id === a);
    if (app && !b) {
      return url.searchParams.get('access_token') === `${app.id}|${app.segredo}`
        ? this.responder(res, 200, {
            id: app.id,
            name: `App ${app.id.slice(-4)}`,
          })
        : erro(190, 'Invalid OAuth access token - Cannot parse access token');
    }
    return erro(190, 'Invalid OAuth access token');
  }
}
