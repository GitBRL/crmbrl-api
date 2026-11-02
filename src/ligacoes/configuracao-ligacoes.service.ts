import { Injectable } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { SegredosDoCanal } from '../canais/comum/segredos-do-canal';
import { ErroDaGraph } from '../canais/meta/graph-api';
import type { SegredosOficiais } from '../canais/whatsapp-oficial/formato-meta';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import {
  type HorarioDeAtendimento,
  lerHorario,
  situacaoDoHorario,
  validarHorario,
} from '../atendimento/horario';
import {
  type Canal,
  type CanalLigacaoConfig,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RETENCAO_PADRAO_DIAS } from './gravacao/gravacao.constantes';
import { CAMPO_DE_CHAMADAS, traduzirErroDeChamada } from './formato-chamadas';
import { GraphLigacoes } from './graph-ligacoes';
import type {
  AtualizarConfiguracaoLigacoesDto,
  CanalParaLigarDto,
  ConfiguracaoLigacoesDto,
} from './ligacoes.dto';
import {
  REGRA_LIGACOES,
  TOQUE_MAXIMO_SEGUNDOS,
  TOQUE_MINIMO_SEGUNDOS,
  TOQUE_PADRAO_SEGUNDOS,
} from './ligacoes.constantes';

/** O que as chamadas à Graph precisam de um canal do WhatsApp oficial. */
export interface CredenciaisDoCanal {
  token: string;
  phoneNumberId: string;
}

/** Configuração de ligações como valor (a linha do banco ou o padrão, quando o canal nunca foi configurado). */
export type ConfiguracaoLida = Pick<
  CanalLigacaoConfig,
  | 'ativa'
  | 'botaoVisivel'
  | 'horario'
  | 'filaId'
  | 'gravar'
  | 'retencaoDias'
  | 'avisoArquivoId'
  | 'tempoDeToqueSegundos'
  | 'mensagemPerdidaAtiva'
  | 'mensagemPerdida'
  | 'sincronizadaEm'
  | 'ultimoErroMeta'
>;

const PADRAO: ConfiguracaoLida = {
  ativa: false,
  botaoVisivel: true,
  horario: null,
  filaId: null,
  gravar: true,
  retencaoDias: RETENCAO_PADRAO_DIAS,
  avisoArquivoId: null,
  tempoDeToqueSegundos: TOQUE_PADRAO_SEGUNDOS,
  mensagemPerdidaAtiva: false,
  mensagemPerdida: null,
  sincronizadaEm: null,
  ultimoErroMeta: null,
};

/**
 * Configuração das ligações de um canal WhatsApp oficial (R29.6): ativa, botão
 * "Ligar", horário, fila, gravar, tempo de toque e mensagem de perdida. Ligar e
 * desligar as chamadas vai à Meta (`settings`) e só vale se ela aceitar.
 * Só o Admin configura (como os demais canais); o resto do módulo é do
 * Atendimento (R12).
 */
