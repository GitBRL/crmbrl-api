import type { Alteracao } from '../comum/dados/sanitizar';

/** Nome legível de cada campo, para os resumos da auditoria. */
const ROTULOS: Readonly<Record<string, string>> = {
  nome: 'nome',
  email: 'e-mail',
  telefone: 'telefone',
  cargo: 'cargo',
  empresaId: 'empresa',
  responsavelId: 'responsável',
  etiquetas: 'etiquetas',
  camposPersonalizados: 'campos personalizados',
  optOutMarketing: 'opt-out de marketing',
  optOutEm: 'opt-out de marketing',
  consentimentoEm: 'consentimento',
  consentimentoOrigem: 'consentimento',
  cnpj: 'CNPJ',
  site: 'site',
  segmento: 'segmento',
  cidade: 'cidade',
  uf: 'UF',
};

/** `{ email, telefone, optOutEm, optOutMarketing }` → `"e-mail, telefone, opt-out de marketing"`. */
export function descreverAlteracoes(
  alteracoes: Readonly<Record<string, Alteracao>>,
): string {
  const rotulos = new Set(
    Object.keys(alteracoes).map((campo) => ROTULOS[campo] ?? campo),
  );
  return [...rotulos].join(', ');
}
