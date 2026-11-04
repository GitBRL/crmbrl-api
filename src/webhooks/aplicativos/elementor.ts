import {
  DICA_ATUALIZACAO,
  ehObjeto,
  itemUnico,
  mapeamentoDe,
  regras,
  semAutenticidade,
  textoOuNulo,
  utmsDeCaminhos,
} from './comum';
import type { AdaptadorDeAplicativo, ItemRecebido } from './tipos';

/**
 * Elementor Pro, ação "Webhook" do formulário. Com "Advanced Data" o corpo vem
 * (em formulário aninhado ou JSON) como `form[id|name]`, `fields[<id>][value|title|…]`
 * e `meta[…]`; sem ele, só `<id>=<valor>`. O campo vira `<id>` (R32.2).
 */
export function normalizarElementor(corpo: unknown): ItemRecebido[] {
  if (!ehObjeto(corpo)) {
    return itemUnico(corpo);
  }
  const campos = corpo.fields;
  if (!ehObjeto(campos)) {
    return itemUnico(corpo);
  }
  const plano: Record<string, unknown> = {};
  for (const [id, campo] of Object.entries(campos)) {
    if (ehObjeto(campo)) {
      const valor = campo.value ?? campo.raw_value;
      if (valor !== undefined) {
        plano[id] = valor;
      }
    } else if (campo !== undefined) {
      plano[id] = campo;
    }
  }
  const formulario = corpo.form;
  if (ehObjeto(formulario)) {
    const id = textoOuNulo(formulario.id);
    const nome = textoOuNulo(formulario.name);
    if (id) {
      plano.form_id = id;
    }
    if (nome) {
      plano.form_name = nome;
    }
  }
  const meta = corpo.meta;
  if (ehObjeto(meta)) {
    for (const chave of [
      'page_url',
      'remote_ip',
      'user_agent',
      'date',
      'time',
    ]) {
      const entrada = meta[chave];
      const valor = ehObjeto(entrada) ? textoOuNulo(entrada.value) : null;
      if (valor && !(`meta_${chave}` in plano)) {
        plano[`meta_${chave}`] = valor;
      }
    }
  }
  // Campo cujo id é igual a uma das chaves de apoio não é sobrescrito.
  for (const [chave, valor] of Object.entries(corpo)) {
    if (!['fields', 'form', 'meta'].includes(chave) && !(chave in plano)) {
      plano[chave] = valor;
    }
  }
  return [{ corpo: plano, rotulo: null }];
}

export const adaptadorElementor: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'ELEMENTOR',
    nome: 'Elementor',
    descricao:
      'Receba os envios dos formulários do Elementor Pro pela ação Webhook, com "Advanced Data".',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/x-www-form-urlencoded', 'application/json'],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'O Elementor não assina o envio: a única proteção é o endereço secreto da integração.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No Elementor',
      passos: [
        'Abra a página, edite o formulário e, em "Actions After Submit", adicione a ação "Webhook".',
        'Cole o endereço da integração em "Webhook URL" e ative "Advanced Data".',
        'Em "Form Fields", aba "Advanced", copie o ID de cada campo: o ID é o nome do campo no mapeamento.',
        'Para as UTMs, crie campos ocultos (Hidden) com o ID utm_source, utm_medium, utm_campaign, utm_term e utm_content e, em "Default Value", use "Request parameter" (Get) com o mesmo nome. Publique a página.',
        'Envie o formulário uma vez e use "Atualizar campos recebidos" para ver os IDs que chegaram.',
      ],
    },
    modelo: {
      nome: 'Elementor',
      descricao:
        'Campos com os IDs padrão do Elementor (name, email, phone/tel) e UTMs por campos ocultos. Ajuste os IDs ao seu formulário.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'name', 'nome', 'first_name'),
        ...regras('email', 'email', 'e-mail'),
        ...regras(
          'telefone',
          'phone',
          'telefone',
          'tel',
          'celular',
          'whatsapp',
        ),
        ...regras('empresa', 'company', 'empresa'),
        ...utmsDeCaminhos(''),
      ]),
      exemplo: {
        name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        phone: '(11) 98765-4321',
        message: 'Quero saber mais',
        utm_source: 'google',
        utm_medium: 'cpc',
        form_id: '3f8a1c2',
        form_name: 'Contato do site',
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: normalizarElementor,
  verificarAutenticidade: semAutenticidade,
};
