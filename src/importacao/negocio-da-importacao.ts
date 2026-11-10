/**
 * Resolução do negócio de cada linha (R16.12): funil e etapa por nome
 * normalizado (sem acento, caixa nem espaços extras), com o cartão "Negócio
 * para todos" como padrão, e o responsável por e-mail ou nome. Funções puras
 * sobre dados já carregados (o processador guarda o cache por importação).
 */
import type { Area } from '../generated/prisma/client';
import { normalizarTextoDoFiltro } from './filtro-de-linhas';
import type { NegocioParaTodos } from './opcoes';

export interface EtapaDoCache {
  id: string;
  nome: string;
  tipo: string;
}

export interface FunilDoCache {
  id: string;
  nome: string;
  ativo: boolean;
  area: Area;
  /** Na ordem do funil. */
  etapas: EtapaDoCache[];
}

export interface DestinoDoNegocio {
  funil: FunilDoCache;
  etapa: EtapaDoCache;
}

export type ResolucaoDoDestino =
  | { destino: DestinoDoNegocio; aviso?: undefined }
  | { destino?: undefined; aviso: string }
  | { destino?: undefined; aviso?: undefined };

function funilPorNome(
  funis: readonly FunilDoCache[],
  nome: string,
): FunilDoCache | undefined {
  const alvo = normalizarTextoDoFiltro(nome);
  const iguais = funis.filter((f) => normalizarTextoDoFiltro(f.nome) === alvo);
  return iguais.find((f) => f.ativo) ?? iguais[0];
}

/** A etapa de entrada do funil: a primeira etapa aberta (a mesma da criação manual). */
export function etapaDeEntrada(funil: FunilDoCache): EtapaDoCache | undefined {
  return funil.etapas.find((e) => e.tipo === 'ABERTA');
}

/**
 * Destino do negócio de uma linha. Colunas de funil e etapa têm prioridade;
 * só funil → etapa de entrada; só etapa → procura no funil do cartão; nada →
 * funil e etapa do cartão; nada em lugar nenhum → `{}` (sem negócio). Quando
 * não dá para criar, devolve o `aviso` (sem o prefixo "Negócio não criado").
 */
export function resolverDestino(entrada: {
  funis: readonly FunilDoCache[];
  cartao: NegocioParaTodos | null;
  funilTexto?: string;
  etapaTexto?: string;
  podeVerArea: (area: Area) => boolean;
}): ResolucaoDoDestino {
  const { funis, cartao } = entrada;
  const funilTexto = entrada.funilTexto?.trim() ?? '';
  const etapaTexto = entrada.etapaTexto?.trim() ?? '';
  if (!funilTexto && !etapaTexto && !cartao) {
    return {};
  }
  let funil: FunilDoCache | undefined;
  if (funilTexto) {
    funil = funilPorNome(funis, funilTexto);
    if (!funil) {
      return { aviso: `funil "${funilTexto}" não encontrado.` };
    }
  } else {
    if (!cartao) {
      return { aviso: `informe o funil da etapa "${etapaTexto}".` };
    }
    funil = funis.find((f) => f.id === cartao.funilId);
    if (!funil) {
      return {
        aviso: 'o funil do cartão "Negócio para todos" não existe mais.',
      };
    }
  }
  if (!funil.ativo) {
    return { aviso: `funil "${funil.nome}" está arquivado.` };
  }
  if (!entrada.podeVerArea(funil.area)) {
    return {
      aviso: `sem permissão para criar negócios no funil "${funil.nome}".`,
    };
  }
  let etapa: EtapaDoCache | undefined;
  if (etapaTexto) {
    const alvo = normalizarTextoDoFiltro(etapaTexto);
    etapa = funil.etapas.find((e) => normalizarTextoDoFiltro(e.nome) === alvo);
    if (!etapa) {
      return {
        aviso: `etapa "${etapaTexto}" não encontrada no funil "${funil.nome}".`,
      };
    }
  } else if (!funilTexto && cartao) {
    etapa = funil.etapas.find((e) => e.id === cartao.etapaId);
    if (!etapa) {
      return {
        aviso: 'a etapa do cartão "Negócio para todos" não existe mais.',
      };
    }
  } else {
    etapa = etapaDeEntrada(funil);
    if (!etapa) {
      return { aviso: `o funil "${funil.nome}" não tem etapa aberta.` };
    }
  }
  if (etapa.tipo === 'PERDIDO') {
    return {
      aviso: `a etapa "${etapa.nome}" é de perda e exige motivo.`,
    };
  }
  return { destino: { funil, etapa } };
}

export interface UsuarioDoCache {
  id: string;
  nome: string;
  email: string;
  papel: string;
}

export type ResolucaoDoResponsavel =
  | { usuario: UsuarioDoCache; aviso?: undefined }
  | { usuario?: undefined; aviso: string };

/** Usuário ativo por e-mail exato (sem caixa) ou por nome normalizado (único). */
export function resolverResponsavel(
  texto: string,
  usuarios: readonly UsuarioDoCache[],
): ResolucaoDoResponsavel {
  const t = texto.trim();
  const porEmail = usuarios.find(
    (u) => u.email.trim().toLowerCase() === t.toLowerCase(),
  );
  if (porEmail) {
    return { usuario: porEmail };
  }
  const alvo = normalizarTextoDoFiltro(t);
  const iguais = usuarios.filter(
    (u) => normalizarTextoDoFiltro(u.nome) === alvo,
  );
  if (iguais.length === 1) {
    return { usuario: iguais[0] };
  }
  return {
    aviso:
      iguais.length > 1
        ? `Responsável "${t}" é ambíguo (mais de uma pessoa com esse nome); usada a estratégia da importação.`
        : `Responsável "${t}" não encontrado; usada a estratégia da importação.`,
  };
}
