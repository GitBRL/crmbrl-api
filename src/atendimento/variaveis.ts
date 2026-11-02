/**
 * Variáveis das respostas rápidas (R12): `{{contato.nome}}`, `{{usuario.primeiroNome}}`,
 * `{{saudacao}}`… O texto é aplicado à conversa na hora de usar (o compositor
 * mostra o resultado para a pessoa revisar antes de enviar).
 */
import { FUSO_HORARIO_PADRAO, partesLocais } from './horario';

export interface VariavelDisponivel {
  /** Como se escreve no texto, sem as chaves: `contato.nome`. */
  nome: string;
  descricao: string;
  exemplo: string;
}

/** As variáveis aceitas, na ordem em que a tela as oferece. */
export const VARIAVEIS_DISPONIVEIS: readonly VariavelDisponivel[] = [
  {
    nome: 'contato.nome',
    descricao: 'Nome completo do contato',
    exemplo: 'Maria Souza',
  },
  {
    nome: 'contato.primeiroNome',
    descricao: 'Primeiro nome do contato',
    exemplo: 'Maria',
  },
  {
    nome: 'contato.email',
    descricao: 'E-mail do contato',
    exemplo: 'maria@exemplo.com',
  },
  {
    nome: 'contato.telefone',
    descricao: 'Telefone do contato',
    exemplo: '(11) 98888-7777',
  },
  {
    nome: 'contato.empresa',
    descricao: 'Empresa do contato',
    exemplo: 'ACME Ltda.',
  },
  {
    nome: 'usuario.nome',
    descricao: 'Nome de quem está atendendo',
    exemplo: 'Ana Lima',
  },
  {
    nome: 'usuario.primeiroNome',
    descricao: 'Primeiro nome de quem está atendendo',
    exemplo: 'Ana',
  },
  {
    nome: 'canal.nome',
    descricao: 'Nome do canal da conversa',
    exemplo: 'WhatsApp Vendas',
  },
  {
    nome: 'saudacao',
    descricao: '"Bom dia", "Boa tarde" ou "Boa noite", pela hora',
    exemplo: 'Boa tarde',
  },
  {
    nome: 'data.hoje',
    descricao: 'Data de hoje (dd/mm/aaaa)',
    exemplo: '23/10/2026',
  },
];

const NOMES = new Set(VARIAVEIS_DISPONIVEIS.map((variavel) => variavel.nome));

/** `{{ nome }}`: letras, números, ponto e sublinhado. */
const VARIAVEL = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Nomes das variáveis usadas no texto (sem repetir, na ordem). */
export function variaveisDoTexto(texto: string): string[] {
  return [...new Set([...texto.matchAll(VARIAVEL)].map((item) => item[1]))];
}

/** Variáveis do texto que não existem (para recusar o cadastro com a lista). */
export function variaveisDesconhecidas(texto: string): string[] {
  return variaveisDoTexto(texto).filter((nome) => !NOMES.has(nome));
}

/** Troca as variáveis pelos valores (variável sem valor vira texto vazio). */
export function aplicarVariaveis(
  texto: string,
  valores: Readonly<Record<string, string | null | undefined>>,
): string {
  return texto.replace(VARIAVEL, (original, nome: string) =>
    NOMES.has(nome) ? (valores[nome] ?? '') : original,
  );
}

/** O que preenche as variáveis numa conversa. */
export interface DadosDasVariaveis {
  contato: {
    nome: string;
    email: string | null;
    telefone: string | null;
    empresa: string | null;
  };
  usuario: { nome: string };
  canal: { nome: string };
  agora?: Date;
  fusoHorario?: string;
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? '';
}

/** Telefone para leitura: `(11) 98888-7777` no Brasil, `+<dígitos>` fora. */
export function telefoneLegivel(telefone: string | null): string | null {
  if (!telefone) {
    return null;
  }
  const brasil = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(telefone);
  return brasil ? `(${brasil[1]}) ${brasil[2]}-${brasil[3]}` : `+${telefone}`;
}

/** Saudação pela hora local: 5h–11h59 bom dia, 12h–17h59 boa tarde, o resto boa noite. */
export function saudacao(hora: number): string {
  if (hora >= 5 && hora < 12) {
    return 'Bom dia';
  }
  return hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Os valores de todas as variáveis para uma conversa. */
export function valoresDasVariaveis(
  dados: DadosDasVariaveis,
): Record<string, string> {
  const agora = dados.agora ?? new Date();
  const local = partesLocais(agora, dados.fusoHorario ?? FUSO_HORARIO_PADRAO);
  const doisDigitos = (numero: number) => String(numero).padStart(2, '0');
  return {
    'contato.nome': dados.contato.nome,
    'contato.primeiroNome': primeiroNome(dados.contato.nome),
    'contato.email': dados.contato.email ?? '',
    'contato.telefone': telefoneLegivel(dados.contato.telefone) ?? '',
    'contato.empresa': dados.contato.empresa ?? '',
    'usuario.nome': dados.usuario.nome,
    'usuario.primeiroNome': primeiroNome(dados.usuario.nome),
    'canal.nome': dados.canal.nome,
    saudacao: saudacao(local.hora),
    'data.hoje': `${doisDigitos(local.dia)}/${doisDigitos(local.mes)}/${local.ano}`,
  };
}

/**
 * Atalho de resposta rápida como o banco exige (CHECK): sem a barra inicial,
 * em minúsculas, sem espaços nem barras, até 40 caracteres.
 */
export function normalizarAtalho(atalho: string): string {
  return atalho.trim().replace(/^\/+/, '').toLocaleLowerCase('pt-BR');
}

export const FORMATO_DO_ATALHO = /^[^\s/]{1,40}$/;
