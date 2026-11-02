import { Injectable, Logger } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ROTULO_DO_TIPO_DE_CANAL } from '../canais/registro-canais';
import { ehEmailValido, normalizarEmail } from '../comum/dominio/email';
import { normalizarTelefone } from '../comum/dominio/telefone';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { ContatosService } from '../contatos/contatos.service';
import { instantaneoDoContato } from '../contatos/instantaneos';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Canal,
  Contato,
  Conversa,
  FilaAtendimento,
  Prisma,
  TipoCanal,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import {
  EVENTOS_DO_ATENDIMENTO,
  linkDaConversa,
  REGRA_ATENDIMENTO,
  resumir,
  TIPOS_NOTIFICACAO_ATENDIMENTO,
} from './atendimento.constantes';
import {
  type EntradaDeAtendimento,
  normalizarIdentificador,
  ORDEM_DO_STATUS,
  ORIGEM_DO_CANAL,
  type RemetenteDaEntrada,
  type ResultadoDaEntrada,
  type StatusDeEntrega,
} from './entrada';
import {
  inicioDaContagem,
  jaRespondeuForaDoHorario,
  lerHorario,
  situacaoDoHorario,
} from './horario';
import { lideresParaAvisar } from './lideres';
import { MotorDoAtendimento } from './motor-do-atendimento.service';
import {
  AGRADECIMENTO_DA_AVALIACAO,
  type Avaliacao,
  lerAvaliacao,
  NOTA_BAIXA,
  TAMANHO_MAXIMO_COMENTARIO,
  VALIDADE_DA_PESQUISA_MS,
} from './satisfacao';
import { prazosDoSla } from './sla';

/** Janela de resposta comum da Meta (Instagram e Messenger, R14). */
export const JANELA_DA_META_MS = 24 * 60 * 60 * 1000;

/** Canais da Meta em que a mensagem do contato abre a janela de 24 h (R14, R28). */
const TIPOS_COM_JANELA_DE_24H: readonly TipoCanal[] = [
  'INSTAGRAM',
  'MESSENGER',
  'WHATSAPP_OFICIAL',
];

type CanalComFila = Canal & { filaPadrao: FilaAtendimento | null };

/**
 * Entrada do Atendimento omnichannel (§2.4, R12), chamada pelos módulos de
 * canal — sempre como o ator do canal:
 *
 * ```ts
 * const { conversaId, mensagemId, nova } = await executarComoAtor(
 *   { tipoAtor: 'SISTEMA', descricao: 'WhatsApp' },
 *   () => this.atendimento.receber({
 *     canalId: canal.id,
 *     remetente: { tipo: 'WHATSAPP', valor: '5511999990000', nome: 'Maria' },
 *     mensagem: { idExterno: 'ABC123', tipo: 'TEXTO', texto: 'Oi!', recebidaEm: new Date() },
 *   }),
 * );
 *
 * // quando o provedor informa o status de uma mensagem enviada:
 * await this.atendimento.atualizarStatus(canal.id, 'ABC999', 'ENTREGUE', undefined, quando);
 *
 * // nota da pesquisa de satisfação vinda de um botão do canal (chat do site):
 * await this.atendimento.avaliar(conversaId, 5, 'Muito bom!');
 * ```
 */
@Injectable()
export class AtendimentoService {
  private readonly logger = new Logger(AtendimentoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contatos: ContatosService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly motor: MotorDoAtendimento,
    private readonly notificacoes: NotificacoesService,
  ) {}

