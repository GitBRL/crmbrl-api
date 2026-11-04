import {
  DICA_ATUALIZACAO,
  ehObjeto,
  itemUnico,
  mapeamentoDe,
  regras,
  semAutenticidade,
  textoOuNulo,
} from './comum';
import { chamarAplicativo } from './chamadas-http';
import type {
  AdaptadorDeAplicativo,
  CampoBuscado,
  ContextoHttp,
  Credencial,
  ItemRecebido,
} from './tipos';

/**
 * ActiveCampaign, ação Webhook de uma automação, em formulário aninhado:
 * `contact[email]`, `contact[first_name]`, `contact[fields][<id>]`, `deal[...]`.
 * O corpo ganha `contact.full_name` (nome + sobrenome), porque o mapeamento
 * não concatena (R32.2).
 */
export function normalizarActiveCampaign(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo) || !ehObjeto(corpo.contact)) {
    return itemUnico(corpo);
  }
  const contato = corpo.contact;
  const nome = [textoOuNulo(contato.first_name), textoOuNulo(contato.last_name)]
    .filter(Boolean)
    .join(' ');
  if (!nome || 'full_name' in contato) {
    return itemUnico(corpo);
  }
  return itemUnico({ ...corpo, contact: { ...contato, full_name: nome } });
}

/** `https://conta.api-us1.com` → sem barra no fim e sem `/api/3` colado por engano. */
export function normalizarUrlDaConta(entrada: string): string | null {
  const texto = entrada.trim();
  if (!URL.canParse(texto)) {
    return null;
  }
  const url = new URL(texto);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    return null;
  }
  const caminho = url.pathname.replace(/\/+$/, '').replace(/\/api\/3$/, '');
  return `${url.origin}${caminho}`;
}

