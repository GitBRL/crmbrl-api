/**
 * Configuração do SDR com IA (R31), só Admin: geral (persona, modelo, limites,
 * faixas, regras de passagem), modo por canal, base de conhecimento versionada
 * e critérios de qualificação. Tudo auditado (antes/depois, sem segredos). A
 * primeira leitura cria a linha de configuração e aplica o modelo de captação
 * de alunos (critérios ativos e artigos de exemplo em rascunho).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import type {
  AlvoCriterioSdr,
  ModoSdr,
  Prisma,
  SdrArtigo,
  SdrConfiguracao,
  SdrCriterio,
  TipoCriterioSdr,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import type {
  AtualizarArtigoSdrDto,
  AtualizarConfiguracaoSdrDto,
  AtualizarCriterioSdrDto,
  CriarArtigoSdrDto,
  CriarCriterioSdrDto,
} from './dto/sdr.dto';
import {
  ARTIGOS_DO_MODELO_DE_CAPTACAO,
  CRITERIOS_DO_MODELO_DE_CAPTACAO,
  PERSONA_DO_MODELO_DE_CAPTACAO,
} from './modelo-captacao';
import { type CriterioDoMotor, normalizarChave } from './qualificacao';
import {
  LIMITES_DO_SDR,
  MODELOS_DO_SDR,
  REGRA_SDR,
  REGRAS_DE_PASSAGEM_PADRAO,
  type RegrasDePassagem,
  TIPOS_DE_CANAL_COM_SDR,
} from './sdr.constantes';

const CHAVE_DA_CONFIGURACAO = 'padrao';

export interface ConfiguracaoGeralSdr {
  nomeAssistente: string;
  tom: string;
  apresentacao: string;
  mensagemPassagem: string;
  modelo: string;
  esforco: string;
  esperaAgrupamentoSegundos: number;
  maxMensagensPorConversa: number;
  maxMensagensSemAvanco: number;
  maxTokensPorConversa: number;
  orcamentoMensalTokens: number | null;
  notaMinimaQualificado: number;
  faixaQuente: number;
  faixaMorno: number;
  regrasPassagem: RegrasDePassagem;
  baseVersao: number;
  atualizadoEm: string;
}

export interface CanalDoSdr {
  canalId: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  modo: ModoSdr;
}

export interface ArtigoDoSdr {
  id: string;
  titulo: string;
  conteudo: string;
  ativo: boolean;
  ordem: number;
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
}

export interface VersaoDeArtigoDoSdr {
  numero: number;
  titulo: string;
  conteudo: string;
  ativo: boolean;
  excluido: boolean;
  autorId: string | null;
  criadoEm: string;
}

export interface CriterioDoSdr {
  id: string;
  chave: string;
  rotulo: string;
  instrucao: string;
  tipo: TipoCriterioSdr;
  opcoes: string[];
  alvo: AlvoCriterioSdr;
  campo: string | null;
  peso: number;
  obrigatorio: boolean;
  ordem: number;
  ativo: boolean;
}

/** Tudo que o motor lê da configuração num turno. */
export interface ConfiguracaoParaOMotor {
  config: SdrConfiguracao;
  regras: RegrasDePassagem;
  criterios: CriterioDoMotor[];
  artigos: Pick<SdrArtigo, 'id' | 'titulo' | 'conteudo'>[];
}

function iso(data: Date): string {
  return data.toISOString();
}

export function lerRegras(json: Prisma.JsonValue): RegrasDePassagem {
  const o =
    typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const b = (v: unknown, padrao: boolean) =>
    typeof v === 'boolean' ? v : padrao;
  const confianca =
    typeof o.confiancaMinima === 'number' &&
    o.confiancaMinima >= 0 &&
    o.confiancaMinima <= 1
      ? o.confiancaMinima
      : REGRAS_DE_PASSAGEM_PADRAO.confiancaMinima;
  return {
    pedidoHumano: b(o.pedidoHumano, REGRAS_DE_PASSAGEM_PADRAO.pedidoHumano),
    assuntoSensivel: b(
      o.assuntoSensivel,
      REGRAS_DE_PASSAGEM_PADRAO.assuntoSensivel,
    ),
    baixaConfianca: b(
      o.baixaConfianca,
      REGRAS_DE_PASSAGEM_PADRAO.baixaConfianca,
    ),
    confiancaMinima: confianca,
    semAvanco: b(o.semAvanco, REGRAS_DE_PASSAGEM_PADRAO.semAvanco),
    reclamacao: b(o.reclamacao, REGRAS_DE_PASSAGEM_PADRAO.reclamacao),
  };
}

