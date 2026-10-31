import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { Injectable } from '@nestjs/common';
import { SegmentosService } from '../comum/segmentos/segmentos.service';
import type { Segmento } from '../comum/segmentos/segmentos';
import {
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import type {
  Campanha,
  Prisma,
  TipoCanal,
  TipoPublico,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TAMANHO_DO_LOTE_DO_PUBLICO } from './disparos.constantes';

export interface PreviaDoPublico {
  /** Contatos do público (opt-out fora). */
  total: number;
  /** Com telefone (WhatsApp) ou e-mail (e-mail): os que podem receber. */
  elegiveis: number;
  semDestino: number;
  /** Contatos que o público teria, mas pediram para não receber (R4.6). */
  optOutExcluidos: number;
  amostra: Array<{
    id: string;
    nome: string;
    email: string | null;
    telefone: string | null;
    etiquetas: string[];
  }>;
}

export interface ResultadoDaMontagem {
  total: number;
  pendentes: number;
  excluidos: number;
}

type OrigemDoPublico = Pick<
  Campanha,
  'tipoPublico' | 'segmento' | 'importacaoId' | 'canal'
>;

/**
 * Público da campanha (R17): segmento (`SegmentosService`) ou lista importada.
 * Opt-out sempre excluído; sem telefone/e-mail e duplicados (mesmo telefone ou
 * e-mail em outro contato) ficam `EXCLUIDO` com o motivo, para o relatório.
 */
@Injectable()
export class PublicoDaCampanha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segmentos: SegmentosService,
  ) {}

  /** Valida a origem do público (segmento válido; importação existente e concluída). */
  async validarOrigem(
    origem: Pick<Campanha, 'tipoPublico' | 'segmento' | 'importacaoId'>,
    usuario?: UsuarioAutenticado,
  ): Promise<void> {
    if (origem.tipoPublico === 'SEGMENTO') {
      if (!origem.segmento) {
        throw new DadosInvalidosException('Informe o segmento do público.', {
          campos: [{ campo: 'segmento', mensagens: ['é obrigatório'] }],
        });
      }
      if (usuario) {
        await this.segmentos.validarParaUsuario(origem.segmento, usuario);
      } else {
        this.segmentos.validar(origem.segmento);
      }
      return;
    }
    if (!origem.importacaoId) {
      throw new DadosInvalidosException('Escolha a importação do público.', {
        campos: [{ campo: 'importacaoId', mensagens: ['é obrigatório'] }],
      });
    }
    const importacao = await this.prisma.importacao.findUnique({
      where: { id: origem.importacaoId },
      select: { tipo: true, status: true },
    });
    if (!importacao) {
      throw new NaoEncontradoException('Importação não encontrada.');
    }
    if (importacao.tipo !== 'CONTATOS') {
      throw new DadosInvalidosException(
        'Só importações de contatos podem formar o público.',
        {
          campos: [{ campo: 'importacaoId', mensagens: ['não é de contatos'] }],
        },
      );
    }
    if (importacao.status !== 'CONCLUIDA') {
      throw new DadosInvalidosException(
        'A importação ainda não foi concluída.',
        { campos: [{ campo: 'importacaoId', mensagens: ['não concluída'] }] },
      );
    }
  }

  /** Contagem e amostra, sem montar nada. */
  async previa(
    origem: OrigemDoPublico,
    usuario?: UsuarioAutenticado,
  ): Promise<PreviaDoPublico> {
    await this.validarOrigem(origem, usuario);
    const campoDeContato: Prisma.ContatoWhereInput =
      origem.canal === 'WHATSAPP'
        ? { telefone: { not: null } }
        : { email: { not: null } };
    if (origem.tipoPublico === 'SEGMENTO') {
      const segmento = this.segmentos.validar(origem.segmento);
      const restricao = usuario ? this.segmentos.opcoesDoUsuario(usuario) : {};
      const [total, elegiveis, comOptOut, amostra] = await Promise.all([
        this.segmentos.contar(segmento, restricao),
        this.segmentos.contar(segmento, {
          ...restricao,
          escopo: campoDeContato,
        }),
        this.segmentos.contar(segmento, { ...restricao, excluirOptOut: false }),
        this.segmentos.amostra(segmento, { ...restricao, limite: 10 }),
      ]);
      return {
        total,
        elegiveis,
        semDestino: total - elegiveis,
        optOutExcluidos: Math.max(0, comOptOut - total),
        amostra: amostra.map((c) => ({
          id: c.id,
          nome: c.nome,
          email: c.email,
          telefone: c.telefone,
          etiquetas: c.etiquetas,
        })),
      };
    }
    const ids = await this.idsDaImportacao(origem.importacaoId as string);
    const base: Prisma.ContatoWhereInput = {
      id: { in: ids },
      excluidoEm: null,
    };
    const [total, elegiveis, comOptOut, amostra] = await Promise.all([
      this.prisma.contato.count({ where: { ...base, optOutMarketing: false } }),
      this.prisma.contato.count({
        where: { ...base, optOutMarketing: false, ...campoDeContato },
      }),
      this.prisma.contato.count({ where: base }),
      this.prisma.contato.findMany({
        where: { ...base, optOutMarketing: false },
        take: 10,
        orderBy: { id: 'asc' },
        select: {
          id: true,
          nome: true,
          email: true,
          telefone: true,
          etiquetas: true,
        },
      }),
    ]);
    return {
      total,
      elegiveis,
      semDestino: total - elegiveis,
      optOutExcluidos: Math.max(0, comOptOut - total),
      amostra,
    };
  }

  /**
   * Cria os destinatários da campanha (uma vez). Ordem estável pelo id do contato.
   * Já com destinatários: não faz nada (devolve os números atuais).
   */
  async montar(campanha: Campanha): Promise<ResultadoDaMontagem> {
    const existentes = await this.prisma.campanhaDestinatario.count({
      where: { campanhaId: campanha.id },
    });
    if (existentes > 0) {
      return this.totais(campanha.id);
    }
    const vistos = new Set<string>();
    let ordem = 0;
    const gravar = async (
      contatos: Array<{
        id: string;
        telefone: string | null;
        email: string | null;
        optOutMarketing: boolean;
      }>,
    ): Promise<void> => {
      const linhas: Prisma.CampanhaDestinatarioCreateManyInput[] = [];
      for (const contato of contatos) {
        const destino =
          campanha.canal === 'WHATSAPP'
            ? contato.telefone
            : contato.email?.toLowerCase();
        let status: 'PENDENTE' | 'EXCLUIDO' = 'PENDENTE';
        let motivo: string | null = null;
        if (contato.optOutMarketing) {
          status = 'EXCLUIDO';
          motivo = 'O contato pediu para não receber mensagens (opt-out).';
        } else if (!destino) {
          status = 'EXCLUIDO';
          motivo =
            campanha.canal === 'WHATSAPP'
              ? 'O contato não tem telefone.'
              : 'O contato não tem e-mail.';
        } else if (vistos.has(destino)) {
          status = 'EXCLUIDO';
          motivo =
            campanha.canal === 'WHATSAPP'
              ? 'Telefone repetido: outro contato da lista já vai receber.'
              : 'E-mail repetido: outro contato da lista já vai receber.';
        } else {
          vistos.add(destino);
        }
        linhas.push({
          campanhaId: campanha.id,
          contatoId: contato.id,
          destino: destino ?? '',
          ordem: ordem++,
          status,
          motivo,
        });
      }
      if (linhas.length > 0) {
        await this.prisma.campanhaDestinatario.createMany({
          data: linhas,
          skipDuplicates: true,
        });
      }
    };

    const selecao = {
      id: true,
      telefone: true,
      email: true,
      optOutMarketing: true,
    } as const;
    if (campanha.tipoPublico === 'SEGMENTO') {
      const segmento: Segmento = this.segmentos.validar(campanha.segmento);
      for await (const ids of this.segmentos.iterarIds(segmento, {
        lote: TAMANHO_DO_LOTE_DO_PUBLICO,
      })) {
        const contatos = await this.prisma.contato.findMany({
          where: { id: { in: ids }, excluidoEm: null },
          orderBy: { id: 'asc' },
          select: selecao,
        });
        await gravar(contatos);
      }
    } else {
      const ids = await this.idsDaImportacao(campanha.importacaoId as string);
      for (let i = 0; i < ids.length; i += TAMANHO_DO_LOTE_DO_PUBLICO) {
        const contatos = await this.prisma.contato.findMany({
          where: {
            id: { in: ids.slice(i, i + TAMANHO_DO_LOTE_DO_PUBLICO) },
            excluidoEm: null,
          },
          orderBy: { id: 'asc' },
          select: selecao,
        });
        await gravar(contatos);
      }
    }
    return this.totais(campanha.id);
  }

  /** Contatos criados ou atualizados pela importação (sem repetição). */
  async idsDaImportacao(importacaoId: string): Promise<string[]> {
    const linhas = await this.prisma.importacaoLinha.findMany({
      where: {
        importacaoId,
        resultado: { in: ['CRIADO', 'ATUALIZADO'] },
        entidadeId: { not: null },
      },
      select: { entidadeId: true },
      orderBy: { numero: 'asc' },
    });
    return [...new Set(linhas.map((l) => l.entidadeId as string))];
  }

  private async totais(campanhaId: string): Promise<ResultadoDaMontagem> {
    const grupos = await this.prisma.campanhaDestinatario.groupBy({
      by: ['status'],
      where: { campanhaId },
      _count: { _all: true },
    });
    let total = 0;
    let pendentes = 0;
    let excluidos = 0;
    for (const grupo of grupos) {
      total += grupo._count._all;
      if (grupo.status === 'PENDENTE') {
        pendentes += grupo._count._all;
      }
      if (grupo.status === 'EXCLUIDO') {
        excluidos += grupo._count._all;
      }
    }
    return { total, pendentes, excluidos };
  }
}

export type { TipoCanal, TipoPublico };