  /**
   * Mensagem que chegou por um canal, numa transação só:
   *
   * 1. idempotência pelo `mensagem.idExterno` no canal (`nova: false` na repetição);
   * 2. contato pelo `ContatoIdentificador`, senão pelo e-mail/telefone (R4.2), senão um novo;
   * 3. nota da pesquisa de satisfação pendente (até 24 h depois de resolver) — fica
   *    na conversa resolvida, que não reabre;
   * 4. a conversa em aberto do contato no canal (R12: no máximo uma) ou uma nova,
   *    na fila padrão do canal, com o SLA da fila (contado da abertura seguinte
   *    quando chega fora do horário) e distribuída pela estratégia da fila;
   * 5. a mensagem, o resumo da conversa e a resposta automática fora do horário
   *    (uma vez por conversa em cada período fechado);
   * 6. auditoria, outbox e tempo real depois do commit; o responsável escolhido
   *    é notificado.
   */
  async receber(entrada: EntradaDeAtendimento): Promise<ResultadoDaEntrada> {
    const idExterno = entrada.mensagem.idExterno?.trim() || undefined;
    return this.prisma.$transaction(async (tx) => {
      if (idExterno) {
        await travarChave(
          tx,
          'atendimento-mensagem',
          entrada.canalId,
          idExterno,
        );
        const repetida = await tx.mensagem.findUnique({
          where: {
            canalId_idExterno: { canalId: entrada.canalId, idExterno },
          },
          select: { id: true, conversaId: true },
        });
        if (repetida) {
          return {
            conversaId: repetida.conversaId,
            mensagemId: repetida.id,
            nova: false,
          };
        }
      }

      const canal = await tx.canal.findFirst({
        where: { id: entrada.canalId, excluidoEm: null },
        include: { filaPadrao: true },
      });
      if (!canal) {
        throw new NaoEncontradoException('Canal não encontrado.');
      }
      if (entrada.mensagem.arquivoId) {
        const arquivo = await tx.arquivo.findUnique({
          where: { id: entrada.mensagem.arquivoId },
          select: { removidoEm: true },
        });
        if (!arquivo || arquivo.removidoEm) {
          throw new DadosInvalidosException(
            'O anexo da mensagem não foi encontrado.',
          );
        }
      }

      const contato = await this.resolverContato(tx, canal, entrada.remetente);
      await travarChave(tx, 'atendimento-conversa', canal.id, contato.id);
      const aberta = await tx.conversa.findFirst({
        where: {
          canalId: canal.id,
          contatoId: contato.id,
          status: { not: 'RESOLVIDA' },
        },
      });
      if (!aberta) {
        const avaliada = await this.receberAvaliacao(
          tx,
          canal,
          contato,
          entrada,
          idExterno,
        );
        if (avaliada) {
          return avaliada;
        }
      }
      const agora = new Date();
      const nova = aberta === null;
      const primeiraNaoLida = (aberta?.naoLidas ?? 0) === 0;
      let conversa =
        aberta ??
        (await this.criarConversa(tx, canal, contato, entrada, agora));

      const mensagem = await this.gravarEntrada(
        tx,
        canal,
        conversa,
        entrada,
        idExterno,
      );
      conversa = await this.atualizarResumoDaEntrada(
        tx,
        canal,
        conversa,
        mensagem.id,
        entrada.mensagem.recebidaEm,
      );
      if (nova) {
        conversa = await this.motor.distribuir(tx, conversa);
      }

      await this.eventos.publicar(
        tx,
        EVENTOS_DO_ATENDIMENTO.MENSAGEM_RECEBIDA,
        {
          mensagemId: mensagem.id,
          conversaId: conversa.id,
          canalId: canal.id,
          canalTipo: canal.tipo,
          contatoId: contato.id,
          tipo: mensagem.tipo,
          conversaNova: nova,
          responsavelId: conversa.responsavelId,
          primeiraNaoLida,
        },
      );
      const completa = await this.motor.emitirConversa(tx, conversa.id, {
        nova,
      });
      await this.motor.emitirMensagem(tx, completa, mensagem.id);
      // Depois da entrada, para a resposta automática aparecer em seguida a ela.
      await this.responderForaDoHorario(tx, canal, conversa, agora);
      await this.motor.publicarContagens(tx, this.motor.afetadosPor(completa));
      return { conversaId: conversa.id, mensagemId: mensagem.id, nova: true };
    });
  }

