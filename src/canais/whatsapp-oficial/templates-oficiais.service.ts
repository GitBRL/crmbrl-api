import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import {
  NaoEncontradoException,
  ServicoIndisponivelException,
} from '../../comum/erros/excecoes';
import { FilaService } from '../../fila/fila.service';
import type {
  Canal,
  Prisma,
  WhatsappOficialTemplate,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfiguracaoDeCanais } from '../comum/configuracao-de-canais.service';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { ErroDaGraph } from '../meta/graph-api';
import { lerConfiguracaoOficial, type SegredosOficiais } from './formato-meta';
import { GraphWhatsappOficial } from './graph-whatsapp-oficial';

/** Fila (pg-boss) da sincronização diária dos templates. */
export const FILA_TEMPLATES_OFICIAIS = 'whatsapp-oficial.templates';
/** Todo dia às 03:00 (fuso de São Paulo). */
const AGENDA_DOS_TEMPLATES = '0 3 * * *';

export interface ResultadoDaSincronizacao {
  total: number;
  aprovados: number;
  sincronizadoEm: Date;
}

/**
 * Cache dos templates da WABA (R28): a lista vem de
 * `GET /{waba_id}/message_templates`, é gravada por canal (o que sumiu da Meta
 * some do cache) e atualizada à mão pelo Admin ou uma vez por dia pela fila.
 * Só os `APPROVED` servem para enviar.
 */
@Injectable()
export class TemplatesOficiaisService implements OnModuleInit {
  private readonly logger = new Logger('WhatsAppOficial');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly graph: GraphWhatsappOficial,
    private readonly segredos: SegredosDoCanal,
    private readonly configuracao: ConfiguracaoDeCanais,
    private readonly auditoria: AuditoriaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(FILA_TEMPLATES_OFICIAIS, () =>
      this.sincronizarTodos().then(() => undefined),
    );
    await this.fila.agendar(FILA_TEMPLATES_OFICIAIS, AGENDA_DOS_TEMPLATES);
  }

  /** Sincroniza todos os canais ativos (a fila diária); erro de um não para os outros. */
  async sincronizarTodos(): Promise<number> {
    const canais = await this.prisma.canal.findMany({
      where: { tipo: 'WHATSAPP_OFICIAL', ativo: true, excluidoEm: null },
    });
    let sincronizados = 0;
    for (const canal of canais) {
      try {
        await executarComoAtor(
          { tipoAtor: 'SISTEMA', descricao: 'WhatsApp oficial' },
          () => this.sincronizar(canal),
        );
        sincronizados++;
      } catch (erro) {
        this.logger.warn(
          `Templates do canal ${canal.nome} não sincronizados: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
    return sincronizados;
  }

  /**
   * Lê os templates da Meta e troca o cache do canal. Falha da Graph registra o
   * motivo no canal (`ultimoErro`) e relança.
   */
  async sincronizar(canal: Canal): Promise<ResultadoDaSincronizacao> {
    const { token, appSecret } =
      await this.segredos.ler<SegredosOficiais>(canal);
    const { wabaId } = lerConfiguracaoOficial(canal.configuracao);
    if (!token || !wabaId) {
      throw new ServicoIndisponivelException(
        'Informe o token e o id da conta (WABA) do canal para sincronizar os templates.',
      );
    }
    let templates;
    try {
      templates = await this.graph.listarTemplates(
        { token, appSecret },
        wabaId,
      );
    } catch (erro) {
      const motivo =
        erro instanceof ErroDaGraph && erro.tokenInvalido
          ? 'O token do canal é inválido ou expirou.'
          : `Não foi possível ler os templates na Meta: ${erro instanceof Error ? erro.message : String(erro)}`;
      await this.configuracao.registrarErro(canal.id, motivo);
      throw new ServicoIndisponivelException(motivo);
    }
    const agora = new Date();
    const validos = templates.filter(
      (item) => item.name && item.language && item.status,
    );
    const resultado = await this.prisma.$transaction(async (tx) => {
      const vistos: Array<{ nome: string; idioma: string }> = [];
      for (const item of validos) {
        const nome = item.name as string;
        const idioma = item.language as string;
        vistos.push({ nome, idioma });
        const dados = {
          idMeta: item.id ?? null,
          categoria: (item.category ?? 'UTILITY').toUpperCase(),
          status: (item.status as string).toUpperCase(),
          componentes: (item.components ?? []) as Prisma.InputJsonArray,
          sincronizadoEm: agora,
        };
        await tx.whatsappOficialTemplate.upsert({
          where: { canalId_nome_idioma: { canalId: canal.id, nome, idioma } },
          create: { canalId: canal.id, nome, idioma, ...dados },
          update: dados,
        });
      }
      const removidos = await tx.whatsappOficialTemplate.deleteMany({
        where: {
          canalId: canal.id,
          NOT: vistos.map(({ nome, idioma }) => ({ nome, idioma })),
        },
      });
      const aprovados = validos.filter(
        (item) => item.status?.toUpperCase() === 'APPROVED',
      ).length;
      await this.auditoria.registrar(tx, {
        acao: 'canal.templates_sincronizados',
        entidade: 'canal',
        entidadeId: canal.id,
        resumo: `Templates do WhatsApp oficial "${canal.nome}" sincronizados (${validos.length}, ${aprovados} aprovados)`,
        dados: {
          total: validos.length,
          aprovados,
          removidos: removidos.count,
        },
      });
      return { total: validos.length, aprovados, sincronizadoEm: agora };
    });
    await this.configuracao.atualizarEstado(canal.id, {
      templatesSincronizadosEm: agora.toISOString(),
    });
    await this.configuracao.registrarErro(canal.id, null);
    return resultado;
  }

  /** Templates do canal (todos, ou só os aprovados), por nome. */
  listar(
    canalId: string,
    somenteAprovados = false,
  ): Promise<WhatsappOficialTemplate[]> {
    return this.prisma.whatsappOficialTemplate.findMany({
      where: {
        canalId,
        ...(somenteAprovados ? { status: 'APPROVED' } : {}),
      },
      orderBy: [{ nome: 'asc' }, { idioma: 'asc' }],
    });
  }

  async obter(
    canalId: string,
    templateId: string,
  ): Promise<WhatsappOficialTemplate> {
    const template = await this.prisma.whatsappOficialTemplate.findFirst({
      where: { id: templateId, canalId },
    });
    if (!template) {
      throw new NaoEncontradoException('Template não encontrado neste canal.');
    }
    return template;
  }

  /** Quando os templates do canal foram sincronizados pela última vez. */
  async ultimaSincronizacao(canalId: string): Promise<Date | null> {
    const ultimo = await this.prisma.whatsappOficialTemplate.aggregate({
      where: { canalId },
      _max: { sincronizadoEm: true },
    });
    return ultimo._max.sincronizadoEm;
  }
}
