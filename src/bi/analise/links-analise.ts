/**
 * Links das ações recomendadas (R21): só rotas conhecidas do front, só os
 * parâmetros que cada lista entende e só ids que vieram na entrada da análise.
 * O que não confere é retirado; um caminho desconhecido vira o próprio painel
 * do BI (com `ajustado: true`).
 */
import { PAINEIS_BI, type PainelBi } from '../bi.tipos';
import type { ClasseDeId } from './entrada-analise';

/** Como um parâmetro é conferido. */
type Parametro =
  | { tipo: 'id'; classe: ClasseDeId }
  | { tipo: 'opcao'; opcoes: readonly string[] }
  | { tipo: 'texto'; padrao?: RegExp };

interface RotaConhecida {
  /** Caminho, com `:segmento` para as partes variáveis. */
  modelo: string;
  descricao: string;
  /** Valores aceitos de cada `:segmento` (lista fixa ou id de uma classe). */
  segmentos?: Record<string, readonly string[] | ClasseDeId>;
  parametros?: Record<string, Parametro>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As listas que uma ação pode abrir (rotas de `crmbrl/src/app/app.routes.ts`). */
export const ROTAS_DOS_LINKS: readonly RotaConhecida[] = [
  {
    modelo: '/bi/:painel',
    descricao: 'Painel do BI.',
    segmentos: { painel: PAINEIS_BI },
  },
  {
    modelo: '/funis/:area',
    descricao:
      'Quadro do funil da área (marketing, comercial ou cs); `etapaId` destaca uma etapa, `funil` escolhe o funil.',
    segmentos: { area: ['marketing', 'comercial', 'cs'] },
    parametros: {
      etapaId: { tipo: 'id', classe: 'etapa' },
      funil: { tipo: 'id', classe: 'funil' },
    },
  },
  {
    modelo: '/atendimento',
    descricao: 'Caixa de conversas; `canalId` ou `filaId` filtram.',
    parametros: {
      canalId: { tipo: 'id', classe: 'canal' },
      filaId: { tipo: 'id', classe: 'fila' },
    },
  },
  {
    modelo: '/contatos',
    descricao:
      'Lista de contatos; `responsavel` (id de usuário ou `sem`), `origem`, `etiqueta`, `marketing` (optout|recebe), `uf`, `aba` (pessoas|empresas).',
    parametros: {
      aba: { tipo: 'opcao', opcoes: ['pessoas', 'empresas'] },
      responsavel: { tipo: 'id', classe: 'usuario' },
      origem: { tipo: 'texto' },
      etiqueta: { tipo: 'texto' },
      marketing: { tipo: 'opcao', opcoes: ['optout', 'recebe'] },
      uf: { tipo: 'texto', padrao: /^[A-Z]{2}$/ },
    },
  },
  {
    modelo: '/atividades',
    descricao: 'Atividades (atrasadas, de hoje, próximas).',
  },
  { modelo: '/disparos', descricao: 'Campanhas de disparo.' },
  {
    modelo: '/disparos/:id',
    descricao: 'Uma campanha de disparo (id da tabela de campanhas).',
    segmentos: { id: 'campanha' },
  },
  { modelo: '/financeiro/contratos', descricao: 'Contratos.' },
  {
    modelo: '/financeiro/parcelas',
    descricao: 'Parcelas a receber (abertas e atrasadas).',
  },
  { modelo: '/financeiro/indicadores', descricao: 'Indicadores financeiros.' },
  {
    modelo: '/financeiro/regua/:aba',
    descricao: 'Régua de cobrança (hoje, ligacoes, etapas).',
    segmentos: { aba: ['hoje', 'ligacoes', 'etapas'] },
  },
];

/** Link conferido, pronto para o `routerLink` + `queryParams` do front. */
export interface LinkConferido {
  caminho: string;
  parametros: Record<string, string>;
  rotulo: string;
  /** `true` quando algo do link do modelo foi retirado ou trocado. */
  ajustado: boolean;
}

/** Descrição das rotas para o prompt de sistema (fixa: entra no cache). */
export function descreverRotas(): string {
  return ROTAS_DOS_LINKS.map((rota) => {
    const params = rota.parametros
      ? ` Parâmetros: ${Object.keys(rota.parametros).join(', ')}.`
      : '';
    return `- ${rota.modelo} — ${rota.descricao}${params}`;
  }).join('\n');
}

function casarCaminho(
  rota: RotaConhecida,
  partes: string[],
  ids: ReadonlyMap<string, ClasseDeId>,
): boolean {
  const modelo = rota.modelo.split('/').filter(Boolean);
  if (modelo.length !== partes.length) {
    return false;
  }
  return modelo.every((segmento, i) => {
    if (!segmento.startsWith(':')) {
      return segmento === partes[i];
    }
    const regra = rota.segmentos?.[segmento.slice(1)];
    if (Array.isArray(regra)) {
      return regra.includes(partes[i]);
    }
    return UUID.test(partes[i]) && ids.get(partes[i]) === regra;
  });
}

function temCaractereDeControle(valor: string): boolean {
  for (let i = 0; i < valor.length; i++) {
    if (valor.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

function parametroValido(
  regra: Parametro,
  valor: string,
  ids: ReadonlyMap<string, ClasseDeId>,
): boolean {
  switch (regra.tipo) {
    case 'id':
      return (
        (regra.classe === 'usuario' && valor === 'sem') ||
        (UUID.test(valor) && ids.get(valor) === regra.classe)
      );
    case 'opcao':
      return regra.opcoes.includes(valor);
    case 'texto':
      return (
        valor.length > 0 &&
        valor.length <= 80 &&
        !temCaractereDeControle(valor) &&
        (!regra.padrao || regra.padrao.test(valor))
      );
  }
}

/**
 * Confere o link de uma ação. `ids` são os conhecidos da entrada; `painel` é
 * o destino de reserva quando o caminho não é de uma rota conhecida.
 */
export function conferirLink(
  link: string,
  rotulo: string,
  ids: ReadonlyMap<string, ClasseDeId>,
  painel: PainelBi,
): LinkConferido {
  const reserva: LinkConferido = {
    caminho: `/bi/${painel}`,
    parametros: {},
    rotulo: 'Ver o painel',
    ajustado: true,
  };
  const bruto = link.trim();
  if (
    !bruto.startsWith('/') ||
    bruto.startsWith('//') ||
    bruto.includes('\\')
  ) {
    return reserva;
  }
  let url: URL;
  try {
    url = new URL(bruto, 'http://crm.invalido');
  } catch {
    return reserva;
  }
  if (url.host !== 'crm.invalido') {
    return reserva;
  }
  let partes: string[];
  try {
    partes = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return reserva;
  }
  const rota = ROTAS_DOS_LINKS.find((r) => casarCaminho(r, partes, ids));
  if (!rota) {
    return reserva;
  }
  const parametros: Record<string, string> = {};
  let ajustado = url.hash !== '';
  for (const [nome, valor] of url.searchParams) {
    const regra = rota.parametros?.[nome];
    if (regra && parametroValido(regra, valor, ids) && !(nome in parametros)) {
      parametros[nome] = valor;
    } else {
      ajustado = true;
    }
  }
  return {
    caminho: `/${partes.join('/')}`,
    parametros,
    rotulo,
    ajustado,
  };
}
