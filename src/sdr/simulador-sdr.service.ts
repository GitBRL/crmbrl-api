/**
 * Simulador do SDR (R31): conversa com a IA usando a configuração atual, sem
 * canal e sem gravar no contato (não existe contato). Não guarda estado: a tela
 * manda a conversa até aqui e os critérios descobertos nos turnos anteriores, e
 * recebe a resposta, os critérios, a nota, a temperatura e a ação que a IA
 * tomaria. Os tokens entram no registro (simulador) e contam no orçamento.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import {
  ChamadaClaudeService,
  FalhaDaChamada,
  MENSAGENS_DAS_FALHAS,
  type ObservadorDaChamada,
} from '../bi/analise/chamada-claude.service';
import {
  DadosInvalidosException,
  RegraVioladaException,
  ServicoIndisponivelException,
} from '../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../config/ambiente';
import { PrismaService } from '../prisma/prisma.service';
import { ConfiguracaoSdrService } from './configuracao-sdr.service';
import type { TurnoDoSimuladorSdrDto } from './dto/sdr.dto';
import { conferirTurnoDoSdr } from './esquema-sdr';
import {
  OrcamentoSdrService,
  type UsoDeTokensSdr,
} from './orcamento-sdr.service';
import {
  type ContextoDoTurno,
  mensagensDaConversa,
  montarPedidoDoSdr,
  RESPOSTA_DE_VAZAMENTO_DO_SDR,
  vazaInstrucoesDoSdr,
} from './prompt-sdr';
import {
  avaliarQualificacao,
  interpretarTurno,
  interpretarValor,
  normalizarChave,
  type ValorDescoberto,
} from './qualificacao';
import { AVISO_DO_SIMULADOR, REGRA_SDR } from './sdr.constantes';
import { TransicoesSdrService } from './transicoes-sdr.service';

const OBSERVADOR_NULO: ObservadorDaChamada = {
  aoIniciarTentativa: () => undefined,
  aoMudarDeFase: () => undefined,
  aoReceberTexto: () => undefined,
};

export interface TurnoDoSimulador {
  aviso: string;
  /** O que a IA diria ao lead. */
  resposta: string;
  /** Os critérios que a IA devolveu neste turno, com o que a API fez com cada um. */
  criterios: {
    chave: string;
    rotulo: string | null;
    valor: string;
    confianca: number;
    aceito: boolean;
    motivoDaRecusa: string | null;
  }[];
  /** Os critérios descobertos até agora: devolva em `valores` na próxima chamada. */
  valores: {
    chave: string;
    rotulo: string;
    valor: string;
    confianca: number;
  }[];
  nota: number;
  temperatura: string;
  /** Critérios obrigatórios que ainda faltam. */
  faltamObrigatorios: string[];
  /** `continuar`, `qualificado`, `desqualificado` ou `passar_humano` (já conferida pela API). */
  acao: string;
  /** A ação que a IA pediu (diferente de `acao` quando a API a trocou). */
  acaoPedida: string;
  motivo: string;
  /** Por que a API trocou a ação pedida (nulo = não trocou). */
  motivoDaTroca: string | null;
  resumo: string;
  tokens: UsoDeTokensSdr & { total: number };
  modelo: string;
  /** Versão da base de conhecimento usada. */
  baseVersao: number;
}