function geralDe(c: SdrConfiguracao): ConfiguracaoGeralSdr {
  return {
    nomeAssistente: c.nomeAssistente,
    tom: c.tom,
    apresentacao: c.apresentacao,
    mensagemPassagem: c.mensagemPassagem,
    modelo: c.modelo,
    esforco: c.esforco,
    esperaAgrupamentoSegundos: c.esperaAgrupamentoSegundos,
    maxMensagensPorConversa: c.maxMensagensPorConversa,
    maxMensagensSemAvanco: c.maxMensagensSemAvanco,
    maxTokensPorConversa: c.maxTokensPorConversa,
    orcamentoMensalTokens: c.orcamentoMensalTokens,
    notaMinimaQualificado: c.notaMinimaQualificado,
    faixaQuente: c.faixaQuente,
    faixaMorno: c.faixaMorno,
    regrasPassagem: lerRegras(c.regrasPassagem),
    baseVersao: c.baseVersao,
    atualizadoEm: iso(c.atualizadoEm),
  };
}

export function criterioDe(c: SdrCriterio): CriterioDoSdr {
  return {
    id: c.id,
    chave: c.chave,
    rotulo: c.rotulo,
    instrucao: c.instrucao,
    tipo: c.tipo,
    opcoes: c.opcoes,
    alvo: c.alvo,
    campo: c.campo,
    peso: c.peso,
    obrigatorio: c.obrigatorio,
    ordem: c.ordem,
    ativo: c.ativo,
  };
}

export function criterioParaOMotor(c: SdrCriterio): CriterioDoMotor {
  return {
    chave: c.chave,
    rotulo: c.rotulo,
    instrucao: c.instrucao,
    tipo: c.tipo,
    opcoes: c.opcoes,
    alvo: c.alvo,
    campo: c.campo,
    peso: c.peso,
    obrigatorio: c.obrigatorio,
  };
}

function artigoDe(a: SdrArtigo): ArtigoDoSdr {
  return {
    id: a.id,
    titulo: a.titulo,
    conteudo: a.conteudo,
    ativo: a.ativo,
    ordem: a.ordem,
    versao: a.versaoAtual,
    criadoEm: iso(a.criadoEm),
    atualizadoEm: iso(a.atualizadoEm),
  };
}

function campoInvalido(
  campo: string,
  mensagem: string,
): DadosInvalidosException {
  return new DadosInvalidosException(mensagem, {
    campos: [{ campo, mensagens: [mensagem] }],
  });
}

/** Confere o par alvo/campo do critério e devolve o campo normalizado. */
export function validarDestinoDoCriterio(
  alvo: AlvoCriterioSdr,
  campo: string | null | undefined,
): string | null {
  const limpo = campo?.trim() || null;
  if (alvo === 'NENHUM') {
    if (limpo) {
      throw campoInvalido(
        'campo',
        'Sem destino (alvo NENHUM) o campo deve ficar vazio.',
      );
    }
    return null;
  }
  if (!limpo) {
    throw campoInvalido('campo', 'Informe o campo onde gravar o valor.');
  }
  const personalizado = /^campos\.(.{1,100})$/s.exec(limpo);
  if (personalizado) {
    if (Array.from(personalizado[1]).some((c) => c.charCodeAt(0) < 32)) {
      throw campoInvalido('campo', 'O nome do campo tem caracteres inválidos.');
    }
    return `campos.${personalizado[1].trim()}`;
  }
  if (alvo === 'CONTATO' && (limpo === 'nome' || limpo === 'cargo')) {
    return limpo;
  }
  throw campoInvalido(
    'campo',
    alvo === 'CONTATO'
      ? 'No contato, use nome, cargo ou campos.<chave>.'
      : 'No negócio, use campos.<chave>.',
  );
}

