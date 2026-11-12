import { TIPOS_ATIVIDADE_EM_MASSA } from './negocios-em-massa.tipos';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import type { AcaoEmMassa } from './dto/negocios-em-massa.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MOTIVO = 500;
const MAX_TITULO = 200;
const MAX_DESCRICAO = 5000;

export type DadosValidados =
  | { acao: 'MOVER'; etapaId: string; motivoPerda?: string }
  | { acao: 'RESPONSAVEL'; responsavelId: string | null }
  | { acao: 'GANHAR' }
  | { acao: 'PERDER'; motivoPerda: string }
  | { acao: 'ETIQUETAR' | 'DESETIQUETAR'; etiquetas: string[] }
  | {
      acao: 'ATIVIDADE';
      tipo: (typeof TIPOS_ATIVIDADE_EM_MASSA)[number];
      titulo: string;
      vencimento?: string;
      descricao?: string;
    }
  | {
      acao: 'DISCADOR';
      campanhaId: number;
      listaId?: number;
      nomeLista?: string;
    }
  | { acao: 'EXCLUIR' };

interface Problema {
  campo: string;
  mensagens: string[];
}

/**
 * Valida `dados` conforme a `acao` (R5.16) antes de tocar em qualquer negócio:
 * erro vira 400 com `detalhes.campos[].campo = 'dados.<campo>'`.
 */
export function validarDadosEmMassa(
  acao: AcaoEmMassa,
  bruto: Record<string, unknown> | undefined,
): DadosValidados {
  const dados = bruto ?? {};
  const problemas: Problema[] = [];
  const erro = (campo: string, mensagem: string) =>
    problemas.push({ campo: `dados.${campo}`, mensagens: [mensagem] });
  const texto = (campo: string, max: number, obrigatorio: boolean) => {
    const valor = dados[campo];
    if (valor === undefined || valor === null) {
      if (obrigatorio) {
        erro(campo, 'é obrigatório');
      }
      return undefined;
    }
    if (typeof valor !== 'string' || (obrigatorio && !valor.trim())) {
      erro(campo, obrigatorio ? 'é obrigatório' : 'deve ser um texto');
      return undefined;
    }
    if (valor.trim().length > max) {
      erro(campo, `deve ter no máximo ${max} caracteres`);
      return undefined;
    }
    return valor.trim() || undefined;
  };
  const uuid = (campo: string) => {
    const valor = dados[campo];
    if (typeof valor !== 'string' || !UUID.test(valor)) {
      erro(campo, 'deve ser um identificador (UUID) válido');
      return '';
    }
    return valor;
  };

  let resultado: DadosValidados = { acao: 'EXCLUIR' };
  switch (acao) {
    case 'MOVER': {
      const etapaId = uuid('etapaId');
      const motivoPerda = texto('motivoPerda', MAX_MOTIVO, false);
      resultado = { acao, etapaId, motivoPerda };
      break;
    }
    case 'RESPONSAVEL': {
      if (dados.responsavelId === null) {
        resultado = { acao, responsavelId: null };
      } else {
        resultado = { acao, responsavelId: uuid('responsavelId') };
      }
      break;
    }
    case 'PERDER':
      resultado = {
        acao,
        motivoPerda: texto('motivoPerda', MAX_MOTIVO, true) ?? '',
      };
      break;
    case 'ETIQUETAR':
    case 'DESETIQUETAR': {
      const lista = dados.etiquetas;
      if (!Array.isArray(lista) || lista.some((e) => typeof e !== 'string')) {
        erro('etiquetas', 'deve ser uma lista de textos');
        resultado = { acao, etiquetas: [] };
      } else {
        const etiquetas = normalizarEtiquetas(lista);
        if (etiquetas.length === 0) {
          erro('etiquetas', 'informe ao menos uma etiqueta');
        }
        resultado = { acao, etiquetas };
      }
      break;
    }
    case 'ATIVIDADE': {
      const tipo = dados.tipo;
      const permitidos: readonly unknown[] = TIPOS_ATIVIDADE_EM_MASSA;
      if (!permitidos.includes(tipo)) {
        erro(
          'tipo',
          `deve ser um destes valores: ${TIPOS_ATIVIDADE_EM_MASSA.join(', ')}`,
        );
      }
      const titulo = texto('titulo', MAX_TITULO, true) ?? '';
      const descricao = texto('descricao', MAX_DESCRICAO, false);
      let vencimento: string | undefined;
      if (dados.vencimento !== undefined && dados.vencimento !== null) {
        if (
          typeof dados.vencimento !== 'string' ||
          Number.isNaN(Date.parse(dados.vencimento)) ||
          !/(Z|[+-]\d{2}:?\d{2})$/.test(dados.vencimento)
        ) {
          erro('vencimento', 'deve ser uma data e hora com fuso');
        } else if (tipo === 'NOTA') {
          erro('vencimento', 'não vale para nota');
        } else {
          vencimento = dados.vencimento;
        }
      }
      resultado = {
        acao,
        tipo: tipo as (typeof TIPOS_ATIVIDADE_EM_MASSA)[number],
        titulo,
        vencimento,
        descricao,
      };
      break;
    }
    case 'DISCADOR': {
      const inteiro = (
        campo: string,
        obrigatorio: boolean,
      ): number | undefined => {
        const valor = dados[campo];
        if (valor === undefined || valor === null) {
          if (obrigatorio) erro(campo, 'é obrigatório');
          return undefined;
        }
        if (
          typeof valor !== 'number' ||
          !Number.isInteger(valor) ||
          valor < 1
        ) {
          erro(campo, 'deve ser um número inteiro maior que zero');
          return undefined;
        }
        return valor;
      };
      const campanhaId = inteiro('campanhaId', true) ?? 0;
      const listaId = inteiro('listaId', false);
      const nomeLista = texto('nomeLista', 120, false);
      if (listaId === undefined && !nomeLista) {
        erro('listaId', 'informe a lista ou o nome de uma lista nova');
      }
      resultado = { acao, campanhaId, listaId, nomeLista };
      break;
    }
    case 'GANHAR':
    case 'EXCLUIR':
      resultado = { acao };
      break;
  }
  if (problemas.length > 0) {
    throw new DadosInvalidosException(
      `Dados inválidos — ${problemas[0].campo}: ${problemas[0].mensagens[0]}.`,
      { campos: problemas },
    );
  }
  return resultado;
}
