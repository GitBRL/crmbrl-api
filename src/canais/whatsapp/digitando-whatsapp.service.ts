import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AvisoDeDigitando,
  TempoRealService,
} from '../../tempo-real/tempo-real.service';
import { ClienteGatewayWhatsapp } from './cliente-gateway';
import { ehJidDeContato } from './contrato-gateway';

/** Não repete o mesmo aviso ao gateway mais que uma vez a cada tanto (o WhatsApp mantém o "digitando…" por ~25 s). */
const INTERVALO_MINIMO_MS = 8_000;

/**
 * Repassa o "digitando…" do atendente ao contato no WhatsApp (§2.2): o tempo
 * real avisa (`aoDigitar`) quando alguém da equipe digita numa conversa, e o
 * comando vai ao gateway (`POST /numeros/:id/digitando`). Melhor esforço: sem
 * número conectado, conversa resolvida ou gateway fora do ar, nada acontece.
 */
@Injectable()
export class DigitandoWhatsappService implements OnModuleInit {
  /** Último aviso repassado por conversa (para não inundar o gateway). */
  private readonly ultimos = new Map<string, { ativo: boolean; em: number }>();

  constructor(
    private readonly tempoReal: TempoRealService,
    private readonly prisma: PrismaService,
    private readonly gateway: ClienteGatewayWhatsapp,
  ) {}

  onModuleInit(): void {
    this.tempoReal.aoDigitar((aviso) => this.repassar(aviso));
  }

  /** Público para os testes. */
  async repassar(aviso: AvisoDeDigitando): Promise<void> {
    if (aviso.tipo !== 'conversa') {
      return;
    }
    const agora = Date.now();
    const ultimo = this.ultimos.get(aviso.id);
    if (
      ultimo &&
      ultimo.ativo === aviso.ativo &&
      agora - ultimo.em < INTERVALO_MINIMO_MS
    ) {
      return;
    }
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: aviso.id },
      select: {
        idExterno: true,
        status: true,
        canal: {
          select: {
            tipo: true,
            excluidoEm: true,
            whatsappNumero: { select: { id: true, status: true } },
          },
        },
      },
    });
    const numero = conversa?.canal.whatsappNumero;
    if (
      !conversa ||
      conversa.status === 'RESOLVIDA' ||
      conversa.canal.tipo !== 'WHATSAPP' ||
      conversa.canal.excluidoEm ||
      !numero ||
      numero.status !== 'CONECTADO' ||
      !ehJidDeContato(conversa.idExterno)
    ) {
      return;
    }
    this.ultimos.set(aviso.id, { ativo: aviso.ativo, em: agora });
    if (this.ultimos.size > 5_000) {
      this.ultimos.clear();
    }
    await this.gateway.digitando(numero.id, {
      para: conversa.idExterno,
      ativo: aviso.ativo,
    });
  }
}
