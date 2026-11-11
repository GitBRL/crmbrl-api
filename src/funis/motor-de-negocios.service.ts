import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  contextoAtual,
  executarComoAtor,
} from '../comum/contexto/contexto-requisicao';
import { formatarValor } from '../comum/dominio/dinheiro';
import type { Utm } from '../comum/dominio/utm';
import {
  ConflitoException,
  DadosInvalidosException,
} from '../comum/erros/excecoes';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  EstrategiaDistribuicao,
  Etapa,
  Funil,
  OrigemContato,
} from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { LogsTecnicosService } from '../logs/logs-tecnicos.service';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../notificacoes/tipos-notificacao';
import type { Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { DistribuicaoService } from './distribuicao.service';
import type { PassagemExecutadaDto } from './dto/negocios.dto';
import {
  formatarDataSemHora,
  INCLUIR_NEGOCIO,
  type NegocioCompleto,
  statusDaEtapa,
} from './negocio-completo';
import { posicaoEntre } from './posicao';

/**
 * Até quantas passagens encadeadas uma movimentação dispara (A → B → C…).
 * Além do índice único por negócio de origem, a mesma passagem nunca roda duas
 * vezes na mesma cadeia: uma configuração em ciclo não vira laço infinito.
 */
export const PROFUNDIDADE_MAXIMA_DE_PASSAGENS = 5;

/** O mínimo do funil que o motor precisa. */
export type FunilDoNegocio = Pick<
  Funil,
  'id' | 'nome' | 'area' | 'visibilidade'
>;

/** Dados já validados de um negócio novo. */
export interface DadosDoNovoNegocio {
  titulo: string;
  contatoId: string;
  empresaId: string | null;
  funil: FunilDoNegocio;
  etapa: Etapa;
  responsavelId: string | null;
  valor: Prisma.Decimal;
  valorRecorrente: Prisma.Decimal | null;
  previsaoFechamento: Date | null;
  /** Obrigatório (e só gravado) se a etapa for de perda (R5.5). */
  motivoPerda: string | null;
  origem: OrigemContato;
  origemDetalhe: string | null;
  utm: Utm | null;
  camposPersonalizados: Record<string, unknown>;
  negocioOrigemId: string | null;
  criadoPorId: string | null;
  /** Vai para os `dados` da auditoria (ex.: a passagem ou a distribuição que criou). */
  detalhesDaCriacao?: Record<string, unknown>;
  /** Importação (R16.14): data de criação na origem (também `etapaDesde` e a entrada no histórico). Padrão: agora. */
  criadoEm?: Date;
  /** Importação: data do ganho ou da perda quando nasce fechado. Padrão: agora. */
  fechadoEm?: Date;
  /** Importação: id do negócio no sistema de origem (índice único parcial). */
  idExterno?: string | null;
}

/** Negócio pedido por uma automação (webhook ou passagem), já validado. */
export interface EntradaDeAutomacao {
  contatoId: string;
  empresaId: string | null;
  funil: FunilDoNegocio;
  etapa: Etapa;
  titulo: string;
  valor: Prisma.Decimal;
  valorRecorrente: Prisma.Decimal | null;
  origem: OrigemContato;
  origemDetalhe: string | null;
  utm: Utm | null;
  estrategia: EstrategiaDistribuicao;
  responsavelFixoId: string | null;
  negocioOrigemId: string | null;
  /** Cria sempre, sem procurar um aberto do contato no funil (integração no modo "criar", R32.3). */
  sempreCriar?: boolean;
  /** Com mais de um aberto, escolhe o mais recente em vez do mais antigo (integrações, R32.3). */
  abertoMaisRecente?: boolean;
  /** Vai para os `dados` da auditoria (ex.: a passagem que pediu). */
  detalhesDaCriacao?: Record<string, unknown>;
  /** Importação (R16.14): ver `DadosDoNovoNegocio`. */
  criadoEm?: Date;
  fechadoEm?: Date;
  idExterno?: string | null;
  /** Importação: nasce fechado, com este motivo se for de perda. */
  motivoPerda?: string | null;
}

export interface ResultadoDeAutomacao {
  negocio: NegocioCompleto;
  /** Um negócio novo foi criado. */
  criado: boolean;
  /** Já havia um aberto do contato no funil: a reconversão foi registrada nele (R5.6). */
  reconversao: boolean;
}

export type PassagemExecutada = PassagemExecutadaDto;

type PassagemParaExecutar = Prisma.PassagemGetPayload<{
  include: { funilDestino: true; etapaDestino: true };
}>;

/** Resumo de etapa que vai na auditoria e nos eventos. */
function resumoDaEtapa(etapa: Pick<Etapa, 'id' | 'nome' | 'tipo'>) {
  return { id: etapa.id, nome: etapa.nome, tipo: etapa.tipo };
}

/**
 * Dados dos eventos `negocio.*` (R9.2): o negócio inteiro, já em JSON (valores
 * em texto decimal, datas em ISO), mais o que a operação acrescentar.
 */
export function dadosDoEventoDeNegocio(
  negocio: NegocioCompleto,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    negocioId: negocio.id,
    funilId: negocio.funilId,
    etapaId: negocio.etapaId,
    negocio: {
      id: negocio.id,
      titulo: negocio.titulo,
      status: negocio.status,
      valor: formatarValor(negocio.valor),
      valorRecorrente: formatarValor(negocio.valorRecorrente),
      previsaoFechamento: formatarDataSemHora(negocio.previsaoFechamento),
      motivoPerda: negocio.motivoPerda,
      ganhoEm: negocio.ganhoEm?.toISOString() ?? null,
      perdidoEm: negocio.perdidoEm?.toISOString() ?? null,
      etapaDesde: negocio.etapaDesde.toISOString(),
      origem: negocio.origem,
      origemDetalhe: negocio.origemDetalhe,
      utm: negocio.utm ?? null,
      reconversoes: negocio.reconversoes,
      negocioOrigemId: negocio.negocioOrigemId,
      funil: {
        id: negocio.funil.id,
        nome: negocio.funil.nome,
        area: negocio.funil.area,
      },
      etapa: resumoDaEtapa(negocio.etapa),
      contato: {
        id: negocio.contato.id,
        nome: negocio.contato.nome,
        email: negocio.contato.email,
        telefone: negocio.contato.telefone,
      },
      empresa: negocio.empresa
        ? { id: negocio.empresa.id, nome: negocio.empresa.nome }
        : null,
      responsavel: negocio.responsavel
        ? { id: negocio.responsavel.id, nome: negocio.responsavel.nome }
        : null,
      criadoEm: negocio.criadoEm.toISOString(),
      atualizadoEm: negocio.atualizadoEm.toISOString(),
    },
    ...extras,
  };
}

