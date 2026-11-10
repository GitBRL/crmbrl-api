import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { rotuloDoPapel, setorDaPessoa } from '../comum/dominio/papeis';
import { linkDoNegocio } from '../funis/motor-de-negocios.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import type {
  ChatCanalDto,
  ChatMembroDto,
  ChatMensagemDto,
  ChatNaoLidasDto,
  ChatParteDto,
  ChatPessoaDto,
  ChatReferenciaDto,
  ChatUltimaMensagemDto,
} from './dto/respostas.dto';
import {
  dividirTexto,
  lerReferencias,
  type ReferenciaGuardada,
  resumir,
} from './regras-chat';

/** O que a montagem de uma mensagem precisa carregar junto. */
export const INCLUIR_NA_MENSAGEM = {
  arquivo: true,
  respostaA: {
    select: {
      id: true,
      autorId: true,
      texto: true,
      excluidaEm: true,
      arquivo: { select: { nome: true, removidoEm: true } },
    },
  },
} satisfies Prisma.ChatMensagemInclude;

export type MensagemCompleta = Prisma.ChatMensagemGetPayload<{
  include: typeof INCLUIR_NA_MENSAGEM;
}>;

/** Campos do usuário que o chat mostra. */
const CAMPOS_DA_PESSOA = {
  id: true,
  nome: true,
  avatarUrl: true,
  papel: true,
  area: true,
  ativo: true,
} satisfies Prisma.UsuarioSelect;

type PessoaDoBanco = Prisma.UsuarioGetPayload<{
  select: typeof CAMPOS_DA_PESSOA;
}>;

/** Contagem de não lidas de um membro num canal. */
interface ContagemDoMembro {
  canalId: string;
  usuarioId: string;
  naoLidas: number;
  mencoes: number;
}

const MENSAGEM_EXCLUIDA = 'Mensagem excluída';

/** Quem está conectado agora (presença), lido uma vez por montagem. */
type Presenca = ReadonlySet<string>;

/**
 * Monta os DTOs do chat (mensagens, canais do ponto de vista de cada pessoa,
 * membros, não lidas), resolvendo em poucas consultas as menções, referências,
 * autores, anexos e a presença.
 */
