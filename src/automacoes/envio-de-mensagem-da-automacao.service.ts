import { Injectable } from '@nestjs/common';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { tipoDoAnexo } from '../atendimento/mensagens.service';
import { ModelosService } from '../comum/modelos/modelos.service';
import {
  ErroDePassoTemporario,
  type ContextoDoPasso,
  type ResultadoDoPasso,
  seguir,
} from '../comum/passos/tipos';
import { EmailService } from '../email/email.service';
import type { Canal, Conversa, Prisma } from '../generated/prisma/client';
import { filtroDeModelosVisiveis } from '../disparos/modelos-mensagem.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';

type CanalDeMensagem = 'WHATSAPP' | 'EMAIL';

interface ConfigDeMensagem {
  modeloId?: string | null;
  texto?: string | null;
  assunto?: string | null;
  canalId?: string | null;
}

/**
 * Ação "enviar WhatsApp / e-mail" das automações (R19): renderiza o modelo
 * para o contato e cria a mensagem de saída pelo mesmo caminho do Atendimento
 * (`MotorDoAtendimento.criarSaida` → fila de envio → adaptador do canal). O
 * autor é a automação (ator do contexto). Idempotente por passo
 * (`metadados.chaveIdempotencia`). No modo teste só simula e devolve o texto.
 */
