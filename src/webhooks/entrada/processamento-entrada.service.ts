import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type ContextoRequisicao,
  contextoAtual,
  executarComContexto,
} from '../../comum/contexto/contexto-requisicao';
import {
  ConflitoException,
  DadosInvalidosException,
  ErroApi,
} from '../../comum/erros/excecoes';
import type { ProblemaDeCampo } from '../../comum/validacao/validacao';
import { ContatosService } from '../../contatos/contatos.service';
import { FilaService } from '../../fila/fila.service';
import { NegociosService } from '../../funis/negocios.service';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import {
  ESPERA_ENTRE_PROCESSAMENTOS_SEGUNDOS,
  FILA_PROCESSAR_RECEBIMENTO,
  TENTATIVAS_DE_PROCESSAMENTO,
} from '../webhooks.constantes';
import { aplicarMapeamento, mapeamentoEfetivo } from './mapeamento';

/** Erro do recebimento que não muda numa nova tentativa (mapeamento, validação). */
export class RecebimentoInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'RecebimentoInvalidoError';
  }
}

const TAMANHO_MAXIMO_MENSAGEM = 1_000;

/**
 * Processamento dos recebimentos (R8.4, R8.5), pela fila
 * `webhooks-entrada.processar`, com até 3 tentativas:
 *
 * aplica o mapeamento → valida (nome e e-mail ou telefone) → deduplica o
 * contato (`ContatosService.encontrarOuCriar`, R4.2) → cria o negócio ou
 * registra a reconversão (`NegociosService.criarAutomatico`, R5.6), que
 * distribui (R5.8), notifica o responsável e publica os eventos → dá ao
 * contato sem responsável o do negócio (R4.5).
 *
 * Tudo numa transação, com ator `WEBHOOK` (o nome do ponto) e o IP de quem
 * chamou, para a auditoria (R3.1). Erro de dados (mapeamento, validação,
 * configuração) é definitivo: o recebimento vai para `ERRO` sem novas
 * tentativas. Falhas passageiras (banco, conflito de concorrência) voltam
 * para a fila; na 3ª, o recebimento fica com erro.
 */
