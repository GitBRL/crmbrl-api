import {
  DICA_ATUALIZACAO,
  ehObjeto,
  mapeamentoDe,
  regras,
  textoOuNulo,
  utmsDeCaminhos,
} from './comum';
import { chamarAplicativo } from './chamadas-http';
import {
  assinaturaDoTypeform,
  cabecalho,
  iguaisEmTempoConstante,
} from './seguranca';
import type {
  AdaptadorDeAplicativo,
  CampoBuscado,
  ContextoHttp,
  Credencial,
  EntradaDeAutenticidade,
  FormularioDoAplicativo,
  ItemRecebido,
  ResultadoDeAutenticidade,
} from './tipos';

// ---------------------------------------------------------------------------
// Corpo (`form_response`)
// ---------------------------------------------------------------------------

/** Chaves do item que não podem ser sobrescritas por um `ref` de pergunta. */
const CHAVES_RESERVADAS = new Set([
  'hidden',
  'variables',
  'event_id',
  'event_type',
  'form_id',
  'form_title',
  'token',
  'submitted_at',
  'landed_at',
  'email',
  'telefone',
  'nome',
]);

/** O valor de uma resposta, conforme o tipo (`text`, `email`, `choice.label`, `choices.labels`…). */
export function valorDaResposta(resposta: Record<string, unknown>): unknown {
  const tipo = typeof resposta.type === 'string' ? resposta.type : '';
  switch (tipo) {
    case 'choice': {
      const escolha = resposta.choice;
      if (ehObjeto(escolha)) {
        return textoOuNulo(escolha.label) ?? textoOuNulo(escolha.other);
      }
      return null;
    }
    case 'choices': {
      const escolhas = resposta.choices;
      if (ehObjeto(escolhas)) {
        const rotulos = Array.isArray(escolhas.labels)
          ? escolhas.labels.filter((r): r is string => typeof r === 'string')
          : [];
        const outro = textoOuNulo(escolhas.other);
        return [...rotulos, ...(outro ? [outro] : [])].join(', ') || null;
      }
      return null;
    }
    case 'payment': {
      const pagamento = resposta.payment;
      return ehObjeto(pagamento) ? textoOuNulo(pagamento.amount) : null;
    }
    default: {
      const valor = resposta[tipo];
      if (typeof valor === 'boolean') {
        return valor;
      }
      return textoOuNulo(valor);
    }
  }
}

/**
 * `form_response` do Typeform → o item que o mapeamento enxerga: uma chave por
 * pergunta (o `ref`), `hidden.*`, `variables.*`, `form_id`, `form_title`,
 * `event_id`, `submitted_at`, e três apelidos úteis: `email` e `telefone` (a
 * primeira pergunta do tipo) e `nome` (a primeira de texto cujo título fala de
 * nome). O `ref` é o nome estável da pergunta (o título aparece na tela).
 */
