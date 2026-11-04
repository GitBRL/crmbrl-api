import {
  DICA_ATUALIZACAO,
  itemUnico,
  mapeamentoDe,
  regras,
  semAutenticidade,
  utmsDeCaminhos,
} from './comum';
import type { AdaptadorDeAplicativo } from './tipos';

/** Great Pages: o formulário envia por Webhook (POST, formulário ou JSON); as chaves são as "variáveis de integração" (R32.2). */
export const adaptadorGreatPages: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'GREAT_PAGES',
    nome: 'Great Pages',
    descricao:
      'Receba os leads dos formulários das páginas do Great Pages pela integração Webhook.',
    disponivel: true,
    entrega: 'WEBHOOK',
    tiposDeConteudo: ['application/x-www-form-urlencoded', 'application/json'],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'O Great Pages não assina o envio: a única proteção é o endereço secreto da integração.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: {
      titulo: 'No Great Pages',
      passos: [
        'Abra a página em "Editar design", selecione o formulário e clique em "Configurar" > "Configurar Integração".',
        'Escolha "Webhook", cole o endereço da integração e use o método Post.',
        'Na coluna "Variável de integração" o Great Pages mostra o nome de cada campo: use esses nomes no mapeamento (com "Adicionar campo", ou envie um teste e use "Atualizar campos recebidos").',
      ],
    },
    modelo: {
      nome: 'Great Pages',
      descricao:
        'Variáveis comuns (nome, email, telefone, empresa) e UTMs. Ajuste ao nome das suas variáveis de integração.',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'nome', 'name', 'Nome'),
        ...regras('email', 'email', 'Email', 'e-mail'),
        ...regras('telefone', 'telefone', 'phone', 'celular', 'whatsapp'),
        ...regras('empresa', 'empresa', 'company'),
        ...utmsDeCaminhos(''),
      ]),
      exemplo: {
        nome: 'Maria Souza',
        email: 'maria@empresa.com.br',
        telefone: '(11) 98765-4321',
        utm_source: 'facebook',
      },
    },
    dicas: [DICA_ATUALIZACAO],
  },
  normalizarCorpo: itemUnico,
  verificarAutenticidade: semAutenticidade,
};