export const adaptadorActiveCampaign: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'ACTIVE_CAMPAIGN',
    nome: 'ActiveCampaign',
    descricao:
      'Receba contatos e negócios do ActiveCampaign por uma ação Webhook de automação e traga os nomes dos campos personalizados pela API.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/x-www-form-urlencoded', 'application/json'],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'O ActiveCampaign não assina o envio: a única proteção é o endereço secreto da integração. A chave da API só serve para buscar os campos.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: [
      {
        chave: 'urlConta',
        rotulo: 'URL da conta',
        secreto: false,
        obrigatorio: true,
        descricao:
          'No ActiveCampaign: Configurações > Desenvolvedor > "URL da API". Precisa ser HTTPS e pública.',
        exemplo: 'https://suaconta.api-us1.com',
      },
      {
        chave: 'chaveApi',
        rotulo: 'Chave da API',
        secreto: true,
        obrigatorio: true,
        descricao: 'No mesmo lugar: "Chave".',
      },
    ],
    buscaCampos: true,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No ActiveCampaign',
      passos: [
        'Em Configurações > Desenvolvedor, copie a URL da conta e a chave da API e informe aqui.',
        'Em Automações, edite a automação, adicione "Condições e fluxo de trabalho" > Webhook e cole o endereço da integração. Cada automação pode usar uma integração diferente.',
        'Use "Buscar campos da integração" para dar nome aos campos personalizados (contact.fields.<id>).',
        'Para atualizar negócios pelo AC, crie ações "Atualizar contato" com os campos "Dono do negócio" (e-mail do vendedor), "etapa_funil" (nome da etapa) e "status" (aberto, ganho ou perdido) e mapeie-os para dono, etapa e status (o modelo pronto já faz isso para esses três nomes).',
      ],
    },
    modelo: {
      nome: 'ActiveCampaign',
      descricao:
        'contact[first_name] + contact[last_name] (contact.full_name), contact[email], contact[phone], contact[orgname] e contact[tags]. Os campos personalizados você mapeia depois de "Buscar campos".',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'contact.full_name', 'contact.first_name'),
        ...regras('email', 'contact.email'),
        ...regras('telefone', 'contact.phone'),
        ...regras('empresa', 'contact.orgname'),
        ...regras('etiquetas', 'contact.tags'),
        ...regras('valor', 'deal.value'),
        ...regras('titulo', 'deal.title'),
        // Atualização pelo AC (R32.4): campos personalizados com esses nomes, quando a automação os envia.
        ...regras('etapa', 'contact.fields.etapa_funil'),
        ...regras('dono', 'contact.fields.Dono do negócio'),
        ...regras('status', 'contact.fields.status'),
      ]),
      exemplo: {
        type: 'automation',
        contact: {
          id: '17',
          email: 'maria@empresa.com.br',
          first_name: 'Maria',
          last_name: 'Souza',
          full_name: 'Maria Souza',
          phone: '11987654321',
          orgname: 'Empresa Ltda',
          tags: 'lead-quente,webinar',
          fields: { '3': 'São Paulo' },
        },
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: normalizarActiveCampaign,
  verificarAutenticidade: semAutenticidade,
  lerCredencial(entrada) {
    const problemas: { campo: string; mensagem: string }[] = [];
    const urlBruta =
      typeof entrada.urlConta === 'string' ? entrada.urlConta : '';
    const url = urlBruta ? normalizarUrlDaConta(urlBruta) : null;
    if (!url) {
      problemas.push({
        campo: 'credencial.urlConta',
        mensagem: urlBruta
          ? 'deve ser um endereço http(s) válido, sem usuário e senha'
          : 'é obrigatória',
      });
    }
    const chave =
      typeof entrada.chaveApi === 'string' ? entrada.chaveApi.trim() : '';
    if (!chave) {
      problemas.push({
        campo: 'credencial.chaveApi',
        mensagem: 'é obrigatória',
      });
    } else if (chave.length > 500) {
      problemas.push({
        campo: 'credencial.chaveApi',
        mensagem: 'deve ter no máximo 500 caracteres',
      });
    }
    return problemas.length > 0 || !url
      ? { problemas }
      : { credencial: { urlConta: url, chaveApi: chave } };
  },
  async testarCredencial(credencial, http) {
    await buscarCamposDaConta(credencial, http, 1);
  },
  async buscarCampos(credencial, _configuracao, http) {
    const personalizados = await buscarCamposDaConta(credencial, http, 100);
    const padrao: CampoBuscado[] = [
      { caminho: 'contact.full_name', rotulo: 'Nome completo', tipo: 'text' },
      { caminho: 'contact.first_name', rotulo: 'Nome', tipo: 'text' },
      { caminho: 'contact.last_name', rotulo: 'Sobrenome', tipo: 'text' },
      { caminho: 'contact.email', rotulo: 'E-mail', tipo: 'text' },
      { caminho: 'contact.phone', rotulo: 'Telefone', tipo: 'text' },
      { caminho: 'contact.orgname', rotulo: 'Organização', tipo: 'text' },
      { caminho: 'contact.tags', rotulo: 'Etiquetas', tipo: 'text' },
    ];
    return [...padrao, ...personalizados];
  },
};

const PAGINAS_MAXIMAS = 5;

/** `GET {conta}/api/3/fields` (cabeçalho `Api-Token`), com paginação. A URL da conta passa pela proteção SSRF (R9.1). */
async function buscarCamposDaConta(
  credencial: Credencial,
  http: ContextoHttp,
  limite: number,
): Promise<CampoBuscado[]> {
  const base = await http.verificarEndereco(credencial.urlConta);
  const campos: CampoBuscado[] = [];
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina += 1) {
    const { dados } = await chamarAplicativo({
      buscar: http.buscar,
      url: `${base.replace(/\/+$/, '')}/api/3/fields?limit=${limite}&offset=${pagina * limite}`,
      cabecalhos: { 'Api-Token': credencial.chaveApi },
      aplicativo: 'ActiveCampaign',
    });
    const lista =
      ehObjeto(dados) && Array.isArray(dados.fields) ? dados.fields : [];
    for (const campo of lista) {
      const id = ehObjeto(campo) ? textoOuNulo(campo.id) : null;
      if (ehObjeto(campo) && id) {
        campos.push({
          caminho: `contact.fields.${id}`,
          rotulo: textoOuNulo(campo.title) ?? `Campo ${id}`,
          tipo: textoOuNulo(campo.type),
        });
      }
    }
    const total =
      ehObjeto(dados) && ehObjeto(dados.meta) ? Number(dados.meta.total) : NaN;
    if (limite === 1 || lista.length < limite || !(campos.length < total)) {
      break;
    }
  }
  return campos;
}
