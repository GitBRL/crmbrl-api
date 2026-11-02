import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { PrismaService } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import {
  filtroDeConversasVisiveis,
  podeUsarAtendimento,
  podeVerConversa,
  type UsuarioDoAtendimento,
} from './visibilidade';

/**
 * Acesso ao Atendimento (R12) para os outros módulos da base:
 *
 * - tempo real: quem pode entrar na sala `conversa:<id>` (`conversa.entrar`);
 * - arquivos: quem pode baixar a mídia de uma mensagem (contexto `MENSAGEM`,
 *   R11) — quem vê a conversa vê a mídia; anexos de respostas rápidas, quem usa
 *   o Atendimento.
 *
 * As regras ficam em `visibilidade.ts`.
 */
@Injectable()
export class AcessoAtendimentoService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tempoReal: TempoRealService,
    private readonly arquivos: ArquivosService,
  ) {}

  onModuleInit(): void {
    this.tempoReal.registrarAutorizadorDeSala('conversa', (usuario, id) =>
      this.podeVerConversaPorId(usuario, id),
    );
    this.arquivos.registrarVerificadorDeAcesso('MENSAGEM', (usuario, arquivo) =>
      this.podeVerArquivo(usuario, arquivo.id),
    );
  }

  /** O usuário vê a conversa? (Conversa inexistente: não.) */
  async podeVerConversaPorId(
    usuario: UsuarioDoAtendimento,
    conversaId: string,
  ): Promise<boolean> {
    if (!podeUsarAtendimento(usuario.papel)) {
      return false;
    }
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: conversaId },
      select: { responsavelId: true, fila: { select: { area: true } } },
    });
    return conversa !== null && podeVerConversa(usuario, conversa);
  }

  /** Mídia de mensagem (ou anexo de resposta rápida) que o usuário pode baixar? */
  async podeVerArquivo(
    usuario: UsuarioAutenticado,
    arquivoId: string,
  ): Promise<boolean> {
    const filtro = filtroDeConversasVisiveis(usuario);
    if (!filtro) {
      return false;
    }
    const mensagem = await this.prisma.mensagem.findFirst({
      where: { arquivoId, conversa: filtro },
      select: { id: true },
    });
    if (mensagem) {
      return true;
    }
    const resposta = await this.prisma.respostaRapida.findFirst({
      where: { arquivoId, excluidoEm: null },
      select: { id: true },
    });
    return resposta !== null;
  }
}
