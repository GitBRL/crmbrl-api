import type { IncomingHttpHeaders } from 'node:http';
import {
  Injectable,
  type OnModuleInit,
  type RawBodyRequest,
} from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { ehCampoSensivel } from '../../comum/dados/sanitizar';
import {
  ConflitoException,
  CorpoMuitoGrandeException,
  ErroApi,
  MuitasTentativasException,
  NaoAutenticadoException,
  NaoEncontradoException,
  RecursoDesativadoException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../../comum/erros/excecoes';
import { type RequisicaoHttp, truncar } from '../../comum/http/requisicao-http';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../../comum/paginacao/paginacao';
import {
  EventosDominioService,
  type EventoPublicado,
} from '../../eventos/eventos-dominio.service';
import { FilaService } from '../../fila/fila.service';
import {
  Prisma,
  type StatusRecebimento,
  type WebhookEntrada,
  type WebhookRecebimento,
} from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { travarChave } from '../../prisma/travas';
import {
  BYTES_MAXIMOS_DO_CORPO,
  CHAMADAS_POR_MINUTO,
  FILA_PROCESSAR_RECEBIMENTO,
  FORMATO_DO_TOKEN,
  JANELA_DO_LIMITE_MS,
  TRAVA_RECEBIMENTO,
} from '../webhooks.constantes';
import {
  type FiltroRecebimentosDto,
  type RecebimentoAceitoDto,
  type RecebimentoComVinculos,
  RecebimentoDetalheDto,
  RecebimentoDto,
} from './dto/recebimento.dto';

/** Cabeçalhos guardados sempre (os demais `x-*` também, salvo os sensíveis). */
const CABECALHOS_GUARDADOS = new Set([
  'accept',
  'content-length',
  'content-type',
  'origin',
  'referer',
  'user-agent',
  'x-assinatura',
  'x-forwarded-for',
  'x-real-ip',
  'x-request-id',
]);
const CABECALHOS_MAXIMOS = 30;
const TAMANHO_MAXIMO_CABECALHO = 500;

const ROTULO_DO_STATUS: Readonly<Record<StatusRecebimento, string>> = {
  RECEBIDO: 'na fila',
  PROCESSADO: 'processado',
  IGNORADO: 'ignorado',
  ERRO: 'com erro',
};

/** Avisa o limite de chamadas nos logs técnicos no máximo uma vez por minuto e por ponto. */
const INTERVALO_DO_AVISO_DE_LIMITE_MS = 60_000;

/** O que a chegada decidiu sobre a chamada (antes de gravar). */
interface Chegada {
  readonly aceita: boolean;
  readonly corpo: Prisma.InputJsonValue | null;
  readonly mensagem: string | null;
  /** O erro HTTP da recusa, já com o id do recebimento gravado. */
  readonly recusa: ((recebimentoId: string) => ErroApi) | null;
}

/**
 * Recebimentos dos webhooks de entrada (R8.2–R8.7):
 *
 * - `receber`: o endereço público. Confere token (404), ponto ativo (410),
 *   limite de 60 chamadas por minuto (429), tipo e tamanho do corpo (415, 413)
 *   e a assinatura HMAC sobre o corpo bruto (401); grava o recebimento e o job
 *   de processamento na mesma transação e responde 202 na hora (R8.4). As
 *   recusas depois do limite também ficam gravadas, como erro (R8.3).
 * - Listagem, detalhe e reprocessamento para o Admin (R8.6). A retenção de 90
 *   dias é do job `administracao.retencao`.
 * - LGPD (R4.6): na anonimização de um contato, o corpo dos recebimentos dele
 *   é apagado (o reprocessamento recriaria os dados pessoais).
 */
@Injectable()
export class RecebimentosService implements OnModuleInit {
  private readonly ultimoAvisoDeLimite = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly fila: FilaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly logs: LogsTecnicosService,
  ) {}

  onModuleInit(): void {
    this.eventos.registrarManipulador(
      'contato.anonimizado',
      async (evento) => {
        await this.apagarDadosDoContato(evento);
      },
      'webhooks-entrada:lgpd',
    );
  }

  // -------------------------------------------------------------------------
  // Endereço público (R8.2–R8.4, R8.7)
  // -------------------------------------------------------------------------

  async receber(
    token: string,
    req: RawBodyRequest<RequisicaoHttp>,
  ): Promise<RecebimentoAceitoDto> {
    const webhook = FORMATO_DO_TOKEN.test(token)
      ? await this.prisma.webhookEntrada.findUnique({
          where: { tokenHash: this.cripto.sha256(token) },
        })
      : null;
    if (!webhook || webhook.excluidoEm) {
      throw new NaoEncontradoException('Webhook não encontrado.');
    }
    if (!webhook.ativo) {
      throw new RecursoDesativadoException(
        'Este webhook de entrada está desativado (R8.7).',
        { regra: 'R8.7' },
      );
    }
    const chegada = await this.avaliarChegada(webhook, req);
    const agora = new Date();
    const resultado = await this.prisma.$transaction(async (tx) => {
      // Serializa os recebimentos do ponto: a contagem da janela não falha
      // com chamadas simultâneas (R8.7).
      await travarChave(tx, TRAVA_RECEBIMENTO, webhook.id);
      const desde = new Date(agora.getTime() - JANELA_DO_LIMITE_MS);
      const naJanela = { webhookId: webhook.id, recebidoEm: { gt: desde } };
      const recentes = await tx.webhookRecebimento.count({ where: naJanela });
      if (recentes >= CHAMADAS_POR_MINUTO) {
        const maisAntigo = await tx.webhookRecebimento.findFirst({
          where: naJanela,
          orderBy: { recebidoEm: 'asc' },
          select: { recebidoEm: true },
        });
        const liberaEm = maisAntigo
          ? maisAntigo.recebidoEm.getTime() + JANELA_DO_LIMITE_MS
          : agora.getTime() + JANELA_DO_LIMITE_MS;
        return {
          limitado: true as const,
          segundos: Math.max(1, Math.ceil((liberaEm - agora.getTime()) / 1000)),
        };
      }
      const recebimento = await tx.webhookRecebimento.create({
        data: {
          webhookId: webhook.id,
          recebidoEm: agora,
          ip: truncar(req.ip, 100) ?? null,
          cabecalhos: cabecalhosParaGuardar(req.headers),
          tipoConteudo: truncar(req.get('content-type'), 200) ?? null,
          corpo: chegada.corpo === null ? Prisma.DbNull : chegada.corpo,
          status: chegada.aceita ? 'RECEBIDO' : 'ERRO',
          mensagem: chegada.mensagem,
          processadoEm: chegada.aceita ? null : agora,
        },
        select: { id: true },
      });
      // SQL direto: o último recebimento não é uma alteração da configuração
      // (não mexe em `atualizado_em`).
      await tx.$executeRaw`
        UPDATE webhooks_entrada SET ultimo_recebimento_em = ${agora}
         WHERE id = ${webhook.id}::uuid`;
      if (chegada.aceita) {
        await this.fila.enviar(
          FILA_PROCESSAR_RECEBIMENTO,
          { recebimentoId: recebimento.id },
          { tx },
        );
      }
      return { limitado: false as const, recebimentoId: recebimento.id };
    });

    if (resultado.limitado) {
      await this.avisarLimite(webhook);
      throw new MuitasTentativasException(
        `Mais de ${CHAMADAS_POR_MINUTO} chamadas por minuto neste webhook (R8.7). Tente de novo em ${resultado.segundos} s.`,
        resultado.segundos,
        { regra: 'R8.7' },
      );
    }
    if (chegada.recusa) {
      throw chegada.recusa(resultado.recebimentoId);
    }
    return { id: resultado.recebimentoId, status: 'RECEBIDO' };
  }

  /**
   * Tipo e tamanho do corpo (R8.2) e assinatura (R8.3). JSON e formulário
   * chegam lidos pelos parsers da aplicação, com o corpo bruto em `rawBody`;
   * outro tipo não é lido (fica sem `rawBody`).
   */
  private async avaliarChegada(
    webhook: WebhookEntrada,
    req: RawBodyRequest<RequisicaoHttp>,
  ): Promise<Chegada> {
    const bruto = req.rawBody;
    const temCorpo =
      bruto !== undefined ? bruto.length > 0 : declaraCorpo(req.headers);
    if (temCorpo && bruto === undefined) {
      const tipo = truncar(req.get('content-type'), 100) ?? 'não informado';
      const mensagem = `Tipo de conteúdo não suportado (${tipo}): envie JSON ou application/x-www-form-urlencoded (R8.2).`;
      return {
        aceita: false,
        corpo: null,
        mensagem,
        recusa: (recebimentoId) =>
          new ErroApi(415, 'tipo_nao_suportado', mensagem, {
            regra: 'R8.2',
            recebimentoId,
          }),
      };
    }
    if (bruto && bruto.length > BYTES_MAXIMOS_DO_CORPO) {
      const mensagem = `O corpo tem ${Math.ceil(bruto.length / 1024)} KB; o limite é ${BYTES_MAXIMOS_DO_CORPO / 1024} KB (R8.2).`;
      return {
        aceita: false,
        corpo: null,
        mensagem,
        recusa: (recebimentoId) =>
          new CorpoMuitoGrandeException(mensagem, {
            regra: 'R8.2',
            recebimentoId,
          }),
      };
    }
    const corpo = (
      bruto && bruto.length > 0 ? (req.body ?? {}) : {}
    ) as Prisma.InputJsonValue;

    if (webhook.segredoCifrado) {
      let segredo: string;
      try {
        segredo = this.cripto.decifrar(webhook.segredoCifrado);
      } catch (erro) {
        await this.logs.erro(
          'Webhooks',
          `Segredo HMAC ilegível no webhook de entrada "${webhook.nome}" (a CHAVE_CRIPTOGRAFIA mudou?).`,
          erro,
          { webhookId: webhook.id },
        );
        const mensagem =
          'Não foi possível conferir a assinatura: o segredo HMAC deste webhook não pode ser lido. O Admin precisa definir um novo.';
        return {
          aceita: false,
          corpo,
          mensagem,
          recusa: (recebimentoId) =>
            new ServicoIndisponivelException(mensagem, { recebimentoId }),
        };
      }
      const assinatura = req.get('x-assinatura');
      if (
        !this.cripto.verificarHmac(
          segredo,
          bruto ?? Buffer.alloc(0),
          assinatura,
        )
      ) {
        const mensagem = assinatura
          ? 'Assinatura inválida (R8.3): X-Assinatura não confere com o HMAC-SHA256 do corpo.'
          : 'Assinatura ausente (R8.3): este webhook exige X-Assinatura: sha256=<hmac do corpo>.';
        return {
          aceita: false,
          corpo,
          mensagem,
          recusa: (recebimentoId) =>
            new NaoAutenticadoException(mensagem, {
              regra: 'R8.3',
              recebimentoId,
            }),
        };
      }
    }
    return { aceita: true, corpo, mensagem: null, recusa: null };
  }

  private async avisarLimite(webhook: WebhookEntrada): Promise<void> {
    const agora = Date.now();
    const ultimo = this.ultimoAvisoDeLimite.get(webhook.id) ?? 0;
    if (agora - ultimo < INTERVALO_DO_AVISO_DE_LIMITE_MS) {
      return;
    }
    this.ultimoAvisoDeLimite.set(webhook.id, agora);
    await this.logs.aviso(
      'Webhooks',
      `Webhook de entrada "${webhook.nome}" passou de ${CHAMADAS_POR_MINUTO} chamadas por minuto: as excedentes recebem 429 (R8.7).`,
      { webhookId: webhook.id },
    );
  }

  // -------------------------------------------------------------------------
  // Admin (R8.6)
  // -------------------------------------------------------------------------

  async listar(
    webhookId: string,
    filtro: FiltroRecebimentosDto,
  ): Promise<Pagina<RecebimentoDto>> {
    await this.garantirWebhook(webhookId);
    const where: Prisma.WebhookRecebimentoWhereInput = {
      webhookId,
      ...(filtro.status?.length ? { status: { in: filtro.status } } : {}),
      ...(filtro.de || filtro.ate
        ? {
            recebidoEm: {
              ...(filtro.de ? { gte: new Date(filtro.de) } : {}),
              ...(filtro.ate ? { lt: new Date(filtro.ate) } : {}),
            },
          }
        : {}),
    };
    const [recebimentos, total] = await Promise.all([
      this.prisma.webhookRecebimento.findMany({
        where,
        omit: { corpo: true, cabecalhos: true },
        include: {
          contato: { select: { id: true, nome: true } },
          negocio: { select: { id: true, titulo: true } },
        },
        orderBy: [{ recebidoEm: 'desc' }, { id: 'desc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.webhookRecebimento.count({ where }),
    ]);
    return montarPagina(
      recebimentos.map((recebimento) => paraDto(recebimento)),
      total,
      filtro,
    );
  }

  async detalhar(
    webhookId: string,
    recebimentoId: string,
  ): Promise<RecebimentoDetalheDto> {
    await this.garantirWebhook(webhookId);
    const recebimento = await this.prisma.webhookRecebimento.findFirst({
      where: { id: recebimentoId, webhookId },
      include: {
        contato: { select: { id: true, nome: true } },
        negocio: { select: { id: true, titulo: true } },
      },
    });
    if (!recebimento) {
      throw new NaoEncontradoException('Recebimento não encontrado.');
    }
    return Object.assign(paraDto(recebimento), {
      cabecalhos: textosDe(recebimento.cabecalhos),
      corpo: recebimento.corpo,
    });
  }

  /**
   * Reprocessa um recebimento (R8.6) com a configuração atual do ponto (ex.:
   * depois de corrigir o mapeamento). Vale para os com erro, ignorados ou
   * ainda na fila; um processado já criou o contato e o negócio (reprocessar
   * contaria uma reconversão a mais) e um recusado na chegada nunca foi
   * aceito (ex.: assinatura inválida).
   */
  async reprocessar(
    webhookId: string,
    recebimentoId: string,
  ): Promise<RecebimentoDto> {
    await this.prisma.$transaction(async (tx) => {
      const webhook = await tx.webhookEntrada.findFirst({
        where: { id: webhookId, excluidoEm: null },
        select: { id: true, nome: true },
      });
      if (!webhook) {
        throw new NaoEncontradoException('Webhook de entrada não encontrado.');
      }
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM webhook_recebimentos
         WHERE id = ${recebimentoId}::uuid AND webhook_id = ${webhookId}::uuid
           FOR UPDATE`;
      if (!linha) {
        throw new NaoEncontradoException('Recebimento não encontrado.');
      }
      const recebimento = await tx.webhookRecebimento.findUniqueOrThrow({
        where: { id: recebimentoId },
        omit: { cabecalhos: true },
      });
      if (recebimento.status === 'PROCESSADO') {
        throw new ConflitoException(
          'Este recebimento já foi processado: o contato e o negócio já existem (reprocessar registraria uma reconversão a mais).',
          {
            regra: 'R8.6',
            contatoId: recebimento.contatoId,
            negocioId: recebimento.negocioId,
          },
        );
      }
      if (foiRecusadoNaRecepcao(recebimento)) {
        throw new RegraVioladaException(
          'R8.6',
          'Este recebimento foi recusado na chegada (assinatura, tamanho ou tipo do corpo) e não pode ser reprocessado: peça ao sistema de origem para enviar de novo.',
        );
      }
      if (recebimento.corpo === null) {
        throw new RegraVioladaException(
          'R8.6',
          'Este recebimento não tem o corpo guardado: não há o que reprocessar.',
        );
      }
      await tx.webhookRecebimento.update({
        where: { id: recebimentoId },
        data: {
          status: 'RECEBIDO',
          mensagem: 'Reprocessamento pedido pelo Admin: na fila.',
          processadoEm: null,
        },
      });
      await this.fila.enviar(
        FILA_PROCESSAR_RECEBIMENTO,
        { recebimentoId },
        { tx },
      );
      await this.auditoria.registrar(tx, {
        acao: 'webhook_recebimento.reprocessado',
        entidade: 'webhook_recebimento',
        entidadeId: recebimentoId,
        resumo: `Recebimento do webhook "${webhook.nome}" enviado para reprocessar (estava ${ROTULO_DO_STATUS[recebimento.status]})`,
        dados: {
          statusAnterior: recebimento.status,
          mensagemAnterior: recebimento.mensagem,
          tentativas: recebimento.tentativas,
        },
        relacionados: { webhook_entrada: webhookId },
      });
    });
    const atualizado = await this.prisma.webhookRecebimento.findUniqueOrThrow({
      where: { id: recebimentoId },
      omit: { corpo: true, cabecalhos: true },
      include: {
        contato: { select: { id: true, nome: true } },
        negocio: { select: { id: true, titulo: true } },
      },
    });
    return paraDto(atualizado);
  }

  // -------------------------------------------------------------------------
  // LGPD (R4.6)
  // -------------------------------------------------------------------------

  /**
   * Manipulador de `contato.anonimizado`: apaga o corpo, os cabeçalhos e o IP
   * dos recebimentos que criaram ou reconverteram o contato, e audita quantos
   * (R3.1). Idempotente.
   */
  async apagarDadosDoContato(evento: EventoPublicado): Promise<number> {
    const contatoId = (evento.dados as { contatoId?: unknown } | null)
      ?.contatoId;
    if (typeof contatoId !== 'string') {
      return 0;
    }
    const mensagem =
      'Corpo, cabeçalhos e IP apagados na anonimização do contato (R4.6).';
    return this.prisma.$transaction(async (tx) => {
      const apagados = await tx.$executeRaw`
        UPDATE webhook_recebimentos
           SET corpo = NULL, cabecalhos = '{}'::jsonb, ip = NULL,
               mensagem = ${mensagem}
         WHERE contato_id = ${contatoId}::uuid
           AND (corpo IS NOT NULL OR ip IS NOT NULL OR cabecalhos <> '{}'::jsonb)`;
      if (apagados > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'webhook_recebimento.dados_apagados',
          entidade: 'webhook_recebimento',
          resumo: `Dados pessoais apagados de ${apagados} recebimento(s) de webhook na anonimização do contato (R4.6)`,
          dados: { quantidade: apagados },
          relacionados: { contato: contatoId },
        });
      }
      return apagados;
    });
  }

  private async garantirWebhook(id: string): Promise<void> {
    const existe = await this.prisma.webhookEntrada.count({
      where: { id, excluidoEm: null },
    });
    if (existe === 0) {
      throw new NaoEncontradoException('Webhook de entrada não encontrado.');
    }
  }
}

/** Recusado na chegada: gravado como erro sem nenhuma tentativa de processamento. */
export function foiRecusadoNaRecepcao(
  recebimento: Pick<WebhookRecebimento, 'status' | 'tentativas'>,
): boolean {
  return recebimento.status === 'ERRO' && recebimento.tentativas === 0;
}

function paraDto(
  recebimento: Omit<RecebimentoComVinculos, 'corpo' | 'cabecalhos'>,
): RecebimentoDto {
  const recusado = foiRecusadoNaRecepcao(recebimento);
  return {
    id: recebimento.id,
    webhookId: recebimento.webhookId,
    recebidoEm: recebimento.recebidoEm.toISOString(),
    ip: recebimento.ip,
    tipoConteudo: recebimento.tipoConteudo,
    status: recebimento.status,
    mensagem: recebimento.mensagem,
    tentativas: recebimento.tentativas,
    processadoEm: recebimento.processadoEm?.toISOString() ?? null,
    contato: recebimento.contato,
    negocio: recebimento.negocio,
    recusadoNaRecepcao: recusado,
    podeReprocessar: !recusado && recebimento.status !== 'PROCESSADO',
  };
}

/** O cliente declarou um corpo (mesmo que nenhum parser o tenha lido)? */
function declaraCorpo(cabecalhos: IncomingHttpHeaders): boolean {
  if (cabecalhos['transfer-encoding'] !== undefined) {
    return true;
  }
  const tamanho = Number(cabecalhos['content-length'] ?? 0);
  return Number.isFinite(tamanho) && tamanho > 0;
}

/**
 * Subconjunto dos cabeçalhos para diagnóstico (R8.6): sem cookies,
 * autorização nem nada com cara de credencial (a `X-Assinatura` fica: ela não
 * revela o segredo).
 */
export function cabecalhosParaGuardar(
  cabecalhos: IncomingHttpHeaders,
): Record<string, string> {
  const guardados: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(cabecalhos)) {
    if (valor === undefined) {
      continue;
    }
    const guardar =
      CABECALHOS_GUARDADOS.has(nome) ||
      (nome.startsWith('x-') && !ehCampoSensivel(nome));
    if (!guardar) {
      continue;
    }
    const texto = Array.isArray(valor) ? valor.join(', ') : String(valor);
    guardados[nome] = texto.slice(0, TAMANHO_MAXIMO_CABECALHO);
    if (Object.keys(guardados).length >= CABECALHOS_MAXIMOS) {
      break;
    }
  }
  return guardados;
}

function textosDe(valor: Prisma.JsonValue): Record<string, string> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(valor).filter(
      (entrada): entrada is [string, string] => typeof entrada[1] === 'string',
    ),
  );
}
