/**
 * DDI padrão da importação (R16.13): telefone sem `+`/`00` recebe o DDI
 * escolhido quando ainda não começa com ele. Com `55` vale a regra brasileira
 * de `normalizarTelefone` (R4.1), sem mudança. Função pura; não altera o
 * comportamento de `normalizarTelefone` para os outros módulos.
 */
import {
  normalizarTelefone,
  type ResultadoTelefone,
} from '../comum/dominio/telefone';

export const DDI_PADRAO = '55';
export const PADRAO_DDI = /^\d{1,3}$/;

export function normalizarTelefoneComDdi(
  entrada: string,
  ddiPadrao: string = DDI_PADRAO,
): ResultadoTelefone {
  if (ddiPadrao === DDI_PADRAO) {
    return normalizarTelefone(entrada);
  }
  const texto = entrada.trim();
  if (texto.startsWith('+') || texto.startsWith('00')) {
    return normalizarTelefone(texto);
  }
  const digitos = texto.replace(/\D/g, '').replace(/^0+/, '');
  if (digitos === '') {
    return { valido: false, motivo: 'Telefone vazio.' };
  }
  return normalizarTelefone(
    `+${digitos.startsWith(ddiPadrao) ? '' : ddiPadrao}${digitos}`,
  );
}
