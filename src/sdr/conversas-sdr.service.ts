/**
 * O SDR nas telas do Atendimento, do contato e do negócio (R31): estado da
 * conversa (situação, qualificação, sugestão pendente, linha do tempo das
 * decisões), "Assumir" e "Devolver para a IA", aprovar ou descartar a sugestão,
 * o cartão de qualificação do contato e do negócio e a lista de decisões do Admin.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConversasService } from '../atendimento/conversas.service';
import { MensagensService } from '../atendimento/mensagens.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  contextoAtual,
  executarComoAtor,
} from '../comum/contexto/contexto-requisicao';
import {
  ConflitoException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { ContatosService } from '../contatos/contatos.service';
import { NegociosService } from '../funis/negocios.service';
import type {
  Prisma,
  SdrConversa,
  SdrDecisao,
  SdrSugestao,
  SdrValor,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfiguracaoSdrService } from './configuracao-sdr.service';
import type {
  AprovarSugestaoSdrDto,
  FiltroDecisoesSdrDto,
} from './dto/sdr.dto';
import { EfeitosSdrService, type ConversaDoSdr } from './efeitos-sdr.service';
import { MotorSdr } from './motor-sdr.service';
import {
  formatarValor,
  type CriterioDoMotor,
  type ValorDeCriterio,
} from './qualificacao';
import { QualificacaoSdrService } from './qualificacao-sdr.service';
import { REGRA_SDR, ROTULO_DA_SITUACAO_SDR } from './sdr.constantes';
import {
  ATOR_DO_SDR,
  MOTIVO_DO_AVISO,
  TransicoesSdrService,
} from './transicoes-sdr.service';

export interface CriterioDaQualificacao {
  chave: string;
  rotulo: string;
  tipo: string;
  obrigatorio: boolean;
  peso: number;
  descoberto: boolean;
  valor: ValorDeCriterio | null;
  valorFormatado: string | null;
  confianca: number | null;
  /** Sempre `IA` hoje. */
  origem: string | null;
  /** Onde foi gravado (`contato:campos.curso`, `negocio:campos.modalidade`) ou nulo. */
  destino: string | null;
  atualizadoEm: string | null;
}

export interface QualificacaoDoSdr {
  conversaId: string;
  situacao: SdrConversa['situacao'];
  rotuloDaSituacao: string;
  nota: number | null;
  temperatura: SdrConversa['temperatura'];
  notaMinima: number;
  faixas: { quente: number; morno: number };
  resumo: string | null;
  motivo: string | null;
  negocioId: string | null;
  criterios: CriterioDaQualificacao[];
  faltamObrigatorios: string[];
  atualizadoEm: string;
}

export interface DecisaoDoSdr {
  id: string;
  conversaId: string | null;
  tipo: SdrDecisao['tipo'];
  acao: SdrDecisao['acao'];
  titulo: string;
  motivo: string | null;
  resumo: string | null;
  resposta: string | null;
  criterios: unknown;
  nota: number | null;
  temperatura: SdrDecisao['temperatura'];
  modo: SdrDecisao['modo'];
  modelo: string | null;
  baseVersao: number | null;
  usuario: { id: string; nome: string } | null;
  tokens: {
    entrada: number;
    saida: number;
    cacheLeitura: number;
    cacheEscrita: number;
  };
  tentativas: number;
  simulador: boolean;
  criadoEm: string;
}

export interface SugestaoDoSdr {
  id: string;
  texto: string;
  acao: SdrSugestao['acao'];
  motivo: string | null;
  resumo: string | null;
  criterios: unknown;
  criadoEm: string;
}