/** Entidades ligadas a um negócio, para a linha do tempo (R3.5). */
export function relacionadosDoNegocio(negocio: {
  contatoId: string;
  empresaId: string | null;
  funilId: string;
}) {
  return {
    contato: negocio.contatoId,
    empresa: negocio.empresaId,
    funil: negocio.funilId,
  };
}

/** Rota do front para abrir o negócio no kanban. */
export function linkDoNegocio(negocio: {
  id: string;
  funilId: string;
}): string {
  return `/funis/${negocio.funilId}?negocio=${negocio.id}`;
}

/** 400 de R5.5 (cenário 11 da seção 13): entrar numa etapa de perda exige motivo. */
export function motivoDePerdaObrigatorio(): DadosInvalidosException {
  return new DadosInvalidosException(
    'Informe o motivo da perda para mover o negócio para uma etapa de perda.',
    {
      regra: 'R5.5',
      campos: [
        {
          campo: 'motivoPerda',
          mensagens: ['é obrigatório ao entrar numa etapa de perda'],
        },
      ],
    },
  );
}

/**
 * O núcleo transacional dos negócios: criar, entrar numa etapa, posicionar no
 * kanban, deduplicar para automações (R5.6) e executar as passagens (R5.7).
 * Tudo roda na transação de quem chama, com a auditoria (R3.1), os eventos de
 * domínio (R10.1) e as notificações (R10.2) da mesma operação. Permissões e
 * validação da entrada ficam com quem chama (`NegociosService`).
 */
