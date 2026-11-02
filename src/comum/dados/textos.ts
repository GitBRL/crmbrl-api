/** Um código de regra: `R4.6`, `R10.2` (e `R7`, numa lista entre parênteses). */
const CODIGO = String.raw`R\d+(?:\.\d+)?`;
/** `R4.6`, `R7.3, R7.4`, `R5.1 e R5.2`, `R8.2/R8.3`. */
const LISTA = String.raw`${CODIGO}(?:\s*(?:,|e|\/)\s*${CODIGO})*`;

/** O parêntese inteiro é só o código: "(R4.6)", "(regra R5.8)", "(R7.3, R7.4)". */
const SO_CODIGO = new RegExp(String.raw`\s*\((?:regras?\s+)?${LISTA}\)`, 'g');
/** Entre colchetes, como as mensagens antigas dos recebimentos: "… [R5.2]". */
const ENTRE_COLCHETES = new RegExp(String.raw`\s*\[${LISTA}\]`, 'g');
/** O código fecha um parêntese com texto: "(LGPD, R4.6)" → "(LGPD)". */
const CODIGO_NO_FIM = new RegExp(
  String.raw`,\s*(?:regras?\s+)?${LISTA}(?=\))`,
  'g',
);
const TEM_CODIGO = /\bR\d+\.\d+/;

/**
 * Tira dos textos lidos por quem usa o CRM os códigos internos das regras
 * ("Contato anonimizado pelo Admin (LGPD, R4.6)" → "Contato anonimizado pelo
 * Admin (LGPD)"). O código fica em `detalhes.regra` dos erros e nos `dados` da
 * auditoria; os textos novos já nascem sem ele. Serve para mostrar o que foi
 * gravado antes (a auditoria é só inclusão: o registro não muda, só a leitura).
 * O mesmo critério do `semCodigoDeRegra` do front.
 */
export function semCodigoDeRegra(texto: string): string;
export function semCodigoDeRegra(texto: string | null): string | null;
export function semCodigoDeRegra(texto: string | null): string | null {
  if (texto === null || !TEM_CODIGO.test(texto)) {
    return texto;
  }
  return texto
    .replace(CODIGO_NO_FIM, '')
    .replace(SO_CODIGO, '')
    .replace(ENTRE_COLCHETES, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}
