/**
 * Gravação das ligações (R30). O navegador do atendente grava em estéreo (atendente à esquerda,
 * cliente à direita; MediaRecorder webm/opus) e manda partes de ~5 s durante a ligação:
 *
 * - `receberParte`: guarda a parte (idempotente por sequência) no armazenamento de arquivos e anota
 *   no banco. Só o atendente da ligação, enquanto ela está EM_ANDAMENTO (ou recém-encerrada).
 * - `finalizar`: junta as partes na ordem (webm do mesmo MediaRecorder concatena direto), guarda o
 *   arquivo original e enfileira o processamento (`src/transcricao`). Se a aba fechar, o
 *   `navigator.sendBeacon` finaliza com o que subiu; sem ele, um job da fila finaliza sozinho.
 */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../../arquivos/arquivos.service';
import {
  DRIVER_DE_ARQUIVOS,
  type DriverDeArquivos,
} from '../../arquivos/drivers/driver-de-arquivos';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import {
  ConflitoException,
  CorpoMuitoGrandeException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import { FilaService } from '../../fila/fila.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { TranscricaoService } from '../../transcricao/transcricao.service';
import { REGRA_TRANSCRICAO } from '../../transcricao/transcricao.constantes';
import { ClienteWhisper } from '../../transcricao/cliente-whisper';
import { exigirWhatsapp } from '../ligacoes.constantes';
import {
  ASSINATURA_WEBM,
  FILA_FINALIZAR_GRAVACAO,
  MAX_BYTES_POR_PARTE,
  MAX_SEQUENCIA_DA_PARTE,
  MIME_DA_GRAVACAO,
  TOLERANCIA_APOS_ENCERRAR_S,
} from './gravacao.constantes';
import type {
  RespostaDaParteDto,
  RespostaDeFinalizacaoDto,
} from './gravacao.dto';

export const chaveDaParte = (ligacaoId: string, sequencia: number): string =>
  `ligacoes/${ligacaoId}/partes/${sequencia}`;

async function* umPedaco(dados: Buffer): AsyncGenerator<Buffer> {
  yield dados;
}

async function lerCorpo(
  corpo: AsyncIterable<Buffer | Uint8Array>,
  limite: number,
): Promise<Buffer> {
  const pedacos: Buffer[] = [];
  let total = 0;
  for await (const pedaco of corpo) {
    const buffer = Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco);
    total += buffer.length;
    if (total > limite) {
      throw new CorpoMuitoGrandeException(
        'A parte da gravação é grande demais.',
        { regra: REGRA_TRANSCRICAO, limiteBytes: limite },
      );
    }
    pedacos.push(buffer);
  }
  return Buffer.concat(pedacos);
}

