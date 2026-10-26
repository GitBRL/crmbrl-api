import { Injectable } from '@nestjs/common';
import { MuitasTentativasException } from '../../comum/erros/excecoes';

/** Uma regra de limite: no máximo `limite` usos a cada `janelaMs`. */
export interface RegraDeLimite {
  readonly limite: number;
  readonly janelaMs: number;
}

export interface ResultadoDoLimite {
  readonly permitido: boolean;
  /** Quanto falta para liberar (0 quando permitido). */
  readonly tentarEmSegundos: number;
}

interface Janela {
  inicio: number;
  usos: number;
  janelaMs: number;
}

/** A cada tantos usos, apaga as janelas vencidas (o mapa não cresce sem fim). */
const USOS_ENTRE_LIMPEZAS = 500;

/**
 * Limite de requisições em memória, por chave (janela fixa): usado nas rotas
 * públicas dos canais (chat do site, webhook da Meta), que não têm sessão.
 *
 * Vale por processo — a API roda numa instância só, como o tempo real
 * (documentado na ARQUITETURA). Com várias réplicas, cada uma conta a sua parte.
 *
 * ```ts
 * this.limitador.exigir(`webchat:ip:${ip}`, { limite: 60, janelaMs: 60_000 },
 *   'Muitas mensagens em pouco tempo.');
 * ```
 */
@Injectable()
export class LimitadorDeRequisicoes {
  private readonly janelas = new Map<string, Janela>();
  private usosDesdeALimpeza = 0;

  /** Conta um uso da chave e diz se ainda cabe na janela. */
  consumir(chave: string, regra: RegraDeLimite): ResultadoDoLimite {
    const agora = this.agora();
    this.limparDeTempoEmTempo(agora);
    let janela = this.janelas.get(chave);
    if (!janela || agora - janela.inicio >= janela.janelaMs) {
      janela = { inicio: agora, usos: 0, janelaMs: regra.janelaMs };
      this.janelas.set(chave, janela);
    }
    if (janela.usos >= regra.limite) {
      return {
        permitido: false,
        tentarEmSegundos: Math.max(
          1,
          Math.ceil((janela.inicio + janela.janelaMs - agora) / 1000),
        ),
      };
    }
    janela.usos += 1;
    return { permitido: true, tentarEmSegundos: 0 };
  }

  /** Como `consumir`, mas lança 429 (com `Retry-After`) quando passou do limite. */
  exigir(chave: string, regra: RegraDeLimite, mensagem: string): void {
    const resultado = this.consumir(chave, regra);
    if (!resultado.permitido) {
      throw new MuitasTentativasException(
        `${mensagem} Tente de novo em ${resultado.tentarEmSegundos} s.`,
        resultado.tentarEmSegundos,
      );
    }
  }

  /** Esquece tudo (testes). */
  zerar(): void {
    this.janelas.clear();
    this.usosDesdeALimpeza = 0;
  }

  /** O relógio (sobrescrito nos testes de unidade). */
  protected agora(): number {
    return Date.now();
  }

  private limparDeTempoEmTempo(agora: number): void {
    this.usosDesdeALimpeza += 1;
    if (this.usosDesdeALimpeza < USOS_ENTRE_LIMPEZAS) {
      return;
    }
    this.usosDesdeALimpeza = 0;
    for (const [chave, janela] of this.janelas) {
      if (agora - janela.inicio >= janela.janelaMs) {
        this.janelas.delete(chave);
      }
    }
  }
}