@Injectable()
export class MontagemChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tempoReal: TempoRealService,
  ) {}

  // -------------------------------------------------------------------------
  // Pessoas
  // -------------------------------------------------------------------------

  /** Quem está com o CRM aberto agora (tempo real conectado nesta instância). */
  async presenca(): Promise<Presenca> {
    return new Set(await this.tempoReal.usuariosConectados());
  }

  private pessoa(usuario: PessoaDoBanco, presenca: Presenca): ChatPessoaDto {
    return {
      id: usuario.id,
      nome: usuario.nome,
      avatarUrl: usuario.avatarUrl,
      papel: usuario.papel,
      rotuloPapel: rotuloDoPapel(usuario.papel, usuario.area),
      area: setorDaPessoa(usuario),
      ativo: usuario.ativo,
      online: usuario.ativo && presenca.has(usuario.id),
    };
  }

  async pessoas(
    ids: Iterable<string>,
    presenca?: Presenca,
    tx: Tx = this.prisma,
  ): Promise<Map<string, ChatPessoaDto>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) {
      return new Map();
    }
    const quem = presenca ?? (await this.presenca());
    const usuarios = await tx.usuario.findMany({
      where: { id: { in: unicos } },
      select: CAMPOS_DA_PESSOA,
    });
    return new Map(usuarios.map((u) => [u.id, this.pessoa(u, quem)]));
  }

  // -------------------------------------------------------------------------
  // Mensagens
  // -------------------------------------------------------------------------

  async mensagem(
    mensagem: MensagemCompleta,
    tx: Tx = this.prisma,
  ): Promise<ChatMensagemDto> {
    const [dto] = await this.mensagens([mensagem], tx);
    return dto;
  }

  async mensagens(
    mensagens: readonly MensagemCompleta[],
    tx: Tx = this.prisma,
    presenca?: Presenca,
  ): Promise<ChatMensagemDto[]> {
    if (mensagens.length === 0) {
      return [];
    }
    const usuarioIds = new Set<string>();
    const referencias: ReferenciaGuardada[] = [];
    for (const mensagem of mensagens) {
      if (mensagem.autorId) {
        usuarioIds.add(mensagem.autorId);
      }
      if (mensagem.respostaA?.autorId) {
        usuarioIds.add(mensagem.respostaA.autorId);
      }
      const textos: Array<string | null> = [];
      if (!mensagem.excluidaEm) {
        textos.push(mensagem.texto);
        referencias.push(...lerReferencias(mensagem.referencias));
      }
      if (mensagem.respostaA && !mensagem.respostaA.excluidaEm) {
        textos.push(mensagem.respostaA.texto);
      }
      for (const pedaco of textos.flatMap((texto) => dividirTexto(texto))) {
        if (pedaco.tipo === 'mencao') {
          usuarioIds.add(pedaco.usuarioId);
        } else if (pedaco.tipo === 'referencia') {
          referencias.push(pedaco.referencia);
        }
      }
    }
    const [pessoas, itens] = await this.juntos(
      tx,
      () => this.pessoas(usuarioIds, presenca, tx),
      () => this.resolverReferencias(referencias, tx),
    );
    return mensagens.map((mensagem) =>
      this.montarMensagem(mensagem, pessoas, itens),
    );
  }

  private montarMensagem(
    mensagem: MensagemCompleta,
    pessoas: ReadonlyMap<string, ChatPessoaDto>,
    itens: ReadonlyMap<string, ChatReferenciaDto>,
  ): ChatMensagemDto {
    const excluida = mensagem.excluidaEm !== null;
    const anexoValido =
      !excluida && mensagem.arquivo && !mensagem.arquivo.removidoEm
        ? mensagem.arquivo
        : null;
    const resposta = mensagem.respostaA;
    return {
      id: mensagem.id,
      canalId: mensagem.canalId,
      autor: mensagem.autorId ? (pessoas.get(mensagem.autorId) ?? null) : null,
      sistema: mensagem.autorId === null,
      texto: excluida ? null : mensagem.texto,
      partes: excluida ? [] : this.partes(mensagem.texto, pessoas, itens),
      anexo: anexoValido ? ArquivoDto.de(anexoValido) : null,
      mencoes: excluida ? [] : [...mensagem.mencoes],
      referencias: excluida
        ? []
        : lerReferencias(mensagem.referencias).map((referencia) =>
            this.referencia(referencia, itens),
          ),
      respostaA: resposta
        ? {
            id: resposta.id,
            autor: resposta.autorId
              ? (pessoas.get(resposta.autorId)?.nome ?? null)
              : null,
            resumo: resposta.excluidaEm
              ? MENSAGEM_EXCLUIDA
              : this.resumoDasPartes(
                  this.partes(resposta.texto, pessoas, itens),
                  resposta.arquivo && !resposta.arquivo.removidoEm
                    ? resposta.arquivo.nome
                    : null,
                ),
            anexoNome:
              !resposta.excluidaEm &&
              resposta.arquivo &&
              !resposta.arquivo.removidoEm
                ? resposta.arquivo.nome
                : null,
            excluida: resposta.excluidaEm !== null,
          }
        : null,
      editadaEm: mensagem.editadaEm?.toISOString() ?? null,
      excluida,
      excluidaEm: mensagem.excluidaEm?.toISOString() ?? null,
      criadaEm: mensagem.criadoEm.toISOString(),
    };
  }

  /** O texto em pedaços, com nomes e títulos resolvidos. */
  partes(
    texto: string | null,
    pessoas: ReadonlyMap<string, ChatPessoaDto>,
    itens: ReadonlyMap<string, ChatReferenciaDto>,
  ): ChatParteDto[] {
    return dividirTexto(texto).map((pedaco): ChatParteDto => {
      if (pedaco.tipo === 'texto') {
        return { tipo: 'texto', texto: pedaco.texto };
      }
      if (pedaco.tipo === 'mencao') {
        const nome = pessoas.get(pedaco.usuarioId)?.nome;
        return {
          tipo: 'mencao',
          texto: `@${nome ?? 'pessoa removida'}`,
          usuarioId: pedaco.usuarioId,
        };
      }
      const referencia = this.referencia(pedaco.referencia, itens);
      return {
        tipo: 'referencia',
        texto: referencia.titulo ?? 'item indisponível',
        referencia,
      };
    });
  }

  /** Resumo de uma mensagem para prévias e notificações. */
  resumoDasPartes(
    partes: readonly ChatParteDto[],
    anexoNome: string | null,
  ): string {
    const texto = resumir(partes.map((parte) => parte.texto).join(''));
    if (texto !== '') {
      return texto;
    }
    return anexoNome ? resumir(`Anexo: ${anexoNome}`) : '';
  }

  private referencia(
    referencia: ReferenciaGuardada,
    itens: ReadonlyMap<string, ChatReferenciaDto>,
  ): ChatReferenciaDto {
    return (
      itens.get(`${referencia.tipo}:${referencia.id}`) ?? {
        tipo: referencia.tipo,
        id: referencia.id,
        titulo: null,
        link: null,
        disponivel: false,
      }
    );
  }

  /** Títulos e links dos itens citados (negócios, contatos, empresas). */
  private async resolverReferencias(
    referencias: readonly ReferenciaGuardada[],
    tx: Tx = this.prisma,
  ): Promise<Map<string, ChatReferenciaDto>> {
    const porTipo = {
      negocio: new Set<string>(),
      contato: new Set<string>(),
      empresa: new Set<string>(),
    };
    for (const { tipo, id } of referencias) {
      porTipo[tipo].add(id);
    }
    const [negocios, contatos, empresas] = await this.juntos(
      tx,
      () =>
        porTipo.negocio.size > 0
          ? tx.negocio.findMany({
              where: { id: { in: [...porTipo.negocio] } },
              select: {
                id: true,
                titulo: true,
                funilId: true,
                excluidoEm: true,
              },
            })
          : Promise.resolve([]),
      () =>
        porTipo.contato.size > 0
          ? tx.contato.findMany({
              where: { id: { in: [...porTipo.contato] } },
              select: { id: true, nome: true, excluidoEm: true },
            })
          : Promise.resolve([]),
      () =>
        porTipo.empresa.size > 0
          ? tx.empresa.findMany({
              where: { id: { in: [...porTipo.empresa] } },
              select: { id: true, nome: true, excluidoEm: true },
            })
          : Promise.resolve([]),
    );
    const mapa = new Map<string, ChatReferenciaDto>();
    for (const negocio of negocios) {
      const disponivel = negocio.excluidoEm === null;
      mapa.set(`negocio:${negocio.id}`, {
        tipo: 'negocio',
        id: negocio.id,
        titulo: disponivel ? negocio.titulo : null,
        link: disponivel ? linkDoNegocio(negocio) : null,
        disponivel,
      });
    }
    for (const contato of contatos) {
      const disponivel = contato.excluidoEm === null;
      mapa.set(`contato:${contato.id}`, {
        tipo: 'contato',
        id: contato.id,
        titulo: disponivel ? contato.nome : null,
        link: disponivel ? `/contatos/${contato.id}` : null,
        disponivel,
      });
    }
    for (const empresa of empresas) {
      const disponivel = empresa.excluidoEm === null;
      mapa.set(`empresa:${empresa.id}`, {
        tipo: 'empresa',
        id: empresa.id,
        titulo: disponivel ? empresa.nome : null,
        link: disponivel ? `/empresas/${empresa.id}` : null,
        disponivel,
      });
    }
    return mapa;
  }

  // -------------------------------------------------------------------------
  // Canais
  // -------------------------------------------------------------------------

  /** Os canais de uma pessoa (todos, ou só `canalIds`), na ordem da lista. */
  async canaisDoUsuario(
    usuarioId: string,
    opcoes: { canalIds?: readonly string[]; arquivados?: boolean } = {},
    tx: Tx = this.prisma,
  ): Promise<ChatCanalDto[]> {
    const membros = await tx.chatMembro.findMany({
      where: {
        usuarioId,
        ...(opcoes.canalIds ? { canalId: { in: [...opcoes.canalIds] } } : {}),
        ...(opcoes.arquivados === false
          ? { canal: { arquivadoEm: null } }
          : {}),
      },
    });
    if (membros.length === 0) {
      return [];
    }
    const canalIds = membros.map((membro) => membro.canalId);
    const [bases, contagens] = await this.juntos(
      tx,
      () => this.basesDosCanais(canalIds, tx),
      () => this.contarNaoLidas({ usuarioId }, tx),
    );
    const dtos: ChatCanalDto[] = [];
    for (const membro of membros) {
      const base = bases.get(membro.canalId);
      if (base) {
        dtos.push(
          this.montarCanal(
            base,
            membro,
            contagens.get(chaveDaContagem(membro.canalId, usuarioId)),
          ),
        );
      }
    }
    return dtos.sort(compararCanais);
  }

  /** Um canal do ponto de vista de cada uma das pessoas (só as que são membros). */
  async canalParaMembros(
    canalId: string,
    usuarioIds: readonly string[],
    tx: Tx = this.prisma,
  ): Promise<Map<string, ChatCanalDto>> {
    const resultado = new Map<string, ChatCanalDto>();
    if (usuarioIds.length === 0) {
      return resultado;
    }
    const membros = await tx.chatMembro.findMany({
      where: { canalId, usuarioId: { in: [...usuarioIds] } },
    });
    if (membros.length === 0) {
      return resultado;
    }
    const [bases, contagens] = await this.juntos(
      tx,
      () => this.basesDosCanais([canalId], tx),
      () =>
        this.contarNaoLidas(
          { canalId, usuarioIds: membros.map((m) => m.usuarioId) },
          tx,
        ),
    );
    const base = bases.get(canalId);
    if (!base) {
      return resultado;
    }
    for (const membro of membros) {
      resultado.set(
        membro.usuarioId,
        this.montarCanal(
          base,
          membro,
          contagens.get(chaveDaContagem(canalId, membro.usuarioId)),
        ),
      );
    }
    return resultado;
  }

  /** Membros de um canal, com o administrador primeiro e depois por nome. */
  async membros(
    canalId: string,
    tx: Tx = this.prisma,
  ): Promise<ChatMembroDto[]> {
    const [membros, presenca] = await this.juntos(
      tx,
      () =>
        tx.chatMembro.findMany({
          where: { canalId },
          include: { usuario: { select: CAMPOS_DA_PESSOA } },
        }),
      () => this.presenca(),
    );
    return membros
      .map((membro): ChatMembroDto => ({
        usuario: this.pessoa(membro.usuario, presenca),
        administrador: membro.administrador,
        automatico: membro.automatico,
        entrouEm: membro.criadoEm.toISOString(),
      }))
      .sort(
        (a, b) =>
          Number(b.administrador) - Number(a.administrador) ||
          a.usuario.nome.localeCompare(b.usuario.nome, 'pt-BR'),
      );
  }

  // -------------------------------------------------------------------------
  // Não lidas
  // -------------------------------------------------------------------------

  /** As não lidas de uma pessoa: total do menu e por canal (só os com alguma). */
  async naoLidas(
    usuarioId: string,
    tx: Tx = this.prisma,
  ): Promise<ChatNaoLidasDto> {
    const linhas = await tx.$queryRaw<
      {
        canalId: string;
        naoLidas: number;
        mencoes: number;
        silenciado: boolean;
        arquivado: boolean;
      }[]
    >`
      SELECT mb.canal_id AS "canalId",
             count(msg.id)::int AS "naoLidas",
             count(msg.id) FILTER (WHERE mb.usuario_id = ANY(msg.mencoes))::int AS "mencoes",
             mb.silenciado AS "silenciado",
             (c.arquivado_em IS NOT NULL) AS "arquivado"
        FROM chat_membros mb
        JOIN chat_canais c ON c.id = mb.canal_id
        JOIN chat_mensagens msg
          ON msg.canal_id = mb.canal_id
         AND msg.criado_em > COALESCE(mb.ultima_leitura_em, mb.criado_em)
         AND msg.excluida_em IS NULL
         AND msg.autor_id IS NOT NULL
         AND msg.autor_id <> mb.usuario_id
       WHERE mb.usuario_id = ${usuarioId}::uuid
       GROUP BY mb.canal_id, mb.silenciado, c.arquivado_em`;
    let total = 0;
    for (const linha of linhas) {
      if (!linha.arquivado) {
        total += linha.silenciado ? linha.mencoes : linha.naoLidas;
      }
    }
    return {
      total,
      canais: linhas.map(({ canalId, naoLidas, mencoes, silenciado }) => ({
        canalId,
        naoLidas,
        mencoes,
        silenciado,
      })),
    };
  }

  /** O número do menu (`nao-lidas.chat`) de cada pessoa. */
  async totaisDoMenu(
    usuarioIds: readonly string[],
    tx: Tx = this.prisma,
  ): Promise<Map<string, number>> {
    const totais = new Map<string, number>(
      usuarioIds.map((id) => [id, 0] as const),
    );
    if (usuarioIds.length === 0) {
      return totais;
    }
    const linhas = await tx.$queryRaw<{ usuarioId: string; total: number }[]>`
      SELECT mb.usuario_id AS "usuarioId", count(msg.id)::int AS "total"
        FROM chat_membros mb
        JOIN chat_canais c ON c.id = mb.canal_id AND c.arquivado_em IS NULL
        JOIN chat_mensagens msg
          ON msg.canal_id = mb.canal_id
         AND msg.criado_em > COALESCE(mb.ultima_leitura_em, mb.criado_em)
         AND msg.excluida_em IS NULL
         AND msg.autor_id IS NOT NULL
         AND msg.autor_id <> mb.usuario_id
       WHERE mb.usuario_id = ANY(${[...usuarioIds]}::uuid[])
         AND (NOT mb.silenciado OR mb.usuario_id = ANY(msg.mencoes))
       GROUP BY mb.usuario_id`;
    for (const linha of linhas) {
      totais.set(linha.usuarioId, linha.total);
    }
    return totais;
  }

  private async contarNaoLidas(
    filtro: { usuarioId: string } | { canalId: string; usuarioIds: string[] },
    tx: Tx,
  ): Promise<Map<string, ContagemDoMembro>> {
    const onde =
      'usuarioId' in filtro
        ? Prisma.sql`mb.usuario_id = ${filtro.usuarioId}::uuid`
        : Prisma.sql`mb.canal_id = ${filtro.canalId}::uuid AND mb.usuario_id = ANY(${filtro.usuarioIds}::uuid[])`;
    const linhas = await tx.$queryRaw<ContagemDoMembro[]>`
      SELECT mb.canal_id AS "canalId", mb.usuario_id AS "usuarioId",
             count(msg.id)::int AS "naoLidas",
             count(msg.id) FILTER (WHERE mb.usuario_id = ANY(msg.mencoes))::int AS "mencoes"
        FROM chat_membros mb
        JOIN chat_mensagens msg
          ON msg.canal_id = mb.canal_id
         AND msg.criado_em > COALESCE(mb.ultima_leitura_em, mb.criado_em)
         AND msg.excluida_em IS NULL
         AND msg.autor_id IS NOT NULL
         AND msg.autor_id <> mb.usuario_id
       WHERE ${onde}
       GROUP BY mb.canal_id, mb.usuario_id`;
    return new Map(
      linhas.map((linha) => [
        chaveDaContagem(linha.canalId, linha.usuarioId),
        linha,
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Apoio da montagem dos canais
  // -------------------------------------------------------------------------

  /** O que é igual para todos os membros: dados, contagem de membros, prévia e as duas pessoas da direta. */
  private async basesDosCanais(
    canalIds: readonly string[],
    tx: Tx,
  ): Promise<Map<string, BaseDoCanal>> {
    const [canais, contagens, ultimas, presenca] = await this.juntos(
      tx,
      () => tx.chatCanal.findMany({ where: { id: { in: [...canalIds] } } }),
      () =>
        tx.chatMembro.groupBy({
          by: ['canalId'],
          where: { canalId: { in: [...canalIds] } },
          _count: { _all: true },
        }),
      () => tx.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT ON (canal_id) id
          FROM chat_mensagens
         WHERE canal_id = ANY(${[...canalIds]}::uuid[])
         ORDER BY canal_id, criado_em DESC, id DESC`,
      () => this.presenca(),
    );
    const diretas = canais
      .filter((canal) => canal.tipo === 'DIRETO')
      .map((canal) => canal.id);
    const [mensagens, pessoasDasDiretas] = await this.juntos(
      tx,
      () =>
        ultimas.length > 0
          ? tx.chatMensagem.findMany({
              where: { id: { in: ultimas.map(({ id }) => id) } },
              include: INCLUIR_NA_MENSAGEM,
            })
          : Promise.resolve([] as MensagemCompleta[]),
      () =>
        diretas.length > 0
          ? tx.chatMembro.findMany({
              where: { canalId: { in: diretas } },
              select: {
                canalId: true,
                usuario: { select: CAMPOS_DA_PESSOA },
              },
            })
          : Promise.resolve([]),
    );
    const previas = new Map<string, ChatUltimaMensagemDto>();
    for (const dto of await this.mensagens(mensagens, tx, presenca)) {
      previas.set(dto.canalId, {
        id: dto.id,
        autorId: dto.autor?.id ?? null,
        autorNome: dto.autor?.nome ?? null,
        resumo: dto.excluida
          ? MENSAGEM_EXCLUIDA
          : this.resumoDasPartes(dto.partes, dto.anexo?.nome ?? null),
        excluida: dto.excluida,
        criadaEm: dto.criadaEm,
      });
    }
    const totalPorCanal = new Map(
      contagens.map((linha) => [linha.canalId, linha._count._all] as const),
    );
    const pessoasPorDireta = new Map<string, ChatPessoaDto[]>();
    for (const { canalId, usuario } of pessoasDasDiretas) {
      const lista = pessoasPorDireta.get(canalId) ?? [];
      lista.push(this.pessoa(usuario, presenca));
      pessoasPorDireta.set(canalId, lista);
    }
    return new Map(
      canais.map((canal) => [
        canal.id,
        {
          canal,
          totalMembros: totalPorCanal.get(canal.id) ?? 0,
          ultimaMensagem: previas.get(canal.id) ?? null,
          pessoas: pessoasPorDireta.get(canal.id) ?? [],
        },
      ]),
    );
  }

  private montarCanal(
    base: BaseDoCanal,
    membro: {
      usuarioId: string;
      administrador: boolean;
      automatico: boolean;
      silenciado: boolean;
      ultimaLeituraEm: Date | null;
    },
    contagem: ContagemDoMembro | undefined,
  ): ChatCanalDto {
    const { canal } = base;
    const direta = canal.tipo === 'DIRETO';
    const outraPessoa = direta
      ? (base.pessoas.find((pessoa) => pessoa.id !== membro.usuarioId) ?? null)
      : null;
    const motivoSemEnvio = canal.arquivadoEm
      ? 'O grupo foi arquivado: as mensagens ficam só para leitura.'
      : outraPessoa && !outraPessoa.ativo
        ? `${outraPessoa.nome} não está mais no CRM: a conversa fica só para leitura.`
        : null;
    const grupo = canal.tipo === 'GRUPO';
    return {
      id: canal.id,
      tipo: canal.tipo,
      nome: direta
        ? (outraPessoa?.nome ?? 'Conversa direta')
        : (canal.nome ?? 'Canal'),
      descricao: canal.descricao,
      area: canal.area,
      outraPessoa,
      totalMembros: base.totalMembros,
      administrador: membro.administrador,
      automatico: membro.automatico,
      silenciado: membro.silenciado,
      naoLidas: contagem?.naoLidas ?? 0,
      mencoesNaoLidas: contagem?.mencoes ?? 0,
      ultimaLeituraEm: membro.ultimaLeituraEm?.toISOString() ?? null,
      ultimaMensagem: base.ultimaMensagem,
      ultimaMensagemEm: canal.ultimaMensagemEm?.toISOString() ?? null,
      arquivadoEm: canal.arquivadoEm?.toISOString() ?? null,
      podeEnviar: motivoSemEnvio === null,
      motivoSemEnvio,
      podeGerenciar: grupo && membro.administrador,
      podeSair: grupo,
      criadoEm: canal.criadoEm.toISOString(),
    };
  }

  /**
   * Consultas independentes: em paralelo no pool; uma de cada vez dentro de
   * uma transação interativa (a mesma conexão não aceita consultas
   * simultâneas — o `pg` só avisa hoje, mas recusaria no futuro).
   */
  private async juntos<T extends readonly unknown[]>(
    tx: Tx,
    ...tarefas: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    if (tx === this.prisma) {
      return Promise.all(
        tarefas.map((tarefa) => tarefa()),
      ) as unknown as Promise<T>;
    }
    const resultados: unknown[] = [];
    for (const tarefa of tarefas) {
      resultados.push(await tarefa());
    }
    return resultados as unknown as T;
  }
}

interface BaseDoCanal {
  canal: Prisma.ChatCanalGetPayload<object>;
  totalMembros: number;
  ultimaMensagem: ChatUltimaMensagemDto | null;
  /** Só nas diretas: as duas pessoas. */
  pessoas: ChatPessoaDto[];
}

function chaveDaContagem(canalId: string, usuarioId: string): string {
  return `${canalId}:${usuarioId}`;
}

const ORDEM_DO_TIPO: Readonly<Record<ChatCanalDto['tipo'], number>> = {
  GERAL: 0,
  AREA: 1,
  GRUPO: 2,
  DIRETO: 2,
};

/** Geral, áreas (por nome) e depois grupos e diretas, do mais recente ao mais antigo. */
function compararCanais(a: ChatCanalDto, b: ChatCanalDto): number {
  const tipo = ORDEM_DO_TIPO[a.tipo] - ORDEM_DO_TIPO[b.tipo];
  if (tipo !== 0) {
    return tipo;
  }
  if (a.tipo === 'AREA') {
    return a.nome.localeCompare(b.nome, 'pt-BR');
  }
  const recenteA = a.ultimaMensagemEm ?? a.criadoEm;
  const recenteB = b.ultimaMensagemEm ?? b.criadoEm;
  return (
    recenteB.localeCompare(recenteA) || a.nome.localeCompare(b.nome, 'pt-BR')
  );
}
