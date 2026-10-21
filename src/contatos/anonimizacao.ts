/**
 * Anonimização de contato (R4.6, LGPD): exclusão lógica que apaga os dados
 * pessoais e mantém o que não identifica ninguém (tipo da origem, UTM,
 * conversões, responsável), para as métricas continuarem corretas.
 */
import { Prisma } from '../generated/prisma/client';
import type { Contato } from '../generated/prisma/client';
import { NOME_DO_CONTATO_ANONIMIZADO } from './contatos.constantes';

/** Campos pessoais que a anonimização apaga (vão, sem valores, para a auditoria). */
export const CAMPOS_ANONIMIZADOS = [
  'nome',
  'email',
  'telefone',
  'cargo',
  'empresaId',
  'primeiraOrigemDetalhe',
  'ultimaOrigemDetalhe',
  'etiquetas',
  'camposPersonalizados',
  'consentimentoEm',
  'consentimentoOrigem',
] as const;

/**
 * Dados do `UPDATE` que anonimiza o contato. O gatilho do banco só deixa mudar
 * a primeira origem junto com `excluidoEm` — aqui só o detalhe (texto livre) é
 * limpo; tipo e UTM ficam. O opt-out é ligado por segurança: o contato não
 * volta a receber marketing nem se o registro for reaproveitado.
 */
export function dadosDaAnonimizacao(
  contato: Pick<Contato, 'optOutEm'>,
  agora: Date,
): Prisma.ContatoUncheckedUpdateInput {
  return {
    nome: NOME_DO_CONTATO_ANONIMIZADO,
    email: null,
    telefone: null,
    cargo: null,
    empresaId: null,
    primeiraOrigemDetalhe: null,
    ultimaOrigemDetalhe: null,
    etiquetas: [],
    camposPersonalizados: {},
    optOutMarketing: true,
    optOutEm: contato.optOutEm ?? agora,
    consentimentoEm: null,
    consentimentoOrigem: null,
    excluidoEm: agora,
  };
}

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Termos que identificam o contato nos textos ligados a ele (títulos de
 * negócios e atividades): nome, e-mail e telefone (com e sem o 55).
 */
export function termosPessoais(
  contato: Pick<Contato, 'nome' | 'email' | 'telefone'>,
): string[] {
  const termos = [contato.nome, contato.email ?? ''];
  if (contato.telefone) {
    termos.push(contato.telefone);
    if (contato.telefone.startsWith('55')) {
      termos.push(contato.telefone.slice(2));
    }
  }
  return termos
    .map((termo) => termo.trim())
    .filter((termo) => termo.length >= 3);
}

/**
 * Troca, num texto, as ocorrências dos termos (palavra inteira, sem
 * diferenciar maiúsculas) pelo substituto. Os termos mais longos vão
 * primeiro, para o e-mail `maria@x.com` não virar `Contato anonimizado@x.com`
 * por causa do nome "Maria".
 *
 * ```ts
 * anonimizarTexto('Ligar para Maria Souza', ['Maria Souza'], 'Contato anonimizado')
 * // 'Ligar para Contato anonimizado'
 * ```
 */
export function anonimizarTexto(
  texto: string,
  termos: readonly string[],
  substituto: string = NOME_DO_CONTATO_ANONIMIZADO,
): string {
  let resultado = texto;
  const ordenados = [...termos].sort((a, b) => b.length - a.length);
  for (const termo of ordenados) {
    const padrao = new RegExp(
      `(?<![\\p{L}\\p{N}])${escaparRegex(termo)}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    resultado = resultado.replace(padrao, substituto);
  }
  return resultado;
}
