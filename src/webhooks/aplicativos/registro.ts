/** Registro dos aplicativos (R32.1): o adaptador de cada um e o catálogo, inclusive os que chegam na fatia H2. */
import type { AplicativoIntegracao } from '../../generated/prisma/client';
import { adaptadorActiveCampaign } from './active-campaign';
import { adaptadorElementor } from './elementor';
import { adaptadorGreatPages } from './great-pages';
import { adaptadorLeadLovers } from './lead-lovers';
import { adaptadorManyChat } from './manychat';
import { adaptadorRdStation } from './rd-station';
import type { AdaptadorDeAplicativo, DefinicaoDoAplicativo } from './tipos';
import { adaptadorTypeform } from './typeform';
import { adaptadorWebhook } from './webhook';

const ADAPTADORES: Readonly<
  Partial<Record<AplicativoIntegracao, AdaptadorDeAplicativo>>
> = {
  WEBHOOK: adaptadorWebhook,
  ELEMENTOR: adaptadorElementor,
  RD_STATION: adaptadorRdStation,
  ACTIVE_CAMPAIGN: adaptadorActiveCampaign,
  GREAT_PAGES: adaptadorGreatPages,
  LEAD_LOVERS: adaptadorLeadLovers,
  MANYCHAT: adaptadorManyChat,
  TYPEFORM: adaptadorTypeform,
};

function emBreve(
  aplicativo: AplicativoIntegracao,
  nome: string,
  descricao: string,
  entrega: 'WEBHOOK' | 'API',
): DefinicaoDoAplicativo {
  return {
    aplicativo,
    nome,
    descricao,
    disponivel: false,
    entrega,
    tiposDeConteudo: [],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao: 'Disponível na próxima etapa da Onda H.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: null,
    },
    credencial: null,
    buscaCampos: false,
    escolheFormulario: false,
    passoAPasso: { titulo: nome, passos: [] },
    modelo: null,
    dicas: [],
  };
}

/** Aplicativos já no enum e ainda sem adaptador (fatia H2). */
const EM_BREVE: readonly DefinicaoDoAplicativo[] = [
  emBreve(
    'FACEBOOK_LEAD_ADS',
    'Facebook Lead Ads',
    'Receba os leads dos formulários de anúncios do Facebook e do Instagram.',
    'API',
  ),
  emBreve(
    'HOTMART',
    'Hotmart',
    'Receba compras, carrinhos abandonados e assinaturas da Hotmart.',
    'WEBHOOK',
  ),
  emBreve(
    'KIWIFY',
    'Kiwify',
    'Receba compras, carrinhos abandonados e assinaturas da Kiwify.',
    'WEBHOOK',
  ),
  emBreve(
    'EDUZZ',
    'Eduzz',
    'Receba faturas, carrinhos abandonados e contratos da Eduzz.',
    'WEBHOOK',
  ),
];

/** O adaptador do aplicativo, ou `undefined` se ele ainda não está disponível. */
export function adaptadorDe(
  aplicativo: AplicativoIntegracao,
): AdaptadorDeAplicativo | undefined {
  return ADAPTADORES[aplicativo];
}

/** O catálogo em ordem alfabética (como a tela do Clint), com os que chegam depois marcados como indisponíveis. */
export function catalogoDeAplicativos(): DefinicaoDoAplicativo[] {
  const definicoes = [
    ...Object.values(ADAPTADORES).map((adaptador) => adaptador.definicao),
    ...EM_BREVE,
  ];
  return definicoes.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

export function definicaoDe(
  aplicativo: AplicativoIntegracao,
): DefinicaoDoAplicativo | undefined {
  return catalogoDeAplicativos().find((d) => d.aplicativo === aplicativo);
}
