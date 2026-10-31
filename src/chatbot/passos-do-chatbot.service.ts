import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PassosService } from '../comum/passos/passos.service';
import {
  aguardarEntrada,
  type ContextoDoPasso,
  encerrar,
  irParaRamo,
  type ResultadoDoPasso,
  seguir,
} from '../comum/passos/tipos';
import { PrismaService } from '../prisma/prisma.service';
import {
  MOTIVOS_DE_FIM,
  PREFIXO_DE_ESTADO,
  TENTATIVAS_PADRAO_DA_PERGUNTA,
} from './chatbot.constantes';
import {
  type AmbienteDeCondicao,
  avaliarCondicao,
  condicoesDoRamo,
} from './condicoes';
import {
  type ConfigDeMensagem,
  type ConfigDePerguntaAberta,
  type ConfigDePerguntaComOpcoes,
  type TempoSemResposta,
  validarAtribuir,
  validarCondicao,
  validarCriarAtividade,
  validarCriarNegocio,
  validarDefinirCampo,
  validarEtiquetar,
  validarMensagem,
  validarMoverFila,
  validarPerguntaAberta,
  validarPerguntaComOpcoes,
  validarTransferir,
  validarWebhook,
} from './configuracao-dos-passos';
import { AcoesDoBot } from './acoes-do-bot.service';
import {
  ConversaIndisponivel,
  MensagensDoBot,
} from './mensagens-do-bot.service';
import {
  casarOpcao,
  textoDaPerguntaComOpcoes,
  validarResposta,
} from './respostas';
import {
  type ConfigDeTransferir,
  TransferenciaDoBot,
} from './transferencia-do-bot.service';

/** Variável (interna) com a transcrição do simulador. */
export const VARIAVEL_DA_TRANSCRICAO = `${PREFIXO_DE_ESTADO}transcricao`;
/** Variável (interna) com o id da última mensagem do contato já consumida. */
export const VARIAVEL_DA_ULTIMA_ENTRADA = `${PREFIXO_DE_ESTADO}ultima_entrada`;

export interface ItemDaTranscricao {
  de: 'bot' | 'contato' | 'sistema';
  texto: string;
  /** Opções oferecidas (botões no chat do site). */
  opcoes?: string[];
  passoId?: string;
}

/** O que o contato mandou (`PassosService.retomarComEntrada`). */
export interface EntradaDoContato {
  texto: string | null;
  mensagemId?: string | null;
  arquivoId?: string | null;
}

interface EstadoDaPergunta {
  invalidas: number;
  lembrou: boolean;
}

type Ctx<C> = ContextoDoPasso<C>;
type Variaveis = Record<string, unknown>;

/** No chat do site as opções vão como botões (`metadados.botoes`); o texto não repete a lista numerada. */
export function ehChatDoSite(ctx: Ctx<unknown>): boolean {
  return ctx.execucao.variaveis['canal'] === 'WEBCHAT';
}

function estadoDe(ctx: Ctx<unknown>): EstadoDaPergunta {
  const bruto = ctx.execucao.variaveis[
    `${PREFIXO_DE_ESTADO}${ctx.passo.id}`
  ] as Partial<EstadoDaPergunta> | null | undefined;
  return { invalidas: bruto?.invalidas ?? 0, lembrou: bruto?.lembrou ?? false };
}

function chaveDoEstado(ctx: Ctx<unknown>): string {
  return `${PREFIXO_DE_ESTADO}${ctx.passo.id}`;
}

/** Soma `itens` à transcrição (só no simulador; fora dele não guarda nada). */
export function transcricao(
  ctx: Ctx<unknown>,
  itens: readonly ItemDaTranscricao[],
): Variaveis {
  if (!ctx.execucao.teste || itens.length === 0) {
    return {};
  }
  const atual =
    (ctx.execucao.variaveis[VARIAVEL_DA_TRANSCRICAO] as
      ItemDaTranscricao[] | undefined) ?? [];
  return {
    [VARIAVEL_DA_TRANSCRICAO]: [
      ...atual,
      ...itens.map((item) => ({
        ...item,
        passoId: item.passoId ?? ctx.passo.id,
      })),
    ],
  };
}

