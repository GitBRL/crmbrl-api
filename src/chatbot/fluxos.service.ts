import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  DadosInvalidosException,
  ErroApi,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { areaDoPapel, ehDiretoria } from '../comum/dominio/papeis';
import {
  montarPagina,
  paraSkipTake,
  type Pagina,
} from '../comum/paginacao/paginacao';
import {
  type DefinicaoDePassos,
  type ProblemaDeDefinicao,
  validarDefinicao,
} from '../comum/passos/definicao';
import { PassosService } from '../comum/passos/passos.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { MOTIVOS_DE_FIM, PASSOS_MAXIMOS_POR_FLUXO } from './chatbot.constantes';
import type {
  AtualizarFluxoChatbotDto,
  CriarFluxoChatbotDto,
  FiltroExecucoesChatbotDto,
  FiltroFluxosChatbotDto,
} from './chatbot.dto';
import {
  areaDoNovoFluxo,
  filtroDeFluxosVisiveis,
  podeGerenciarFluxo,
  podeUsarChatbot,
} from './permissoes-chatbot';

const INCLUIR_VERSAO = {
  versaoPublicada: {
    select: {
      id: true,
      numero: true,
      criadoEm: true,
      publicadaPor: { select: { id: true, nome: true } },
    },
  },
  criadoPor: { select: { id: true, nome: true } },
} satisfies Prisma.FluxoChatbotInclude;

type FluxoComRelacoes = Prisma.FluxoChatbotGetPayload<{
  include: typeof INCLUIR_VERSAO;
}>;

export interface ContadoresDoFluxo {
  total: number;
  emAndamento: number;
  transferidas: number;
  semResposta: number;
}

/** Um fluxo na lista e no detalhe (`rascunho` e `definicaoPublicada` só no detalhe). */
export interface FluxoChatbotDto {
  id: string;
  nome: string;
  descricao: string | null;
  area: string | null;
  canalIds: string[];
  gatilho: string;
  palavrasChave: string[];
  prioridade: number;
  ativo: boolean;
  versaoPublicada: {
    id: string;
    numero: number;
    publicadaEm: string;
    publicadaPor: { id: string; nome: string } | null;
  } | null;
  /** O rascunho mudou depois da última publicação. */
  rascunhoNaoPublicado: boolean;
  passos: number;
  criadoPor: { id: string; nome: string } | null;
  criadoEm: string;
  atualizadoEm: string;
  rascunhoAlteradoEm: string;
  contadores?: ContadoresDoFluxo;
  /** Só no detalhe. */
  rascunho?: unknown;
  definicaoPublicada?: unknown;
  /** O usuário pode editar, publicar, ativar e excluir? */
  podeEditar: boolean;
}

export interface ProblemaDoFluxo {
  caminho: string;
  mensagem: string;
  passoId?: string;
}

function contarPassos(definicao: unknown): number {
  const conta = (lista: unknown): number =>
    Array.isArray(lista)
      ? lista.reduce<number>((soma, passo: unknown) => {
          const p = passo as { ramos?: Array<{ passos?: unknown }> };
          return (
            soma + 1 + (p.ramos ?? []).reduce((s, r) => s + conta(r.passos), 0)
          );
        }, 0)
      : 0;
  return conta((definicao as { passos?: unknown })?.passos);
}

/**
 * Fluxos do chatbot (R18): CRUD, rascunho × versão publicada (imutável),
 * ativar/desativar, duplicar, restaurar versão e histórico de execuções.
 * Editar o rascunho nunca afeta conversas em andamento: cada execução guarda
 * uma cópia da versão com que começou.
 */
