/**
 * Leitura da gravação, da transcrição e do resumo (R30) e a privacidade (LGPD):
 *
 * - ouve e lê quem vê a ligação: o atendente, quem foi chamado, a diretoria, quem vê a conversa (R12)
 *   e quem tem o contato no seu alcance (responsável, líder da equipe);
 * - baixar o áudio, só Admin e líderes;
 * - reprodução e download são auditados (quem, quando e qual ligação);
 * - gravação removida pela guarda (ou pela anonimização) não existe mais: 404 `gravacao_removida`.
 */
import { Injectable } from '@nestjs/common';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { filtroDeConversasVisiveis } from '../../atendimento/visibilidade';
import { ehAdmin, ehDiretoria, ehLider } from '../../comum/dominio/papeis';
import {
  NaoEncontradoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import { PermissoesContatosService } from '../../contatos/permissoes-contatos.service';
import type { Arquivo, Ligacao } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  REGRA_TRANSCRICAO,
  type TranscricaoGravada,
} from '../../transcricao/transcricao.constantes';
import type { TranscricaoCompletaDto } from './gravacao.dto';
import { JANELA_DA_REPRODUCAO_MS } from './gravacao.constantes';

export type VersaoDoAudio = 'ouvir' | 'original';

@Injectable()
export class LeituraDaGravacaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly contatos: PermissoesContatosService,
  ) {}

  /** A ligação, se o usuário pode vê-la; senão 404 (não revela que existe). */
  async ligacaoVisivel(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<Ligacao> {
    const ligacao = await this.prisma.ligacao.findUnique({ where: { id } });
    if (!ligacao || !(await this.podeVer(usuario, ligacao))) {
      throw new NaoEncontradoException('Ligação não encontrada.');
    }
    return ligacao;
  }

  async podeVer(
    usuario: UsuarioAutenticado,
    ligacao: Ligacao,
  ): Promise<boolean> {
    if (
      ehDiretoria(usuario.papel) ||
      ligacao.atendenteId === usuario.id ||
      ligacao.tocouPara.includes(usuario.id)
    ) {
      return true;
    }
    const filtro = filtroDeConversasVisiveis(usuario);
    if (filtro && ligacao.conversaId) {
      const conversa = await this.prisma.conversa.findFirst({
        where: { id: ligacao.conversaId, ...filtro },
        select: { id: true },
      });
      if (conversa) {
        return true;
      }
    }
    const contato = await this.prisma.contato.findUnique({
      where: { id: ligacao.contatoId },
      select: { responsavelId: true },
    });
    if (!contato) {
      return false;
    }
    const alcance = await this.contatos.alcance(usuario);
    return alcance.permite(contato.responsavelId);
  }

  podeBaixar(usuario: UsuarioAutenticado): boolean {
    return ehAdmin(usuario.papel) || ehLider(usuario.papel);
  }

  // ---------------------------------------------------------------------------
  // Transcrição
  // ---------------------------------------------------------------------------

  async transcricao(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<TranscricaoCompletaDto> {
    const ligacao = await this.ligacaoVisivel(usuario, id);
    if (!ligacao.transcricaoSituacao) {
      throw new NaoEncontradoException(
        ligacao.gravacaoRemovidaEm
          ? 'A transcrição foi apagada pelo prazo de guarda.'
          : 'Esta ligação não tem transcrição.',
        {
          regra: REGRA_TRANSCRICAO,
          motivo: ligacao.gravacaoRemovidaEm
            ? 'gravacao_removida'
            : 'sem_transcricao',
        },
      );
    }
    const gravada = ligacao.transcricao as TranscricaoGravada | null;
    if (gravada) {
      await this.prisma.$transaction((tx) =>
        this.auditoria.registrar(tx, {
          acao: 'ligacao.transcricao-lida',
          entidade: 'ligacao',
          entidadeId: ligacao.id,
          resumo: 'Transcrição da ligação lida',
          dados: { regra: REGRA_TRANSCRICAO },
          relacionados: { contato: ligacao.contatoId },
        }),
      );
    }
    return {
      situacao: ligacao.transcricaoSituacao.toLowerCase(),
      erro: ligacao.transcricaoErro,
      modelo: gravada?.modelo ?? null,
      duracaoSegundos: gravada?.duracaoSegundos ?? null,
      trechos: gravada?.trechos ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Áudio
  // ---------------------------------------------------------------------------

  /**
   * O arquivo de áudio da ligação, conferida a permissão. `baixar` exige Admin ou líder (403).
   * A auditoria (`registrarAcessoAoAudio`) é de quem serve o arquivo: uma vez por reprodução, não
   * por cada `Range` do player.
   */
  async arquivoDoAudio(
    usuario: UsuarioAutenticado,
    id: string,
    opcoes: { baixar: boolean; versao: VersaoDoAudio },
  ): Promise<Arquivo> {
    const ligacao = await this.ligacaoVisivel(usuario, id);
    if (opcoes.baixar && !this.podeBaixar(usuario)) {
      throw new SemPermissaoException(
        'Só o Admin e os líderes baixam a gravação. Você pode ouvir pelo player.',
        { regra: REGRA_TRANSCRICAO },
      );
    }
    const arquivoId =
      opcoes.versao === 'original'
        ? ligacao.gravacaoOriginalArquivoId
        : ligacao.gravacaoArquivoId;
    if (ligacao.gravacaoRemovidaEm) {
      throw new NaoEncontradoException(
        'A gravação foi apagada pelo prazo de guarda.',
        { regra: REGRA_TRANSCRICAO, motivo: 'gravacao_removida' },
      );
    }
    if (
      !arquivoId ||
      (opcoes.versao === 'ouvir' && ligacao.gravacaoSituacao !== 'PRONTA')
    ) {
      throw new NaoEncontradoException(
        'Esta ligação ainda não tem gravação para ouvir.',
        { regra: REGRA_TRANSCRICAO, motivo: 'sem_gravacao' },
      );
    }
    return this.arquivos.obter(arquivoId);
  }

  /**
   * Audita o download (todo pedido) ou a reprodução: a que começa no byte 0 e, para o `Range` que
   * começa adiante (o player ao avançar, mas também quem pula o início para fugir do registro),
   * a primeira de cada janela de {@link JANELA_DA_REPRODUCAO_MS} por usuário, ligação e versão.
   */
  async registrarAcessoAoAudio(
    id: string,
    arquivo: Pick<Arquivo, 'tamanho'>,
    opcoes: {
      baixar: boolean;
      versao: VersaoDoAudio;
      usuarioId: string;
      inicio: number;
    },
  ): Promise<void> {
    if (
      !opcoes.baixar &&
      !this.primeiraDaJanela(opcoes.usuarioId, id, opcoes.versao) &&
      opcoes.inicio !== 0
    ) {
      return;
    }
    const ligacao = await this.prisma.ligacao.findUniqueOrThrow({
      where: { id },
      select: { contatoId: true },
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: opcoes.baixar
          ? 'ligacao.gravacao-baixada'
          : 'ligacao.gravacao-reproduzida',
        entidade: 'ligacao',
        entidadeId: id,
        resumo: opcoes.baixar
          ? 'Gravação da ligação baixada'
          : 'Gravação da ligação reproduzida',
        dados: {
          regra: REGRA_TRANSCRICAO,
          versao: opcoes.versao,
          tamanhoBytes: arquivo.tamanho,
        },
        relacionados: { contato: ligacao.contatoId },
      }),
    );
  }

  /** Reproduções já auditadas: `usuário:ligação:versão` -> quando. Só na memória do processo. */
  private readonly reproducoes = new Map<string, number>();

  /** Marca a reprodução e diz se ela abre uma janela nova (não há registro recente). */
  private primeiraDaJanela(
    usuarioId: string,
    ligacaoId: string,
    versao: VersaoDoAudio,
  ): boolean {
    const agora = Date.now();
    const chave = `${usuarioId}:${ligacaoId}:${versao}`;
    const ultima = this.reproducoes.get(chave);
    if (this.reproducoes.size > 5000) {
      for (const [k, quando] of this.reproducoes) {
        if (agora - quando > JANELA_DA_REPRODUCAO_MS) {
          this.reproducoes.delete(k);
        }
      }
    }
    if (ultima !== undefined && agora - ultima <= JANELA_DA_REPRODUCAO_MS) {
      return false;
    }
    this.reproducoes.set(chave, agora);
    return true;
  }

  /** O áudio de aviso do canal (o navegador toca ao atender), para quem usa o Atendimento. */
  async arquivoDoAviso(canalId: string): Promise<Arquivo> {
    const config = await this.prisma.canalLigacaoConfig.findUnique({
      where: { canalId },
      select: { avisoArquivoId: true },
    });
    if (!config?.avisoArquivoId) {
      throw new NaoEncontradoException('Este canal não tem áudio de aviso.');
    }
    return this.arquivos.obter(config.avisoArquivoId);
  }
}