@Injectable()
export class SimuladorSdrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuracao: ConfiguracaoSdrService,
    private readonly orcamento: OrcamentoSdrService,
    private readonly transicoes: TransicoesSdrService,
    private readonly chamada: ChamadaClaudeService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  async turno(
    usuario: UsuarioAutenticado,
    dto: TurnoDoSimuladorSdrDto,
  ): Promise<TurnoDoSimulador> {
    if (dto.mensagens.length === 0 || dto.mensagens.at(-1)?.papel !== 'lead') {
      throw new DadosInvalidosException(
        'A última mensagem da conversa precisa ser do lead.',
        {
          campos: [
            { campo: 'mensagens', mensagens: ['a última deve ser do lead'] },
          ],
        },
      );
    }
    if (!this.ambiente.anthropic.configurada) {
      throw new ServicoIndisponivelException(
        'A IA não está configurada neste servidor (falta a chave da Anthropic).',
        { motivo: 'ia_nao_configurada' },
      );
    }
    if (await this.orcamento.esgotado()) {
      throw new RegraVioladaException(
        REGRA_SDR,
        'O orçamento mensal de tokens do SDR acabou. Aumente-o em Configurações → SDR com IA.',
        { motivo: 'orcamento_esgotado' },
      );
    }
    const cfg = await this.configuracao.paraOMotor();
    const { config, regras } = cfg;
    const parametros = {
      notaMinima: config.notaMinimaQualificado,
      faixas: { quente: config.faixaQuente, morno: config.faixaMorno },
      confiancaMinima: regras.confiancaMinima,
    };
    const anteriores = new Map<string, ValorDescoberto>();
    for (const v of dto.valores ?? []) {
      const chave = normalizarChave(v.chave);
      const criterio = cfg.criterios.find((c) => c.chave === chave);
      const interpretado = criterio
        ? interpretarValor(criterio, v.valor)
        : null;
      if (interpretado?.ok) {
        anteriores.set(chave, {
          chave,
          valor: interpretado.valor,
          confianca: v.confianca,
        });
      }
    }
    const antes = avaliarQualificacao(cfg.criterios, anteriores, parametros);
    const mensagensDaIa =
      dto.mensagensDaIa ?? dto.mensagens.filter((m) => m.papel === 'ia').length;
    const contexto: ContextoDoTurno = {
      canal: null,
      nome: null,
      primeiraRespostaDaIa: mensagensDaIa === 0,
      mensagensDaIa,
      origem: 'novo',
      valores: anteriores,
      nota: antes.nota,
      temperatura: antes.temperatura,
      depoisDoLead: [],
    };
    const mensagens = mensagensDaConversa(
      dto.mensagens.map((m) => ({
        papel: m.papel === 'lead' ? 'lead' : 'equipe',
        texto: m.texto,
      })),
    );
    let resultado;
    try {
      resultado = await this.chamada.executar(
        montarPedidoDoSdr(
          {
            config,
            regras,
            criterios: cfg.criterios,
            artigos: cfg.artigos,
            contexto,
          },
          mensagens,
        ),
        OBSERVADOR_NULO,
        conferirTurnoDoSdr,
        new AbortController().signal,
      );
    } catch (erro) {
      if (erro instanceof FalhaDaChamada) {
        // Os tokens gastos em tentativas que falharam também contam.
        await this.registrar(
          usuario,
          erro.uso,
          config.modelo,
          config.baseVersao,
          null,
        );
        throw new ServicoIndisponivelException(
          MENSAGENS_DAS_FALHAS[erro.codigo],
          {
            motivo: erro.codigo,
          },
        );
      }
      throw erro;
    }
    const turno = resultado.valor;
    const interp = interpretarTurno({
      criterios: cfg.criterios,
      anteriores,
      daIa: turno.criterios,
      acao: turno.acao,
      parametros,
    });
    const resposta = vazaInstrucoesDoSdr(turno.resposta)
      ? RESPOSTA_DE_VAZAMENTO_DO_SDR
      : turno.resposta.trim() ||
        (interp.acao === 'PASSAR_HUMANO' ? config.mensagemPassagem : '');
    const criterios = turno.criterios.map((c) => {
      const chave = normalizarChave(c.chave);
      const aceito = interp.aceitos.some((a) => a.chave === chave);
      const recusa = interp.recusados.find((r) => r.chave === chave);
      return {
        chave,
        rotulo: cfg.criterios.find((x) => x.chave === chave)?.rotulo ?? null,
        valor: c.valor,
        confianca: c.confianca,
        aceito,
        motivoDaRecusa: aceito ? null : (recusa?.motivo ?? 'sem mudança'),
      };
    });
    await this.registrar(
      usuario,
      resultado.uso,
      config.modelo,
      config.baseVersao,
      {
        resposta,
        acao: interp.acao,
        motivo: turno.motivo,
        resumo: turno.resumo,
        criterios,
        nota: interp.avaliacao.nota,
        temperatura: interp.avaliacao.temperatura,
        tentativas: resultado.tentativas,
      },
    );
    const u = resultado.uso;
    return {
      aviso: AVISO_DO_SIMULADOR,
      resposta,
      criterios,
      valores: [...interp.valores.values()].map((v) => ({
        chave: v.chave,
        rotulo:
          cfg.criterios.find((c) => c.chave === v.chave)?.rotulo ?? v.chave,
        valor: String(v.valor),
        confianca: v.confianca,
      })),
      nota: interp.avaliacao.nota,
      temperatura: interp.avaliacao.temperatura,
      faltamObrigatorios: interp.avaliacao.faltamObrigatorios,
      acao: interp.acao.toLowerCase(),
      acaoPedida: turno.acao.toLowerCase(),
      motivo: turno.motivo,
      motivoDaTroca: interp.motivoDaTroca,
      resumo: turno.resumo,
      tokens: {
        ...u,
        total: u.entrada + u.saida + u.cacheLeitura + u.cacheEscrita,
      },
      modelo: config.modelo,
      baseVersao: config.baseVersao,
    };
  }

  private async registrar(
    usuario: UsuarioAutenticado,
    uso: UsoDeTokensSdr,
    modelo: string,
    baseVersao: number,
    resultado: {
      resposta: string;
      acao: string;
      motivo: string;
      resumo: string;
      criterios: unknown;
      nota: number;
      temperatura: 'QUENTE' | 'MORNO' | 'FRIO';
      tentativas: number;
    } | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.transicoes.registrarDecisao(tx, {
        conversaId: null,
        tipo: resultado ? 'TURNO' : 'FALHA',
        titulo: resultado
          ? 'Turno do simulador'
          : 'Falha no simulador (tokens gastos)',
        motivo: resultado?.motivo ?? null,
        resumo: resultado?.resumo ?? null,
        resposta: resultado?.resposta ?? null,
        criterios: resultado?.criterios,
        nota: resultado?.nota ?? null,
        temperatura: resultado?.temperatura ?? null,
        modelo,
        baseVersao,
        usuarioId: usuario.id,
        uso,
        tentativas: resultado?.tentativas,
        simulador: true,
        auditar: false,
      });
      await this.orcamento.avisarSeNecessario(tx);
    });
  }
}
