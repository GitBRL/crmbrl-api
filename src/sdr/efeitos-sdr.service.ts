/**
 * Efeitos das decisões do SDR sobre a conversa (R31), sempre na transação de
 * quem chama: enviar a resposta como IA, passar a conversa para uma pessoa,
 * desqualificar e qualificar (passagem para o Comercial). São os mesmos no modo
 * automático (o turno aplica na hora) e no modo sugestão (a aprovação aplica).
 */
import { Injectable } from '@nestjs/common';
import { DistribuicaoDaFila } from '../atendimento/distribuicao-fila.service';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Canal,
  Contato,
  Conversa,
  Prisma,
  SdrConversa,
  TemperaturaSdr,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import type { Tx } from '../prisma/prisma.service';
import { type ConfiguracaoParaOMotor } from './configuracao-sdr.service';
import type { CriterioDoMotor } from './qualificacao';
import {
  QualificacaoSdrService,
  rotuloDaTemperatura,
} from './qualificacao-sdr.service';
import {
  EVENTOS_DO_SDR,
  linkDaConversaSdr,
  TIPOS_NOTIFICACAO_SDR,
  TITULO_DESQUALIFICOU_O_LEAD,
  TITULO_PASSOU_PARA_A_EQUIPE,
} from './sdr.constantes';
import {
  MOTIVO_DO_AVISO,
  TransicoesSdrService,
} from './transicoes-sdr.service';

export type ConversaDoSdr = Conversa & {
  canal: Canal;
  contato: Contato;
  fila: { area: 'MARKETING' | 'COMERCIAL' | 'CS' } | null;
};

export interface DadosDoEfeito {
  motivo: string;
  resumo: string;
  nota: number | null;
  temperatura: TemperaturaSdr | null;
  /** Mensagem que acompanha o efeito (já enviada ou não): só para o texto da decisão. */
  respostaEnviada?: boolean;
  /** Quem aprovou (modo sugestão) ou nulo (a IA agiu sozinha). */
  aprovadoPor?: { id: string; nome: string } | null;
}

@Injectable()
export class EfeitosSdrService {
  constructor(
    private readonly motor: MotorDoAtendimento,
    private readonly distribuicao: DistribuicaoDaFila,
    private readonly notificacoes: NotificacoesService,
    private readonly eventos: EventosDominioService,
    private readonly qualificacao: QualificacaoSdrService,
    private readonly transicoes: TransicoesSdrService,
  ) {}

  /**
   * A resposta da IA ao contato, pelo mesmo caminho do Atendimento (mensagem
   * `PENDENTE` + job de envio do canal), com autor `IA`. Atualiza a prévia, tira
   * o "aguardando" e marca as mensagens do contato como atendidas.
   */
  async enviarComoIa(
    tx: Tx,
    conversa: Conversa & { canal: Canal },
    texto: string,
    metadados: Prisma.InputJsonObject,
  ): Promise<string> {
    const criada = await this.motor.criarSaida(tx, conversa, conversa.canal, {
      tipo: 'TEXTO',
      texto,
      autorId: null,
      metadados: { ...metadados, sdr: true },
    });
    const agora = new Date();
    await tx.conversa.update({
      where: { id: conversa.id },
      data: {
        ultimaMensagemId: criada.id,
        ultimaMensagemEm: criada.ocorridaEm ?? agora,
        naoLidas: 0,
        aguardandoDesde: null,
        ...(conversa.primeiraRespostaEm === null &&
        conversa.ultimaEntradaEm !== null
          ? { primeiraRespostaEm: agora }
          : {}),
      },
    });
    await tx.mensagem.updateMany({
      where: { conversaId: conversa.id, direcao: 'ENTRADA', lidaEm: null },
      data: { lidaEm: agora },
    });
    return criada.id;
  }

