import {
  DICA_ATUALIZACAO,
  ehObjeto,
  mapeamentoDe,
  nomesDeLista,
  regras,
  semAutenticidade,
} from './comum';
import { chamarAplicativo } from './chamadas-http';
import type {
  AdaptadorDeAplicativo,
  CampoBuscado,
  Credencial,
  ItemRecebido,
} from './tipos';

/**
 * ManyChat, ação "Fazer uma consulta externa" (External Request, POST) com
 * "Full Contact Data": o objeto do contato, às vezes dentro de `data`/`contact`.
 * `custom_fields` pode ser objeto ou lista `{ name, value }`; vira o objeto
 * `custom_fields.<nome>`; `tags` (lista de `{ name }`) vira lista de nomes (R32.2).
 */
export function normalizarManyChat(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return [{ corpo, rotulo: null }];
  }
  const contato = ['data', 'contact', 'subscriber'].reduce<
    Record<string, unknown>
  >((atual, chave) => {
    const interno = corpo[chave];
    return atual === corpo && ehObjeto(interno) ? interno : atual;
  }, corpo);
  const normalizado: Record<string, unknown> = { ...contato };
  const personalizados = contato.custom_fields;
  if (Array.isArray(personalizados)) {
    const objeto: Record<string, unknown> = {};
    for (const campo of personalizados) {
      if (ehObjeto(campo) && typeof campo.name === 'string' && campo.name) {
        objeto[campo.name] = campo.value;
      }
    }
    normalizado.custom_fields = objeto;
  }
  if (Array.isArray(contato.tags)) {
    normalizado.tags = nomesDeLista(contato.tags);
  }
  return [{ corpo: normalizado, rotulo: null }];
}

const MENSAGEM_SEM_CONTATO =
  'O contato do ManyChat veio sem e-mail nem telefone (contato do Instagram só envia o nome e o @): colete e-mail ou telefone no fluxo, com um passo de "Coleta de Dados", antes da consulta externa.';

export const adaptadorManyChat: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'MANYCHAT',
    nome: 'ManyChat',
    descricao:
      'Receba os contatos dos fluxos do ManyChat pela ação "Fazer uma consulta externa" com Full Contact Data.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/json'],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'O ManyChat não assina a consulta externa: a única proteção é o endereço secreto da integração. A chave da API só serve para buscar os campos.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: [
      {
        chave: 'chaveApi',
        rotulo: 'Chave da API do ManyChat',
        secreto: true,
        obrigatorio: true,
        descricao: 'No ManyChat: Configurações > API > "Gerar chave".',
      },
    ],
    buscaCampos: true,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No ManyChat',
      passos: [
        'Copie a chave da API em Configurações > API e informe aqui: o CRM a usa só para buscar os campos personalizados.',
        'No fluxo (Automatização), escolha o gatilho e, em Ações, "Fazer uma consulta externa" (External Request) com o tipo POST.',
        'Cole o endereço da integração e, na aba Corpo, clique em "Adicionar Full Contact Data". Salve.',
        'Contatos do Instagram só trazem o nome e o @: use um passo de "Coleta de Dados" (tipo Texto) para pedir e-mail ou telefone e gravar num campo personalizado do ManyChat, antes da consulta externa.',
        'Use "Buscar campos da integração" para listar os campos personalizados e mapeá-los.',
      ],
    },
    modelo: {
      nome: 'ManyChat',
      descricao:
        'name, email, phone/whatsapp_phone, as etiquetas (tags) e os campos personalizados (custom_fields.*).',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'name', 'first_name'),
        ...regras('email', 'email'),
        ...regras('telefone', 'phone', 'whatsapp_phone'),
        ...regras('etiquetas', 'tags'),
        ...regras('camposPersonalizados.*', 'custom_fields.*'),
      ]),
      exemplo: {
        id: '4812345678',
        first_name: 'Maria',
        last_name: 'Souza',
        name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        phone: '+5511987654321',
        whatsapp_phone: '5511987654321',
        ig_username: 'maria.souza',
        tags: ['lead-quente'],
        custom_fields: { cidade: 'São Paulo' },
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: normalizarManyChat,
  verificarAutenticidade: semAutenticidade,
  explicarFaltaDeContato: () => MENSAGEM_SEM_CONTATO,
  lerCredencial(entrada) {
    const chave =
      typeof entrada.chaveApi === 'string' ? entrada.chaveApi.trim() : '';
    if (!chave) {
      return {
        problemas: [
          { campo: 'credencial.chaveApi', mensagem: 'é obrigatória' },
        ],
      };
    }
    if (chave.length > 500) {
      return {
        problemas: [
          {
            campo: 'credencial.chaveApi',
            mensagem: 'deve ter no máximo 500 caracteres',
          },
        ],
      };
    }
    return { credencial: { chaveApi: chave } };
  },
  async testarCredencial(credencial, http) {
    await consultarCamposPersonalizados(credencial, http);
  },
  async buscarCampos(credencial, _configuracao, http) {
    const personalizados = await consultarCamposPersonalizados(
      credencial,
      http,
    );
    const padrao: CampoBuscado[] = [
      { caminho: 'name', rotulo: 'Nome completo', tipo: 'text' },
      { caminho: 'first_name', rotulo: 'Primeiro nome', tipo: 'text' },
      { caminho: 'email', rotulo: 'E-mail', tipo: 'text' },
      { caminho: 'phone', rotulo: 'Telefone', tipo: 'text' },
      {
        caminho: 'whatsapp_phone',
        rotulo: 'Telefone do WhatsApp',
        tipo: 'text',
      },
      { caminho: 'ig_username', rotulo: 'Usuário do Instagram', tipo: 'text' },
      { caminho: 'tags', rotulo: 'Etiquetas', tipo: 'list' },
    ];
    return [...padrao, ...personalizados];
  },
};

async function consultarCamposPersonalizados(
  credencial: Credencial,
  http: Parameters<NonNullable<AdaptadorDeAplicativo['testarCredencial']>>[1],
): Promise<CampoBuscado[]> {
  const { dados } = await chamarAplicativo({
    buscar: http.buscar,
    url: `${http.manychatUrl}/fb/page/getCustomFields`,
    cabecalhos: { Authorization: `Bearer ${credencial.chaveApi}` },
    aplicativo: 'ManyChat',
  });
  const lista = ehObjeto(dados) && Array.isArray(dados.data) ? dados.data : [];
  return lista.flatMap((campo) =>
    ehObjeto(campo) && typeof campo.name === 'string' && campo.name
      ? [
          {
            caminho: `custom_fields.${campo.name}`,
            rotulo: campo.name,
            tipo: typeof campo.type === 'string' ? campo.type : null,
          },
        ]
      : [],
  );
}
