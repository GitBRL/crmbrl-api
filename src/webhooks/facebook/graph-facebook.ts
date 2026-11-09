/**
 * Chamadas à Graph API da Meta para o Facebook Lead Ads (R32.14), por `fetch`:
 * login (troca do `code` e token de longa duração), páginas, formulários,
 * perguntas, assinatura da página (`subscribed_apps`) e leads. O endereço vem de
 * `META_GRAPH_URL` e a versão de `META_GRAPH_VERSAO` (a falsa no ambiente dos
 * agentes e nos testes). O token vai no cabeçalho `Authorization` (nunca na URL)
 * e nenhum token ou segredo entra em mensagem de erro.
 *
 * Tudo aqui é sem banco: quem chama decide o que fazer com `ErroDaGraph`
 * (`tokenInvalido`, `passageiro`).
 */
import { ErroDaGraph } from '../../canais/meta/graph-api';

export { ErroDaGraph };

const PRAZO_MS = 15_000;
/** Páginas de resultado lidas em cada listagem (100 itens cada). */
const MAXIMO_DE_PAGINAS = 20;
const ITENS_POR_PAGINA = 100;

export interface ConfiguracaoDaGraph {
  readonly buscar: typeof fetch;
  /** `META_GRAPH_URL`, sem barra no fim. */
  readonly graphUrl: string;
  /** `META_GRAPH_VERSAO` (`v24.0`). */
  readonly versao: string;
}

export interface PaginaDoFacebook {
  readonly id: string;
  readonly nome: string;
  readonly categoria: string | null;
  /** Token da página: não expira com o do usuário. */
  readonly token: string;
}

export interface FormularioDoFacebook {
  readonly id: string;
  readonly nome: string;
  readonly status: string | null;
  readonly idioma: string | null;
  readonly criadoEm: string | null;
  readonly leads: number | null;
}

export interface PerguntaDoFormulario {
  readonly chave: string;
  readonly rotulo: string;
  readonly tipo: string | null;
}

export interface LeadDoFacebook {
  readonly id: string;
  readonly criadoEm: string | null;
  readonly formularioId: string | null;
  readonly anuncioId: string | null;
  readonly anuncio: string | null;
  readonly conjuntoId: string | null;
  readonly conjunto: string | null;
  readonly campanhaId: string | null;
  readonly campanha: string | null;
  readonly organico: boolean | null;
  readonly plataforma: string | null;
  readonly respostas: readonly { nome: string; valores: readonly string[] }[];
}

export interface TokenTrocado {
  readonly token: string;
  /** Segundos até expirar, quando a Meta informa. */
  readonly expiraEmSegundos: number | null;
}

/** Campos pedidos de cada lead (os de anúncio só vêm nos leads de anúncio). */
export const CAMPOS_DO_LEAD = [
  'id',
  'created_time',
  'ad_id',
  'ad_name',
  'adset_id',
  'adset_name',
  'campaign_id',
  'campaign_name',
  'form_id',
  'is_organic',
  'platform',
  'field_data',
] as const;

type Objeto = Record<string, unknown>;

function objeto(valor: unknown): Objeto {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Objeto)
    : {};
}

function texto(valor: unknown): string | null {
  if (typeof valor === 'string') {
    return valor.trim() || null;
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return String(valor);
  }
  return null;
}

export class ClienteDaGraphFacebook {
  constructor(private readonly configuracao: ConfiguracaoDaGraph) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  /** Troca o `code` do diálogo por um token curto (o `redirect_uri` precisa ser idêntico ao do diálogo). */
  trocarCodigo(
    appId: string,
    appSecret: string,
    redirectUri: string,
    codigo: string,
  ): Promise<TokenTrocado> {
    return this.token({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code: codigo,
    });
  }

  /** Troca o token curto por um de longa duração (~60 dias). */
  tokenDeLongaDuracao(
    appId: string,
    appSecret: string,
    tokenCurto: string,
  ): Promise<TokenTrocado> {
    return this.token({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: tokenCurto,
    });
  }

