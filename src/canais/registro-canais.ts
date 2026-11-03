import { Injectable } from '@nestjs/common';
import { ServicoIndisponivelException } from '../comum/erros/excecoes';
import type { Canal, Conversa, TipoCanal } from '../generated/prisma/client';
import type { AdaptadorCanal, PermissaoDeResposta } from './adaptador-canal';

/** Nome de cada tipo de canal, para mensagens. */
export const ROTULO_DO_TIPO_DE_CANAL: Readonly<Record<TipoCanal, string>> = {
  WHATSAPP: 'WhatsApp',
  WEBCHAT: 'chat do site',
  EMAIL: 'e-mail',
  INSTAGRAM: 'Instagram',
  MESSENGER: 'Messenger',
  WHATSAPP_OFICIAL: 'WhatsApp oficial',
};

/**
 * Registro dos adaptadores de canal (um por tipo). Cada módulo de canal se
 * registra no `onModuleInit`; o Atendimento pede o adaptador pelo tipo do canal
 * da conversa.
 *
 * ```ts
 * const adaptador = this.registro.obter(canal.tipo);
 * const resultado = await adaptador.enviar(mensagem, conversa, canal);
 * ```
 *
 * Nos testes, `substituir(adaptadorFalso)` troca o adaptador real e devolve a
 * função que desfaz a troca.
 */
@Injectable()
export class RegistroCanais {
  private readonly adaptadores = new Map<TipoCanal, AdaptadorCanal>();

  /** Registra o adaptador do tipo. Dois para o mesmo tipo é erro de programação. */
  registrar(adaptador: AdaptadorCanal): void {
    if (this.adaptadores.has(adaptador.tipo)) {
      throw new Error(
        `Já existe um adaptador de canal registrado para ${adaptador.tipo}.`,
      );
    }
    this.adaptadores.set(adaptador.tipo, adaptador);
  }

  /** Troca o adaptador do tipo (testes); a função devolvida restaura o anterior. */
  substituir(adaptador: AdaptadorCanal): () => void {
    const anterior = this.adaptadores.get(adaptador.tipo);
    this.adaptadores.set(adaptador.tipo, adaptador);
    return () => {
      if (anterior) {
        this.adaptadores.set(adaptador.tipo, anterior);
      } else {
        this.adaptadores.delete(adaptador.tipo);
      }
    };
  }

  /** O adaptador do tipo; 503 se nenhum módulo o registrou. */
  obter(tipo: TipoCanal): AdaptadorCanal {
    const adaptador = this.adaptadores.get(tipo);
    if (!adaptador) {
      throw new ServicoIndisponivelException(
        `O canal ${ROTULO_DO_TIPO_DE_CANAL[tipo]} não está disponível nesta instalação.`,
        { tipo },
      );
    }
    return adaptador;
  }

  /** O adaptador do tipo, se houver. */
  buscar(tipo: TipoCanal): AdaptadorCanal | undefined {
    return this.adaptadores.get(tipo);
  }

  /** Tipos com adaptador registrado. */
  tipos(): TipoCanal[] {
    return [...this.adaptadores.keys()];
  }

  /** Se a conversa aceita resposta comum agora (sem a regra no adaptador: sim). */
  podeResponder(conversa: Conversa, canal: Canal): PermissaoDeResposta {
    const adaptador = this.adaptadores.get(canal.tipo);
    return adaptador?.podeResponder?.(conversa, canal) ?? { pode: true };
  }
}
