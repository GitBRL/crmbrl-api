/**
 * Planilha modelo da importação (R16.10): a 1ª aba só tem o cabeçalho, com os
 * mesmos nomes que a importação reconhece sozinha; a 2ª ("Como preencher")
 * explica cada coluna. Função pura.
 */
import ExcelJS from 'exceljs';
import type { TipoImportacao } from '../generated/prisma/client';
import { camposDoTipo, type CampoDeImportacao } from './campos';
import { LIMITE_DE_LINHAS_DA_IMPORTACAO } from './importacao.constantes';

const NOME_DA_ABA: Record<TipoImportacao, string> = {
  CONTATOS: 'Contatos',
  EMPRESAS: 'Empresas',
  PARCELAS: 'Parcelas',
};

export const ABA_DE_AJUDA = 'Como preencher';

/** Tamanho máximo da planilha (igual à política de arquivos de importação). */
const TAMANHO_MAXIMO_EM_MB = 10;

const FORMATO_TEXTO = '@';
const FORMATO_DATA = 'dd/mm/yyyy';
const FORMATO_VALOR = '#,##0.00';

/** Colunas que o Excel estragaria (zeros à esquerda, notação científica). */
const CHAVES_DE_TEXTO = new Set([
  'telefone',
  'cnpj',
  'numero',
  'contrato',
  'pix',
  'uf',
]);
const CHAVES_DE_DATA = new Set(['vencimento', 'pagoEm']);
const CHAVES_DE_VALOR = new Set(['valor', 'valorPago']);

interface Orientacao {
  oQueColocar: string;
  exemplo: string;
}

