import {
  conferirChaveNoCabecalho,
  DICA_ATUALIZACAO,
  ehObjeto,
  mapeamentoDe,
  regras,
} from './comum';
import type {
  AdaptadorDeAplicativo,
  EntradaDeAutenticidade,
  ItemRecebido,
} from './tipos';

export const CABECALHO_PADRAO_DO_RD = 'X-RD-Chave';

/**
 * Corpo do webhook criado pela API (R32.26, RD Station Marketing 2.0): objeto único
 * `{ event_type, entity_type: 'CONTACT', event_identifier, timestamp, event_timestamp, contact: {...} }`,
 * com os campos personalizados em `cf_*`. O item é o `contact` na raiz (`name`, `email`, `cf_*`…), com
 * `company` reduzido ao nome, `funnel` como veio e os dados do evento (`event_type`, `event_identifier`).
 */
function contatoDoWebhookDaApi(corpo: Record<string, unknown>): ItemRecebido {
  const contato = ehObjeto(corpo.contact) ? corpo.contact : {};
  const item: Record<string, unknown> = { ...contato };
  if (ehObjeto(contato.company)) {
    const nome = contato.company.name;
    if (typeof nome === 'string' && nome.trim()) {
      item.company = nome.trim();
    } else {
      delete item.company;
    }
  }
  for (const chave of [
    'event_type',
    'entity_type',
    'event_identifier',
    'timestamp',
    'event_timestamp',
  ]) {
    if (corpo[chave] !== undefined && !(chave in item)) {
      item[chave] = corpo[chave];
    }
  }
  return { corpo: item, rotulo: null };
}

/**
 * Corpo do RD Station: o do webhook criado pela API (`{ ..., contact: {...} }`, R32.26), `{ "leads": [...] }`
 * (cada lead é um item) ou um lead único (R32.2).
 */
export function normalizarRdStation(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return [{ corpo, rotulo: null }];
  }
  if (ehObjeto(corpo.contact) && !Array.isArray(corpo.leads)) {
    return [contatoDoWebhookDaApi(corpo)];
  }
  const leads = corpo.leads;
  if (Array.isArray(leads)) {
    const tipo = corpo.entity_type;
    return leads.map((lead, indice) => ({
      corpo:
        ehObjeto(lead) && tipo !== undefined && !('entity_type' in lead)
          ? { ...lead, entity_type: tipo }
          : lead,
      rotulo: leads.length > 1 ? `lead ${indice + 1} de ${leads.length}` : null,
    }));
  }
  // API 2.0 / eventos de conversão: `{ event_type, event_identifier, payload: { name, email, ... } }`. O lead é o `payload`.
  if (ehObjeto(corpo.payload) && !('email' in corpo)) {
    return [
      {
        corpo: {
          ...corpo.payload,
          ...(corpo.event_type !== undefined
            ? { entity_type: corpo.event_type }
            : {}),
        },
        rotulo: null,
      },
    ];
  }
  return [{ corpo, rotulo: null }];
}

export function nomeDoCabecalho(
  configuracao: Readonly<Record<string, unknown>>,
): string {
  const configurado = configuracao.cabecalhoDeAutenticacao;
  return typeof configurado === 'string' && configurado.trim()
    ? configurado.trim()
    : CABECALHO_PADRAO_DO_RD;
}

function verificar(entrada: EntradaDeAutenticidade) {
  return conferirChaveNoCabecalho(
    entrada,
    nomeDoCabecalho(entrada.configuracao),
    'esta integração do RD Station',
  );
}

export const adaptadorRdStation: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'RD_STATION',
    nome: 'RD Station',
    descricao:
      'Receba as conversões e as oportunidades do RD Station Marketing: entrando com o RD Station, o CRM cria o webhook no RD sozinho; ou cole o endereço num webhook configurado por você.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'CHAVE_NO_CABECALHO',
      descricao: `Opcional: o RD permite enviar uma chave num cabeçalho. Com chave, a integração exige o cabeçalho ${CABECALHO_PADRAO_DO_RD} (ou o nome configurado) com o mesmo valor.`,
      segredo: 'OPCIONAL',
      rotuloDoSegredo: 'Chave de autenticação',
      cabecalho: CABECALHO_PADRAO_DO_RD,
    },
    credencial: null,
    login: 'RD_STATION',
    buscaCampos: true,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No RD Station Marketing',
      passos: [
        'Automático: entre com o RD Station, escolha o gatilho (Conversão ou Oportunidade) e as conversões, e o CRM cria o webhook no RD ao ativar a integração (e o remove ao desativar ou excluir). O endereço do CRM precisa ser público, com HTTPS: o RD o testa antes de criar.',
        'Manual: no menu superior direito, abra Integrações > Webhook > "Configurar" e clique em "Criar webhook".',
        'Dê um nome, cole o endereço da integração e escolha o gatilho: "Conversão" (escolha as conversões ou deixe vazio para todas) ou "Oportunidade".',
        'Se quiser autenticar, configure no RD um cabeçalho com a chave e informe a mesma chave aqui.',
        'Converta um lead de teste e use "Atualizar campos recebidos" (ou, entrando com o RD Station, "Buscar campos"). Campos personalizados chegam como cf_<nome> (ou custom_fields.<nome> nos webhooks manuais mais antigos).',
      ],
    },
    modelo: {
      nome: 'RD Station',
      descricao:
        'name, email, mobile_phone/personal_phone, company, job_title, tags, os campos personalizados (custom_fields.* e cf_*) e as UTMs da última conversão.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'name'),
        ...regras('email', 'email'),
        ...regras('telefone', 'mobile_phone', 'personal_phone'),
        ...regras('empresa', 'company'),
        ...regras('cargo', 'job_title'),
        ...regras('etiquetas', 'tags'),
        ...regras(
          'utm.source',
          'last_conversion.conversion_origin.source',
          'first_conversion.conversion_origin.source',
          'traffic_source',
        ),
        ...regras(
          'utm.medium',
          'last_conversion.conversion_origin.medium',
          'first_conversion.conversion_origin.medium',
          'traffic_medium',
        ),
        ...regras(
          'utm.campaign',
          'last_conversion.conversion_origin.campaign',
          'first_conversion.conversion_origin.campaign',
          'traffic_campaign',
        ),
        ...regras(
          'utm.term',
          'last_conversion.content.utm_term',
          'first_conversion.content.utm_term',
        ),
        ...regras(
          'utm.content',
          'last_conversion.content.utm_content',
          'first_conversion.content.utm_content',
        ),
        ...regras('camposPersonalizados.*', 'custom_fields.*', 'cf_*'),
      ]),
      exemplo: {
        entity_type: 'WEBHOOK.CONVERTED',
        name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        mobile_phone: '11987654321',
        company: 'Empresa Ltda',
        job_title: 'Diretora',
        tags: ['ebook', 'black-friday'],
        custom_fields: { nome_escola: 'Colégio Central' },
        last_conversion: {
          content: { identificador: 'ebook-vendas' },
          conversion_origin: {
            source: 'google',
            medium: 'cpc',
            campaign: 'black-friday',
          },
        },
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: normalizarRdStation,
  verificarAutenticidade: verificar,
};