export interface EstadoDoSdrNaConversa {
  conversaId: string;
  /** Nulo = a IA nunca atendeu esta conversa. */
  situacao: SdrConversa['situacao'] | null;
  rotuloDaSituacao: string | null;
  /** A IA está atendendo (selo "IA atendendo"). */
  ativa: boolean;
  modo: SdrConversa['modo'] | null;
  origem: string | null;
  situacaoDesde: string | null;
  humano: { id: string; nome: string } | null;
  mensagensIa: number;
  tokens: {
    entrada: number;
    saida: number;
    cacheLeitura: number;
    cacheEscrita: number;
    total: number;
  };
  qualificacao: QualificacaoDoSdr | null;
  sugestao: SugestaoDoSdr | null;
  decisoes: DecisaoDoSdr[];
  acoes: {
    assumir: boolean;
    devolver: boolean;
    aprovarSugestao: boolean;
    descartarSugestao: boolean;
  };
}

const TOKENS_ZERADOS = {
  entrada: 0,
  saida: 0,
  cacheLeitura: 0,
  cacheEscrita: 0,
};

function decisaoDe(d: SdrDecisao, usuarios: Map<string, string>): DecisaoDoSdr {
  return {
    id: d.id,
    conversaId: d.conversaId,
    tipo: d.tipo,
    acao: d.acao,
    titulo: d.titulo,
    motivo: d.motivo,
    resumo: d.resumo,
    resposta: d.resposta,
    criterios: d.criterios,
    nota: d.nota,
    temperatura: d.temperatura,
    modo: d.modo,
    modelo: d.modelo,
    baseVersao: d.baseVersao,
    usuario:
      d.usuarioId && usuarios.has(d.usuarioId)
        ? { id: d.usuarioId, nome: usuarios.get(d.usuarioId) as string }
        : null,
    tokens: {
      entrada: d.tokensEntrada,
      saida: d.tokensSaida,
      cacheLeitura: d.tokensCacheLeitura,
      cacheEscrita: d.tokensCacheEscrita,
    },
    tentativas: d.tentativas,
    simulador: d.simulador,
    criadoEm: d.criadoEm.toISOString(),
  };
}

