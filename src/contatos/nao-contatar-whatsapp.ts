import type { Contato } from '../generated/prisma/client';
import {
  CAMPO_NAO_CONTATAR_WHATSAPP,
  ETIQUETA_NAO_CONTATAR_WHATSAPP,
} from '../financeiro/financeiro.constantes';

/** O contato pediu para não ser cobrado por WhatsApp (R24.7)? */
export function naoContatarPorWhatsapp(
  contato: Pick<Contato, 'etiquetas' | 'camposPersonalizados'>,
): boolean {
  if (contato.etiquetas.includes(ETIQUETA_NAO_CONTATAR_WHATSAPP)) return true;
  const campos = contato.camposPersonalizados;
  if (campos && typeof campos === 'object' && !Array.isArray(campos)) {
    const v = (campos as Record<string, unknown>)[CAMPO_NAO_CONTATAR_WHATSAPP];
    return (
      v === true ||
      (typeof v === 'string' &&
        ['true', 'sim', '1', 'yes'].includes(v.trim().toLowerCase()))
    );
  }
  return false;
}
