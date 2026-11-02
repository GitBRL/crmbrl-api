import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type GatilhoDisparado,
  GatilhosService,
} from '../comum/gatilhos/gatilhos.service';
import { formatarValor } from '../comum/dominio/dinheiro';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService } from '../prisma/prisma.service';

export const TIPO_NOTIFICACAO_SUGESTAO_CONTRATO = 'contrato.sugerido';

/**
 * R22.6 — ao ganhar um negócio, o CRM sugere criar o contrato: notifica o
 * responsável do negócio e os líderes de CS, com o link da tela de novo contrato
 * já preenchida (`GET /financeiro/negocios/:id/sugestao-de-contrato`).
 */
@Injectable()
export class SugestaoDeContratoService implements OnModuleInit {
  constructor(
    private readonly gatilhos: GatilhosService,
    private readonly prisma: PrismaService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  onModuleInit(): void {
    this.gatilhos.registrarDestino({
      nome: 'financeiro-sugestao-de-contrato',
      eventos: ['negocio.ganho'],
      ignorarLimiteDeEncadeamento: true,
      aoDisparar: (g) => this.aoGanhar(g),
    });
  }

  async aoGanhar(g: GatilhoDisparado): Promise<void> {
    const negocioId = (g.evento.dados as { negocioId?: string }).negocioId;
    if (!negocioId) return;
    const negocio = await this.prisma.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null, status: 'GANHO' },
      include: {
        contato: { select: { nome: true } },
        empresa: { select: { nome: true } },
      },
    });
    if (!negocio) return;
    if ((await this.prisma.contrato.count({ where: { negocioId } })) > 0)
      return;
    const lideres = await this.prisma.usuario.findMany({
      where: { papel: 'LIDER_CS', ativo: true },
      select: { id: true },
    });
    const destinos = [
      ...(negocio.responsavelId ? [negocio.responsavelId] : []),
      ...lideres.map((l) => l.id),
    ];
    if (destinos.length === 0) return;
    const cliente = negocio.empresa?.nome ?? negocio.contato.nome;
    await this.prisma.$transaction(async (tx) => {
      // Idempotência: a outbox entrega "pelo menos uma vez".
      const ja = await tx.notificacao.findFirst({
        where: {
          tipo: TIPO_NOTIFICACAO_SUGESTAO_CONTRATO,
          dados: { path: ['negocioId'], equals: negocioId },
        },
        select: { id: true },
      });
      if (ja) return;
      await this.notificacoes.notificarVarios(tx, destinos, {
        tipo: TIPO_NOTIFICACAO_SUGESTAO_CONTRATO,
        titulo: 'Negócio ganho: criar o contrato?',
        texto: `${cliente} fechou "${negocio.titulo}" (R$ ${formatarValor(negocio.valorRecorrente ?? negocio.valor)}). Crie o contrato para gerar as parcelas.`,
        link: `/financeiro/contratos/novo?negocio=${negocioId}`,
        dados: { negocioId },
      });
    });
  }
}
