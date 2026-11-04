/** Registro dos aplicativos (R32.1): o adaptador de cada um e o catálogo. */
import type { AplicativoIntegracao } from '../../generated/prisma/client';
import { adaptadorActiveCampaign } from './active-campaign';
import { adaptadorEduzz } from './eduzz';
import { adaptadorElementor } from './elementor';
import { adaptadorFacebookLeadAds } from './facebook-lead-ads';
import { adaptadorGreatPages } from './great-pages';
import { adaptadorHotmart } from './hotmart';
import { adaptadorKiwify } from './kiwify';
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
  FACEBOOK_LEAD_ADS: adaptadorFacebookLeadAds,
  HOTMART: adaptadorHotmart,
  KIWIFY: adaptadorKiwify,
  EDUZZ: adaptadorEduzz,
};

/** O adaptador do aplicativo, ou `undefined` se ele ainda não está disponível. */
export function adaptadorDe(
  aplicativo: AplicativoIntegracao,
): AdaptadorDeAplicativo | undefined {
  return ADAPTADORES[aplicativo];
}

/** O catálogo em ordem alfabética (como a tela do Clint). */
export function catalogoDeAplicativos(): DefinicaoDoAplicativo[] {
  return Object.values(ADAPTADORES)
    .map((adaptador) => adaptador.definicao)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

export function definicaoDe(
  aplicativo: AplicativoIntegracao,
): DefinicaoDoAplicativo | undefined {
  return catalogoDeAplicativos().find((d) => d.aplicativo === aplicativo);
}
