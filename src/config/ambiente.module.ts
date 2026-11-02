import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AMBIENTE, type Ambiente } from './ambiente';

/** Disponibiliza o ambiente já validado (token `AMBIENTE`) para todos os módulos. */
@Global()
@Module({})
export class AmbienteModule {
  static forRoot(ambiente: Ambiente): DynamicModule {
    return {
      module: AmbienteModule,
      providers: [{ provide: AMBIENTE, useValue: ambiente }],
      exports: [AMBIENTE],
    };
  }
}