@Injectable()
export class GravacaoService implements OnModuleInit {
  private readonly logger = new Logger('Gravacao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly fila: FilaService,
    private readonly transcricao: TranscricaoService,
    private readonly whisper: ClienteWhisper,
    @Inject(DRIVER_DE_ARQUIVOS) private readonly driver: DriverDeArquivos,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ ligacaoId: string }>(
      FILA_FINALIZAR_GRAVACAO,
      async (trabalho) => {
        await this.finalizarSozinho(trabalho.dados.ligacaoId);
      },
      { tentativas: 3, intervaloEntreTentativasSegundos: 30 },
    );
  }

  // ---------------------------------------------------------------------------
  // Partes
  // ---------------------------------------------------------------------------

  async receberParte(
    usuario: UsuarioAutenticado,
    ligacaoId: string,
    sequencia: number,
    corpo: AsyncIterable<Buffer | Uint8Array>,
  ): Promise<RespostaDaParteDto> {
    if (
      !Number.isInteger(sequencia) ||
      sequencia < 0 ||
      sequencia > MAX_SEQUENCIA_DA_PARTE
    ) {
      throw new DadosInvalidosException('Número de sequência inválido.', {
        campos: [
          {
            campo: 'sequencia',
            mensagens: [`deve ser um inteiro de 0 a ${MAX_SEQUENCIA_DA_PARTE}`],
          },
        ],
      });
    }
    const ligacao = await this.ligacaoDoAtendente(usuario, ligacaoId);
    this.exigirGravandoAgora(ligacao);
    const dados = await lerCorpo(corpo, MAX_BYTES_POR_PARTE);
    if (dados.length === 0) {
      throw new DadosInvalidosException('A parte da gravação está vazia.');
    }
    if (
      sequencia === 0 &&
      !ASSINATURA_WEBM.every((byte, indice) => dados[indice] === byte)
    ) {
      throw new DadosInvalidosException(
        'A primeira parte precisa ser um áudio webm (MediaRecorder).',
        { regra: REGRA_TRANSCRICAO },
      );
    }
    const sha256 = createHash('sha256').update(dados).digest('hex');

    const existente = await this.prisma.ligacaoGravacaoParte.findUnique({
      where: { ligacaoId_sequencia: { ligacaoId, sequencia } },
    });
    if (existente) {
      return this.parteDuplicada(
        existente.sha256,
        sha256,
        ligacaoId,
        sequencia,
      );
    }

    const agregado = await this.prisma.ligacaoGravacaoParte.aggregate({
      where: { ligacaoId },
      _sum: { tamanho: true },
      _count: true,
    });
    if (
      (agregado._sum.tamanho ?? 0) + dados.length >
      this.ambiente.transcricao.gravacaoMaxBytes
    ) {
      throw new CorpoMuitoGrandeException(
        'A gravação desta ligação passou do tamanho máximo.',
        {
          regra: REGRA_TRANSCRICAO,
          limiteBytes: this.ambiente.transcricao.gravacaoMaxBytes,
        },
      );
    }

    const chave = chaveDaParte(ligacaoId, sequencia);
    await this.driver.gravar(chave, umPedaco(dados), {
      mime: MIME_DA_GRAVACAO,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        // Trava a ligação como o `juntar`: se a gravação foi finalizada (ou apagada) enquanto o
        // objeto subia, a parte atrasada não entra, e o objeto sai no `catch` abaixo.
        await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${ligacaoId}::uuid FOR UPDATE`;
        const atual = await tx.ligacao.findUniqueOrThrow({
          where: { id: ligacaoId },
          select: { gravacaoFinalizadaEm: true, gravacaoRemovidaEm: true },
        });
        if (atual.gravacaoFinalizadaEm || atual.gravacaoRemovidaEm) {
          throw new ConflitoException(
            atual.gravacaoRemovidaEm
              ? 'A gravação desta ligação foi apagada.'
              : 'A gravação desta ligação já foi finalizada.',
            {
              regra: REGRA_TRANSCRICAO,
              motivo: atual.gravacaoRemovidaEm
                ? 'gravacao_removida'
                : 'gravacao_finalizada',
            },
          );
        }
        await tx.ligacaoGravacaoParte.create({
          data: { ligacaoId, sequencia, chave, tamanho: dados.length, sha256 },
        });
        await tx.ligacao.updateMany({
          where: { id: ligacaoId, gravacaoSituacao: 'SEM' },
          data: { gravacaoSituacao: 'ENVIANDO', gravacaoErro: null },
        });
      });
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        // Duas entregas da mesma parte ao mesmo tempo: vale a que gravou primeiro.
        const gravada =
          await this.prisma.ligacaoGravacaoParte.findUniqueOrThrow({
            where: { ligacaoId_sequencia: { ligacaoId, sequencia } },
          });
        return this.parteDuplicada(
          gravada.sha256,
          sha256,
          ligacaoId,
          sequencia,
        );
      }
      await this.driver.remover(chave).catch(() => undefined);
      throw erro;
    }
    return {
      sequencia,
      duplicada: false,
      partes: agregado._count + 1,
    };
  }

  private async parteDuplicada(
    shaGravado: string,
    shaRecebido: string,
    ligacaoId: string,
    sequencia: number,
  ): Promise<RespostaDaParteDto> {
    if (shaGravado.trim() !== shaRecebido) {
      throw new ConflitoException(
        'Já existe outra parte com este número de sequência nesta gravação.',
        { regra: REGRA_TRANSCRICAO, motivo: 'parte_diferente' },
      );
    }
    const partes = await this.prisma.ligacaoGravacaoParte.count({
      where: { ligacaoId },
    });
    return { sequencia, duplicada: true, partes };
  }

  /** A ligação existe e é deste atendente (senão 404, sem revelar que existe). */
  private async ligacaoDoAtendente(usuario: UsuarioAutenticado, id: string) {
    const ligacao = await this.prisma.ligacao.findUnique({ where: { id } });
    if (!ligacao || ligacao.atendenteId !== usuario.id) {
      throw new NaoEncontradoException('Ligação não encontrada.');
    }
    exigirWhatsapp(ligacao);
    return ligacao;
  }

  /** Partes só durante a ligação (ou logo depois dela) e enquanto a gravação não foi finalizada. */
  private exigirGravandoAgora(ligacao: {
    gravar: boolean;
    estado: string;
    encerradaEm: Date | null;
    atendidaEm: Date | null;
    gravacaoFinalizadaEm: Date | null;
    gravacaoRemovidaEm: Date | null;
  }): void {
    const recusar = (motivo: string, mensagem: string): never => {
      throw new ConflitoException(mensagem, {
        regra: REGRA_TRANSCRICAO,
        motivo,
      });
    };
    if (!ligacao.gravar) {
      recusar('gravacao_desativada', 'Este canal não grava as ligações.');
    }
    if (ligacao.gravacaoRemovidaEm) {
      recusar('gravacao_removida', 'A gravação desta ligação foi apagada.');
    }
    if (ligacao.gravacaoFinalizadaEm) {
      recusar(
        'gravacao_finalizada',
        'A gravação desta ligação já foi finalizada.',
      );
    }
    const agora = Date.now();
    const recemEncerrada =
      ligacao.estado === 'ENCERRADA' &&
      ligacao.encerradaEm !== null &&
      agora - ligacao.encerradaEm.getTime() <=
        TOLERANCIA_APOS_ENCERRAR_S * 1000;
    if (ligacao.estado !== 'EM_ANDAMENTO' && !recemEncerrada) {
      recusar(
        'ligacao_fora_de_andamento',
        'A gravação só aceita partes durante a ligação.',
      );
    }
    const limiteMs =
      (this.ambiente.transcricao.gravacaoMaxMinutos + 5) * 60_000;
    if (ligacao.atendidaEm && agora - ligacao.atendidaEm.getTime() > limiteMs) {
      throw new CorpoMuitoGrandeException(
        'A gravação desta ligação passou da duração máxima.',
        {
          regra: REGRA_TRANSCRICAO,
          limiteMinutos: this.ambiente.transcricao.gravacaoMaxMinutos,
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Finalizar
  // ---------------------------------------------------------------------------

  /** `POST /ligacoes/:id/gravacao/finalizar` (e o `sendBeacon` ao fechar a aba). */
  async finalizar(
    usuario: UsuarioAutenticado,
    ligacaoId: string,
    totalPartes?: number,
  ): Promise<RespostaDeFinalizacaoDto> {
    const ligacao = await this.ligacaoDoAtendente(usuario, ligacaoId);
    if (!ligacao.gravar) {
      throw new ConflitoException('Este canal não grava as ligações.', {
        regra: REGRA_TRANSCRICAO,
        motivo: 'gravacao_desativada',
      });
    }
    return this.juntar(ligacaoId, totalPartes);
  }

  /** Job da fila: a aba fechou sem finalizar, junta o que subiu. */
  async finalizarSozinho(ligacaoId: string): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
      select: { gravar: true, gravacaoFinalizadaEm: true },
    });
    if (!ligacao?.gravar || ligacao.gravacaoFinalizadaEm) {
      return;
    }
    await this.juntar(ligacaoId, undefined);
  }

  private async juntar(
    ligacaoId: string,
    totalDeclarado: number | undefined,
  ): Promise<RespostaDeFinalizacaoDto> {
    const resultado = await this.prisma.$transaction(
      async (tx): Promise<RespostaDeFinalizacaoDto & { chaves: string[] }> => {
        // Trava a ligação: o "finalizar" do fetch e o do sendBeacon podem chegar juntos.
        await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${ligacaoId}::uuid FOR UPDATE`;
        const ligacao = await tx.ligacao.findUniqueOrThrow({
          where: { id: ligacaoId },
        });
        if (ligacao.gravacaoFinalizadaEm || ligacao.gravacaoRemovidaEm) {
          return {
            gravacao: ligacao.gravacaoSituacao.toLowerCase(),
            partes: ligacao.gravacaoTotalPartes ?? 0,
            jaFinalizada: true,
            chaves: [],
          };
        }
        const partes = await tx.ligacaoGravacaoParte.findMany({
          where: { ligacaoId },
          orderBy: { sequencia: 'asc' },
        });
        const agora = new Date();
        if (partes.length === 0) {
          await tx.ligacao.update({
            where: { id: ligacaoId },
            data: { gravacaoFinalizadaEm: agora, gravacaoTotalPartes: 0 },
          });
          return {
            gravacao: 'sem',
            partes: 0,
            jaFinalizada: false,
            chaves: [],
          };
        }
        if (partes[0].sequencia !== 0) {
          // Sem a primeira parte não há cabeçalho webm: o resto não toca.
          await tx.ligacao.update({
            where: { id: ligacaoId },
            data: {
              gravacaoFinalizadaEm: agora,
              gravacaoTotalPartes: partes.length,
              gravacaoSituacao: 'FALHOU',
              gravacaoErro:
                'A primeira parte da gravação não chegou; não foi possível montar o áudio.',
            },
          });
          await this.auditoriaDaGravacao(tx, ligacao, partes.length, 0, false);
          return {
            gravacao: 'falhou',
            partes: partes.length,
            jaFinalizada: false,
            chaves: partes.map((p) => p.chave),
          };
        }
        const driver = this.driver;
        async function* conteudo(): AsyncGenerator<Buffer> {
          for (const parte of partes) {
            const stream: Readable = await driver.abrir(parte.chave);
            for await (const pedaco of stream) {
              yield Buffer.isBuffer(pedaco)
                ? pedaco
                : Buffer.from(pedaco as Uint8Array);
            }
          }
        }
        const arquivo = await this.arquivos.salvar(
          conteudo(),
          {
            nome: `ligacao-${ligacaoId}.webm`,
            mime: MIME_DA_GRAVACAO,
            contexto: 'LIGACAO',
            // Sem dono: quem enviou não baixa o original estéreo por `GET /arquivos/:id` (só pelas
            // rotas do áudio, que auditam e limitam o download aos líderes).
            criadoPorId: null,
            limiteBytes:
              this.ambiente.transcricao.gravacaoMaxBytes + 1024 * 1024,
          },
          { tx },
        );
        const transcreve = this.whisper.ligado;
        await tx.ligacao.update({
          where: { id: ligacaoId },
          data: {
            gravacaoOriginalArquivoId: arquivo.id,
            gravacaoTotalPartes: totalDeclarado ?? partes.length,
            gravacaoFinalizadaEm: agora,
            gravacaoSituacao: 'ENVIANDO',
            gravacaoErro: null,
            transcricaoSituacao: transcreve ? 'PENDENTE' : 'DESATIVADA',
            transcricaoErro: null,
            resumoSituacao: transcreve ? 'PENDENTE' : 'DESATIVADO',
            resumoErro: transcreve
              ? null
              : 'A transcrição está desligada neste servidor.',
          },
        });
        await this.auditoriaDaGravacao(
          tx,
          ligacao,
          partes.length,
          arquivo.tamanho,
          totalDeclarado === undefined || totalDeclarado === partes.length,
        );
        await this.transcricao.enfileirarProcessamento(ligacaoId, { tx });
        return {
          gravacao: 'enviando',
          partes: partes.length,
          jaFinalizada: false,
          chaves: partes.map((p) => p.chave),
        };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    // Depois do commit: as partes já viraram o arquivo e saem do armazenamento.
    if (resultado.chaves.length > 0) {
      await this.apagarPartes(ligacaoId, resultado.chaves);
    }
    const { chaves: _chaves, ...resposta } = resultado;
    void _chaves;
    return resposta;
  }

  private async auditoriaDaGravacao(
    tx: Tx,
    ligacao: { id: string; contatoId: string; canalId: string | null },
    partes: number,
    tamanhoBytes: number,
    completa: boolean,
  ): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao: 'ligacao.gravacao-finalizada',
      entidade: 'ligacao',
      entidadeId: ligacao.id,
      resumo: 'Gravação da ligação finalizada',
      dados: {
        regra: REGRA_TRANSCRICAO,
        partes,
        tamanhoBytes,
        completa,
        canalId: ligacao.canalId,
      },
      relacionados: { contato: ligacao.contatoId },
    });
  }

  /** Apaga os objetos das partes e as linhas do banco (best effort: a limpeza diária pega o resto). */
  private async apagarPartes(
    ligacaoId: string,
    chaves: readonly string[],
  ): Promise<void> {
    await Promise.all(
      chaves.map((chave) =>
        this.driver.remover(chave).catch((erro: unknown) => {
          this.logger.warn(
            `Não foi possível apagar a parte ${chave}: ${erro instanceof Error ? erro.message : String(erro)}`,
          );
        }),
      ),
    );
    // Só as linhas das partes tratadas: uma parte que chegou depois da leitura não perde a linha
    // (e o objeto, que fica sem quem aponte para ele).
    await this.prisma.ligacaoGravacaoParte.deleteMany({
      where: { ligacaoId, chave: { in: [...chaves] } },
    });
  }

  /** Apaga as partes de uma ligação (retenção e anonimização). */
  async descartarPartes(ligacaoId: string): Promise<void> {
    const partes = await this.prisma.ligacaoGravacaoParte.findMany({
      where: { ligacaoId },
      select: { chave: true },
    });
    await this.apagarPartes(
      ligacaoId,
      partes.map((p) => p.chave),
    );
  }
}
