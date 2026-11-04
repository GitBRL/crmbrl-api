/**
 * Facebook Lead Ads (R32.14), funções puras: o `leadgen` do webhook, o lead da
 * Graph → o corpo que o mapeamento enxerga e os campos que o assistente oferece.
 *
 * Webhook (objeto `page`, campo `leadgen`; o payload NÃO traz os dados do lead):
 *
 * ```json
 * { "object": "page", "entry": [{ "id": "<página>", "time": 1761230000,
 *   "changes": [{ "field": "leadgen", "value": { "leadgen_id": "…", "page_id": "…",
 *     "form_id": "…", "adgroup_id": "…", "ad_id": "…", "created_time": 1761230000 } }] }] }
 * ```
 */
import type { CampoBuscado } from '../aplicativos/tipos';
import type { LeadDoFacebook, PerguntaDoFormulario } from './graph-facebook';

export interface LeadgenDoWebhook {
  readonly paginaId: string;
  readonly leadgenId: string;
  readonly formularioId: string;
  readonly anuncioId: string | null;
  readonly criadoEm: Date | null;
}

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

/** Os eventos `leadgen` de um POST do webhook da Meta (vazio se não é um). */
export function extrairLeadgens(corpo: unknown): LeadgenDoWebhook[] {
  const raiz = objeto(corpo);
  if (raiz.object !== 'page' || !Array.isArray(raiz.entry)) {
    return [];
  }
  return raiz.entry.flatMap((bruta) => {
    const entrada = objeto(bruta);
    const mudancas = Array.isArray(entrada.changes) ? entrada.changes : [];
    return mudancas.flatMap((mudanca) => {
      const { field, value } = objeto(mudanca);
      if (field !== 'leadgen') {
        return [];
      }
      const valor = objeto(value);
      const leadgenId = texto(valor.leadgen_id);
      const paginaId = texto(valor.page_id) ?? texto(entrada.id);
      const formularioId = texto(valor.form_id);
      if (!leadgenId || !paginaId || !formularioId) {
        return [];
      }
      const criado = Number(valor.created_time);
      return [
        {
          paginaId,
          leadgenId,
          formularioId,
          anuncioId: texto(valor.ad_id),
          criadoEm:
            Number.isFinite(criado) && criado > 0
              ? new Date(criado * 1000)
              : null,
        },
      ];
    });
  });
}

/** O `leadgen` traz telefone `p:+5511…` em alguns exports: tira o prefixo. */
function limparValor(chave: string, valor: string): string {
  return /^(phone_number|email)$/.test(chave)
    ? valor.replace(/^[a-z]:/i, '').trim()
    : valor;
}

export interface OrigemDoLead {
  readonly paginaId: string;
  readonly formularioId: string;
  /** `ad_id` do webhook, para o caso de a Graph não devolvê-lo. */
  readonly anuncioId?: string | null;
}

/**
 * O lead → o corpo que o mapeamento enxerga: uma chave por pergunta (`full_name`,
 * `email`, `phone_number`, as personalizadas…), mais `leadgen_id`, `page_id`,
 * `form_id`, `ad_id`, `ad_name`, `adset_id`, `adset_name`, `campaign_id`,
 * `campaign_name`, `platform`, `is_organic` e `created_time` quando existem. Sem
 * `full_name`, junta `first_name` e `last_name`. Respostas de várias opções
 * viram um texto separado por vírgula.
 */
export function normalizarLead(
  lead: LeadDoFacebook,
  origem: OrigemDoLead,
): Record<string, unknown> {
  const corpo: Record<string, unknown> = {};
  const poe = (chave: string, valor: unknown) => {
    if (valor !== null && valor !== undefined && valor !== '') {
      corpo[chave] = valor;
    }
  };
  poe('leadgen_id', lead.id);
  poe('page_id', origem.paginaId);
  poe('form_id', lead.formularioId ?? origem.formularioId);
  poe('ad_id', lead.anuncioId ?? origem.anuncioId ?? null);
  poe('ad_name', lead.anuncio);
  poe('adset_id', lead.conjuntoId);
  poe('adset_name', lead.conjunto);
  poe('campaign_id', lead.campanhaId);
  poe('campaign_name', lead.campanha);
  poe('platform', lead.plataforma);
  poe('is_organic', lead.organico);
  poe('created_time', lead.criadoEm);
  for (const resposta of lead.respostas) {
    const valor = limparValor(resposta.nome, resposta.valores.join(', '));
    if (valor !== '' && resposta.nome !== 'leadgen_id') {
      corpo[resposta.nome] = valor;
    }
  }
  if (corpo.full_name === undefined) {
    const nome = [corpo.first_name, corpo.last_name]
      .filter((parte): parte is string => typeof parte === 'string')
      .join(' ')
      .trim();
    poe('full_name', nome);
  }
  return corpo;
}

/** Metadados do lead que o assistente oferece ao lado das perguntas do formulário. */
export const METADADOS_DO_LEAD: readonly CampoBuscado[] = [
  { caminho: 'leadgen_id', rotulo: 'ID do lead no Facebook', tipo: 'metadado' },
  {
    caminho: 'created_time',
    rotulo: 'Data de criação do lead',
    tipo: 'metadado',
  },
  { caminho: 'page_id', rotulo: 'ID da página', tipo: 'metadado' },
  { caminho: 'form_id', rotulo: 'ID do formulário', tipo: 'metadado' },
  { caminho: 'ad_id', rotulo: 'ID do anúncio', tipo: 'metadado' },
  { caminho: 'ad_name', rotulo: 'Nome do anúncio', tipo: 'metadado' },
  {
    caminho: 'adset_id',
    rotulo: 'ID do conjunto de anúncios',
    tipo: 'metadado',
  },
  {
    caminho: 'adset_name',
    rotulo: 'Nome do conjunto de anúncios',
    tipo: 'metadado',
  },
  { caminho: 'campaign_id', rotulo: 'ID da campanha', tipo: 'metadado' },
  { caminho: 'campaign_name', rotulo: 'Nome da campanha', tipo: 'metadado' },
  { caminho: 'platform', rotulo: 'Plataforma (fb ou ig)', tipo: 'metadado' },
  {
    caminho: 'is_organic',
    rotulo: 'Lead orgânico (sem anúncio)',
    tipo: 'metadado',
  },
];

/** As perguntas do formulário (e os metadados do lead) como campos do assistente de mapeamento. */
export function camposDasPerguntas(
  perguntas: readonly PerguntaDoFormulario[],
): CampoBuscado[] {
  const chaves = new Set(perguntas.map(({ chave }) => chave));
  return [
    ...perguntas.map(({ chave, rotulo, tipo }) => ({
      caminho: chave,
      rotulo,
      tipo: tipo ? tipo.toLowerCase() : null,
    })),
    ...METADADOS_DO_LEAD.filter(({ caminho }) => !chaves.has(caminho)),
  ];
}
