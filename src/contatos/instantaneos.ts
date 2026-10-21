/**
 * O que vai para a auditoria e para os eventos de domínio de contatos e
 * empresas (R3.1, R9.2). Os eventos levam o retrato completo do registro: é
 * o que os webhooks de saída entregam em `dados` (`contato.criado`,
 * `contato.atualizado`).
 */
import type {
  Contato,
  Empresa,
  OrigemContato,
} from '../generated/prisma/client';
import { objetoJson, utmDoJson } from './deduplicacao';

/** Campos do contato comparados na auditoria (antes/depois). */
export const CAMPOS_AUDITADOS_DO_CONTATO = [
  'nome',
  'email',
  'telefone',
  'cargo',
  'empresaId',
  'responsavelId',
  'primeiraOrigem',
  'primeiraOrigemDetalhe',
  'primeiraOrigemUtm',
  'ultimaOrigem',
  'ultimaOrigemDetalhe',
  'ultimaOrigemUtm',
  'conversoes',
  'etiquetas',
  'camposPersonalizados',
  'optOutMarketing',
  'optOutEm',
  'consentimentoEm',
  'consentimentoOrigem',
] as const satisfies readonly (keyof Contato)[];

/** Campos da empresa comparados na auditoria (antes/depois). */
export const CAMPOS_AUDITADOS_DA_EMPRESA = [
  'nome',
  'cnpj',
  'site',
  'email',
  'telefone',
  'segmento',
  'cidade',
  'uf',
  'responsavelId',
  'etiquetas',
  'camposPersonalizados',
] as const satisfies readonly (keyof Empresa)[];

const ROTULO_DA_ORIGEM: Readonly<Record<OrigemContato, string>> = {
  MANUAL: 'cadastro manual',
  WEBHOOK: 'webhook',
  WHATSAPP: 'WhatsApp',
  SITE: 'site',
  INDICACAO: 'indicação',
  IMPORTACAO: 'importação',
  PASSAGEM: 'passagem entre funis',
  OUTRO: 'outra origem',
};

/** `webhook (Landing Black Friday)`, `cadastro manual`… — para os resumos da auditoria. */
export function descreverOrigem(
  origem: OrigemContato,
  detalhe: string | null,
): string {
  const rotulo = ROTULO_DA_ORIGEM[origem];
  return detalhe ? `${rotulo} (${detalhe})` : rotulo;
}

/** Retrato do contato para os eventos de domínio (datas viram ISO na outbox). */
export function instantaneoDoContato(contato: Contato) {
  return {
    contatoId: contato.id,
    nome: contato.nome,
    email: contato.email,
    telefone: contato.telefone,
    cargo: contato.cargo,
    empresaId: contato.empresaId,
    responsavelId: contato.responsavelId,
    primeiraOrigem: {
      tipo: contato.primeiraOrigem,
      detalhe: contato.primeiraOrigemDetalhe,
      utm: utmDoJson(contato.primeiraOrigemUtm),
    },
    ultimaOrigem: {
      tipo: contato.ultimaOrigem,
      detalhe: contato.ultimaOrigemDetalhe,
      utm: utmDoJson(contato.ultimaOrigemUtm),
      em: contato.ultimaOrigemEm,
    },
    conversoes: contato.conversoes,
    etiquetas: contato.etiquetas,
    camposPersonalizados: objetoJson(contato.camposPersonalizados),
    optOutMarketing: contato.optOutMarketing,
    optOutEm: contato.optOutEm,
    consentimento:
      contato.consentimentoEm || contato.consentimentoOrigem
        ? { em: contato.consentimentoEm, origem: contato.consentimentoOrigem }
        : null,
    criadoEm: contato.criadoEm,
    atualizadoEm: contato.atualizadoEm,
  };
}

/** Retrato da empresa para os eventos de domínio. */
export function instantaneoDaEmpresa(empresa: Empresa) {
  return {
    empresaId: empresa.id,
    nome: empresa.nome,
    cnpj: empresa.cnpj,
    site: empresa.site,
    email: empresa.email,
    telefone: empresa.telefone,
    segmento: empresa.segmento,
    cidade: empresa.cidade,
    uf: empresa.uf,
    responsavelId: empresa.responsavelId,
    etiquetas: empresa.etiquetas,
    camposPersonalizados: objetoJson(empresa.camposPersonalizados),
    criadoEm: empresa.criadoEm,
    atualizadoEm: empresa.atualizadoEm,
  };
}
