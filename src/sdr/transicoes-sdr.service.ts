/**
 * Estado do SDR numa conversa (R31): as mudanças de situação que não vêm de
 * um turno da IA (uma pessoa assumiu, a conversa foi resolvida), o registro das
 * decisões (linha do tempo + tokens, com auditoria) e o aviso de tempo real.
 */
import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import type {
  AcaoSdr,
  ModoSdr,
  Prisma,
  SdrConversa,
  TemperaturaSdr,
  TipoDecisaoSdr,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR } from '../tempo-real/catalogo';
import { TempoRealPublicador } from '../tempo-real/tempo-real.publicador';
import { REGRA_SDR } from './sdr.constantes';
import type { UsoDeTokensSdr } from './orcamento-sdr.service';

/** O ator das ações automáticas do SDR (auditoria e mensagens: `IA`). */
export const ATOR_DO_SDR = {
  tipoAtor: 'IA' as const,
  descricao: 'SDR com IA',
};

export interface NovaDecisao {
  conversaId: string | null;
  tipo: TipoDecisaoSdr;
  acao?: AcaoSdr | null;
  /** Frase curta da linha do tempo. */
  titulo: string;
  motivo?: string | null;
  resumo?: string | null;
  resposta?: string | null;
  criterios?: unknown;
  nota?: number | null;
  temperatura?: TemperaturaSdr | null;
  modo?: ModoSdr | null;
  modelo?: string | null;
  baseVersao?: number | null;
  mensagemId?: string | null;
  usuarioId?: string | null;
  uso?: UsoDeTokensSdr;
  tentativas?: number;
  simulador?: boolean;
  /** Padrão: audita. Quem já audita a ação por conta própria passa `false`. */
  auditar?: boolean;
}

const ACAO_DA_AUDITORIA: Readonly<Record<TipoDecisaoSdr, string>> = {
  ASSUMIU: 'sdr.assumiu',
  TURNO: 'sdr.turno',
  QUALIFICADO: 'sdr.lead-qualificado',
  DESQUALIFICADO: 'sdr.lead-desqualificado',
  PASSOU_HUMANO: 'sdr.passou-humano',
  HUMANO_ASSUMIU: 'sdr.humano-assumiu',
  DEVOLVIDA: 'sdr.devolvida',
  BLOQUEIO: 'sdr.bloqueio',
  FALHA: 'sdr.falha',
};

export const MOTIVO_DO_AVISO = {
  ASSUMIU: 'assumiu',
  TURNO: 'turno',
  SUGESTAO: 'sugestao',
  QUALIFICADA: 'qualificada',
  DESQUALIFICADA: 'desqualificada',
  PASSOU_HUMANO: 'passou_humano',
  HUMANO_ASSUMIU: 'humano_assumiu',
  DEVOLVIDA: 'devolvida',
  ENCERRADA: 'encerrada',
  SUGESTAO_RESOLVIDA: 'sugestao_resolvida',
} as const;

