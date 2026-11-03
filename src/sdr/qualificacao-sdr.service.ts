/**
 * O que a qualificação do SDR faz no banco (R31), sempre dentro da transação
 * de quem chama e como o ator `IA`:
 *
 * - guarda os valores descobertos (origem IA, confiança) e escreve nos campos
 *   configurados do contato e do negócio, com a auditoria das ações humanas;
 * - passa o lead qualificado para o Comercial pela passagem Marketing →
 *   Comercial (R5.7, rodízio), com nota de resumo e qualificação no negócio,
 *   aviso ao vendedor e a conversa atribuída a ele.
 */
import { Injectable } from '@nestjs/common';
import { dadosDoEvento } from '../atividades/atividades.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ORIGEM_DO_CANAL } from '../atendimento/entrada';
import { MotorDoAtendimento } from '../atendimento/motor-do-atendimento.service';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import {
  CAMPOS_AUDITADOS_DO_CONTATO,
  instantaneoDoContato,
} from '../contatos/instantaneos';
import {
  aplicarPatchDosCampos,
  normalizarTextoCurto,
} from '../contatos/deduplicacao';
import { descreverAlteracoes } from '../contatos/rotulos';
import { TAMANHO_MAXIMO_NOME } from '../contatos/contatos.constantes';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import {
  dadosDoEventoDeNegocio,
  linkDoNegocio,
  relacionadosDoNegocio,
} from '../funis/motor-de-negocios.service';
import { INCLUIR_NEGOCIO } from '../funis/negocio-completo';
import { NegociosService } from '../funis/negocios.service';
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
import {
  type CriterioDoMotor,
  formatarValor,
  type ValorDescoberto,
  type ValorDeCriterio,
} from './qualificacao';
import {
  EVENTOS_DO_SDR,
  REGRA_SDR,
  TIPOS_NOTIFICACAO_SDR,
} from './sdr.constantes';

export interface ResultadoDaPassagemSdr {
  negocioId: string;
  vendedorId: string | null;
  vendedorNome: string | null;
  /** A passagem Marketing → Comercial foi a que criou o negócio (senão, foi direto no Comercial). */
  viaPassagem: boolean;
  funilId: string;
}

export interface DadosDaQualificacao {
  resumo: string;
  motivo: string;
  nota: number;
  temperatura: TemperaturaSdr;
}

const ROTULO_DA_TEMPERATURA: Readonly<Record<TemperaturaSdr, string>> = {
  QUENTE: 'quente',
  MORNO: 'morno',
  FRIO: 'frio',
};

export function rotuloDaTemperatura(t: TemperaturaSdr | null): string {
  return t ? ROTULO_DA_TEMPERATURA[t] : 'sem temperatura';
}

type ConversaDaPassagem = Conversa & { canal: Canal; contato: Contato };

@Injectable()
export class QualificacaoSdrService {
  constructor(
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly negocios: NegociosService,
    private readonly motor: MotorDoAtendimento,
  ) {}

  // -------------------------------------------------------------------------
  // Valores
  // -------------------------------------------------------------------------

  async valoresDoEstado(
    tx: Tx,
    sdrConversaId: string,
  ): Promise<Map<string, ValorDescoberto>> {
    const valores = await tx.sdrValor.findMany({ where: { sdrConversaId } });
    return new Map(
      valores.map((v) => [
        v.chave,
        {
          chave: v.chave,
          valor: v.valor as ValorDeCriterio,
          confianca: Number(v.confianca),
        },
      ]),
    );
  }

  /** Guarda (ou atualiza) os valores descobertos, com origem IA e confiança. */
  async gravarValores(
    tx: Tx,
    estado: SdrConversa,
    aceitos: readonly ValorDescoberto[],
    criterios: readonly CriterioDoMotor[],
    mensagemId: string | null,
  ): Promise<void> {
    const porChave = new Map(criterios.map((c) => [c.chave, c]));
    for (const v of aceitos) {
      const criterio = porChave.get(v.chave);
      if (!criterio) {
        continue;
      }
      await tx.sdrValor.upsert({
        where: {
          sdrConversaId_chave: { sdrConversaId: estado.id, chave: v.chave },
        },
        create: {
          sdrConversaId: estado.id,
          chave: v.chave,
          rotulo: criterio.rotulo,
          valor: v.valor,
          confianca: v.confianca,
          origem: 'IA',
          mensagemId,
        },
        // Valor novo: precisa ser escrito de novo no campo de destino.
        update: {
          rotulo: criterio.rotulo,
          valor: v.valor,
          confianca: v.confianca,
          origem: 'IA',
          mensagemId,
          destino: null,
        },
      });
    }
  }