function lerEntrada(entrada: unknown): EntradaDoContato {
  const e = (entrada ?? {}) as Partial<EntradaDoContato>;
  return {
    texto: typeof e.texto === 'string' ? e.texto : null,
    mensagemId: e.mensagemId ?? null,
    arquivoId: e.arquivoId ?? null,
  };
}

/** Quando o tempo da pergunta acaba (nulo = não espera por tempo). */
function primeiroPrazo(
  tempo: TempoSemResposta | undefined,
  agora: Date,
): Date | undefined {
  const minutos = tempo?.lembreteAposMinutos ?? tempo?.encerrarAposMinutos;
  return minutos ? new Date(agora.getTime() + minutos * 60_000) : undefined;
}

/**
 * Tipos de passo do chatbot (R18), registrados no executor (`CHATBOT`):
 * `mensagem`, `pergunta.opcoes`, `pergunta.aberta`, `condicao`, as ações
 * `acao.*`, `transferir`; `aguardar` e `encerrar` vêm do executor.
 *
 * Perguntas esperam a resposta (`aguardarEntrada`); o `EntradaDoBot` entrega a
 * mensagem do contato em `retomarComEntrada` e o passo roda de novo com
 * `retomada.motivo === 'entrada'`. O estado da pergunta (respostas inválidas,
 * lembrete enviado) fica em `variaveis.__<passoId>`.
 */
@Injectable()
export class PassosDoChatbot implements OnModuleInit {
  constructor(
    private readonly passos: PassosService,
    private readonly prisma: PrismaService,
    private readonly mensagens: MensagensDoBot,
    private readonly acoes: AcoesDoBot,
    private readonly transferencia: TransferenciaDoBot,
  ) {}

