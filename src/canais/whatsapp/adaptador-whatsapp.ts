import { Injectable, type OnModuleInit } from '@nestjs/common';
import { FilaService } from '../../fila/fila.service';
import type { Canal, Conversa, Mensagem } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type ResultadoEnvio,
} from '../adaptador-canal';
import { RegistroCanais } from '../registro-canais';
import { ClienteGatewayWhatsapp } from './cliente-gateway';
import {
  ehJidDeContato,
  ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
  filaDeEnvio,
  gerarIdDeMensagemWhatsapp,
  jidDoTelefone,
  type PedidoDeEnvio,
  TENTATIVAS_DE_ENVIO,
} from './contrato-gateway';

/** Áudio que vira mensagem de voz sem precisar de `metadados.voz` (o que o navegador grava). */
const MIMES_DE_VOZ = new Set(['audio/webm', 'audio/ogg', 'audio/opus']);

/**
 * Canal WhatsApp do lado da API (R13): o envio vira um job na fila do número
 * (`whatsapp.envio.<numeroId>`), que o gateway consome uma mensagem por vez. O
 * id da mensagem no WhatsApp é gerado aqui e devolvido como `idExterno` (com
 * `enfileirado: true`): a mensagem fica `PENDENTE` até o gateway informar
 * `ENVIADA`/`FALHOU` pela fila `whatsapp.evento`.
 *
 * - Destino: o JID da conversa (de quem escreveu), senão o identificador do
 *   WhatsApp ou o telefone do contato.
 * - Áudio vai como **mensagem de voz** (o gateway converte para ogg/opus)
 *   quando `metadados.voz` é `true`, ou, sem a marca, quando é webm/ogg (o que
 *   o navegador grava); `metadados.voz = false` manda como arquivo de áudio.
 * - `respostaAoContato` (a conversa tem mensagem do contato) libera o opt-out
 *   (R4.6) e a verificação do número no gateway; mensagem ativa respeita os dois.
 */
@Injectable()
export class AdaptadorWhatsapp implements AdaptadorCanal, OnModuleInit {
  readonly tipo = 'WHATSAPP' as const;

  constructor(
    private readonly registro: RegistroCanais,
    private readonly fila: FilaService,
    private readonly prisma: PrismaService,
    private readonly gateway: ClienteGatewayWhatsapp,
  ) {}

  onModuleInit(): void {
    this.registro.registrar(this);
  }

  /** "Digitando…" ao contato (SDR com IA). Sem número conectado ou sem JID, não faz nada. */
  async digitar(
    conversa: Conversa,
    canal: Canal,
    ativo: boolean,
  ): Promise<void> {
    try {
      const numero = await this.prisma.whatsappNumero.findUnique({
        where: { canalId: canal.id },
        select: { id: true, status: true },
      });
      if (
        !numero ||
        numero.status !== 'CONECTADO' ||
        !ehJidDeContato(conversa.idExterno)
      ) {
        return;
      }
      await this.gateway.digitando(numero.id, {
        para: conversa.idExterno,
        ativo,
      });
    } catch {
      // melhor esforço
    }
  }

  async enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    const numero = await this.prisma.whatsappNumero.findUnique({
      where: { canalId: canal.id },
      select: { id: true },
    });
    if (!numero) {
      throw new FalhaDefinitivaDeEnvio(
        'Este canal de WhatsApp ainda não tem um número configurado.',
        'sem_numero',
      );
    }
    const para = await this.destino(conversa);
    const citada = mensagem.respostaAId
      ? await this.prisma.mensagem.findUnique({
          where: { id: mensagem.respostaAId },
          select: { idExterno: true },
        })
      : null;
    const idExterno = mensagem.idExterno ?? gerarIdDeMensagemWhatsapp();
    const metadados = objetoDe(mensagem.metadados);
    const pedido: PedidoDeEnvio = {
      mensagemId: mensagem.id,
      conversaId: conversa.id,
      canalId: canal.id,
      numeroId: numero.id,
      idExterno,
      para,
      tipo: mensagem.tipo,
      texto: mensagem.texto,
      arquivoId: mensagem.arquivoId,
      voz: await this.ehVoz(mensagem, metadados),
      metadados: Object.keys(metadados).length > 0 ? metadados : null,
      respondeAIdExterno: citada?.idExterno ?? null,
      respostaAoContato: conversa.ultimaEntradaEm !== null,
      contatoId: conversa.contatoId,
      // Campanhas podem desligar o "digitando…" (`metadados.digitando = false`).
      ...(metadados.digitando === false ? { digitando: false } : {}),
    };
    // As tentativas vão no job (a fila pode não ter a configuração do
    // gateway ainda). Um job repetido da mesma mensagem não sai duas vezes:
    // o gateway confere o status dela e o que já enviou.
    await this.fila.enviar(filaDeEnvio(numero.id), pedido, {
      tentativas: TENTATIVAS_DE_ENVIO,
      intervaloEntreTentativasSegundos:
        ESPERA_ENTRE_TENTATIVAS_DE_ENVIO_SEGUNDOS,
      esperaExponencial: true,
    });
    return { idExterno, enfileirado: true };
  }

  private async ehVoz(
    mensagem: Mensagem,
    metadados: Record<string, unknown>,
  ): Promise<boolean> {
    if (mensagem.tipo !== 'AUDIO') {
      return false;
    }
    if (typeof metadados.voz === 'boolean') {
      return metadados.voz;
    }
    if (!mensagem.arquivoId) {
      return false;
    }
    const arquivo = await this.prisma.arquivo.findUnique({
      where: { id: mensagem.arquivoId },
      select: { mime: true },
    });
    return arquivo ? MIMES_DE_VOZ.has(arquivo.mime) : false;
  }

  /** JID do contato: o da conversa (quem escreveu), senão o identificador ou o telefone do contato. */
  private async destino(conversa: Conversa): Promise<string> {
    if (ehJidDeContato(conversa.idExterno)) {
      return conversa.idExterno;
    }
    const identificadores = await this.prisma.contatoIdentificador.findMany({
      where: {
        contatoId: conversa.contatoId,
        tipo: { in: ['WHATSAPP', 'WHATSAPP_LID'] },
      },
      orderBy: { ultimoUsoEm: { sort: 'desc', nulls: 'last' } },
    });
    const telefone = identificadores.find((item) => item.tipo === 'WHATSAPP');
    if (telefone) {
      return jidDoTelefone(telefone.valor);
    }
    const lid = identificadores.find((item) => item.tipo === 'WHATSAPP_LID');
    if (lid) {
      return lid.valor;
    }
    const contato = await this.prisma.contato.findUnique({
      where: { id: conversa.contatoId },
      select: { telefone: true },
    });
    if (contato?.telefone) {
      return jidDoTelefone(contato.telefone);
    }
    throw new FalhaDefinitivaDeEnvio(
      'O contato não tem um número de WhatsApp.',
      'sem_destino',
    );
  }
}

function objetoDe(json: unknown): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}
