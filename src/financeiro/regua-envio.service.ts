import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { ModelosService } from '../comum/modelos/modelos.service';
import { EmailService } from '../email/email.service';
import { FilaService, type Trabalho } from '../fila/fila.service';
import type {
  Canal,
  Contato,
  Conversa,
  Parcela,
  Prisma,
  ReguaEnvio,
  ReguaEtapa,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { deDataDoBanco, diasEntre, hojeLocal } from './datas';
import {
  CAMPO_NAO_CONTATAR_WHATSAPP,
  DESCRICAO_DO_ATOR_DA_REGUA,
  ETIQUETA_NAO_CONTATAR_WHATSAPP,
  FILA_REGUA_EMAIL,
  FILA_REGUA_WHATSAPP,
  VARIAVEIS_DO_TITULO,
} from './financeiro.constantes';
import { ReguaConfiguracaoService } from './regua-configuracao.service';
import { TempoRealFinanceiro } from './tempo-real-financeiro.service';

export interface PedidoDeEnvioDaRegua {
  envioId: string;
}

/** Erro que não adianta tentar de novo (sem telefone, sem SMTP…). */
class ErroPermanente extends Error {}

/** Tentativas do job (a primeira + retentativas) antes de marcar FALHOU. */
const TENTATIVAS_TOTAIS = 3;

export type ContatoDeCobranca = Pick<
  Contato,
  | 'id'
  | 'nome'
  | 'email'
  | 'telefone'
  | 'etiquetas'
  | 'camposPersonalizados'
  | 'responsavelId'
>;

/** O contato pediu para não ser cobrado por WhatsApp (R24.7)? */
export function naoContatarPorWhatsapp(
  contato: Pick<Contato, 'etiquetas' | 'camposPersonalizados'>,
): boolean {
  if (contato.etiquetas.includes(ETIQUETA_NAO_CONTATAR_WHATSAPP)) return true;
  const campos = contato.camposPersonalizados;
  if (campos && typeof campos === 'object' && !Array.isArray(campos)) {
    const v = (campos as Record<string, unknown>)[CAMPO_NAO_CONTATAR_WHATSAPP];
    return (
      v === true ||
      (typeof v === 'string' &&
        ['true', 'sim', '1', 'yes'].includes(v.trim().toLowerCase()))
    );
  }
  return false;
}

function moeda(v: Prisma.Decimal): string {
  return Number(v.toFixed(2)).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dataBr(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Valores das variáveis `{{titulo.*}}` (R24.1). */
export function variaveisDoTitulo(
  parcela: Pick<
    Parcela,
    | 'numero'
    | 'valor'
    | 'vencimento'
    | 'descricao'
    | 'linkBoleto'
    | 'linkPagamento'
    | 'pix'
    | 'promessaAte'
  >,
  produto: string | null,
  hoje: string = hojeLocal(),
  promessaAte?: string | null,
): Record<string, string> {
  const venc = deDataDoBanco(parcela.vencimento);
  const prom =
    promessaAte ??
    (parcela.promessaAte ? deDataDoBanco(parcela.promessaAte) : null);
  return {
    'titulo.numero': parcela.numero,
    'titulo.valor': moeda(parcela.valor),
    'titulo.vencimento': dataBr(venc),
    'titulo.dias_atraso': String(Math.max(0, diasEntre(venc, hoje))),
    'titulo.descricao': parcela.descricao ?? '',
    'titulo.link_boleto': parcela.linkBoleto ?? '',
    'titulo.link_pagamento': parcela.linkPagamento ?? '',
    'titulo.pix': parcela.pix ?? '',
    'titulo.promessa': prom ? dataBr(prom) : '',
    'contrato.produto': produto ?? '',
  };
}

export interface MensagemPreparada {
  canal: 'WHATSAPP' | 'EMAIL';
  texto: string;
  assunto: string | null;
  destino: string | null;
  /** Motivo de não enviar (sem telefone, não contatar…). */
  pular: string | null;
}

/**
 * Envio das mensagens da régua (R24.4): renderiza os modelos com as variáveis do
 * título, cria o registro (`ReguaEnvio`) e o envia por fila própria — WhatsApp
 * pelo gateway (número do financeiro opcional, intervalo configurável entre
 * mensagens) e e-mail pelo SMTP. O autor é a automação "Régua de cobrança".
 * As respostas dos clientes caem no Atendimento (R24.8).
 */
@Injectable()
export class ReguaEnvioService implements OnModuleInit {
  private readonly logger = new Logger('ReguaDeCobranca');

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly modelos: ModelosService,
    private readonly motor: MotorDoAtendimento,
    private readonly email: EmailService,
    private readonly auditoria: AuditoriaService,
    private readonly configuracao: ReguaConfiguracaoService,
    private readonly tempoReal: TempoRealFinanceiro,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<PedidoDeEnvioDaRegua>(
      FILA_REGUA_WHATSAPP,
      (t) => this.processar('WHATSAPP', t),
      {
        concorrencia: 1,
        intervaloDeConsultaSegundos: 2,
        tentativas: RETENTATIVAS_DA_FILA,
        intervaloEntreTentativasSegundos: 60,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 120,
      },
    );
    await this.fila.trabalhar<PedidoDeEnvioDaRegua>(
      FILA_REGUA_EMAIL,
      (t) => this.processar('EMAIL', t),
      {
        concorrencia: 2,
        intervaloDeConsultaSegundos: 2,
        tentativas: RETENTATIVAS_DA_FILA,
        intervaloEntreTentativasSegundos: 60,
        esperaExponencial: true,
        prazoDeExecucaoSegundos: 120,
      },
    );
  }

  // ---- preparação ----------------------------------------------------------------

  /** Contato a cobrar: o do título, o do contrato ou o primeiro da empresa com telefone ou e-mail. */
  async contatoDeCobranca(
    parcela: Pick<Parcela, 'contatoId' | 'empresaId' | 'contratoId'>,
  ): Promise<ContatoDeCobranca | null> {
    const selecao = {
      id: true,
      nome: true,
      email: true,
      telefone: true,
      etiquetas: true,
      camposPersonalizados: true,
      responsavelId: true,
    } as const;
    let contatoId = parcela.contatoId;
    let empresaId = parcela.empresaId;
    if (!contatoId && parcela.contratoId) {
      const c = await this.prisma.contrato.findUnique({
        where: { id: parcela.contratoId },
        select: { contatoId: true, empresaId: true },
      });
      contatoId = c?.contatoId ?? null;
      empresaId ??= c?.empresaId ?? null;
    }
    if (contatoId) {
      const c = await this.prisma.contato.findFirst({
        where: { id: contatoId, excluidoEm: null },
        select: selecao,
      });
      if (c) return c;
    }
    if (empresaId) {
      return this.prisma.contato.findFirst({
        where: {
          empresaId,
          excluidoEm: null,
          OR: [{ telefone: { not: null } }, { email: { not: null } }],
        },
        orderBy: { criadoEm: 'asc' },
        select: selecao,
      });
    }
    return null;
  }

  /** Texto e assunto de um canal da etapa, renderizados para o título. */
  async prepararDaEtapa(
    etapa: ReguaEtapa,
    canal: 'WHATSAPP' | 'EMAIL',
    parcela: Parcela,
    contato: ContatoDeCobranca,
    produto: string | null,
    hoje: string,
  ): Promise<MensagemPreparada> {
    const modeloId =
      canal === 'WHATSAPP' ? etapa.modeloWhatsappId : etapa.modeloEmailId;
    const modelo = modeloId
      ? await this.prisma.modeloMensagem.findFirst({
          where: { id: modeloId, excluidoEm: null },
        })
      : null;
    const texto =
      modelo?.texto ??
      (canal === 'WHATSAPP' ? etapa.textoWhatsapp : etapa.textoEmail) ??
      '';
    const assunto =
      canal === 'EMAIL'
        ? (modelo?.assunto ?? etapa.assuntoEmail ?? 'Cobrança')
        : null;
    return this.prepararTexto(
      canal,
      texto,
      assunto,
      parcela,
      contato,
      produto,
      hoje,
      `${parcela.id}:${etapa.marco}`,
    );
  }

  async prepararTexto(
    canal: 'WHATSAPP' | 'EMAIL',
    texto: string,
    assunto: string | null,
    parcela: Parcela,
    contato: ContatoDeCobranca,
    produto: string | null,
    hoje: string,
    semente: string,
    promessaAte?: string | null,
  ): Promise<MensagemPreparada> {
    const opcoes = {
      semente,
      extras: variaveisDoTitulo(parcela, produto, hoje, promessaAte),
      variaveisExtras: VARIAVEIS_DO_TITULO,
    };
    const alvo = { contatoId: contato.id };
    const renderizado = (
      await this.modelos.renderizarPara(texto, alvo, opcoes)
    ).texto.trim();
    const assuntoFinal = assunto
      ? (await this.modelos.renderizarPara(assunto, alvo, opcoes)).texto.trim()
      : null;
    let destino: string | null = null;
    let pular: string | null = null;
    if (canal === 'WHATSAPP') {
      if (naoContatarPorWhatsapp(contato)) {
        pular = 'O cliente pediu para não ser contatado por WhatsApp.';
      } else if (!contato.telefone) {
        pular = 'Cliente sem telefone.';
      } else {
        destino = contato.telefone;
      }
    } else if (!contato.email) {
      pular = 'Cliente sem e-mail.';
    } else {
      destino = contato.email;
    }
    return { canal, texto: renderizado, assunto: assuntoFinal, destino, pular };
  }

  /** Põe o envio na fila do canal (na transação de quem criou o registro). */
  async enfileirar(
    tx: Tx,
    envio: Pick<ReguaEnvio, 'id' | 'canal'>,
    executarEm?: Date,
  ): Promise<void> {
    const fila =
      envio.canal === 'EMAIL' ? FILA_REGUA_EMAIL : FILA_REGUA_WHATSAPP;
    await this.fila.enviar<PedidoDeEnvioDaRegua>(
      fila,
      { envioId: envio.id },
      {
        tx,
        ...(executarEm && executarEm.getTime() > Date.now()
          ? { executarEm }
          : {}),
        chaveUnica: `regua:${envio.id}:${executarEm?.getTime() ?? 0}`,
      },
    );
  }

  /** Instante do próximo envio de WhatsApp (escalonado pelo intervalo configurado). */
  async proximoHorarioDeWhatsapp(): Promise<{ proximo: () => Date }> {
    const { intervaloWhatsappSegundos } =
      await this.configuracao.configuracao();
    let contador = 0;
    const base = Date.now();
    return {
      proximo: () =>
        new Date(base + contador++ * intervaloWhatsappSegundos * 1000),
    };
  }

  /**
   * Aviso avulso de promessa (confirmação ou não cumprimento): uma mensagem por
   * canal com destino, agendada na fila. Devolve quantas criou.
   */
  async criarAviso(
    tx: Tx,
    o: {
      parcela: Parcela;
      contato: ContatoDeCobranca;
      produto: string | null;
      tipo: 'PROMESSA_CONFIRMADA' | 'PROMESSA_NAO_CUMPRIDA';
      nome: string;
      texto: string;
      assuntoEmail: string;
      promessaAte: string | null;
      execucaoId: string | null;
      hoje: string;
      agendarWhatsapp: () => Date;
    },
  ): Promise<number> {
    let criadas = 0;
    for (const canal of ['WHATSAPP', 'EMAIL'] as const) {
      const m = await this.prepararTexto(
        canal,
        o.texto,
        canal === 'EMAIL' ? o.assuntoEmail : null,
        o.parcela,
        o.contato,
        o.produto,
        o.hoje,
        `${o.parcela.id}:${o.tipo}`,
        o.promessaAte,
      );
      if (m.pular) continue;
      const agendadoPara =
        canal === 'WHATSAPP' ? o.agendarWhatsapp() : new Date();
      const envio = await tx.reguaEnvio.create({
        data: {
          parcelaId: o.parcela.id,
          ciclo: o.parcela.cicloRegua,
          marco: null,
          etapaNome: o.nome,
          tipo: o.tipo,
          canal,
          situacao: 'AGENDADO',
          dia: new Date(`${o.hoje}T00:00:00.000Z`),
          execucaoId: o.execucaoId,
          destino: m.destino,
          assunto: m.assunto,
          texto: m.texto,
          agendadoPara,
        },
      });
      await this.enfileirar(
        tx,
        envio,
        canal === 'WHATSAPP' ? agendadoPara : undefined,
      );
      criadas++;
    }
    return criadas;
  }

  // ---- processamento (fila) ---------------------------------------------------------

  async processar(
    canal: 'WHATSAPP' | 'EMAIL',
    trabalho: Trabalho<PedidoDeEnvioDaRegua>,
  ): Promise<void> {
    await executarComoAtor(
      { tipoAtor: 'AUTOMACAO', descricao: DESCRICAO_DO_ATOR_DA_REGUA },
      () => this.enviar(canal, trabalho.dados.envioId, trabalho.tentativa),
    );
  }

  async enviar(
    canal: 'WHATSAPP' | 'EMAIL',
    envioId: string,
    tentativa = 1,
  ): Promise<void> {
    const envio = await this.prisma.reguaEnvio.findUnique({
      where: { id: envioId },
      include: { parcela: true },
    });
    if (!envio || envio.situacao !== 'AGENDADO') return;
    const aberta =
      envio.parcela.status === 'ABERTO' || envio.parcela.status === 'ATRASADO';
    if (!aberta) {
      await this.finalizar(envio, 'CANCELADO', {
        motivo: 'Título não está mais em aberto.',
      });
      return;
    }
    if (envio.ciclo !== envio.parcela.cicloRegua) {
      await this.finalizar(envio, 'CANCELADO', {
        motivo: 'Vencimento alterado: a régua recomeçou.',
      });
      return;
    }
    const config = await this.configuracao.configuracao();
    if (config.pausada) {
      // Envios pausados: tenta de novo em 5 minutos, sem gastar tentativa.
      await this.prisma.$transaction((tx) =>
        this.enfileirar(tx, envio, new Date(Date.now() + 5 * 60_000)),
      );
      return;
    }
    try {
      const resultado =
        canal === 'WHATSAPP'
          ? await this.enviarWhatsapp(envio, config.canalWhatsappId)
          : await this.enviarEmail(envio);
      await this.finalizar(envio, 'ENVIADO', resultado);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (erro instanceof ErroPermanente || tentativa >= TENTATIVAS_TOTAIS) {
        await this.finalizar(envio, 'FALHOU', {
          erro: mensagem,
          tentativas: tentativa,
        });
        return;
      }
      await this.prisma.reguaEnvio.update({
        where: { id: envio.id },
        data: { tentativas: tentativa, erro: mensagem },
      });
      throw erro;
    }
  }

  /** Volta os envios que falharam para a fila (R24.4, "Reenviar falhas"). */
  async reenviarFalhas(opcoes: {
    canal?: 'WHATSAPP' | 'EMAIL';
    dia: string;
  }): Promise<number> {
    const falhas = await this.prisma.reguaEnvio.findMany({
      where: {
        situacao: 'FALHOU',
        dia: new Date(`${opcoes.dia}T00:00:00.000Z`),
        canal: opcoes.canal ?? { in: ['WHATSAPP', 'EMAIL'] },
        parcela: { status: { in: ['ABERTO', 'ATRASADO'] } },
      },
    });
    const agenda = await this.proximoHorarioDeWhatsapp();
    await this.prisma.$transaction(async (tx) => {
      for (const e of falhas) {
        await tx.reguaEnvio.update({
          where: { id: e.id },
          data: {
            situacao: 'AGENDADO',
            erro: null,
            tentativas: 0,
            motivo: 'Reenviado',
          },
        });
        await this.enfileirar(
          tx,
          e,
          e.canal === 'WHATSAPP' ? agenda.proximo() : undefined,
        );
      }
      if (falhas.length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'regua.reenvio',
          entidade: 'regua',
          entidadeId: null,
          resumo: `${falhas.length} envios com falha voltaram para a fila da régua`,
          dados: {
            quantidade: falhas.length,
            canal: opcoes.canal ?? null,
            dia: opcoes.dia,
            regra: 'R24.4',
          },
        });
      }
    });
    return falhas.length;
  }

  private async finalizar(
    envio: ReguaEnvio & { parcela: Parcela },
    situacao: 'ENVIADO' | 'FALHOU' | 'CANCELADO',
    extra: {
      mensagemId?: string | null;
      motivo?: string;
      erro?: string;
      tentativas?: number;
      destino?: string;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.reguaEnvio.updateMany({
        where: { id: envio.id, situacao: 'AGENDADO' },
        data: {
          situacao,
          enviadoEm: situacao === 'ENVIADO' ? new Date() : undefined,
          mensagemId: extra.mensagemId ?? undefined,
          motivo: extra.motivo,
          erro: situacao === 'FALHOU' ? extra.erro : null,
          tentativas: extra.tentativas ?? envio.tentativas + 1,
          destino: extra.destino ?? undefined,
        },
      });
      if (r.count === 0) return;
      if (situacao !== 'CANCELADO') {
        await this.auditoria.registrar(tx, {
          acao:
            situacao === 'ENVIADO'
              ? 'regua.mensagem_enviada'
              : 'regua.mensagem_falhou',
          entidade: 'parcela',
          entidadeId: envio.parcelaId,
          resumo:
            situacao === 'ENVIADO'
              ? `Régua: ${envio.etapaNome} enviada por ${envio.canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'} (título ${envio.parcela.numero})`
              : `Régua: falha ao enviar ${envio.etapaNome} por ${envio.canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'} (título ${envio.parcela.numero}): ${extra.erro}`,
          dados: {
            envioId: envio.id,
            canal: envio.canal,
            marco: envio.marco,
            mensagemId: extra.mensagemId ?? null,
            erro: extra.erro ?? null,
            regra: 'R24.4',
          },
          relacionados: {
            ...(envio.parcela.contatoId
              ? { contato: envio.parcela.contatoId }
              : {}),
          },
        });
      }
    });
    this.tempoReal.regua({
      execucaoId: envio.execucaoId,
      status: 'EM_ANDAMENTO',
      resumo: {},
      envioId: envio.id,
      situacao,
    });
  }

  // ---- canais ------------------------------------------------------------------------

  private async enviarEmail(
    envio: ReguaEnvio & { parcela: Parcela },
  ): Promise<{ destino: string }> {
    const para = envio.destino;
    if (!para) throw new ErroPermanente('Cliente sem e-mail.');
    if (!this.email.configurado) {
      throw new ErroPermanente('SMTP não configurado.');
    }
    const r = await this.email.enviar({
      para,
      assunto: envio.assunto ?? 'Cobrança',
      texto: envio.texto ?? '',
    });
    if (!r.enviado) {
      throw new Error('O servidor de e-mail não aceitou a mensagem.');
    }
    return { destino: para };
  }

  private async enviarWhatsapp(
    envio: ReguaEnvio & { parcela: Parcela },
    canalDoFinanceiro: string | null,
  ): Promise<{ mensagemId: string; destino: string }> {
    const contato = await this.prisma.contato.findFirst({
      where: {
        id:
          envio.parcela.contatoId ??
          (await this.contatoDe(envio.parcela)) ??
          '',
        excluidoEm: null,
      },
    });
    if (!contato) throw new ErroPermanente('Contato não encontrado.');
    if (naoContatarPorWhatsapp(contato)) {
      throw new ErroPermanente(
        'O cliente pediu para não ser contatado por WhatsApp.',
      );
    }
    if (!contato.telefone) throw new ErroPermanente('Cliente sem telefone.');
    const canal = await this.escolherCanal(contato.id, canalDoFinanceiro);
    if (!canal) {
      throw new Error(
        canalDoFinanceiro
          ? 'O número de WhatsApp do financeiro está desconectado.'
          : 'Nenhum número de WhatsApp conectado.',
      );
    }
    const mensagemId = await this.prisma.$transaction(async (tx) => {
      await travarChave(tx, 'atendimento-conversa', canal.id, contato.id);
      const repetida = await tx.mensagem.findFirst({
        where: {
          canalId: canal.id,
          metadados: { path: ['reguaEnvioId'], equals: envio.id },
        },
        select: { id: true },
      });
      if (repetida) return repetida.id;
      const conversa = await this.conversaDoContato(tx, canal, contato.id);
      const mensagem = await this.motor.criarSaida(tx, conversa, canal, {
        tipo: 'TEXTO',
        texto: envio.texto && envio.texto !== '' ? envio.texto : null,
        arquivoId: null,
        autorId: null,
        metadados: {
          regua: true,
          reguaEnvioId: envio.id,
          parcelaId: envio.parcelaId,
          etapa: envio.etapaNome,
        } satisfies Prisma.InputJsonObject,
      });
      await tx.conversa.update({
        where: { id: conversa.id },
        data: {
          ultimaMensagemId: mensagem.id,
          ultimaMensagemEm: mensagem.ocorridaEm ?? new Date(),
        },
      });
      return mensagem.id;
    });
    return { mensagemId, destino: contato.telefone };
  }

  private async contatoDe(parcela: Parcela): Promise<string | null> {
    return (await this.contatoDeCobranca(parcela))?.id ?? null;
  }

  /** O número do financeiro (se configurado e conectado); senão o da conversa em aberto; senão o primeiro conectado. */
  private async escolherCanal(
    contatoId: string,
    canalDoFinanceiro: string | null,
  ): Promise<Canal | null> {
    const utilizavel = (
      c: Canal & {
        whatsappNumero: { status: string; pausadoEm: Date | null } | null;
      },
    ) =>
      c.ativo &&
      c.whatsappNumero?.status === 'CONECTADO' &&
      c.whatsappNumero.pausadoEm === null;
    if (canalDoFinanceiro) {
      const c = await this.prisma.canal.findFirst({
        where: { id: canalDoFinanceiro, tipo: 'WHATSAPP', excluidoEm: null },
        include: { whatsappNumero: true },
      });
      return c && utilizavel(c) ? c : null;
    }
    const aberta = await this.prisma.conversa.findFirst({
      where: {
        contatoId,
        status: { not: 'RESOLVIDA' },
        canal: { tipo: 'WHATSAPP', excluidoEm: null },
      },
      include: { canal: { include: { whatsappNumero: true } } },
    });
    if (aberta && utilizavel(aberta.canal)) return aberta.canal;
    const canais = await this.prisma.canal.findMany({
      where: { tipo: 'WHATSAPP', ativo: true, excluidoEm: null },
      include: { whatsappNumero: true },
      orderBy: { criadoEm: 'asc' },
    });
    return canais.find(utilizavel) ?? null;
  }

  /** Conversa em aberto; senão a última sem resposta do cliente; senão uma nova já resolvida (como nos Disparos). */
  private async conversaDoContato(
    tx: Tx,
    canal: Canal,
    contatoId: string,
  ): Promise<Conversa> {
    const aberta = await tx.conversa.findFirst({
      where: { canalId: canal.id, contatoId, status: { not: 'RESOLVIDA' } },
    });
    if (aberta) return aberta;
    const reaproveitavel = await tx.conversa.findFirst({
      where: {
        canalId: canal.id,
        contatoId,
        status: 'RESOLVIDA',
        ultimaEntradaEm: null,
      },
      orderBy: { criadoEm: 'desc' },
    });
    if (reaproveitavel) return reaproveitavel;
    return tx.conversa.create({
      data: {
        canalId: canal.id,
        contatoId,
        filaId: canal.filaPadraoId,
        status: 'RESOLVIDA',
        resolvidaEm: new Date(),
      },
    });
  }
}

const RETENTATIVAS_DA_FILA = TENTATIVAS_TOTAIS - 1;
