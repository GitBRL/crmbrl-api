import { Module } from '@nestjs/common';
import { DesligamentoController } from './desligamento.controller';
import { DesligamentoService } from './desligamento.service';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';

/**
 * Usuários, papéis e hierarquia (R1), senha temporária e convite (R2.8),
 * desligamento com encaminhamento e reativação (R7) e a visão de equipe.
 *
 * Usa os serviços globais da base (Prisma, auditoria, eventos, notificações,
 * sessões e senhas). O desligamento altera atividades, negócios, contatos,
 * empresas e rodízios direto pelo Prisma, na própria transação — não depende
 * dos módulos donos dessas tabelas.
 */
@Module({
  controllers: [UsuariosController, DesligamentoController],
  providers: [UsuariosService, DesligamentoService],
  exports: [UsuariosService],
})
export class UsuariosModule {}