  onModuleInit(): void {
    const execucoes = ['CHATBOT'] as const;
    const proteger =
      <C>(fn: (ctx: Ctx<C>) => Promise<ResultadoDoPasso>) =>
      async (ctx: Ctx<C>): Promise<ResultadoDoPasso> => {
        try {
          return await fn(ctx);
        } catch (erro) {
          if (erro instanceof ConversaIndisponivel) {
            return encerrar(MOTIVOS_DE_FIM.CONVERSA_RESOLVIDA, {
              status: 'CANCELADA',
            });
          }
          throw erro;
        }
      };

    this.passos.registrarTipo<ConfigDeMensagem>({
      tipo: 'mensagem',
      execucoes,
      validar: validarMensagem,
      executar: proteger((ctx) => this.mensagem(ctx)),
    });
    this.passos.registrarTipo<ConfigDePerguntaComOpcoes>({
      tipo: 'pergunta.opcoes',
      execucoes,
      validar: validarPerguntaComOpcoes,
      executar: proteger((ctx) => this.perguntaComOpcoes(ctx)),
    });
    this.passos.registrarTipo<ConfigDePerguntaAberta>({
      tipo: 'pergunta.aberta',
      execucoes,
      validar: validarPerguntaAberta,
      executar: proteger((ctx) => this.perguntaAberta(ctx)),
    });
    this.passos.registrarTipo<Record<string, unknown>>({
      tipo: 'condicao',
      execucoes,
      validar: validarCondicao,
      executar: proteger((ctx) => this.condicao(ctx)),
    });
    this.passos.registrarTipo<{
      adicionar?: string[];
      etiquetas?: string[];
      remover?: string[];
    }>({
      tipo: 'acao.etiquetar',
      execucoes,
      validar: validarEtiquetar,
      executar: proteger(async (ctx) => {
        const saida = await this.acoes.etiquetar(ctx.execucao, ctx.config);
        return this.concluirAcao(ctx, 'Etiquetas do contato', saida);
      }),
    });
    this.passos.registrarTipo<{ campo: string; valor: string }>({
      tipo: 'acao.definir_campo',
      execucoes,
      validar: validarDefinirCampo,
      executar: proteger(async (ctx) => {
        const valor = await this.mensagens.renderizar(
          ctx.execucao,
          ctx.config.valor,
        );
        const saida = await this.acoes.definirCampo(
          ctx.execucao,
          ctx.config.campo,
          valor,
        );
        return this.concluirAcao(ctx, `Campo ${ctx.config.campo}`, saida);
      }),
    });
    this.passos.registrarTipo<{ filaId: string; distribuir?: boolean }>({
      tipo: 'acao.mover_fila',
      execucoes,
      validar: validarMoverFila,
      executar: proteger(async (ctx) => {
        const saida = await this.acoes.moverParaFila(
          ctx.execucao,
          ctx.config.filaId,
          ctx.config.distribuir !== false,
        );
        return this.concluirAcao(ctx, 'Mover para a fila', saida);
      }),
    });
    this.passos.registrarTipo<{ usuarioId: string }>({
      tipo: 'acao.atribuir',
      execucoes,
      validar: validarAtribuir,
      executar: proteger(async (ctx) => {
        const saida = await this.acoes.atribuir(
          ctx.execucao,
          ctx.config.usuarioId,
        );
        return this.concluirAcao(ctx, 'Atribuir a uma pessoa', saida);
      }),
    });
    this.passos.registrarTipo<Parameters<AcoesDoBot['criarNegocio']>[1]>({
      tipo: 'acao.criar_negocio',
      execucoes,
      validar: validarCriarNegocio,
      executar: proteger(async (ctx) => {
        const saida = await this.acoes.criarNegocio(ctx.execucao, ctx.config);
        return this.concluirAcao(ctx, 'Criar negócio', saida);
      }),
    });
    this.passos.registrarTipo<Parameters<AcoesDoBot['criarAtividade']>[1]>({
      tipo: 'acao.criar_atividade',
      execucoes,
      validar: validarCriarAtividade,
      executar: proteger(async (ctx) => {
        const saida = await this.acoes.criarAtividade(ctx.execucao, ctx.config);
        return this.concluirAcao(ctx, 'Criar atividade', saida);
      }),
    });
    this.passos.registrarTipo<Parameters<AcoesDoBot['chamarWebhook']>[1]>({
      tipo: 'acao.webhook',
      execucoes,
      validar: validarWebhook,
      executar: proteger(async (ctx) => {
        const { saida, variaveis } = await this.acoes.chamarWebhook(
          ctx.execucao,
          ctx.config,
          ctx.tentativa,
        );
        return seguir({
          saida,
          variaveis: {
            ...variaveis,
            ...transcricao(ctx, [
              { de: 'sistema', texto: `Webhook chamado: ${ctx.config.url}` },
            ]),
          },
        });
      }),
    });
    this.passos.registrarTipo<ConfigDeTransferir>({
      tipo: 'transferir',
      execucoes,
      validar: validarTransferir,
      executar: proteger((ctx) => this.transferir(ctx)),
    });
  }

  // -------------------------------------------------------------------------
  // Mensagem e perguntas
  // -------------------------------------------------------------------------

  private async mensagem(
    ctx: Ctx<ConfigDeMensagem>,
  ): Promise<ResultadoDoPasso> {
    const enviada = await this.mensagens.enviar(ctx, {
      texto: ctx.config.texto,
      arquivoId: ctx.config.arquivoId,
      sufixo: 'mensagem',
    });
    return seguir({
      saida: { mensagem: enviada.texto, simulada: enviada.simulada },
      variaveis: transcricao(ctx, [{ de: 'bot', texto: enviada.texto }]),
    });
  }

  private async perguntaComOpcoes(
    ctx: Ctx<ConfigDePerguntaComOpcoes>,
  ): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    const estado = estadoDe(ctx);
    const chave = chaveDoEstado(ctx);
    const temRamo = (id: string) => ctx.passo.ramos?.some((r) => r.id === id);

