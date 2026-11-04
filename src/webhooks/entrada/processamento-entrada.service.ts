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
import { FilaService } from '../../fila/fila.service';
import type { Prisma, StatusRecebimento } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { adaptadorDe } from '../aplicativos/registro';
import type { ItemRecebido } from '../aplicativos/tipos';
import { adaptadorWebhook } from '../aplicativos/webhook';
import {
  ESPERA_ENTRE_PROCESSAMENTOS_SEGUNDOS,
  FILA_PROCESSAR_RECEBIMENTO,
  TENTATIVAS_DE_PROCESSAMENTO,
} from '../webhooks.constantes';
import {
  AplicacaoDoRecebimento,
  RecebimentoInvalidoError,
  type ResultadoDoItem,
} from './aplicacao-do-recebimento';
import { aplicarMapeamento } from './mapeamento';
import { mapeamentoDaIntegracao } from './mapeamento-da-integracao';

export { RecebimentoInvalidoError };

const TAMANHO_MAXIMO_MENSAGEM = 1_000;

/** O resultado de um item, como fica gravado em `webhook_recebimentos.resultados`. */
export interface ResultadoGravado {
  readonly indice: number;
  readonly rotulo: string | null;
  readonly status: 'PROCESSADO' | 'IGNORADO' | 'ERRO';
  readonly mensagem: string;
  readonly contatoId: string | null;
  readonly negocioId: string | null;
  readonly avisos: readonly string[];
}

/**
 * Processamento dos recebimentos (R8.4, R8.5, R32.3), pela fila
 * `webhooks-entrada.processar`, com até 3 tentativas:
 *
 * o adaptador do aplicativo transforma o corpo em itens (um, ou um por lead do
 * RD Station) → cada item aplica o mapeamento → valida → cria ou atualiza o
 * contato e o negócio (`AplicacaoDoRecebimento`), com ator `WEBHOOK` (o nome da
 * integração) e o IP de quem chamou, para a auditoria (R3.1).
 *
 * Cada item roda na própria transação, que também grava o resultado dele no
 * recebimento: numa nova tentativa, os itens já concluídos não se repetem. Erro
 * de dados (mapeamento, validação, configuração) é definitivo para o item: vira
 * `ERRO` sem novas tentativas. Falhas passageiras (banco, concorrência) voltam
 * para a fila; na 3ª, o recebimento fica com erro.
 */
