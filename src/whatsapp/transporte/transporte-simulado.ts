import { createHash } from 'node:crypto';
import { FalhaDefinitivaDeEnvio } from '../../canais/adaptador-canal';
import { jidDoTelefone } from '../../canais/whatsapp/contrato-gateway';
import type {
  EnvioDoTransporte,
  FabricaDeTransporte,
  NumeroDaSessao,
  OuvinteDaSessao,
  SessaoWhatsapp,
} from './transporte';

/** Tempos do simulador (em ms). Os testes usam zeros. */
export interface TemposDoSimulador {
  /** Até o primeiro QR. */
  qr: number;
  /** Do QR até "conectar" (como se alguém tivesse lido o QR). */
  conexao: number;
  /** Do envio até "entregue". */
  entrega: number;
  /** Do envio até "lida". */
  leitura: number;
}

export const TEMPOS_PADRAO_DO_SIMULADOR: TemposDoSimulador = {
  qr: 500,
  conexao: 4_000,
  entrega: 1_500,
  leitura: 4_000,
};

/**
 * Telefones de mentira terminados em `0000` "não têm WhatsApp": a verificação
 * responde `existe: false` e o envio falha de vez — para testar esses casos.
 */
export function telefoneSemWhatsappNoSimulador(telefone: string): boolean {
  return telefone.replace(/\D/g, '').endsWith('0000');
}

/** Telefone fixo e plausível para o número simulado (DDD 11, celular). */
export function telefoneSimulado(numeroId: string): string {
  const digitos = BigInt(
    `0x${createHash('sha256').update(numeroId).digest('hex').slice(0, 12)}`,
  )
    .toString()
    .padStart(8, '0')
    .slice(-8);
  return `55119${digitos}`;
}

/**
 * Transporte simulado (`WHATSAPP_SIMULADO=true`): mesma interface do Baileys,
 * sem rede. Mostra um QR de mentira e "conecta" sozinho em segundos; o envio é
 * aceito e passa por entregue → lida. A entrada vem do `POST /simulador/receber`
 * do HTTP interno, que o `GerenciadorDeNumeros` trata como uma mensagem
 * recebida pelo número. Usado no ambiente dos agentes, nos testes e em
 * demonstrações.
 */
export class TransporteSimulado implements FabricaDeTransporte {
  readonly nome = 'simulado' as const;

  constructor(
    private readonly tempos: TemposDoSimulador = TEMPOS_PADRAO_DO_SIMULADOR,
  ) {}

  criar(numero: NumeroDaSessao, ouvinte: OuvinteDaSessao): SessaoWhatsapp {
    return new SessaoSimulada(numero, ouvinte, this.tempos);
  }
}

class SessaoSimulada implements SessaoWhatsapp {
  private readonly temporizadores = new Set<NodeJS.Timeout>();
  private qrs = 0;
  private conectada = false;

  constructor(
    private readonly numero: NumeroDaSessao,
    private readonly ouvinte: OuvinteDaSessao,
    private readonly tempos: TemposDoSimulador,
  ) {}

  iniciar(): Promise<void> {
    if (this.numero.jaConectado) {
      this.depois(Math.min(this.tempos.qr, 500), () => this.conectar());
      return Promise.resolve();
    }
    this.depois(this.tempos.qr, () => {
      this.qrs += 1;
      this.ouvinte.aoQr(
        `SIMULADO-CRMBRL:${this.numero.numeroId}:${this.qrs}:${Date.now()}`,
      );
      this.depois(this.tempos.conexao, () => this.conectar());
    });
    return Promise.resolve();
  }

  encerrar(): Promise<void> {
    this.conectada = false;
    for (const temporizador of this.temporizadores) {
      clearTimeout(temporizador);
    }
    this.temporizadores.clear();
    return Promise.resolve();
  }

  enviar(envio: EnvioDoTransporte): Promise<{ enviadaEm: Date }> {
    if (!this.conectada) {
      return Promise.reject(new Error('O número simulado não está conectado.'));
    }
    const telefone = envio.para.split('@')[0] ?? '';
    if (telefoneSemWhatsappNoSimulador(telefone)) {
      return Promise.reject(
        new FalhaDefinitivaDeEnvio(
          'Este número não tem WhatsApp.',
          'numero_sem_whatsapp',
        ),
      );
    }
    this.depois(this.tempos.entrega, () =>
      this.ouvinte.aoStatus(envio.idExterno, 'ENTREGUE', new Date()),
    );
    this.depois(Math.max(this.tempos.leitura, this.tempos.entrega), () =>
      this.ouvinte.aoStatus(envio.idExterno, 'LIDA', new Date()),
    );
    return Promise.resolve({ enviadaEm: new Date() });
  }

  verificar(
    telefone: string,
  ): Promise<{ existe: boolean; jid: string | null }> {
    const existe = !telefoneSemWhatsappNoSimulador(telefone);
    return Promise.resolve({
      existe,
      jid: existe ? jidDoTelefone(telefone) : null,
    });
  }

  digitando(): Promise<void> {
    return Promise.resolve();
  }

  private conectar(): void {
    this.conectada = true;
    const telefone =
      this.numero.telefone ?? telefoneSimulado(this.numero.numeroId);
    this.ouvinte.aoConectar({ telefone, jid: jidDoTelefone(telefone) });
  }

  private depois(ms: number, fn: () => void): void {
    const temporizador = setTimeout(() => {
      this.temporizadores.delete(temporizador);
      fn();
    }, ms);
    temporizador.unref();
    this.temporizadores.add(temporizador);
  }
}