@Injectable()
export class EnvioDeMensagemDaAutomacao {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modelos: ModelosService,
    private readonly motor: MotorDoAtendimento,
    private readonly email: EmailService,
  ) {}

  /** Recorte de modelos do autor da automação; sem autor ativo, só os de todas as áreas. */
  private async visibilidadeDoAutor(
    automacaoId: string | null,
  ): Promise<Prisma.ModeloMensagemWhereInput> {
    const automacao = automacaoId
      ? await this.prisma.automacao.findUnique({
          where: { id: automacaoId },
          select: {
            criadoPor: {
              select: { id: true, papel: true, area: true, ativo: true },
            },
          },
        })
      : null;
    const autor = automacao?.criadoPor;
    return autor?.ativo ? filtroDeModelosVisiveis(autor) : { area: null };
  }

  async enviar(
    ctx: ContextoDoPasso<ConfigDeMensagem>,
    tipo: CanalDeMensagem,
  ): Promise<ResultadoDoPasso> {
    const { execucao, config } = ctx;
    if (!execucao.contatoId) {
      return seguir({ saida: { pulado: 'sem_contato' } });
    }
    const contato = await this.prisma.contato.findFirst({
      where: { id: execucao.contatoId, excluidoEm: null },
      include: { identificadores: true },
    });
    if (!contato) {
      return seguir({ saida: { pulado: 'contato_removido' } });
    }
    const tem = (t: string) =>
      contato.identificadores.some((i) => i.tipo === t);
    const para =
      tipo === 'WHATSAPP'
        ? (contato.telefone ??
          (tem('WHATSAPP') || tem('WHATSAPP_LID') ? 'identificador' : null))
        : (contato.email ?? (tem('EMAIL') ? 'identificador' : null));
    if (!para) {
      return seguir({
        saida: {
          pulado: tipo === 'WHATSAPP' ? 'sem_telefone' : 'sem_email',
        },
      });
    }

    // O modelo vale pelo acesso de quem criou a automação (R17): o de outro setor não é usado.
    const modelo = config.modeloId
      ? await this.prisma.modeloMensagem.findFirst({
          where: {
            id: config.modeloId,
            excluidoEm: null,
            ...(await this.visibilidadeDoAutor(execucao.automacaoId)),
          },
        })
      : null;
    if (config.modeloId && !modelo) {
      throw new Error('O modelo de mensagem da ação não existe mais.');
    }
    const textoBruto = modelo?.texto ?? config.texto ?? '';
    const assuntoBruto = modelo?.assunto ?? config.assunto ?? null;
    const alvo = {
      contatoId: contato.id,
      negocioId: execucao.negocioId ?? undefined,
      variaveis: { ...execucao.variaveis },
    };
    const semente = { semente: ctx.chaveIdempotencia };
    const texto = (
      await this.modelos.renderizarPara(textoBruto, alvo, semente)
    ).texto.trim();
    const assunto =
      tipo === 'EMAIL' && assuntoBruto
        ? (
            await this.modelos.renderizarPara(assuntoBruto, alvo, semente)
          ).texto.trim()
        : null;

    if (execucao.teste) {
      return seguir({
        saida: { simulado: true, canal: tipo, para, texto, assunto },
      });
    }

    const arquivo = modelo?.arquivoId
      ? await this.prisma.arquivo.findUnique({
          where: { id: modelo.arquivoId },
          select: { id: true, mime: true },
        })
      : null;
    const canal = await this.escolherCanal(tipo, contato.id, config.canalId);
    if (!canal) {
      if (tipo === 'EMAIL' && this.email.configurado && contato.email) {
        const resultado = await this.email.enviar({
          para: contato.email,
          assunto: assunto ?? 'Mensagem',
          texto,
        });
        return seguir({
          saida: {
            canal: 'EMAIL',
            via: 'smtp',
            para: contato.email,
            enviado: resultado.enviado,
          },
        });
      }
      throw new ErroDePassoTemporario(
        tipo === 'WHATSAPP'
          ? 'Nenhum número de WhatsApp conectado para enviar a mensagem.'
          : 'Nenhuma caixa de e-mail disponível para enviar a mensagem.',
        300,
      );
    }

    const resultado = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'atendimento-conversa', canal.id, contato.id);
      const conversa = await this.conversaDoContato(
        tx,
        canal,
        contato.id,
        assunto,
      );
      const repetida = await tx.mensagem.findFirst({
        where: {
          conversaId: conversa.id,
          metadados: {
            path: ['chaveIdempotencia'],
            equals: ctx.chaveIdempotencia,
          },
        },
        select: { id: true },
      });
      if (repetida) {
        return {
          mensagemId: repetida.id,
          conversaId: conversa.id,
          repetida: true,
        };
      }
      const mensagem = await this.motor.criarSaida(tx, conversa, canal, {
        tipo: arquivo ? tipoDoAnexo(arquivo.mime) : 'TEXTO',
        texto: texto === '' ? null : texto,
        arquivoId: arquivo?.id ?? null,
        autorId: null,
        metadados: {
          automacaoId: execucao.automacaoId,
          automacao: execucao.nome,
          execucaoId: execucao.id,
          chaveIdempotencia: ctx.chaveIdempotencia,
        } satisfies Prisma.InputJsonObject,
      });
      await tx.conversa.update({
        where: { id: conversa.id },
        data: {
          ultimaMensagemId: mensagem.id,
          ultimaMensagemEm: mensagem.ocorridaEm ?? new Date(),
        },
      });
      return {
        mensagemId: mensagem.id,
        conversaId: conversa.id,
        repetida: false,
      };
    });
    return seguir({
      saida: {
        canal: tipo,
        canalId: canal.id,
        para,
        mensagemId: resultado.mensagemId,
        conversaId: resultado.conversaId,
        ...(resultado.repetida ? { jaEnviada: true } : {}),
      },
    });
  }

  /**
   * Canal da mensagem: o pedido (se utilizável); senão o da conversa em aberto
   * do contato; senão o primeiro ativo (WhatsApp: conectado e sem pausa).
   */
  private async escolherCanal(
    tipo: CanalDeMensagem,
    contatoId: string,
    canalId: string | null | undefined,
  ): Promise<Canal | null> {
    const utilizavel = (
      canal: Canal & {
        whatsappNumero: { status: string; pausadoEm: Date | null } | null;
      },
    ) =>
      canal.ativo &&
      (tipo === 'EMAIL' ||
        (canal.whatsappNumero?.status === 'CONECTADO' &&
          canal.whatsappNumero.pausadoEm === null));
    if (canalId) {
      const canal = await this.prisma.canal.findFirst({
        where: { id: canalId, tipo, excluidoEm: null },
        include: { whatsappNumero: true },
      });
      return canal && utilizavel(canal) ? canal : null;
    }
    const aberta = await this.prisma.conversa.findFirst({
      where: {
        contatoId,
        status: { not: 'RESOLVIDA' },
        canal: { tipo, excluidoEm: null },
      },
      include: { canal: { include: { whatsappNumero: true } } },
    });
    if (aberta && utilizavel(aberta.canal)) {
      return aberta.canal;
    }
    const canais = await this.prisma.canal.findMany({
      where: { tipo, ativo: true, excluidoEm: null },
      include: { whatsappNumero: true },
      orderBy: { criadoEm: 'asc' },
    });
    return canais.find(utilizavel) ?? null;
  }

  /**
   * A conversa em aberto do contato no canal; senão a última que nunca recebeu
   * mensagem dele; senão uma nova, já resolvida (não lota a caixa de entrada;
   * quando o contato responde, o Atendimento abre uma conversa e a distribui).
   */
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
    return tx.conversa.create({
      data: {
        canalId: canal.id,
        contatoId,
        filaId: canal.filaPadraoId,
        status: 'RESOLVIDA',
        resolvidaEm: new Date(),
        assunto,
      },
    });
  }
}