@Injectable()
export class ProcessamentoEntradaService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly aplicacao: AplicacaoDoRecebimento,
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
        corpo: true,
        resultados: true,
        webhook: { select: { nome: true, aplicativo: true } },
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
        const adaptador =
          adaptadorDe(recebimento.webhook.aplicativo) ?? adaptadorWebhook;
        const itens = adaptador.normalizarCorpo(recebimento.corpo);
        const concluidos = new Set(
          lerResultados(recebimento.resultados)
            .filter(({ status }) => status === 'PROCESSADO')
            .map(({ indice }) => indice),
        );
        for (let indice = 0; indice < itens.length; indice += 1) {
          if (concluidos.has(indice)) {
            continue;
          }
          await this.processarItem(recebimentoId, indice, itens[indice]);
        }
        await this.finalizar(recebimentoId, itens);
      } catch (erro) {
        await this.registrarFalha(recebimentoId, tentativa, erro);
        if (!ehDefinitivo(erro)) {
          throw erro;
        }
      }
    });
  }

  /** Um item numa transação; erro definitivo vira resultado `ERRO` do item (os demais seguem). */
  private async processarItem(
    recebimentoId: string,
    indice: number,
    item: ItemRecebido,
  ): Promise<void> {
    try {
      await this.prisma.$transaction((tx) =>
        this.processarItemNaTransacao(tx, recebimentoId, indice, item),
      );
    } catch (erro) {
      if (!ehDefinitivo(erro)) {
        throw erro;
      }
      await this.prisma.$transaction(async (tx) => {
        await travarRecebimento(tx, recebimentoId);
        await this.gravarResultado(tx, recebimentoId, {
          indice,
          rotulo: item.rotulo,
          status: 'ERRO',
          mensagem: limitar(descreverErro(erro)),
          contatoId: null,
          negocioId: null,
          avisos: [],
        });
      });
    }
  }

  private async processarItemNaTransacao(
    tx: Tx,
    recebimentoId: string,
    indice: number,
    item: ItemRecebido,
  ): Promise<void> {
    // A linha fica presa até o fim: um job repetido espera e, ao seguir, já
    // encontra o item concluído.
    if (!(await travarRecebimento(tx, recebimentoId))) {
      return;
    }
    const recebimento = await tx.webhookRecebimento.findUniqueOrThrow({
      where: { id: recebimentoId },
      select: { webhookId: true, resultados: true },
    });
    if (
      lerResultados(recebimento.resultados).some(
        (resultado) =>
          resultado.indice === indice && resultado.status === 'PROCESSADO',
      )
    ) {
      return;
    }
    const webhook = await tx.webhookEntrada.findUniqueOrThrow({
      where: { id: recebimento.webhookId },
    });
    const adaptador = adaptadorDe(webhook.aplicativo) ?? adaptadorWebhook;
    const lead = aplicarMapeamento(
      mapeamentoDaIntegracao(webhook),
      item.corpo,
      webhook.etiquetasFixas,
      { exigirNome: webhook.modo !== 'ATUALIZAR' },
    );
    if (lead.ignorado) {
      await this.gravarResultado(tx, recebimentoId, {
        indice,
        rotulo: item.rotulo,
        status: 'IGNORADO',
        mensagem: limitar(lead.ignorado),
        contatoId: null,
        negocioId: null,
        avisos: [],
      });
      return;
    }
    if (lead.problemas.length > 0) {
      const semContato =
        !lead.contato.email &&
        !lead.contato.telefone &&
        lead.problemas.some((problema) =>
          problema.startsWith('Sem e-mail nem telefone'),
        );
      const explicacao = semContato
        ? adaptador.explicarFaltaDeContato?.(
            typeof item.corpo === 'object' && item.corpo !== null
              ? (item.corpo as Record<string, unknown>)
              : {},
          )
        : null;
      throw new RecebimentoInvalidoError(
        explicacao ?? lead.problemas.join(' '),
      );
    }
    const resultado: ResultadoDoItem = await this.aplicacao.aplicar(
      tx,
      webhook,
      lead,
      webhook.aplicativo === 'TYPEFORM' ? variaveisDoItem(item.corpo) : null,
    );
    await this.gravarResultado(tx, recebimentoId, {
      indice,
      rotulo: item.rotulo,
      status: resultado.status,
      mensagem: limitar(resultado.mensagem),
      contatoId: resultado.contatoId,
      negocioId: resultado.negocioId,
      avisos: [...resultado.avisos],
    });
  }

  /** Acrescenta (ou troca) o resultado do item em `resultados`. A linha do recebimento já está presa. */
  private async gravarResultado(
    tx: Tx,
    recebimentoId: string,
    resultado: ResultadoGravado,
  ): Promise<void> {
    const atual = await tx.webhookRecebimento.findUniqueOrThrow({
      where: { id: recebimentoId },
      select: { resultados: true },
    });
    const outros = lerResultados(atual.resultados).filter(
      ({ indice }) => indice !== resultado.indice,
    );
    await tx.webhookRecebimento.update({
      where: { id: recebimentoId },
      data: {
        resultados: [...outros, resultado].sort(
          (a, b) => a.indice - b.indice,
        ) as unknown as Prisma.InputJsonArray,
      },
    });
  }

  /** Fecha o recebimento com o status que os resultados dos itens pedem. */
  private async finalizar(
    recebimentoId: string,
    itens: readonly ItemRecebido[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await travarRecebimento(tx, recebimentoId))) {
        return;
      }
      const recebimento = await tx.webhookRecebimento.findUniqueOrThrow({
        where: { id: recebimentoId },
        select: { resultados: true },
      });
      const resultados = lerResultados(recebimento.resultados);
      const resumo = resumir(resultados, itens.length);
      await tx.webhookRecebimento.update({
        where: { id: recebimentoId },
        data: {
          status: resumo.status,
          mensagem: limitar(resumo.mensagem),
          contatoId: resumo.contatoId,
          negocioId: resumo.negocioId,
          avisos: resumo.avisos as unknown as Prisma.InputJsonArray,
          processadoEm: new Date(),
          tentativas: { increment: 1 },
        },
      });
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

