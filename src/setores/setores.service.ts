import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ehDiretoria,
  ehLiderDoSetor,
  rotuloDaPessoa,
} from '../comum/dominio/papeis';
import {
  type Area,
  gerarChaveDoSetor,
  nomeNormalizado,
  registrarNomesDosSetores,
} from '../comum/dominio/setores';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  chaveDoAlvo,
  mudancaDeAcessos,
  resumoDosAcessos,
  validarAcessosPedidos,
} from '../funis/acessos-extras';
import { esquecerAcessosDaRequisicao } from '../funis/acessos-no-banco';
import {
  AcessoDto,
  type AcessosDoSetorDto,
  INCLUIR_ALVO_DO_ACESSO,
  type SubstituirAcessosDto,
} from '../funis/dto/acessos.dto';
import type { Setor, TipoEtapa } from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { TempoRealService } from '../tempo-real/tempo-real.service';
import { problemaDeMudancaDePapel } from '../usuarios/dominio/hierarquia';
import { SELECAO_RESUMO, UsuarioResumoDto } from '../usuarios/dto/usuario.dto';
import {
  lideradosAtivos,
  travarHierarquia,
} from '../usuarios/hierarquia-no-banco';
import type {
  AtualizarSetorDto,
  CriarSetorDto,
  FiltroSetoresDto,
  SetorDto,
} from './dto/setores.dto';

/** Etapas do funil-base de um setor criado (R1.7). */
export const ETAPAS_DO_FUNIL_DE_SETOR: readonly {
  chave: string;
  nome: string;
  tipo: TipoEtapa;
  prazoDias: number | null;
}[] = [
  { chave: 'novo', nome: 'Novo', tipo: 'ABERTA', prazoDias: 2 },
  {
    chave: 'em_andamento',
    nome: 'Em andamento',
    tipo: 'ABERTA',
    prazoDias: 7,
  },
  { chave: 'ganho', nome: 'Ganho', tipo: 'GANHO', prazoDias: null },
  { chave: 'perdido', nome: 'Perdido', tipo: 'PERDIDO', prazoDias: null },
];

const CAMPOS_AUDITADOS = ['nome', 'descricao', 'cor', 'ordem'] as const;

/** Releitura periódica dos nomes (rótulos em mensagens), além das mudanças locais. */
const INTERVALO_DOS_NOMES_MS = 60_000;

/**
 * Setores (R1.6–R1.11): os três de base (da migration) e os criados por Admin
 * e C-level. Criar um setor cria, na mesma transação, o funil-base dele, a
 * regra de rodízio e promove os líderes escolhidos (respondendo ao C-level
 * responsável). Setor não é apagado: desativar exige que ele esteja vazio (sem
 * pessoas, funis e filas ativos) e o tira das listas de escolha. Tudo auditado.
 *
 * Mantém também o registro de nomes em memória (`nomeDoSetor`), usado nos
 * rótulos de mensagens e resumos de auditoria.
 */
