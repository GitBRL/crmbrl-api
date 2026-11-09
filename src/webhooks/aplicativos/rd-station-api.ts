/**
 * API do RD Station Marketing para as integrações por login (R32.26): criar, listar e remover o webhook
 * pela API e buscar os campos de contato. A base vem de `RD_STATION_API_URL`; o token é o da conexão.
 * Os caminhos e os formatos são os da documentação oficial (pesquisa em `login-facilitado.md`).
 */
import { chamarAplicativo } from './chamadas-http';
import { ehObjeto } from './comum';
import { type CampoBuscado, FalhaNoAplicativoError } from './tipos';

export type GatilhoDoRd = 'CONVERSAO' | 'OPORTUNIDADE';

export const EVENTO_DO_GATILHO: Readonly<Record<GatilhoDoRd, string>> = {
  CONVERSAO: 'WEBHOOK.CONVERTED',
  OPORTUNIDADE: 'WEBHOOK.MARKED_OPPORTUNITY',
};

export interface WebhookParaCriar {
  readonly gatilho: GatilhoDoRd;
  /** Só na conversão; vazio = todas as conversões. */
  readonly conversoes: readonly string[];
  readonly url: string;
  /** O cabeçalho de autenticação que o RD envia (`auth_header` e `auth_key`), se a integração tem chave. */
  readonly autenticacao: {
    readonly cabecalho: string;
    readonly chave: string;
  } | null;
}

function cabecalhos(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** `POST /integrations/webhooks` → o `uuid` do webhook criado. */
export async function criarWebhookDoRd(
  buscar: typeof fetch,
  base: string,
  token: string,
  webhook: WebhookParaCriar,
): Promise<string> {
  const { dados } = await chamarAplicativo({
    buscar,
    url: `${base}/integrations/webhooks`,
    metodo: 'POST',
    cabecalhos: cabecalhos(token),
    corpo: {
      event_type: EVENTO_DO_GATILHO[webhook.gatilho],
      entity_type: 'CONTACT',
      ...(webhook.gatilho === 'CONVERSAO' && webhook.conversoes.length > 0
        ? { event_identifiers: [...webhook.conversoes] }
        : {}),
      url: webhook.url,
      http_method: 'POST',
      include_relations: ['COMPANY', 'CONTACT_FUNNEL'],
      ...(webhook.autenticacao
        ? {
            auth_header: webhook.autenticacao.cabecalho,
            auth_key: webhook.autenticacao.chave,
          }
        : {}),
    },
    aplicativo: 'RD Station',
  });
  const uuid =
    ehObjeto(dados) && typeof dados.uuid === 'string' ? dados.uuid : '';
  if (!uuid) {
    throw new FalhaNoAplicativoError(
      'O RD Station não devolveu o identificador do webhook criado.',
    );
  }
  return uuid;
}

/** Um webhook que o RD guarda (o que o `GET /integrations/webhooks` devolve, sem os dados de autenticação). */
export interface WebhookDoRdExistente {
  readonly uuid: string;
  readonly url: string;
}

/** `GET /integrations/webhooks` → `{webhooks:[{uuid, url, …}]}` (só os criados pela API, com este app). */
export async function listarWebhooksDoRd(
  buscar: typeof fetch,
  base: string,
  token: string,
): Promise<WebhookDoRdExistente[]> {
  const { dados } = await chamarAplicativo({
    buscar,
    url: `${base}/integrations/webhooks`,
    cabecalhos: cabecalhos(token),
    aplicativo: 'RD Station',
  });
  const lista =
    ehObjeto(dados) && Array.isArray(dados.webhooks) ? dados.webhooks : [];
  const webhooks: WebhookDoRdExistente[] = [];
  for (const bruto of lista) {
    if (
      ehObjeto(bruto) &&
      typeof bruto.uuid === 'string' &&
      typeof bruto.url === 'string'
    ) {
      webhooks.push({ uuid: bruto.uuid, url: bruto.url });
    }
  }
  return webhooks;
}

/** `DELETE /integrations/webhooks/{uuid}` (204; um webhook que já não existe, 404, conta como removido). */
export async function removerWebhookDoRd(
  buscar: typeof fetch,
  base: string,
  token: string,
  uuid: string,
): Promise<void> {
  await chamarAplicativo({
    buscar,
    url: `${base}/integrations/webhooks/${encodeURIComponent(uuid)}`,
    metodo: 'DELETE',
    cabecalhos: cabecalhos(token),
    aplicativo: 'RD Station',
    aceitar: [404],
  });
}

/**
 * Campos de contato do RD (`GET /platform/contacts/fields` → `{fields:[{api_identifier, label, data_type,
 * presentation_type, custom_field}]}`) como campos para o mapeamento. O caminho é o que o webhook envia no
 * `contact` (o `company_name` chega como `company`).
 */
export function camposDoRd(dados: unknown): CampoBuscado[] {
  const lista =
    ehObjeto(dados) && Array.isArray(dados.fields) ? dados.fields : [];
  const campos: CampoBuscado[] = [];
  for (const bruto of lista) {
    if (!ehObjeto(bruto) || typeof bruto.api_identifier !== 'string') {
      continue;
    }
    const identificador = bruto.api_identifier.trim();
    if (!identificador) {
      continue;
    }
    const caminho =
      identificador === 'company_name' ? 'company' : identificador;
    if (campos.some((campo) => campo.caminho === caminho)) {
      continue;
    }
    const rotulo = (valor: unknown): string | null => {
      if (typeof valor === 'string' && valor.trim()) {
        return valor.trim();
      }
      if (ehObjeto(valor)) {
        for (const chave of ['pt-BR', 'default']) {
          const texto = valor[chave];
          if (typeof texto === 'string' && texto.trim()) {
            return texto.trim();
          }
        }
      }
      return null;
    };
    const tipo =
      typeof bruto.presentation_type === 'string'
        ? bruto.presentation_type.toLowerCase()
        : typeof bruto.data_type === 'string'
          ? bruto.data_type.toLowerCase()
          : null;
    campos.push({
      caminho,
      rotulo: rotulo(bruto.label) ?? rotulo(bruto.name) ?? identificador,
      tipo,
    });
  }
  return campos;
}

/** `GET /platform/contacts/fields`. */
export async function buscarCamposDoRd(
  buscar: typeof fetch,
  base: string,
  token: string,
): Promise<CampoBuscado[]> {
  const { dados } = await chamarAplicativo({
    buscar,
    url: `${base}/platform/contacts/fields`,
    cabecalhos: cabecalhos(token),
    aplicativo: 'RD Station',
  });
  return camposDoRd(dados);
}
