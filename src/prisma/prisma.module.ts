import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Acesso ao banco para a aplicação inteira: qualquer módulo injeta o `PrismaService`. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