const ORIENTACOES: Record<TipoImportacao, Record<string, Orientacao>> = {
  CONTATOS: {
    nome: { oQueColocar: 'Nome da pessoa.', exemplo: 'Maria Souza' },
    email: {
      oQueColocar: 'E-mail da pessoa.',
      exemplo: 'maria@exemplo.com.br',
    },
    telefone: {
      oQueColocar: 'Telefone com DDD, só números ou como preferir.',
      exemplo: '(61) 99999-0000',
    },
    cargo: { oQueColocar: 'Cargo ou função.', exemplo: 'Gerente comercial' },
    empresa: {
      oQueColocar: 'Nome da empresa onde a pessoa trabalha.',
      exemplo: 'Exemplo Ltda',
    },
    etiquetas: {
      oQueColocar: 'Uma ou mais etiquetas, separadas por vírgula.',
      exemplo: 'cliente, indicação',
    },
    'utm.source': {
      oQueColocar: 'De onde a pessoa veio (origem).',
      exemplo: 'google',
    },
    'utm.medium': { oQueColocar: 'Meio da campanha.', exemplo: 'cpc' },
    'utm.campaign': { oQueColocar: 'Nome da campanha.', exemplo: 'lancamento' },
    'utm.term': { oQueColocar: 'Palavra-chave da campanha.', exemplo: 'crm' },
    'utm.content': {
      oQueColocar: 'Variação do anúncio ou do link.',
      exemplo: 'banner-azul',
    },
    responsavel: {
      oQueColocar:
        'E-mail ou nome de um usuário ativo do CRM, dono do contato e do negócio.',
      exemplo: 'ana@exemplo.com.br',
    },
    'negocio.funil': {
      oQueColocar: 'Nome do funil em que o negócio entra.',
      exemplo: 'Vendas',
    },
    'negocio.etapa': {
      oQueColocar:
        'Nome da etapa do funil (sem a coluna, entra na primeira etapa aberta).',
      exemplo: 'Novo lead',
    },
    'negocio.titulo': {
      oQueColocar: 'Título do negócio (sem a coluna, vale o nome do contato).',
      exemplo: 'Proposta de implantação',
    },
    'negocio.valor': {
      oQueColocar: 'Valor do negócio em reais.',
      exemplo: '1.500,00',
    },
    'negocio.valorRecorrente': {
      oQueColocar: 'Valor recorrente (mensal) do negócio em reais.',
      exemplo: '300,00',
    },
  },
  EMPRESAS: {
    nome: { oQueColocar: 'Nome da empresa.', exemplo: 'Exemplo Ltda' },
    cnpj: {
      oQueColocar: 'CNPJ, com ou sem pontuação.',
      exemplo: '00.123.456/0001-00',
    },
    site: { oQueColocar: 'Endereço do site.', exemplo: 'www.exemplo.com.br' },
    email: {
      oQueColocar: 'E-mail da empresa.',
      exemplo: 'contato@exemplo.com.br',
    },
    telefone: {
      oQueColocar: 'Telefone com DDD.',
      exemplo: '(61) 3333-0000',
    },
    segmento: { oQueColocar: 'Ramo de atuação.', exemplo: 'Educação' },
    cidade: { oQueColocar: 'Cidade.', exemplo: 'Brasília' },
    uf: { oQueColocar: 'Sigla do estado.', exemplo: 'DF' },
    etiquetas: {
      oQueColocar: 'Uma ou mais etiquetas, separadas por vírgula.',
      exemplo: 'cliente, prioridade',
    },
  },
  PARCELAS: {
    numero: {
      oQueColocar:
        'Número que identifica o título. É a chave: repetir o número atualiza a parcela.',
      exemplo: '000123',
    },
    nome: { oQueColocar: 'Nome do cliente.', exemplo: 'Maria Souza' },
    telefone: {
      oQueColocar: 'Telefone do cliente com DDD.',
      exemplo: '(61) 99999-0000',
    },
    email: {
      oQueColocar: 'E-mail do cliente.',
      exemplo: 'maria@exemplo.com.br',
    },
    empresa: { oQueColocar: 'Empresa do cliente.', exemplo: 'Exemplo Ltda' },
    contrato: {
      oQueColocar: 'Código do contrato no CRM, se já existir.',
      exemplo: 'C-000012',
    },
    vencimento: {
      oQueColocar: 'Data de vencimento (dia/mês/ano).',
      exemplo: '10/12/2026',
    },
    valor: { oQueColocar: 'Valor da parcela em reais.', exemplo: '1.234,56' },
    status: {
      oQueColocar: 'Aberto, Pago ou Cancelado.',
      exemplo: 'Aberto',
    },
    pagoEm: {
      oQueColocar: 'Só se já foi paga: data do pagamento.',
      exemplo: '05/12/2026',
    },
    valorPago: {
      oQueColocar: 'Só se já foi paga: valor recebido.',
      exemplo: '1.234,56',
    },
    formaPagamento: {
      oQueColocar: 'Pix, Boleto, Cartão, Transferência, Dinheiro ou Outro.',
      exemplo: 'Pix',
    },
    linkBoleto: {
      oQueColocar: 'Endereço do boleto.',
      exemplo: 'https://exemplo.com.br/boleto/123',
    },
    linkPagamento: {
      oQueColocar: 'Endereço para pagar online.',
      exemplo: 'https://exemplo.com.br/pagar/123',
    },
    pix: { oQueColocar: 'Código Pix copia e cola.', exemplo: '00020126…' },
    descricao: {
      oQueColocar: 'Observação livre sobre a parcela.',
      exemplo: 'Mensalidade de dezembro',
    },
  },
};

const REGRAS_GERAIS: Record<TipoImportacao, string[]> = {
  CONTATOS: [
    'Cada linha é uma pessoa. Preencha o nome e, pelo menos, o e-mail ou o telefone.',
    'Para várias etiquetas na mesma célula, separe por vírgula (também vale ponto e vírgula ou barra vertical).',
  ],
  EMPRESAS: [
    'Cada linha é uma empresa. Só o nome é obrigatório.',
    'Para várias etiquetas na mesma célula, separe por vírgula (também vale ponto e vírgula ou barra vertical).',
  ],
  PARCELAS: [
    'Cada linha é uma parcela. O número do título é obrigatório e identifica a parcela.',
    'Datas: escreva dia/mês/ano (10/12/2026). Valores: 1.234,56 ou 1234,56.',
  ],
};