@Injectable()
export class TransicoesSdrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly motor: MotorDoAtendimento,
    private readonly publicador: TempoRealPublicador,
  ) {}

  /** Trava a linha do estado da conversa até o fim da transação. */
  async travarEstado(tx: Tx, conversaId: string): Promise<SdrConversa | null> {
    await tx.$queryRaw`SELECT id FROM sdr_conversas WHERE conversa_id = ${conversaId}::uuid FOR UPDATE`;
    return tx.sdrConversa.findUnique({ where: { conversaId } });
  }

  async registrarDecisao(tx: Tx, d: NovaDecisao): Promise<string> {
    const uso = d.uso ?? {
      entrada: 0,
      saida: 0,
      cacheLeitura: 0,
      cacheEscrita: 0,
    };
    const criada = await tx.sdrDecisao.create({
      data: {
        conversaId: d.conversaId,
        tipo: d.tipo,
        acao: d.acao ?? null,
        titulo: d.titulo.slice(0, 300),
        motivo: d.motivo ?? null,
        resumo: d.resumo ?? null,
        resposta: d.resposta ?? null,
        criterios: (d.criterios ?? undefined) as
          Prisma.InputJsonValue | undefined,
        nota: d.nota ?? null,
        temperatura: d.temperatura ?? null,
        modo: d.modo ?? null,
        modelo: d.modelo ?? null,
        baseVersao: d.baseVersao ?? null,
        mensagemId: d.mensagemId ?? null,
        usuarioId: d.usuarioId ?? null,
        tokensEntrada: uso.entrada,
        tokensSaida: uso.saida,
        tokensCacheLeitura: uso.cacheLeitura,
        tokensCacheEscrita: uso.cacheEscrita,
        tentativas: d.tentativas ?? 1,
        simulador: d.simulador ?? false,
      },
    });
    if (d.auditar !== false && d.conversaId) {
      const conversa = await tx.conversa.findUnique({
        where: { id: d.conversaId },
        select: { contatoId: true },
      });
      await this.auditoria.registrar(tx, {
        acao: ACAO_DA_AUDITORIA[d.tipo],
        entidade: 'conversa',
        entidadeId: d.conversaId,
        resumo: `SDR com IA: ${d.titulo}`.slice(0, 300),
        dados: {
          regra: REGRA_SDR,
          decisaoId: criada.id,
          tipo: d.tipo,
          acao: d.acao ?? null,
          motivo: d.motivo ?? null,
          nota: d.nota ?? null,
          temperatura: d.temperatura ?? null,
          modo: d.modo ?? null,
          modelo: d.modelo ?? null,
          baseVersao: d.baseVersao ?? null,
          tokens: uso,
          criterios: d.criterios ?? null,
        },
        relacionados: conversa ? { contato: conversa.contatoId } : undefined,
      });
    }
    return criada.id;
  }

  async marcarSugestoesObsoletas(tx: Tx, conversaId: string): Promise<number> {
    const r = await tx.sdrSugestao.updateMany({
      where: { conversaId, status: 'PENDENTE' },
      data: { status: 'OBSOLETA', resolvidaEm: new Date() },
    });
    return r.count;
  }

  /**
   * Avisa o tempo real (depois do commit): o estado do SDR da conversa
   * (`sdr.atualizado`) e o resumo da conversa (`conversa.atualizada`, que leva
   * o selo "IA atendendo" e a temperatura).
   */
  async emitir(tx: Tx, conversaId: string, motivo: string): Promise<void> {
    const conversa = await tx.conversa.findUnique({
      where: { id: conversaId },
      select: {
        id: true,
        responsavelId: true,
        fila: { select: { area: true } },
        sdr: true,
      },
    });
    if (!conversa) {
      return;
    }
    const pendentes = await tx.sdrSugestao.count({
      where: { conversaId, status: 'PENDENTE' },
    });
    if (conversa.sdr) {
      await this.publicador.emitirAposCommit(tx, {
        salas: this.motor.salas(conversa),
        evento: EVENTOS_DO_SERVIDOR.SDR_ATUALIZADO,
        dados: {
          conversaId,
          situacao: conversa.sdr.situacao,
          modo: conversa.sdr.modo,
          nota: conversa.sdr.nota,
          temperatura: conversa.sdr.temperatura,
          sugestaoPendente: pendentes > 0,
          motivo,
        },
      });
    }
    await this.motor.emitirConversa(tx, conversaId);
  }

  /**
   * Uma pessoa assumiu (mandou mensagem, clicou em "Assumir" ou ficou com a
   * conversa): a IA para até alguém devolver. Idempotente.
   */
  async humanoAssumiu(
    conversaId: string,
    pessoa: { id: string; nome: string } | null,
    motivo: string,
  ): Promise<boolean> {
    return executarComoAtor(ATOR_DO_SDR, () =>
      this.prisma.$transaction(async (tx) => {
        const estado = await this.travarEstado(tx, conversaId);
        if (!estado || estado.situacao !== 'ATIVA') {
          return false;
        }
        await tx.sdrConversa.update({
          where: { id: estado.id },
          data: {
            situacao: 'HUMANO',
            humanoId: pessoa?.id ?? null,
            motivo,
            situacaoDesde: new Date(),
            execucaoDesde: null,
          },
        });
        await this.marcarSugestoesObsoletas(tx, conversaId);
        await this.registrarDecisao(tx, {
          conversaId,
          tipo: 'HUMANO_ASSUMIU',
          titulo: pessoa
            ? `${pessoa.nome} assumiu a conversa: a IA parou`
            : 'Uma pessoa da equipe assumiu a conversa: a IA parou',
          motivo,
          modo: estado.modo,
          usuarioId: pessoa?.id ?? null,
        });
        await this.emitir(tx, conversaId, MOTIVO_DO_AVISO.HUMANO_ASSUMIU);
        return true;
      }),
    );
  }

  /** A conversa foi resolvida: o SDR encerra o estado e as sugestões perdem a vez. */
  async encerrar(conversaId: string): Promise<boolean> {
    return executarComoAtor(ATOR_DO_SDR, () =>
      this.prisma.$transaction(async (tx) => {
        const estado = await this.travarEstado(tx, conversaId);
        if (
          !estado ||
          ['ENCERRADA', 'QUALIFICADA', 'DESQUALIFICADA'].includes(
            estado.situacao,
          )
        ) {
          return false;
        }
        await tx.sdrConversa.update({
          where: { id: estado.id },
          data: {
            situacao: 'ENCERRADA',
            situacaoDesde: new Date(),
            execucaoDesde: null,
          },
        });
        await this.marcarSugestoesObsoletas(tx, conversaId);
        await this.emitir(tx, conversaId, MOTIVO_DO_AVISO.ENCERRADA);
        return true;
      }),
    );
  }
}
