/** "Reprocessar" (R30): refaz a conversão, a transcrição e o resumo (ou só o resumo) de uma ligação. */
import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { ehAdmin, ehLider } from '../../comum/dominio/papeis';
import {
  ConflitoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import { PrismaService } from '../../prisma/prisma.service';
import { ClienteWhisper } from '../../transcricao/cliente-whisper';
import { REGRA_TRANSCRICAO } from '../../transcricao/transcricao.constantes';
import { TranscricaoService } from '../../transcricao/transcricao.service';
import { LeituraDaGravacaoService } from './leitura-gravacao.service';

@Injectable()
export class ReprocessamentoDaGravacaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leitura: LeituraDaGravacaoService,
    private readonly transcricao: TranscricaoService,
    private readonly whisper: ClienteWhisper,
    private readonly auditoria: AuditoriaService,
  ) {}

  async reprocessar(
    usuario: UsuarioAutenticado,
    id: string,
    etapa: 'completo' | 'resumo' = 'completo',
  ): Promise<void> {
    const ligacao = await this.leitura.ligacaoVisivel(usuario, id);
    const dono = ligacao.atendenteId === usuario.id;
    if (!dono && !ehAdmin(usuario.papel) && !ehLider(usuario.papel)) {
      throw new SemPermissaoException(
        'Só o atendente da ligação, o Admin e os líderes reprocessam.',
        { regra: REGRA_TRANSCRICAO },
      );
    }
    const recusar = (motivo: string, mensagem: string): never => {
      throw new ConflitoException(mensagem, {
        regra: REGRA_TRANSCRICAO,
        motivo,
      });
    };
    if (ligacao.gravacaoRemovidaEm) {
      recusar(
        'gravacao_removida',
        'A gravação foi apagada pelo prazo de guarda.',
      );
    }
    if (!ligacao.gravacaoOriginalArquivoId || !ligacao.gravacaoFinalizadaEm) {
      recusar(
        'sem_gravacao',
        'Esta ligação não tem gravação para reprocessar.',
      );
    }
    if (
      ligacao.transcricaoSituacao === 'PROCESSANDO' ||
      ligacao.resumoSituacao === 'PROCESSANDO'
    ) {
      recusar('em_processamento', 'A ligação já está sendo processada.');
    }
    if (etapa === 'resumo' && ligacao.transcricaoSituacao !== 'PRONTA') {
      recusar('sem_transcricao', 'O resumo precisa da transcrição pronta.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.ligacao.update({
        where: { id },
        data:
          etapa === 'resumo'
            ? { resumoSituacao: 'PENDENTE', resumoErro: null }
            : {
                gravacaoErro: null,
                transcricaoSituacao: this.whisper.ligado
                  ? 'PENDENTE'
                  : 'DESATIVADA',
                transcricaoErro: null,
                resumoSituacao: this.whisper.ligado ? 'PENDENTE' : 'DESATIVADO',
                resumoErro: this.whisper.ligado
                  ? null
                  : 'A transcrição está desligada neste servidor.',
              },
      });
      await this.auditoria.registrar(tx, {
        acao: 'ligacao.reprocessada',
        entidade: 'ligacao',
        entidadeId: id,
        resumo: `Ligação reprocessada (${etapa})`,
        dados: { regra: REGRA_TRANSCRICAO, etapa },
        relacionados: { contato: ligacao.contatoId },
      });
    });
    if (etapa === 'resumo') {
      await this.transcricao.enfileirarResumo(id);
    } else {
      await this.transcricao.enfileirarProcessamento(id);
    }
  }
}
