import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AcessoAtendimentoService } from '../atendimento/acesso-atendimento.service';
import { ArquivosService } from '../arquivos/arquivos.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { NaoEncontradoException } from '../comum/erros/excecoes';
import { ehDiretoria } from '../comum/dominio/papeis';
import type { Arquivo, Campanha } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  filtroDeCampanhasVisiveis,
  podeVerCampanha,
} from './permissoes-disparos';

/**
 * Acesso às campanhas e aos arquivos dos disparos:
 *
 * - `obter`: a campanha, se a pessoa a vê (404 se não — não revela que existe);
 * - arquivos de contexto `CAMPANHA` (mídia): quem vê a campanha ou o modelo que
 *   usa o arquivo, ou a conversa em que a mensagem foi parar;
 * - arquivos de contexto `RELATORIO` (exportações): quem vê a campanha exportada
 *   (o vínculo está no evento de auditoria `campanha.exportada`).
 */
@Injectable()
export class AcessoDisparos implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly atendimento: AcessoAtendimentoService,
  ) {}

  onModuleInit(): void {
    this.arquivos.registrarVerificadorDeAcesso('CAMPANHA', (usuario, arquivo) =>
      this.podeVerMidia(usuario, arquivo),
    );
    this.arquivos.registrarVerificadorDeAcesso(
      'RELATORIO',
      (usuario, arquivo) => this.podeVerExportacao(usuario, arquivo),
    );
  }

  async obter(usuario: UsuarioAutenticado, id: string): Promise<Campanha> {
    const campanha = await this.prisma.campanha.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!campanha || !podeVerCampanha(usuario, campanha)) {
      throw new NaoEncontradoException('Campanha não encontrada.');
    }
    return campanha;
  }

  private async podeVerMidia(
    usuario: UsuarioAutenticado,
    arquivo: Arquivo,
  ): Promise<boolean> {
    const campanha = await this.prisma.campanha.findFirst({
      where: {
        arquivoId: arquivo.id,
        excluidoEm: null,
        ...filtroDeCampanhasVisiveis(usuario),
      },
      select: { id: true },
    });
    if (campanha) {
      return true;
    }
    // Modelos de mensagem: de todas as áreas, ou da área da pessoa; diretoria todos.
    const modelo = await this.prisma.modeloMensagem.findFirst({
      where: {
        arquivoId: arquivo.id,
        excluidoEm: null,
        ...(ehDiretoria(usuario.papel)
          ? {}
          : { OR: [{ area: null }, { area: usuario.area }] }),
      },
      select: { id: true },
    });
    if (modelo) {
      return true;
    }
    return this.atendimento.podeVerArquivo(usuario, arquivo.id);
  }

  private async podeVerExportacao(
    usuario: UsuarioAutenticado,
    arquivo: Arquivo,
  ): Promise<boolean> {
    const evento = await this.prisma.eventoAuditoria.findFirst({
      where: {
        acao: 'campanha.exportada',
        dados: { path: ['arquivoId'], equals: arquivo.id },
      },
      select: { entidadeId: true },
    });
    if (!evento?.entidadeId) {
      return false;
    }
    const campanha = await this.prisma.campanha.findFirst({
      where: { id: evento.entidadeId },
      select: { area: true, criadoPorId: true },
    });
    return campanha !== null && podeVerCampanha(usuario, campanha);
  }
}