export function normalizarTypeform(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo) || !ehObjeto(corpo.form_response)) {
    return [{ corpo, rotulo: null }];
  }
  const resposta = corpo.form_response;
  const definicao = ehObjeto(resposta.definition) ? resposta.definition : {};
  const titulos = new Map<string, string>();
  for (const pergunta of Array.isArray(definicao.fields)
    ? definicao.fields
    : []) {
    if (ehObjeto(pergunta) && typeof pergunta.id === 'string') {
      titulos.set(pergunta.id, textoOuNulo(pergunta.title) ?? '');
    }
  }
  const item: Record<string, unknown> = {};
  const copiar = (chave: string, valor: unknown) => {
    const texto = textoOuNulo(valor);
    if (texto) {
      item[chave] = texto;
    }
  };
  copiar('event_id', corpo.event_id);
  copiar('form_id', resposta.form_id);
  copiar('form_title', definicao.title);
  copiar('token', resposta.token);
  copiar('submitted_at', resposta.submitted_at);
  copiar('landed_at', resposta.landed_at);

  const apelidos: { email?: unknown; telefone?: unknown; nome?: unknown } = {};
  for (const bruta of Array.isArray(resposta.answers) ? resposta.answers : []) {
    if (!ehObjeto(bruta) || !ehObjeto(bruta.field)) {
      continue;
    }
    const valor = valorDaResposta(bruta);
    if (valor === null || valor === undefined) {
      continue;
    }
    const ref = textoOuNulo(bruta.field.ref) ?? textoOuNulo(bruta.field.id);
    if (ref && !CHAVES_RESERVADAS.has(ref) && !ref.includes('.')) {
      item[ref] = valor;
    }
    if (bruta.type === 'email') {
      apelidos.email ??= valor;
    } else if (bruta.type === 'phone_number') {
      apelidos.telefone ??= valor;
    } else if (bruta.type === 'text') {
      const titulo = titulos.get(String(bruta.field.id)) ?? '';
      if (/\b(nome|name)\b/i.test(titulo)) {
        apelidos.nome ??= valor;
      }
    }
  }
  for (const [apelido, valor] of Object.entries(apelidos)) {
    if (valor !== undefined) {
      item[apelido] = valor;
    }
  }
  if (ehObjeto(resposta.hidden) && Object.keys(resposta.hidden).length > 0) {
    item.hidden = resposta.hidden;
  }
  if (Array.isArray(resposta.variables)) {
    const variaveis: Record<string, unknown> = {};
    for (const variavel of resposta.variables) {
      if (ehObjeto(variavel) && typeof variavel.key === 'string') {
        variaveis[variavel.key] =
          variavel.type === 'number' ? variavel.number : variavel.text;
      }
    }
    if (Object.keys(variaveis).length > 0) {
      item.variables = variaveis;
    }
  }
  return [
    { corpo: item, rotulo: null, chaveDoEvento: textoOuNulo(corpo.event_id) },
  ];
}

// ---------------------------------------------------------------------------
// Autenticidade: `Typeform-Signature: sha256=<base64 do HMAC-SHA256 do corpo bruto>`
// ---------------------------------------------------------------------------

function verificar(entrada: EntradaDeAutenticidade): ResultadoDeAutenticidade {
  if (!entrada.segredo) {
    return {
      ok: false,
      mensagem:
        'Esta integração do Typeform ainda não tem o segredo do webhook: escolha o formulário para o CRM registrar o webhook.',
    };
  }
  const recebida = cabecalho(entrada.cabecalhos, 'typeform-signature');
  if (!recebida) {
    return {
      ok: false,
      mensagem:
        'Assinatura ausente: o Typeform envia Typeform-Signature: sha256=<base64 do HMAC-SHA256 do corpo>.',
    };
  }
  const esperada = assinaturaDoTypeform(entrada.segredo, entrada.corpoBruto);
  return iguaisEmTempoConstante(recebida.trim(), esperada)
    ? { ok: true }
    : {
        ok: false,
        mensagem:
          'Assinatura inválida: Typeform-Signature não confere com o HMAC-SHA256 do corpo.',
      };
}

// ---------------------------------------------------------------------------
// API do Typeform (`TYPEFORM_API_URL`)
// ---------------------------------------------------------------------------

function cabecalhosDoTypeform(credencial: Credencial): Record<string, string> {
  return { Authorization: `Bearer ${credencial.token}` };
}

export async function testarTokenDoTypeform(
  credencial: Credencial,
  http: ContextoHttp,
): Promise<void> {
  await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.typeformUrl}/forms?page_size=1`,
    cabecalhos: cabecalhosDoTypeform(credencial),
    aplicativo: 'Typeform',
  });
}

export async function listarFormulariosDoTypeform(
  credencial: Credencial,
  http: ContextoHttp,
  busca?: string,
): Promise<FormularioDoAplicativo[]> {
  const parametros = new URLSearchParams({ page_size: '200' });
  if (busca) {
    parametros.set('search', busca);
  }
  const { dados } = await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.typeformUrl}/forms?${parametros.toString()}`,
    cabecalhos: cabecalhosDoTypeform(credencial),
    aplicativo: 'Typeform',
  });
  const itens =
    ehObjeto(dados) && Array.isArray(dados.items) ? dados.items : [];
  return itens.flatMap((item) => {
    if (!ehObjeto(item) || typeof item.id !== 'string') {
      return [];
    }
    const ligacoes = ehObjeto(item._links) ? item._links : {};
    return [
      {
        id: item.id,
        titulo: textoOuNulo(item.title) ?? item.id,
        url: textoOuNulo(ligacoes.display),
        atualizadoEm: textoOuNulo(item.last_updated_at),
      },
    ];
  });
}