@Injectable()
export class MotorDeNegociosService {
  constructor(
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly distribuicao: DistribuicaoService,
    private readonly logs: LogsTecnicosService,
  ) {}

  /**
   * Cria o negócio no topo da etapa, com a entrada no histórico (R5.4: `deEtapa`
   * nulo), auditoria `negocio.criado` e os eventos `negocio.criado` (e
   * `negocio.ganho`/`negocio.perdido`, se já nasce fechado). Não notifica nem
   * executa passagens: isso é de quem chama.
   */
  async criar(tx: Tx, dados: DadosDoNovoNegocio): Promise<NegocioCompleto> {
    const contexto = contextoAtual();
    const agora = new Date();
    const criadoEm = dados.criadoEm ?? agora;
    const fechadoEm = dados.fechadoEm ?? agora;
    const status = statusDaEtapa(dados.etapa.tipo);
    const negocio = await tx.negocio.create({
      data: {
        titulo: dados.titulo,
        contatoId: dados.contatoId,
        empresaId: dados.empresaId,
        funilId: dados.funil.id,
        etapaId: dados.etapa.id,
        responsavelId: dados.responsavelId,
        status,
        valor: dados.valor,
        valorRecorrente: dados.valorRecorrente,
        previsaoFechamento: dados.previsaoFechamento,
        motivoPerda: status === 'PERDIDO' ? dados.motivoPerda : null,
        ganhoEm: status === 'GANHO' ? fechadoEm : null,
        perdidoEm: status === 'PERDIDO' ? fechadoEm : null,
        etapaDesde: criadoEm,
        posicao: await this.posicaoNoTopo(tx, dados.etapa.id),
        negocioOrigemId: dados.negocioOrigemId,
        origem: dados.origem,
        origemDetalhe: dados.origemDetalhe,
        utm: dados.utm ? (dados.utm as Prisma.InputJsonObject) : undefined,
        camposPersonalizados:
          dados.camposPersonalizados as Prisma.InputJsonObject,
        criadoPorId: dados.criadoPorId,
        idExterno: dados.idExterno ?? null,
        criadoEm,
        movimentacoes: {
          create: {
            funilId: dados.funil.id,
            deEtapaId: null,
            paraEtapaId: dados.etapa.id,
            usuarioId: contexto.usuario?.id ?? null,
            tipoAtor: contexto.tipoAtor,
            criadoEm,
          },
        },
      },
      include: INCLUIR_NEGOCIO,
    });
    await this.auditoria.registrar(tx, {
      acao: 'negocio.criado',
      entidade: 'negocio',
      entidadeId: negocio.id,
      resumo: `Negócio "${negocio.titulo}" criado em ${negocio.funil.nome} / ${negocio.etapa.nome}`,
      dados: {
        funil: { id: negocio.funil.id, nome: negocio.funil.nome },
        etapa: resumoDaEtapa(negocio.etapa),
        status: negocio.status,
        responsavelId: negocio.responsavelId,
        valor: negocio.valor,
        valorRecorrente: negocio.valorRecorrente,
        origem: negocio.origem,
        origemDetalhe: negocio.origemDetalhe,
        utm: negocio.utm,
        negocioOrigemId: negocio.negocioOrigemId,
        ...dados.detalhesDaCriacao,
      },
      relacionados: relacionadosDoNegocio(negocio),
    });
    await this.eventos.publicar(
      tx,
      'negocio.criado',
      dadosDoEventoDeNegocio(negocio),
    );
    if (status === 'GANHO') {
      await this.eventos.publicar(
        tx,
        'negocio.ganho',
        dadosDoEventoDeNegocio(negocio),
      );
    } else if (status === 'PERDIDO') {
      await this.eventos.publicar(
        tx,
        'negocio.perdido',
        dadosDoEventoDeNegocio(negocio),
      );
    }
    return negocio;
  }

