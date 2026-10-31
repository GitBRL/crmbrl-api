import { Injectable } from '@nestjs/common';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { tipoDoAnexo } from '../atendimento/mensagens.service';
import { ModelosService } from '../comum/modelos/modelos.service';
import type {
  Arquivo,
  Campanha,
  Canal,
  Conversa,
  Prisma,
} from '../generated/prisma/client';
import { type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';

export interface PedidoDeEntrega {
  campanha: Pick<
    Campanha,
    'id' | 'nome' | 'canal' | 'texto' | 'assunto' | 'simularDigitando'
  >;
  canal: Canal;
  contatoId: string;
  /** Semente das variações (o id do destinatário; no teste, o do contato). */
  semente: string;
  destinatarioId?: string | null;
  arquivo?: Pick<Arquivo, 'id' | 'mime'> | null;
  teste?: boolean;
}

export interface Entregue {
  mensagemId: string;
  conversaId: string;
  texto: string;
}

/**
 * Entrega a mensagem da campanha: renderiza o modelo para o contato (variações
 * sorteadas pela semente do destinatário), acha ou cria a conversa do contato
 * no canal e cria a mensagem de saída (`MotorDoAtendimento.criarSaida`, o mesmo
 * caminho do Atendimento: fila `atendimento.enviar` → adaptador do canal →
 * gateway). O autor é a automação (ator do contexto = a campanha).
 *
 * Conversa: a em aberto do contato no canal; senão a última que nunca recebeu
 * mensagem do contato (só de campanha); senão uma nova, já `RESOLVIDA` — para
 * não lotar a caixa de entrada com conversas sem resposta. Quando o contato
 * responde, o Atendimento abre uma conversa nova e a distribui pela fila.
 */
@Injectable()
export class EntregaDeCampanha {
  constructor(
    private readonly modelos: ModelosService,
    private readonly motor: MotorDoAtendimento,
  ) {}

  async entregar(tx: Tx, pedido: PedidoDeEntrega): Promise<Entregue> {
    const { campanha, canal } = pedido;
    const opcoes = { semente: pedido.semente, tx };
    const texto = (
      await this.modelos.renderizarPara(
        campanha.texto,
        { contatoId: pedido.contatoId },
        opcoes,
      )
    ).texto.trim();
    const assunto =
      campanha.canal === 'EMAIL' && campanha.assunto
        ? (
            await this.modelos.renderizarPara(
              campanha.assunto,
              { contatoId: pedido.contatoId },
              opcoes,
            )
          ).texto.trim()
        : null;

    await travarChave(tx, 'atendimento-conversa', canal.id, pedido.contatoId);
    const conversa = await this.conversaDoContato(
      tx,
      canal,
      pedido.contatoId,
      assunto,
    );
    const mensagem = await this.motor.criarSaida(tx, conversa, canal, {
      tipo: pedido.arquivo ? tipoDoAnexo(pedido.arquivo.mime) : 'TEXTO',
      texto: texto === '' ? null : texto,
      arquivoId: pedido.arquivo?.id ?? null,
      autorId: null,
      metadados: {
        campanhaId: campanha.id,
        campanha: campanha.nome,
        ...(pedido.destinatarioId
          ? { destinatarioId: pedido.destinatarioId }
          : {}),
        ...(pedido.teste ? { teste: true } : {}),
        ...(!campanha.simularDigitando ? { digitando: false } : {}),
      } satisfies Prisma.InputJsonObject,
    });
    await tx.conversa.update({
      where: { id: conversa.id },
      data: {
        ultimaMensagemId: mensagem.id,
        ultimaMensagemEm: mensagem.ocorridaEm ?? new Date(),
      },
    });
    return { mensagemId: mensagem.id, conversaId: conversa.id, texto };
  }

  private async conversaDoContato(
    tx: Tx,
    canal: Canal,
    contatoId: string,
    assunto: string | null,
  ): Promise<Conversa> {
    const aberta = await tx.conversa.findFirst({
      where: { canalId: canal.id, contatoId, status: { not: 'RESOLVIDA' } },
    });
    if (aberta) {
      return aberta;
    }
    const reaproveitavel = await tx.conversa.findFirst({
      where: {
        canalId: canal.id,
        contatoId,
        status: 'RESOLVIDA',
        ultimaEntradaEm: null,
      },
      orderBy: { criadoEm: 'desc' },
    });
    if (reaproveitavel) {
      return assunto && assunto !== reaproveitavel.assunto
        ? tx.conversa.update({
            where: { id: reaproveitavel.id },
            data: { assunto },
          })
        : reaproveitavel;
    }
    const agora = new Date();
    return tx.conversa.create({
      data: {
        canalId: canal.id,
        contatoId,
        filaId: canal.filaPadraoId,
        status: 'RESOLVIDA',
        resolvidaEm: agora,
        assunto,
      },
    });
  }
}
