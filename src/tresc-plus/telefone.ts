/**
 * Telefones e `identifier` do 3C+ (R34.3, R34.6): funções puras.
 *
 * O CRM guarda E.164 só com dígitos (`5511987654321`). O 3C+ usa o número nacional (a API "devolve
 * sem o 55"); se a discagem exige o DDI 55 é uma lacuna da referência (§11.6) — a decisão fica
 * aqui, num ponto só.
 */
import { normalizarTelefone } from '../comum/dominio/telefone';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Só os dígitos de um texto (ou `''`). */
export function somenteDigitos(valor: unknown): string {
  return typeof valor === 'string' || typeof valor === 'number'
    ? String(valor).replace(/\D/g, '')
    : '';
}

/**
 * Número como o 3C+ recebe (discagem e mailing): dígitos, sem o `55` de número brasileiro.
 * `null` se não tem de 7 a 15 dígitos.
 */
export function telefoneParaTresc(
  telefone: string | null | undefined,
): string | null {
  const digitos = somenteDigitos(telefone);
  const nacional =
    digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)
      ? digitos.slice(2)
      : digitos;
  return nacional.length >= 7 && nacional.length <= 15 ? nacional : null;
}

/** O número que o 3C+ informou, como E.164 do CRM (`null` se não dá para entender). */
export function telefoneDoTresc(valor: unknown): string | null {
  const digitos = somenteDigitos(valor);
  if (digitos === '') return null;
  const resultado = normalizarTelefone(digitos);
  if (resultado.valido) return resultado.telefone;
  return digitos.length >= 8 && digitos.length <= 15 && !digitos.startsWith('0')
    ? digitos
    : null;
}

/** `5511988887777` <-> `551188887777`: a outra forma de um celular brasileiro (com ou sem o nono dígito). */
export function outraFormaDoCelular(telefone: string): string | null {
  const comNove = /^55(\d{2})9(\d{8})$/.exec(telefone);
  if (comNove) return `55${comNove[1]}${comNove[2]}`;
  const semNove = /^55(\d{2})([6-9]\d{7})$/.exec(telefone);
  return semNove ? `55${semNove[1]}9${semNove[2]}` : null;
}

/** Todas as formas pelas quais o contato pode estar gravado para este número. */
export function variantesDoTelefone(valor: unknown): string[] {
  const base = telefoneDoTresc(valor);
  if (base === null) return [];
  const outra = outraFormaDoCelular(base);
  return outra ? [base, outra] : [base];
}

/**
 * `identifier` enviado ao discador: o id do negócio (ou do contato), um UUID. Na volta, o id é
 * procurado primeiro entre os negócios e depois entre os contatos.
 */
export function identifierDoDiscador(id: string): string {
  return id.toLowerCase();
}

/** O UUID dentro de um `identifier` devolvido pelo 3C+ (`null` se não é do CRM). */
export function lerIdentifier(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim().toLowerCase();
  return UUID.test(texto) ? texto : null;
}