  /**
   * Leva o negócio para outra etapa **do mesmo funil** (R5.4): status pelo tipo
   * da etapa (R5.3), data de ganho ou de perda com motivo (R5.5), histórico com
   * o tempo na etapa anterior, auditoria (`negocio.movido`, `.ganho`,
   * `.perdido` ou `.reaberto`) e os eventos `negocio.movido` +
   * `negocio.ganho`/`negocio.perdido`/`negocio.reaberto`. Quem chama confere
   * permissão, funil e motivo, e depois executa as passagens.
   */
  async entrarNaEtapa(
    tx: Tx,
    atual: NegocioCompleto,
    destino: Etapa,
    opcoes: {
      motivoPerda?: string | null;
      posicao: number;
      /** Importação: data do ganho ou da perda (padrão: agora). */
      fechadoEm?: Date | null;
    },
  ): Promise<NegocioCompleto> {
    const contexto = contextoAtual();
    const agora = new Date();
    const fechadoEm = opcoes.fechadoEm ?? agora;
    const status = statusDaEtapa(destino.tipo);
    const segundos = Math.max(
      0,
      Math.round((agora.getTime() - atual.etapaDesde.getTime()) / 1000),
    );
    const negocio = await tx.negocio.update({
      where: { id: atual.id },
      data: {
        etapaId: destino.id,
        status,
        etapaDesde: agora,
        posicao: opcoes.posicao,
        ganhoEm: status === 'GANHO' ? fechadoEm : null,
        perdidoEm: status === 'PERDIDO' ? fechadoEm : null,
        motivoPerda: status === 'PERDIDO' ? (opcoes.motivoPerda ?? null) : null,
      },
      include: INCLUIR_NEGOCIO,
    });
    await tx.negocioMovimentacao.create({
      data: {
        negocioId: negocio.id,
        funilId: negocio.funilId,
        deEtapaId: atual.etapaId,
        paraEtapaId: destino.id,
        usuarioId: contexto.usuario?.id ?? null,
        tipoAtor: contexto.tipoAtor,
        segundosNaEtapaAnterior: segundos,
        criadoEm: agora,
      },
    });
    const reaberto = atual.status !== 'ABERTO' && status === 'ABERTO';
    const de = resumoDaEtapa(atual.etapa);
    const para = resumoDaEtapa(negocio.etapa);
    const acao = reaberto
      ? 'negocio.reaberto'
      : status === 'GANHO'
        ? 'negocio.ganho'
        : status === 'PERDIDO'
          ? 'negocio.perdido'
          : 'negocio.movido';
    const resumo = reaberto
      ? `Negócio "${negocio.titulo}" reaberto em ${para.nome}`
      : status === 'GANHO'
        ? `Negócio "${negocio.titulo}" ganho (${de.nome} → ${para.nome})`
        : status === 'PERDIDO'
          ? `Negócio "${negocio.titulo}" perdido (${de.nome} → ${para.nome}): ${negocio.motivoPerda ?? ''}`
          : `Negócio "${negocio.titulo}" movido de ${de.nome} para ${para.nome}`;
    await this.auditoria.registrar(tx, {
      acao,
      entidade: 'negocio',
      entidadeId: negocio.id,
      resumo,
      dados: {
        deEtapa: de,
        paraEtapa: para,
        segundosNaEtapaAnterior: segundos,
        alteracoes: {
          etapaId: { antes: atual.etapaId, depois: negocio.etapaId },
          ...(atual.status !== negocio.status
            ? { status: { antes: atual.status, depois: negocio.status } }
            : {}),
          ...(atual.motivoPerda !== negocio.motivoPerda
            ? {
                motivoPerda: {
                  antes: atual.motivoPerda,
                  depois: negocio.motivoPerda,
                },
              }
            : {}),
        },
      },
      relacionados: relacionadosDoNegocio(negocio),
    });
    const extras = {
      deEtapa: de,
      paraEtapa: para,
      segundosNaEtapaAnterior: segundos,
    };
    await this.eventos.publicar(
      tx,
      'negocio.movido',
      dadosDoEventoDeNegocio(negocio, extras),
    );
    if (status === 'GANHO') {
      await this.eventos.publicar(
        tx,
        'negocio.ganho',
        dadosDoEventoDeNegocio(negocio, extras),
      );
    } else if (status === 'PERDIDO') {
      await this.eventos.publicar(
        tx,
        'negocio.perdido',
        dadosDoEventoDeNegocio(negocio, extras),
      );
    } else if (reaberto) {
      await this.eventos.publicar(
        tx,
        'negocio.reaberto',
        dadosDoEventoDeNegocio(negocio, extras),
      );
    }
    return negocio;
  }

