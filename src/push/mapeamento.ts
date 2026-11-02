import type { Notificacao } from '../generated/prisma/client';
import {
  type CargaDoPush,
  PREFERENCIA_POR_TIPO_DE_NOTIFICACAO,
  type TipoDePreferencia,
  URL_PADRAO_DO_PUSH,
} from './push.constantes';

/** A preferência que governa o tipo de notificação, ou `null` se ele não gera push. */
export function preferenciaDoTipo(tipo: string): TipoDePreferencia | null {
  return PREFERENCIA_POR_TIPO_DE_NOTIFICACAO[tipo] ?? null;
}

/** Só rotas internas do front (`/algo`); qualquer outra coisa volta para a lista de notificações. */
export function urlDoFront(link: string | null | undefined): string {
  if (
    !link ||
    !link.startsWith('/') ||
    link.startsWith('//') ||
    link.includes('\\') ||
    link.length > 500
  ) {
    return URL_PADRAO_DO_PUSH;
  }
  return link;
}

function cortar(texto: string, limite: number): string {
  return texto.length <= limite ? texto : `${texto.slice(0, limite - 1)}…`;
}

/** A carga do push de uma notificação interna. */
export function cargaDaNotificacao(
  notificacao: Pick<Notificacao, 'id' | 'tipo' | 'titulo' | 'texto' | 'link'>,
): CargaDoPush {
  const url = urlDoFront(notificacao.link);
  return {
    titulo: cortar(notificacao.titulo, 100),
    corpo: cortar(notificacao.texto ?? '', 200),
    url,
    tag: cortar(
      `${notificacao.tipo}:${notificacao.link ? url : notificacao.id}`,
      120,
    ),
    notificacaoId: notificacao.id,
  };
}