function validarOpcoes(
  tipo: TipoCriterioSdr,
  opcoes: string[] | undefined,
): string[] {
  const lista = [
    ...new Set((opcoes ?? []).map((o) => o.trim()).filter(Boolean)),
  ];
  if (tipo === 'OPCAO' && lista.length < 2) {
    throw campoInvalido(
      'opcoes',
      'Um critério de opção precisa de pelo menos 2 opções.',
    );
  }
  return tipo === 'OPCAO' ? lista : [];
}

@Injectable()
export class ConfiguracaoSdrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Configuração geral
  // -------------------------------------------------------------------------

  /**
   * A linha de configuração; a primeira vez cria e aplica o modelo de
   * captação de alunos (nas duas coisas, só se ainda não existir nada).
   */
  async garantir(): Promise<SdrConfiguracao> {
    const existente = await this.prisma.sdrConfiguracao.findUnique({
      where: { chave: CHAVE_DA_CONFIGURACAO },
    });
    if (existente) {
      return existente;
    }
    return this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-configuracao');
      const jaCriada = await tx.sdrConfiguracao.findUnique({
        where: { chave: CHAVE_DA_CONFIGURACAO },
      });
      if (jaCriada) {
        return jaCriada;
      }
      const criada = await tx.sdrConfiguracao.create({
        data: {
          chave: CHAVE_DA_CONFIGURACAO,
          ...PERSONA_DO_MODELO_DE_CAPTACAO,
        },
      });
      await this.aplicarModeloNaTransacao(tx, criada.id, null);
      await this.auditoria.registrar(tx, {
        acao: 'sdr.configuracao-criada',
        entidade: 'sdr_configuracao',
        entidadeId: criada.id,
        resumo:
          'Configuração do SDR com IA criada com o modelo de captação de alunos',
        dados: { regra: REGRA_SDR },
      });
      return tx.sdrConfiguracao.findUniqueOrThrow({ where: { id: criada.id } });
    });
  }

  async geral(): Promise<{
    iaConfigurada: boolean;
    modelosDisponiveis: { id: string; rotulo: string }[];
    configuracao: ConfiguracaoGeralSdr;
  }> {
    const config = await this.garantir();
    return {
      iaConfigurada: this.ambiente.anthropic.configurada,
      modelosDisponiveis: MODELOS_DO_SDR.map((m) => ({
        id: m.id,
        rotulo: m.rotulo,
      })),
      configuracao: geralDe(config),
    };
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    dto: AtualizarConfiguracaoSdrDto,
  ): Promise<ConfiguracaoGeralSdr> {
    await this.garantir();
    const atualizada = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-configuracao');
      const antes = await tx.sdrConfiguracao.findUniqueOrThrow({
        where: { chave: CHAVE_DA_CONFIGURACAO },
      });
      const { regrasPassagem, ...simples } = dto;
      const regras = regrasPassagem
        ? { ...lerRegras(antes.regrasPassagem), ...definidos(regrasPassagem) }
        : undefined;
      const quente = dto.faixaQuente ?? antes.faixaQuente;
      const morno = dto.faixaMorno ?? antes.faixaMorno;
      if (morno >= quente) {
        throw campoInvalido(
          'faixaMorno',
          'A faixa morna precisa ser menor que a faixa quente.',
        );
      }
      const dados: Prisma.SdrConfiguracaoUpdateInput = {
        ...definidos(simples),
        ...(regras
          ? { regrasPassagem: regras as unknown as Prisma.InputJsonObject }
          : {}),
        atualizadoPorId: usuario.id,
      };
      const depois = await tx.sdrConfiguracao.update({
        where: { id: antes.id },
        data: dados,
      });
      const alteracoes = calcularAlteracoes(
        { ...antes, regrasPassagem: lerRegras(antes.regrasPassagem) },
        { ...depois, regrasPassagem: lerRegras(depois.regrasPassagem) },
        [
          'nomeAssistente',
          'tom',
          'apresentacao',
          'mensagemPassagem',
          'modelo',
          'esforco',
          'esperaAgrupamentoSegundos',
          'maxMensagensPorConversa',
          'maxMensagensSemAvanco',
          'maxTokensPorConversa',
          'orcamentoMensalTokens',
          'notaMinimaQualificado',
          'faixaQuente',
          'faixaMorno',
          'regrasPassagem',
        ],
      );
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'sdr.configuracao-atualizada',
          entidade: 'sdr_configuracao',
          entidadeId: depois.id,
          resumo: `Configuração do SDR com IA alterada: ${Object.keys(alteracoes).join(', ')}`,
          dados: { regra: REGRA_SDR, alteracoes },
        });
      }
      return depois;
    });
    return geralDe(atualizada);
  }

  // -------------------------------------------------------------------------
  // Canais
  // -------------------------------------------------------------------------

  async canais(): Promise<CanalDoSdr[]> {
    const canais = await this.prisma.canal.findMany({
      where: {
        excluidoEm: null,
        tipo: { in: [...TIPOS_DE_CANAL_COM_SDR] },
      },
      include: { sdr: { select: { modo: true } } },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }],
    });
    return canais.map((c) => ({
      canalId: c.id,
      nome: c.nome,
      tipo: c.tipo,
      ativo: c.ativo,
      modo: c.sdr?.modo ?? 'DESLIGADO',
    }));
  }

  async definirModo(
    usuario: UsuarioAutenticado,
    canalId: string,
    modo: ModoSdr,
  ): Promise<CanalDoSdr> {
    await this.garantir();
    await this.prisma.$transaction(async (tx) => {
      const canal = await tx.canal.findFirst({
        where: { id: canalId, excluidoEm: null },
        include: { sdr: true },
      });
      if (!canal) {
        throw new NaoEncontradoException('Canal não encontrado.');
      }
      if (!TIPOS_DE_CANAL_COM_SDR.includes(canal.tipo)) {
        throw new RegraVioladaException(
          REGRA_SDR,
          'O SDR com IA não atua neste tipo de canal (o e-mail fica de fora).',
          { tipo: canal.tipo },
        );
      }
      const antes = canal.sdr?.modo ?? 'DESLIGADO';
      await tx.sdrCanal.upsert({
        where: { canalId },
        create: { canalId, modo, atualizadoPorId: usuario.id },
        update: { modo, atualizadoPorId: usuario.id },
      });
      if (antes !== modo) {
        await this.auditoria.registrar(tx, {
          acao: 'sdr.canal-configurado',
          entidade: 'canal',
          entidadeId: canalId,
          resumo: `SDR com IA do canal "${canal.nome}": ${antes} → ${modo}`,
          dados: { regra: REGRA_SDR, de: antes, para: modo },
        });
      }
    });
    const [canal] = (await this.canais()).filter((c) => c.canalId === canalId);
    return canal;
  }

  // -------------------------------------------------------------------------
  // Base de conhecimento (versionada)
  // -------------------------------------------------------------------------

  async artigos(): Promise<ArtigoDoSdr[]> {
    await this.garantir();
    const artigos = await this.prisma.sdrArtigo.findMany({
      where: { excluidoEm: null },
      orderBy: [{ ordem: 'asc' }, { titulo: 'asc' }, { id: 'asc' }],
    });
    return artigos.map(artigoDe);
  }

  private async subirBase(tx: Tx): Promise<number> {
    const c = await tx.sdrConfiguracao.update({
      where: { chave: CHAVE_DA_CONFIGURACAO },
      data: { baseVersao: { increment: 1 } },
    });
    return c.baseVersao;
  }

  async criarArtigo(
    usuario: UsuarioAutenticado,
    dto: CriarArtigoSdrDto,
  ): Promise<ArtigoDoSdr> {
    await this.garantir();
    const criado = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-artigos');
      const total = await tx.sdrArtigo.count({ where: { excluidoEm: null } });
      if (total >= LIMITES_DO_SDR.artigos) {
        throw new RegraVioladaException(
          REGRA_SDR,
          `A base de conhecimento aceita até ${LIMITES_DO_SDR.artigos} artigos.`,
        );
      }
      const artigo = await tx.sdrArtigo.create({
        data: {
          titulo: dto.titulo,
          conteudo: dto.conteudo,
          ativo: dto.ativo ?? true,
          ordem: dto.ordem ?? total,
          criadoPorId: usuario.id,
          atualizadoPorId: usuario.id,
          versoes: {
            create: {
              numero: 1,
              titulo: dto.titulo,
              conteudo: dto.conteudo,
              ativo: dto.ativo ?? true,
              autorId: usuario.id,
            },
          },
        },
      });
      const baseVersao = await this.subirBase(tx);
      await this.auditoria.registrar(tx, {
        acao: 'sdr.artigo-criado',
        entidade: 'sdr_artigo',
        entidadeId: artigo.id,
        resumo: `Artigo "${artigo.titulo}" criado na base de conhecimento do SDR`,
        dados: { regra: REGRA_SDR, baseVersao, ativo: artigo.ativo },
      });
      return artigo;
    });
    return artigoDe(criado);
  }

  async atualizarArtigo(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarArtigoSdrDto,
  ): Promise<ArtigoDoSdr> {
    const atualizado = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-artigos');
      const antes = await tx.sdrArtigo.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!antes) {
        throw new NaoEncontradoException('Artigo não encontrado.');
      }
      const dados = definidos({
        titulo: dto.titulo,
        conteudo: dto.conteudo,
        ativo: dto.ativo,
        ordem: dto.ordem,
      });
      const mudouConteudo =
        (dto.titulo !== undefined && dto.titulo !== antes.titulo) ||
        (dto.conteudo !== undefined && dto.conteudo !== antes.conteudo) ||
        (dto.ativo !== undefined && dto.ativo !== antes.ativo);
      if (!mudouConteudo && dto.ordem === antes.ordem) {
        return antes;
      }
      const numero = mudouConteudo ? antes.versaoAtual + 1 : antes.versaoAtual;
      const depois = await tx.sdrArtigo.update({
        where: { id },
        data: { ...dados, versaoAtual: numero, atualizadoPorId: usuario.id },
      });
      if (mudouConteudo) {
        await tx.sdrArtigoVersao.create({
          data: {
            artigoId: id,
            numero,
            titulo: depois.titulo,
            conteudo: depois.conteudo,
            ativo: depois.ativo,
            autorId: usuario.id,
          },
        });
        const baseVersao = await this.subirBase(tx);
        await this.auditoria.registrar(tx, {
          acao: 'sdr.artigo-atualizado',
          entidade: 'sdr_artigo',
          entidadeId: id,
          resumo: `Artigo "${depois.titulo}" atualizado na base de conhecimento do SDR (versão ${numero})`,
          dados: {
            regra: REGRA_SDR,
            baseVersao,
            versao: numero,
            alteracoes: calcularAlteracoes(antes, depois, [
              'titulo',
              'ativo',
              'ordem',
            ]),
            conteudoAlterado: antes.conteudo !== depois.conteudo,
          },
        });
      }
      return depois;
    });
    return artigoDe(atualizado);
  }

  async excluirArtigo(usuario: UsuarioAutenticado, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-artigos');
      const antes = await tx.sdrArtigo.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!antes) {
        throw new NaoEncontradoException('Artigo não encontrado.');
      }
      const numero = antes.versaoAtual + 1;
      await tx.sdrArtigo.update({
        where: { id },
        data: {
          excluidoEm: new Date(),
          ativo: false,
          versaoAtual: numero,
          atualizadoPorId: usuario.id,
        },
      });
      await tx.sdrArtigoVersao.create({
        data: {
          artigoId: id,
          numero,
          titulo: antes.titulo,
          conteudo: antes.conteudo,
          ativo: false,
          excluido: true,
          autorId: usuario.id,
        },
      });
      const baseVersao = await this.subirBase(tx);
      await this.auditoria.registrar(tx, {
        acao: 'sdr.artigo-excluido',
        entidade: 'sdr_artigo',
        entidadeId: id,
        resumo: `Artigo "${antes.titulo}" excluído da base de conhecimento do SDR`,
        dados: { regra: REGRA_SDR, baseVersao },
      });
    });
  }

  async versoesDoArtigo(id: string): Promise<VersaoDeArtigoDoSdr[]> {
    const artigo = await this.prisma.sdrArtigo.findUnique({ where: { id } });
    if (!artigo) {
      throw new NaoEncontradoException('Artigo não encontrado.');
    }
    const versoes = await this.prisma.sdrArtigoVersao.findMany({
      where: { artigoId: id },
      orderBy: { numero: 'desc' },
    });
    return versoes.map((v) => ({
      numero: v.numero,
      titulo: v.titulo,
      conteudo: v.conteudo,
      ativo: v.ativo,
      excluido: v.excluido,
      autorId: v.autorId,
      criadoEm: iso(v.criadoEm),
    }));
  }

  /** Volta o artigo ao conteúdo de uma versão antiga (cria uma versão nova). */
  async restaurarVersao(
    usuario: UsuarioAutenticado,
    id: string,
    numero: number,
  ): Promise<ArtigoDoSdr> {
    const alvo = await this.prisma.sdrArtigoVersao.findUnique({
      where: { artigoId_numero: { artigoId: id, numero } },
    });
    if (!alvo || alvo.excluido) {
      throw new NaoEncontradoException('Versão não encontrada.');
    }
    const atual = await this.prisma.sdrArtigo.findFirst({
      where: { id, excluidoEm: null },
    });
    if (!atual) {
      throw new NaoEncontradoException('Artigo não encontrado.');
    }
    return this.atualizarArtigo(usuario, id, {
      titulo: alvo.titulo,
      conteudo: alvo.conteudo,
      ativo: alvo.ativo,
    });
  }

  // -------------------------------------------------------------------------
  // Critérios
  // -------------------------------------------------------------------------

  async criterios(): Promise<CriterioDoSdr[]> {
    await this.garantir();
    const criterios = await this.prisma.sdrCriterio.findMany({
      where: { excluidoEm: null },
      orderBy: [{ ordem: 'asc' }, { rotulo: 'asc' }, { id: 'asc' }],
    });
    return criterios.map(criterioDe);
  }

  async criarCriterio(
    usuario: UsuarioAutenticado,
    dto: CriarCriterioSdrDto,
  ): Promise<CriterioDoSdr> {
    await this.garantir();
    const chave = normalizarChave(dto.chave);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(chave)) {
      throw campoInvalido(
        'chave',
        'Use letras minúsculas, números e _ (começa com letra, de 2 a 40 caracteres).',
      );
    }
    const tipo = dto.tipo ?? 'TEXTO';
    const alvo = dto.alvo ?? 'NENHUM';
    const opcoes = validarOpcoes(tipo, dto.opcoes);
    const campo = validarDestinoDoCriterio(alvo, dto.campo);
    const criado = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-criterios');
      const total = await tx.sdrCriterio.count({ where: { excluidoEm: null } });
      if (total >= LIMITES_DO_SDR.criterios) {
        throw new RegraVioladaException(
          REGRA_SDR,
          `A qualificação aceita até ${LIMITES_DO_SDR.criterios} critérios.`,
        );
      }
      const repetido = await tx.sdrCriterio.findFirst({
        where: { chave, excluidoEm: null },
        select: { id: true },
      });
      if (repetido) {
        throw new ConflitoException(
          `Já existe um critério com a chave "${chave}".`,
          { chave },
        );
      }
      const criterio = await tx.sdrCriterio.create({
        data: {
          chave,
          rotulo: dto.rotulo,
          instrucao: dto.instrucao,
          tipo,
          opcoes,
          alvo,
          campo,
          peso: dto.peso ?? 10,
          obrigatorio: dto.obrigatorio ?? false,
          ordem: dto.ordem ?? total,
          ativo: dto.ativo ?? true,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'sdr.criterio-criado',
        entidade: 'sdr_criterio',
        entidadeId: criterio.id,
        resumo: `Critério "${criterio.rotulo}" criado no SDR (${criterio.chave})`,
        dados: {
          regra: REGRA_SDR,
          chave,
          tipo,
          alvo,
          campo,
          peso: criterio.peso,
          obrigatorio: criterio.obrigatorio,
          porUsuarioId: usuario.id,
        },
      });
      return criterio;
    });
    return criterioDe(criado);
  }

  async atualizarCriterio(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarCriterioSdrDto,
  ): Promise<CriterioDoSdr> {
    const atualizado = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-criterios');
      const antes = await tx.sdrCriterio.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!antes) {
        throw new NaoEncontradoException('Critério não encontrado.');
      }
      const tipo = dto.tipo ?? antes.tipo;
      const alvo = dto.alvo ?? antes.alvo;
      const opcoes = validarOpcoes(tipo, dto.opcoes ?? antes.opcoes);
      const campo = validarDestinoDoCriterio(
        alvo,
        dto.campo === undefined
          ? dto.alvo === undefined
            ? antes.campo
            : null
          : dto.campo,
      );
      const depois = await tx.sdrCriterio.update({
        where: { id },
        data: {
          ...definidos({
            rotulo: dto.rotulo,
            instrucao: dto.instrucao,
            peso: dto.peso,
            obrigatorio: dto.obrigatorio,
            ordem: dto.ordem,
            ativo: dto.ativo,
          }),
          tipo,
          alvo,
          opcoes,
          campo,
        },
      });
      const alteracoes = calcularAlteracoes(antes, depois, [
        'rotulo',
        'instrucao',
        'tipo',
        'opcoes',
        'alvo',
        'campo',
        'peso',
        'obrigatorio',
        'ordem',
        'ativo',
      ]);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'sdr.criterio-atualizado',
          entidade: 'sdr_criterio',
          entidadeId: id,
          resumo: `Critério "${depois.rotulo}" do SDR alterado: ${Object.keys(alteracoes).join(', ')}`,
          dados: { regra: REGRA_SDR, alteracoes, porUsuarioId: usuario.id },
        });
      }
      return depois;
    });
    return criterioDe(atualizado);
  }

  async excluirCriterio(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const antes = await tx.sdrCriterio.findFirst({
        where: { id, excluidoEm: null },
      });
      if (!antes) {
        throw new NaoEncontradoException('Critério não encontrado.');
      }
      await tx.sdrCriterio.update({
        where: { id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'sdr.criterio-excluido',
        entidade: 'sdr_criterio',
        entidadeId: id,
        resumo: `Critério "${antes.rotulo}" excluído do SDR`,
        dados: {
          regra: REGRA_SDR,
          chave: antes.chave,
          porUsuarioId: usuario.id,
        },
      });
    });
  }

  async reordenarCriterios(
    usuario: UsuarioAutenticado,
    ids: string[],
  ): Promise<CriterioDoSdr[]> {
    await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-criterios');
      const existentes = await tx.sdrCriterio.findMany({
        where: { excluidoEm: null },
        select: { id: true },
      });
      const conhecidos = new Set(existentes.map((c) => c.id));
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !conhecidos.has(id))
      ) {
        throw campoInvalido(
          'ids',
          'A lista tem ids repetidos ou de critérios que não existem.',
        );
      }
      const resto = existentes
        .map((c) => c.id)
        .filter((id) => !ids.includes(id));
      const ordem = [...ids, ...resto];
      for (const [indice, id] of ordem.entries()) {
        await tx.sdrCriterio.update({ where: { id }, data: { ordem: indice } });
      }
      await this.auditoria.registrar(tx, {
        acao: 'sdr.criterios-reordenados',
        entidade: 'sdr_criterio',
        resumo: 'Ordem dos critérios do SDR alterada',
        dados: { regra: REGRA_SDR, porUsuarioId: usuario.id },
      });
    });
    return this.criterios();
  }

  /** Aplica de novo o modelo de captação de alunos: só acrescenta o que falta. */
  async aplicarModelo(
    usuario: UsuarioAutenticado,
  ): Promise<{ criterios: CriterioDoSdr[]; criados: number }> {
    const config = await this.garantir();
    const criados = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'sdr-criterios');
      const n = await this.aplicarModeloNaTransacao(tx, config.id, usuario.id);
      await this.auditoria.registrar(tx, {
        acao: 'sdr.modelo-aplicado',
        entidade: 'sdr_configuracao',
        entidadeId: config.id,
        resumo: `Modelo de captação de alunos aplicado ao SDR (${n} itens novos)`,
        dados: { regra: REGRA_SDR, itens: n },
      });
      return n;
    });
    return { criterios: await this.criterios(), criados };
  }

  /** Acrescenta os critérios e os artigos (em rascunho) do modelo que ainda não existem. */
  private async aplicarModeloNaTransacao(
    tx: Tx,
    configuracaoId: string,
    usuarioId: string | null,
  ): Promise<number> {
    let novos = 0;
    const chaves = new Set(
      (
        await tx.sdrCriterio.findMany({
          where: { excluidoEm: null },
          select: { chave: true },
        })
      ).map((c) => c.chave),
    );
    let ordem = chaves.size;
    for (const modelo of CRITERIOS_DO_MODELO_DE_CAPTACAO) {
      if (chaves.has(modelo.chave)) {
        continue;
      }
      await tx.sdrCriterio.create({ data: { ...modelo, ordem: ordem++ } });
      novos++;
    }
    const titulos = new Set(
      (
        await tx.sdrArtigo.findMany({
          where: { excluidoEm: null },
          select: { titulo: true },
        })
      ).map((a) => a.titulo),
    );
    let ordemArtigo = titulos.size;
    for (const modelo of ARTIGOS_DO_MODELO_DE_CAPTACAO) {
      if (titulos.has(modelo.titulo)) {
        continue;
      }
      await tx.sdrArtigo.create({
        data: {
          titulo: modelo.titulo,
          conteudo: modelo.conteudo,
          // Rascunho: o Admin troca pelos dados reais e ativa.
          ativo: false,
          ordem: ordemArtigo++,
          criadoPorId: usuarioId,
          atualizadoPorId: usuarioId,
          versoes: {
            create: {
              numero: 1,
              titulo: modelo.titulo,
              conteudo: modelo.conteudo,
              ativo: false,
              autorId: usuarioId,
            },
          },
        },
      });
      novos++;
    }
    await tx.sdrConfiguracao.update({
      where: { id: configuracaoId },
      data: { modeloCaptacaoAplicadoEm: new Date() },
    });
    return novos;
  }

  /**
   * Campos em que um critério pode gravar: os fixos do contato e os
   * personalizados que já existem (chaves em uso nos contatos e nos negócios).
   */
  async camposDisponiveis(): Promise<{
    contato: { campo: string; rotulo: string; fixo: boolean }[];
    negocio: { campo: string; rotulo: string; fixo: boolean }[];
  }> {
    const [doContato, doNegocio] = await Promise.all([
      this.prisma.$queryRaw<{ chave: string }[]>`
        SELECT DISTINCT k AS chave
          FROM contatos, LATERAL jsonb_object_keys(campos_personalizados) AS k
         WHERE excluido_em IS NULL
         ORDER BY 1
         LIMIT 300`,
      this.prisma.$queryRaw<{ chave: string }[]>`
        SELECT DISTINCT k AS chave
          FROM negocios, LATERAL jsonb_object_keys(campos_personalizados) AS k
         WHERE excluido_em IS NULL
         ORDER BY 1
         LIMIT 300`,
    ]);
    const configurados = await this.prisma.sdrCriterio.findMany({
      where: { excluidoEm: null, campo: { startsWith: 'campos.' } },
      select: { alvo: true, campo: true },
    });
    const junta = (
      alvo: 'CONTATO' | 'NEGOCIO',
      usados: { chave: string }[],
    ): { campo: string; rotulo: string; fixo: boolean }[] => {
      const chaves = new Set(usados.map((u) => u.chave));
      for (const c of configurados) {
        if (c.alvo === alvo && c.campo) {
          chaves.add(c.campo.slice('campos.'.length));
        }
      }
      return [...chaves]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((chave) => ({
          campo: `campos.${chave}`,
          rotulo: chave,
          fixo: false,
        }));
    };
    return {
      contato: [
        { campo: 'nome', rotulo: 'Nome', fixo: true },
        { campo: 'cargo', rotulo: 'Cargo', fixo: true },
        ...junta('CONTATO', doContato),
      ],
      negocio: junta('NEGOCIO', doNegocio),
    };
  }

  // -------------------------------------------------------------------------
  // Para o motor
  // -------------------------------------------------------------------------

  async paraOMotor(): Promise<ConfiguracaoParaOMotor> {
    const config = await this.garantir();
    const [criterios, artigos] = await Promise.all([
      this.prisma.sdrCriterio.findMany({
        where: { excluidoEm: null, ativo: true },
        orderBy: [{ ordem: 'asc' }, { rotulo: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.sdrArtigo.findMany({
        where: { excluidoEm: null, ativo: true },
        select: { id: true, titulo: true, conteudo: true },
        orderBy: [{ ordem: 'asc' }, { titulo: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      config,
      regras: lerRegras(config.regrasPassagem),
      criterios: criterios.map(criterioParaOMotor),
      artigos,
    };
  }
}

/** Só as chaves com valor (o DTO deixa as ausentes `undefined`). */
function definidos<T extends object>(objeto: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(objeto).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
