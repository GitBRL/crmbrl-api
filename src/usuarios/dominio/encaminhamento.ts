/**
 * Textos do encaminhamento por desligamento (R7.3, R7.4) — funções puras.
 */
import { rotuloDaArea, rotuloDoPapel } from '../../comum/dominio/papeis';
import type { Papel } from '../../generated/prisma/client';
import { juntarNomes } from './hierarquia';
import type { Area } from '../../comum/dominio/setores';

/** O que vai (ou foi) para o destinatário. */
export interface ContagensDeEncaminhamento {
  /** Atividades pendentes. */
  readonly atividades: number;
  /** Negócios abertos. */
  readonly negocios: number;
  readonly contatos: number;
  readonly empresas: number;
  /** Liderados ativos, que passam a responder ao destinatário. */
  readonly liderados: number;
  /** Webhooks de entrada e passagens com o usuário como responsável fixo. */
  readonly responsavelFixo: number;
}

/** `1 atividade`, `3 atividades`. */
export function quantidade(
  numero: number,
  singular: string,
  plural: string,
): string {
  return `${numero} ${numero === 1 ? singular : plural}`;
}

/**
 * "12 atividades e 3 negócios" — só o que não é zero, na ordem atividades,
 * negócios, contatos e empresas. Vazio se não há nada.
 */
export function descreverItens(contagens: ContagensDeEncaminhamento): string {
  const partes: string[] = [];
  if (contagens.atividades > 0) {
    partes.push(quantidade(contagens.atividades, 'atividade', 'atividades'));
  }
  if (contagens.negocios > 0) {
    partes.push(quantidade(contagens.negocios, 'negócio', 'negócios'));
  }
  if (contagens.contatos > 0) {
    partes.push(quantidade(contagens.contatos, 'contato', 'contatos'));
  }
  if (contagens.empresas > 0) {
    partes.push(quantidade(contagens.empresas, 'empresa', 'empresas'));
  }
  return juntarNomes(partes);
}

export interface TextoDeNotificacao {
  readonly titulo: string;
  readonly texto: string;
}

/**
 * A notificação do destinatário (R7.4): "Você recebeu 12 atividades e 3
 * negócios de Pedro." `null` quando não há nada para avisar.
 */
export function notificacaoDeItensRecebidos(
  desligadoNome: string,
  contagens: ContagensDeEncaminhamento,
  nomesDosLiderados: readonly string[] = [],
): TextoDeNotificacao | null {
  const frases: string[] = [];
  const itens = descreverItens(contagens);
  if (itens) {
    frases.push(`Você recebeu ${itens} de ${desligadoNome}.`);
  }
  if (contagens.responsavelFixo > 0) {
    frases.push(
      `Você também assumiu, no lugar de ${desligadoNome}, ${quantidade(
        contagens.responsavelFixo,
        'distribuição automática (webhook de entrada ou passagem)',
        'distribuições automáticas (webhooks de entrada e passagens)',
      )} com responsável fixo.`,
    );
  }
  if (contagens.liderados > 0) {
    const quem =
      nomesDosLiderados.length > 0 &&
      nomesDosLiderados.length === contagens.liderados
        ? juntarNomes(nomesDosLiderados)
        : quantidade(contagens.liderados, 'liderado', 'liderados');
    frases.push(
      `${quem} ${contagens.liderados === 1 ? 'passou' : 'passaram'} a responder a você até a definição de um novo líder.`,
    );
  }
  if (frases.length === 0) {
    return null;
  }
  return {
    titulo: `Itens recebidos de ${desligadoNome}`,
    texto: frases.join(' '),
  };
}

/** O alerta "equipe sem líder" para os Admins (R7.3). */
export function alertaDeEquipeSemLider(
  lider: { readonly nome: string; readonly papel: Papel; readonly area: Area },
  destinatarioNome: string,
  lideradosAtivos: number,
): TextoDeNotificacao {
  const area = rotuloDaArea(lider.area);
  const inicio = `Com o desligamento de ${lider.nome} (${rotuloDoPapel(lider.papel, lider.area)}), a equipe de ${area} ficou sem líder`;
  return {
    titulo: `Equipe sem líder: ${area}`,
    texto:
      lideradosAtivos > 0
        ? `${inicio}: ${quantidade(lideradosAtivos, 'liderado passou', 'liderados passaram')} a responder a ${destinatarioNome} até você definir um novo líder.`
        : `${inicio}. Defina um novo líder.`,
  };
}
