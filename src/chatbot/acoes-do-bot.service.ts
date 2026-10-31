import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { dadosDoEvento } from '../atividades/atividades.service';
import { ORIGEM_DO_CANAL } from '../atendimento/entrada';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { normalizarEmailOpcional } from '../comum/dominio/email';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { normalizarTelefoneOpcional } from '../comum/dominio/telefone';
import type { ExecucaoAtual } from '../comum/passos/tipos';
import { ErroDePassoTemporario } from '../comum/passos/tipos';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import {
  TAMANHO_MAXIMO_NOME,
  TRAVA_EMAIL_DO_CONTATO,
  TRAVA_TELEFONE_DO_CONTATO,
} from '../contatos/contatos.constantes';
import {
  aplicarPatchDosCampos,
  normalizarTextoCurto,
} from '../contatos/deduplicacao';
import {
  CAMPOS_AUDITADOS_DO_CONTATO,
  instantaneoDoContato,
} from '../contatos/instantaneos';
import { descreverAlteracoes } from '../contatos/rotulos';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { NegociosService } from '../funis/negocios.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { enviarPost } from '../webhooks/saida/envio-http';
import { verificarDestino } from '../webhooks/saida/protecao-ssrf';
import { PRAZO_DO_WEBHOOK_DO_BOT_MS } from './chatbot.constantes';
import {
  ConversaIndisponivel,
  MensagensDoBot,
} from './mensagens-do-bot.service';

/** O que o passo grava no histórico (`execucao_passos.resultado.saida`). */
export type SaidaDeAcao = Record<string, unknown>;

type ConfigDeAtividade = {
  tipo?: 'TAREFA' | 'LIGACAO' | 'REUNIAO' | 'EMAIL' | 'WHATSAPP';
  titulo: string;
  descricao?: string;
  prazoHoras?: number;
  prioridade?: 'BAIXA' | 'MEDIA' | 'ALTA';
  responsavelId?: string;
};

/**
 * Ações dos passos do chatbot (R18). Cada uma roda numa transação, com a mesma
 * regra de negócio e a mesma auditoria das ações humanas — o ator do contexto é
 * `AUTOMACAO` (descrição = nome do fluxo). No modo teste/simulador nada é
 * gravado: a ação só descreve o que faria.
 */
@Injectable()
export class AcoesDoBot {
  constructor(
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly motor: MotorDoAtendimento,
    private readonly negocios: NegociosService,
    private readonly mensagens: MensagensDoBot,
  ) {}

  // -------------------------------------------------------------------------
  // Contato
  // -------------------------------------------------------------------------

  async etiquetar(
    execucao: ExecucaoAtual,
    config: { adicionar?: string[]; etiquetas?: string[]; remover?: string[] },
  ): Promise<SaidaDeAcao> {
    const adicionar = normalizarEtiquetas(
      config.adicionar ?? config.etiquetas ?? [],
    );
    const remover = (config.remover ?? []).map((e) =>
      e.trim().toLocaleLowerCase('pt-BR'),
    );
    if (execucao.teste) {
      return { simulado: true, adicionar, remover: config.remover ?? [] };
    }
    const contatoId = this.exigirContato(execucao);
    return this.prisma.$transaction(async (tx) => {
      const antes = await this.contatoTravado(tx, contatoId);
      const mantidas = antes.etiquetas.filter(
        (e) => !remover.includes(e.toLocaleLowerCase('pt-BR')),
      );
      const depoisLista = normalizarEtiquetas([...mantidas, ...adicionar]);
      const alteracoes = calcularAlteracoes(
        antes,
        { ...antes, etiquetas: depoisLista },
        CAMPOS_AUDITADOS_DO_CONTATO,
      );
      if (Object.keys(alteracoes).length === 0) {
        return { semMudanca: true };
      }
      const depois = await tx.contato.update({
        where: { id: contatoId },
        data: { etiquetas: depoisLista },
      });
      await this.registrarMudancaDoContato(tx, antes, depois, alteracoes);
      return { etiquetas: depois.etiquetas };
    });
  }