/** As perguntas de um formulário (inclusive as de grupos), `hidden` e `variables`, como campos para o mapeamento. */
export async function buscarCamposDoFormulario(
  credencial: Credencial,
  http: ContextoHttp,
  formularioId: string,
): Promise<CampoBuscado[]> {
  const { dados } = await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.typeformUrl}/forms/${encodeURIComponent(formularioId)}`,
    cabecalhos: cabecalhosDoTypeform(credencial),
    aplicativo: 'Typeform',
  });
  const campos: CampoBuscado[] = [
    {
      caminho: 'nome',
      rotulo: 'Nome (primeira pergunta de texto sobre nome)',
      tipo: 'text',
    },
    {
      caminho: 'email',
      rotulo: 'E-mail (primeira pergunta de e-mail)',
      tipo: 'email',
    },
    {
      caminho: 'telefone',
      rotulo: 'Telefone (primeira pergunta de telefone)',
      tipo: 'phone_number',
    },
  ];
  if (!ehObjeto(dados)) {
    return campos;
  }
  const percorrer = (perguntas: unknown) => {
    for (const pergunta of Array.isArray(perguntas) ? perguntas : []) {
      if (!ehObjeto(pergunta)) {
        continue;
      }
      const tipo = textoOuNulo(pergunta.type);
      const propriedades = ehObjeto(pergunta.properties)
        ? pergunta.properties
        : {};
      if (tipo === 'group' || tipo === 'matrix') {
        percorrer(propriedades.fields);
        continue;
      }
      const ref = textoOuNulo(pergunta.ref) ?? textoOuNulo(pergunta.id);
      // Um `ref` igual a um apelido (nome, email, telefone) já está na lista: não repete o caminho.
      if (
        ref &&
        tipo !== 'statement' &&
        !campos.some((c) => c.caminho === ref)
      ) {
        campos.push({
          caminho: ref,
          rotulo: textoOuNulo(pergunta.title) ?? ref,
          tipo,
        });
      }
    }
  };
  percorrer(dados.fields);
  for (const oculto of Array.isArray(dados.hidden) ? dados.hidden : []) {
    if (typeof oculto === 'string' && oculto) {
      campos.push({
        caminho: `hidden.${oculto}`,
        rotulo: `Campo oculto ${oculto}`,
        tipo: 'hidden',
      });
    }
  }
  if (ehObjeto(dados.variables)) {
    for (const nome of Object.keys(dados.variables)) {
      campos.push({
        caminho: `variables.${nome}`,
        rotulo: `Variável ${nome}`,
        tipo: 'variable',
      });
    }
  }
  return campos;
}

/** `PUT /forms/{id}/webhooks/{tag}`: registra (ou atualiza) o webhook do CRM no formulário, com o segredo. */
export async function registrarWebhookDoTypeform(
  credencial: Credencial,
  http: ContextoHttp,
  dados: {
    formularioId: string;
    tag: string;
    url: string;
    segredo: string;
    ativo: boolean;
  },
): Promise<void> {
  await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.typeformUrl}/forms/${encodeURIComponent(dados.formularioId)}/webhooks/${encodeURIComponent(dados.tag)}`,
    metodo: 'PUT',
    cabecalhos: cabecalhosDoTypeform(credencial),
    corpo: {
      url: dados.url,
      enabled: dados.ativo,
      secret: dados.segredo,
      verify_ssl: true,
    },
    aplicativo: 'Typeform',
  });
}

