import { Injectable } from '@nestjs/common';
import { liderDaArea } from '../comum/dominio/papeis';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR, salas } from '../tempo-real/catalogo';
import { TempoRealPublicador } from '../tempo-real/tempo-real.publicador';

/** Números do relatório e do progresso ao vivo de uma campanha. */
export interface ContadoresDaCampanha {
  total: number;
  pendentes: number;
  enviando: number;
  enviados: number;
  entregues: number;
  lidos: number;
  respondidos: number;
  falhas: number;
  invalidos: number;
  excluidos: number;
  optOuts: number;
}

interface LinhaDeContagem {
  total: number;
  pendentes: number;
  enviando: number;
  enviados: number;
  entregues: number;
  lidos: number;
  respondidos: number;
  falhas: number;
  invalidos: number;
  excluidos: number;
  opt_outs: number;
}

/**
 * Contadores da campanha (uma varredura por consulta, usando o índice
 * `campanha_id, status`) e o aviso de progresso em tempo real
 * (`campanha.progresso`) para o criador, o líder da área e a diretoria.
 */
@Injectable()
export class ProgressoDaCampanha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publicador: TempoRealPublicador,
  ) {}

  /** Conta os destinatários (sem gravar nada). */
  async contar(
    banco: Tx | PrismaService,
    campanhaId: string,
  ): Promise<ContadoresDaCampanha> {
    const [linha] = await banco.$queryRaw<LinhaDeContagem[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'PENDENTE')::int AS pendentes,
             COUNT(*) FILTER (WHERE status = 'ENVIANDO')::int AS enviando,
             COUNT(*) FILTER (WHERE enviado_em IS NOT NULL)::int AS enviados,
             COUNT(*) FILTER (WHERE entregue_em IS NOT NULL)::int AS entregues,
             COUNT(*) FILTER (WHERE lido_em IS NOT NULL)::int AS lidos,
             COUNT(*) FILTER (WHERE respondeu_em IS NOT NULL)::int AS respondidos,
             COUNT(*) FILTER (WHERE status = 'FALHOU')::int AS falhas,
             COUNT(*) FILTER (WHERE status = 'INVALIDO')::int AS invalidos,
             COUNT(*) FILTER (WHERE status = 'EXCLUIDO')::int AS excluidos,
             COUNT(*) FILTER (WHERE opt_out_em IS NOT NULL)::int AS opt_outs
        FROM campanha_destinatarios
       WHERE campanha_id = ${campanhaId}::uuid`;
    return {
      total: linha?.total ?? 0,
      pendentes: linha?.pendentes ?? 0,
      enviando: linha?.enviando ?? 0,
      enviados: linha?.enviados ?? 0,
      entregues: linha?.entregues ?? 0,
      lidos: linha?.lidos ?? 0,
      respondidos: linha?.respondidos ?? 0,
      falhas: linha?.falhas ?? 0,
      invalidos: linha?.invalidos ?? 0,
      excluidos: linha?.excluidos ?? 0,
      optOuts: linha?.opt_outs ?? 0,
    };
  }

  /** Contadores de várias campanhas de uma vez (listas). */
  async contarVarias(
    ids: readonly string[],
  ): Promise<Map<string, ContadoresDaCampanha>> {
    const mapa = new Map<string, ContadoresDaCampanha>();
    if (ids.length === 0) {
      return mapa;
    }
    const linhas = await this.prisma.$queryRaw<
      Array<LinhaDeContagem & { campanha_id: string }>
    >`
      SELECT campanha_id,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'PENDENTE')::int AS pendentes,
             COUNT(*) FILTER (WHERE status = 'ENVIANDO')::int AS enviando,
             COUNT(*) FILTER (WHERE enviado_em IS NOT NULL)::int AS enviados,
             COUNT(*) FILTER (WHERE entregue_em IS NOT NULL)::int AS entregues,
             COUNT(*) FILTER (WHERE lido_em IS NOT NULL)::int AS lidos,
             COUNT(*) FILTER (WHERE respondeu_em IS NOT NULL)::int AS respondidos,
             COUNT(*) FILTER (WHERE status = 'FALHOU')::int AS falhas,
             COUNT(*) FILTER (WHERE status = 'INVALIDO')::int AS invalidos,
             COUNT(*) FILTER (WHERE status = 'EXCLUIDO')::int AS excluidos,
             COUNT(*) FILTER (WHERE opt_out_em IS NOT NULL)::int AS opt_outs
        FROM campanha_destinatarios
       WHERE campanha_id = ANY(${ids as string[]}::uuid[])
       GROUP BY campanha_id`;
    for (const linha of linhas) {
      mapa.set(linha.campanha_id, {
        total: linha.total,
        pendentes: linha.pendentes,
        enviando: linha.enviando,
        enviados: linha.enviados,
        entregues: linha.entregues,
        lidos: linha.lidos,
        respondidos: linha.respondidos,
        falhas: linha.falhas,
        invalidos: linha.invalidos,
        excluidos: linha.excluidos,
        optOuts: linha.opt_outs,
      });
    }
    return mapa;
  }

  /**
   * Recalcula, grava nos contadores da campanha e, se algo mudou (ou `forcar`),
   * avisa em tempo real depois do commit. Devolve os contadores.
   */
  async atualizar(
    tx: Tx,
    campanhaId: string,
    forcar = false,
  ): Promise<ContadoresDaCampanha> {
    const antes = await tx.campanha.findUniqueOrThrow({
      where: { id: campanhaId },
    });
    const c = await this.contar(tx, campanhaId);
    const mudou =
      forcar ||
      antes.totalDestinatarios !== c.total ||
      antes.enviados !== c.enviados ||
      antes.entregues !== c.entregues ||
      antes.lidos !== c.lidos ||
      antes.respondidos !== c.respondidos ||
      antes.falhas !== c.falhas ||
      antes.invalidos !== c.invalidos ||
      antes.optOuts !== c.optOuts;
    if (!mudou) {
      return c;
    }
    const depois = await tx.campanha.update({
      where: { id: campanhaId },
      data: {
        totalDestinatarios: c.total,
        enviados: c.enviados,
        entregues: c.entregues,
        lidos: c.lidos,
        respondidos: c.respondidos,
        falhas: c.falhas,
        invalidos: c.invalidos,
        optOuts: c.optOuts,
      },
    });
    await this.emitir(tx, depois, c);
    return c;
  }

  /** `campanha.progresso` depois do commit. */
  async emitir(
    tx: Tx,
    campanha: {
      id: string;
      status: string;
      area: Parameters<typeof liderDaArea>[0] | null;
      criadoPorId: string | null;
      proximoEnvioEm: Date | null;
      pausaMotivo: string | null;
    },
    contadores: ContadoresDaCampanha,
  ): Promise<void> {
    const destino = [salas.papel('ADMIN'), salas.papel('C_LEVEL')];
    if (campanha.area) {
      destino.push(salas.papel(liderDaArea(campanha.area)));
    }
    if (campanha.criadoPorId) {
      destino.push(salas.usuario(campanha.criadoPorId));
    }
    await this.publicador.emitirAposCommit(tx, {
      salas: destino,
      evento: EVENTOS_DO_SERVIDOR.CAMPANHA_PROGRESSO,
      dados: {
        campanhaId: campanha.id,
        status: campanha.status,
        contadores: { ...contadores },
        proximoEnvioEm: campanha.proximoEnvioEm?.toISOString() ?? null,
        pausaMotivo: campanha.pausaMotivo,
        em: new Date().toISOString(),
      },
    });
  }
}