  /** Grava um campo do contato (`nome`, `email`, `telefone`, `cargo`, `campos.x`). */
  async definirCampo(
    execucao: ExecucaoAtual,
    campo: string,
    valor: string,
  ): Promise<SaidaDeAcao> {
    if (execucao.teste) {
      return { simulado: true, campo, valor };
    }
    const contatoId = this.exigirContato(execucao);
    return this.prisma.$transaction(async (tx) => {
      let email: string | null | undefined;
      let telefone: string | null | undefined;
      try {
        if (campo === 'email') {
          email = normalizarEmailOpcional(valor);
        } else if (campo === 'telefone') {
          telefone = normalizarTelefoneOpcional(valor);
        }
      } catch (erro) {
        return { naoGravado: true, motivo: (erro as Error).message };
      }
      if (email) {
        await travarChave(tx, TRAVA_EMAIL_DO_CONTATO, email);
      }
      if (telefone) {
        await travarChave(tx, TRAVA_TELEFONE_DO_CONTATO, telefone);
      }
      const antes = await this.contatoTravado(tx, contatoId);
      const dados: Prisma.ContatoUncheckedUpdateInput = {};
      if (campo === 'nome') {
        const nome = normalizarTextoCurto(valor, TAMANHO_MAXIMO_NOME);
        if (!nome) {
          return { naoGravado: true, motivo: 'Nome vazio.' };
        }
        dados.nome = nome;
      } else if (campo === 'cargo') {
        dados.cargo = normalizarTextoCurto(valor);
      } else if (email || telefone) {
        const outro = await tx.contato.findFirst({
          where: {
            id: { not: contatoId },
            excluidoEm: null,
            ...(email ? { email } : { telefone }),
          },
          select: { id: true },
        });
        if (outro) {
          return {
            naoGravado: true,
            motivo: 'Outro contato já usa este valor.',
            campo,
          };
        }
        if (email) {
          dados.email = email;
        } else {
          dados.telefone = telefone;
        }
      } else if (campo.startsWith('campos.')) {
        dados.camposPersonalizados = aplicarPatchDosCampos(
          antes.camposPersonalizados,
          { [campo.slice('campos.'.length)]: valor },
        ) as Prisma.InputJsonObject;
      } else {
        return { naoGravado: true, motivo: 'Campo desconhecido.' };
      }
      const alteracoes = calcularAlteracoes(
        antes,
        { ...antes, ...dados } as typeof antes,
        CAMPOS_AUDITADOS_DO_CONTATO,
      );
      if (Object.keys(alteracoes).length === 0) {
        return { semMudanca: true };
      }
      const depois = await tx.contato.update({
        where: { id: contatoId },
        data: dados,
      });
      await this.registrarMudancaDoContato(tx, antes, depois, alteracoes);
      return { campo, gravado: true };
    });
  }

  // -------------------------------------------------------------------------
  // Conversa
  // -------------------------------------------------------------------------

  /** Muda a conversa de fila e, se `distribuir`, escolhe o responsável pela estratégia da fila. */
  async moverParaFila(
    execucao: ExecucaoAtual,
    filaId: string,
    distribuir = true,
  ): Promise<SaidaDeAcao> {
    if (execucao.teste) {
      return { simulado: true, filaId, distribuir };
    }
    const conversaId = this.exigirConversa(execucao);
    return this.prisma.$transaction(async (tx) => {
      const conversa = await this.conversaAberta(tx, conversaId);
      const fila = await tx.filaAtendimento.findFirst({
        where: { id: filaId, ativa: true, excluidoEm: null },
        select: { id: true, nome: true },
      });
      if (!fila) {
        return {
          naoMovida: true,
          motivo: 'A fila não existe ou está inativa.',
        };
      }
      const salasAntes = this.motor.salas(
        await this.motor.carregar(tx, conversaId),
      );
      let atual = conversa;
      if (conversa.filaId !== fila.id) {
        atual = await this.motor.atribuir(tx, conversa, {
          usuarioId: null,
          filaId: fila.id,
          motivo: 'TRANSFERENCIA',
          nota: `Movida para a fila ${fila.nome} pelo fluxo "${execucao.nome}"`,
          notificar: false,
        });
      }
      if (distribuir && !atual.responsavelId) {
        atual = await this.motor.distribuir(tx, atual);
      }
      await this.motor.emitirConversa(tx, conversaId, { salasAntes });
      await this.motor.publicarContagens(tx, {
        usuarios: [conversa.responsavelId, atual.responsavelId],
        areas: [(await this.motor.carregar(tx, conversaId)).fila?.area],
      });
      return { filaId: fila.id, responsavelId: atual.responsavelId };
    });
  }

  async atribuir(
    execucao: ExecucaoAtual,
    usuarioId: string,
  ): Promise<SaidaDeAcao> {
    if (execucao.teste) {
      return { simulado: true, usuarioId };
    }
    const conversaId = this.exigirConversa(execucao);
    return this.prisma.$transaction(async (tx) => {
      const conversa = await this.conversaAberta(tx, conversaId);
      const usuario = await tx.usuario.findFirst({
        where: { id: usuarioId, ativo: true },
        select: { id: true },
      });
      if (!usuario) {
        return { naoAtribuida: true, motivo: 'A pessoa não está ativa.' };
      }
      const salasAntes = this.motor.salas(
        await this.motor.carregar(tx, conversaId),
      );
      await this.motor.atribuir(tx, conversa, {
        usuarioId: usuario.id,
        motivo: 'MANUAL',
        nota: `Atribuída pelo fluxo "${execucao.nome}"`,
      });
      await this.motor.emitirConversa(tx, conversaId, { salasAntes });
      const depois = await this.motor.carregar(tx, conversaId);
      await this.motor.publicarContagens(tx, {
        usuarios: [conversa.responsavelId, usuario.id],
        areas: [depois.fila?.area],
      });
      return { usuarioId: usuario.id };
    });
  }

