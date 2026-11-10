/**
 * Resolução do negócio de cada linha (R16.12): funil e etapa por nome
 * normalizado (sem acento, caixa nem espaços extras), com o cartão "Negócio
 * para todos" como padrão, e o responsável por e-mail ou nome. Funções puras
 * sobre dados já carregados (o processador guarda o cache por importação).
 */
import { normalizarTextoDoFiltro } from './filtro-de-linhas';
import type { StatusDoNegocioImportado } from './dados-do-negocio';
import type {
  NegocioParaTodos,
  TraducaoDeEtapas,
  TraducaoDeFunis,
} from './opcoes';
import type { Area } from '../comum/dominio/setores';
import type { Papel } from '../generated/prisma/client';

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

export type ComoAchou = 'NOME' | 'TRADUCAO';
export type ProblemaDoFunil = 'NAO_ENCONTRADO' | 'ARQUIVADO' | 'SEM_PERMISSAO';
export type ProblemaDaEtapa = 'NAO_ENCONTRADA' | 'ETAPA_DE_PERDA';

export interface AchadoDoFunil {
  /** Presente quando o funil existe (mesmo arquivado ou sem permissão). */
  funil?: FunilDoCache;
  como: ComoAchou | null;
  problema: ProblemaDoFunil | null;
  /** A tradução escolhida aponta para um funil que não existe mais. */
  traducaoPerdida?: boolean;
}

/**
 * Funil de um valor da planilha (R16.14): a tradução escolhida pela pessoa vale
 * antes do nome; depois confere arquivado e permissão (R5.9).
 */
export function acharFunil(
  funis: readonly FunilDoCache[],
  texto: string,
  traducaoFunis: TraducaoDeFunis,
  podeVerArea: (area: Area) => boolean,
): AchadoDoFunil {
  const chave = normalizarTextoDoFiltro(texto);
  const traduzido = traducaoFunis[chave];
  let funil: FunilDoCache | undefined;
  let como: ComoAchou | null = null;
  if (traduzido) {
    funil = funis.find((f) => f.id === traduzido);
    if (!funil) {
      return { como: null, problema: 'NAO_ENCONTRADO', traducaoPerdida: true };
    }
    como = 'TRADUCAO';
  } else {
    funil = funilPorNome(funis, texto);
    if (!funil) {
      return { como: null, problema: 'NAO_ENCONTRADO' };
    }
    como = 'NOME';
  }
  if (!funil.ativo) {
    return { funil, como, problema: 'ARQUIVADO' };
  }
  if (!podeVerArea(funil.area)) {
    return { funil, como, problema: 'SEM_PERMISSAO' };
  }
  return { funil, como, problema: null };
}

export interface AchadoDaEtapa {
  etapa?: EtapaDoCache;
  como: ComoAchou | null;
  problema: ProblemaDaEtapa | null;
  traducaoPerdida?: boolean;
}

/** Etapa de um valor da planilha dentro do funil: tradução (R16.14) antes do nome. */
export function acharEtapa(
  funil: FunilDoCache,
  texto: string,
  traducaoEtapas: TraducaoDeEtapas,
): AchadoDaEtapa {
  const chave = normalizarTextoDoFiltro(texto);
  const traduzida = traducaoEtapas[funil.id]?.[chave];
  let etapa: EtapaDoCache | undefined;
  let como: ComoAchou;
  if (traduzida) {
    etapa = funil.etapas.find((e) => e.id === traduzida);
    if (!etapa) {
      return { como: null, problema: 'NAO_ENCONTRADA', traducaoPerdida: true };
    }
    como = 'TRADUCAO';
  } else {
    etapa = funil.etapas.find((e) => normalizarTextoDoFiltro(e.nome) === chave);
    if (!etapa) {
      return { como: null, problema: 'NAO_ENCONTRADA' };
    }
    como = 'NOME';
  }
  return {
    etapa,
    como,
    problema: etapa.tipo === 'PERDIDO' ? 'ETAPA_DE_PERDA' : null,
  };
}

/**
 * Destino do negócio de uma linha. Colunas de funil e etapa têm prioridade;
 * só funil → etapa de entrada; só etapa → procura no funil do cartão; nada →
 * funil e etapa do cartão; nada em lugar nenhum → `{}` (sem negócio). Quando
 * não dá para criar, devolve o `aviso` (sem o prefixo "Negócio não criado").
 * Negócio fechado (`status` GANHO ou PERDIDO, R16.14): o destino é a etapa de
 * ganho ou de perda do funil e a etapa da planilha não é usada.
 */
export function resolverDestino(entrada: {
  funis: readonly FunilDoCache[];
  cartao: NegocioParaTodos | null;
  funilTexto?: string;
  etapaTexto?: string;
  podeVerArea: (area: Area) => boolean;
  status?: StatusDoNegocioImportado;
  traducaoFunis?: TraducaoDeFunis;
  traducaoEtapas?: TraducaoDeEtapas;
}): ResolucaoDoDestino {
  const { funis, cartao } = entrada;
  const status = entrada.status ?? 'ABERTO';
  const funilTexto = entrada.funilTexto?.trim() ?? '';
  const etapaTexto = entrada.etapaTexto?.trim() ?? '';
  if (!funilTexto && !etapaTexto && !cartao) {
    return {};
  }
  let funil: FunilDoCache | undefined;
  if (funilTexto) {
    const achado = acharFunil(
      funis,
      funilTexto,
      entrada.traducaoFunis ?? {},
      entrada.podeVerArea,
    );
    if (achado.problema === 'NAO_ENCONTRADO') {
      return {
        aviso: achado.traducaoPerdida
          ? `o funil escolhido para "${funilTexto}" não existe mais.`
          : `funil "${funilTexto}" não encontrado.`,
      };
    }
    funil = achado.funil as FunilDoCache;
    if (achado.problema === 'ARQUIVADO') {
      return { aviso: `funil "${funil.nome}" está arquivado.` };
    }
    if (achado.problema === 'SEM_PERMISSAO') {
      return {
        aviso: `sem permissão para criar negócios no funil "${funil.nome}".`,
      };
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
    if (!funil.ativo) {
      return { aviso: `funil "${funil.nome}" está arquivado.` };
    }
    if (!entrada.podeVerArea(funil.area)) {
      return {
        aviso: `sem permissão para criar negócios no funil "${funil.nome}".`,
      };
    }
  }
  if (status !== 'ABERTO') {
    const fechamento = funil.etapas.find((e) => e.tipo === status);
    return fechamento
      ? { destino: { funil, etapa: fechamento } }
      : {
          aviso: `o funil "${funil.nome}" não tem etapa de ${status === 'GANHO' ? 'ganho' : 'perda'}.`,
        };
  }
  let etapa: EtapaDoCache | undefined;
  if (etapaTexto) {
    const achada = acharEtapa(funil, etapaTexto, entrada.traducaoEtapas ?? {});
    if (achada.problema === 'NAO_ENCONTRADA') {
      return {
        aviso: achada.traducaoPerdida
          ? `a etapa escolhida para "${etapaTexto}" não existe mais no funil "${funil.nome}".`
          : `etapa "${etapaTexto}" não encontrada no funil "${funil.nome}".`,
      };
    }
    etapa = achada.etapa;
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
  if (etapa && etapa.tipo === 'PERDIDO') {
    return {
      aviso: `a etapa "${etapa.nome}" é de perda e exige motivo.`,
    };
  }
  return { destino: { funil, etapa: etapa as EtapaDoCache } };
}

export interface UsuarioDoCache {
  id: string;
  nome: string;
  email: string;
  papel: Papel;
  area: Area | null;
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