@Injectable()
export class ConversasSdrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversas: ConversasService,
    private readonly mensagens: MensagensService,
    private readonly contatos: ContatosService,
    private readonly negocios: NegociosService,
    private readonly configuracao: ConfiguracaoSdrService,
    private readonly qualificacao: QualificacaoSdrService,
    private readonly transicoes: TransicoesSdrService,
    private readonly efeitos: EfeitosSdrService,
    private readonly motorSdr: MotorSdr,
    private readonly motorAtendimento: MotorDoAtendimento,
    private readonly auditoria: AuditoriaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  private async nomesDe(ids: (string | null)[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((id): id is string => !!id))];
    if (unicos.length === 0) {
      return new Map();
    }
    const usuarios = await this.prisma.usuario.findMany({
      where: { id: { in: unicos } },
      select: { id: true, nome: true },
    });
    return new Map(usuarios.map((u) => [u.id, u.nome]));
  }

  /** A qualificação de uma conversa do SDR (critérios configurados + valores descobertos). */
  private async qualificacaoDe(
    estado: SdrConversa,
    criterios: CriterioDoMotor[],
    config: {
      notaMinimaQualificado: number;
      faixaQuente: number;
      faixaMorno: number;
    },
    confiancaMinima: number,
  ): Promise<QualificacaoDoSdr> {
    const valores = await this.prisma.sdrValor.findMany({
      where: { sdrConversaId: estado.id },
    });
    const porChave = new Map<string, SdrValor>(
      valores.map((v) => [v.chave, v]),
    );
    const linhas: CriterioDaQualificacao[] = criterios.map((c) => {
      const v = porChave.get(c.chave);
      const valor = v ? (v.valor as ValorDeCriterio) : null;
      return {
        chave: c.chave,
        rotulo: c.rotulo,
        tipo: c.tipo,
        obrigatorio: c.obrigatorio,
        peso: c.peso,
        descoberto: v !== undefined,
        valor,
        valorFormatado: valor === null ? null : formatarValor(c, valor),
        confianca: v ? Number(v.confianca) : null,
        origem: v?.origem ?? null,
        destino: v?.destino ?? null,
        atualizadoEm: v ? v.atualizadoEm.toISOString() : null,
      };
    });
    // Valores de critérios que o Admin removeu depois continuam visíveis.
    for (const v of valores) {
      if (!criterios.some((c) => c.chave === v.chave)) {
        linhas.push({
          chave: v.chave,
          rotulo: v.rotulo,
          tipo: 'TEXTO',
          obrigatorio: false,
          peso: 0,
          descoberto: true,
          valor: v.valor as ValorDeCriterio,
          valorFormatado: JSON.stringify(v.valor).replace(/^"|"$/g, ''),
          confianca: Number(v.confianca),
          origem: v.origem,
          destino: v.destino,
          atualizadoEm: v.atualizadoEm.toISOString(),
        });
      }
    }
    return {
      conversaId: estado.conversaId,
      situacao: estado.situacao,
      rotuloDaSituacao: ROTULO_DA_SITUACAO_SDR[estado.situacao],
      nota: estado.nota,
      temperatura: estado.temperatura,
      notaMinima: config.notaMinimaQualificado,
      faixas: { quente: config.faixaQuente, morno: config.faixaMorno },
      resumo: estado.resumo,
      motivo: estado.motivo,
      negocioId: estado.negocioId,
      criterios: linhas,
      faltamObrigatorios: linhas
        .filter(
          (l) =>
            l.obrigatorio &&
            (!l.descoberto || (l.confianca ?? 0) < confiancaMinima),
        )
        .map((l) => l.chave),
      atualizadoEm: estado.atualizadoEm.toISOString(),
    };
  }

  /** `GET /sdr/conversas/:id`. */
  async detalhe(
    usuario: UsuarioAutenticado,
    conversaId: string,
  ): Promise<EstadoDoSdrNaConversa> {
    const conversa = await this.conversas.visivel(
      this.prisma,
      usuario,
      conversaId,
    );
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId },
    });
    if (!estado) {
      return {
        conversaId,
        situacao: null,
        rotuloDaSituacao: null,
        ativa: false,
        modo: null,
        origem: null,
        situacaoDesde: null,
        humano: null,
        mensagensIa: 0,
        tokens: { ...TOKENS_ZERADOS, total: 0 },
        qualificacao: null,
        sugestao: null,
        decisoes: [],
        acoes: {
          assumir: false,
          devolver: false,
          aprovarSugestao: false,
          descartarSugestao: false,
        },
      };
    }
    const cfg = await this.configuracao.paraOMotor();
    const [qualificacao, sugestao, decisoes, canal] = await Promise.all([
      this.qualificacaoDe(
        estado,
        cfg.criterios,
        cfg.config,
        cfg.regras.confiancaMinima,
      ),
      this.prisma.sdrSugestao.findFirst({
        where: { conversaId, status: 'PENDENTE' },
        orderBy: { criadoEm: 'desc' },
      }),
      this.prisma.sdrDecisao.findMany({
        where: { conversaId },
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.sdrCanal.findUnique({
        where: { canalId: conversa.canal.id },
        select: { modo: true },
      }),
    ]);
    decisoes.reverse();
    const nomes = await this.nomesDe([
      estado.humanoId,
      ...decisoes.map((d) => d.usuarioId),
    ]);
    const aberta = conversa.status !== 'RESOLVIDA';
    const modoDoCanal = canal?.modo ?? 'DESLIGADO';
    return {
      conversaId,
      situacao: estado.situacao,
      rotuloDaSituacao: ROTULO_DA_SITUACAO_SDR[estado.situacao],
      ativa: estado.situacao === 'ATIVA',
      modo: estado.modo,
      origem: estado.origem,
      situacaoDesde: estado.situacaoDesde.toISOString(),
      humano:
        estado.humanoId && nomes.has(estado.humanoId)
          ? { id: estado.humanoId, nome: nomes.get(estado.humanoId) as string }
          : null,
      mensagensIa: estado.mensagensIa,
      tokens: {
        entrada: estado.tokensEntrada,
        saida: estado.tokensSaida,
        cacheLeitura: estado.tokensCacheLeitura,
        cacheEscrita: estado.tokensCacheEscrita,
        total:
          estado.tokensEntrada +
          estado.tokensSaida +
          estado.tokensCacheLeitura +
          estado.tokensCacheEscrita,
      },
      qualificacao,
      sugestao: sugestao
        ? {
            id: sugestao.id,
            texto: sugestao.texto,
            acao: sugestao.acao,
            motivo: sugestao.motivo,
            resumo: sugestao.resumo,
            criterios: sugestao.criterios,
            criadoEm: sugestao.criadoEm.toISOString(),
          }
        : null,
      decisoes: decisoes.map((d) => decisaoDe(d, nomes)),
      acoes: {
        assumir: aberta && estado.situacao === 'ATIVA',
        devolver:
          aberta &&
          ['HUMANO', 'PASSADA_HUMANO', 'DESQUALIFICADA'].includes(
            estado.situacao,
          ) &&
          modoDoCanal !== 'DESLIGADO' &&
          this.ambiente.anthropic.configurada,
        aprovarSugestao:
          aberta && sugestao !== null && estado.situacao === 'ATIVA',
        descartarSugestao:
          aberta && sugestao !== null && estado.situacao === 'ATIVA',
      },
    };
  }

  /** Cartão de qualificação do contato: a conversa do SDR mais recente dele. */
  async qualificacaoDoContato(
    usuario: UsuarioAutenticado,
    contatoId: string,
  ): Promise<{ qualificacao: QualificacaoDoSdr | null }> {
    await this.contatos.detalhar(usuario, contatoId);
    const estado = await this.prisma.sdrConversa.findFirst({
      where: { conversa: { contatoId } },
      orderBy: { criadoEm: 'desc' },
    });
    return { qualificacao: await this.cartao(estado) };
  }

  /** Cartão de qualificação do negócio: o da conversa que o gerou, senão o do contato. */
  async qualificacaoDoNegocio(
    usuario: UsuarioAutenticado,
    negocioId: string,
  ): Promise<{ qualificacao: QualificacaoDoSdr | null }> {
    const negocio = await this.negocios.detalhar(usuario, negocioId);
    const contatoId = (negocio as { contato?: { id: string } }).contato?.id;
    const direto = await this.prisma.sdrConversa.findFirst({
      where: { OR: [{ negocioId }, { conversa: { negocioId } }] },
      orderBy: { criadoEm: 'desc' },
    });
    const estado =
      direto ??
      (contatoId
        ? await this.prisma.sdrConversa.findFirst({
            where: { conversa: { contatoId } },
            orderBy: { criadoEm: 'desc' },
          })
        : null);
    return { qualificacao: await this.cartao(estado) };
  }

  private async cartao(
    estado: SdrConversa | null,
  ): Promise<QualificacaoDoSdr | null> {
    if (!estado) {
      return null;
    }
    const cfg = await this.configuracao.paraOMotor();
    return this.qualificacaoDe(
      estado,
      cfg.criterios,
      cfg.config,
      cfg.regras.confiancaMinima,
    );
  }

  /** `GET /sdr/decisoes` (Admin): o registro de decisões e de tokens. */
  async decisoes(filtro: FiltroDecisoesSdrDto): Promise<Pagina<DecisaoDoSdr>> {
    const where: Prisma.SdrDecisaoWhereInput = {
      ...(filtro.conversaId ? { conversaId: filtro.conversaId } : {}),
      ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
    };
    const [itens, total] = await Promise.all([
      this.prisma.sdrDecisao.findMany({
        where,
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.sdrDecisao.count({ where }),
    ]);
    const nomes = await this.nomesDe(itens.map((d) => d.usuarioId));
    return montarPagina(
      itens.map((d) => decisaoDe(d, nomes)),
      total,
      filtro,
    );
  }

  // -------------------------------------------------------------------------
  // Assumir e devolver
  // -------------------------------------------------------------------------

  private semEstado(): NaoEncontradoException {
    return new NaoEncontradoException('A IA não atendeu esta conversa.');
  }

  /** "Assumir": a pessoa fica com a conversa e a IA para. */
  async assumir(
    usuario: UsuarioAutenticado,
    conversaId: string,
  ): Promise<EstadoDoSdrNaConversa> {
    const conversa = await this.conversas.visivel(
      this.prisma,
      usuario,
      conversaId,
    );
    this.conversas.exigirEmAberto(conversa);
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId },
    });
    if (!estado) {
      throw this.semEstado();
    }
    if (estado.situacao !== 'ATIVA') {
      throw new ConflitoException('A IA não está atendendo esta conversa.', {
        situacao: estado.situacao,
      });
    }
    if (!conversa.responsavelId) {
      await this.conversas.assumir(usuario, conversaId);
    }
    await this.transicoes.humanoAssumiu(
      conversaId,
      { id: usuario.id, nome: usuario.nome },
      `${usuario.nome} clicou em Assumir.`,
    );
    return this.detalhe(usuario, conversaId);
  }

  /** "Devolver para a IA": a IA retoma a conversa. */
  async devolver(
    usuario: UsuarioAutenticado,
    conversaId: string,
  ): Promise<EstadoDoSdrNaConversa> {
    const conversa = await this.conversas.visivel(
      this.prisma,
      usuario,
      conversaId,
    );
    this.conversas.exigirEmAberto(conversa);
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId },
    });
    if (!estado) {
      throw this.semEstado();
    }
    if (
      !['HUMANO', 'PASSADA_HUMANO', 'DESQUALIFICADA'].includes(estado.situacao)
    ) {
      throw new ConflitoException(
        estado.situacao === 'ATIVA'
          ? 'A IA já está atendendo esta conversa.'
          : 'Esta conversa não pode voltar para a IA.',
        { situacao: estado.situacao },
      );
    }
    const modo =
      (
        await this.prisma.sdrCanal.findUnique({
          where: { canalId: conversa.canal.id },
          select: { modo: true },
        })
      )?.modo ?? 'DESLIGADO';
    if (modo === 'DESLIGADO') {
      throw new RegraVioladaException(
        REGRA_SDR,
        'O SDR com IA está desligado neste canal: ligue-o em Configurações → SDR com IA.',
        { motivo: 'canal_desligado' },
      );
    }
    if (!this.ambiente.anthropic.configurada) {
      throw new RegraVioladaException(
        REGRA_SDR,
        'A IA não está configurada neste servidor (falta a chave da Anthropic).',
        { motivo: 'ia_nao_configurada' },
      );
    }
    await executarComoAtor(
      { ...ATOR_DO_SDR, usuario: contextoAtual().usuario },
      () =>
        this.prisma.$transaction(async (tx) => {
          const atual = await this.transicoes.travarEstado(tx, conversaId);
          if (
            !atual ||
            !['HUMANO', 'PASSADA_HUMANO', 'DESQUALIFICADA'].includes(
              atual.situacao,
            )
          ) {
            throw new ConflitoException(
              'Esta conversa não pode voltar para a IA agora.',
            );
          }
          await tx.sdrConversa.update({
            where: { id: atual.id },
            data: {
              situacao: 'ATIVA',
              modo: modo === 'SUGESTAO' ? 'SUGESTAO' : 'AUTOMATICO',
              origem: 'devolvida',
              mensagensSemAvanco: 0,
              humanoId: null,
              motivo: `${usuario.nome} devolveu a conversa para a IA.`,
              situacaoDesde: new Date(),
              execucaoDesde: null,
            },
          });
          if (modo === 'AUTOMATICO' && conversa.responsavelId) {
            const linha = await tx.conversa.findUniqueOrThrow({
              where: { id: conversaId },
            });
            await this.motorAtendimento.atribuir(tx, linha, {
              usuarioId: null,
              motivo: 'TRANSFERENCIA',
              nota: `Devolvida para a IA por ${usuario.nome}`,
              notificar: false,
            });
          }
          await this.transicoes.registrarDecisao(tx, {
            conversaId,
            tipo: 'DEVOLVIDA',
            titulo: `${usuario.nome} devolveu a conversa para a IA`,
            modo,
            usuarioId: usuario.id,
          });
          await this.motorAtendimento.publicarContagens(tx, {
            usuarios: [conversa.responsavelId],
            areas: [conversa.fila?.area],
          });
          await this.transicoes.emitir(
            tx,
            conversaId,
            MOTIVO_DO_AVISO.DEVOLVIDA,
          );
        }),
    );
    const config = await this.configuracao.garantir();
    const pendentes = await this.prisma.mensagem.count({
      where: {
        conversaId,
        direcao: 'ENTRADA',
        excluidaEm: null,
        ...(estado.processadoAte
          ? { criadoEm: { gt: estado.processadoAte } }
          : {}),
      },
    });
    if (pendentes > 0) {
      await this.motorSdr.enfileirar(
        { conversaId },
        config.esperaAgrupamentoSegundos,
      );
    }
    return this.detalhe(usuario, conversaId);
  }

  // -------------------------------------------------------------------------
  // Sugestões
  // -------------------------------------------------------------------------

  private async sugestaoPendente(
    usuario: UsuarioAutenticado,
    sugestaoId: string,
  ): Promise<SdrSugestao> {
    const sugestao = await this.prisma.sdrSugestao.findUnique({
      where: { id: sugestaoId },
    });
    if (!sugestao) {
      throw new NaoEncontradoException('Sugestão não encontrada.');
    }
    const conversa = await this.conversas.visivel(
      this.prisma,
      usuario,
      sugestao.conversaId,
    );
    this.conversas.exigirEmAberto(conversa);
    if (sugestao.status !== 'PENDENTE') {
      throw new ConflitoException('Esta sugestão já foi resolvida.', {
        status: sugestao.status,
      });
    }
    return sugestao;
  }

  /** Envia a sugestão (ou a versão editada) ao lead e aplica o que a IA propôs. */
  async aprovar(
    usuario: UsuarioAutenticado,
    sugestaoId: string,
    dto: AprovarSugestaoSdrDto,
  ): Promise<EstadoDoSdrNaConversa> {
    const sugestao = await this.sugestaoPendente(usuario, sugestaoId);
    const estado = await this.prisma.sdrConversa.findUnique({
      where: { conversaId: sugestao.conversaId },
    });
    if (!estado || estado.situacao !== 'ATIVA') {
      throw new ConflitoException(
        'A IA não está mais atendendo esta conversa.',
      );
    }
    const texto = dto.texto?.trim() || sugestao.texto;
    const editada = texto !== sugestao.texto;
    const marcada = await this.prisma.sdrSugestao.updateMany({
      where: { id: sugestaoId, status: 'PENDENTE' },
      data: {
        status: 'ENVIADA',
        resolvidaEm: new Date(),
        resolvidaPorId: usuario.id,
      },
    });
    if (marcada.count === 0) {
      throw new ConflitoException('Esta sugestão já foi resolvida.');
    }
    let enviada;
    try {
      enviada = await this.mensagens.enviar(usuario, sugestao.conversaId, {
        texto,
      });
    } catch (erro) {
      await this.prisma.sdrSugestao.updateMany({
        where: { id: sugestaoId, status: 'ENVIADA', mensagemEnviadaId: null },
        data: { status: 'PENDENTE', resolvidaEm: null, resolvidaPorId: null },
      });
      throw erro;
    }
    const cfg = await this.configuracao.paraOMotor();
    await executarComoAtor(
      {
        ...ATOR_DO_SDR,
        descricao: `SDR com IA (aprovado por ${usuario.nome})`,
        usuario: contextoAtual().usuario,
      },
      () =>
        this.prisma.$transaction(async (tx) => {
          await tx.sdrSugestao.update({
            where: { id: sugestaoId },
            data: { mensagemEnviadaId: enviada.id, textoEnviado: texto },
          });
          const atual = await this.transicoes.travarEstado(
            tx,
            sugestao.conversaId,
          );
          if (!atual || atual.situacao !== 'ATIVA') {
            return;
          }
          const conversa = await tx.conversa.findUnique({
            where: { id: sugestao.conversaId },
            include: {
              canal: true,
              contato: true,
              fila: { select: { area: true } },
            },
          });
          if (!conversa) {
            return;
          }
          await tx.sdrConversa.update({
            where: { id: atual.id },
            data: {
              mensagensIa: { increment: 1 },
              ...(atual.primeiraRespostaEm
                ? {}
                : { primeiraRespostaEm: new Date() }),
            },
          });
          await this.qualificacao.escreverNosCampos(
            tx,
            atual,
            conversa.contatoId,
            conversa.negocioId ? [conversa.negocioId] : [],
            cfg.criterios,
            cfg.regras.confiancaMinima,
          );
          await this.transicoes.registrarDecisao(tx, {
            conversaId: conversa.id,
            tipo: 'TURNO',
            acao: sugestao.acao,
            titulo: `${usuario.nome} ${editada ? 'editou e enviou' : 'aprovou e enviou'} a sugestão da IA`,
            motivo: sugestao.motivo,
            resposta: texto,
            modo: 'SUGESTAO',
            usuarioId: usuario.id,
          });
          const comEstado = await tx.sdrConversa.findUniqueOrThrow({
            where: { id: atual.id },
          });
          const dados = {
            motivo: sugestao.motivo ?? '',
            resumo: sugestao.resumo ?? comEstado.resumo ?? '',
            nota: comEstado.nota,
            temperatura: comEstado.temperatura,
            aprovadoPor: { id: usuario.id, nome: usuario.nome },
          };
          const completa = conversa as ConversaDoSdr;
          if (
            sugestao.acao === 'QUALIFICADO' &&
            comEstado.nota !== null &&
            comEstado.temperatura
          ) {
            await this.efeitos.qualificar(tx, comEstado, completa, cfg, {
              ...dados,
              nota: comEstado.nota,
              temperatura: comEstado.temperatura,
            });
          } else if (sugestao.acao === 'DESQUALIFICADO') {
            await this.efeitos.desqualificar(
              tx,
              comEstado,
              completa,
              dados,
              cfg.criterios,
            );
          } else if (sugestao.acao === 'PASSAR_HUMANO') {
            await this.efeitos.passarParaHumano(tx, comEstado, completa, dados);
          } else {
            await this.transicoes.emitir(
              tx,
              conversa.id,
              MOTIVO_DO_AVISO.SUGESTAO_RESOLVIDA,
            );
          }
        }),
    );
    return this.detalhe(usuario, sugestao.conversaId);
  }

  /** Descarta a sugestão (nada é enviado nem aplicado). */
  async descartar(
    usuario: UsuarioAutenticado,
    sugestaoId: string,
  ): Promise<EstadoDoSdrNaConversa> {
    const sugestao = await this.sugestaoPendente(usuario, sugestaoId);
    await executarComoAtor(
      { ...ATOR_DO_SDR, usuario: contextoAtual().usuario },
      () =>
        this.prisma.$transaction(async (tx) => {
          const r = await tx.sdrSugestao.updateMany({
            where: { id: sugestaoId, status: 'PENDENTE' },
            data: {
              status: 'DESCARTADA',
              resolvidaEm: new Date(),
              resolvidaPorId: usuario.id,
            },
          });
          if (r.count === 0) {
            throw new ConflitoException('Esta sugestão já foi resolvida.');
          }
          await this.auditoria.registrar(tx, {
            acao: 'sdr.sugestao-descartada',
            entidade: 'conversa',
            entidadeId: sugestao.conversaId,
            resumo: `${usuario.nome} descartou a sugestão da IA`,
            dados: { regra: REGRA_SDR, sugestaoId, acao: sugestao.acao },
          });
          await this.transicoes.emitir(
            tx,
            sugestao.conversaId,
            MOTIVO_DO_AVISO.SUGESTAO_RESOLVIDA,
          );
        }),
    );
    return this.detalhe(usuario, sugestao.conversaId);
  }
}