  // -------------------------------------------------------------------------
  // Negócio e atividade
  // -------------------------------------------------------------------------

  async criarNegocio(
    execucao: ExecucaoAtual,
    config: {
      funilId?: string;
      etapaId?: string;
      titulo?: string;
      valor?: string;
      responsavelFixoId?: string;
    },
  ): Promise<SaidaDeAcao> {
    if (execucao.teste) {
      return { simulado: true, ...config };
    }
    const contatoId = this.exigirContato(execucao);
    const titulo = config.titulo
      ? await this.mensagens.renderizar(execucao, config.titulo)
      : undefined;
    return this.prisma.$transaction(async (tx) => {
      const conversa = execucao.conversaId
        ? await tx.conversa.findUnique({
            where: { id: execucao.conversaId },
            include: { canal: true, fila: true },
          })
        : null;
      let funilId = config.funilId;
      if (!funilId) {
        const funil = await tx.funil.findFirst({
          where: {
            area: conversa?.fila?.area ?? 'COMERCIAL',
            base: true,
            excluidoEm: null,
          },
          select: { id: true },
        });
        if (!funil) {
          return {
            naoCriado: true,
            motivo: 'Não há funil base para o negócio.',
          };
        }
        funilId = funil.id;
      }
      const etapa = config.etapaId
        ? { id: config.etapaId }
        : await tx.etapa.findFirst({
            where: { funilId, tipo: 'ABERTA' },
            orderBy: { ordem: 'asc' },
            select: { id: true },
          });
      if (!etapa) {
        return { naoCriado: true, motivo: 'O funil não tem etapa de entrada.' };
      }
      const resultado = await this.negocios.criarAutomatico(tx, {
        contatoId,
        funilId,
        etapaId: etapa.id,
        titulo,
        valor: config.valor,
        origem: conversa ? ORIGEM_DO_CANAL[conversa.canal.tipo] : 'OUTRO',
        origemDetalhe: `Chatbot: ${execucao.nome}`,
        estrategia: config.responsavelFixoId ? 'RESPONSAVEL_FIXO' : 'RODIZIO',
        responsavelFixoId: config.responsavelFixoId,
      });
      if (conversa && !conversa.negocioId) {
        await tx.conversa.update({
          where: { id: conversa.id },
          data: { negocioId: resultado.negocio.id },
        });
        await this.motor.emitirConversa(tx, conversa.id);
      }
      return {
        negocioId: resultado.negocio.id,
        criado: resultado.criado,
        reconversao: resultado.reconversao,
      };
    });
  }

