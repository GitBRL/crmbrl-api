import { Injectable } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { PrismaService } from '../prisma/prisma.service';
import type { FotoDePerfilDto } from './dto/foto-de-perfil.dto';

/** Endereço das fotos enviadas pelo CRM: o próprio download de arquivos (abre com a sessão). */
export const PREFIXO_DA_FOTO = '/api/v1/arquivos/';

/** O id do arquivo de uma foto enviada pelo CRM; `null` para endereço externo ou sem foto. */
export function arquivoDaFoto(
  avatarUrl: string | null | undefined,
): string | null {
  if (!avatarUrl?.startsWith(PREFIXO_DA_FOTO)) {
    return null;
  }
  const id = avatarUrl.slice(PREFIXO_DA_FOTO.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/**
 * Foto de perfil pela própria pessoa (R2.10): qualquer usuário logado troca ou remove a sua.
 * A foto é um arquivo `AVATAR` que a própria pessoa enviou (`POST /arquivos?contexto=AVATAR`);
 * a anterior enviada pelo CRM é removida (sai do armazenamento). Audita `usuario.atualizado`.
 */
@Injectable()
export class FotoDePerfilService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
  ) {}

  async definir(
    usuario: UsuarioAutenticado,
    arquivoId: string | null,
  ): Promise<FotoDePerfilDto> {
    return this.prisma.$transaction(async (tx) => {
      const antes = await tx.usuario.findUnique({
        where: { id: usuario.id },
        select: { id: true, nome: true, avatarUrl: true },
      });
      if (!antes) {
        throw new NaoEncontradoException('Usuário não encontrado.');
      }
      let avatarUrl: string | null = null;
      if (arquivoId) {
        const arquivo = await tx.arquivo.findUnique({
          where: { id: arquivoId },
        });
        // Arquivo de outra pessoa é tratado como inexistente (não revela que existe).
        if (
          !arquivo ||
          arquivo.removidoEm ||
          arquivo.criadoPorId !== usuario.id
        ) {
          throw new NaoEncontradoException('Arquivo não encontrado.');
        }
        if (arquivo.contexto !== 'AVATAR') {
          throw new RegraVioladaException(
            'R2.10',
            'Esse arquivo não foi enviado como foto de perfil. Envie a imagem de novo pela tela do perfil.',
            { campo: 'arquivoId' },
          );
        }
        avatarUrl = `${PREFIXO_DA_FOTO}${arquivo.id}`;
      }
      if (avatarUrl === antes.avatarUrl) {
        return { avatarUrl };
      }
      await tx.usuario.update({
        where: { id: usuario.id },
        data: { avatarUrl },
      });
      await this.auditoria.registrar(tx, {
        acao: 'usuario.atualizado',
        entidade: 'usuario',
        entidadeId: usuario.id,
        resumo: avatarUrl
          ? `${antes.nome} trocou a foto de perfil`
          : `${antes.nome} removeu a foto de perfil`,
        dados: {
          alteracoes: calcularAlteracoes(antes, { avatarUrl }, ['avatarUrl']),
        },
      });
      // A foto anterior enviada pelo CRM não é usada em mais nada: sai do armazenamento.
      const anterior = arquivoDaFoto(antes.avatarUrl);
      if (anterior && anterior !== arquivoId) {
        await this.arquivos.remover(anterior, {
          tx,
          motivo: 'foto de perfil substituída',
        });
      }
      return { avatarUrl };
    });
  }
}
