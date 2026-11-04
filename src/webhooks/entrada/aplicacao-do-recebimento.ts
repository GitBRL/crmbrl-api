import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import { calcularAlteracoes } from '../../comum/dados/sanitizar';
import { normalizarEtiquetas } from '../../comum/dominio/etiquetas';
import { ContatosService } from '../../contatos/contatos.service';
import {
  CAMPOS_AUDITADOS_DO_CONTATO,
  instantaneoDoContato,
} from '../../contatos/instantaneos';
import { EventosDominioService } from '../../eventos/eventos-dominio.service';
import { podeSerResponsavelNaArea } from '../../funis/acesso-funis';
import {
  dadosDoEventoDeNegocio,
  linkDoNegocio,
  MotorDeNegociosService,
  relacionadosDoNegocio,
} from '../../funis/motor-de-negocios.service';
import {
  INCLUIR_NEGOCIO,
  type NegocioCompleto,
} from '../../funis/negocio-completo';
import { NegociosService } from '../../funis/negocios.service';
import type {
  Contato,
  Etapa,
  Funil,
  Prisma,
  StatusNegocio,
  WebhookEntrada,
} from '../../generated/prisma/client';
import { NotificacoesService } from '../../notificacoes/notificacoes.service';
import { TIPOS_NOTIFICACAO } from '../../notificacoes/tipos-notificacao';
import type { Tx } from '../../prisma/prisma.service';
import {
  acharEtapa,
  etapaPelaVariavel,
  lerStatus,
  ROTULO_DO_STATUS,
  statusDoTipo,
} from './atualizacoes';
import type { LeadMapeado } from './mapeamento';

/** Erro do recebimento que não muda numa nova tentativa (mapeamento, validação). */
export class RecebimentoInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'RecebimentoInvalidoError';
  }
}

/** O que a aplicação de um item do recebimento fez (R32.3). */
export interface ResultadoDoItem {
  readonly status: 'PROCESSADO' | 'IGNORADO';
  readonly mensagem: string;
  readonly contatoId: string | null;
  readonly negocioId: string | null;
  readonly avisos: readonly string[];
}

/**
 * Aplica um lead lido do recebimento ao CRM, na transação de quem chama e com
 * o ator `WEBHOOK` do contexto (R32.3, R32.4):
 *
 * - **contato**: `CRIAR`/`CRIAR_OU_ATUALIZAR` deduplicam e criam (R4.2);
 *   `ATUALIZAR` só acha (sem contato, o recebimento é ignorado). No alvo
 *   `CONTATO`, o modo `CRIAR_OU_ATUALIZAR` também sobrescreve nome, cargo,
 *   etiquetas e campos personalizados de um contato que já existe, e `ATUALIZAR`
 *   sempre sobrescreve;
 * - **negócio** (alvo `NEGOCIO`): `CRIAR` cria sempre; `CRIAR_OU_ATUALIZAR`
 *   atualiza o aberto mais recente do contato no funil, registrando a
 *   reconversão (R5.6), ou cria; `ATUALIZAR` só atualiza (sem negócio aberto,
 *   ignora);
 * - **atualizações mapeadas**: etapa (nome ou posição), dono (e-mail ou
 *   identificador), status (R5.5 para a perda), valor, título e campos
 *   personalizados do negócio. Valor desconhecido vira aviso e o resto é aplicado.
 */
