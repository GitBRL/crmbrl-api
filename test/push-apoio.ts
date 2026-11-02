/**
 * Apoio dos testes de push (R26): um serviço de push falso que guarda o que
 * recebeu e responde conforme o roteiro por endpoint (padrão: 201 ok).
 */
import type {
  AssinaturaDePush,
  ResultadoDoEnvio,
  ServicoDePush,
} from '../src/push/servico-de-push';
import type { CargaDoPush } from '../src/push/push.constantes';
import { generateVAPIDKeys } from 'web-push';

export interface EnvioFalso {
  endpoint: string;
  keys: AssinaturaDePush['keys'];
  carga: CargaDoPush;
}

export class ServicoDePushFalso implements ServicoDePush {
  readonly enviados: EnvioFalso[] = [];
  /** Próximas respostas por endpoint (a última se repete); sem roteiro, ok. */
  private readonly roteiros = new Map<string, ResultadoDoEnvio[]>();
  tentativas = 0;

  responder(endpoint: string, ...resultados: ResultadoDoEnvio[]): void {
    this.roteiros.set(endpoint, resultados);
  }

  limpar(): void {
    this.enviados.length = 0;
    this.roteiros.clear();
    this.tentativas = 0;
  }

  enviar(
    assinatura: AssinaturaDePush,
    carga: string,
  ): Promise<ResultadoDoEnvio> {
    this.tentativas++;
    const roteiro = this.roteiros.get(assinatura.endpoint);
    const resultado: ResultadoDoEnvio = roteiro
      ? ((roteiro.length > 1
          ? roteiro.shift()
          : roteiro[0]) as ResultadoDoEnvio)
      : { ok: true };
    if (resultado.ok) {
      this.enviados.push({
        endpoint: assinatura.endpoint,
        keys: assinatura.keys,
        carga: JSON.parse(carga) as CargaDoPush,
      });
    }
    return Promise.resolve(resultado);
  }
}

/** Chaves VAPID de teste (geradas na hora; nada fixo no repositório). */
export function variaveisDePush(): Record<string, string> {
  const chaves = generateVAPIDKeys();
  return {
    VAPID_CHAVE_PUBLICA: chaves.publicKey,
    VAPID_CHAVE_PRIVADA: chaves.privateKey,
    VAPID_ASSUNTO: 'mailto:push-teste@brl.local',
    WEBHOOKS_PERMITIR_REDE_INTERNA: 'true',
  };
}

let sequencia = 0;

/** Uma inscrição como o navegador a entregaria (chaves no formato certo). */
export function inscricaoDeTeste(aparelho = 'Chrome de teste') {
  sequencia++;
  return {
    endpoint: `https://127.0.0.1:9/push/aparelho-${sequencia}`,
    keys: {
      p256dh: `B${'p'.repeat(86)}`,
      auth: 'a'.repeat(22),
    },
    aparelho,
  };
}
