import { Module } from '@nestjs/common';
import { SaudeController } from './saude.controller';
import { SaudeService } from './saude.service';

/** `GET /api/saude`: estado da API, do banco e das migrations. */
@Module({
  controllers: [SaudeController],
  providers: [SaudeService],
})
export class SaudeModule {}