/** `DELETE /forms/{id}/webhooks/{tag}` (um webhook que já não existe, 404, conta como removido). */
export async function removerWebhookDoTypeform(
  credencial: Credencial,
  http: ContextoHttp,
  formularioId: string,
  tag: string,
): Promise<void> {
  await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.typeformUrl}/forms/${encodeURIComponent(formularioId)}/webhooks/${encodeURIComponent(tag)}`,
    metodo: 'DELETE',
    cabecalhos: cabecalhosDoTypeform(credencial),
    aplicativo: 'Typeform',
    aceitar: [404],
  });
}

export const adaptadorTypeform: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'TYPEFORM',
    nome: 'Typeform',
    descricao:
      'Receba as respostas dos formulários do Typeform: o CRM registra o webhook no formulário escolhido, com segredo.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'TYPEFORM_ASSINATURA',
      descricao:
        'O CRM gera um segredo, registra-o no webhook do formulário e confere o Typeform-Signature (sha256=<base64 do HMAC-SHA256 do corpo>) de cada resposta.',
      segredo: 'GERADO_PELO_CRM',
      rotuloDoSegredo: 'Segredo do webhook (gerado pelo CRM)',
      cabecalho: 'Typeform-Signature',
    },
    credencial: [
      {
        chave: 'token',
        rotulo: 'Personal Token do Typeform',
        secreto: true,
        obrigatorio: true,
        descricao:
          'No Typeform: Account > Your Settings > Personal tokens > "Generate a new token" (precisa dos escopos Forms: read e Webhooks: read/write).',
      },
    ],
    login: 'TYPEFORM',
    buscaCampos: true,
    escolheFormulario: true,
    passoAPasso: {
      titulo: 'No Typeform',
      passos: [
        'Gere um Personal Token em Account > Your Settings > Personal tokens, com acesso a Forms e Webhooks, e informe aqui.',
        'Escolha o formulário: o CRM registra sozinho o webhook nele (você não precisa mexer na aba Connect > Webhooks).',
        'Cada pergunta chega pelo "ref" dela; o título aparece na tela de mapeamento. Campos ocultos chegam como hidden.<nome> e variáveis como variables.<nome>.',
        'Para mover o negócio de etapa, como no Clint, crie em Workflow > Variables uma variável com o nome exato da etapa de destino e valor 1 (o CRM entende sozinho). Para atualizar negócios pelo Typeform, também dá para criar uma variável chamada etapa (com o nome ou a posição da etapa), status ou dono, e mapeie variables.etapa, variables.status e variables.dono.',
        'Se o token expirar ou for revogado, a integração passa para "precisa de atenção" e o Admin é avisado: gere outro token e atualize a credencial.',
      ],
    },
    modelo: {
      nome: 'Typeform',
      descricao:
        'Apelidos nome, email e telefone (a primeira pergunta do tipo), UTMs por campos ocultos (hidden.utm_*) e as variáveis etapa, status e dono.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'nome'),
        ...regras('email', 'email'),
        ...regras('telefone', 'telefone'),
        ...utmsDeCaminhos('hidden.'),
        ...regras('etapa', 'variables.etapa'),
        ...regras('status', 'variables.status'),
        ...regras('dono', 'variables.dono'),
      ]),
      exemplo: {
        event_id: '01HZX7Y2K9',
        form_id: 'lT9uwa',
        nome: 'Maria Souza',
        email: 'maria@empresa.com.br',
        telefone: '+5511987654321',
        hidden: { utm_source: 'instagram' },
        variables: { etapa: 'Qualificação' },
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: normalizarTypeform,
  verificarAutenticidade: verificar,
  lerCredencial(entrada) {
    const token = typeof entrada.token === 'string' ? entrada.token.trim() : '';
    if (!token) {
      return {
        problemas: [{ campo: 'credencial.token', mensagem: 'é obrigatório' }],
      };
    }
    if (token.length > 500) {
      return {
        problemas: [
          {
            campo: 'credencial.token',
            mensagem: 'deve ter no máximo 500 caracteres',
          },
        ],
      };
    }
    return { credencial: { token } };
  },
  testarCredencial: testarTokenDoTypeform,
  async buscarCampos(credencial, configuracao, http) {
    const formularioId = configuracao.formularioId;
    if (typeof formularioId !== 'string' || !formularioId) {
      return [];
    }
    return buscarCamposDoFormulario(credencial, http, formularioId);
  },
};
