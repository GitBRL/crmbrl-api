import { Injectable } from '@nestjs/common';
import {
  clausulaWhere,
  condicoesDeBusca,
  termosDaBusca,
} from '../auditoria/consulta/consulta-comum';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import {
  type ChatCanal,
  type ChatMembro,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import type {
  AdicionarMembrosChatDto,
  AtualizarCanalChatDto,
  AtualizarMembroChatDto,
  CriarGrupoChatDto,
  FiltroCanaisChatDto,
  FiltroPessoasChatDto,
  IniciarDiretaChatDto,
  MarcarLeituraChatDto,
  PreferenciasDoCanalChatDto,
} from './dto/requisicoes.dto';
import type {
  ChatCanalDto,
  ChatMembroDto,
  ChatNaoLidasDto,
  ChatPessoaDto,
  ResultadoDiretaChatDto,
} from './dto/respostas.dto';
import { MontagemChatService } from './montagem-chat.service';
import { PublicacaoChatService } from './publicacao-chat.service';
import {
  chaveDaDireta,
  MAXIMO_DE_MEMBROS_DO_GRUPO,
  marcarMencao,
  REGRAS_DO_CHAT,
} from './regras-chat';
import { SincronizacaoChatService } from './sincronizacao-chat.service';
import { TempoRealChatService } from './tempo-real-chat.service';

/** A participação de quem pede e o canal. */
export interface Participacao {
  membro: ChatMembro;
  canal: ChatCanal;
}

/** Texto vazio (ou só espaços) vira `null`; `undefined` = não mexer. */
function textoOuNulo(
  valor: string | null | undefined,
): string | null | undefined {
  if (valor === undefined) {
    return undefined;
  }
  const aparado = valor?.trim() ?? '';
  return aparado === '' ? null : aparado;
}

function listaDeMencoes(usuarioIds: readonly string[]): string {
  const marcas = usuarioIds.map(marcarMencao);
  if (marcas.length <= 1) {
    return marcas.join('');
  }
  return `${marcas.slice(0, -1).join(', ')} e ${marcas[marcas.length - 1]}`;
}

/**
 * Canais do chat interno (R15): a lista de cada pessoa, grupos (criar,
 * renomear, pessoas, administradores, arquivar, sair), conversas diretas,
 * silenciar, marcar como lido, não lidas e o diretório de pessoas.
 *
 * Acesso: só membros enxergam um canal — para quem não é, ele não existe
 * (404), inclusive para o Admin (as diretas são privadas). Toda mudança de
 * estrutura (grupo criado, renomeado, pessoas, administradores, arquivamento,
 * direta iniciada) é auditada e vai para a outbox na mesma transação; leitura
 * e silenciamento são estados pessoais (sem auditoria, R3.1).
 */
@Injectable()
export class CanaisChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly montagem: MontagemChatService,
    private readonly publicacao: PublicacaoChatService,
    private readonly sincronizacao: SincronizacaoChatService,
    private readonly tempoReal: TempoRealChatService,
  ) {}

  // -------------------------------------------------------------------------
  // Acesso
  // -------------------------------------------------------------------------

  /** A participação de quem pede; 404 se não é membro (o canal "não existe"). */
  async exigirMembro(
    usuarioId: string,
    canalId: string,
    tx: Tx = this.prisma,
  ): Promise<Participacao> {
    const membro = await tx.chatMembro.findUnique({
      where: { canalId_usuarioId: { canalId, usuarioId } },
      include: { canal: true },
    });
    if (!membro) {
      throw new NaoEncontradoException('Canal não encontrado.');
    }
    const { canal, ...resto } = membro;
    return { membro: resto, canal };
  }

  /**
   * O canal aceita mensagens novas? Grupo arquivado e direta com pessoa
   * desligada ficam só para leitura (R15.2, R15.3).
   */
  async exigirPodeEnviar(
    tx: Tx,
    canal: ChatCanal,
    usuarioId: string,
  ): Promise<void> {
    if (canal.arquivadoEm) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.GRUPOS,
        'O grupo foi arquivado: as mensagens ficam só para leitura.',
      );
    }
    if (canal.tipo === 'DIRETO') {
      const outra = await tx.chatMembro.findFirst({
        where: { canalId: canal.id, usuarioId: { not: usuarioId } },
        select: { usuario: { select: { nome: true, ativo: true } } },
      });
      if (!outra || !outra.usuario.ativo) {
        throw new RegraVioladaException(
          REGRAS_DO_CHAT.DIRETAS,
          `${outra?.usuario.nome ?? 'A outra pessoa'} não está mais no CRM: a conversa fica só para leitura.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroCanaisChatDto,
  ): Promise<ChatCanalDto[]> {
    await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
    return this.montagem.canaisDoUsuario(usuario.id, {
      arquivados: filtro.arquivados,
    });
  }

  async obter(
    usuario: UsuarioAutenticado,
    canalId: string,
  ): Promise<ChatCanalDto> {
    await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
    return this.visao(usuario.id, canalId);
  }

  async membros(
    usuario: UsuarioAutenticado,
    canalId: string,
  ): Promise<ChatMembroDto[]> {
    await this.exigirMembro(usuario.id, canalId);
    return this.montagem.membros(canalId);
  }

  async naoLidas(usuario: UsuarioAutenticado): Promise<ChatNaoLidasDto> {
    await this.sincronizacao.sincronizarSeNecessario([usuario.id]);
    return this.montagem.naoLidas(usuario.id);
  }

  /**
   * Diretório do chat: as pessoas ativas do CRM (para criar grupo, iniciar
   * direta), por nome. Mostra só o que o chat mostra (nome, papel, foto,
   * presença) — todos se veem, como numa equipe.
   */
  async pessoas(filtro: FiltroPessoasChatDto): Promise<Pagina<ChatPessoaDto>> {
    const condicoes = [
      Prisma.sql`u.ativo`,
      ...condicoesDeBusca(['u.nome', 'u.email'], termosDaBusca(filtro.busca)),
    ];
    const onde = clausulaWhere(condicoes);
    const { skip, take } = paraSkipTake(filtro);
    const [linhas, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT u.id FROM usuarios u ${onde}
         ORDER BY lower(u.nome), u.id
         LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM usuarios u ${onde}`,
    ]);
    const ids = linhas.map(({ id }) => id);
    const pessoas = await this.montagem.pessoas(ids);
    return montarPagina(
      ids.flatMap((id) => {
        const pessoa = pessoas.get(id);
        return pessoa ? [pessoa] : [];
      }),
      total,
      filtro,
    );
  }

  // -------------------------------------------------------------------------
  // Grupos
  // -------------------------------------------------------------------------

  async criarGrupo(
    usuario: UsuarioAutenticado,
    dto: CriarGrupoChatDto,
  ): Promise<ChatCanalDto> {
    const outros = dto.membrosIds.filter((id) => id !== usuario.id);
    const canal = await this.prisma.$transaction(async (tx) => {
      await this.exigirUsuariosAtivos(tx, outros);
      const criado = await tx.chatCanal.create({
        data: {
          tipo: 'GRUPO',
          nome: dto.nome,
          descricao: textoOuNulo(dto.descricao) ?? null,
          criadoPorId: usuario.id,
          membros: {
            create: [
              { usuarioId: usuario.id, administrador: true },
              ...outros.map((usuarioId) => ({ usuarioId })),
            ],
          },
        },
      });
      await this.publicacao.aviso(
        tx,
        criado.id,
        `${marcarMencao(usuario.id)} criou o grupo.`,
      );
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.criado',
        entidade: 'chat_canal',
        entidadeId: criado.id,
        resumo: `Grupo "${criado.nome ?? ''}" criado no chat, com ${outros.length + 1} ${outros.length === 0 ? 'pessoa' : 'pessoas'}`,
        dados: {
          tipo: 'GRUPO',
          nome: criado.nome,
          membrosIds: [usuario.id, ...outros],
        },
      });
      await this.publicacao.canalAtualizado(tx, {
        canalId: criado.id,
        entraram: [usuario.id, ...outros],
      });
      return criado;
    });
    return this.visao(usuario.id, canal.id);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    canalId: string,
    dto: AtualizarCanalChatDto,
  ): Promise<ChatCanalDto> {
    await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.exigirGerente(
        tx,
        usuario,
        canalId,
        'mudar o nome ou a descrição',
      );
      const dados: Prisma.ChatCanalUpdateInput = {};
      if (dto.nome !== undefined && dto.nome !== canal.nome) {
        dados.nome = dto.nome;
      }
      const descricao = textoOuNulo(dto.descricao);
      if (descricao !== undefined && descricao !== canal.descricao) {
        dados.descricao = descricao;
      }
      if (Object.keys(dados).length === 0) {
        return;
      }
      const depois = await tx.chatCanal.update({
        where: { id: canalId },
        data: dados,
      });
      if (dados.nome !== undefined) {
        await this.publicacao.aviso(
          tx,
          canalId,
          `${marcarMencao(usuario.id)} renomeou o grupo para "${depois.nome ?? ''}".`,
        );
      }
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.atualizado',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo: `Grupo "${depois.nome ?? ''}" do chat atualizado`,
        dados: {
          alteracoes: calcularAlteracoes(canal, depois, ['nome', 'descricao']),
        },
      });
      await this.publicacao.canalAtualizado(tx, { canalId });
    });
    return this.visao(usuario.id, canalId);
  }

  /** Arquiva (só leitura) ou desarquiva o grupo. */
  async arquivar(
    usuario: UsuarioAutenticado,
    canalId: string,
    arquivar: boolean,
  ): Promise<ChatCanalDto> {
    await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.exigirGerente(
        tx,
        usuario,
        canalId,
        arquivar ? 'arquivar o grupo' : 'desarquivar o grupo',
        { permitirArquivado: true },
      );
      if (Boolean(canal.arquivadoEm) === arquivar) {
        return;
      }
      if (!arquivar) {
        await tx.chatCanal.update({
          where: { id: canalId },
          data: { arquivadoEm: null },
        });
      }
      await this.publicacao.aviso(
        tx,
        canalId,
        `${marcarMencao(usuario.id)} ${arquivar ? 'arquivou' : 'desarquivou'} o grupo.`,
      );
      if (arquivar) {
        // Depois do aviso, para ele ser a última mensagem do grupo aberto.
        await tx.chatCanal.update({
          where: { id: canalId },
          data: { arquivadoEm: new Date() },
        });
      }
      await this.auditoria.registrar(tx, {
        acao: arquivar ? 'chat_canal.arquivado' : 'chat_canal.desarquivado',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo: `Grupo "${canal.nome ?? ''}" do chat ${arquivar ? 'arquivado' : 'desarquivado'}`,
      });
      await this.publicacao.canalAtualizado(tx, { canalId });
    });
    return this.visao(usuario.id, canalId);
  }

  /** Sai do grupo. Sem administrador, o membro mais antigo assume; vazio, o grupo é arquivado. */
  async sair(usuario: UsuarioAutenticado, canalId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.travarCanal(tx, canalId);
      const { canal } = await this.exigirMembro(usuario.id, canalId, tx);
      this.exigirGrupo(canal, 'sair');
      await tx.chatMembro.delete({
        where: { canalId_usuarioId: { canalId, usuarioId: usuario.id } },
      });
      const restantes = await tx.chatMembro.findMany({
        where: { canalId },
        orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
        select: { usuarioId: true, administrador: true },
      });
      let novoAdministrador: string | null = null;
      if (
        restantes.length > 0 &&
        !restantes.some((membro) => membro.administrador)
      ) {
        novoAdministrador = restantes[0].usuarioId;
        await tx.chatMembro.update({
          where: {
            canalId_usuarioId: { canalId, usuarioId: novoAdministrador },
          },
          data: { administrador: true },
        });
      }
      await this.publicacao.aviso(
        tx,
        canalId,
        `${marcarMencao(usuario.id)} saiu do grupo.` +
          (novoAdministrador
            ? ` ${marcarMencao(novoAdministrador)} passou a administrar o grupo.`
            : ''),
      );
      const arquivado = restantes.length === 0 && !canal.arquivadoEm;
      if (arquivado) {
        await tx.chatCanal.update({
          where: { id: canalId },
          data: { arquivadoEm: new Date() },
        });
      }
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.membro_saiu',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo:
          `${usuario.nome} saiu do grupo "${canal.nome ?? ''}" do chat` +
          (arquivado ? ' (o grupo ficou vazio e foi arquivado)' : ''),
        dados: { novoAdministradorId: novoAdministrador, arquivado },
        relacionados: { usuario: usuario.id },
      });
      await this.publicacao.canalAtualizado(tx, {
        canalId,
        sairam: [usuario.id],
      });
    });
  }

  async adicionarMembros(
    usuario: UsuarioAutenticado,
    canalId: string,
    dto: AdicionarMembrosChatDto,
  ): Promise<ChatMembroDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.exigirGerente(
        tx,
        usuario,
        canalId,
        'adicionar pessoas',
      );
      const atuais = await tx.chatMembro.findMany({
        where: { canalId },
        select: { usuarioId: true },
      });
      const jaEstao = new Set(atuais.map(({ usuarioId }) => usuarioId));
      const novos = dto.usuariosIds.filter((id) => !jaEstao.has(id));
      if (novos.length === 0) {
        return;
      }
      if (atuais.length + novos.length > MAXIMO_DE_MEMBROS_DO_GRUPO) {
        throw new RegraVioladaException(
          REGRAS_DO_CHAT.GRUPOS,
          `Um grupo pode ter até ${MAXIMO_DE_MEMBROS_DO_GRUPO} pessoas: este já tem ${atuais.length}.`,
          { maximo: MAXIMO_DE_MEMBROS_DO_GRUPO, atuais: atuais.length },
        );
      }
      await this.exigirUsuariosAtivos(tx, novos);
      await tx.chatMembro.createMany({
        data: novos.map((usuarioId) => ({ canalId, usuarioId })),
        skipDuplicates: true,
      });
      await this.publicacao.aviso(
        tx,
        canalId,
        `${marcarMencao(usuario.id)} adicionou ${listaDeMencoes(novos)}.`,
      );
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.membros_adicionados',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo: `${novos.length === 1 ? '1 pessoa adicionada' : `${novos.length} pessoas adicionadas`} ao grupo "${canal.nome ?? ''}" do chat`,
        dados: { usuarioIds: novos },
      });
      await this.publicacao.canalAtualizado(tx, {
        canalId,
        entraram: novos,
      });
    });
    return this.montagem.membros(canalId);
  }

  async removerMembro(
    usuario: UsuarioAutenticado,
    canalId: string,
    alvoId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.exigirGerente(
        tx,
        usuario,
        canalId,
        'tirar pessoas',
      );
      if (alvoId === usuario.id) {
        throw new RegraVioladaException(
          REGRAS_DO_CHAT.GRUPOS,
          'Para sair do grupo, use a opção "Sair do grupo".',
        );
      }
      const alvo = await this.exigirAlvo(tx, canalId, alvoId);
      await tx.chatMembro.delete({ where: { id: alvo.id } });
      await this.publicacao.aviso(
        tx,
        canalId,
        `${marcarMencao(usuario.id)} removeu ${marcarMencao(alvoId)} do grupo.`,
      );
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.membro_removido',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo: `${alvo.usuario.nome} removido(a) do grupo "${canal.nome ?? ''}" do chat`,
        dados: { usuarioId: alvoId, eraAdministrador: alvo.administrador },
        relacionados: { usuario: alvoId },
      });
      await this.publicacao.canalAtualizado(tx, {
        canalId,
        sairam: [alvoId],
      });
    });
  }

  async alterarMembro(
    usuario: UsuarioAutenticado,
    canalId: string,
    alvoId: string,
    dto: AtualizarMembroChatDto,
  ): Promise<ChatMembroDto> {
    await this.prisma.$transaction(async (tx) => {
      const { canal } = await this.exigirGerente(
        tx,
        usuario,
        canalId,
        'mudar quem administra',
      );
      const alvo = await this.exigirAlvo(tx, canalId, alvoId);
      if (alvo.administrador === dto.administrador) {
        return;
      }
      if (!dto.administrador) {
        const administradores = await tx.chatMembro.count({
          where: { canalId, administrador: true },
        });
        if (administradores <= 1) {
          throw new RegraVioladaException(
            REGRAS_DO_CHAT.GRUPOS,
            'O grupo precisa de pelo menos uma pessoa administrando: escolha outra antes.',
          );
        }
      }
      await tx.chatMembro.update({
        where: { id: alvo.id },
        data: { administrador: dto.administrador },
      });
      await this.publicacao.aviso(
        tx,
        canalId,
        dto.administrador
          ? `${marcarMencao(usuario.id)} deu a ${marcarMencao(alvoId)} a administração do grupo.`
          : `${marcarMencao(alvoId)} deixou de administrar o grupo.`,
      );
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.administrador_alterado',
        entidade: 'chat_canal',
        entidadeId: canalId,
        resumo: `${alvo.usuario.nome} ${dto.administrador ? 'passou a administrar' : 'deixou de administrar'} o grupo "${canal.nome ?? ''}" do chat`,
        dados: {
          usuarioId: alvoId,
          alteracoes: {
            administrador: {
              antes: alvo.administrador,
              depois: dto.administrador,
            },
          },
        },
        relacionados: { usuario: alvoId },
      });
      await this.publicacao.canalAtualizado(tx, { canalId });
    });
    const membros = await this.montagem.membros(canalId);
    const membro = membros.find((item) => item.usuario.id === alvoId);
    if (!membro) {
      throw new NaoEncontradoException('A pessoa não está no grupo.');
    }
    return membro;
  }

  // -------------------------------------------------------------------------
  // Diretas
  // -------------------------------------------------------------------------

  /** Abre (ou cria) a conversa direta com outra pessoa (R15.3). */
  async iniciarDireta(
    usuario: UsuarioAutenticado,
    dto: IniciarDiretaChatDto,
  ): Promise<ResultadoDiretaChatDto> {
    if (dto.usuarioId === usuario.id) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.DIRETAS,
        'Escolha outra pessoa para conversar.',
      );
    }
    const chave = chaveDaDireta(usuario.id, dto.usuarioId);
    const { canalId, criada } = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'chat-direta', chave);
      const existente = await tx.chatCanal.findUnique({
        where: { chave },
        select: { id: true },
      });
      if (existente) {
        return { canalId: existente.id, criada: false };
      }
      const outra = await tx.usuario.findUnique({
        where: { id: dto.usuarioId },
        select: { id: true, nome: true, ativo: true },
      });
      if (!outra) {
        throw new NaoEncontradoException('Pessoa não encontrada.');
      }
      if (!outra.ativo) {
        throw new RegraVioladaException(
          REGRAS_DO_CHAT.DIRETAS,
          `${outra.nome} não está mais no CRM.`,
        );
      }
      const canal = await tx.chatCanal.create({
        data: {
          tipo: 'DIRETO',
          chave,
          nome: null,
          criadoPorId: usuario.id,
          membros: {
            create: [{ usuarioId: usuario.id }, { usuarioId: outra.id }],
          },
        },
      });
      // Só quem e quando: o conteúdo das diretas é privado (nem o Admin lê).
      await this.auditoria.registrar(tx, {
        acao: 'chat_canal.criado',
        entidade: 'chat_canal',
        entidadeId: canal.id,
        resumo: `Conversa direta iniciada no chat por ${usuario.nome}`,
        dados: { tipo: 'DIRETO', participantes: [usuario.id, outra.id] },
      });
      await this.publicacao.canalAtualizado(tx, {
        canalId: canal.id,
        entraram: [usuario.id, outra.id],
      });
      return { canalId: canal.id, criada: true };
    });
    return { criada, canal: await this.visao(usuario.id, canalId) };
  }

  // -------------------------------------------------------------------------
  // Estados pessoais
  // -------------------------------------------------------------------------

  async definirPreferencias(
    usuario: UsuarioAutenticado,
    canalId: string,
    dto: PreferenciasDoCanalChatDto,
  ): Promise<ChatCanalDto> {
    const { membro } = await this.exigirMembro(usuario.id, canalId);
    if (membro.silenciado !== dto.silenciado) {
      await this.prisma.chatMembro.update({
        where: { id: membro.id },
        data: { silenciado: dto.silenciado },
      });
      await this.tempoReal.atualizarParaUsuario(usuario.id, canalId);
    }
    return this.visao(usuario.id, canalId);
  }

  /**
   * Marca como lido até a mensagem informada (ou até agora). Nunca volta: ler
   * uma mensagem antiga não desmarca as mais novas.
   */
  async marcarLeitura(
    usuario: UsuarioAutenticado,
    canalId: string,
    dto: MarcarLeituraChatDto,
  ): Promise<ChatCanalDto> {
    const { membro } = await this.exigirMembro(usuario.id, canalId);
    let ate = new Date();
    if (dto.mensagemId) {
      const mensagem = await this.prisma.chatMensagem.findFirst({
        where: { id: dto.mensagemId, canalId },
        select: { criadoEm: true },
      });
      if (!mensagem) {
        throw new NaoEncontradoException('Mensagem não encontrada.');
      }
      ate = mensagem.criadoEm;
    }
    const alteradas = await this.prisma.$executeRaw`
      UPDATE chat_membros
         SET ultima_leitura_em = ${ate}, atualizado_em = now()
       WHERE id = ${membro.id}::uuid
         AND (ultima_leitura_em IS NULL OR ultima_leitura_em < ${ate})`;
    if (alteradas > 0) {
      await this.tempoReal.atualizarParaUsuario(usuario.id, canalId);
    }
    return this.visao(usuario.id, canalId);
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /** O canal do ponto de vista da pessoa (404 se ela não é membro). */
  private async visao(
    usuarioId: string,
    canalId: string,
  ): Promise<ChatCanalDto> {
    const [canal] = await this.montagem.canaisDoUsuario(usuarioId, {
      canalIds: [canalId],
    });
    if (!canal) {
      throw new NaoEncontradoException('Canal não encontrado.');
    }
    return canal;
  }

  /** Trava a linha do canal até o fim da transação (mudanças de membros em paralelo). */
  private async travarCanal(tx: Tx, canalId: string): Promise<void> {
    // NO KEY UPDATE: não segura quem só grava mensagens no canal (a chave
    // estrangeira pede KEY SHARE), mas serializa as mudanças de pessoas.
    await tx.$queryRaw`SELECT id FROM chat_canais WHERE id = ${canalId}::uuid FOR NO KEY UPDATE`;
  }

  /** Só grupos têm nome, pessoas e administradores mexíveis. */
  private exigirGrupo(canal: ChatCanal, acao: string): void {
    if (canal.tipo === 'GERAL' || canal.tipo === 'AREA') {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.CANAIS_PADRAO,
        acao === 'sair'
          ? `Não dá para sair do canal ${canal.nome ?? ''}: ele acompanha o seu papel no CRM. Silencie o canal se não quiser acompanhá-lo.`
          : `O canal ${canal.nome ?? ''} é mantido pelo sistema: não dá para ${acao}.`,
      );
    }
    if (canal.tipo === 'DIRETO') {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.DIRETAS,
        acao === 'sair'
          ? 'Não dá para sair de uma conversa direta. Silencie a conversa se não quiser acompanhá-la.'
          : `Conversas diretas são só entre duas pessoas: não dá para ${acao}.`,
      );
    }
  }

  /** Membro administrador de um grupo (não arquivado, salvo para desarquivar). */
  private async exigirGerente(
    tx: Tx,
    usuario: UsuarioAutenticado,
    canalId: string,
    acao: string,
    opcoes: { permitirArquivado?: boolean } = {},
  ): Promise<Participacao> {
    await this.travarCanal(tx, canalId);
    const participacao = await this.exigirMembro(usuario.id, canalId, tx);
    this.exigirGrupo(participacao.canal, acao);
    if (!participacao.membro.administrador) {
      throw new SemPermissaoException(
        `Só quem administra o grupo pode ${acao}.`,
      );
    }
    if (participacao.canal.arquivadoEm && !opcoes.permitirArquivado) {
      throw new RegraVioladaException(
        REGRAS_DO_CHAT.GRUPOS,
        `O grupo está arquivado: desarquive-o para ${acao}.`,
      );
    }
    return participacao;
  }

  private async exigirAlvo(
    tx: Tx,
    canalId: string,
    usuarioId: string,
  ): Promise<ChatMembro & { usuario: { nome: string } }> {
    const alvo = await tx.chatMembro.findUnique({
      where: { canalId_usuarioId: { canalId, usuarioId } },
      include: { usuario: { select: { nome: true } } },
    });
    if (!alvo) {
      throw new NaoEncontradoException('A pessoa não está no grupo.');
    }
    return alvo;
  }

  /** Todos existem e estão ativos (409 lista quem não está). */
  private async exigirUsuariosAtivos(
    tx: Tx,
    usuarioIds: readonly string[],
  ): Promise<void> {
    if (usuarioIds.length === 0) {
      return;
    }
    const encontrados = await tx.usuario.findMany({
      where: { id: { in: [...usuarioIds] } },
      select: { id: true, nome: true, ativo: true },
    });
    const ativos = new Set(
      encontrados.filter((u) => u.ativo).map(({ id }) => id),
    );
    const faltando = usuarioIds.filter((id) => !ativos.has(id));
    if (faltando.length > 0) {
      const nomes = encontrados.filter((u) => !u.ativo).map(({ nome }) => nome);
      throw new ConflitoException(
        nomes.length > 0
          ? `Só pessoas ativas no CRM podem entrar no grupo (${nomes.join(', ')} não ${nomes.length > 1 ? 'estão' : 'está'}).`
          : 'Algumas pessoas escolhidas não existem mais no CRM.',
        { usuarioIds: faltando },
      );
    }
  }
}
