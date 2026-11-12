import { Injectable } from '@nestjs/common';
import { tipoDoAnexo } from '../atendimento/mensagens.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { ModelosService } from '../comum/modelos/modelos.service';
import type { ExecucaoAtual } from '../comum/passos/tipos';
import { PrismaService, type Tx } from '../prisma/prisma.service';

/** A conversa foi resolvida (ou sumiu) enquanto o bot falava: o fluxo para. */
export class ConversaIndisponivel extends Error {
  constructor() {
    super('A conversa não está mais aberta.');
    this.name = 'ConversaIndisponivel';
  }
}

export interface MensagemDoBot {
  texto?: string | null;
  arquivoId?: string | null;
  /** Distingue as mensagens de um mesmo passo (pergunta, lembrete, inválida:2…). */
  sufixo: string;
  metadados?: Record<string, unknown>;
}

export interface Enviada {
  texto: string;
  mensagemId: string | null;
  /** Modo teste/simulador: nada foi gravado. */
  simulada: boolean;
}

/**
 * Mensagens do bot (R18): renderiza o modelo com os dados do contato e as
 * variáveis da execução e cria a saída pelo mesmo caminho do Atendimento
 * (`MotorDoAtendimento.criarSaida` → fila `atendimento.enviar` → canal), com
 * autor `BOT`. Idempotente por `chaveIdempotencia + sufixo`: uma queda no meio
 * do passo não duplica a mensagem.
 */
@Injectable()
export class MensagensDoBot {
  constructor(
    private readonly prisma: PrismaService,
    private readonly motor: MotorDoAtendimento,
    private readonly modelos: ModelosService,
  ) {}

  /** O texto com as variáveis trocadas (`{{contato.nome}}`, `{{variaveis.x}}`…). */
  async renderizar(
    execucao: ExecucaoAtual,
    texto: string,
    tx?: Tx,
  ): Promise<string> {
    if (!texto) {
      return '';
    }
    const simulado = execucao.contexto.contato as { nome?: string } | undefined;
    const extras: Record<string, unknown> = {};
    if (execucao.teste && !execucao.contatoId && simulado?.nome) {
      extras['contato.nome'] = simulado.nome;
      extras['contato.primeiro_nome'] = simulado.nome.split(' ')[0];
    }
    const { texto: pronto } = await this.modelos.renderizarPara(
      texto,
      {
        contatoId: execucao.contatoId ?? undefined,
        negocioId: execucao.negocioId ?? undefined,
        variaveis: execucao.variaveis as Record<string, unknown>,
      },
      { tx, extras },
    );
    return pronto.trim();
  }

  async enviar(
    ctx: { execucao: ExecucaoAtual; chaveIdempotencia: string },
    dados: MensagemDoBot,
  ): Promise<Enviada> {
    const { execucao } = ctx;
    const texto = await this.renderizar(execucao, dados.texto ?? '');
    if (execucao.teste) {
      return { texto, mensagemId: null, simulada: true };
    }
    const conversaId = execucao.conversaId;
    if (!conversaId) {
      throw new Error('A execução do chatbot não tem conversa.');
    }
    const chave = `${ctx.chaveIdempotencia}:${dados.sufixo}`;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM conversas WHERE id = ${conversaId}::uuid FOR UPDATE`;
      const existente = await tx.mensagem.findFirst({
        where: { conversaId, metadados: { path: ['chaveBot'], equals: chave } },
        select: { id: true },
      });
      if (existente) {
        return { texto, mensagemId: existente.id, simulada: false };
      }
      const conversa = await tx.conversa.findUnique({
        where: { id: conversaId },
        include: { canal: true },
      });
      if (!conversa || conversa.status === 'RESOLVIDA') {
        throw new ConversaIndisponivel();
      }
      let arquivo: { id: string; mime: string } | null = null;
      if (dados.arquivoId) {
        arquivo = await tx.arquivo.findFirst({
          // Só mídia de campanha/chatbot (R11): o arquivo de outro contexto (conversa, importação,
          // ligação…) nunca sai por aqui, mesmo que o id tenha entrado no fluxo.
          where: {
            id: dados.arquivoId,
            removidoEm: null,
            contexto: 'CAMPANHA',
          },
          select: { id: true, mime: true },
        });
      }
      const criada = await executarComoAtor(
        {
          tipoAtor: 'BOT',
          descricao: execucao.nome,
          cadeia: execucao.cadeia,
        },
        () =>
          this.motor.criarSaida(tx, conversa, conversa.canal, {
            tipo: arquivo ? tipoDoAnexo(arquivo.mime) : 'TEXTO',
            texto: texto === '' ? null : texto,
            arquivoId: arquivo?.id ?? null,
            autorId: null,
            metadados: {
              ...dados.metadados,
              chaveBot: chave,
              bot: true,
              fluxoId: execucao.fluxoId,
              execucaoId: execucao.id,
            } as never,
          }),
      );
      await tx.conversa.update({
        where: { id: conversaId },
        data: {
          ultimaMensagemId: criada.id,
          ultimaMensagemEm: criada.ocorridaEm ?? new Date(),
        },
      });
      await this.motor.emitirConversa(tx, conversaId);
      return { texto, mensagemId: criada.id, simulada: false };
    });
  }
}