@Injectable()
export class AplicacaoDoRecebimento {
  constructor(
    private readonly contatos: ContatosService,
    private readonly negocios: NegociosService,
    private readonly motor: MotorDeNegociosService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  async aplicar(
    tx: Tx,
    webhook: WebhookEntrada,
    lead: LeadMapeado,
    variaveis: Record<string, unknown> | null = null,
  ): Promise<ResultadoDoItem> {
    const avisos: string[] = [...lead.avisos];
    const atualizando = webhook.modo === 'ATUALIZAR';

    // -- Contato ------------------------------------------------------------
    let contato: Contato;
    let contatoCriado = false;
    let contatoAtualizado = false;
    if (atualizando) {
      const achado = await this.acharContato(tx, lead);
      if (!achado) {
        return {
          status: 'IGNORADO',
          mensagem: `Contato não encontrado (${descreverMeio(lead)}): o modo Atualizar não cria contato. Nada foi criado.`,
          contatoId: null,
          negocioId: null,
          avisos,
        };
      }
      contato = achado;
      contatoAtualizado = true;
    } else {
      const resultado = await this.contatos.encontrarOuCriar(tx, {
        nome: lead.contato.nome ?? '',
        email: lead.contato.email ?? undefined,
        telefone: lead.contato.telefone ?? undefined,
        empresaNome: lead.contato.empresa ?? undefined,
        cargo: lead.contato.cargo ?? undefined,
        origem: 'WEBHOOK',
        origemDetalhe: webhook.nome,
        utm: lead.utm ?? undefined,
        etiquetas: lead.etiquetas,
        camposPersonalizados: lead.camposPersonalizados,
      });
      contato = resultado.contato;
      contatoCriado = resultado.criado;
      contatoAtualizado =
        !resultado.criado &&
        webhook.alvo === 'CONTATO' &&
        webhook.modo === 'CRIAR_OU_ATUALIZAR';
    }
    if (contatoAtualizado) {
      contato = await this.sobrescreverContato(tx, contato, lead);
    }

    const funil = await tx.funil.findUniqueOrThrow({
      where: { id: webhook.funilId },
    });

    // -- Alvo contato -------------------------------------------------------
    if (webhook.alvo === 'CONTATO') {
      const dono = lead.atualizacoes.dono
        ? await this.resolverDono(tx, lead.atualizacoes.dono, funil, avisos)
        : null;
      if (dono && !contato.responsavelId) {
        await this.contatos.definirResponsavelSeVazio(tx, contato.id, dono.id);
      }
      avisarSemEfeito(lead, avisos, ['etapa', 'status', 'motivoPerda']);
      return {
        status: 'PROCESSADO',
        mensagem: montarMensagem(
          [
            contatoCriado
              ? `Contato "${contato.nome}" criado`
              : atualizando || contatoAtualizado
                ? `Contato "${contato.nome}" atualizado`
                : `Contato "${contato.nome}" reconvertido (já existia)`,
          ],
          avisos,
        ),
        contatoId: contato.id,
        negocioId: null,
        avisos,
      };
    }

    // -- Alvo negócio -------------------------------------------------------
    const etapas = await tx.etapa.findMany({
      where: { funilId: funil.id },
      orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
    });
    const etapaDeEntrada = etapas.find(({ id }) => id === webhook.etapaId);
    if (!etapaDeEntrada) {
      throw new RecebimentoInvalidoError(
        'A etapa de entrada da integração não existe mais no funil: edite a integração.',
      );
    }
    const dono = lead.atualizacoes.dono
      ? await this.resolverDono(tx, lead.atualizacoes.dono, funil, avisos)
      : null;
    // Typeform, como no Clint: uma variável com o nome exato de uma etapa (valor diferente de 0 ou vazio) pede essa etapa.
    const etapaDaVariavel =
      !lead.atualizacoes.etapa && variaveis
        ? etapaPelaVariavel(etapas, variaveis)
        : null;
    const etapaPedida = lead.atualizacoes.etapa
      ? this.resolverEtapa(etapas, lead.atualizacoes.etapa, funil, avisos)
      : etapaDaVariavel;
    const statusPedido = lead.atualizacoes.status
      ? this.resolverStatus(lead.atualizacoes.status, avisos)
      : null;

    let negocio: NegocioCompleto;
    let criado = false;
    let reconversao = false;
    const ajustes: string[] = [];
    if (atualizando) {
      const aberto = await this.negocioAbertoMaisRecente(
        tx,
        contato.id,
        funil.id,
      );
      if (!aberto) {
        return {
          status: 'IGNORADO',
          mensagem: montarMensagem(
            [
              `Contato "${contato.nome}" atualizado; nenhum negócio aberto dele em ${funil.nome}: o modo Atualizar não cria negócio. Nada foi criado`,
            ],
            avisos,
          ),
          contatoId: contato.id,
          negocioId: null,
          avisos,
        };
      }
      negocio = aberto;
    } else {
      const etapaDaCriacao =
        etapaPedida?.tipo === 'ABERTA' ? etapaPedida : etapaDeEntrada;
      const resultado = await this.negocios.criarAutomatico(tx, {
        contatoId: contato.id,
        funilId: funil.id,
        etapaId: etapaDaCriacao.id,
        titulo: lead.negocio.titulo ?? undefined,
        valor: lead.negocio.valor ?? undefined,
        valorRecorrente: lead.negocio.valorRecorrente ?? undefined,
        origem: 'WEBHOOK',
        origemDetalhe: webhook.nome,
        utm: lead.utm ?? undefined,
        estrategia: dono ? 'RESPONSAVEL_FIXO' : webhook.estrategia,
        responsavelFixoId: dono?.id ?? webhook.responsavelFixoId ?? undefined,
        sempreCriar: webhook.modo === 'CRIAR',
        abertoMaisRecente: true,
      });
      negocio = await tx.negocio.findUniqueOrThrow({
        where: { id: resultado.negocio.id },
        include: INCLUIR_NEGOCIO,
      });
      criado = resultado.criado;
      reconversao = resultado.reconversao;
      // R4.5: o contato (e a empresa) sem responsável fica com o do negócio.
      if (negocio.responsavelId) {
        await this.contatos.definirResponsavelSeVazio(
          tx,
          contato.id,
          negocio.responsavelId,
        );
      }
    }

    // Dados do negócio (valor, título, dono e campos personalizados) de um negócio que já existia.
    if (!criado) {
      const antes = negocio;
      negocio = await this.atualizarDados(tx, negocio, lead, dono, ajustes);
      if (
        negocio.responsavelId !== antes.responsavelId &&
        negocio.responsavelId
      ) {
        await this.notificarNovoDono(tx, negocio, contato);
      }
    } else if (Object.keys(lead.camposDoNegocio).length > 0) {
      negocio = await this.atualizarDados(
        tx,
        negocio,
        {
          ...lead,
          negocio: { titulo: null, valor: null, valorRecorrente: null },
        },
        null,
        ajustes,
      );
    }

    // Etapa e status.
    const destino = this.decidirDestino({
      etapas,
      etapaDeEntrada,
      etapaPedida,
      statusPedido,
      statusInicial: criado ? webhook.statusInicial : 'ABERTO',
      negocio,
      avisos,
    });
    if (destino) {
      const motivo =
        lead.atualizacoes.motivoPerda ?? webhook.motivoPerdaPadrao ?? null;
      if (destino.tipo === 'PERDIDO' && !motivo) {
        avisos.push(
          'O negócio não foi marcado como perdido: a perda exige motivo (R5.5). Mapeie o motivo da perda ou defina o motivo padrão da integração.',
        );
      } else if (destino.id !== negocio.etapaId) {
        const anterior = negocio;
        negocio = await this.motor.entrarNaEtapa(tx, negocio, destino, {
          motivoPerda: destino.tipo === 'PERDIDO' ? motivo : null,
          posicao: await this.motor.posicaoNoTopo(tx, destino.id, negocio.id),
        });
        await this.motor.executarPassagens(tx, negocio);
        ajustes.push(
          anterior.status !== negocio.status
            ? `etapa → ${destino.nome}, status → ${ROTULO_DO_STATUS[negocio.status]}`
            : `etapa → ${destino.nome}`,
        );
      }
    }

    const partes = [
      contatoCriado
        ? `Contato "${contato.nome}" criado`
        : atualizando
          ? `Contato "${contato.nome}" atualizado`
          : `Contato "${contato.nome}" reconvertido (já existia)`,
      criado
        ? `negócio criado em ${funil.nome} / ${negocio.etapa.nome}, ${negocio.responsavel ? `com ${negocio.responsavel.nome}` : 'sem responsável'}`
        : reconversao
          ? `reconversão registrada no negócio aberto "${negocio.titulo}"`
          : `negócio aberto "${negocio.titulo}" atualizado`,
      ...(ajustes.length > 0 ? [`atualizações: ${ajustes.join('; ')}`] : []),
    ];
    return {
      status: 'PROCESSADO',
      mensagem: montarMensagem(partes, avisos),
      contatoId: contato.id,
      negocioId: negocio.id,
      avisos,
    };
  }

  // -------------------------------------------------------------------------
  // Contato
  // -------------------------------------------------------------------------

  /** O contato ativo com o e-mail (primeiro) ou o telefone do lead. */
  private async acharContato(
    tx: Tx,
    lead: LeadMapeado,
  ): Promise<Contato | null> {
    if (lead.contato.email) {
      const contato = await tx.contato.findFirst({
        where: { email: lead.contato.email, excluidoEm: null },
      });
      if (contato) {
        return contato;
      }
    }
    if (lead.contato.telefone) {
      return tx.contato.findFirst({
        where: { telefone: lead.contato.telefone, excluidoEm: null },
      });
    }
    return null;
  }

  /** Sobrescreve o que o lead trouxe: nome, cargo, etiquetas (somam) e campos personalizados (mesclam). */
  private async sobrescreverContato(
    tx: Tx,
    antes: Contato,
    lead: LeadMapeado,
  ): Promise<Contato> {
    const dados: Prisma.ContatoUncheckedUpdateInput = {};
    if (lead.contato.nome && lead.contato.nome !== antes.nome) {
      dados.nome = lead.contato.nome;
    }
    if (lead.contato.cargo && lead.contato.cargo !== antes.cargo) {
      dados.cargo = lead.contato.cargo;
    }
    if (lead.etiquetas.length > 0) {
      dados.etiquetas = normalizarEtiquetas([
        ...antes.etiquetas,
        ...lead.etiquetas,
      ]);
    }
    if (Object.keys(lead.camposPersonalizados).length > 0) {
      dados.camposPersonalizados = {
        ...(typeof antes.camposPersonalizados === 'object' &&
        antes.camposPersonalizados !== null &&
        !Array.isArray(antes.camposPersonalizados)
          ? antes.camposPersonalizados
          : {}),
        ...lead.camposPersonalizados,
      } as Prisma.InputJsonObject;
    }
    if (Object.keys(dados).length === 0) {
      return antes;
    }
    const depois = await tx.contato.update({
      where: { id: antes.id },
      data: dados,
    });
    const alteracoes = calcularAlteracoes(
      antes,
      depois,
      CAMPOS_AUDITADOS_DO_CONTATO,
    );
    if (Object.keys(alteracoes).length === 0) {
      return depois;
    }
    await this.auditoria.registrar(tx, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: depois.id,
      resumo: `Contato "${depois.nome}" atualizado por uma integração (${Object.keys(alteracoes).join(', ')})`,
      dados: { alteracoes, regra: 'R32.3' },
      relacionados: { empresa: depois.empresaId },
    });
    await this.eventos.publicar(tx, 'contato.atualizado', {
      ...instantaneoDoContato(depois),
      camposAlterados: Object.keys(alteracoes),
      motivo: 'integracao',
    });
    return depois;
  }

