import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ArquivosModule } from '../arquivos/arquivos.module';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { ComumModule } from '../comum/comum.module';
import { CriptografiaService } from '../comum/criptografia/criptografia.service';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { AmbienteModule } from '../config/ambiente.module';
import { FilaModule } from '../fila/fila.module';
import { LogsModule } from '../logs/logs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { GerenciadorDeNumeros } from './gerenciador-de-numeros.service';
import { GatewayController } from './http/gateway.controller';
import { TokenInternoGuard } from './http/token-interno.guard';
import { ConversorDeMidia } from './midia/conversor-de-midia';
import { RELOGIO_DO_GATEWAY, RELOGIO_REAL } from './relogio';
import { FABRICA_DE_TRANSPORTE } from './transporte/transporte';
import { TransporteBaileys } from './transporte/transporte-baileys';
import { TransporteSimulado } from './transporte/transporte-simulado';

/**
 * Módulo raiz do processo do gateway de WhatsApp (`node dist/whatsapp/main.js`).
 *
 * Usa a infraestrutura da API (ambiente, Prisma, logs técnicos, criptografia,
 * fila, auditoria, arquivos), mas **não** o `EventosModule`: o trabalhador da
 * outbox fica só na API (aqui ele entregaria os eventos sem os manipuladores
 * dela). O que o gateway avisa à API vai pela fila `whatsapp.evento`.
 */
@Module({})
export class GatewayWhatsappModule {
  static forRoot(ambiente: Ambiente): DynamicModule {
    return {
      module: GatewayWhatsappModule,
      imports: [
        AmbienteModule.forRoot(ambiente),
        PrismaModule,
        LogsModule,
        ComumModule,
        FilaModule,
        AuditoriaModule,
        ArquivosModule,
      ],
      controllers: [GatewayController],
      providers: [
        {
          provide: FABRICA_DE_TRANSPORTE,
          inject: [AMBIENTE, PrismaService, CriptografiaService],
          useFactory: (
            configuracao: Ambiente,
            prisma: PrismaService,
            cripto: CriptografiaService,
          ) =>
            configuracao.whatsapp.simulado
              ? new TransporteSimulado()
              : new TransporteBaileys({
                  prisma,
                  cripto,
                  logger: new Logger('Baileys'),
                }),
        },
        { provide: ConversorDeMidia, useValue: new ConversorDeMidia() },
        { provide: RELOGIO_DO_GATEWAY, useValue: RELOGIO_REAL },
        GerenciadorDeNumeros,
        { provide: APP_GUARD, useClass: TokenInternoGuard },
      ],
    };
  }
}
