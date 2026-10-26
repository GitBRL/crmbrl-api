import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { SincronizacaoChatService } from './sincronizacao-chat.service';

/**
 * Acesso ao chat interno (R15) para os outros módulos da base: só os membros
 * de um canal entram na sala `chat:<canalId>` e baixam os anexos dele (contexto
 * `CHAT`, R11). Vale também para o Admin — as conversas diretas são privadas.
 */
@Injectable()
export class AcessoChatService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tempoReal: TempoRealService,
    private readonly arquivos: ArquivosService,
    private readonly sincronizacao: SincronizacaoChatService,
  ) {}

  onModuleInit(): void {
    this.tempoReal.registrarAutorizadorDeSala(
      'chat',
      async (usuario, canalId) => {
        // Os canais padrão acompanham o papel atual (R15.1).
        await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
        return this.ehMembro(usuario.id, canalId);
      },
    );
    this.arquivos.registrarVerificadorDeAcesso('CHAT', (usuario, arquivo) =>
      this.podeVerArquivo(usuario.id, arquivo.id),
    );
  }

  /** O usuário é membro do canal? */
  async ehMembro(usuarioId: string, canalId: string): Promise<boolean> {
    const membro = await this.prisma.chatMembro.findUnique({
      where: { canalId_usuarioId: { canalId, usuarioId } },
      select: { id: true },
    });
    return membro !== null;
  }

  /** Anexo de uma mensagem (não excluída) de um canal de que o usuário é membro? */
  async podeVerArquivo(usuarioId: string, arquivoId: string): Promise<boolean> {
    const mensagem = await this.prisma.chatMensagem.findFirst({
      where: {
        arquivoId,
        excluidaEm: null,
        canal: { membros: { some: { usuarioId } } },
      },
      select: { id: true },
    });
    return mensagem !== null;
  }
}
