import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import type { Arquivo } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { podeUsarChatbot } from './permissoes-chatbot';

/**
 * Acesso aos arquivos de contexto `CAMPANHA` usados como mídia nos passos de
 * mensagem do chatbot: quem configura o chatbot (Admin, C-level, líderes)
 * baixa a mídia que aparece no rascunho ou numa versão de fluxo.
 */
@Injectable()
export class AcessoChatbot implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
  ) {}

  onModuleInit(): void {
    this.arquivos.registrarVerificadorDeAcesso('CAMPANHA', (usuario, arquivo) =>
      this.podeVerMidia(usuario, arquivo),
    );
  }

  private async podeVerMidia(
    usuario: UsuarioAutenticado,
    arquivo: Arquivo,
  ): Promise<boolean> {
    if (!podeUsarChatbot(usuario)) {
      return false;
    }
    const padrao = `%"arquivoId": "${arquivo.id}"%`;
    const achados = await this.prisma.$queryRaw<Array<{ achou: number }>>`
      SELECT 1 AS achou FROM fluxos_chatbot
       WHERE excluido_em IS NULL AND rascunho::text LIKE ${padrao}
      UNION ALL
      SELECT 1 FROM fluxos_chatbot_versoes WHERE definicao::text LIKE ${padrao}
      LIMIT 1`;
    return achados.length > 0;
  }
}