@Injectable()
export class SetoresService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Setores');
  private temporizador?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly tempoReal: TempoRealService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recarregarNomes().catch((erro: unknown) =>
      this.logger.warn(
        `Nomes dos setores não carregados na subida: ${erro instanceof Error ? erro.message : String(erro)}`,
      ),
    );
    this.temporizador = setInterval(() => {
      void this.recarregarNomes().catch(() => undefined);
    }, INTERVALO_DOS_NOMES_MS);
    this.temporizador.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.temporizador);
  }

  /** Relê os nomes de todos os setores para os rótulos (`nomeDoSetor`). */
  async recarregarNomes(): Promise<void> {
    const setores = await this.prisma.setor.findMany({
      select: { chave: true, nome: true },
    });
    registrarNomesDosSetores(setores);
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  /**
   * Setores ativos, na ordem de exibição (todo autenticado: são as opções dos
   * seletores). Admin e C-level podem pedir os inativos também, e recebem os
   * líderes e as contagens.
   */
  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroSetoresDto,
  ): Promise<SetorDto[]> {
    const gestao = ehDiretoria(usuario.papel);
    const setores = await this.prisma.setor.findMany({
      where: gestao && filtro.incluirInativos ? {} : { ativo: true },
      orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
    });
    return this.montar(this.prisma, setores, gestao);
  }

  /** Um setor (inativos só para Admin e C-level). */
  async detalhar(usuario: UsuarioAutenticado, chave: Area): Promise<SetorDto> {
    const gestao = ehDiretoria(usuario.papel);
    const setor = await this.prisma.setor.findUnique({ where: { chave } });
    if (!setor || (!setor.ativo && !gestao)) {
      throw new NaoEncontradoException('Setor não encontrado.');
    }
    const [dto] = await this.montar(this.prisma, [setor], gestao);
    return dto;
  }

  // -------------------------------------------------------------------------
  // Criação (R1.7)
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarSetorDto,
  ): Promise<SetorDto> {
    const lideres = [...new Set(dto.lideres ?? [])];
    if (lideres.length > 0 && !dto.cLevelResponsavelId) {
      throw new RegraVioladaException(
        'R1.2',
        'Escolha o C-level responsável: é ele quem lidera os líderes do setor.',
        { campo: 'cLevelResponsavelId' },
      );
    }
    const promovidos: string[] = [];
    const setor = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'setores');
      await travarHierarquia(tx);
      const existentes = await tx.setor.findMany();
      this.exigirNomeLivre(existentes, dto.nome);
      const chave = gerarChaveDoSetor(
        dto.nome,
        new Set(existentes.map((existente) => existente.chave)),
      );
      const ordem =
        dto.ordem ??
        existentes.reduce((maior, atual) => Math.max(maior, atual.ordem), 0) +
          1;
      const criado = await tx.setor.create({
        data: {
          chave,
          nome: dto.nome,
          descricao: dto.descricao ?? null,
          cor: dto.cor ?? null,
          base: false,
          ativo: true,
          ordem,
        },
      });
      const funil = await this.criarFunilBase(tx, criado);
      const regra = await tx.regraDistribuicao.create({
        data: { area: chave },
      });
      await this.auditoria.registrar(tx, {
        acao: 'regra_distribuicao.criada',
        entidade: 'regra_distribuicao',
        entidadeId: regra.id,
        resumo: `Rodízio do setor ${criado.nome} criado com o setor`,
        dados: { area: chave, incluirLideres: regra.incluirLideres },
      });
      if (lideres.length > 0) {
        promovidos.push(
          ...(await this.promoverLideres(
            tx,
            criado,
            lideres,
            dto.cLevelResponsavelId!,
          )),
        );
      }
      await this.auditoria.registrar(tx, {
        acao: 'setor.criado',
        entidade: 'setor',
        entidadeId: chave,
        resumo:
          `Setor ${criado.nome} criado (chave ${chave})` +
          (lideres.length > 0
            ? `, com ${lideres.length === 1 ? '1 líder' : `${lideres.length} líderes`}`
            : ''),
        dados: {
          alteracoes: calcularAlteracoes({}, criado, CAMPOS_AUDITADOS),
          funilBaseId: funil.id,
          regraDistribuicaoId: regra.id,
          lideres,
          cLevelResponsavelId: dto.cLevelResponsavelId ?? null,
        },
        relacionados: { funil: funil.id },
      });
      return criado;
    });
    registrarNomesDosSetores([setor]);
    // As salas do socket (papel, setor) são fixadas no handshake (R12.5).
    for (const id of promovidos) {
      this.tempoReal.desconectarUsuario(id);
    }
    const [resposta] = await this.montar(this.prisma, [setor], true);
    return resposta;
  }

  /** O funil-base do setor criado: nome do setor, `base`, etapas padrão (R1.7). */
  private async criarFunilBase(tx: Tx, setor: Setor) {
    const { _max } = await tx.funil.aggregate({ _max: { ordem: true } });
    const funil = await tx.funil.create({
      data: {
        nome: setor.nome,
        area: setor.chave,
        base: true,
        ordem: (_max.ordem ?? 0) + 1,
        descricao: setor.descricao,
        etapas: {
          create: ETAPAS_DO_FUNIL_DE_SETOR.map((etapa, indice) => ({
            ...etapa,
            ordem: indice + 1,
          })),
        },
      },
      include: { etapas: { orderBy: { ordem: 'asc' } } },
    });
    await this.auditoria.registrar(tx, {
      acao: 'funil.criado',
      entidade: 'funil',
      entidadeId: funil.id,
      resumo: `Funil-base ${funil.nome} criado com o setor ${setor.nome}`,
      dados: {
        area: funil.area,
        base: true,
        visibilidade: funil.visibilidade,
        etapas: funil.etapas.map((etapa) => ({
          nome: etapa.nome,
          tipo: etapa.tipo,
          prazoDias: etapa.prazoDias,
        })),
      },
    });
    return funil;
  }

  /**
   * Os líderes escolhidos viram `LIDER` do setor, respondendo ao C-level
   * responsável (R1.2). Só líderes e membros de hoje (R1.7): Admin e C-level não
   * mudam de papel por aqui (422 com quem foi recusado), e o C-level responsável
   * não lidera o próprio setor (422 `R1.2`). Quem tem liderados ativos não muda
   * de setor nem deixa de ser líder (R1.3): 409 com a lista de quem precisa de
   * novo líder, de todos os escolhidos de uma vez. Devolve quem mudou.
   */
  private async promoverLideres(
    tx: Tx,
    setor: Setor,
    ids: readonly string[],
    cLevelId: string,
  ): Promise<string[]> {
    const cLevel = await tx.usuario.findUnique({
      where: { id: cLevelId },
      select: { id: true, nome: true, papel: true, ativo: true },
    });
    if (!cLevel || cLevel.papel !== 'C_LEVEL' || !cLevel.ativo) {
      throw new RegraVioladaException(
        'R1.2',
        'O C-level responsável precisa ser um C-level ativo.',
        { campo: 'cLevelResponsavelId', cLevelResponsavelId: cLevelId },
      );
    }
    if (ids.includes(cLevel.id)) {
      throw new RegraVioladaException(
        'R1.2',
        'O C-level responsável não pode ser também líder do setor.',
        { campo: 'lideres', cLevelResponsavelId: cLevelId },
      );
    }
    const pessoas = await tx.usuario.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        nome: true,
        papel: true,
        area: true,
        ativo: true,
        liderId: true,
      },
    });
    const faltando = ids.filter((id) => !pessoas.some((p) => p.id === id));
    const inativos = pessoas.filter((pessoa) => !pessoa.ativo);
    if (faltando.length > 0 || inativos.length > 0) {
      throw new RegraVioladaException(
        'R1.7',
        'Os líderes precisam ser pessoas ativas.',
        {
          campo: 'lideres',
          naoEncontrados: faltando,
          inativos: inativos.map(({ id, nome }) => ({ id, nome })),
        },
      );
    }
    const foraDoNivel = pessoas.filter(
      ({ papel }) => papel !== 'LIDER' && papel !== 'MEMBRO',
    );
    if (foraDoNivel.length > 0) {
      throw new RegraVioladaException(
        'R1.7',
        'Só líderes e membros podem liderar um setor novo: Admin e C-level não mudam de papel ao criar um setor.',
        {
          campo: 'lideres',
          recusados: foraDoNivel.map(({ id, nome, papel }) => ({
            id,
            nome,
            papel,
          })),
        },
      );
    }
    const novo = { papel: 'LIDER' as const, area: setor.chave };
    const pendencias: {
      usuario: { id: string; nome: string };
      liderados: {
        id: string;
        nome: string;
        papel: string;
        area: string | null;
      }[];
    }[] = [];
    for (const pessoa of pessoas) {
      const problema = problemaDeMudancaDePapel(
        pessoa,
        novo,
        await lideradosAtivos(tx, pessoa.id),
      );
      const liderados = problema?.detalhes?.liderados as
        (typeof pendencias)[number]['liderados'] | undefined;
      if (liderados?.length) {
        pendencias.push({
          usuario: { id: pessoa.id, nome: pessoa.nome },
          liderados,
        });
      }
    }
    if (pendencias.length > 0) {
      throw new ConflitoException(
        pendencias.length === 1
          ? `${pendencias[0].usuario.nome} tem liderados que precisam de um novo líder antes de mudar de setor.`
          : `${pendencias.map((p) => p.usuario.nome).join(', ')} têm liderados que precisam de um novo líder antes de mudar de setor.`,
        { regra: 'R1.3', campo: 'lideres', pendencias },
      );
    }
    for (const pessoa of pessoas) {
      const depois = await tx.usuario.update({
        where: { id: pessoa.id },
        data: { papel: 'LIDER', area: setor.chave, liderId: cLevel.id },
        select: {
          id: true,
          nome: true,
          papel: true,
          area: true,
          liderId: true,
        },
      });
      const alteracoes = calcularAlteracoes(pessoa, depois, [
        'papel',
        'area',
        'liderId',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'usuario.atualizado',
          entidade: 'usuario',
          entidadeId: pessoa.id,
          resumo: `${pessoa.nome} passou a ser ${rotuloDaPessoa(depois)} (novo setor), respondendo a ${cLevel.nome}`,
          dados: { alteracoes, setor: setor.chave },
          relacionados: { usuario: cLevel.id },
        });
      }
    }
    return pessoas.map(({ id }) => id);
  }

  // -------------------------------------------------------------------------
  // Edição, desativação e reativação (R1.10, R1.11)
  // -------------------------------------------------------------------------

  /** Nome, descrição, cor e ordem (a chave não muda; os de base também podem ser renomeados). */
  async atualizar(
    usuario: UsuarioAutenticado,
    chave: Area,
    dto: AtualizarSetorDto,
  ): Promise<SetorDto> {
    const setor = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'setores');
      const antes = await this.obter(tx, chave);
      if (dto.nome !== undefined && dto.nome !== antes.nome && antes.ativo) {
        this.exigirNomeLivre(await tx.setor.findMany(), dto.nome, chave);
      }
      const depois = await tx.setor.update({
        where: { chave },
        data: {
          nome: dto.nome,
          descricao: dto.descricao,
          cor: dto.cor,
          ordem: dto.ordem,
        },
      });
      const alteracoes = calcularAlteracoes(antes, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'setor.atualizado',
          entidade: 'setor',
          entidadeId: chave,
          resumo: `Setor ${depois.nome} atualizado (${Object.keys(alteracoes).join(', ')})`,
          dados: { alteracoes },
        });
      }
      if (depois.nome !== antes.nome) {
        // O canal do setor no chat interno acompanha o nome (R15.1).
        await tx.chatCanal.updateMany({
          where: { tipo: 'AREA', area: chave, chave: { not: null } },
          data: {
            nome: depois.nome,
            descricao: `Canal da equipe de ${depois.nome}.`,
          },
        });
      }
      return depois;
    });
    registrarNomesDosSetores([setor]);
    const [resposta] = await this.montar(
      this.prisma,
      [setor],
      ehDiretoria(usuario.papel),
    );
    return resposta;
  }

  /**
   * Desativa (R1.10): só setores criados (não os de base) e vazios — sem
   * pessoas ativas, funis ativos nem filas de atendimento ativas (409 com o que
   * falta tirar). Inativo, o setor some das listas de escolha e continua nos
   * registros antigos.
   */
  async desativar(usuario: UsuarioAutenticado, chave: Area): Promise<SetorDto> {
    const setor = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'setores');
      await travarHierarquia(tx);
      const antes = await this.obter(tx, chave);
      if (antes.base) {
        throw new RegraVioladaException(
          'R1.10',
          `${antes.nome} é um setor de base: não pode ser desativado.`,
          { chave },
        );
      }
      if (!antes.ativo) {
        throw new ConflitoException(
          `O setor ${antes.nome} já está desativado.`,
          {
            regra: 'R1.10',
          },
        );
      }
      const [usuarios, funis, filas] = await Promise.all([
        tx.usuario.findMany({
          where: { area: chave, ativo: true },
          select: { id: true, nome: true, papel: true, area: true },
          orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        }),
        tx.funil.findMany({
          where: { area: chave, ativo: true, excluidoEm: null },
          select: { id: true, nome: true, base: true },
          orderBy: [{ ordem: 'asc' }, { nome: 'asc' }],
        }),
        tx.filaAtendimento.findMany({
          where: { area: chave, ativa: true, excluidoEm: null },
          select: { id: true, nome: true },
          orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        }),
      ]);
      if (usuarios.length > 0 || funis.length > 0 || filas.length > 0) {
        const partes = [
          usuarios.length > 0
            ? `${usuarios.length === 1 ? '1 pessoa ativa' : `${usuarios.length} pessoas ativas`}`
            : null,
          funis.length > 0
            ? `${funis.length === 1 ? '1 funil ativo' : `${funis.length} funis ativos`}`
            : null,
          filas.length > 0
            ? `${filas.length === 1 ? '1 fila de atendimento ativa' : `${filas.length} filas de atendimento ativas`}`
            : null,
        ].filter((parte): parte is string => parte !== null);
        throw new ConflitoException(
          `O setor ${antes.nome} ainda tem ${partes.join(', ')}: mude as pessoas de setor (ou desligue-as) e arquive os funis e as filas antes de desativar.`,
          {
            regra: 'R1.10',
            usuarios: usuarios.map((pessoa) => ({
              id: pessoa.id,
              nome: pessoa.nome,
              papel: pessoa.papel,
              rotuloPapel: rotuloDaPessoa(pessoa),
            })),
            funis,
            filas,
          },
        );
      }
      const depois = await tx.setor.update({
        where: { chave },
        data: { ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'setor.desativado',
        entidade: 'setor',
        entidadeId: chave,
        resumo: `Setor ${depois.nome} desativado`,
        dados: { alteracoes: { ativo: { de: true, para: false } } },
      });
      return depois;
    });
    const [resposta] = await this.montar(
      this.prisma,
      [setor],
      ehDiretoria(usuario.papel),
    );
    return resposta;
  }

  /** Reativa (R1.10): volta às listas, se o nome continuar único entre os ativos (R1.8). */
  async reativar(usuario: UsuarioAutenticado, chave: Area): Promise<SetorDto> {
    const setor = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'setores');
      const antes = await this.obter(tx, chave);
      if (antes.ativo) {
        throw new ConflitoException(`O setor ${antes.nome} já está ativo.`, {
          regra: 'R1.10',
        });
      }
      this.exigirNomeLivre(await tx.setor.findMany(), antes.nome, chave);
      const depois = await tx.setor.update({
        where: { chave },
        data: { ativo: true },
      });
      await this.auditoria.registrar(tx, {
        acao: 'setor.reativado',
        entidade: 'setor',
        entidadeId: chave,
        resumo: `Setor ${depois.nome} reativado`,
        dados: { alteracoes: { ativo: { de: false, para: true } } },
      });
      return depois;
    });
    const [resposta] = await this.montar(
      this.prisma,
      [setor],
      ehDiretoria(usuario.papel),
    );
    return resposta;
  }

  // -------------------------------------------------------------------------
  // Acessos extras do setor (R5.11)
  // -------------------------------------------------------------------------

  /** Quem mais vê os funis do setor (menos os `RESTRITA`): Admin, C-level e líderes do setor. */
  async listarAcessos(
    usuario: UsuarioAutenticado,
    chave: Area,
  ): Promise<AcessosDoSetorDto> {
    const setor = await this.obterParaAcessos(this.prisma, usuario, chave);
    return this.acessosDoSetor(this.prisma, setor);
  }

  /**
   * Troca a lista de acessos do setor (R5.11): valida os alvos, grava só o que
   * mudou e audita antes e depois (`setor.acessos_alterados`).
   */
  async substituirAcessos(
    usuario: UsuarioAutenticado,
    chave: Area,
    dto: SubstituirAcessosDto,
  ): Promise<AcessosDoSetorDto> {
    const resposta = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, `setor-acessos:${chave}`);
      const setor = await this.obterParaAcessos(tx, usuario, chave);
      const gravados = await tx.acessoSetor.findMany({
        where: { areaDono: setor.chave },
        select: { id: true, area: true, usuarioId: true, nivel: true },
      });
      const pedidos = await validarAcessosPedidos(
        tx,
        setor.chave,
        dto.acessos,
        gravados,
      );
      const mudanca = mudancaDeAcessos(gravados, pedidos);
      if (mudanca.remover.length > 0) {
        await tx.acessoSetor.deleteMany({
          where: { id: { in: mudanca.remover } },
        });
      }
      for (const { id, nivel } of mudanca.atualizar) {
        await tx.acessoSetor.update({ where: { id }, data: { nivel } });
      }
      if (mudanca.criar.length > 0) {
        await tx.acessoSetor.createMany({
          data: mudanca.criar.map((acesso) => ({
            areaDono: setor.chave,
            area: acesso.area,
            usuarioId: acesso.usuarioId,
            nivel: acesso.nivel,
          })),
        });
      }
      const antes = resumoDosAcessos(gravados);
      const depois = resumoDosAcessos(pedidos);
      if (JSON.stringify(antes) !== JSON.stringify(depois)) {
        await this.auditoria.registrar(tx, {
          acao: 'setor.acessos_alterados',
          entidade: 'setor',
          entidadeId: setor.chave,
          resumo: `Acessos do setor ${setor.nome} alterados (${depois.length} na lista)`,
          dados: {
            alteracoes: { acessos: { antes, depois } },
            incluidos: mudanca.criar.map(chaveDoAlvo),
            removidos: gravados
              .filter(({ id }) => mudanca.remover.includes(id))
              .map(chaveDoAlvo),
          },
        });
      }
      return this.acessosDoSetor(tx, setor);
    });
    esquecerAcessosDaRequisicao();
    return resposta;
  }

  /** O setor, para Admin, C-level e líderes dele (os demais: 403). */
  private async obterParaAcessos(
    tx: Tx,
    usuario: UsuarioAutenticado,
    chave: Area,
  ): Promise<Setor> {
    const setor = await this.obter(tx, chave);
    if (!ehDiretoria(usuario.papel) && !ehLiderDoSetor(usuario, setor.chave)) {
      throw new SemPermissaoException(
        `Só o Admin, o C-level e os líderes de ${setor.nome} configuram quem mais vê os funis do setor.`,
        { regra: 'R5.11' },
      );
    }
    return setor;
  }

  private async acessosDoSetor(
    db: Tx,
    setor: Setor,
  ): Promise<AcessosDoSetorDto> {
    const acessos = await db.acessoSetor.findMany({
      where: { areaDono: setor.chave },
      include: INCLUIR_ALVO_DO_ACESSO,
      // Estável: as linhas gravadas juntas (mesmo PUT) têm o mesmo `criadoEm`.
      orderBy: [
        { criadoEm: 'asc' },
        { area: { sort: 'asc', nulls: 'last' } },
        { usuario: { nome: 'asc' } },
        { id: 'asc' },
      ],
    });
    return {
      area: setor.chave,
      nomeSetor: setor.nome,
      acessos: acessos.map((acesso) => AcessoDto.de(acesso)),
    };
  }

  // -------------------------------------------------------------------------

  private async obter(tx: Tx, chave: Area): Promise<Setor> {
    const setor = await tx.setor.findUnique({ where: { chave } });
    if (!setor) {
      throw new NaoEncontradoException('Setor não encontrado.');
    }
    return setor;
  }

  /** R1.8: nome único entre os ativos, sem diferenciar maiúsculas nem acentos. */
  private exigirNomeLivre(
    setores: readonly Setor[],
    nome: string,
    exceto?: Area,
  ): void {
    const procurado = nomeNormalizado(nome);
    const repetido = setores.find(
      (setor) =>
        setor.ativo &&
        setor.chave !== exceto &&
        nomeNormalizado(setor.nome) === procurado,
    );
    if (repetido) {
      throw new ConflitoException(
        `Já existe um setor ativo chamado "${repetido.nome}".`,
        { regra: 'R1.8', campos: ['nome'], chave: repetido.chave },
      );
    }
  }

  private async montar(
    db: PrismaService | Tx,
    setores: readonly Setor[],
    gestao: boolean,
  ): Promise<SetorDto[]> {
    const chaves = setores.map((setor) => setor.chave);
    const [lideres, usuarios, funis] = gestao
      ? await Promise.all([
          db.usuario.findMany({
            where: { area: { in: chaves }, papel: 'LIDER', ativo: true },
            select: SELECAO_RESUMO,
            orderBy: [{ nome: 'asc' }, { id: 'asc' }],
          }),
          db.usuario.groupBy({
            by: ['area'],
            where: { area: { in: chaves }, ativo: true },
            _count: { _all: true },
          }),
          db.funil.groupBy({
            by: ['area'],
            where: { area: { in: chaves }, ativo: true, excluidoEm: null },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];
    return setores.map((setor) => ({
      chave: setor.chave,
      nome: setor.nome,
      descricao: setor.descricao,
      cor: setor.cor,
      base: setor.base,
      ativo: setor.ativo,
      ordem: setor.ordem,
      criadoEm: setor.criadoEm.toISOString(),
      atualizadoEm: setor.atualizadoEm.toISOString(),
      lideres: gestao
        ? lideres
            .filter((lider) => lider.area === setor.chave)
            .map((lider) => UsuarioResumoDto.de(lider))
        : null,
      contagens: gestao
        ? {
            usuariosAtivos:
              usuarios.find((linha) => linha.area === setor.chave)?._count
                ._all ?? 0,
            funisAtivos:
              funis.find((linha) => linha.area === setor.chave)?._count._all ??
              0,
          }
        : null,
    }));
  }
}