  private async token(
    parametros: Record<string, string>,
  ): Promise<TokenTrocado> {
    const dados = objeto(
      await this.pedir('GET', 'oauth/access_token', null, parametros),
    );
    const token = texto(dados.access_token);
    if (!token) {
      throw new ErroDaGraph(
        'A Meta não devolveu o token de acesso.',
        502,
        null,
        null,
      );
    }
    const expira = Number(dados.expires_in);
    return {
      token,
      expiraEmSegundos: Number.isFinite(expira) && expira > 0 ? expira : null,
    };
  }

  /**
   * Confere o par ID + segredo do app (`GET /{app-id}?fields=id,name`, token de app `id|segredo`, o formato
   * documentado da Meta, R32.22): devolve o nome do app ou lança `ErroDaGraph` (par errado: HTTP 400, código 190).
   */
  async validarApp(
    appId: string,
    appSecret: string,
  ): Promise<{ id: string; nome: string }> {
    const dados = objeto(
      await this.pedir('GET', encodeURIComponent(appId), null, {
        fields: 'id,name',
        access_token: `${appId}|${appSecret}`,
      }),
    );
    const id = texto(dados.id);
    if (id !== appId) {
      throw new ErroDaGraph(
        'A Meta respondeu com outro app: confira o ID.',
        400,
        190,
        null,
      );
    }
    return { id, nome: texto(dados.name) ?? appId };
  }

  // -------------------------------------------------------------------------
  // Contas, páginas, formulários e perguntas
  // -------------------------------------------------------------------------

  /** Quem é o dono do token (`/me`): o usuário (token de usuário) ou a página (token de página). */
  async eu(token: string): Promise<{ id: string; nome: string }> {
    const dados = objeto(
      await this.pedir('GET', 'me', token, { fields: 'id,name' }),
    );
    return { id: texto(dados.id) ?? '', nome: texto(dados.name) ?? '' };
  }

  /** Uma página pelo id (com o token da própria página ou de um usuário que a administra). */
  async pagina(
    token: string,
    paginaId: string,
  ): Promise<{ id: string; nome: string; categoria: string | null }> {
    const dados = objeto(
      await this.pedir('GET', encodeURIComponent(paginaId), token, {
        fields: 'id,name,category',
      }),
    );
    return {
      id: texto(dados.id) ?? paginaId,
      nome: texto(dados.name) ?? paginaId,
      categoria: texto(dados.category),
    };
  }

  /** As páginas do usuário, com o token de cada uma (`/me/accounts`). */
  async paginas(tokenDoUsuario: string): Promise<PaginaDoFacebook[]> {
    const { itens } = await this.listar(
      'me/accounts',
      tokenDoUsuario,
      'id,name,category,access_token',
    );
    return itens.flatMap((item) => {
      const id = texto(item.id);
      const token = texto(item.access_token);
      return id && token
        ? [
            {
              id,
              nome: texto(item.name) ?? id,
              categoria: texto(item.category),
              token,
            },
          ]
        : [];
    });
  }

  /** Os formulários de lead da página (`/{página}/leadgen_forms`). */
  async formularios(
    tokenDaPagina: string,
    paginaId: string,
  ): Promise<FormularioDoFacebook[]> {
    const { itens } = await this.listar(
      `${encodeURIComponent(paginaId)}/leadgen_forms`,
      tokenDaPagina,
      'id,name,status,locale,created_time,leads_count',
    );
    return itens.flatMap((item) => {
      const id = texto(item.id);
      if (!id) {
        return [];
      }
      const leads = Number(item.leads_count);
      return [
        {
          id,
          nome: texto(item.name) ?? id,
          status: texto(item.status),
          idioma: texto(item.locale),
          criadoEm: texto(item.created_time),
          leads: Number.isFinite(leads) ? leads : null,
        },
      ];
    });
  }

  /** As perguntas de um formulário (`/{formulário}?fields=questions`). */
  async perguntas(
    tokenDaPagina: string,
    formularioId: string,
  ): Promise<PerguntaDoFormulario[]> {
    const dados = objeto(
      await this.pedir('GET', encodeURIComponent(formularioId), tokenDaPagina, {
        fields: 'questions',
      }),
    );
    const lista = Array.isArray(dados.questions) ? dados.questions : [];
    return lista.flatMap((bruta) => {
      const pergunta = objeto(bruta);
      const chave = texto(pergunta.key);
      return chave
        ? [
            {
              chave,
              rotulo: texto(pergunta.label) ?? chave,
              tipo: texto(pergunta.type),
            },
          ]
        : [];
    });
  }