  private async notaInterna(
    tx: Tx,
    conversa: ConversaDoSdr,
    texto: string,
  ): Promise<void> {
    const nota = await tx.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: conversa.canalId,
        direcao: 'INTERNA',
        tipo: 'TEXTO',
        texto,
        autorTipo: 'IA',
      },
    });
    await this.motor.emitirMensagem(tx, conversa, nota.id);
  }

  /**
   * Passa a conversa para uma pessoa: situação `PASSADA_HUMANO`, nota interna
   * com o resumo e, sem responsável, a distribuição pela fila (aviso ao
   * escolhido). Com responsável (modo sugestão), só avisa quem já cuida dela.
   */
  async passarParaHumano(
    tx: Tx,
    estado: SdrConversa,
    conversa: ConversaDoSdr,
    dados: DadosDoEfeito,
    tipoDaDecisao: 'PASSOU_HUMANO' | 'BLOQUEIO' | 'FALHA' = 'PASSOU_HUMANO',
    tituloDaDecisao?: string,
  ): Promise<void> {
    await tx.sdrConversa.update({
      where: { id: estado.id },
      data: {
        situacao: 'PASSADA_HUMANO',
        motivo: dados.motivo,
        situacaoDesde: new Date(),
        ...(dados.resumo ? { resumo: dados.resumo } : {}),
        execucaoDesde: null,
      },
    });
    await this.transicoes.marcarSugestoesObsoletas(tx, conversa.id);
    const salasAntes = this.motor.salas(conversa);
    let responsavelId = conversa.responsavelId;
    if (!conversa.responsavelId && conversa.filaId) {
      const escolhido = await this.distribuicao.escolher(tx, conversa.filaId);
      if (escolhido) {
        await this.motor.atribuir(tx, conversa, {
          usuarioId: escolhido.id,
          motivo: 'DISTRIBUICAO',
          nota: dados.resumo || null,
          tituloDaNotificacao: 'A IA passou uma conversa para você',
        });
        responsavelId = escolhido.id;
      }
    } else if (conversa.responsavelId) {
      await this.notificacoes.notificar(tx, conversa.responsavelId, {
        tipo: TIPOS_NOTIFICACAO_SDR.PASSOU_PARA_HUMANO,
        titulo: `A IA passou para você: ${conversa.contato.nome}`,
        texto: dados.motivo.slice(0, 300),
        link: linkDaConversaSdr(conversa.id),
        dados: { conversaId: conversa.id },
      });
    }
    const atual = { ...conversa, responsavelId };
    await this.notaInterna(
      tx,
      atual,
      [
        `A IA passou a conversa para a equipe${dados.aprovadoPor ? ` (aprovado por ${dados.aprovadoPor.nome})` : ''}.`,
        `Motivo: ${dados.motivo || 'não informado'}`,
        dados.nota !== null
          ? `Nota ${dados.nota} (${rotuloDaTemperatura(dados.temperatura)}).`
          : '',
        dados.resumo ? `Resumo: ${dados.resumo}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    await this.motor.avisoDeSistema(
      tx,
      atual,
      'A IA passou a conversa para a equipe.',
      { evento: 'sdr_passou_humano' },
    );
    await this.motor.publicarContagens(tx, {
      usuarios: [responsavelId, conversa.responsavelId],
      areas: [conversa.fila?.area],
    });
    await this.transicoes.registrarDecisao(tx, {
      conversaId: conversa.id,
      tipo: tipoDaDecisao,
      acao: 'PASSAR_HUMANO',
      // O motivo (escrito pela IA) vai no campo próprio: o título entra na auditoria, que não se anonimiza.
      titulo: tituloDaDecisao ?? TITULO_PASSOU_PARA_A_EQUIPE,
      motivo: dados.motivo,
      resumo: dados.resumo || null,
      nota: dados.nota,
      temperatura: dados.temperatura,
      modo: estado.modo,
      usuarioId: dados.aprovadoPor?.id ?? contextoAtual().usuario?.id ?? null,
    });
    await this.eventos.publicar(tx, EVENTOS_DO_SDR.PASSOU_PARA_HUMANO, {
      conversaId: conversa.id,
      contatoId: conversa.contatoId,
      responsavelId,
      motivo: dados.motivo,
      resumo: dados.resumo,
    });
    await this.motor.emitirConversa(tx, conversa.id, { salasAntes });
    await this.transicoes.emitir(
      tx,
      conversa.id,
      MOTIVO_DO_AVISO.PASSOU_HUMANO,
    );
  }

  /** Desqualifica: a conversa fica como está, com o motivo, e a IA para. */
  async desqualificar(
    tx: Tx,
    estado: SdrConversa,
    conversa: ConversaDoSdr,
    dados: DadosDoEfeito,
    criterios: readonly CriterioDoMotor[],
  ): Promise<void> {
    await tx.sdrConversa.update({
      where: { id: estado.id },
      data: {
        situacao: 'DESQUALIFICADA',
        motivo: dados.motivo,
        situacaoDesde: new Date(),
        ...(dados.resumo ? { resumo: dados.resumo } : {}),
        execucaoDesde: null,
      },
    });
    await this.transicoes.marcarSugestoesObsoletas(tx, conversa.id);
    await this.notaInterna(
      tx,
      conversa,
      [
        `A IA desqualificou o lead${dados.aprovadoPor ? ` (aprovado por ${dados.aprovadoPor.nome})` : ''}.`,
        `Motivo: ${dados.motivo || 'não informado'}`,
        dados.nota !== null
          ? `Nota ${dados.nota} (${rotuloDaTemperatura(dados.temperatura)}).`
          : '',
        dados.resumo ? `Resumo: ${dados.resumo}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    await this.transicoes.registrarDecisao(tx, {
      conversaId: conversa.id,
      tipo: 'DESQUALIFICADO',
      acao: 'DESQUALIFICADO',
      titulo: TITULO_DESQUALIFICOU_O_LEAD,
      motivo: dados.motivo,
      resumo: dados.resumo || null,
      nota: dados.nota,
      temperatura: dados.temperatura,
      modo: estado.modo,
      usuarioId: dados.aprovadoPor?.id ?? null,
    });
    const negocio = conversa.negocioId
      ? await tx.negocio.findFirst({
          where: { id: conversa.negocioId, excluidoEm: null },
          select: { id: true, titulo: true, funilId: true },
        })
      : await tx.negocio.findFirst({
          where: {
            contatoId: conversa.contatoId,
            status: 'ABERTO',
            excluidoEm: null,
          },
          orderBy: { criadoEm: 'desc' },
          select: { id: true, titulo: true, funilId: true },
        });
    await this.eventos.publicar(
      tx,
      EVENTOS_DO_SDR.LEAD_DESQUALIFICADO,
      await this.qualificacao.dadosDoEventoDoLead(
        tx,
        estado,
        conversa,
        criterios,
        {
          motivo: dados.motivo,
          resumo: dados.resumo,
          nota: dados.nota,
          temperatura: dados.temperatura,
        },
        negocio,
        null,
      ),
    );
    await this.transicoes.emitir(
      tx,
      conversa.id,
      MOTIVO_DO_AVISO.DESQUALIFICADA,
    );
  }

  /** Qualifica: passagem Marketing → Comercial (rodízio) e a conversa para o vendedor. */
  async qualificar(
    tx: Tx,
    estado: SdrConversa,
    conversa: ConversaDoSdr,
    cfg: ConfiguracaoParaOMotor,
    dados: DadosDoEfeito & { nota: number; temperatura: TemperaturaSdr },
  ): Promise<void> {
    const resultado = await this.qualificacao.passarParaOComercial(
      tx,
      estado,
      conversa,
      cfg.criterios,
      cfg.regras.confiancaMinima,
      dados,
    );
    await tx.sdrConversa.update({
      where: { id: estado.id },
      data: {
        situacao: 'QUALIFICADA',
        motivo: dados.motivo,
        situacaoDesde: new Date(),
        qualificadaEm: new Date(),
        negocioId: resultado.negocioId,
        ...(dados.resumo ? { resumo: dados.resumo } : {}),
        execucaoDesde: null,
      },
    });
    await this.transicoes.marcarSugestoesObsoletas(tx, conversa.id);
    await this.transicoes.registrarDecisao(tx, {
      conversaId: conversa.id,
      tipo: 'QUALIFICADO',
      acao: 'QUALIFICADO',
      titulo: resultado.vendedorNome
        ? `Qualificou o lead (nota ${dados.nota}) e passou para ${resultado.vendedorNome} no Comercial`
        : `Qualificou o lead (nota ${dados.nota}) e passou para o Comercial`,
      motivo: dados.motivo,
      resumo: dados.resumo || null,
      nota: dados.nota,
      temperatura: dados.temperatura,
      modo: estado.modo,
      usuarioId: dados.aprovadoPor?.id ?? null,
      // A auditoria desta ação já foi gravada pela passagem (`sdr.lead-qualificado`).
      auditar: false,
    });
    await this.transicoes.emitir(tx, conversa.id, MOTIVO_DO_AVISO.QUALIFICADA);
  }
}