    if (ctx.retomada?.motivo === 'entrada') {
      const entrada = lerEntrada(ctx.retomada.entrada);
      const consumida = {
        [VARIAVEL_DA_ULTIMA_ENTRADA]: entrada.mensagemId ?? null,
      };
      const opcao = casarOpcao(entrada.texto ?? '', c.opcoes);
      const itemContato: ItemDaTranscricao = {
        de: 'contato',
        texto: entrada.texto ?? '',
      };
      if (opcao) {
        const pergunta = await this.mensagens.renderizar(ctx.execucao, c.texto);
        const variaveis: Variaveis = {
          ...consumida,
          ...transcricao(ctx, [itemContato]),
          [chave]: null,
          ...(c.variavel
            ? { [c.variavel]: opcao.rotulo, [`${c.variavel}_id`]: opcao.id }
            : {}),
        };
        const saida = { pergunta, resposta: opcao.rotulo, opcaoId: opcao.id };
        return temRamo(opcao.id)
          ? irParaRamo(opcao.id, { saida, variaveis })
          : seguir({ saida, variaveis });
      }
      return this.respostaInvalida(ctx, {
        estado,
        chave,
        consumida,
        itemContato,
        maximo: c.tentativas ?? TENTATIVAS_PADRAO_DA_PERGUNTA,
        mensagemInvalida: c.mensagemInvalida,
        reperguntar: (texto) =>
          textoDaPerguntaComOpcoes(ehChatDoSite(ctx), texto, c.opcoes),
        botoes: ehChatDoSite(ctx)
          ? c.opcoes.map((o) => ({ id: o.id, rotulo: o.rotulo }))
          : undefined,
        textoPadrao: 'Não entendi. Escolha uma das opções:',
        tempo: c.tempoSemResposta,
        textoDaPergunta: c.texto,
      });
    }
    if (ctx.retomada?.motivo === 'tempo') {
      return this.aoEsgotarOTempo(ctx, estado, chave, c.tempoSemResposta);
    }
    const enviada = await this.mensagens.enviar(ctx, {
      texto: textoDaPerguntaComOpcoes(ehChatDoSite(ctx), c.texto, c.opcoes),
      sufixo: 'pergunta',
      metadados: {
        botoes: c.opcoes.map((o) => ({ id: o.id, rotulo: o.rotulo })),
      },
    });
    return aguardarEntrada({
      ate: primeiroPrazo(c.tempoSemResposta, ctx.agora),
      saida: { pergunta: enviada.texto, opcoes: c.opcoes.map((o) => o.rotulo) },
      variaveis: {
        [chave]: { invalidas: 0, lembrou: false },
        ...transcricao(ctx, [
          {
            de: 'bot',
            texto: enviada.texto,
            opcoes: c.opcoes.map((o) => o.rotulo),
          },
        ]),
      },
    });
  }

  private async perguntaAberta(
    ctx: Ctx<ConfigDePerguntaAberta>,
  ): Promise<ResultadoDoPasso> {
    const c = ctx.config;
    const estado = estadoDe(ctx);
    const chave = chaveDoEstado(ctx);

    if (ctx.retomada?.motivo === 'entrada') {
      const entrada = lerEntrada(ctx.retomada.entrada);
      const consumida = {
        [VARIAVEL_DA_ULTIMA_ENTRADA]: entrada.mensagemId ?? null,
      };
      const itemContato: ItemDaTranscricao = {
        de: 'contato',
        texto: entrada.texto ?? '',
      };
      const validada = validarResposta(
        c.validacao ?? 'texto',
        entrada.texto ?? '',
      );
      if (validada.valido) {
        const pergunta = await this.mensagens.renderizar(ctx.execucao, c.texto);
        let gravacao: Record<string, unknown> | undefined;
        if (c.campoContato) {
          gravacao = await this.acoes.definirCampo(
            ctx.execucao,
            c.campoContato,
            String(validada.valor),
          );
        }
        return seguir({
          saida: {
            pergunta,
            resposta: validada.valor,
            ...(gravacao ? { campoContato: c.campoContato, gravacao } : {}),
          },
          variaveis: {
            ...consumida,
            ...transcricao(ctx, [itemContato]),
            [chave]: null,
            [c.variavel]: validada.valor,
          },
        });
      }
      return this.respostaInvalida(ctx, {
        estado,
        chave,
        consumida,
        itemContato,
        maximo: c.tentativas ?? TENTATIVAS_PADRAO_DA_PERGUNTA,
        mensagemInvalida: c.mensagemInvalida,
        reperguntar: (texto) => texto,
        textoPadrao: validada.motivo,
        tempo: c.tempoSemResposta,
        textoDaPergunta: c.texto,
      });
    }
    if (ctx.retomada?.motivo === 'tempo') {
      return this.aoEsgotarOTempo(ctx, estado, chave, c.tempoSemResposta);
    }
    const enviada = await this.mensagens.enviar(ctx, {
      texto: c.texto,
      sufixo: 'pergunta',
    });
    return aguardarEntrada({
      ate: primeiroPrazo(c.tempoSemResposta, ctx.agora),
      saida: { pergunta: enviada.texto },
      variaveis: {
        [chave]: { invalidas: 0, lembrou: false },
        ...transcricao(ctx, [{ de: 'bot', texto: enviada.texto }]),
      },
    });
  }

  /** Resposta que não serve: tenta de novo até o limite, depois sai pelo ramo `invalida` (ou encerra). */
  private async respostaInvalida(
    ctx: Ctx<ConfigDePerguntaComOpcoes | ConfigDePerguntaAberta>,
    p: {
      estado: EstadoDaPergunta;
      chave: string;
      consumida: Variaveis;
      itemContato: ItemDaTranscricao;
      maximo: number;
      mensagemInvalida: string | undefined;
      reperguntar: (texto: string) => string;
      /** Chat do site: botões da pergunta, repetidos junto da nova tentativa. */
      botoes?: { id: string; rotulo: string }[];
      textoPadrao: string;
      tempo: TempoSemResposta | undefined;
      textoDaPergunta: string;
    },
  ): Promise<ResultadoDoPasso> {
    const invalidas = p.estado.invalidas + 1;
    if (invalidas >= p.maximo) {
      const variaveis = {
        ...p.consumida,
        ...transcricao(ctx, [p.itemContato]),
        [p.chave]: null,
      };
      const saida = {
        resposta: p.itemContato.texto,
        motivo: 'respostas_invalidas',
      };
      return ctx.passo.ramos?.some((r) => r.id === 'invalida')
        ? irParaRamo('invalida', { saida, variaveis })
        : encerrar(MOTIVOS_DE_FIM.RESPOSTAS_INVALIDAS, { saida, variaveis });
    }
    const aviso = p.mensagemInvalida?.trim() || p.textoPadrao;
    const enviada = await this.mensagens.enviar(ctx, {
      texto: `${aviso}\n\n${p.reperguntar(p.textoDaPergunta)}`,
      sufixo: `invalida:${invalidas}`,
      ...(p.botoes ? { metadados: { botoes: p.botoes } } : {}),
    });
    return aguardarEntrada({
      ate: primeiroPrazo(p.tempo, ctx.agora),
      saida: { invalidas, resposta: p.itemContato.texto },
      variaveis: {
        ...p.consumida,
        [p.chave]: { invalidas, lembrou: false },
        ...transcricao(ctx, [
          p.itemContato,
          { de: 'bot', texto: enviada.texto },
        ]),
      },
    });
  }

  /** O contato não respondeu: lembrete uma vez; depois, ramo `sem_resposta` ou fim. */
  private async aoEsgotarOTempo(
    ctx: Ctx<unknown>,
    estado: EstadoDaPergunta,
    chave: string,
    tempo: TempoSemResposta | undefined,
  ): Promise<ResultadoDoPasso> {
    if (!estado.lembrou && tempo?.lembreteAposMinutos && tempo.lembrete) {
      const enviada = await this.mensagens.enviar(ctx, {
        texto: tempo.lembrete,
        sufixo: 'lembrete',
      });
      const restante = tempo.encerrarAposMinutos
        ? tempo.encerrarAposMinutos - tempo.lembreteAposMinutos
        : undefined;
      return aguardarEntrada({
        ate: restante
          ? new Date(ctx.agora.getTime() + restante * 60_000)
          : undefined,
        saida: { lembrete: enviada.texto },
        variaveis: {
          [chave]: { ...estado, lembrou: true },
          ...transcricao(ctx, [{ de: 'bot', texto: enviada.texto }]),
        },
      });
    }
    const variaveis = {
      [chave]: null,
      ...transcricao(ctx, [
        { de: 'sistema', texto: 'O contato não respondeu a tempo.' },
      ]),
    };
    const saida = { motivo: 'sem_resposta' };
    return ctx.passo.ramos?.some((r) => r.id === 'sem_resposta')
      ? irParaRamo('sem_resposta', { saida, variaveis })
      : encerrar(MOTIVOS_DE_FIM.SEM_RESPOSTA, { saida, variaveis });
  }

  // -------------------------------------------------------------------------
  // Condição, ações e transferência
  // -------------------------------------------------------------------------

  private async condicao(
    ctx: Ctx<Record<string, unknown>>,
  ): Promise<ResultadoDoPasso> {
    const ambiente = await this.ambienteDaCondicao(ctx);
    for (const ramo of ctx.passo.ramos ?? []) {
      const condicoes = condicoesDoRamo(ramo.config);
      if (
        condicoes.length > 0 &&
        condicoes.every((c) => avaliarCondicao(c, ambiente))
      ) {
        return irParaRamo(ramo.id, { saida: { ramo: ramo.id } });
      }
    }
    const senao = (ctx.passo.ramos ?? []).find(
      (ramo) => condicoesDoRamo(ramo.config).length === 0,
    );
    return senao
      ? irParaRamo(senao.id, { saida: { ramo: senao.id, senao: true } })
      : seguir({ saida: { ramo: null } });
  }

  private async ambienteDaCondicao(
    ctx: Ctx<unknown>,
  ): Promise<AmbienteDeCondicao> {
    const { execucao } = ctx;
    const simulado = execucao.contexto as {
      contato?: AmbienteDeCondicao['contato'];
      canal?: AmbienteDeCondicao['canal'];
    };
    const contatoBanco = execucao.contatoId
      ? await this.prisma.contato.findFirst({
          where: { id: execucao.contatoId, excluidoEm: null },
        })
      : null;
    const conversa = execucao.conversaId
      ? await this.prisma.conversa.findUnique({
          where: { id: execucao.conversaId },
          include: { canal: true },
        })
      : null;
    return {
      variaveis: execucao.variaveis,
      contato: contatoBanco
        ? {
            nome: contatoBanco.nome,
            email: contatoBanco.email,
            telefone: contatoBanco.telefone,
            cargo: contatoBanco.cargo,
            etiquetas: contatoBanco.etiquetas,
            campos:
              (contatoBanco.camposPersonalizados as Record<string, unknown>) ??
              {},
          }
        : (simulado.contato ?? null),
      canal: conversa
        ? {
            id: conversa.canal.id,
            tipo: conversa.canal.tipo,
            horarioAtendimento: conversa.canal.horarioAtendimento,
          }
        : (simulado.canal ?? null),
      agora: ctx.agora,
    };
  }

  private concluirAcao(
    ctx: Ctx<unknown>,
    rotulo: string,
    saida: Record<string, unknown>,
  ): ResultadoDoPasso {
    return seguir({
      saida,
      variaveis: transcricao(ctx, [
        {
          de: 'sistema',
          texto: `${rotulo}${saida.simulado ? ' (simulado)' : ''}`,
        },
      ]),
    });
  }

  private async transferir(
    ctx: Ctx<ConfigDeTransferir>,
  ): Promise<ResultadoDoPasso> {
    const itens: ItemDaTranscricao[] = [];
    if (ctx.config.mensagem?.trim()) {
      const aviso = await this.mensagens.enviar(ctx, {
        texto: ctx.config.mensagem,
        sufixo: 'transferencia',
      });
      itens.push({ de: 'bot', texto: aviso.texto });
    }
    const saida = await this.transferencia.transferir(
      ctx.execucao,
      ctx.config,
      ctx.chaveIdempotencia,
    );
    itens.push({
      de: 'sistema',
      texto: `Transferido para a equipe${saida.simulado ? ' (simulado)' : ''}.\n${saida.resumo}`,
    });
    return encerrar(MOTIVOS_DE_FIM.TRANSFERIDA, {
      saida,
      variaveis: transcricao(ctx, itens),
    });
  }
}
