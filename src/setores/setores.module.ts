import { Global, Module } from '@nestjs/common';
import { SetoresController } from './setores.controller';
import { SetoresService } from './setores.service';

/**
 * Setores (R1.6–R1.11): CRUD, criação com funil-base, rodízio e líderes, e o
 * registro de nomes usado nos rótulos. Global para quem precisar do serviço;
 * as checagens simples (setor ativo, chaves ativas) ficam em
 * `setores-no-banco.ts`, sem injeção.
 */
@Global()
@Module({
  controllers: [SetoresController],
  providers: [SetoresService],
  exports: [SetoresService],
})
export class SetoresModule {}
