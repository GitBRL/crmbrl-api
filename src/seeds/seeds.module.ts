import { Module } from '@nestjs/common';
import { SeedsService } from './seeds.service';

/** Configuração inicial idempotente (funis-base, passagens, rodízios e Admin inicial). */
@Module({
  providers: [SeedsService],
  exports: [SeedsService],
})
export class SeedsModule {}
