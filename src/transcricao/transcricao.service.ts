/**
 * Processamento das gravações de ligação pela fila (R30): ffmpeg → whisper.cpp → resumo do Claude.
 *
 * - `transcricao.processar`: baixa a gravação original, gera a versão para ouvir (mono, ogg/opus),
 *   transcreve cada canal (esquerdo = atendente, direito = cliente) e intercala os trechos por tempo.
 *   Uma transcrição por vez (concorrência 1). Sem `TRANSCRICAO_URL`, só a versão para ouvir.
 * - `transcricao.resumir`: o resumo pelo Claude (assunto, pontos, combinados, próximos passos,
 *   sentimento e sugestões de atividade). Sem `ANTHROPIC_API_KEY`, fica só a transcrição.
 *
 * Falha transitória (rede, 5xx, tempo) repete pela fila; ao esgotar, a ligação fica `falhou`
 * com uma mensagem em português e o botão "Reprocessar" refaz.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  type ObservadorDaChamada,
} from '../bi/analise/chamada-claude.service';
import type { ParametrosDoFluxo } from '../bi/analise/cliente-anthropic';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { FilaService } from '../fila/fila.service';
import { type Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { salas } from '../tempo-real/catalogo';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { ClienteWhisper, ErroDeTranscricao } from './cliente-whisper';
import { conferirResumo, ESQUEMA_RESUMO_DE_LIGACAO } from './esquema-resumo';
import { ProcessadorDeAudio } from './processador-de-audio';
import { mensagemDoResumo, PROMPT_DE_SISTEMA_DO_RESUMO } from './prompt-resumo';
import { situacoesDaLigacao } from './situacoes';
import {
  contarPalavras,
  intercalar,
  prepararCanal,
  textoDaConversa,
} from './trechos';
import {
  ESPERA_ENTRE_TENTATIVAS_S,
  FILA_PROCESSAR_LIGACAO,
  FILA_RESUMIR_LIGACAO,
  MAX_TOKENS_DO_RESUMO,
  MINIMO_DE_PALAVRAS_PARA_RESUMIR,
  REGRA_TRANSCRICAO,
  type ResumoGravado,
  TENTATIVAS_DO_PROCESSAMENTO,
  TENTATIVAS_DO_RESUMO,
  type TranscricaoGravada,
  type Trecho,
  VERSAO_DA_TRANSCRICAO,
} from './transcricao.constantes';

interface DadosDoJob {
  ligacaoId: string;
}

type Etapa = 'gravacao' | 'transcricao' | 'resumo';

const OBSERVADOR_NULO: ObservadorDaChamada = {
  aoIniciarTentativa: () => undefined,
  aoMudarDeFase: () => undefined,
  aoReceberTexto: () => undefined,
};

const json = (valor: unknown) => valor as Prisma.InputJsonValue;

@Injectable()
export class TranscricaoService implements OnModuleInit {
  private readonly logger = new Logger('Transcricao');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly arquivos: ArquivosService,
    private readonly whisper: ClienteWhisper,
    private readonly audio: ProcessadorDeAudio,
    private readonly chamada: ChamadaClaudeService,
    private readonly tempoReal: TempoRealService,
    private readonly auditoria: AuditoriaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<DadosDoJob>(
      FILA_PROCESSAR_LIGACAO,
      (trabalho) =>
        this.processar(
          trabalho.dados.ligacaoId,
          trabalho.tentativa > TENTATIVAS_DO_PROCESSAMENTO,
        ),
      {
        tentativas: TENTATIVAS_DO_PROCESSAMENTO,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_TENTATIVAS_S,
        esperaExponencial: true,
        // Uma transcrição por vez: o CPU do serviço de transcrição é um só.
        concorrencia: 1,
        prazoDeExecucaoSegundos:
          this.ambiente.transcricao.tempoLimiteSegundos + 1800,
      },
    );
    await this.fila.trabalhar<DadosDoJob>(
      FILA_RESUMIR_LIGACAO,
      (trabalho) =>
        this.resumir(
          trabalho.dados.ligacaoId,
          trabalho.tentativa > TENTATIVAS_DO_RESUMO,
        ),
      {
        tentativas: TENTATIVAS_DO_RESUMO,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_TENTATIVAS_S,
        esperaExponencial: true,
        concorrencia: 1,
      },
    );
  }

  /** Enfileira o processamento da gravação (uma fila de espera por ligação). */
  async enfileirarProcessamento(
    ligacaoId: string,
    opcoes: { tx?: Tx } = {},
  ): Promise<void> {
    await this.fila.enviar<DadosDoJob>(
      FILA_PROCESSAR_LIGACAO,
      { ligacaoId },
      { chaveUnica: ligacaoId, tx: opcoes.tx },
    );
  }

  async enfileirarResumo(ligacaoId: string): Promise<void> {
    await this.fila.enviar<DadosDoJob>(
      FILA_RESUMIR_LIGACAO,
      { ligacaoId },
      { chaveUnica: ligacaoId },
    );
  }

  // ---------------------------------------------------------------------------
  // Processamento: ffmpeg + whisper
  // ---------------------------------------------------------------------------

  async processar(ligacaoId: string, ultima: boolean): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
    });
    if (!ligacao?.gravacaoOriginalArquivoId || ligacao.gravacaoRemovidaEm) {
      return;
    }
    const transcreve = this.whisper.ligado;
    const originalId = ligacao.gravacaoOriginalArquivoId;
    if (transcreve) {
      const marcada = await this.prisma.ligacao.updateMany({
        where: { id: ligacaoId, gravacaoRemovidaEm: null },
        data: {
          transcricaoSituacao: 'PROCESSANDO',
          transcricaoErro: null,
          resumoSituacao: 'PENDENTE',
          resumoErro: null,
        },
      });
      if (marcada.count === 0) {
        return;
      }
    }
    const pasta = await mkdtemp(join(tmpdir(), 'crmbrl-ligacao-'));
    try {
      const entrada = join(pasta, 'original.webm');
      const original = await this.arquivos.obter(
        ligacao.gravacaoOriginalArquivoId,
      );
      await pipeline(
        await this.arquivos.abrirConteudo(original),
        createWriteStream(entrada),
      );

      let convertido;
      try {
        convertido = await this.audio.converter(entrada, pasta);
      } catch (erro) {
        this.logger.warn(
          `ffmpeg falhou na ligação ${ligacaoId}: ${mensagemDe(erro)}`,
        );
        await this.falhar(
          ligacaoId,
          'gravacao',
          'Não foi possível converter a gravação (arquivo corrompido ou incompleto).',
        );
        return;
      }

      const guardada = await this.guardarVersaoParaOuvir(
        ligacaoId,
        originalId,
        convertido.ogg,
        convertido.duracaoSegundos,
      );
      if (!guardada) {
        return; // Apagada (guarda ou anonimização) durante o processamento.
      }
      if (!transcreve) {
        await this.prisma.ligacao.updateMany({
          where: { id: ligacaoId, gravacaoRemovidaEm: null },
          data: {
            transcricaoSituacao: 'DESATIVADA',
            transcricaoErro: null,
            resumoSituacao: 'DESATIVADO',
            resumoErro: 'A transcrição está desligada neste servidor.',
          },
        });
        await this.avisar(ligacaoId, 'gravacao');
        return;
      }

      const prazoFinal =
        Date.now() + this.ambiente.transcricao.tempoLimiteSegundos * 1000;
      const restante = () => {
        const ms = prazoFinal - Date.now();
        if (ms <= 0) {
          throw new ErroDeTranscricao(
            'A transcrição passou do tempo limite.',
            false,
          );
        }
        return ms;
      };
      const esquerdo = await this.whisper.transcrever(
        convertido.esquerdo,
        restante(),
      );
      const direito = convertido.direito
        ? await this.whisper.transcrever(convertido.direito, restante())
        : null;
      const trechos: Trecho[] = intercalar([
        // Gravação mono (sem a separação dos canais): não dá para dizer quem falou.
        prepararCanal(direito ? 'atendente' : 'participante', esquerdo.trechos),
        direito ? prepararCanal('cliente', direito.trechos) : [],
      ]);
      const transcricao: TranscricaoGravada = {
        versao: VERSAO_DA_TRANSCRICAO,
        idioma: 'pt',
        modelo: this.ambiente.transcricao.modelo,
        duracaoSegundos: convertido.duracaoSegundos,
        trechos,
      };
      const gravada = await this.prisma.$transaction(async (tx) => {
        if (!(await this.aindaAceita(tx, ligacaoId, originalId))) {
          return false;
        }
        await tx.ligacao.update({
          where: { id: ligacaoId },
          data: {
            transcricao: json(transcricao),
            transcricaoSituacao: 'PRONTA',
            transcricaoErro: null,
            transcricaoProcessadaEm: new Date(),
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.transcricao-concluida',
          entidade: 'ligacao',
          entidadeId: ligacaoId,
          resumo: 'Transcrição da ligação concluída',
          dados: {
            regra: REGRA_TRANSCRICAO,
            trechos: trechos.length,
            palavras: contarPalavras(trechos),
            duracaoSegundos: convertido.duracaoSegundos,
            modelo: this.ambiente.transcricao.modelo,
          },
          relacionados: { contato: ligacao.contatoId },
        });
        return true;
      });
      if (!gravada) {
        return;
      }
      await this.avisar(ligacaoId, 'transcricao');
      await this.enfileirarResumo(ligacaoId);
    } catch (erro) {
      const transitoria =
        erro instanceof ErroDeTranscricao ? erro.transitoria : true;
      this.logger.warn(
        `Transcrição da ligação ${ligacaoId} falhou (tentativa${ultima ? ' final' : ''}): ${mensagemDe(erro)}`,
      );
      if (transitoria && !ultima) {
        throw erro;
      }
      await this.falhar(
        ligacaoId,
        'transcricao',
        erro instanceof ErroDeTranscricao
          ? erro.message
          : 'Não foi possível transcrever a ligação.',
      );
    } finally {
      await rm(pasta, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Trava a linha da ligação e confere se ela ainda aceita gravação, transcrição ou resumo: a guarda
   * (R30.11) e a anonimização (R4.6, R30.12) podem ter apagado tudo durante o processamento, e o que
   * se gravasse depois disso nunca mais seria removido. Com `originalId`, exige também que a gravação
   * original continue a mesma. Chamar dentro da transação que grava.
   */
  private async aindaAceita(
    tx: Tx,
    ligacaoId: string,
    originalId?: string,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM ligacoes WHERE id = ${ligacaoId}::uuid FOR UPDATE`;
    const atual = await tx.ligacao.findUnique({
      where: { id: ligacaoId },
      select: { gravacaoRemovidaEm: true, gravacaoOriginalArquivoId: true },
    });
    if (!atual || atual.gravacaoRemovidaEm) {
      return false;
    }
    return (
      originalId === undefined || atual.gravacaoOriginalArquivoId === originalId
    );
  }

  /**
   * Guarda o ogg como arquivo da ligação, trocando o anterior (reprocessamento). Devolve `false`
   * (e descarta o ogg novo) se a gravação foi apagada enquanto se processava.
   */
  private async guardarVersaoParaOuvir(
    ligacaoId: string,
    originalId: string,
    caminho: string,
    duracaoSegundos: number,
  ): Promise<boolean> {
    const tamanho = (await stat(caminho)).size;
    const conteudo = await readFile(caminho);
    const arquivo = await this.arquivos.salvar(conteudo, {
      nome: `ligacao-${ligacaoId}.ogg`,
      mime: 'audio/ogg',
      contexto: 'LIGACAO',
      duracaoSegundos,
      limiteBytes: Math.max(tamanho, 1) + 1024,
    });
    const guardada = await this.prisma.$transaction(async (tx) => {
      if (!(await this.aindaAceita(tx, ligacaoId, originalId))) {
        return false;
      }
      const atual = await tx.ligacao.findUniqueOrThrow({
        where: { id: ligacaoId },
        select: { gravacaoArquivoId: true },
      });
      await tx.ligacao.update({
        where: { id: ligacaoId },
        data: {
          gravacaoArquivoId: arquivo.id,
          gravacaoSituacao: 'PRONTA',
          gravacaoErro: null,
          gravacaoDuracaoSegundos: duracaoSegundos,
        },
      });
      if (atual.gravacaoArquivoId) {
        await this.arquivos.remover(atual.gravacaoArquivoId, {
          tx,
          motivo: 'Reprocessamento da gravação (R30)',
        });
      }
      return true;
    });
    if (!guardada) {
      await this.arquivos.descartarNovo(arquivo.id);
    }
    return guardada;
  }

  private async falhar(
    ligacaoId: string,
    etapa: Etapa,
    mensagem: string,
  ): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
      select: { contatoId: true },
    });
    const registrada = await this.prisma.$transaction(async (tx) => {
      if (!(await this.aindaAceita(tx, ligacaoId))) {
        return false;
      }
      await tx.ligacao.update({
        where: { id: ligacaoId },
        data:
          etapa === 'gravacao'
            ? {
                gravacaoSituacao: 'FALHOU',
                gravacaoErro: mensagem,
                transcricaoSituacao: this.whisper.ligado
                  ? 'FALHOU'
                  : 'DESATIVADA',
                transcricaoErro: this.whisper.ligado ? mensagem : null,
                resumoSituacao: 'DESATIVADO',
                resumoErro: 'Sem transcrição, não há o que resumir.',
              }
            : etapa === 'transcricao'
              ? {
                  transcricaoSituacao: 'FALHOU',
                  transcricaoErro: mensagem,
                  resumoSituacao: 'DESATIVADO',
                  resumoErro: 'Sem transcrição, não há o que resumir.',
                }
              : { resumoSituacao: 'FALHOU', resumoErro: mensagem },
      });
      await this.auditoria.registrar(tx, {
        acao: `ligacao.${etapa === 'resumo' ? 'resumo' : 'transcricao'}-falhou`,
        entidade: 'ligacao',
        entidadeId: ligacaoId,
        resumo: `Falha no processamento da ligação (${etapa})`,
        dados: { regra: REGRA_TRANSCRICAO, etapa, motivo: mensagem },
        relacionados: ligacao ? { contato: ligacao.contatoId } : undefined,
      });
      return true;
    });
    if (registrada) {
      await this.avisar(ligacaoId, etapa);
    }
  }

  // ---------------------------------------------------------------------------
  // Resumo pelo Claude
  // ---------------------------------------------------------------------------

  async resumir(ligacaoId: string, ultima: boolean): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
    });
    const transcricao = ligacao?.transcricao as TranscricaoGravada | null;
    if (!ligacao || !transcricao || ligacao.transcricaoSituacao !== 'PRONTA') {
      return;
    }
    if (!this.claudeConfigurado()) {
      await this.desativarResumo(
        ligacaoId,
        'A chave da Anthropic não está configurada neste servidor.',
      );
      return;
    }
    if (contarPalavras(transcricao.trechos) < MINIMO_DE_PALAVRAS_PARA_RESUMIR) {
      await this.desativarResumo(
        ligacaoId,
        'A conversa foi curta demais para resumir.',
      );
      return;
    }
    const marcado = await this.prisma.ligacao.updateMany({
      where: { id: ligacaoId, gravacaoRemovidaEm: null },
      data: { resumoSituacao: 'PROCESSANDO', resumoErro: null },
    });
    if (marcado.count === 0) {
      return;
    }
    const modelo = this.ambiente.transcricao.resumoModelo;
    const parametros: ParametrosDoFluxo = {
      model: modelo,
      max_tokens: MAX_TOKENS_DO_RESUMO,
      // Recusa por política: a API refaz com o modelo de reserva padrão.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: ESQUEMA_RESUMO_DE_LIGACAO },
      },
      system: [
        {
          type: 'text',
          text: PROMPT_DE_SISTEMA_DO_RESUMO,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: mensagemDoResumo({
            direcao: ligacao.direcao,
            duracaoSegundos: ligacao.duracaoSegundos,
            conversa: textoDaConversa(transcricao.trechos),
          }),
        },
      ],
    };
    try {
      const resultado = await this.chamada.executar(
        parametros,
        OBSERVADOR_NULO,
        conferirResumo,
        new AbortController().signal,
      );
      const r = resultado.valor;
      const resumo: ResumoGravado = {
        versao: 1,
        assunto: r.assunto,
        pontosPrincipais: r.pontosPrincipais,
        combinados: r.combinados,
        proximosPassos: r.proximosPassos,
        sentimento: r.sentimento,
        sentimentoMotivo: r.sentimentoMotivo,
        sugestoes: r.sugestoes.map((s) => ({
          ...s,
          id: randomUUID(),
          atividadeId: null,
          descartadaEm: null,
        })),
        modelo,
      };
      const gravado = await this.prisma.$transaction(async (tx) => {
        if (!(await this.aindaAceita(tx, ligacaoId))) {
          return false;
        }
        await tx.ligacao.update({
          where: { id: ligacaoId },
          data: {
            resumo: json(resumo),
            resumoSituacao: 'PRONTO',
            resumoErro: null,
            resumoProcessadoEm: new Date(),
          },
        });
        await this.auditoria.registrar(tx, {
          acao: 'ligacao.resumo-concluido',
          entidade: 'ligacao',
          entidadeId: ligacaoId,
          resumo: 'Resumo da ligação gerado pela IA',
          dados: {
            regra: REGRA_TRANSCRICAO,
            modelo,
            tokensEntrada: resultado.uso.entrada,
            tokensSaida: resultado.uso.saida,
            sugestoes: resumo.sugestoes.length,
          },
          relacionados: { contato: ligacao.contatoId },
        });
        return true;
      });
      if (gravado) {
        await this.avisar(ligacaoId, 'resumo');
      }
    } catch (erro) {
      if (!(erro instanceof FalhaDaChamada)) {
        throw erro;
      }
      const definitiva =
        erro.codigo === 'chave_recusada' || erro.codigo === 'recusada';
      if (!definitiva && !ultima) {
        throw erro;
      }
      await this.falhar(ligacaoId, 'resumo', erro.message);
    }
  }

  /** Há chave da Anthropic neste servidor? (Sem ela, só a transcrição.) */
  claudeConfigurado(): boolean {
    return this.ambiente.anthropic.configurada;
  }

  private async desativarResumo(
    ligacaoId: string,
    motivo: string,
  ): Promise<void> {
    await this.prisma.ligacao.updateMany({
      where: { id: ligacaoId, gravacaoRemovidaEm: null },
      data: { resumoSituacao: 'DESATIVADO', resumoErro: motivo },
    });
    await this.avisar(ligacaoId, 'resumo');
  }

  // ---------------------------------------------------------------------------
  // Tempo real
  // ---------------------------------------------------------------------------

  /** `ligacao.processada` para o atendente e para quem acompanha a conversa. */
  async avisar(ligacaoId: string, etapa: Etapa): Promise<void> {
    const ligacao = await this.prisma.ligacao.findUnique({
      where: { id: ligacaoId },
      select: {
        atendenteId: true,
        conversaId: true,
        gravacaoSituacao: true,
        transcricaoSituacao: true,
        resumoSituacao: true,
      },
    });
    if (!ligacao) {
      return;
    }
    const destino = [
      ...(ligacao.atendenteId ? [salas.usuario(ligacao.atendenteId)] : []),
      ...(ligacao.conversaId ? [salas.conversa(ligacao.conversaId)] : []),
    ];
    if (destino.length === 0) {
      return;
    }
    this.tempoReal.emitir(destino, 'ligacao.processada', {
      ligacaoId,
      etapa,
      ...situacoesDaLigacao(ligacao),
    });
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export { situacoesDaLigacao };