  /**
   * Escreve nos campos configurados os valores que ainda não foram: no
   * contato (nome, cargo, campos personalizados) e nos negócios `negocioIds`
   * (campos personalizados). Valor de negócio sem negócio ainda fica
   * pendente. Devolve quantos valores foram escritos.
   */
  async escreverNosCampos(
    tx: Tx,
    estado: SdrConversa,
    contatoId: string,
    negocioIds: readonly string[],
    criterios: readonly CriterioDoMotor[],
    confiancaMinima: number,
  ): Promise<number> {
    const pendentes = await tx.sdrValor.findMany({
      where: { sdrConversaId: estado.id, destino: null },
    });
    const porChave = new Map(criterios.map((c) => [c.chave, c]));
    const doContato: { id: string; campo: string; valor: ValorDeCriterio }[] =
      [];
    const doNegocio: { id: string; campo: string; valor: ValorDeCriterio }[] =
      [];
    for (const v of pendentes) {
      const criterio = porChave.get(v.chave);
      if (
        !criterio ||
        !criterio.campo ||
        criterio.alvo === 'NENHUM' ||
        Number(v.confianca) < confiancaMinima
      ) {
        continue;
      }
      const item = {
        id: v.id,
        campo: criterio.campo,
        valor: v.valor as ValorDeCriterio,
      };
      (criterio.alvo === 'CONTATO' ? doContato : doNegocio).push(item);
    }
    let escritos = 0;
    if (doContato.length > 0) {
      escritos += await this.escreverNoContato(tx, contatoId, doContato);
    }
    if (doNegocio.length > 0 && negocioIds.length > 0) {
      for (const negocioId of negocioIds) {
        await this.escreverNoNegocio(tx, negocioId, doNegocio);
      }
      for (const v of doNegocio) {
        await tx.sdrValor.update({
          where: { id: v.id },
          data: { destino: `negocio:${v.campo}` },
        });
      }
      escritos += doNegocio.length;
    }
    return escritos;
  }

  private async escreverNoContato(
    tx: Tx,
    contatoId: string,
    itens: { id: string; campo: string; valor: ValorDeCriterio }[],
  ): Promise<number> {
    await tx.$queryRaw`SELECT id FROM contatos WHERE id = ${contatoId}::uuid FOR UPDATE`;
    const antes = await tx.contato.findFirst({
      where: { id: contatoId, excluidoEm: null },
    });
    if (!antes) {
      return 0;
    }
    const dados: Prisma.ContatoUncheckedUpdateInput = {};
    const personalizados: Record<string, unknown> = {};
    const gravados: typeof itens = [];
    for (const item of itens) {
      if (item.campo === 'nome') {
        const nome = normalizarTextoCurto(item.valor, TAMANHO_MAXIMO_NOME);
        if (nome) {
          dados.nome = nome;
          gravados.push(item);
        }
      } else if (item.campo === 'cargo') {
        const cargo = normalizarTextoCurto(item.valor);
        if (cargo) {
          dados.cargo = cargo;
          gravados.push(item);
        }
      } else if (item.campo.startsWith('campos.')) {
        personalizados[item.campo.slice('campos.'.length)] = item.valor;
        gravados.push(item);
      }
    }
    if (Object.keys(personalizados).length > 0) {
      dados.camposPersonalizados = aplicarPatchDosCampos(
        antes.camposPersonalizados,
        personalizados,
      ) as Prisma.InputJsonObject;
    }
    if (Object.keys(dados).length > 0) {
      const alteracoes = calcularAlteracoes(
        antes,
        { ...antes, ...dados } as typeof antes,
        CAMPOS_AUDITADOS_DO_CONTATO,
      );
      if (Object.keys(alteracoes).length > 0) {
        const depois = await tx.contato.update({
          where: { id: contatoId },
          data: dados,
        });
        await this.auditoria.registrar(tx, {
          acao: 'contato.atualizado',
          entidade: 'contato',
          entidadeId: contatoId,
          resumo: `Contato "${depois.nome}" atualizado pelo SDR com IA: ${descreverAlteracoes(alteracoes)}`,
          dados: { alteracoes, regra: REGRA_SDR },
          relacionados: { empresa: depois.empresaId },
        });
        await this.eventos.publicar(tx, 'contato.atualizado', {
          ...instantaneoDoContato(depois),
          camposAlterados: Object.keys(alteracoes),
          motivo: 'automacao',
        });
      }
    }
    for (const item of gravados) {
      await tx.sdrValor.update({
        where: { id: item.id },
        data: { destino: `contato:${item.campo}` },
      });
    }
    return gravados.length;
  }