  /**
   * R5.6: para automações (webhook, passagem), um contato não tem dois negócios
   * **abertos** no mesmo funil. Com um aberto, registra a reconversão nele;
   * senão, distribui (R5.8) e cria. Uma trava por contato e funil serializa
   * automações simultâneas do mesmo contato.
   */
  async criarOuReconverter(
    tx: Tx,
    entrada: EntradaDeAutomacao,
  ): Promise<ResultadoDeAutomacao> {
    await travarChave(
      tx,
      'negocio-automatico',
      entrada.contatoId,
      entrada.funil.id,
    );
    const aberto = entrada.sempreCriar
      ? null
      : await this.travarNegocioAberto(
          tx,
          entrada.contatoId,
          entrada.funil.id,
          entrada.abertoMaisRecente ?? false,
        );
    if (aberto) {
      return {
        negocio: await this.registrarReconversao(tx, aberto, entrada),
        criado: false,
        reconversao: true,
      };
    }
    const responsavelId = await this.distribuicao.escolherResponsavel(
      tx,
      entrada.funil,
      entrada.estrategia,
      entrada.responsavelFixoId ?? undefined,
    );
    const negocio = await this.criar(tx, {
      titulo: entrada.titulo,
      contatoId: entrada.contatoId,
      empresaId: entrada.empresaId,
      funil: entrada.funil,
      etapa: entrada.etapa,
      responsavelId,
      valor: entrada.valor,
      valorRecorrente: entrada.valorRecorrente,
      previsaoFechamento: null,
      motivoPerda: entrada.motivoPerda ?? null,
      origem: entrada.origem,
      origemDetalhe: entrada.origemDetalhe,
      utm: entrada.utm,
      camposPersonalizados: {},
      negocioOrigemId: entrada.negocioOrigemId,
      criadoPorId: contextoAtual().usuario?.id ?? null,
      criadoEm: entrada.criadoEm,
      fechadoEm: entrada.fechadoEm,
      idExterno: entrada.idExterno,
      detalhesDaCriacao: {
        distribuicao: {
          estrategia: entrada.estrategia,
          area: entrada.funil.area,
          responsavelId,
        },
        ...entrada.detalhesDaCriacao,
      },
    });
    return { negocio, criado: true, reconversao: false };
  }