/** Trava a linha do recebimento ainda `RECEBIDO` (falso se outro job já a concluiu). */
async function travarRecebimento(
  tx: Tx,
  recebimentoId: string,
): Promise<boolean> {
  const [linha] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM webhook_recebimentos
     WHERE id = ${recebimentoId}::uuid AND status = 'RECEBIDO'::status_recebimento
       FOR UPDATE`;
  return linha !== undefined;
}

export function lerResultados(
  valor: Prisma.JsonValue | null,
): ResultadoGravado[] {
  if (!Array.isArray(valor)) {
    return [];
  }
  return valor.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return [];
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.indice !== 'number' ||
      (r.status !== 'PROCESSADO' &&
        r.status !== 'IGNORADO' &&
        r.status !== 'ERRO')
    ) {
      return [];
    }
    return [
      {
        indice: r.indice,
        rotulo: typeof r.rotulo === 'string' ? r.rotulo : null,
        status: r.status,
        mensagem: typeof r.mensagem === 'string' ? r.mensagem : '',
        contatoId: typeof r.contatoId === 'string' ? r.contatoId : null,
        negocioId: typeof r.negocioId === 'string' ? r.negocioId : null,
        avisos: Array.isArray(r.avisos)
          ? r.avisos.filter(
              (aviso): aviso is string => typeof aviso === 'string',
            )
          : [],
      },
    ];
  });
}

interface ResumoDoRecebimento {
  readonly status: StatusRecebimento;
  readonly mensagem: string;
  readonly contatoId: string | null;
  readonly negocioId: string | null;
  readonly avisos: string[];
}

/**
 * Um item só: o resultado dele, como no R8.5. Vários (RD Station): contagem por
 * status e os motivos dos erros; `ERRO` se algum falhou (o reprocessamento
 * refaz só os que não foram processados).
 */
export function resumir(
  resultados: readonly ResultadoGravado[],
  total: number,
): ResumoDoRecebimento {
  if (total === 0) {
    return {
      status: 'IGNORADO',
      mensagem: 'Nenhum item no corpo: nada a processar.',
      contatoId: null,
      negocioId: null,
      avisos: [],
    };
  }
  if (total === 1 && resultados.length === 1) {
    const [unico] = resultados;
    return {
      status: unico.status,
      mensagem: unico.mensagem,
      contatoId: unico.contatoId,
      negocioId: unico.negocioId,
      avisos: [...unico.avisos],
    };
  }
  const processados = resultados.filter(
    ({ status }) => status === 'PROCESSADO',
  );
  const ignorados = resultados.filter(({ status }) => status === 'IGNORADO');
  const erros = resultados.filter(({ status }) => status === 'ERRO');
  const rotulo = (r: ResultadoGravado) =>
    r.rotulo ?? `item ${r.indice + 1} de ${total}`;
  const contagem = [
    `${processados.length} processado(s)`,
    ...(ignorados.length > 0 ? [`${ignorados.length} ignorado(s)`] : []),
    ...(erros.length > 0 ? [`${erros.length} com erro`] : []),
  ].join(', ');
  const detalhes = [...erros, ...ignorados]
    .map((r) => `${rotulo(r)}: ${r.mensagem}`)
    .join(' ');
  return {
    status:
      erros.length > 0
        ? 'ERRO'
        : processados.length > 0
          ? 'PROCESSADO'
          : 'IGNORADO',
    mensagem: `${total} itens: ${contagem}.${detalhes ? ` ${detalhes}` : ''}`,
    contatoId: processados[0]?.contatoId ?? null,
    negocioId: processados[0]?.negocioId ?? null,
    avisos: resultados.flatMap((r) =>
      r.avisos.map((aviso) => (total > 1 ? `${rotulo(r)}: ${aviso}` : aviso)),
    ),
  };
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

function variaveisDoItem(corpo: unknown): Record<string, unknown> | null {
  if (typeof corpo !== 'object' || corpo === null) {
    return null;
  }
  const variaveis = (corpo as Record<string, unknown>).variables;
  return typeof variaveis === 'object' &&
    variaveis !== null &&
    !Array.isArray(variaveis)
    ? (variaveis as Record<string, unknown>)
    : null;
}