@Injectable()
export class ConfiguracaoDeLigacoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly segredos: SegredosDoCanal,
    private readonly graph: GraphLigacoes,
    private readonly arquivos: ArquivosService,
  ) {}

  /** O canal de WhatsApp oficial (404 se não existe). */
  async canalOficial(canalId: string): Promise<Canal> {
    const canal = await this.prisma.canal.findFirst({
      where: { id: canalId, tipo: 'WHATSAPP_OFICIAL', excluidoEm: null },
    });
    if (!canal) {
      throw new NaoEncontradoException(
        'Canal de WhatsApp oficial não encontrado.',
      );
    }
    return canal;
  }

  /** Token e `phone_number_id` do canal (503 se o canal não pode ser lido). */
  async credenciais(canal: Canal): Promise<CredenciaisDoCanal> {
    const { token } = await this.segredos.ler<SegredosOficiais>(canal);
    if (!token || !canal.idExterno) {
      throw new ServicoIndisponivelException(
        `O canal "${canal.nome}" não tem o token da Meta configurado.`,
        { motivo: 'canal_sem_token' },
      );
    }
    return { token, phoneNumberId: canal.idExterno };
  }

  /** A configuração gravada, ou o padrão para o canal que nunca foi configurado. */
  async ler(canalId: string): Promise<ConfiguracaoLida> {
    const gravada = await this.prisma.canalLigacaoConfig.findUnique({
      where: { canalId },
    });
    return gravada ?? PADRAO;
  }

  async obter(canalId: string): Promise<ConfiguracaoLigacoesDto> {
    const canal = await this.canalOficial(canalId);
    return this.paraDto(canal, await this.ler(canalId));
  }

  /** O canal atende ligações agora? (`horario` próprio ou, sem ele, o de atendimento do canal.) */
  horarioEfetivo(
    canal: Pick<Canal, 'horarioAtendimento'>,
    config: Pick<ConfiguracaoLida, 'horario'>,
  ): HorarioDeAtendimento | null {
    return lerHorario(config.horario) ?? lerHorario(canal.horarioAtendimento);
  }

  dentroDoHorario(
    canal: Pick<Canal, 'horarioAtendimento'>,
    config: Pick<ConfiguracaoLida, 'horario'>,
    agora: Date = new Date(),
  ): boolean {
    return situacaoDoHorario(this.horarioEfetivo(canal, config), agora).aberto;
  }

  /** Canais em que o atendente pode ligar (ligações ativas e botão visível). */
  async canaisParaLigar(): Promise<CanalParaLigarDto[]> {
    const canais = await this.prisma.canal.findMany({
      where: {
        tipo: 'WHATSAPP_OFICIAL',
        ativo: true,
        excluidoEm: null,
        configuracaoLigacoes: { is: { ativa: true, botaoVisivel: true } },
      },
      orderBy: { nome: 'asc' },
      select: { id: true, nome: true },
    });
    return canais.map((canal) => ({ ...canal, botaoVisivel: true }));
  }

  async atualizar(
    canalId: string,
    dto: AtualizarConfiguracaoLigacoesDto,
    usuarioId: string,
  ): Promise<ConfiguracaoLigacoesDto> {
    const canal = await this.canalOficial(canalId);
    const atual = await this.ler(canalId);
    const dados: Prisma.CanalLigacaoConfigUncheckedUpdateInput = {};

    if (dto.horario !== undefined) {
      if (dto.horario === null) {
        dados.horario = Prisma.DbNull;
      } else {
        const validado = validarHorario(dto.horario);
        if (validado.erros) {
          throw new DadosInvalidosException(validado.erros.join(' '), {
            campos: [{ campo: 'horario', mensagens: validado.erros }],
          });
        }
        dados.horario = validado.horario as unknown as Prisma.InputJsonObject;
      }
    }
    if (dto.filaId !== undefined) {
      if (dto.filaId !== null) {
        const fila = await this.prisma.filaAtendimento.findFirst({
          where: { id: dto.filaId, excluidoEm: null, ativa: true },
          select: { id: true },
        });
        if (!fila) {
          throw new DadosInvalidosException('Fila não encontrada ou inativa.', {
            campos: [
              { campo: 'filaId', mensagens: ['fila inexistente ou inativa'] },
            ],
          });
        }
      }
      dados.filaId = dto.filaId;
    }
    if (dto.botaoVisivel !== undefined) dados.botaoVisivel = dto.botaoVisivel;
    if (dto.gravar !== undefined) dados.gravar = dto.gravar;
    if (dto.retencaoDias !== undefined) dados.retencaoDias = dto.retencaoDias;
    if (dto.avisoArquivoId !== undefined) {
      if (dto.avisoArquivoId !== null) {
        await this.conferirAviso(dto.avisoArquivoId);
      }
      dados.avisoArquivoId = dto.avisoArquivoId;
    }
    if (dto.tempoDeToqueSegundos !== undefined) {
      if (
        dto.tempoDeToqueSegundos < TOQUE_MINIMO_SEGUNDOS ||
        dto.tempoDeToqueSegundos > TOQUE_MAXIMO_SEGUNDOS
      ) {
        throw new DadosInvalidosException(
          `O tempo de toque vai de ${TOQUE_MINIMO_SEGUNDOS} a ${TOQUE_MAXIMO_SEGUNDOS} segundos (a Meta espera de 30 a 60 s pela resposta).`,
        );
      }
      dados.tempoDeToqueSegundos = dto.tempoDeToqueSegundos;
    }
    const ativaDepois = dto.mensagemPerdidaAtiva ?? atual.mensagemPerdidaAtiva;
    const mensagemDepois =
      dto.mensagemPerdida !== undefined
        ? dto.mensagemPerdida
        : atual.mensagemPerdida;
    if (ativaDepois && !mensagemDepois?.trim()) {
      throw new DadosInvalidosException(
        'Escreva a mensagem automática antes de ligar o envio para ligações perdidas.',
        {
          campos: [
            {
              campo: 'mensagemPerdida',
              mensagens: ['é obrigatória com a mensagem ligada'],
            },
          ],
        },
      );
    }
    if (dto.mensagemPerdidaAtiva !== undefined) {
      dados.mensagemPerdidaAtiva = dto.mensagemPerdidaAtiva;
    }
    if (dto.mensagemPerdida !== undefined) {
      dados.mensagemPerdida = dto.mensagemPerdida;
    }

    let mudouNaMeta: boolean | null = null;
    if (dto.ativa !== undefined) {
      await this.configurarNaMeta(canal, dto.ativa);
      dados.ativa = dto.ativa;
      dados.sincronizadaEm = new Date();
      dados.ultimoErroMeta = null;
      mudouNaMeta = dto.ativa !== atual.ativa;
    }
    dados.atualizadoPorId = usuarioId;

    const alterados = Object.keys(dados).filter(
      (chave) =>
        !['atualizadoPorId', 'sincronizadaEm', 'ultimoErroMeta'].includes(
          chave,
        ),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.canalLigacaoConfig.upsert({
        where: { canalId },
        create: {
          ...(dados as Prisma.CanalLigacaoConfigUncheckedCreateInput),
          canalId,
        },
        update: dados,
      });
      const acao =
        mudouNaMeta === true
          ? dto.ativa
            ? 'canal.ligacoes_ativadas'
            : 'canal.ligacoes_desativadas'
          : 'canal.ligacoes_configuradas';
      await this.auditoria.registrar(tx, {
        acao,
        entidade: 'canal',
        entidadeId: canal.id,
        resumo:
          mudouNaMeta === true
            ? `Ligações ${dto.ativa ? 'ativadas' : 'desativadas'} no canal "${canal.nome}"`
            : `Configuração de ligações do canal "${canal.nome}" alterada`,
        dados: { campos: alterados, regra: REGRA_LIGACOES },
      });
    });
    if (
      dto.avisoArquivoId !== undefined &&
      atual.avisoArquivoId &&
      atual.avisoArquivoId !== dto.avisoArquivoId
    ) {
      await this.arquivos
        .remover(atual.avisoArquivoId, {
          motivo: 'Áudio de aviso trocado (R30)',
        })
        .catch(() => undefined);
    }
    return this.obter(canalId);
  }

  /** `POST /{phone_number_id}/settings`: erro da Meta vira 503/422 em português e nada é gravado. */
  private async configurarNaMeta(canal: Canal, ativa: boolean): Promise<void> {
    const { token, phoneNumberId } = await this.credenciais(canal);
    try {
      await this.graph.configurar(token, phoneNumberId, ativa);
    } catch (erro) {
      if (!(erro instanceof ErroDaGraph)) {
        throw erro;
      }
      const traduzido = traduzirErroDeChamada(
        erro.codigo,
        erro.codigo === null ? erro.message : null,
      );
      await this.prisma.canalLigacaoConfig.upsert({
        where: { canalId: canal.id },
        create: { canalId: canal.id, ultimoErroMeta: traduzido.mensagem },
        update: { ultimoErroMeta: traduzido.mensagem },
      });
      if (erro.passageiro) {
        throw new ServicoIndisponivelException(
          'A Meta não respondeu agora. Tente de novo em instantes.',
          { motivo: 'meta_indisponivel' },
        );
      }
      throw new RegraVioladaException(REGRA_LIGACOES, traduzido.mensagem, {
        motivo: traduzido.motivo,
        codigoDaMeta: erro.codigo,
      });
    }
  }

  /** O áudio de aviso precisa ser um áudio enviado no contexto LIGACAO e ainda existir. */
  private async conferirAviso(arquivoId: string): Promise<void> {
    const arquivo = await this.prisma.arquivo.findFirst({
      where: { id: arquivoId, contexto: 'LIGACAO', removidoEm: null },
      select: { mime: true },
    });
    if (!arquivo?.mime.startsWith('audio/')) {
      throw new DadosInvalidosException(
        'O áudio de aviso precisa ser um arquivo de áudio enviado para ligações.',
        {
          campos: [
            {
              campo: 'avisoArquivoId',
              mensagens: ['envie o áudio em /arquivos?contexto=LIGACAO'],
            },
          ],
        },
      );
    }
  }

  private paraDto(
    canal: Canal,
    config: ConfiguracaoLida,
  ): ConfiguracaoLigacoesDto {
    return {
      canalId: canal.id,
      ativa: config.ativa,
      botaoVisivel: config.botaoVisivel,
      horario: lerHorario(config.horario) as Record<string, unknown> | null,
      horarioEfetivo: this.horarioEfetivo(canal, config) as Record<
        string,
        unknown
      > | null,
      filaId: config.filaId,
      filaEfetivaId: config.filaId ?? canal.filaPadraoId,
      gravar: config.gravar,
      retencaoDias: config.retencaoDias,
      avisoArquivoId: config.avisoArquivoId,
      tempoDeToqueSegundos: config.tempoDeToqueSegundos,
      mensagemPerdidaAtiva: config.mensagemPerdidaAtiva,
      mensagemPerdida: config.mensagemPerdida,
      sincronizadaEm: config.sincronizadaEm?.toISOString() ?? null,
      ultimoErroMeta: config.ultimoErroMeta,
      campoDoWebhook: CAMPO_DE_CHAMADAS,
    };
  }
}