  /**
   * O negócio aberto mais antigo do contato no funil, travado até o fim da
   * transação (ou `null`). Uma movimentação simultânea que o feche termina
   * antes, e aí ele deixa de contar como aberto: o Postgres refaz o filtro
   * depois da espera — e, se o primeiro sair, procura de novo.
   */
  private async travarNegocioAberto(
    tx: Tx,
    contatoId: string,
    funilId: string,
    maisRecente = false,
  ): Promise<NegocioCompleto | null> {
    const ordem = maisRecente
      ? Prisma.sql`ORDER BY criado_em DESC, id DESC`
      : Prisma.sql`ORDER BY criado_em, id`;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const [linha] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM negocios
         WHERE contato_id = ${contatoId}::uuid
           AND funil_id = ${funilId}::uuid
           AND status = 'ABERTO'::status_negocio
           AND excluido_em IS NULL
         ${ordem}
         LIMIT 1
           FOR UPDATE`;
      if (linha) {
        return tx.negocio.findUniqueOrThrow({
          where: { id: linha.id },
          include: INCLUIR_NEGOCIO,
        });
      }
      const outro = await tx.negocio.findFirst({
        where: { contatoId, funilId, status: 'ABERTO', excluidoEm: null },
        select: { id: true },
      });
      if (!outro) {
        return null;
      }
    }
    return null;
  }

  private async registrarReconversao(
    tx: Tx,
    aberto: NegocioCompleto,
    entrada: EntradaDeAutomacao,
  ): Promise<NegocioCompleto> {
    const negocio = await tx.negocio.update({
      where: { id: aberto.id },
      data: {
        reconversoes: { increment: 1 },
        ultimaReconversaoEm: new Date(),
      },
      include: INCLUIR_NEGOCIO,
    });
    const origem = {
      origem: entrada.origem,
      origemDetalhe: entrada.origemDetalhe,
      utm: entrada.utm,
    };
    await this.auditoria.registrar(tx, {
      acao: 'negocio.reconvertido',
      entidade: 'negocio',
      entidadeId: negocio.id,
      resumo: `Contato voltou com o negócio "${negocio.titulo}" aberto em ${negocio.funil.nome}: reconversão registrada`,
      dados: {
        regra: 'R5.6',
        ...origem,
        reconversoes: negocio.reconversoes,
        ...entrada.detalhesDaCriacao,
      },
      relacionados: relacionadosDoNegocio(negocio),
    });
    await this.eventos.publicar(
      tx,
      'negocio.reconvertido',
      dadosDoEventoDeNegocio(negocio, { reconversao: origem }),
    );
    return negocio;
  }

  /**
   * R5.7: executa as passagens ativas cujo gatilho é a etapa em que o negócio
   * acabou de entrar, **na transação da movimentação**. Cada passagem roda uma
   * única vez por negócio de origem (índice único + trava); reabrir e ganhar de
   * novo não duplica nada. O negócio criado herda contato, empresa, título,
   * valores e origem/UTM, guarda o vínculo com o de origem, é distribuído pela
   * estratégia da passagem e o responsável é notificado. Roda como `AUTOMACAO`
   * (com o usuário que disparou, para rastrear).
   */
  async executarPassagens(
    tx: Tx,
    origem: NegocioCompleto,
    cadeia: ReadonlySet<string> = new Set(),
  ): Promise<PassagemExecutada[]> {
    if (cadeia.size >= PROFUNDIDADE_MAXIMA_DE_PASSAGENS) {
      return [];
    }
    const passagens = await tx.passagem.findMany({
      where: {
        etapaGatilhoId: origem.etapaId,
        funilOrigemId: origem.funilId,
        ativa: true,
      },
      include: { funilDestino: true, etapaDestino: true },
      orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
    });
    const executadas: PassagemExecutada[] = [];
    for (const passagem of passagens) {
      if (cadeia.has(passagem.id)) {
        continue;
      }
      await travarChave(tx, 'passagem', passagem.id, origem.id);
      const jaExecutada = await tx.passagemExecucao.findUnique({
        where: {
          passagemId_negocioOrigemId: {
            passagemId: passagem.id,
            negocioOrigemId: origem.id,
          },
        },
        select: { id: true },
      });
      if (jaExecutada) {
        continue;
      }
      if (!this.destinoRecebeNegocios(passagem)) {
        await this.logs.aviso(
          'Passagens',
          `Passagem "${passagem.nome}" não executada: o funil ou a etapa de destino não recebe negócios (arquivado, excluído ou etapa fechada).`,
          { passagemId: passagem.id, negocioId: origem.id },
        );
        continue;
      }
      const usuario = contextoAtual().usuario;
      const resultado = await executarComoAtor(
        {
          tipoAtor: 'AUTOMACAO',
          descricao: `Passagem ${passagem.nome}`,
          usuario,
        },
        () => this.executarPassagem(tx, passagem, origem, cadeia),
      );
      executadas.push(...resultado);
    }
    return executadas;
  }

  private destinoRecebeNegocios(passagem: PassagemParaExecutar): boolean {
    return (
      passagem.funilDestino.ativo &&
      passagem.funilDestino.excluidoEm === null &&
      passagem.etapaDestino.funilId === passagem.funilDestinoId &&
      passagem.etapaDestino.tipo === 'ABERTA'
    );
  }

  private async executarPassagem(
    tx: Tx,
    passagem: PassagemParaExecutar,
    origem: NegocioCompleto,
    cadeia: ReadonlySet<string>,
  ): Promise<PassagemExecutada[]> {
    const disparadaPor = contextoAtual().usuario?.id ?? null;
    const resultado = await this.criarOuReconverter(tx, {
      contatoId: origem.contatoId,
      empresaId: origem.empresaId,
      funil: passagem.funilDestino,
      etapa: passagem.etapaDestino,
      titulo: origem.titulo,
      valor: origem.valor,
      valorRecorrente: origem.valorRecorrente,
      origem: origem.origem,
      origemDetalhe: origem.origemDetalhe,
      utm: (origem.utm as Utm | null) ?? null,
      estrategia: passagem.estrategia,
      responsavelFixoId: passagem.responsavelFixoId,
      negocioOrigemId: origem.id,
      detalhesDaCriacao: {
        passagem: { id: passagem.id, nome: passagem.nome },
        negocioOrigemId: origem.id,
      },
    });
    const { negocio } = resultado;
    await tx.passagemExecucao.create({
      data: {
        passagemId: passagem.id,
        negocioOrigemId: origem.id,
        negocioDestinoId: negocio.id,
        reconversao: resultado.reconversao,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'passagem.executada',
      entidade: 'passagem',
      entidadeId: passagem.id,
      resumo: resultado.criado
        ? `Passagem ${passagem.nome}: "${origem.titulo}" seguiu para ${negocio.funil.nome} / ${negocio.etapa.nome}`
        : `Passagem ${passagem.nome}: "${origem.titulo}" já tinha negócio aberto em ${negocio.funil.nome}; reconversão registrada`,
      dados: {
        regra: resultado.criado ? 'R5.7' : 'R5.6',
        negocioOrigemId: origem.id,
        negocioDestinoId: negocio.id,
        funilDestino: { id: negocio.funil.id, nome: negocio.funil.nome },
        reconversao: resultado.reconversao,
        responsavelId: negocio.responsavelId,
      },
      relacionados: {
        negocio: origem.id,
        contato: origem.contatoId,
        empresa: origem.empresaId,
        funil: origem.funilId,
      },
    });
    if (negocio.responsavelId && negocio.responsavelId !== disparadaPor) {
      await this.notificacoes.notificar(tx, negocio.responsavelId, {
        tipo: TIPOS_NOTIFICACAO.PASSAGEM_RECEBIDA,
        titulo: resultado.criado
          ? `Novo negócio vindo de ${origem.funil.nome}`
          : `Contato voltou de ${origem.funil.nome}`,
        texto: resultado.criado
          ? `"${negocio.titulo}" chegou pela passagem ${passagem.nome}.`
          : `"${negocio.titulo}" passou de novo pela passagem ${passagem.nome}; a reconversão foi registrada no negócio aberto.`,
        link: linkDoNegocio(negocio),
        dados: {
          negocioId: negocio.id,
          negocioOrigemId: origem.id,
          passagemId: passagem.id,
          reconversao: resultado.reconversao,
        },
      });
    }
    const executada: PassagemExecutada = {
      passagemId: passagem.id,
      nome: passagem.nome,
      negocioOrigemId: origem.id,
      negocioDestinoId: negocio.id,
      funilDestinoId: negocio.funilId,
      criado: resultado.criado,
      reconversao: resultado.reconversao,
      responsavel: negocio.responsavel
        ? {
            id: negocio.responsavel.id,
            nome: negocio.responsavel.nome,
            avatarUrl: negocio.responsavel.avatarUrl,
          }
        : null,
    };
    // Encadeia: o negócio novo pode ter entrado no gatilho de outra passagem.
    const seguintes = resultado.criado
      ? await this.executarPassagens(
          tx,
          negocio,
          new Set([...cadeia, passagem.id]),
        )
      : [];
    return [executada, ...seguintes];
  }

  // -------------------------------------------------------------------------
  // Posição no kanban (fracionária)
  // -------------------------------------------------------------------------

  /** Posição para o topo da etapa (acima do primeiro cartão). */
  async posicaoNoTopo(
    tx: Tx,
    etapaId: string,
    ignorarNegocioId?: string,
  ): Promise<number> {
    const { _min } = await tx.negocio.aggregate({
      where: {
        etapaId,
        excluidoEm: null,
        ...(ignorarNegocioId ? { id: { not: ignorarNegocioId } } : {}),
      },
      _min: { posicao: true },
    });
    return posicaoEntre(null, _min.posicao) ?? 0;
  }

  /**
   * Posição para o cartão `negocioId` na etapa, logo abaixo de `depoisDeId`
   * e/ou logo acima de `antesDeId` (sem nenhum dos dois: o topo). Sem folga
   * entre os vizinhos, renumera a etapa e calcula de novo.
   */
  async posicaoEntreVizinhos(
    tx: Tx,
    etapaId: string,
    negocioId: string,
    depoisDeId?: string,
    antesDeId?: string,
  ): Promise<number> {
    if (!depoisDeId && !antesDeId) {
      return this.posicaoNoTopo(tx, etapaId, negocioId);
    }
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const { anterior, posterior } = await this.vizinhos(
        tx,
        etapaId,
        negocioId,
        depoisDeId,
        antesDeId,
      );
      const posicao = posicaoEntre(anterior, posterior);
      if (posicao !== null) {
        return posicao;
      }
      await this.renumerarEtapa(tx, etapaId, negocioId);
    }
    throw new ConflitoException(
      'Não foi possível posicionar o cartão. Atualize o quadro e tente de novo.',
    );
  }

  private async vizinhos(
    tx: Tx,
    etapaId: string,
    negocioId: string,
    depoisDeId?: string,
    antesDeId?: string,
  ): Promise<{ anterior: number | null; posterior: number | null }> {
    const naEtapa: Prisma.NegocioWhereInput = {
      etapaId,
      excluidoEm: null,
      id: { not: negocioId },
    };
    const referencia = async (id: string, campo: string) => {
      const encontrado = await tx.negocio.findFirst({
        where: { ...naEtapa, AND: [{ id }] },
        select: { id: true, posicao: true },
      });
      if (!encontrado) {
        throw new DadosInvalidosException(
          'O cartão de referência não está na etapa de destino.',
          {
            campos: [
              {
                campo,
                mensagens: ['deve ser outro negócio da etapa de destino'],
              },
            ],
          },
        );
      }
      return encontrado;
    };
    const seguinte = async (cartao: { id: string; posicao: number }) =>
      (
        await tx.negocio.findFirst({
          where: {
            ...naEtapa,
            OR: [
              { posicao: { gt: cartao.posicao } },
              { posicao: cartao.posicao, id: { gt: cartao.id } },
            ],
          },
          orderBy: [{ posicao: 'asc' }, { id: 'asc' }],
          select: { posicao: true },
        })
      )?.posicao ?? null;
    const anteriorA = async (cartao: { id: string; posicao: number }) =>
      (
        await tx.negocio.findFirst({
          where: {
            ...naEtapa,
            OR: [
              { posicao: { lt: cartao.posicao } },
              { posicao: cartao.posicao, id: { lt: cartao.id } },
            ],
          },
          orderBy: [{ posicao: 'desc' }, { id: 'desc' }],
          select: { posicao: true },
        })
      )?.posicao ?? null;

    if (depoisDeId) {
      const acima = await referencia(depoisDeId, 'depoisDeId');
      if (antesDeId) {
        const abaixo = await referencia(antesDeId, 'antesDeId');
        if (abaixo.posicao >= acima.posicao) {
          return { anterior: acima.posicao, posterior: abaixo.posicao };
        }
      }
      // Sem `antesDeId` (ou incoerente com o de cima): vale o de cima e o seguinte a ele.
      return { anterior: acima.posicao, posterior: await seguinte(acima) };
    }
    const abaixo = await referencia(antesDeId as string, 'antesDeId');
    return { anterior: await anteriorA(abaixo), posterior: abaixo.posicao };
  }

  /** Renumera os cartões da etapa (1, 2, 3…) na ordem atual, menos o que está sendo movido. */
  private async renumerarEtapa(
    tx: Tx,
    etapaId: string,
    negocioId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE negocios AS n
         SET posicao = ordenados.nova
        FROM (SELECT id, row_number() OVER (ORDER BY posicao, id)::double precision AS nova
                FROM negocios
               WHERE etapa_id = ${etapaId}::uuid
                 AND id <> ${negocioId}::uuid) AS ordenados
       WHERE n.id = ordenados.id`;
  }
}