  // -------------------------------------------------------------------------
  // Assinatura da página
  // -------------------------------------------------------------------------

  /** Campos que o app `appId` assina na página (vazio se não assina). */
  async camposAssinados(
    tokenDaPagina: string,
    paginaId: string,
    appId: string,
  ): Promise<string[]> {
    const dados = objeto(
      await this.pedir(
        'GET',
        `${encodeURIComponent(paginaId)}/subscribed_apps`,
        tokenDaPagina,
        { fields: 'id,name,subscribed_fields' },
      ),
    );
    const apps = Array.isArray(dados.data) ? dados.data : [];
    for (const bruto of apps) {
      const app = objeto(bruto);
      if (texto(app.id) === appId) {
        return Array.isArray(app.subscribed_fields)
          ? app.subscribed_fields.filter(
              (campo): campo is string => typeof campo === 'string',
            )
          : [];
      }
    }
    return [];
  }

  /** Assina os campos na página (`POST /{página}/subscribed_apps`). */
  async assinar(
    tokenDaPagina: string,
    paginaId: string,
    campos: readonly string[],
  ): Promise<void> {
    await this.pedir(
      'POST',
      `${encodeURIComponent(paginaId)}/subscribed_apps`,
      tokenDaPagina,
      { subscribed_fields: campos.join(',') },
    );
  }

  /** Remove a assinatura do app na página. */
  async desassinar(tokenDaPagina: string, paginaId: string): Promise<void> {
    await this.pedir(
      'DELETE',
      `${encodeURIComponent(paginaId)}/subscribed_apps`,
      tokenDaPagina,
    );
  }

  // -------------------------------------------------------------------------
  // Leads
  // -------------------------------------------------------------------------

  /** Um lead pelo `leadgen_id`. */
  async lead(
    tokenDaPagina: string,
    leadgenId: string,
  ): Promise<LeadDoFacebook> {
    const dados = await this.pedir(
      'GET',
      encodeURIComponent(leadgenId),
      tokenDaPagina,
      { fields: CAMPOS_DO_LEAD.join(',') },
    );
    return lerLead(dados);
  }

  /**
   * Os leads do formulário criados a partir de `desde` (reconciliação).
   * `completo` falso: a listagem parou no limite de páginas e há mais leads.
   */
  async leadsDoFormulario(
    tokenDaPagina: string,
    formularioId: string,
    desde: Date,
  ): Promise<{ leads: LeadDoFacebook[]; completo: boolean }> {
    const segundos = Math.floor(desde.getTime() / 1000);
    const { itens, completo } = await this.listar(
      `${encodeURIComponent(formularioId)}/leads`,
      tokenDaPagina,
      CAMPOS_DO_LEAD.join(','),
      {
        filtering: JSON.stringify([
          { field: 'time_created', operator: 'GREATER_THAN', value: segundos },
        ]),
        since: String(segundos),
      },
    );
    const leads = itens.map(lerLead).filter((lead) => {
      const criado = instanteDaMeta(lead.criadoEm);
      return lead.id !== '' && (criado === null || criado >= desde);
    });
    return { leads, completo };
  }

  // -------------------------------------------------------------------------
  // Base
  // -------------------------------------------------------------------------

  /** Lista paginada pelo cursor `after` (nunca segue o `paging.next`, que leva o token na URL). */
  private async listar(
    caminho: string,
    token: string,
    campos: string,
    extra: Record<string, string> = {},
  ): Promise<{ itens: Objeto[]; completo: boolean }> {
    const itens: Objeto[] = [];
    let depois: string | null = null;
    let completo = false;
    for (let pagina = 0; pagina < MAXIMO_DE_PAGINAS; pagina++) {
      const dados: Objeto = objeto(
        await this.pedir('GET', caminho, token, {
          fields: campos,
          limit: String(ITENS_POR_PAGINA),
          ...extra,
          ...(depois ? { after: depois } : {}),
        }),
      );
      const data = Array.isArray(dados.data) ? dados.data : [];
      itens.push(...data.map(objeto));
      const paginacao = objeto(dados.paging);
      const proxima = texto(objeto(paginacao.cursors).after);
      if (
        !paginacao.next ||
        !proxima ||
        proxima === depois ||
        data.length === 0
      ) {
        completo = true;
        break;
      }
      depois = proxima;
    }
    // `completo` falso: parou no limite de páginas, havia mais itens.
    return { itens, completo };
  }