const REGRAS_COMUNS = [
  'Pode acrescentar outras colunas: na tela de importação, escolha "campo personalizado" para elas.',
  `A planilha aceita até ${LIMITE_DE_LINHAS_DA_IMPORTACAO.toLocaleString('pt-BR')} linhas e ${TAMANHO_MAXIMO_EM_MB} MB.`,
  'Não renomeie nem apague a primeira aba: é ela que o CRM lê. Esta aba de explicação é ignorada.',
];

function formatoDaColuna(campo: CampoDeImportacao): string | undefined {
  if (CHAVES_DE_TEXTO.has(campo.chave)) return FORMATO_TEXTO;
  if (CHAVES_DE_DATA.has(campo.chave)) return FORMATO_DATA;
  if (CHAVES_DE_VALOR.has(campo.chave)) return FORMATO_VALOR;
  return undefined;
}

export async function gerarPlanilhaModelo(
  tipo: TipoImportacao,
): Promise<Buffer> {
  const campos = camposDoTipo(tipo);
  const livro = new ExcelJS.Workbook();
  livro.created = new Date();

  const dados = livro.addWorksheet(NOME_DA_ABA[tipo], {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  dados.columns = campos.map((campo) => ({
    header: campo.rotulo,
    key: campo.chave,
    width: Math.max(18, campo.rotulo.length + 6),
  }));
  // Formato na coluna inteira (estilo de coluna, sem inflar o arquivo): o que a
  // pessoa digitar nas linhas de dados já entra no formato certo.
  campos.forEach((campo, i) => {
    const formato = formatoDaColuna(campo);
    if (formato) dados.getColumn(i + 1).numFmt = formato;
  });
  const cabecalho = dados.getRow(1);
  cabecalho.font = { bold: true };
  cabecalho.alignment = { vertical: 'middle' };
  cabecalho.height = 22;
  campos.forEach((campo, i) => {
    const celula = cabecalho.getCell(i + 1);
    // O formato da coluna não vale para o cabeçalho em si.
    celula.numFmt = 'General';
    if (campo.obrigatorio) {
      celula.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFE699' },
      };
      celula.note = 'Coluna obrigatória.';
    } else {
      celula.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEDEDED' },
      };
    }
  });

  const ajuda = livro.addWorksheet(ABA_DE_AJUDA);
  ajuda.columns = [
    { header: 'Coluna', key: 'coluna', width: 26 },
    { header: 'Obrigatória?', key: 'obrigatoria', width: 16 },
    { header: 'O que colocar', key: 'oQue', width: 60 },
    { header: 'Exemplo', key: 'exemplo', width: 34 },
  ];
  ajuda.getRow(1).font = { bold: true };
  ajuda.views = [{ state: 'frozen', ySplit: 1 }];
  for (const campo of campos) {
    const o = ORIENTACOES[tipo][campo.chave];
    ajuda.addRow({
      coluna: campo.rotulo,
      obrigatoria: campo.obrigatorio ? 'Sim' : 'Não',
      oQue: o?.oQueColocar ?? '',
      exemplo: o?.exemplo ?? '',
    });
  }
  ajuda.addRow({});
  ajuda.addRow({ coluna: 'Regras' }).font = { bold: true };
  for (const regra of [...REGRAS_GERAIS[tipo], ...REGRAS_COMUNS]) {
    const linha = ajuda.addRow({ coluna: regra });
    ajuda.mergeCells(linha.number, 1, linha.number, 4);
    linha.alignment = { wrapText: true, vertical: 'top' };
    linha.height = 32;
  }
  ajuda.eachRow((linha) => {
    if (linha.number <= campos.length + 1) {
      linha.alignment = { wrapText: true, vertical: 'top' };
    }
  });

  return Buffer.from(await livro.xlsx.writeBuffer());
}
