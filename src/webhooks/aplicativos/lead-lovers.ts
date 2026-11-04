import {
  DICA_ATUALIZACAO,
  itemUnico,
  mapeamentoDe,
  regras,
  semAutenticidade,
  utmsDeCaminhos,
} from './comum';
import type { AdaptadorDeAplicativo } from './tipos';

/** Lead Lovers: "HttpPost Simples" de um gatilho inteligente (POST, formulário ou JSON); o usuário digita os campos (R32.2). */
export const adaptadorLeadLovers: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'LEAD_LOVERS',
    nome: 'Lead Lovers',
    descricao:
      'Receba contatos do Lead Lovers por uma ação "HttpPost Simples" de um gatilho inteligente.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/x-www-form-urlencoded', 'application/json'],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'O Lead Lovers não assina o envio: a única proteção é o endereço secreto da integração.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No Lead Lovers',
      passos: [
        'Em Ferramentas > Gestão de contatos > Ações automatizadas, crie um "Novo gatilho inteligente".',
        'Defina os filtros (por exemplo, por tag) e, em Ações, escolha "HttpPost Simples".',
        'Cole o endereço da integração e use o tipo POST.',
        'Os nomes dos campos são os do formulário do Lead Lovers: digite cada um no mapeamento ("Adicionar campo") ou envie um teste e use "Atualizar campos recebidos".',
      ],
    },
    modelo: {
      nome: 'Lead Lovers',
      descricao:
        'Campos comuns (nome, email, telefone) e UTMs. Ajuste ao nome dos campos do seu formulário.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'nome', 'name', 'Nome'),
        ...regras('email', 'email', 'Email', 'e-mail'),
        ...regras('telefone', 'telefone', 'phone', 'celular', 'whatsapp'),
        ...regras('etiquetas', 'tags', 'tag'),
        ...utmsDeCaminhos(''),
      ]),
      exemplo: {
        nome: 'Maria Souza',
        email: 'maria@empresa.com.br',
        telefone: '(11) 98765-4321',
        tags: 'lead-quente',
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: itemUnico,
  verificarAutenticidade: semAutenticidade,
};