  private async pedir(
    metodo: 'GET' | 'POST' | 'DELETE',
    caminho: string,
    token: string | null,
    parametros: Record<string, string> = {},
  ): Promise<unknown> {
    const consulta = new URLSearchParams(parametros).toString();
    const url = `${this.configuracao.graphUrl}/${this.configuracao.versao}/${caminho}${consulta ? `?${consulta}` : ''}`;
    let resposta: Response;
    try {
      resposta = await this.configuracao.buscar(url, {
        method: metodo,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(PRAZO_MS),
      });
    } catch {
      throw new ErroDaGraph(
        'Sem resposta da Graph API da Meta (falha de conexão ou tempo esgotado).',
        0,
        null,
        null,
      );
    }
    const dados = (await resposta.json().catch(() => ({}))) as unknown;
    const erro = objeto(objeto(dados).error);
    if (!resposta.ok || Object.keys(erro).length > 0) {
      throw new ErroDaGraph(
        texto(erro.message) ?? `A Graph API respondeu ${resposta.status}.`,
        resposta.status,
        typeof erro.code === 'number' ? erro.code : null,
        typeof erro.error_subcode === 'number' ? erro.error_subcode : null,
      );
    }
    return dados;
  }
}

/** A data da Meta (`2026-11-04T10:00:00+0000`, sem dois-pontos no fuso) como `Date`, ou `null`. */
export function instanteDaMeta(valor: string | null): Date | null {
  if (!valor) {
    return null;
  }
  const normalizado = valor.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const data = new Date(normalizado);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * Até onde a reconciliação pode avançar o marco `reconciliadoAte`. Lista completa:
 * até agora. Lista cortada no limite de páginas: se vier em ordem crescente, até o
 * último lead lido (a próxima rodada continua dali); em ordem decrescente (ou sem
 * datas), não avança, para os leads além do corte não ficarem de fora para sempre.
 */
export function marcoDaReconciliacao(
  agora: Date,
  leads: readonly Pick<LeadDoFacebook, 'criadoEm'>[],
  completo: boolean,
): Date | null {
  if (completo) {
    return agora;
  }
  const datas = leads.flatMap(({ criadoEm }) => {
    const data = instanteDaMeta(criadoEm);
    return data ? [data] : [];
  });
  if (datas.length < 2) {
    return null;
  }
  const crescente = datas[0].getTime() <= datas[datas.length - 1].getTime();
  return crescente ? datas[datas.length - 1] : null;
}

/** `field_data` e metadados de um lead da Graph → `LeadDoFacebook` (tolerante). */
export function lerLead(bruto: unknown): LeadDoFacebook {
  const lead = objeto(bruto);
  const respostas = (
    Array.isArray(lead.field_data) ? lead.field_data : []
  ).flatMap((item) => {
    const campo = objeto(item);
    const nome = texto(campo.name);
    if (!nome) {
      return [];
    }
    const valores = (Array.isArray(campo.values) ? campo.values : [])
      .map((valor) => (typeof valor === 'string' ? valor : texto(valor)))
      .filter((valor): valor is string => valor !== null && valor !== '');
    return [{ nome, valores }];
  });
  return {
    id: texto(lead.id) ?? '',
    criadoEm: texto(lead.created_time),
    formularioId: texto(lead.form_id),
    anuncioId: texto(lead.ad_id),
    anuncio: texto(lead.ad_name),
    conjuntoId: texto(lead.adset_id),
    conjunto: texto(lead.adset_name),
    campanhaId: texto(lead.campaign_id),
    campanha: texto(lead.campaign_name),
    organico: typeof lead.is_organic === 'boolean' ? lead.is_organic : null,
    plataforma: texto(lead.platform),
    respostas,
  };
}