  async criarAtividade(
    execucao: ExecucaoAtual,
    config: ConfigDeAtividade,
  ): Promise<SaidaDeAcao> {
    const titulo = await this.mensagens.renderizar(execucao, config.titulo);
    const descricao = config.descricao
      ? await this.mensagens.renderizar(execucao, config.descricao)
      : null;
    if (execucao.teste) {
      return { simulado: true, titulo, descricao };
    }
    const contatoId = this.exigirContato(execucao);
    return this.prisma.$transaction(async (tx) => {
      const contato = await this.contatoTravado(tx, contatoId);
      const conversa = execucao.conversaId
        ? await tx.conversa.findUnique({ where: { id: execucao.conversaId } })
        : null;
      const responsavelId =
        config.responsavelId ??
        conversa?.responsavelId ??
        contato.responsavelId;
      const responsavel = responsavelId
        ? await tx.usuario.findFirst({
            where: { id: responsavelId, ativo: true },
            select: { id: true },
          })
        : null;
      if (!responsavel) {
        return {
          naoCriada: true,
          motivo: 'Não há responsável ativo para a atividade.',
        };
      }
      const agora = new Date();
      const atividade = await tx.atividade.create({
        data: {
          tipo: config.tipo ?? 'TAREFA',
          titulo: titulo.slice(0, 200) || 'Atividade do chatbot',
          descricao,
          prioridade: config.prioridade ?? 'MEDIA',
          venceEm: new Date(
            agora.getTime() + (config.prazoHoras ?? 24) * 3_600_000,
          ),
          responsavelId: responsavel.id,
          criadoPorId: null,
          contatoId,
          empresaId: contato.empresaId,
          negocioId: conversa?.negocioId ?? null,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'atividade.criada',
        entidade: 'atividade',
        entidadeId: atividade.id,
        resumo: `Atividade "${atividade.titulo}" criada pelo fluxo "${execucao.nome}"`,
        dados: { ...dadosDoEvento(atividade) },
        relacionados: {
          contato: atividade.contatoId,
          empresa: atividade.empresaId,
          negocio: atividade.negocioId,
        },
      });
      await this.eventos.publicar(
        tx,
        'atividade.criada',
        dadosDoEvento(atividade),
      );
      return { atividadeId: atividade.id };
    });
  }

  // -------------------------------------------------------------------------
  // Webhook de saída
  // -------------------------------------------------------------------------

  /**
   * `POST` JSON para a URL do passo (mesma proteção contra rede interna dos
   * webhooks de saída, R9.1). Falha de rede ou 5xx: o executor tenta de novo
   * (até 5x); depois disso, `aoFalhar: 'continuar'` (padrão) segue o fluxo.
   */
  async chamarWebhook(
    execucao: ExecucaoAtual,
    config: {
      url: string;
      corpo?: Record<string, unknown>;
      cabecalhos?: Record<string, string>;
      salvarEm?: string;
    },
    tentativa: number,
  ): Promise<{ saida: SaidaDeAcao; variaveis?: Record<string, unknown> }> {
    const corpo = {
      evento: 'chatbot.webhook',
      fluxo: { id: execucao.fluxoId, nome: execucao.nome },
      execucaoId: execucao.id,
      conversaId: execucao.conversaId,
      contatoId: execucao.contatoId,
      variaveis: execucao.variaveis,
      ...config.corpo,
    };
    if (execucao.teste) {
      return { saida: { simulado: true, url: config.url, corpo } };
    }
    const verificado = await verificarDestino(config.url, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (!verificado.permitido) {
      return { saida: { bloqueado: true, motivo: verificado.mensagem } };
    }
    const resultado = await enviarPost({
      url: config.url,
      corpo: JSON.stringify(corpo),
      cabecalhos: {
        'Content-Type': 'application/json',
        'User-Agent': 'BRL-CRM-Chatbot/1.0',
        ...config.cabecalhos,
      },
      prazoMs: PRAZO_DO_WEBHOOK_DO_BOT_MS,
    });
    const saida: SaidaDeAcao = {
      statusHttp: resultado.statusHttp,
      sucesso: resultado.sucesso,
      erro: resultado.erro,
    };
    const temporario =
      !resultado.sucesso &&
      (resultado.statusHttp === null || resultado.statusHttp >= 500);
    if (temporario && tentativa < 3) {
      throw new ErroDePassoTemporario(
        resultado.erro ?? 'O webhook não respondeu.',
        10 * tentativa,
      );
    }
    return {
      saida,
      variaveis:
        config.salvarEm && resultado.sucesso
          ? { [config.salvarEm]: resultado.trechoResposta ?? '' }
          : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  exigirContato(execucao: ExecucaoAtual): string {
    if (!execucao.contatoId) {
      throw new Error('A execução do chatbot não tem contato.');
    }
    return execucao.contatoId;
  }

  exigirConversa(execucao: ExecucaoAtual): string {
    if (!execucao.conversaId) {
      throw new Error('A execução do chatbot não tem conversa.');
    }
    return execucao.conversaId;
  }

  /** Conversa travada e aberta; resolvida: o fluxo para (`ConversaIndisponivel`). */
  async conversaAberta(tx: Tx, conversaId: string) {
    await tx.$queryRaw`SELECT id FROM conversas WHERE id = ${conversaId}::uuid FOR UPDATE`;
    const conversa = await tx.conversa.findUnique({
      where: { id: conversaId },
    });
    if (!conversa || conversa.status === 'RESOLVIDA') {
      throw new ConversaIndisponivel();
    }
    return conversa;
  }

  private async contatoTravado(tx: Tx, contatoId: string) {
    await tx.$queryRaw`SELECT id FROM contatos WHERE id = ${contatoId}::uuid FOR UPDATE`;
    const contato = await tx.contato.findFirst({
      where: { id: contatoId, excluidoEm: null },
    });
    if (!contato) {
      throw new Error('O contato foi excluído.');
    }
    return contato;
  }

  private async registrarMudancaDoContato(
    tx: Tx,
    antes: { nome: string; empresaId: string | null },
    depois: Parameters<typeof instantaneoDoContato>[0],
    alteracoes: ReturnType<typeof calcularAlteracoes>,
  ): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: depois.id,
      resumo: `Contato "${depois.nome}" atualizado: ${descreverAlteracoes(alteracoes)}`,
      dados: { alteracoes },
      relacionados: { empresa: depois.empresaId ?? antes.empresaId },
    });
    await this.eventos.publicar(tx, 'contato.atualizado', {
      ...instantaneoDoContato(depois),
      camposAlterados: Object.keys(alteracoes),
      motivo: 'automacao',
    });
  }
}
