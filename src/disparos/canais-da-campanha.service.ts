import { Injectable } from '@nestjs/common';
import {
  dataDoDia,
  diaEmSaoPaulo,
  inicioDoProximoDia,
  limiteDoDia,
} from '../canais/whatsapp/protecoes';
import type {
  Campanha,
  Canal,
  WhatsappNumero,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PisoDoNumero } from './ritmo';

export type CanalComNumero = Canal & { whatsappNumero: WhatsappNumero | null };

export type EscolhaDeCanal =
  | {
      tipo: 'canal';
      canal: CanalComNumero;
      piso: PisoDoNumero | null;
    }
  | { tipo: 'limite'; ate: Date; motivo: string }
  | { tipo: 'indisponivel'; motivo: string };

/**
 * Rodízio entre os canais (números de WhatsApp ou caixas de e-mail) da
 * campanha, respeitando o que o gateway impõe (R13): número conectado e não
 * pausado, limite diário com aquecimento e o intervalo mínimo do número.
 */
@Injectable()
export class CanaisDaCampanha {
  constructor(private readonly prisma: PrismaService) {}

  /** Os canais da campanha na ordem do rodízio. */
  async listar(campanhaId: string): Promise<CanalComNumero[]> {
    const ligacoes = await this.prisma.campanhaCanal.findMany({
      where: { campanhaId },
      orderBy: { ordem: 'asc' },
      include: { canal: { include: { whatsappNumero: true } } },
    });
    return ligacoes.map((l) => l.canal);
  }

  /**
   * Escolhe o próximo canal do rodízio: o primeiro depois do último usado que
   * esteja disponível. Todos no limite do dia → espera até o dia seguinte;
   * nenhum utilizável → `indisponivel` (o envio conta como falha seguida).
   */
  async escolher(
    campanha: Pick<Campanha, 'id' | 'canal' | 'ultimoCanalId'>,
    agora: Date,
    opcoes: { ignorarLimite?: boolean } = {},
  ): Promise<EscolhaDeCanal> {
    const canais = await this.listar(campanha.id);
    if (canais.length === 0) {
      return {
        tipo: 'indisponivel',
        motivo: 'A campanha não tem número ou caixa de envio.',
      };
    }
    const inicio = Math.max(
      0,
      canais.findIndex((c) => c.id === campanha.ultimoCanalId) + 1,
    );
    const rotacionados = [...canais.slice(inicio), ...canais.slice(0, inicio)];
    let noLimite = false;
    const motivos: string[] = [];
    const dia = dataDoDia(diaEmSaoPaulo(agora));
    for (const canal of rotacionados) {
      if (!canal.ativo || canal.excluidoEm) {
        motivos.push(`${canal.nome}: canal desativado`);
        continue;
      }
      if (campanha.canal === 'EMAIL') {
        return { tipo: 'canal', canal, piso: null };
      }
      const numero = canal.whatsappNumero;
      if (!numero) {
        motivos.push(`${canal.nome}: sem número configurado`);
        continue;
      }
      if (numero.status !== 'CONECTADO') {
        motivos.push(`${canal.nome}: número desconectado`);
        continue;
      }
      if (numero.pausadoEm) {
        motivos.push(
          `${canal.nome}: número pausado${numero.pausaMotivo ? ` (${numero.pausaMotivo})` : ''}`,
        );
        continue;
      }
      if (!opcoes.ignorarLimite) {
        const [diario, emEnvio] = await Promise.all([
          this.prisma.whatsappEnvioDiario.findUnique({
            where: { numeroId_dia: { numeroId: numero.id, dia } },
            select: { enviados: true },
          }),
          this.prisma.campanhaDestinatario.count({
            where: { canalId: canal.id, status: 'ENVIANDO' },
          }),
        ]);
        const usados = (diario?.enviados ?? 0) + emEnvio;
        if (usados >= limiteDoDia(numero, agora)) {
          noLimite = true;
          motivos.push(`${canal.nome}: limite diário atingido`);
          continue;
        }
      }
      return {
        tipo: 'canal',
        canal,
        piso: {
          intervaloMinimoSegundos: numero.intervaloMinimoSegundos,
          intervaloMaximoSegundos: numero.intervaloMaximoSegundos,
        },
      };
    }
    if (noLimite && motivos.every((m) => m.includes('limite diário'))) {
      return {
        tipo: 'limite',
        ate: inicioDoProximoDia(agora),
        motivo: motivos.join('; '),
      };
    }
    if (noLimite) {
      // Parte no limite, parte fora do ar: o que voltar primeiro (o dia seguinte ou a reconexão).
      return { tipo: 'indisponivel', motivo: motivos.join('; ') };
    }
    return { tipo: 'indisponivel', motivo: motivos.join('; ') };
  }
}