  /**
   * O canal informou o status de uma mensagem de saída (pelo `idExterno`).
   * O status só avança (PENDENTE → ENVIADA → ENTREGUE → LIDA); `FALHOU` vale
   * enquanto a mensagem não foi entregue. Mensagem desconhecida ou repetição
   * fora de ordem: ignora. Emite `mensagem.status` depois do commit.
   */
  async atualizarStatus(
    canalId: string,
    idExterno: string,
    status: StatusDeEntrega,
    erro?: string,
    quando: Date = new Date(),
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const mensagem = await tx.mensagem.findUnique({
        where: { canalId_idExterno: { canalId, idExterno } },
      });
      if (!mensagem || mensagem.direcao !== 'SAIDA') {
        this.logger.debug?.(
          `Status ${status} de mensagem desconhecida (${idExterno}) ignorado.`,
        );
        return;
      }
      const atual = mensagem.status ?? 'PENDENTE';
      const avanca =
        status === 'FALHOU'
          ? atual === 'PENDENTE' || atual === 'ENVIADA'
          : ORDEM_DO_STATUS[status] > ORDEM_DO_STATUS[atual];
      if (!avanca) {
        return;
      }
      const motivo =
        status === 'FALHOU'
          ? erro?.trim() || 'Não foi possível enviar a mensagem.'
          : null;
      const entregue = status === 'ENTREGUE' || status === 'LIDA';
      const alteradas = await tx.mensagem.updateMany({
        where: { id: mensagem.id, status: mensagem.status },
        data: {
          status,
          erro: motivo,
          ...(status !== 'FALHOU' && !mensagem.enviadaEm
            ? { enviadaEm: quando }
            : {}),
          ...(entregue && !mensagem.entregueEm ? { entregueEm: quando } : {}),
          ...(status === 'LIDA' && !mensagem.lidaEm ? { lidaEm: quando } : {}),
        },
      });
      if (alteradas.count === 0) {
        return;
      }
      await this.motor.emitirStatus(
        tx,
        {
          id: mensagem.id,
          conversaId: mensagem.conversaId,
          status,
          erro: motivo,
        },
        quando,
      );
    });
  }

  /**
   * Nota da pesquisa de satisfação vinda do próprio canal (ex.: botões do chat
   * do site). 422 se a conversa não tem pesquisa aguardando resposta (não foi
   * pedida, já respondida ou passou de 24 h).
   */
  async avaliar(
    conversaId: string,
    nota: number,
    comentario?: string | null,
  ): Promise<void> {
    if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
      throw new DadosInvalidosException('A nota precisa ser de 1 a 5.', {
        campos: [{ campo: 'nota', mensagens: ['deve ser de 1 a 5'] }],
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM conversas WHERE id = ${conversaId}::uuid FOR UPDATE`;
      const conversa = await tx.conversa.findUnique({
        where: { id: conversaId },
        include: { contato: { select: { nome: true } } },
      });
      if (!conversa) {
        throw new NaoEncontradoException('Conversa não encontrada.');
      }
      if (!this.aguardandoAvaliacao(conversa)) {
        throw new RegraVioladaException(
          REGRA_ATENDIMENTO,
          'Esta conversa não está aguardando avaliação (a pesquisa vale por 24 horas depois de resolvida).',
          { motivo: 'pesquisa_indisponivel' },
        );
      }
      await this.registrarAvaliacao(tx, conversa, conversa.contato.nome, {
        nota,
        comentario:
          comentario?.trim().slice(0, TAMANHO_MAXIMO_COMENTARIO) || null,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Passos da entrada
  // -------------------------------------------------------------------------

  /** Contato do remetente: pelo identificador; senão pelo e-mail/telefone; senão cria. */
  private async resolverContato(
    tx: Tx,
    canal: Canal,
    remetente: RemetenteDaEntrada,
  ): Promise<Contato> {
    let valor: string;
    try {
      valor = normalizarIdentificador(remetente.tipo, remetente.valor);
    } catch (erro) {
      throw new DadosInvalidosException(
        `Remetente inválido: ${(erro as Error).message}`,
      );
    }
    await travarChave(tx, 'atendimento-identificador', remetente.tipo, valor);
    const nomeExibicao = remetente.nome?.trim() || null;
    const existente = await tx.contatoIdentificador.findUnique({
      where: { tipo_valor: { tipo: remetente.tipo, valor } },
      include: { contato: true },
    });
    if (existente && !existente.contato.excluidoEm) {
      await tx.contatoIdentificador.update({
        where: { id: existente.id },
        data: {
          ultimoUsoEm: new Date(),
          ...(nomeExibicao ? { nomeExibicao } : {}),
        },
      });
      return existente.contato;
    }
    if (existente) {
      // Contato anonimizado (R4.6): o identificador antigo não volta a ligá-lo.
      await tx.contatoIdentificador.delete({ where: { id: existente.id } });
    }

    const email =
      remetente.tipo === 'EMAIL' ? valor : emailOuNulo(remetente.email);
    const telefone =
      remetente.tipo === 'WHATSAPP'
        ? valor
        : telefoneOuNulo(remetente.telefone);
    const nome =
      nomeExibicao ??
      (remetente.tipo === 'EMAIL' || remetente.tipo === 'WHATSAPP'
        ? valor
        : `Contato do ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]}`);

    let contato: Contato | null = null;
    if (email || telefone) {
      contato = await tx.contato.findFirst({
        where: {
          excluidoEm: null,
          OR: [
            ...(email ? [{ email }] : []),
            ...(telefone ? [{ telefone }] : []),
          ],
        },
        orderBy: { criadoEm: 'asc' },
      });
      contato ??= (
        await this.contatos.encontrarOuCriar(tx, {
          nome,
          ...(email ? { email } : {}),
          ...(telefone ? { telefone } : {}),
          origem: ORIGEM_DO_CANAL[canal.tipo],
          origemDetalhe: canal.nome,
        })
      ).contato;
    } else {
      contato = await this.criarContatoSoComIdentificador(tx, canal, nome);
    }
    await tx.contatoIdentificador.create({
      data: {
        contatoId: contato.id,
        tipo: remetente.tipo,
        valor,
        canalId: canal.id,
        nomeExibicao,
        ultimoUsoEm: new Date(),
      },
    });
    return contato;
  }

  /**
   * Contato que só tem o identificador do canal (Instagram, Messenger, chat do
   * site sem e-mail nem telefone): o banco aceita porque o identificador é
   * gravado na mesma transação (R4.1, conferido no commit).
   */
  private async criarContatoSoComIdentificador(
    tx: Tx,
    canal: Canal,
    nome: string,
  ): Promise<Contato> {
    const origem = ORIGEM_DO_CANAL[canal.tipo];
    const agora = new Date();
    const contato = await tx.contato.create({
      data: {
        nome,
        primeiraOrigem: origem,
        primeiraOrigemDetalhe: canal.nome,
        ultimaOrigem: origem,
        ultimaOrigemDetalhe: canal.nome,
        ultimaOrigemEm: agora,
        conversoes: 1,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'contato.criado',
      entidade: 'contato',
      entidadeId: contato.id,
      resumo: `Contato "${contato.nome}" criado por mensagem no ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} (${canal.nome})`,
      dados: { canalId: canal.id, origem },
    });
    await this.eventos.publicar(
      tx,
      'contato.criado',
      instantaneoDoContato(contato),
    );
    return contato;
  }

  /**
   * Conversa nova do contato no canal: na fila padrão (ativa) do canal, com os
   * prazos do SLA da fila contados da chegada — ou da abertura seguinte, fora
   * do horário de atendimento.
   */
  private async criarConversa(
    tx: Tx,
    canal: CanalComFila,
    contato: Contato,
    entrada: EntradaDeAtendimento,
    agora: Date,
  ): Promise<Conversa> {
    const fila =
      canal.filaPadrao && canal.filaPadrao.ativa && !canal.filaPadrao.excluidoEm
        ? canal.filaPadrao
        : null;
    const prazos = prazosDoSla(
      fila,
      inicioDaContagem(lerHorario(canal.horarioAtendimento), agora),
    );
    const conversa = await tx.conversa.create({
      data: {
        canalId: canal.id,
        contatoId: contato.id,
        filaId: fila?.id ?? null,
        idExterno: entrada.idExternoConversa?.trim() || null,
        assunto: entrada.assunto?.trim().slice(0, 200) || null,
        ...prazos,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'conversa.criada',
      entidade: 'conversa',
      entidadeId: conversa.id,
      resumo: `Conversa com "${contato.nome}" aberta no ${ROTULO_DO_TIPO_DE_CANAL[canal.tipo]} (${canal.nome})${fila ? ` na fila ${fila.nome}` : ''}`,
      dados: { canalId: canal.id, filaId: conversa.filaId },
      relacionados: { contato: contato.id },
    });
    await this.eventos.publicar(tx, EVENTOS_DO_ATENDIMENTO.CONVERSA_CRIADA, {
      conversaId: conversa.id,
      canalId: canal.id,
      canalTipo: canal.tipo,
      contatoId: contato.id,
      filaId: conversa.filaId,
    });
    return conversa;
  }

  private async gravarEntrada(
    tx: Tx,
    canal: Canal,
    conversa: Conversa,
    entrada: EntradaDeAtendimento,
    idExterno: string | undefined,
  ) {
    const mensagemEntrada = entrada.mensagem;
    const citada = mensagemEntrada.respondeAIdExterno
      ? await tx.mensagem.findUnique({
          where: {
            canalId_idExterno: {
              canalId: canal.id,
              idExterno: mensagemEntrada.respondeAIdExterno,
            },
          },
          select: { id: true, conversaId: true },
        })
      : null;
    const citadaNaConversa =
      citada && citada.conversaId === conversa.id ? citada : null;
    const metadados: Record<string, unknown> = {
      ...mensagemEntrada.metadados,
      ...(mensagemEntrada.respondeAIdExterno && !citadaNaConversa
        ? { respondeAIdExterno: mensagemEntrada.respondeAIdExterno }
        : {}),
    };
    return tx.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: canal.id,
        direcao: 'ENTRADA',
        tipo: mensagemEntrada.tipo,
        texto: mensagemEntrada.texto ?? null,
        arquivoId: mensagemEntrada.arquivoId ?? null,
        idExterno: idExterno ?? null,
        respostaAId: citadaNaConversa?.id ?? null,
        metadados:
          Object.keys(metadados).length > 0
            ? (metadados as Prisma.InputJsonObject)
            : undefined,
        ocorridaEm: mensagemEntrada.recebidaEm,
      },
    });
  }

  /**
   * Resumo da conversa depois de uma entrada: não lidas, desde quando o
   * contato espera, última mensagem, janela de 24 h da Meta e — se estava
   * `PENDENTE` (aguardando o contato) — volta a `ABERTA`.
   */
  private async atualizarResumoDaEntrada(
    tx: Tx,
    canal: Canal,
    conversa: Conversa,
    mensagemId: string,
    recebidaEm: Date,
  ): Promise<Conversa> {
    const maisRecente =
      !conversa.ultimaMensagemEm || recebidaEm >= conversa.ultimaMensagemEm;
    const entradaMaisRecente =
      !conversa.ultimaEntradaEm || recebidaEm > conversa.ultimaEntradaEm;
    return tx.conversa.update({
      where: { id: conversa.id },
      data: {
        naoLidas: { increment: 1 },
        aguardandoDesde: conversa.aguardandoDesde ?? recebidaEm,
        ...(conversa.status === 'PENDENTE' ? { status: 'ABERTA' } : {}),
        ...(maisRecente
          ? { ultimaMensagemId: mensagemId, ultimaMensagemEm: recebidaEm }
          : {}),
        ...(entradaMaisRecente
          ? {
              ultimaEntradaEm: recebidaEm,
              ...(TIPOS_COM_JANELA_DE_24H.includes(canal.tipo)
                ? {
                    janelaAte: new Date(
                      recebidaEm.getTime() + JANELA_DA_META_MS,
                    ),
                  }
                : {}),
            }
          : {}),
      },
    });
  }

  /**
   * Fora do horário de atendimento, responde a mensagem automática do canal
   * — uma vez por conversa em cada período fechado.
   */
  private async responderForaDoHorario(
    tx: Tx,
    canal: Canal,
    conversa: Conversa,
    agora: Date,
  ): Promise<void> {
    const texto = canal.mensagemForaHorario?.trim();
    const horario = lerHorario(canal.horarioAtendimento);
    if (!texto || !horario || !canal.ativo) {
      return;
    }
    const situacao = situacaoDoHorario(horario, agora);
    if (
      situacao.aberto ||
      jaRespondeuForaDoHorario(conversa.foraHorarioRespondidoEm, situacao)
    ) {
      return;
    }
    await tx.conversa.update({
      where: { id: conversa.id },
      data: { foraHorarioRespondidoEm: agora },
    });
    await this.motor.criarSaida(tx, conversa, canal, {
      texto,
      autorId: null,
      metadados: { automatica: 'fora_do_horario' },
    });
  }

  /**
   * Nota da pesquisa de satisfação (R12): o contato sem conversa em aberto
   * responde, até 24 h depois de resolvida, algo que parece uma nota ("5",
   * "nota 4", "⭐⭐⭐"). A mensagem fica na conversa resolvida, que não reabre.
   * Devolve `null` quando não é o caso (a entrada segue o fluxo normal).
   */
  private async receberAvaliacao(
    tx: Tx,
    canal: Canal,
    contato: Contato,
    entrada: EntradaDeAtendimento,
    idExterno: string | undefined,
  ): Promise<ResultadoDaEntrada | null> {
    if (entrada.mensagem.tipo !== 'TEXTO') {
      return null;
    }
    const avaliacao = lerAvaliacao(entrada.mensagem.texto);
    if (!avaliacao) {
      return null;
    }
    const conversa = await tx.conversa.findFirst({
      where: {
        canalId: canal.id,
        contatoId: contato.id,
        status: 'RESOLVIDA',
        satisfacaoRespondidaEm: null,
        satisfacaoSolicitadaEm: {
          gte: new Date(Date.now() - VALIDADE_DA_PESQUISA_MS),
        },
      },
      orderBy: { satisfacaoSolicitadaEm: 'desc' },
    });
    if (!conversa) {
      return null;
    }
    const mensagem = await this.gravarEntrada(
      tx,
      canal,
      conversa,
      entrada,
      idExterno,
    );
    const recebidaEm = entrada.mensagem.recebidaEm;
    await tx.mensagem.update({
      where: { id: mensagem.id },
      data: { lidaEm: new Date() },
    });
    await tx.conversa.update({
      where: { id: conversa.id },
      data: {
        ultimaMensagemId: mensagem.id,
        ultimaMensagemEm: recebidaEm,
        ultimaEntradaEm: recebidaEm,
        ...(TIPOS_COM_JANELA_DE_24H.includes(canal.tipo)
          ? { janelaAte: new Date(recebidaEm.getTime() + JANELA_DA_META_MS) }
          : {}),
      },
    });
    await this.registrarAvaliacao(tx, conversa, contato.nome, avaliacao, {
      mensagemId: mensagem.id,
    });
    return { conversaId: conversa.id, mensagemId: mensagem.id, nova: true };
  }

  private aguardandoAvaliacao(conversa: Conversa): boolean {
    return (
      conversa.status === 'RESOLVIDA' &&
      conversa.satisfacaoSolicitadaEm !== null &&
      conversa.satisfacaoRespondidaEm === null &&
      Date.now() - conversa.satisfacaoSolicitadaEm.getTime() <=
        VALIDADE_DA_PESQUISA_MS
    );
  }

  /** Grava a nota, agradece ao contato, audita, avisa o líder se a nota é baixa e emite em tempo real. */
  private async registrarAvaliacao(
    tx: Tx,
    conversa: Conversa,
    nomeDoContato: string,
    avaliacao: Avaliacao,
    opcoes: { mensagemId?: string } = {},
  ): Promise<void> {
    const atualizada = await tx.conversa.update({
      where: { id: conversa.id },
      data: {
        satisfacaoNota: avaliacao.nota,
        satisfacaoComentario: avaliacao.comentario,
        satisfacaoRespondidaEm: new Date(),
      },
    });
    const canal = await tx.canal.findUniqueOrThrow({
      where: { id: conversa.canalId },
    });
    if (canal.ativo && !canal.excluidoEm) {
      await this.motor.criarSaida(tx, atualizada, canal, {
        texto: AGRADECIMENTO_DA_AVALIACAO,
        autorId: null,
        metadados: { automatica: 'agradecimento_da_avaliacao' },
      });
    }
    await this.auditoria.registrar(tx, {
      acao: 'conversa.avaliada',
      entidade: 'conversa',
      entidadeId: conversa.id,
      resumo: `Conversa com "${nomeDoContato}" avaliada com nota ${avaliacao.nota}`,
      dados: { nota: avaliacao.nota, comentario: avaliacao.comentario },
      relacionados: { contato: conversa.contatoId },
    });
    await this.eventos.publicar(tx, EVENTOS_DO_ATENDIMENTO.CONVERSA_AVALIADA, {
      conversaId: conversa.id,
      canalId: conversa.canalId,
      contatoId: conversa.contatoId,
      filaId: conversa.filaId,
      resolvidaPorId: conversa.resolvidaPorId,
      nota: avaliacao.nota,
      comentario: avaliacao.comentario,
    });
    if (avaliacao.nota <= NOTA_BAIXA) {
      await this.avisarAvaliacaoBaixa(
        tx,
        conversa,
        nomeDoContato,
        canal.nome,
        avaliacao,
      );
    }
    const completa = await this.motor.emitirConversa(tx, conversa.id);
    if (opcoes.mensagemId) {
      await this.motor.emitirMensagem(tx, completa, opcoes.mensagemId);
    }
  }

  /**
   * Nota baixa (1 ou 2): avisa o líder de quem atendeu (ou os líderes da área
   * da fila), para ele olhar a conversa enquanto o assunto está quente.
   */
  private async avisarAvaliacaoBaixa(
    tx: Tx,
    conversa: Conversa,
    nomeDoContato: string,
    nomeDoCanal: string,
    avaliacao: Avaliacao,
  ): Promise<void> {
    const atendenteId = conversa.responsavelId ?? conversa.resolvidaPorId;
    const [atendente, fila] = await Promise.all([
      atendenteId
        ? tx.usuario.findUnique({
            where: { id: atendenteId },
            select: { nome: true, liderId: true },
          })
        : Promise.resolve(null),
      conversa.filaId
        ? tx.filaAtendimento.findUnique({
            where: { id: conversa.filaId },
            select: { area: true },
          })
        : Promise.resolve(null),
    ]);
    const lideres = await lideresParaAvisar(
      tx,
      atendente?.liderId ?? null,
      fila?.area ?? null,
    );
    await this.notificacoes.notificarVarios(tx, lideres, {
      tipo: TIPOS_NOTIFICACAO_ATENDIMENTO.AVALIACAO_BAIXA,
      titulo: `Avaliação ${avaliacao.nota} de 5 no atendimento`,
      texto: `${nomeDoContato} (${nomeDoCanal})${atendente ? `, atendido(a) por ${atendente.nome}` : ''}${avaliacao.comentario ? `: "${resumir(avaliacao.comentario)}"` : '.'}`,
      link: linkDaConversa(conversa.id),
      dados: { conversaId: conversa.id, nota: avaliacao.nota },
    });
  }
}

function emailOuNulo(email: string | undefined): string | null {
  if (!email?.trim()) {
    return null;
  }
  const normalizado = normalizarEmail(email);
  return ehEmailValido(normalizado) ? normalizado : null;
}

function telefoneOuNulo(telefone: string | undefined): string | null {
  if (!telefone?.trim()) {
    return null;
  }
  const resultado = normalizarTelefone(telefone);
  return resultado.valido ? resultado.telefone : null;
}