  // -------------------------------------------------------------------------
  // Negócio
  // -------------------------------------------------------------------------

  private async negocioAbertoMaisRecente(
    tx: Tx,
    contatoId: string,
    funilId: string,
  ): Promise<NegocioCompleto | null> {
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM negocios
       WHERE contato_id = ${contatoId}::uuid
         AND funil_id = ${funilId}::uuid
         AND status = 'ABERTO'::status_negocio
         AND excluido_em IS NULL
       ORDER BY criado_em DESC, id DESC
       LIMIT 1
         FOR UPDATE`;
    return linha
      ? tx.negocio.findUniqueOrThrow({
          where: { id: linha.id },
          include: INCLUIR_NEGOCIO,
        })
      : null;
  }

  /** Título, valores, dono e campos personalizados do negócio (auditado e publicado como `negocio.atualizado`). */
  private async atualizarDados(
    tx: Tx,
    antes: NegocioCompleto,
    lead: LeadMapeado,
    dono: { id: string; nome: string } | null,
    ajustes: string[],
  ): Promise<NegocioCompleto> {
    const dados: Prisma.NegocioUncheckedUpdateInput = {};
    if (lead.negocio.titulo && lead.negocio.titulo !== antes.titulo) {
      dados.titulo = lead.negocio.titulo;
    }
    if (
      lead.negocio.valor !== null &&
      lead.negocio.valor !== antes.valor.toFixed(2)
    ) {
      dados.valor = lead.negocio.valor;
    }
    if (
      lead.negocio.valorRecorrente !== null &&
      lead.negocio.valorRecorrente !== antes.valorRecorrente?.toFixed(2)
    ) {
      dados.valorRecorrente = lead.negocio.valorRecorrente;
    }
    if (dono && dono.id !== antes.responsavelId) {
      dados.responsavelId = dono.id;
    }
    if (Object.keys(lead.camposDoNegocio).length > 0) {
      const atuais =
        typeof antes.camposPersonalizados === 'object' &&
        antes.camposPersonalizados !== null &&
        !Array.isArray(antes.camposPersonalizados)
          ? antes.camposPersonalizados
          : {};
      dados.camposPersonalizados = {
        ...atuais,
        ...lead.camposDoNegocio,
      } as Prisma.InputJsonObject;
    }
    if (Object.keys(dados).length === 0) {
      return antes;
    }
    const depois = await tx.negocio.update({
      where: { id: antes.id },
      data: dados,
      include: INCLUIR_NEGOCIO,
    });
    const alteracoes = calcularAlteracoes(antes, depois, [
      'titulo',
      'responsavelId',
      'valor',
      'valorRecorrente',
      'camposPersonalizados',
    ] as const);
    if (Object.keys(alteracoes).length === 0) {
      return depois;
    }
    await this.auditoria.registrar(tx, {
      acao: 'negocio.atualizado',
      entidade: 'negocio',
      entidadeId: depois.id,
      resumo: `Negócio "${depois.titulo}" atualizado por uma integração (${Object.keys(alteracoes).join(', ')})`,
      dados: { alteracoes, regra: 'R32.3' },
      relacionados: relacionadosDoNegocio(depois),
    });
    await this.eventos.publicar(
      tx,
      'negocio.atualizado',
      dadosDoEventoDeNegocio(depois, { alteracoes }),
    );
    if ('responsavelId' in alteracoes && dono) {
      ajustes.push(`dono → ${dono.nome}`);
    }
    const outros = Object.keys(alteracoes).filter(
      (campo) => campo !== 'responsavelId',
    );
    if (outros.length > 0) {
      ajustes.push(outros.join(', '));
    }
    return depois;
  }

  private async notificarNovoDono(
    tx: Tx,
    negocio: NegocioCompleto,
    contato: Contato,
  ): Promise<void> {
    if (!negocio.responsavelId) {
      return;
    }
    await this.notificacoes.notificar(tx, negocio.responsavelId, {
      tipo: TIPOS_NOTIFICACAO.NEGOCIO_ATRIBUIDO,
      titulo: 'Negócio atribuído a você',
      texto: `O negócio "${negocio.titulo}" de ${contato.nome} passou a ser seu por uma integração.`,
      link: linkDoNegocio(negocio),
      dados: { negocioId: negocio.id, contatoId: contato.id },
    });
  }

  /**
   * Para onde levar o negócio: a etapa pedida; senão o que o status pede
   * (ganho/perdido → a etapa do tipo; aberto → a etapa de entrada, se ele estava
   * fechado); senão o status inicial da integração, num negócio novo.
   */
  private decidirDestino(entrada: {
    etapas: readonly Etapa[];
    etapaDeEntrada: Etapa;
    etapaPedida: Etapa | null;
    statusPedido: StatusNegocio | null;
    statusInicial: StatusNegocio;
    negocio: NegocioCompleto;
    avisos: string[];
  }): Etapa | null {
    const { etapaPedida, statusPedido, negocio, avisos } = entrada;
    if (etapaPedida) {
      if (statusPedido && statusDoTipo(etapaPedida.tipo) !== statusPedido) {
        avisos.push(
          `Status "${ROTULO_DO_STATUS[statusPedido]}" ignorado: a etapa "${etapaPedida.nome}" define o status ${ROTULO_DO_STATUS[statusDoTipo(etapaPedida.tipo)]}.`,
        );
      }
      return etapaPedida;
    }
    const status = statusPedido ?? entrada.statusInicial;
    if (status === 'ABERTO') {
      return negocio.status === 'ABERTO' ? null : entrada.etapaDeEntrada;
    }
    const tipo = status === 'GANHO' ? 'GANHO' : 'PERDIDO';
    const etapa = entrada.etapas.find((candidata) => candidata.tipo === tipo);
    if (!etapa) {
      avisos.push(
        `O funil não tem etapa de ${status === 'GANHO' ? 'ganho' : 'perda'}: o status "${ROTULO_DO_STATUS[status]}" não foi aplicado.`,
      );
      return null;
    }
    return etapa;
  }

  // -------------------------------------------------------------------------
  // Resolução dos valores mapeados
  // -------------------------------------------------------------------------

  private resolverEtapa(
    etapas: readonly Etapa[],
    texto: string,
    funil: Funil,
    avisos: string[],
  ): Etapa | null {
    const etapa = acharEtapa(etapas, texto);
    if (!etapa) {
      avisos.push(
        `Etapa "${texto}" não existe no funil ${funil.nome}: ignorada.`,
      );
    }
    return etapa;
  }

  private resolverStatus(
    texto: string,
    avisos: string[],
  ): StatusNegocio | null {
    const status = lerStatus(texto);
    if (!status) {
      avisos.push(
        `Status "${texto}" desconhecido (use aberto, ganho ou perdido): ignorado.`,
      );
    }
    return status;
  }

  /** O dono pelo e-mail ou pelo identificador nas integrações (R32.4); precisa ser ativo e da área do funil. */
  private async resolverDono(
    tx: Tx,
    texto: string,
    funil: Funil,
    avisos: string[],
  ): Promise<{ id: string; nome: string } | null> {
    const procurado = texto.trim();
    const usuario = await tx.usuario.findFirst({
      where: {
        ativo: true,
        OR: [
          { email: { equals: procurado, mode: 'insensitive' } },
          {
            identificadorIntegracao: { equals: procurado, mode: 'insensitive' },
          },
        ],
      },
      select: { id: true, nome: true, papel: true },
    });
    if (!usuario) {
      avisos.push(
        `Dono "${texto}" não encontrado (e-mail ou identificador de um usuário ativo): ignorado.`,
      );
      return null;
    }
    if (!podeSerResponsavelNaArea(usuario.papel, funil.area)) {
      avisos.push(
        `Dono "${texto}" (${usuario.nome}) não é da área do funil ${funil.nome}: ignorado.`,
      );
      return null;
    }
    return { id: usuario.id, nome: usuario.nome };
  }
}

function descreverMeio(lead: LeadMapeado): string {
  return (
    lead.contato.email ?? lead.contato.telefone ?? 'sem e-mail nem telefone'
  );
}

/** `Contato criado; negócio criado… Avisos: …` (o formato do R8.5, com os avisos no fim). */
function montarMensagem(
  partes: readonly string[],
  avisos: readonly string[],
): string {
  return `${partes.join('; ')}.${avisos.length > 0 ? ` Avisos: ${avisos.join(' ')}` : ''}`;
}

/** No alvo contato, etapa, status e motivo da perda não têm onde ser aplicados. */
function avisarSemEfeito(
  lead: LeadMapeado,
  avisos: string[],
  campos: readonly ('etapa' | 'status' | 'motivoPerda')[],
): void {
  const usados = campos.filter((campo) => lead.atualizacoes[campo] !== null);
  if (usados.length > 0) {
    avisos.push(
      `Campos ${usados.join(', ')} ignorados: a integração atualiza só o contato (alvo Contato).`,
    );
  }
}