@Injectable()
export class ProcessamentoEntradaService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly contatos: ContatosService,
    private readonly negocios: NegociosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<{ recebimentoId: string }>(
      FILA_PROCESSAR_RECEBIMENTO,
      (trabalho) =>
        this.processar(trabalho.dados.recebimentoId, trabalho.tentativa),
      {
        tentativas: TENTATIVAS_DE_PROCESSAMENTO - 1,
        intervaloEntreTentativasSegundos: ESPERA_ENTRE_PROCESSAMENTOS_SEGUNDOS,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 120,
        concorrencia: 2,
      },
    );
  }

  /** Processa um recebimento `RECEBIDO` (os demais são ignorados: o job pode chegar repetido). */
  async processar(recebimentoId: string, tentativa = 1): Promise<void> {
    const recebimento = await this.prisma.webhookRecebimento.findUnique({
      where: { id: recebimentoId },
      select: {
        status: true,
        ip: true,
        cabecalhos: true,
        webhook: { select: { nome: true } },
      },
    });
    if (!recebimento || recebimento.status !== 'RECEBIDO') {
      return;
    }
    const contexto: ContextoRequisicao = {
      requisicaoId: contextoAtual().requisicaoId,
      ip: recebimento.ip ?? undefined,
      userAgent: agenteDe(recebimento.cabecalhos),
      tipoAtor: 'WEBHOOK',
      atorDescricao: recebimento.webhook.nome,
    };
    await executarComContexto(contexto, async () => {
      try {
        await this.prisma.$transaction((tx) =>
          this.processarNaTransacao(tx, recebimentoId),
        );
      } catch (erro) {
        await this.registrarFalha(recebimentoId, tentativa, erro);
        if (!ehDefinitivo(erro)) {
          throw erro;
        }
      }
    });
  }

  private async processarNaTransacao(
    tx: Tx,
    recebimentoId: string,
  ): Promise<void> {
    // A linha fica presa até o fim: um job repetido espera e, ao seguir, já
    // encontra o recebimento processado.
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_recebimentos
       WHERE id = ${recebimentoId}::uuid AND status = 'RECEBIDO'::status_recebimento
         FOR UPDATE`;
    if (!linha) {
      return;
    }
    const recebimento = await tx.webhookRecebimento.findUniqueOrThrow({
      where: { id: recebimentoId },
      select: { corpo: true, webhookId: true },
    });
    const webhook = await tx.webhookEntrada.findUniqueOrThrow({
      where: { id: recebimento.webhookId },
    });
    const lead = aplicarMapeamento(
      mapeamentoEfetivo(webhook.modeloMapeamento, webhook.mapeamento),
      recebimento.corpo,
      webhook.etiquetasFixas,
    );
    if (lead.ignorado) {
      await tx.webhookRecebimento.update({
        where: { id: recebimentoId },
        data: {
          status: 'IGNORADO',
          mensagem: limitar(lead.ignorado),
          processadoEm: new Date(),
          tentativas: { increment: 1 },
        },
      });
      return;
    }
    if (lead.problemas.length > 0) {
      throw new RecebimentoInvalidoError(lead.problemas.join(' '));
    }

    const { contato, criado: contatoCriado } =
      await this.contatos.encontrarOuCriar(tx, {
        nome: lead.contato.nome ?? '',
        email: lead.contato.email ?? undefined,
        telefone: lead.contato.telefone ?? undefined,
        empresaNome: lead.contato.empresa ?? undefined,
        cargo: lead.contato.cargo ?? undefined,
        origem: 'WEBHOOK',
        origemDetalhe: webhook.nome,
        utm: lead.utm ?? undefined,
        etiquetas: lead.etiquetas,
        camposPersonalizados: lead.camposPersonalizados,
      });
    const resultado = await this.negocios.criarAutomatico(tx, {
      contatoId: contato.id,
      funilId: webhook.funilId,
      etapaId: webhook.etapaId,
      titulo: lead.negocio.titulo ?? undefined,
      valor: lead.negocio.valor ?? undefined,
      valorRecorrente: lead.negocio.valorRecorrente ?? undefined,
      origem: 'WEBHOOK',
      origemDetalhe: webhook.nome,
      utm: lead.utm ?? undefined,
      estrategia: webhook.estrategia,
      responsavelFixoId: webhook.responsavelFixoId ?? undefined,
    });
    const { negocio } = resultado;
    // R4.5: o contato (e a empresa) sem responsável fica com o do negócio.
    // O `criarAutomatico` já notificou o responsável (R8.5).
    if (negocio.responsavelId) {
      await this.contatos.definirResponsavelSeVazio(
        tx,
        contato.id,
        negocio.responsavelId,
      );
    }

    const etapa = await tx.etapa.findUniqueOrThrow({
      where: { id: negocio.etapaId },
      select: { nome: true },
    });
    const funil = await tx.funil.findUniqueOrThrow({
      where: { id: negocio.funilId },
      select: { nome: true },
    });
    const responsavel = negocio.responsavelId
      ? await tx.usuario.findUnique({
          where: { id: negocio.responsavelId },
          select: { nome: true },
        })
      : null;
    const partes = [
      contatoCriado
        ? `Contato "${contato.nome}" criado`
        : `Contato "${contato.nome}" reconvertido (já existia)`,
      resultado.criado
        ? `negócio criado em ${funil.nome} / ${etapa.nome}, ${responsavel ? `com ${responsavel.nome}` : 'sem responsável'}`
        : `reconversão registrada no negócio aberto "${negocio.titulo}"`,
    ];
    const mensagem = `${partes.join('; ')}.${lead.avisos.length > 0 ? ` Avisos: ${lead.avisos.join(' ')}` : ''}`;
    await tx.webhookRecebimento.update({
      where: { id: recebimentoId },
      data: {
        status: 'PROCESSADO',
        contatoId: contato.id,
        negocioId: negocio.id,
        processadoEm: new Date(),
        mensagem: limitar(mensagem),
        tentativas: { increment: 1 },
      },
    });
  }

  /**
   * Registra a tentativa que falhou. Erro definitivo, ou a última tentativa:
   * `ERRO` com o motivo. Senão o recebimento continua `RECEBIDO` (o job tenta
   * de novo) e a mensagem conta o que houve.
   */
  private async registrarFalha(
    recebimentoId: string,
    tentativa: number,
    erro: unknown,
  ): Promise<void> {
    const definitivo = ehDefinitivo(erro);
    const final = definitivo || tentativa >= TENTATIVAS_DE_PROCESSAMENTO;
    const motivo = descreverErro(erro);
    const mensagem = definitivo
      ? motivo
      : final
        ? `Falhou ${tentativa} vezes; última falha: ${motivo}`
        : `A tentativa ${tentativa} de ${TENTATIVAS_DE_PROCESSAMENTO} falhou (${motivo}); nova tentativa em instantes.`;
    const dados: Prisma.WebhookRecebimentoUpdateManyMutationInput = {
      status: final ? 'ERRO' : 'RECEBIDO',
      mensagem: limitar(mensagem),
      processadoEm: final ? new Date() : null,
      tentativas: { increment: 1 },
    };
    await this.prisma.webhookRecebimento.updateMany({
      where: { id: recebimentoId, status: 'RECEBIDO' },
      data: dados,
    });
  }
}

/**
 * Erros que se repetiriam numa nova tentativa: o mapeamento não deu um contato
 * válido, ou uma regra recusou (funil arquivado, etapa de outro funil…).
 * Conflito (concorrência) e erro inesperado são passageiros.
 */
function ehDefinitivo(erro: unknown): boolean {
  if (erro instanceof RecebimentoInvalidoError) {
    return true;
  }
  return (
    erro instanceof ErroApi &&
    erro.getStatus() < 500 &&
    !(erro instanceof ConflitoException)
  );
}

function descreverErro(erro: unknown): string {
  if (erro instanceof DadosInvalidosException) {
    const campos = (erro.detalhes?.campos ?? []) as ProblemaDeCampo[];
    const detalhes = campos
      .map(({ campo, mensagens }) => `${campo}: ${mensagens.join(', ')}`)
      .join('; ');
    return detalhes ? `${erro.mensagem} (${detalhes})` : erro.mensagem;
  }
  if (erro instanceof ErroApi) {
    // Sem o código da regra (`detalhes.regra`): a mensagem é lida pelo Admin.
    return erro.mensagem;
  }
  // Sem `instanceof Error`: erros do Node podem vir de outro "realm".
  const mensagem =
    typeof erro === 'object' && erro !== null && 'message' in erro
      ? String((erro as { message: unknown }).message)
      : String(erro);
  return mensagem.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function agenteDe(cabecalhos: Prisma.JsonValue): string | undefined {
  if (
    typeof cabecalhos === 'object' &&
    cabecalhos !== null &&
    !Array.isArray(cabecalhos)
  ) {
    const agente = cabecalhos['user-agent'];
    return typeof agente === 'string' ? agente : undefined;
  }
  return undefined;
}

function limitar(texto: string): string {
  return texto.length > TAMANHO_MAXIMO_MENSAGEM
    ? `${texto.slice(0, TAMANHO_MAXIMO_MENSAGEM)}…`
    : texto;
}