  private async escreverNoNegocio(
    tx: Tx,
    negocioId: string,
    itens: { campo: string; valor: ValorDeCriterio }[],
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM negocios WHERE id = ${negocioId}::uuid FOR UPDATE`;
    const antes = await tx.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      include: INCLUIR_NEGOCIO,
    });
    if (!antes) {
      return;
    }
    const personalizados: Record<string, unknown> = {};
    for (const item of itens) {
      if (item.campo.startsWith('campos.')) {
        personalizados[item.campo.slice('campos.'.length)] = item.valor;
      }
    }
    if (Object.keys(personalizados).length === 0) {
      return;
    }
    const camposPersonalizados = aplicarPatchDosCampos(
      antes.camposPersonalizados,
      personalizados,
    ) as Prisma.InputJsonObject;
    const depois = await tx.negocio.update({
      where: { id: negocioId },
      data: { camposPersonalizados },
      include: INCLUIR_NEGOCIO,
    });
    const alteracoes = calcularAlteracoes(antes, depois, [
      'camposPersonalizados',
    ]);
    if (Object.keys(alteracoes).length === 0) {
      return;
    }
    await this.auditoria.registrar(tx, {
      acao: 'negocio.atualizado',
      entidade: 'negocio',
      entidadeId: negocioId,
      resumo: `Negócio "${depois.titulo}" atualizado pelo SDR com IA (campos personalizados)`,
      dados: { alteracoes, regra: REGRA_SDR },
      relacionados: relacionadosDoNegocio(depois),
    });
    await this.eventos.publicar(
      tx,
      'negocio.atualizado',
      dadosDoEventoDeNegocio(depois, { alteracoes }),
    );
  }

  // -------------------------------------------------------------------------
  // Passagem para o Comercial
  // -------------------------------------------------------------------------

  /** A qualificação como linhas de texto ("Curso de interesse: Enfermagem"). */
  async linhasDaQualificacao(
    tx: Tx,
    sdrConversaId: string,
    criterios: readonly CriterioDoMotor[],
  ): Promise<string[]> {
    const valores = await this.valoresDoEstado(tx, sdrConversaId);
    return criterios
      .filter((c) => valores.has(c.chave))
      .map((c) => {
        const v = valores.get(c.chave) as ValorDescoberto;
        return `${c.rotulo}: ${formatarValor(c, v.valor)}`;
      });
  }

  /**
   * Passa o lead qualificado ao Comercial: negócio pela passagem Marketing →
   * Comercial (rodízio), nota com o resumo e a qualificação, aviso ao vendedor
   * e a conversa atribuída a ele. Sem a passagem ativa, cria o negócio direto
   * no funil-base do Comercial (também pelo rodízio).
   */
  async passarParaOComercial(
    tx: Tx,
    estado: SdrConversa,
    conversa: ConversaDaPassagem,
    criterios: readonly CriterioDoMotor[],
    confiancaMinima: number,
    dados: DadosDaQualificacao,
  ): Promise<ResultadoDaPassagemSdr> {
    const { contato, canal } = conversa;
    const origemDetalhe = `SDR com IA — ${canal.nome}`;
    const passagem = await tx.passagem.findFirst({
      where: { chave: 'marketing_comercial', ativa: true },
      include: { funilOrigem: true, funilDestino: true, etapaDestino: true },
    });
    let comercial: { id: string; funilId: string } | null = null;
    let marketingId: string | null = null;
    let viaPassagem = false;
    if (
      passagem &&
      passagem.funilOrigem.ativo &&
      !passagem.funilOrigem.excluidoEm
    ) {
      const aberto = await tx.negocio.findFirst({
        where: {
          contatoId: contato.id,
          funilId: passagem.funilOrigemId,
          status: 'ABERTO',
          excluidoEm: null,
        },
        orderBy: { criadoEm: 'desc' },
        select: { id: true },
      });
      if (aberto) {
        marketingId = aberto.id;
        await this.negocios.moverAutomatico(
          tx,
          aberto.id,
          passagem.etapaGatilhoId,
        );
      } else {
        const criado = await this.negocios.criarAutomatico(tx, {
          contatoId: contato.id,
          funilId: passagem.funilOrigemId,
          etapaId: passagem.etapaGatilhoId,
          titulo: contato.nome,
          origem: ORIGEM_DO_CANAL[canal.tipo],
          origemDetalhe,
          estrategia: 'LIDER_DA_AREA',
        });
        marketingId = criado.negocio.id;
      }
      const execucao = await tx.passagemExecucao.findUnique({
        where: {
          passagemId_negocioOrigemId: {
            passagemId: passagem.id,
            negocioOrigemId: marketingId,
          },
        },
        include: { negocioDestino: true },
      });
      const destino = execucao?.negocioDestino;
      if (destino && destino.status === 'ABERTO' && !destino.excluidoEm) {
        comercial = { id: destino.id, funilId: destino.funilId };
        viaPassagem = true;
      }
    }
    if (!comercial) {
      const funil = await tx.funil.findFirst({
        where: { area: 'COMERCIAL', base: true, ativo: true, excluidoEm: null },
        include: {
          etapas: {
            where: { tipo: 'ABERTA' },
            orderBy: { ordem: 'asc' },
            take: 1,
          },
        },
      });
      const etapa = funil?.etapas[0];
      if (!funil || !etapa) {
        throw new Error('O funil-base do Comercial não tem uma etapa aberta.');
      }
      const criado = await this.negocios.criarAutomatico(tx, {
        contatoId: contato.id,
        funilId: funil.id,
        etapaId: etapa.id,
        titulo: contato.nome,
        origem: ORIGEM_DO_CANAL[canal.tipo],
        origemDetalhe,
        estrategia: 'RODIZIO',
      });
      comercial = { id: criado.negocio.id, funilId: criado.negocio.funilId };
    }
    const negocio = await tx.negocio.findUniqueOrThrow({
      where: { id: comercial.id },
      include: { responsavel: { select: { id: true, nome: true } } },
    });
    const vendedor = negocio.responsavel;

    // Critérios nos campos do contato e dos negócios (Comercial e Marketing).
    await this.escreverNosCampos(
      tx,
      estado,
      contato.id,
      [
        negocio.id,
        ...(marketingId && marketingId !== negocio.id ? [marketingId] : []),
      ],
      criterios,
      confiancaMinima,
    );

    const linhas = await this.linhasDaQualificacao(tx, estado.id, criterios);
    const texto = [
      `Qualificado pela IA (SDR) — nota ${dados.nota}, lead ${rotuloDaTemperatura(dados.temperatura)}.`,
      '',
      'Resumo:',
      dados.resumo || '(sem resumo)',
      '',
      linhas.length
        ? `Qualificação:\n${linhas.map((l) => `- ${l}`).join('\n')}`
        : 'Qualificação: nenhum critério registrado.',
      '',
      `Por que passou para o Comercial: ${dados.motivo || 'critérios atendidos'}`,
    ].join('\n');

    if (vendedor) {
      const nota = await tx.atividade.create({
        data: {
          tipo: 'NOTA',
          titulo: `Qualificação pela IA — nota ${dados.nota} (${rotuloDaTemperatura(dados.temperatura)})`,
          descricao: texto,
          status: 'CONCLUIDA',
          responsavelId: vendedor.id,
          criadoPorId: null,
          concluidaEm: new Date(),
          contatoId: contato.id,
          negocioId: negocio.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'atividade.criada',
        entidade: 'atividade',
        entidadeId: nota.id,
        resumo: `Nota "${nota.titulo}" criada pelo SDR com IA no negócio "${negocio.titulo}"`,
        dados: { ...dadosDoEvento(nota), regra: REGRA_SDR },
        relacionados: { contato: contato.id, negocio: negocio.id },
      });
      await this.eventos.publicar(tx, 'atividade.criada', dadosDoEvento(nota));
    }

    // Conversa: negócio ligado, atribuída ao vendedor, com a nota interna.
    let atual = await tx.conversa.update({
      where: { id: conversa.id },
      data: { negocioId: negocio.id },
    });
    const filaDaConversa = conversa.filaId
      ? await tx.filaAtendimento.findUnique({
          where: { id: conversa.filaId },
          select: { area: true },
        })
      : null;
    const salasAntes = this.motor.salas({
      id: conversa.id,
      responsavelId: conversa.responsavelId,
      fila: filaDaConversa,
    });
    if (vendedor) {
      atual = await this.motor.atribuir(tx, atual, {
        usuarioId: vendedor.id,
        motivo: 'DISTRIBUICAO',
        nota: dados.resumo || null,
        tituloDaNotificacao: 'Lead qualificado pela IA',
      });
    } else {
      atual = await this.motor.distribuir(tx, atual);
    }
    const comFila = { ...atual, fila: filaDaConversa };
    await tx.mensagem.create({
      data: {
        conversaId: conversa.id,
        canalId: conversa.canalId,
        direcao: 'INTERNA',
        tipo: 'TEXTO',
        texto,
        autorTipo: 'IA',
      },
    });
    await this.motor.avisoDeSistema(
      tx,
      comFila,
      vendedor
        ? `A IA qualificou o lead (nota ${dados.nota}, ${rotuloDaTemperatura(dados.temperatura)}) e passou para ${vendedor.nome} no Comercial.`
        : `A IA qualificou o lead (nota ${dados.nota}, ${rotuloDaTemperatura(dados.temperatura)}) e passou para o Comercial.`,
      { evento: 'sdr_qualificado', negocioId: negocio.id },
    );
    await this.motor.publicarContagens(tx, {
      usuarios: [vendedor?.id, conversa.responsavelId],
      areas: [filaDaConversa?.area],
    });
    await this.motor.emitirConversa(tx, conversa.id, { salasAntes });

    await this.auditoria.registrar(tx, {
      acao: 'sdr.lead-qualificado',
      entidade: 'conversa',
      entidadeId: conversa.id,
      resumo: `SDR com IA qualificou "${contato.nome}" (nota ${dados.nota}, ${rotuloDaTemperatura(dados.temperatura)}) e passou para o Comercial${vendedor ? ` (${vendedor.nome})` : ''}`,
      dados: {
        regra: REGRA_SDR,
        negocioId: negocio.id,
        vendedorId: vendedor?.id ?? null,
        viaPassagem,
        nota: dados.nota,
        temperatura: dados.temperatura,
        motivo: dados.motivo,
      },
      relacionados: { contato: contato.id, negocio: negocio.id },
    });
    await this.eventos.publicar(tx, EVENTOS_DO_SDR.LEAD_QUALIFICADO, {
      conversaId: conversa.id,
      contatoId: contato.id,
      negocioId: negocio.id,
      vendedorId: vendedor?.id ?? null,
      nota: dados.nota,
      temperatura: dados.temperatura,
      resumo: dados.resumo,
    });
    if (vendedor) {
      await this.notificacoes.notificar(tx, vendedor.id, {
        tipo: TIPOS_NOTIFICACAO_SDR.LEAD_QUALIFICADO,
        titulo: `Lead qualificado pela IA: ${contato.nome}`,
        texto:
          `Nota ${dados.nota} (${rotuloDaTemperatura(dados.temperatura)}). ${dados.resumo}`.slice(
            0,
            300,
          ),
        link: linkDoNegocio({ id: negocio.id, funilId: negocio.funilId }),
        dados: { conversaId: conversa.id, negocioId: negocio.id },
      });
    }
    return {
      negocioId: negocio.id,
      vendedorId: vendedor?.id ?? null,
      vendedorNome: vendedor?.nome ?? null,
      viaPassagem,
      funilId: negocio.funilId,
    };
  }
}