@Injectable()
export class FluxosChatbotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passos: PassosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroFluxosChatbotDto,
  ): Promise<Pagina<FluxoChatbotDto>> {
    this.exigirAcesso(usuario);
    const where: Prisma.FluxoChatbotWhereInput = {
      excluidoEm: null,
      AND: [filtroDeFluxosVisiveis(usuario)],
      ...(filtro.busca
        ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
        : {}),
      ...(filtro.ativo !== undefined ? { ativo: filtro.ativo } : {}),
      ...(filtro.gatilho ? { gatilho: filtro.gatilho } : {}),
    };
    const [total, fluxos] = await Promise.all([
      this.prisma.fluxoChatbot.count({ where }),
      this.prisma.fluxoChatbot.findMany({
        where,
        include: INCLUIR_VERSAO,
        orderBy: [{ ativo: 'desc' }, { prioridade: 'desc' }, { nome: 'asc' }],
        ...paraSkipTake(filtro),
      }),
    ]);
    const contadores = await this.contadores(fluxos.map((f) => f.id));
    return montarPagina(
      fluxos.map((f) =>
        this.paraDto(usuario, f, { contadores: contadores.get(f.id) }),
      ),
      total,
      filtro,
    );
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FluxoChatbotDto> {
    const fluxo = await this.obter(usuario, id);
    const [contadores, publicada] = await Promise.all([
      this.contadores([id]),
      fluxo.versaoPublicadaId
        ? this.prisma.fluxoChatbotVersao.findUnique({
            where: { id: fluxo.versaoPublicadaId },
            select: { definicao: true },
          })
        : null,
    ]);
    return this.paraDto(usuario, fluxo, {
      contadores: contadores.get(id),
      detalhe: true,
      definicaoPublicada: publicada?.definicao,
    });
  }

  async versoes(usuario: UsuarioAutenticado, id: string) {
    const fluxo = await this.obter(usuario, id);
    const versoes = await this.prisma.fluxoChatbotVersao.findMany({
      where: { fluxoId: id },
      orderBy: { numero: 'desc' },
      select: {
        id: true,
        numero: true,
        criadoEm: true,
        definicao: true,
        publicadaPor: { select: { id: true, nome: true } },
      },
    });
    return versoes.map((v) => ({
      id: v.id,
      numero: v.numero,
      publicadaEm: v.criadoEm.toISOString(),
      publicadaPor: v.publicadaPor,
      passos: contarPassos(v.definicao),
      emUso: v.id === fluxo.versaoPublicadaId,
    }));
  }

  async versao(usuario: UsuarioAutenticado, id: string, numero: number) {
    await this.obter(usuario, id);
    const versao = await this.prisma.fluxoChatbotVersao.findUnique({
      where: { fluxoId_numero: { fluxoId: id, numero } },
      include: { publicadaPor: { select: { id: true, nome: true } } },
    });
    if (!versao) {
      throw new NaoEncontradoException('Versão não encontrada.');
    }
    return {
      id: versao.id,
      numero: versao.numero,
      publicadaEm: versao.criadoEm.toISOString(),
      publicadaPor: versao.publicadaPor,
      definicao: versao.definicao,
    };
  }

  async execucoes(
    usuario: UsuarioAutenticado,
    id: string,
    filtro: FiltroExecucoesChatbotDto,
  ) {
    await this.obter(usuario, id);
    const where: Prisma.ExecucaoWhereInput = {
      fluxoId: id,
      tipo: 'CHATBOT',
      teste: false,
      ...(filtro.status ? { status: filtro.status } : {}),
      ...(filtro.motivoFim ? { motivoFim: filtro.motivoFim } : {}),
    };
    const [total, linhas] = await Promise.all([
      this.prisma.execucao.count({ where }),
      this.prisma.execucao.findMany({
        where,
        orderBy: { iniciadaEm: 'desc' },
        ...paraSkipTake(filtro),
        select: {
          id: true,
          status: true,
          motivoFim: true,
          erro: true,
          iniciadaEm: true,
          concluidaEm: true,
          conversaId: true,
          passosExecutados: true,
          fluxoVersao: { select: { numero: true } },
          contato: { select: { id: true, nome: true } },
        },
      }),
    ]);
    return montarPagina(
      linhas.map((l) => ({
        id: l.id,
        status: l.status,
        motivoFim: l.motivoFim,
        erro: l.erro,
        iniciadaEm: l.iniciadaEm.toISOString(),
        concluidaEm: l.concluidaEm?.toISOString() ?? null,
        conversaId: l.conversaId,
        contato: l.contato,
        versao: l.fluxoVersao?.numero ?? null,
        passosExecutados: l.passosExecutados,
      })),
      total,
      filtro,
    );
  }

  /** O passo a passo de uma execução (histórico por passo, com o que o bot disse e ouviu). */
  async execucao(usuario: UsuarioAutenticado, id: string, execucaoId: string) {
    await this.obter(usuario, id);
    const execucao = await this.prisma.execucao.findFirst({
      where: { id: execucaoId, fluxoId: id, tipo: 'CHATBOT' },
      include: {
        passos: { orderBy: { ordem: 'asc' } },
        contato: { select: { id: true, nome: true } },
      },
    });
    if (!execucao) {
      throw new NaoEncontradoException('Execução não encontrada.');
    }
    return {
      id: execucao.id,
      status: execucao.status,
      motivoFim: execucao.motivoFim,
      erro: execucao.erro,
      conversaId: execucao.conversaId,
      contato: execucao.contato,
      iniciadaEm: execucao.iniciadaEm.toISOString(),
      concluidaEm: execucao.concluidaEm?.toISOString() ?? null,
      variaveis: Object.fromEntries(
        Object.entries(execucao.variaveis as Record<string, unknown>).filter(
          ([chave]) => !chave.startsWith('__'),
        ),
      ),
      passos: execucao.passos.map((p) => ({
        passoId: p.passoId,
        tipo: p.tipo,
        visita: p.visita,
        status: p.status,
        tentativas: p.tentativas,
        erro: p.erro,
        saida: (p.resultado as { saida?: unknown } | null)?.saida ?? null,
        iniciadoEm: p.iniciadoEm.toISOString(),
        concluidoEm: p.concluidoEm?.toISOString() ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarFluxoChatbotDto,
  ): Promise<FluxoChatbotDto> {
    this.exigirAcesso(usuario);
    const area = areaDoNovoFluxo(usuario, dto.area);
    this.exigirPalavrasChave(dto.gatilho, dto.palavrasChave ?? []);
    const definicao = dto.definicao
      ? this.estruturar(dto.definicao)
      : { passos: [] };
    const criado = await this.prisma.$transaction(async (tx) => {
      await this.conferirCanais(tx, usuario, dto.canalIds ?? []);
      const fluxo = await tx.fluxoChatbot.create({
        data: {
          nome: dto.nome,
          descricao: dto.descricao || null,
          area,
          canalIds: dto.canalIds ?? [],
          gatilho: dto.gatilho,
          palavrasChave: this.limparPalavras(dto.palavrasChave),
          prioridade: dto.prioridade ?? 0,
          ativo: false,
          rascunho: definicao as unknown as Prisma.InputJsonObject,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.criado',
        entidade: 'fluxo_chatbot',
        entidadeId: fluxo.id,
        resumo: `Fluxo de chatbot "${fluxo.nome}" criado`,
        dados: { gatilho: fluxo.gatilho, area: fluxo.area },
      });
      return fluxo;
    });
    return this.detalhar(usuario, criado.id);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarFluxoChatbotDto,
  ): Promise<FluxoChatbotDto> {
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.travar(tx, usuario, id, true);
      const gatilho = dto.gatilho ?? antes.gatilho;
      const palavras =
        dto.palavrasChave !== undefined
          ? this.limparPalavras(dto.palavrasChave)
          : antes.palavrasChave;
      this.exigirPalavrasChave(gatilho, palavras);
      if (dto.canalIds) {
        await this.conferirCanais(tx, usuario, dto.canalIds);
      }
      const dados: Prisma.FluxoChatbotUpdateInput = {
        ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
        ...(dto.descricao !== undefined
          ? { descricao: dto.descricao || null }
          : {}),
        ...(dto.canalIds !== undefined ? { canalIds: dto.canalIds } : {}),
        ...(dto.gatilho !== undefined ? { gatilho: dto.gatilho } : {}),
        ...(dto.palavrasChave !== undefined ? { palavrasChave: palavras } : {}),
        ...(dto.prioridade !== undefined ? { prioridade: dto.prioridade } : {}),
      };
      const depois = await tx.fluxoChatbot.update({
        where: { id },
        data: dados,
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'nome',
        'descricao',
        'canalIds',
        'gatilho',
        'palavrasChave',
        'prioridade',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'fluxo_chatbot.atualizado',
          entidade: 'fluxo_chatbot',
          entidadeId: id,
          resumo: `Fluxo de chatbot "${depois.nome}" atualizado`,
          dados: { alteracoes },
        });
      }
    });
    return this.detalhar(usuario, id);
  }

  /**
   * Salva o rascunho (o editor chama a cada alteração). Confere a estrutura
   * (ids únicos, ramos, desvios, tipos conhecidos); a configuração de cada
   * passo só é cobrada na publicação (`POST …/publicar`).
   */
  async salvarRascunho(
    usuario: UsuarioAutenticado,
    id: string,
    definicao: Record<string, unknown>,
  ): Promise<FluxoChatbotDto> {
    const estrutura = this.estruturar(definicao);
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      await tx.fluxoChatbot.update({
        where: { id },
        data: {
          rascunho: estrutura as unknown as Prisma.InputJsonObject,
          rascunhoAlteradoEm: new Date(),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.rascunho_salvo',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Rascunho do fluxo "${fluxo.nome}" salvo (${contarPassos(estrutura)} passos)`,
        dados: { passos: contarPassos(estrutura) },
      });
    });
    return this.detalhar(usuario, id);
  }

  /** Problemas do rascunho que impediriam a publicação. */
  async validar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{ valido: boolean; problemas: ProblemaDoFluxo[] }> {
    const fluxo = await this.obter(usuario, id);
    const problemas = this.problemasDaDefinicao(fluxo.rascunho, fluxo);
    return { valido: problemas.length === 0, problemas };
  }

  /**
   * Publica o rascunho como a próxima versão (imutável). Conversas em andamento
   * seguem na versão com que começaram; as novas já entram na nova versão.
   */
  async publicar(
    usuario: UsuarioAutenticado,
    id: string,
    ativar?: boolean,
  ): Promise<FluxoChatbotDto> {
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      const problemas = this.problemasDaDefinicao(fluxo.rascunho, fluxo);
      if (problemas.length > 0) {
        throw new DadosInvalidosException(
          `O fluxo tem problemas: ${problemas[0].mensagem}`,
          { regra: 'R18', problemas },
        );
      }
      const ultima = await tx.fluxoChatbotVersao.aggregate({
        where: { fluxoId: id },
        _max: { numero: true },
      });
      const numero = (ultima._max.numero ?? 0) + 1;
      const versao = await tx.fluxoChatbotVersao.create({
        data: {
          fluxoId: id,
          numero,
          definicao: fluxo.rascunho as Prisma.InputJsonObject,
          publicadaPorId: usuario.id,
        },
      });
      await tx.fluxoChatbot.update({
        where: { id },
        data: {
          versaoPublicadaId: versao.id,
          ...(ativar !== undefined ? { ativo: ativar } : {}),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.publicado',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Fluxo "${fluxo.nome}" publicado (versão ${numero})`,
        dados: { versao: numero, ativar: ativar ?? null },
      });
    });
    return this.detalhar(usuario, id);
  }

  async ativar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FluxoChatbotDto> {
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      if (!fluxo.versaoPublicadaId) {
        throw new RegraVioladaException(
          'R18',
          'Publique o fluxo antes de ativar.',
          { motivo: 'sem_versao_publicada' },
        );
      }
      if (fluxo.ativo) {
        return;
      }
      await tx.fluxoChatbot.update({ where: { id }, data: { ativo: true } });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.ativado',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Fluxo "${fluxo.nome}" ativado`,
      });
    });
    return this.detalhar(usuario, id);
  }

  /** Desativa: não atende conversas novas; as em andamento terminam normalmente. */
  async desativar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FluxoChatbotDto> {
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      if (!fluxo.ativo) {
        return;
      }
      await tx.fluxoChatbot.update({ where: { id }, data: { ativo: false } });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.desativado',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Fluxo "${fluxo.nome}" desativado`,
      });
    });
    return this.detalhar(usuario, id);
  }

  async duplicar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FluxoChatbotDto> {
    this.exigirAcesso(usuario);
    const origem = await this.obter(usuario, id);
    const copia = await this.prisma.$transaction(async (tx) => {
      const nova = await tx.fluxoChatbot.create({
        data: {
          nome: `${origem.nome} (cópia)`.slice(0, 120),
          descricao: origem.descricao,
          area: areaDoNovoFluxo(usuario, origem.area),
          canalIds: origem.canalIds,
          gatilho: origem.gatilho,
          palavrasChave: origem.palavrasChave,
          prioridade: origem.prioridade,
          ativo: false,
          rascunho: origem.rascunho as Prisma.InputJsonObject,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.duplicado',
        entidade: 'fluxo_chatbot',
        entidadeId: nova.id,
        resumo: `Fluxo "${origem.nome}" duplicado como "${nova.nome}"`,
        dados: { origemId: origem.id },
      });
      return nova;
    });
    return this.detalhar(usuario, copia.id);
  }

  /** Copia uma versão antiga para o rascunho (a publicada continua valendo até publicar de novo). */
  async restaurar(
    usuario: UsuarioAutenticado,
    id: string,
    numero: number,
  ): Promise<FluxoChatbotDto> {
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      const versao = await tx.fluxoChatbotVersao.findUnique({
        where: { fluxoId_numero: { fluxoId: id, numero } },
      });
      if (!versao) {
        throw new NaoEncontradoException('Versão não encontrada.');
      }
      await tx.fluxoChatbot.update({
        where: { id },
        data: {
          rascunho: versao.definicao as Prisma.InputJsonObject,
          rascunhoAlteradoEm: new Date(),
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.versao_restaurada',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Versão ${numero} do fluxo "${fluxo.nome}" restaurada no rascunho`,
        dados: { versao: numero },
      });
    });
    return this.detalhar(usuario, id);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fluxo = await this.travar(tx, usuario, id, true);
      await tx.fluxoChatbot.update({
        where: { id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.passos.cancelarAtivas(
        { fluxoId: id, tipo: 'CHATBOT' },
        MOTIVOS_DE_FIM.FLUXO_EXCLUIDO,
        { tx },
      );
      await this.auditoria.registrar(tx, {
        acao: 'fluxo_chatbot.excluido',
        entidade: 'fluxo_chatbot',
        entidadeId: id,
        resumo: `Fluxo de chatbot "${fluxo.nome}" excluído`,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  private exigirAcesso(usuario: UsuarioAutenticado): void {
    if (!podeUsarChatbot(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes configuram o chatbot.',
      );
    }
  }

  /** O fluxo, se a pessoa o vê (senão 404). */
  async obter(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<FluxoComRelacoes> {
    this.exigirAcesso(usuario);
    const fluxo = await this.prisma.fluxoChatbot.findFirst({
      where: { id, excluidoEm: null, AND: [filtroDeFluxosVisiveis(usuario)] },
      include: INCLUIR_VERSAO,
    });
    if (!fluxo) {
      throw new NaoEncontradoException('Fluxo não encontrado.');
    }
    return fluxo;
  }

  /** Trava a linha, confere que existe, que a pessoa vê e (com `editar`) que pode gerenciar. */
  private async travar(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
    editar: boolean,
  ) {
    this.exigirAcesso(usuario);
    await tx.$queryRaw`SELECT id FROM fluxos_chatbot WHERE id = ${id}::uuid FOR UPDATE`;
    const fluxo = await tx.fluxoChatbot.findFirst({
      where: { id, excluidoEm: null, AND: [filtroDeFluxosVisiveis(usuario)] },
    });
    if (!fluxo) {
      throw new NaoEncontradoException('Fluxo não encontrado.');
    }
    if (editar && !podeGerenciarFluxo(usuario, fluxo)) {
      throw new SemPermissaoException(
        'Este fluxo é de outra área: você pode ver, mas não alterar.',
      );
    }
    return fluxo;
  }

  /**
   * Os canais existem; e o líder só liga o fluxo a canais da própria área (a
   * fila padrão do canal é da área dele), nunca a "todos os canais" — assim o
   * fluxo dele não passa na frente do atendimento de outra área (R18.6).
   */
  private async conferirCanais(
    tx: Tx,
    usuario: UsuarioAutenticado,
    canalIds: readonly string[],
  ): Promise<void> {
    const unicos = [...new Set(canalIds)];
    const restrito = !ehDiretoria(usuario.papel);
    if (unicos.length === 0) {
      if (restrito) {
        throw new DadosInvalidosException(
          'Escolha os canais do fluxo: o líder só atende canais da própria área.',
          {
            regra: 'R18.6',
            campos: [
              { campo: 'canalIds', mensagens: ['escolha ao menos um canal'] },
            ],
          },
        );
      }
      return;
    }
    const canais = await tx.canal.findMany({
      where: { id: { in: unicos }, excluidoEm: null },
      select: { id: true, nome: true, filaPadrao: { select: { area: true } } },
    });
    if (canais.length !== unicos.length) {
      throw new DadosInvalidosException('Há canal que não existe mais.', {
        campos: [{ campo: 'canalIds', mensagens: ['canal não encontrado'] }],
      });
    }
    if (restrito) {
      const area = areaDoPapel(usuario.papel);
      const fora = canais.filter((c) => c.filaPadrao?.area !== area);
      if (fora.length > 0) {
        throw new DadosInvalidosException(
          `Só canais da sua área: ${fora.map((c) => c.nome).join(', ')} não atende(m) a sua fila.`,
          {
            regra: 'R18.6',
            campos: [{ campo: 'canalIds', mensagens: ['canal de outra área'] }],
          },
        );
      }
    }
  }

  private limparPalavras(palavras: readonly string[] | undefined): string[] {
    return [
      ...new Set((palavras ?? []).map((p) => p.trim()).filter((p) => p !== '')),
    ];
  }

  private exigirPalavrasChave(
    gatilho: string,
    palavras: readonly string[],
  ): void {
    if (
      gatilho === 'PALAVRA_CHAVE' &&
      this.limparPalavras([...palavras]).length === 0
    ) {
      throw new DadosInvalidosException(
        'Informe ao menos uma palavra-chave para este gatilho.',
        {
          regra: 'R18',
          campos: [{ campo: 'palavrasChave', mensagens: ['é obrigatória'] }],
        },
      );
    }
  }

  /** Estrutura da definição + tipos conhecidos (sem exigir a configuração completa). */
  private estruturar(entrada: unknown): DefinicaoDePassos {
    const tipos = new Map(
      this.passos.tiposDisponiveis('CHATBOT').map((nome) => [nome, undefined]),
    );
    return validarDefinicao(entrada, {
      tipos,
      maximoDePassos: PASSOS_MAXIMOS_POR_FLUXO,
    });
  }

  /** Problemas que impedem a publicação: estrutura, configuração dos passos e fluxo vazio. */
  problemasDaDefinicao(
    definicao: unknown,
    fluxo: { gatilho: string; palavrasChave: string[] },
  ): ProblemaDoFluxo[] {
    const problemas: ProblemaDoFluxo[] = [];
    try {
      const completa = this.passos.validarDefinicao('CHATBOT', definicao);
      if (completa.passos.length === 0) {
        problemas.push({
          caminho: 'passos',
          mensagem: 'Adicione ao menos um passo ao fluxo.',
        });
      }
      if (contarPassos(completa) > PASSOS_MAXIMOS_POR_FLUXO) {
        problemas.push({
          caminho: 'passos',
          mensagem: `No máximo ${PASSOS_MAXIMOS_POR_FLUXO} passos.`,
        });
      }
    } catch (erro) {
      if (erro instanceof ErroApi) {
        const lista = erro.detalhes?.problemas as
          ProblemaDeDefinicao[] | undefined;
        problemas.push(
          ...(lista ?? [{ caminho: 'passos', mensagem: erro.mensagem }]),
        );
      } else {
        throw erro;
      }
    }
    if (fluxo.gatilho === 'PALAVRA_CHAVE' && fluxo.palavrasChave.length === 0) {
      problemas.push({
        caminho: 'palavrasChave',
        mensagem: 'Informe ao menos uma palavra-chave.',
      });
    }
    return problemas;
  }

  private async contadores(
    ids: readonly string[],
  ): Promise<Map<string, ContadoresDoFluxo>> {
    const mapa = new Map<string, ContadoresDoFluxo>();
    if (ids.length === 0) {
      return mapa;
    }
    const linhas = await this.prisma.execucao.groupBy({
      by: ['fluxoId', 'status', 'motivoFim'],
      where: { fluxoId: { in: [...ids] }, tipo: 'CHATBOT', teste: false },
      _count: { _all: true },
    });
    for (const linha of linhas) {
      if (!linha.fluxoId) {
        continue;
      }
      const c = mapa.get(linha.fluxoId) ?? {
        total: 0,
        emAndamento: 0,
        transferidas: 0,
        semResposta: 0,
      };
      const n = linha._count._all;
      c.total += n;
      if (linha.status === 'EM_ANDAMENTO' || linha.status === 'AGUARDANDO') {
        c.emAndamento += n;
      }
      if (linha.motivoFim === MOTIVOS_DE_FIM.TRANSFERIDA) {
        c.transferidas += n;
      }
      if (linha.motivoFim === MOTIVOS_DE_FIM.SEM_RESPOSTA) {
        c.semResposta += n;
      }
      mapa.set(linha.fluxoId, c);
    }
    return mapa;
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    f: FluxoComRelacoes,
    extras: {
      contadores?: ContadoresDoFluxo;
      detalhe?: boolean;
      definicaoPublicada?: unknown;
    } = {},
  ): FluxoChatbotDto {
    const versao = f.versaoPublicada;
    return {
      id: f.id,
      nome: f.nome,
      descricao: f.descricao,
      area: f.area,
      canalIds: f.canalIds,
      gatilho: f.gatilho,
      palavrasChave: f.palavrasChave,
      prioridade: f.prioridade,
      ativo: f.ativo,
      versaoPublicada: versao
        ? {
            id: versao.id,
            numero: versao.numero,
            publicadaEm: versao.criadoEm.toISOString(),
            publicadaPor: versao.publicadaPor,
          }
        : null,
      rascunhoNaoPublicado:
        versao === null
          ? contarPassos(f.rascunho) > 0
          : f.rascunhoAlteradoEm.getTime() > versao.criadoEm.getTime(),
      passos: contarPassos(f.rascunho),
      criadoPor: f.criadoPor,
      criadoEm: f.criadoEm.toISOString(),
      atualizadoEm: f.atualizadoEm.toISOString(),
      rascunhoAlteradoEm: f.rascunhoAlteradoEm.toISOString(),
      contadores: extras.contadores ?? {
        total: 0,
        emAndamento: 0,
        transferidas: 0,
        semResposta: 0,
      },
      podeEditar: podeGerenciarFluxo(usuario, f),
      ...(extras.detalhe
        ? {
            rascunho: f.rascunho,
            definicaoPublicada: extras.definicaoPublicada ?? null,
          }
        : {}),
    };
  }
}
