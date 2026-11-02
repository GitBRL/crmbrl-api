import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DRIVER_DE_ARQUIVOS } from '../../src/arquivos/drivers/driver-de-arquivos';
import {
  CABECALHO_TOKEN_INTERNO,
  FILA_EVENTOS_WHATSAPP,
  filaDeEnvio,
} from '../../src/canais/whatsapp/contrato-gateway';
import { FilaService } from '../../src/fila/fila.service';
import type { StatusWhatsapp } from '../../src/generated/prisma/client';
import { configurarGateway } from '../../src/whatsapp/aplicacao-gateway';
import { GatewayWhatsappModule } from '../../src/whatsapp/gateway-whatsapp.module';
import { GerenciadorDeNumeros } from '../../src/whatsapp/gerenciador-de-numeros.service';
import { FABRICA_DE_TRANSPORTE } from '../../src/whatsapp/transporte/transporte';
import {
  type TemposDoSimulador,
  TransporteSimulado,
} from '../../src/whatsapp/transporte/transporte-simulado';
import type { AppTeste } from './app-teste';
import { TOKEN_INTERNO_DE_TESTE } from './ambiente-teste';

/** O processo do gateway de WhatsApp, em modo simulado, dentro do teste. */
export interface GatewayTeste {
  readonly app: INestApplication<App>;
  readonly gerenciador: GerenciadorDeNumeros;
  readonly fila: FilaService;
  /** HTTP interno com o token: `gateway.pedir('post', '/numeros/<id>/conectar')`. */
  pedir(metodo: 'get' | 'post', caminho: string, corpo?: object): request.Test;
  /** HTTP interno sem o token (para testar a recusa). */
  pedirSemToken(metodo: 'get' | 'post', caminho: string): request.Test;
  /** Espera o número chegar ao status (os avisos do simulador são assíncronos). */
  aguardarStatus(
    numeroId: string,
    status: StatusWhatsapp,
    prazoMs?: number,
  ): Promise<void>;
  /** Roda agora os envios pendentes da fila do número (como o gateway faria). */
  drenarEnvios(numeroId: string): Promise<number>;
  fechar(): Promise<void>;
}

/**
 * Sobe o gateway (`GatewayWhatsappModule`) no mesmo banco de teste da API, com
 * o transporte simulado instantâneo (tempos zerados, salvo `tempos`) e o mesmo
 * armazenamento em memória da API (a mídia que ele salva, a API lê).
 *
 * Os eventos que ele publica ficam na fila `whatsapp.evento`: drene-os do lado
 * da API com `drenarFilas(t, FILA_EVENTOS_WHATSAPP)` (ou `drenarEventosDoGateway`).
 *
 * ```ts
 * const gateway = await criarGatewayTeste(t);
 * await gateway.pedir('post', `/numeros/${numero.id}/conectar`).expect(202);
 * await gateway.aguardarStatus(numero.id, 'CONECTADO');
 * await gateway.pedir('post', '/simulador/receber', { numeroId: numero.id, de: '11999990000', texto: 'Oi' }).expect(202);
 * await drenarEventosDoGateway(t);
 * ```
 */
export async function criarGatewayTeste(
  t: AppTeste,
  opcoes: { tempos?: Partial<TemposDoSimulador> } = {},
): Promise<GatewayTeste> {
  const modulo = await Test.createTestingModule({
    imports: [GatewayWhatsappModule.forRoot(t.ambiente)],
  })
    .overrideProvider(FABRICA_DE_TRANSPORTE)
    .useValue(
      new TransporteSimulado({
        qr: 0,
        conexao: 0,
        entrega: 0,
        leitura: 0,
        ...opcoes.tempos,
      }),
    )
    .overrideProvider(DRIVER_DE_ARQUIVOS)
    .useValue(t.arquivos)
    .compile();
  const app = modulo.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configurarGateway(app);
  await app.init();
  const servidor = app.getHttpServer() as App;
  const gerenciador = app.get(GerenciadorDeNumeros);
  const fila = app.get(FilaService);
  return {
    app: app as INestApplication<App>,
    gerenciador,
    fila,
    pedir: (metodo, caminho, corpo) => {
      const pedido = request(servidor)
        [metodo](caminho)
        .set(CABECALHO_TOKEN_INTERNO, TOKEN_INTERNO_DE_TESTE);
      return corpo === undefined ? pedido : pedido.send(corpo);
    },
    pedirSemToken: (metodo, caminho) => request(servidor)[metodo](caminho),
    aguardarStatus: async (numeroId, status, prazoMs = 5_000) => {
      const limite = Date.now() + prazoMs;
      for (;;) {
        await gerenciador.aguardarAvisos(numeroId);
        const estado = await gerenciador.estado(numeroId);
        if (estado.status === status) {
          return;
        }
        if (Date.now() > limite) {
          throw new Error(
            `O número ${numeroId} ficou em ${estado.status}, não em ${status}.`,
          );
        }
        await new Promise((resolver) => setTimeout(resolver, 20));
      }
    },
    drenarEnvios: (numeroId) => fila.drenar(filaDeEnvio(numeroId)),
    fechar: () => app.close(),
  };
}

/** Do lado da API: processa agora os eventos que o gateway publicou. */
export function drenarEventosDoGateway(t: AppTeste): Promise<number> {
  return t.fila.drenar(FILA_EVENTOS_WHATSAPP);
}
