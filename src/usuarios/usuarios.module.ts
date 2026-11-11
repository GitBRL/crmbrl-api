import { Module } from '@nestjs/common';
import { DesligamentoController } from './desligamento.controller';
import { DesligamentoService } from './desligamento.service';
import { FotoDePerfilController } from './foto-de-perfil.controller';
import { FotoDePerfilService } from './foto-de-perfil.service';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';

/**
 * Usuários, papéis e hierarquia (R1), senha temporária e convite (R2.8),
 * desligamento com encaminhamento e reativação (R7), a visão de equipe e a
 * própria foto de perfil (R2.10).
 *
 * Usa os serviços globais da base (Prisma, auditoria, eventos, notificações,
 * sessões e senhas). O desligamento altera atividades, negócios, contatos,
 * empresas e rodízios direto pelo Prisma, na própria transação — não depende
 * dos módulos donos dessas tabelas.
 */
@Module({
  // A rota fixa `usuarios/eu/foto` vem antes das de `usuarios/:id`.
  controllers: [
    FotoDePerfilController,
    UsuariosController,
    DesligamentoController,
  ],
  providers: [UsuariosService, DesligamentoService, FotoDePerfilService],
  exports: [UsuariosService],
})
export class UsuariosModule {}
