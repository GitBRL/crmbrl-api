/**
 * Modelo de captação de alunos: a configuração inicial do SDR (critérios,
 * artigos de exemplo e persona). O Admin ajusta tudo depois; aplicar o modelo
 * de novo só acrescenta o que falta (por chave e por título), sem sobrescrever.
 */
import type {
  AlvoCriterioSdr,
  TipoCriterioSdr,
} from '../generated/prisma/client';

export interface CriterioDoModelo {
  chave: string;
  rotulo: string;
  instrucao: string;
  tipo: TipoCriterioSdr;
  opcoes: string[];
  alvo: AlvoCriterioSdr;
  campo: string | null;
  peso: number;
  obrigatorio: boolean;
}

export const CRITERIOS_DO_MODELO_DE_CAPTACAO: readonly CriterioDoModelo[] = [
  {
    chave: 'curso',
    rotulo: 'Curso de interesse',
    instrucao:
      'Descubra qual curso a pessoa quer fazer. Registre o nome do curso como a pessoa disse ou como está na base de conhecimento.',
    tipo: 'TEXTO',
    opcoes: [],
    alvo: 'NEGOCIO',
    campo: 'campos.curso',
    peso: 30,
    obrigatorio: true,
  },
  {
    chave: 'modalidade',
    rotulo: 'Modalidade',
    instrucao:
      'Descubra se a pessoa prefere estudar presencialmente, a distância ou no formato híbrido.',
    tipo: 'OPCAO',
    opcoes: ['Presencial', 'EAD', 'Híbrido'],
    alvo: 'NEGOCIO',
    campo: 'campos.modalidade',
    peso: 15,
    obrigatorio: true,
  },
  {
    chave: 'inicio',
    rotulo: 'Quando quer começar',
    instrucao:
      'Descubra quando a pessoa pretende começar. Registre uma data aproximada no formato AAAA-MM-DD (se só o mês foi dito, use o dia 1).',
    tipo: 'DATA',
    opcoes: [],
    alvo: 'NEGOCIO',
    campo: 'campos.inicio_previsto',
    peso: 20,
    obrigatorio: true,
  },
  {
    chave: 'cidade',
    rotulo: 'Cidade',
    instrucao:
      'Descubra em que cidade a pessoa mora ou onde pretende estudar (importante para o presencial).',
    tipo: 'TEXTO',
    opcoes: [],
    alvo: 'CONTATO',
    campo: 'campos.cidade',
    peso: 10,
    obrigatorio: false,
  },
  {
    chave: 'pagamento',
    rotulo: 'Forma de pagamento',
    instrucao:
      'Descubra como a pessoa pretende pagar (à vista, parcelado no cartão, boleto, financiamento ou bolsa). Não prometa condições que não estejam na base.',
    tipo: 'OPCAO',
    opcoes: ['À vista', 'Cartão parcelado', 'Boleto', 'Financiamento', 'Bolsa'],
    alvo: 'NEGOCIO',
    campo: 'campos.forma_de_pagamento',
    peso: 10,
    obrigatorio: false,
  },
  {
    chave: 'decisor',
    rotulo: 'Quem decide a matrícula',
    instrucao:
      'Descubra se a própria pessoa decide a matrícula (sim) ou se precisa da decisão de outra pessoa, como pais ou empresa (não).',
    tipo: 'SIM_NAO',
    opcoes: [],
    alvo: 'NEGOCIO',
    campo: 'campos.decide_sozinho',
    peso: 15,
    obrigatorio: false,
  },
];

export interface ArtigoDoModelo {
  titulo: string;
  conteudo: string;
}

/** Artigos de exemplo: o Admin troca pelos dados reais antes de ligar o SDR. */
export const ARTIGOS_DO_MODELO_DE_CAPTACAO: readonly ArtigoDoModelo[] = [
  {
    titulo: 'Como preencher esta base',
    conteudo:
      'Exemplo: troque este texto pelos dados reais da instituição. A IA só afirma preços, prazos e condições que estiverem escritos aqui; fora da base, ela diz que vai confirmar com a equipe.\n\nSugestão de artigos: cursos e modalidades, valores e formas de pagamento, datas de início das turmas, documentos para matrícula, endereço e horários, perguntas frequentes e o que a instituição não oferece.',
  },
  {
    titulo: 'Cursos e modalidades (exemplo)',
    conteudo:
      'Exemplo, substitua: oferecemos cursos de graduação e técnicos nas modalidades presencial, EAD e híbrida. Os cursos, as cargas horárias e as unidades devem ser listados aqui.',
  },
  {
    titulo: 'Valores e pagamento (exemplo)',
    conteudo:
      'Exemplo, substitua: informe aqui a mensalidade de cada curso, a taxa de matrícula, os descontos e as formas de pagamento aceitas. Sem valores nesta base, a IA não informa preço.',
  },
];

export const PERSONA_DO_MODELO_DE_CAPTACAO = {
  nomeAssistente: 'Bia',
  tom: 'Simpático, acolhedor e objetivo, como uma consultora de matrículas. Frases curtas, sem gírias.',
  apresentacao: 'Sou a Bia, assistente virtual da BRL.',
  mensagemPassagem:
    'Vou chamar uma pessoa da nossa equipe para continuar com você. Já passei o que conversamos, não precisa repetir.',
} as const;
