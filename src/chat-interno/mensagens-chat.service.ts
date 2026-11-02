import { Injectable } from '@nestjs/common';
import { ArquivosService } from '../arquivos/arquivos.service';
import {
  clausulaWhere,
  condicoesDeBusca,
  termosDaBusca,
} from '../auditoria/consulta/consulta-comum';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { podeVerNegocio } from '../funis/acesso-funis';
import { type ChatCanal, Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { CanaisChatService } from './canais-chat.service';
import type {
  BuscaMensagensChatDto,
  EditarMensagemChatDto,
  EnviarMensagemChatDto,
  FiltroMensagensChatDto,
} from './dto/requisicoes.dto';
import type {
  ChatMensagemDto,
  PaginaChatMensagensDto,
  ResultadoBuscaChatDto,
} from './dto/respostas.dto';
import {
  INCLUIR_NA_MENSAGEM,
  type MensagemCompleta,
  MontagemChatService,
} from './montagem-chat.service';
import { PublicacaoChatService } from './publicacao-chat.service';
import {
  extrairMarcacoes,
  lerReferencias,
  linkDaMensagem,
  lugarDoCanal,
  type Marcacoes,
  MAXIMO_DE_MENCOES,
  MAXIMO_DE_REFERENCIAS,
  NOTIFICACAO_DE_MENCAO,
  normalizarTextoDaMensagem,
  type ReferenciaGuardada,
  REGRAS_DO_CHAT,
  sqlTextoSemMarcacoes,
} from './regras-chat';
import { SincronizacaoChatService } from './sincronizacao-chat.service';

/** Posição de uma mensagem na ordem do canal (data e id, para desempate). */
interface Posicao {
  id: string;
  criadoEm: Date;
}

function antesDe(posicao: Posicao): Prisma.ChatMensagemWhereInput {
  return {
    OR: [
      { criadoEm: { lt: posicao.criadoEm } },
      { criadoEm: posicao.criadoEm, id: { lt: posicao.id } },
    ],
  };
}

function depoisDe(posicao: Posicao): Prisma.ChatMensagemWhereInput {
  return {
    OR: [
      { criadoEm: { gt: posicao.criadoEm } },
      { criadoEm: posicao.criadoEm, id: { gt: posicao.id } },
    ],
  };
}

const MAIS_NOVAS_PRIMEIRO: Prisma.ChatMensagemOrderByWithRelationInput[] = [
  { criadoEm: 'desc' },
  { id: 'desc' },
];
const MAIS_ANTIGAS_PRIMEIRO: Prisma.ChatMensagemOrderByWithRelationInput[] = [
  { criadoEm: 'asc' },
  { id: 'asc' },
];

/**
 * Mensagens do chat interno (R15): histórico com rolagem nos dois sentidos,
 * envio com anexo, resposta, menções (notificam) e referências (viram links),
 * edição e exclusão das próprias, e a busca nos canais da pessoa.
 *
 * O conteúdo das mensagens não vai para a auditoria (as diretas são privadas —
 * nem o Admin lê): a própria mensagem guarda o histórico (`editadaEm`,
 * `excluidaEm`); a exclusão apaga o texto e remove o anexo (R11). A outbox
 * leva só ids (`chat_mensagem.*`) para o tempo real.
 */
@Injectable()
export class MensagensChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arquivos: ArquivosService,
    private readonly notificacoes: NotificacoesService,
    private readonly montagem: MontagemChatService,
    private readonly publicacao: PublicacaoChatService,
    private readonly canais: CanaisChatService,
    private readonly sincronizacao: SincronizacaoChatService,
  ) {}

  // -------------------------------------------------------------------------
  // Histórico
  // -------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    canalId: string,
    filtro: FiltroMensagensChatDto,
  ): Promise<PaginaChatMensagensDto> {
    await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
    await this.canais.exigirMembro(usuario.id, canalId);
    const cursores = [filtro.antesDe, filtro.depoisDe, filtro.aoRedorDe].filter(
      (valor) => valor !== undefined,
    );
    if (cursores.length > 1) {
      throw new DadosInvalidosException(
        'Use só um entre antesDe, depoisDe e aoRedorDe.',
      );
    }
    const limite = filtro.limite;
    const doCanal = (
      onde: Prisma.ChatMensagemWhereInput,
      orderBy: Prisma.ChatMensagemOrderByWithRelationInput[],
      quantas: number,
    ) =>
      this.prisma.chatMensagem.findMany({
        where: { canalId, ...onde },
        orderBy,
        take: quantas,
        include: INCLUIR_NA_MENSAGEM,
      });

    let itens: MensagemCompleta[];
    let temAnteriores: boolean;
    let temPosteriores: boolean;
    if (filtro.antesDe) {
      const posicao = await this.posicao(canalId, filtro.antesDe);
      const lote = await doCanal(
        antesDe(posicao),
        MAIS_NOVAS_PRIMEIRO,
        limite + 1,
      );
      temAnteriores = lote.length > limite;
      temPosteriores = true;
      itens = lote.slice(0, limite).reverse();
    } else if (filtro.depoisDe) {
      const posicao = await this.posicao(canalId, filtro.depoisDe);
      const lote = await doCanal(
        depoisDe(posicao),
        MAIS_ANTIGAS_PRIMEIRO,
        limite + 1,
      );
      temAnteriores = true;
      temPosteriores = lote.length > limite;
      itens = lote.slice(0, limite);
    } else if (filtro.aoRedorDe) {
      const centro = await this.prisma.chatMensagem.findFirst({
        where: { id: filtro.aoRedorDe, canalId },
        include: INCLUIR_NA_MENSAGEM,
      });
      if (!centro) {
        throw new NaoEncontradoException('Mensagem não encontrada.');
      }
      const quantasAntes = Math.floor((limite - 1) / 2);
      const quantasDepois = limite - 1 - quantasAntes;
      const [anteriores, posteriores] = await Promise.all([
        doCanal(antesDe(centro), MAIS_NOVAS_PRIMEIRO, quantasAntes + 1),
        doCanal(depoisDe(centro), MAIS_ANTIGAS_PRIMEIRO, quantasDepois + 1),
      ]);
      temAnteriores = anteriores.length > quantasAntes;
      temPosteriores = posteriores.length > quantasDepois;
      itens = [
        ...anteriores.slice(0, quantasAntes).reverse(),
        centro,
        ...posteriores.slice(0, quantasDepois),
      ];
    } else {
      const lote = await doCanal({}, MAIS_NOVAS_PRIMEIRO, limite + 1);
      temAnteriores = lote.length > limite;
      temPosteriores = false;
      itens = lote.slice(0, limite).reverse();
    }
    return {
      itens: await this.montagem.mensagens(itens),
      temAnteriores,
      temPosteriores,
    };
  }

  // -------------------------------------------------------------------------
  // Envio, edição e exclusão
  // -------------------------------------------------------------------------

  async enviar(
    usuario: UsuarioAutenticado,
    canalId: string,
    dto: EnviarMensagemChatDto,
  ): Promise<ChatMensagemDto> {
    const texto = normalizarTextoDaMensagem(dto.texto);
    if (!texto && !dto.arquivoId) {
      throw new DadosInvalidosException(
        'Escreva uma mensagem ou anexe um arquivo.',
        {
          campos: [{ campo: 'texto', mensagens: ['é obrigatório sem anexo'] }],
        },
      );
    }
    const marcacoes = this.exigirLimites(extrairMarcacoes(texto));
    // Canais padrão acompanham o papel atual (mudou de área agora há pouco?).
    await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
    await this.prepararMencionados(usuario.id, canalId, marcacoes.mencoes);

    const mensagem = await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.canais.exigirMembro(usuario.id, canalId, tx);
      await this.canais.exigirPodeEnviar(tx, canal, usuario.id);
      await this.exigirMencionaveis(tx, canalId, marcacoes.mencoes);
      await this.exigirReferenciaveis(tx, usuario, marcacoes.referencias);
      if (dto.arquivoId) {
        await this.exigirAnexo(tx, usuario.id, dto.arquivoId);
      }
      if (dto.respostaAId) {
        await this.exigirRespondivel(tx, canalId, dto.respostaAId);
      }
      const agora = new Date();
      const criada = await tx.chatMensagem.create({
        data: {
          canalId,
          autorId: usuario.id,
          texto,
          arquivoId: dto.arquivoId ?? null,
          mencoes: marcacoes.mencoes,
          referencias:
            marcacoes.referencias as unknown as Prisma.InputJsonValue,
          respostaAId: dto.respostaAId ?? null,
          criadoEm: agora,
        },
        include: INCLUIR_NA_MENSAGEM,
      });
      await tx.chatCanal.update({
        where: { id: canalId },
        data: { ultimaMensagemEm: agora },
      });
      // Quem escreve leu o canal até a própria mensagem.
      await tx.$executeRaw`
        UPDATE chat_membros
           SET ultima_leitura_em = ${agora}, atualizado_em = now()
         WHERE canal_id = ${canalId}::uuid AND usuario_id = ${usuario.id}::uuid
           AND (ultima_leitura_em IS NULL OR ultima_leitura_em < ${agora})`;
      const dtoDaMensagem = await this.montagem.mensagem(criada, tx);
      await this.notificarMencionados(
        tx,
        usuario,
        canal,
        dtoDaMensagem,
        marcacoes.mencoes,
      );
      await this.publicacao.mensagemCriada(tx, canalId, criada.id);
      return dtoDaMensagem;
    });
    return mensagem;
  }

  async editar(
    usuario: UsuarioAutenticado,
    mensagemId: string,
    dto: EditarMensagemChatDto,
  ): Promise<ChatMensagemDto> {
    const texto = normalizarTextoDaMensagem(dto.texto);
    const marcacoes = this.exigirLimites(extrairMarcacoes(texto));
    const original = await this.exigirPropria(usuario, mensagemId, 'editar');
    const novasMencoes = marcacoes.mencoes.filter(
      (id) => !original.mencoes.includes(id),
    );
    await this.prepararMencionados(usuario.id, original.canalId, novasMencoes);

    return this.prisma.$transaction(async (tx) => {
      const mensagem = await this.exigirPropria(
        usuario,
        mensagemId,
        'editar',
        tx,
      );
      if (mensagem.excluidaEm) {
        throw new RegraVioladaException(
          REGRAS_DO_CHAT.MENSAGENS,
          'A mensagem foi excluída e não pode ser editada.',
        );
      }
      const { canal } = await this.canais.exigirMembro(
        usuario.id,
        mensagem.canalId,
        tx,
      );
      await this.canais.exigirPodeEnviar(tx, canal, usuario.id);
      if (!texto && !mensagem.arquivoId) {
        throw new DadosInvalidosException(
          'A mensagem não pode ficar vazia: escreva algo ou exclua a mensagem.',
          {
            campos: [
              { campo: 'texto', mensagens: ['é obrigatório sem anexo'] },
            ],
          },
        );
      }
      if (texto === mensagem.texto) {
        return this.montagem.mensagem(mensagem, tx);
      }
      // Só o que é novo é conferido: menções e itens que já estavam ficam.
      const mencoesNovas = marcacoes.mencoes.filter(
        (id) => !mensagem.mencoes.includes(id),
      );
      const jaCitadas = new Set(
        lerReferencias(mensagem.referencias).map(
          ({ tipo, id }) => `${tipo}:${id}`,
        ),
      );
      await this.exigirMencionaveis(tx, mensagem.canalId, mencoesNovas);
      await this.exigirReferenciaveis(
        tx,
        usuario,
        marcacoes.referencias.filter(
          ({ tipo, id }) => !jaCitadas.has(`${tipo}:${id}`),
        ),
      );
      const editada = await tx.chatMensagem.update({
        where: { id: mensagem.id },
        data: {
          texto,
          mencoes: marcacoes.mencoes,
          referencias:
            marcacoes.referencias as unknown as Prisma.InputJsonValue,
          editadaEm: new Date(),
        },
        include: INCLUIR_NA_MENSAGEM,
      });
      const dtoDaMensagem = await this.montagem.mensagem(editada, tx);
      await this.notificarMencionados(
        tx,
        usuario,
        canal,
        dtoDaMensagem,
        mencoesNovas,
      );
      await this.publicacao.mensagemEditada(tx, mensagem.canalId, mensagem.id);
      return dtoDaMensagem;
    });
  }

  /** Exclui a própria mensagem: o texto é apagado e o anexo removido, para todos. */
  async excluir(
    usuario: UsuarioAutenticado,
    mensagemId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const mensagem = await this.exigirPropria(
        usuario,
        mensagemId,
        'excluir',
        tx,
      );
      if (mensagem.excluidaEm) {
        return;
      }
      await tx.chatMensagem.update({
        where: { id: mensagem.id },
        data: {
          excluidaEm: new Date(),
          texto: null,
          mencoes: [],
          referencias: [],
        },
      });
      if (mensagem.arquivoId) {
        await this.arquivos.remover(mensagem.arquivoId, {
          tx,
          motivo: 'mensagem do chat excluída pelo autor',
        });
      }
      await this.publicacao.mensagemExcluida(tx, mensagem.canalId, mensagem.id);
    });
  }

  // -------------------------------------------------------------------------
  // Busca
  // -------------------------------------------------------------------------

  /** Mensagens (não excluídas) dos canais de que a pessoa é membro, mais novas primeiro. */
  async buscar(
    usuario: UsuarioAutenticado,
    filtro: BuscaMensagensChatDto,
  ): Promise<Pagina<ResultadoBuscaChatDto>> {
    const termos = termosDaBusca(filtro.texto);
    const condicoes: Prisma.Sql[] = [
      Prisma.sql`m.excluida_em IS NULL`,
      Prisma.sql`m.autor_id IS NOT NULL`,
      Prisma.sql`m.texto IS NOT NULL`,
      Prisma.sql`EXISTS (
        SELECT 1 FROM chat_membros mb
         WHERE mb.canal_id = m.canal_id AND mb.usuario_id = ${usuario.id}::uuid
      )`,
      ...(filtro.canalId
        ? [Prisma.sql`m.canal_id = ${filtro.canalId}::uuid`]
        : []),
      ...(filtro.autorId
        ? [Prisma.sql`m.autor_id = ${filtro.autorId}::uuid`]
        : []),
      ...condicoesDeBusca([sqlTextoSemMarcacoes('m.texto')], termos),
    ];
    const onde = clausulaWhere(condicoes);
    const { skip, take } = paraSkipTake(filtro);
    const [linhas, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM chat_mensagens m ${onde}
         ORDER BY m.criado_em DESC, m.id DESC
         LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM chat_mensagens m ${onde}`,
    ]);
    const ids = linhas.map(({ id }) => id);
    if (ids.length === 0) {
      return montarPagina([], total, filtro);
    }
    const encontradas = await this.prisma.chatMensagem.findMany({
      where: { id: { in: ids } },
      include: INCLUIR_NA_MENSAGEM,
    });
    const porId = new Map(encontradas.map((m) => [m.id, m] as const));
    const ordenadas = ids.flatMap((id) => {
      const mensagem = porId.get(id);
      return mensagem ? [mensagem] : [];
    });
    const [dtos, canais] = await Promise.all([
      this.montagem.mensagens(ordenadas),
      this.montagem.canaisDoUsuario(usuario.id, {
        canalIds: [...new Set(ordenadas.map((m) => m.canalId))],
      }),
    ]);
    const canalPorId = new Map(canais.map((canal) => [canal.id, canal]));
    return montarPagina(
      dtos.flatMap((mensagem) => {
        const canal = canalPorId.get(mensagem.canalId);
        return canal
          ? [
              {
                mensagem,
                canal: { id: canal.id, tipo: canal.tipo, nome: canal.nome },
              },
            ]
          : [];
      }),
      total,
      filtro,
    );
  }

  // -------------------------------------------------------------------------
  // Regras
  // -------------------------------------------------------------------------

  private exigirLimites(marcacoes: Marcacoes): Marcacoes {
    if (marcacoes.mencoes.length > MAXIMO_DE_MENCOES) {
      throw new DadosInvalidosException(
        `Mencione no máximo ${MAXIMO_DE_MENCOES} pessoas por mensagem.`,
        { campos: [{ campo: 'texto', mensagens: ['menções demais'] }] },
      );
    }
    if (marcacoes.referencias.length > MAXIMO_DE_REFERENCIAS) {
      throw new DadosInvalidosException(
        `Cite no máximo ${MAXIMO_DE_REFERENCIAS} itens por mensagem.`,
        { campos: [{ campo: 'texto', mensagens: ['referências demais'] }] },
      );
    }
    return marcacoes;
  }

  /**
   * Nos canais padrão, quem é mencionado pode ainda não ter sido sincronizado
   * (usuário novo que nunca abriu o chat): sincroniza antes de conferir.
   */
  private async prepararMencionados(
    usuarioId: string,
    canalId: string,
    mencoes: readonly string[],
  ): Promise<void> {
    if (mencoes.length === 0) {
      return;
    }
    const { canal } = await this.canais.exigirMembro(usuarioId, canalId);
    if (canal.tipo === 'GERAL' || canal.tipo === 'AREA') {
      await this.sincronizacao.sincronizarSeNecessario(mencoes);
    }
  }

  /** R15.5: só dá para mencionar quem está no canal. */
  private async exigirMencionaveis(
    tx: Tx,
    canalId: string,
    mencoes: readonly string[],
  ): Promise<void> {
    if (mencoes.length === 0) {
      return;
    }
    const membros = await tx.chatMembro.findMany({
      where: { canalId, usuarioId: { in: [...mencoes] } },
      select: { usuarioId: true },
    });
    const presentes = new Set(membros.map(({ usuarioId }) => usuarioId));
    const fora = mencoes.filter((id) => !presentes.has(id));
    if (fora.length > 0) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.MENCOES,
        fora.length === 1
          ? 'A pessoa mencionada não está neste canal.'
          : 'Algumas pessoas mencionadas não estão neste canal.',
        { usuarioIds: fora },
      );
    }
  }

  /**
   * R15.6: só itens que existem — negócios que a pessoa vê (R5.9), contatos e
   * empresas não excluídos.
   */
  private async exigirReferenciaveis(
    tx: Tx,
    usuario: UsuarioAutenticado,
    referencias: readonly ReferenciaGuardada[],
  ): Promise<void> {
    if (referencias.length === 0) {
      return;
    }
    const ids = (tipo: ReferenciaGuardada['tipo']) =>
      referencias.filter((r) => r.tipo === tipo).map(({ id }) => id);
    const [negocios, contatos, empresas] = [
      ids('negocio'),
      ids('contato'),
      ids('empresa'),
    ];
    const validos = new Set<string>();
    if (negocios.length > 0) {
      const encontrados = await tx.negocio.findMany({
        where: { id: { in: negocios }, excluidoEm: null },
        select: {
          id: true,
          responsavelId: true,
          funil: { select: { area: true } },
        },
      });
      for (const negocio of encontrados) {
        if (podeVerNegocio(usuario, negocio)) {
          validos.add(`negocio:${negocio.id}`);
        }
      }
    }
    if (contatos.length > 0) {
      const encontrados = await tx.contato.findMany({
        where: { id: { in: contatos }, excluidoEm: null },
        select: { id: true },
      });
      for (const { id } of encontrados) {
        validos.add(`contato:${id}`);
      }
    }
    if (empresas.length > 0) {
      const encontrados = await tx.empresa.findMany({
        where: { id: { in: empresas }, excluidoEm: null },
        select: { id: true },
      });
      for (const { id } of encontrados) {
        validos.add(`empresa:${id}`);
      }
    }
    const invalidas = referencias.filter(
      ({ tipo, id }) => !validos.has(`${tipo}:${id}`),
    );
    if (invalidas.length > 0) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.REFERENCIAS,
        'Não dá para citar um item que não existe mais ou que você não pode ver.',
        { referencias: invalidas },
      );
    }
  }

  /** O anexo (R11): enviado por quem escreve, para o chat, e ainda não usado. */
  private async exigirAnexo(
    tx: Tx,
    usuarioId: string,
    arquivoId: string,
  ): Promise<void> {
    const arquivo = await tx.arquivo.findUnique({ where: { id: arquivoId } });
    if (!arquivo || arquivo.removidoEm || arquivo.criadoPorId !== usuarioId) {
      throw new NaoEncontradoException('Anexo não encontrado.');
    }
    if (arquivo.contexto !== 'CHAT') {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.MENSAGENS,
        'Este arquivo não foi enviado para o chat: anexe-o de novo pela conversa.',
        { contexto: arquivo.contexto },
      );
    }
    const usado = await tx.chatMensagem.findFirst({
      where: { arquivoId },
      select: { id: true },
    });
    if (usado) {
      throw new ConflitoException(
        'Este anexo já foi enviado em outra mensagem: anexe-o de novo.',
      );
    }
  }

  /** A mensagem respondida é do mesmo canal e não foi excluída. */
  private async exigirRespondivel(
    tx: Tx,
    canalId: string,
    respostaAId: string,
  ): Promise<void> {
    const original = await tx.chatMensagem.findFirst({
      where: { id: respostaAId, canalId },
      select: { excluidaEm: true },
    });
    if (!original) {
      throw new NaoEncontradoException(
        'A mensagem respondida não foi encontrada neste canal.',
      );
    }
    if (original.excluidaEm) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.MENSAGENS,
        'A mensagem respondida foi excluída.',
      );
    }
  }

  /**
   * A mensagem, de um canal de que a pessoa é membro (senão 404), escrita por
   * ela (senão 403 — avisos do sistema também não são editáveis).
   */
  private async exigirPropria(
    usuario: UsuarioAutenticado,
    mensagemId: string,
    acao: 'editar' | 'excluir',
    tx: Tx = this.prisma,
  ): Promise<MensagemCompleta> {
    const mensagem = await tx.chatMensagem.findUnique({
      where: { id: mensagemId },
      include: INCLUIR_NA_MENSAGEM,
    });
    if (!mensagem) {
      throw new NaoEncontradoException('Mensagem não encontrada.');
    }
    const membro = await tx.chatMembro.findUnique({
      where: {
        canalId_usuarioId: { canalId: mensagem.canalId, usuarioId: usuario.id },
      },
      select: { id: true },
    });
    if (!membro) {
      throw new NaoEncontradoException('Mensagem não encontrada.');
    }
    if (mensagem.autorId !== usuario.id) {
      throw new SemPermissaoException(
        `Só quem escreveu a mensagem pode ${acao}.`,
      );
    }
    return mensagem;
  }

  /** Notificação de menção (R15.5) para os mencionados ativos, menos o autor. */
  private async notificarMencionados(
    tx: Tx,
    usuario: UsuarioAutenticado,
    canal: ChatCanal,
    mensagem: ChatMensagemDto,
    mencoes: readonly string[],
  ): Promise<void> {
    const candidatos = mencoes.filter((id) => id !== usuario.id);
    if (candidatos.length === 0) {
      return;
    }
    const ativos = await tx.usuario.findMany({
      where: { id: { in: candidatos }, ativo: true },
      select: { id: true },
    });
    if (ativos.length === 0) {
      return;
    }
    const lugar = lugarDoCanal(canal);
    await this.notificacoes.notificarVarios(
      tx,
      ativos.map(({ id }) => id),
      {
        tipo: NOTIFICACAO_DE_MENCAO,
        titulo: `${usuario.nome} mencionou você ${lugar}`,
        texto:
          this.montagem.resumoDasPartes(
            mensagem.partes,
            mensagem.anexo?.nome ?? null,
          ) || null,
        link: linkDaMensagem(canal.id, mensagem.id),
        dados: { canalId: canal.id, mensagemId: mensagem.id },
      },
    );
  }

  /** Data e id de uma mensagem do canal (cursor); 404 se não é dele. */
  private async posicao(canalId: string, mensagemId: string): Promise<Posicao> {
    const mensagem = await this.prisma.chatMensagem.findFirst({
      where: { id: mensagemId, canalId },
      select: { id: true, criadoEm: true },
    });
    if (!mensagem) {
      throw new NaoEncontradoException('Mensagem não encontrada.');
    }
    return mensagem;
  }
}
