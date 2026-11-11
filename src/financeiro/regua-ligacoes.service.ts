import { Injectable } from '@nestjs/common';
import { SETOR_CS } from '../comum/dominio/setores';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { formatarValor } from '../comum/dominio/dinheiro';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Parcela,
  ReguaEnvio,
  ReguaEtapa,
} from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { inicioDoDia } from '../atividades/fuso-horario';
import {
  deDataDoBanco,
  ehDataIso,
  hojeLocal,
  minutosDoHorario,
  paraDataDoBanco,
  somarDias,
} from './datas';
import {
  DESCRICAO_DO_ATOR_DA_REGUA,
  FUSO_DO_FINANCEIRO,
} from './financeiro.constantes';
import type { FiltroLigacoesDto, ResultadoLigacaoDto } from './financeiro.dto';
import { codigoDoContrato } from './financeiro.mapas';
import { ParcelasService, relacionadosDe } from './parcelas.service';
import { filtroDeParcelasVisiveis } from './permissoes-financeiro';
import { ReguaConfiguracaoService } from './regua-configuracao.service';
import {
  type ContatoDeCobranca,
  ReguaEnvioService,
} from './regua-envio.service';
import { TempoRealFinanceiro } from './tempo-real-financeiro.service';

export const TIPO_NOTIFICACAO_LIGACAO = 'regua.ligacao';
export const TIPO_NOTIFICACAO_PROMESSA = 'regua.promessa_nao_cumprida';

/**
 * Ligações da régua (R24.5): a etapa com ligação vira uma atividade (tipo LIGAÇÃO)
 * para o responsável de CS; as mensagens da etapa ficam retidas até o resultado:
 * promessa (suspende a régua e confirma), sem acordo ou não atendeu (libera a
 * mensagem), já pagou (dá baixa). Sem resultado até o horário limite, a mensagem sai.
 */
@Injectable()
export class ReguaLigacoesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly parcelas: ParcelasService,
    private readonly envios: ReguaEnvioService,
    private readonly configuracao: ReguaConfiguracaoService,
    private readonly tempoReal: TempoRealFinanceiro,
  ) {}

  /** Prazo para registrar o resultado: o horário limite de hoje, ou o de amanhã se já passou. */
  async prazoDaLigacao(agora: Date = new Date()): Promise<Date> {
    const { horarioLimiteLigacoes } = await this.configuracao.configuracao();
    const hoje = hojeLocal(agora);
    const minutos = minutosDoHorario(horarioLimiteLigacoes);
    const dia = (iso: string) => {
      const [a, m, d] = iso.split('-').map(Number);
      return new Date(
        inicioDoDia(a, m, d, FUSO_DO_FINANCEIRO).getTime() + minutos * 60_000,
      );
    };
    const hojeNoLimite = dia(hoje);
    return hojeNoLimite.getTime() > agora.getTime()
      ? hojeNoLimite
      : dia(somarDias(hoje, 1));
  }

  /** Quem faz a ligação: CS do contrato, responsável do contato, líder de CS ou Admin. */
  async responsavelDaLigacao(
    contratoId: string | null,
    contato: ContatoDeCobranca,
  ): Promise<string> {
    const candidatos: (string | null)[] = [];
    if (contratoId) {
      const c = await this.prisma.contrato.findUnique({
        where: { id: contratoId },
        select: { responsavelCsId: true },
      });
      candidatos.push(c?.responsavelCsId ?? null);
    }
    candidatos.push(contato.responsavelId);
    for (const id of candidatos) {
      if (
        id &&
        (await this.prisma.usuario.findFirst({
          where: { id, ativo: true },
          select: { id: true },
        }))
      ) {
        return id;
      }
    }
    const lider =
      (await this.prisma.usuario.findFirst({
        where: { papel: 'LIDER', area: SETOR_CS, ativo: true },
        orderBy: { criadoEm: 'asc' },
        select: { id: true },
      })) ??
      (await this.prisma.usuario.findFirst({
        where: { papel: 'ADMIN', ativo: true },
        orderBy: { criadoEm: 'asc' },
        select: { id: true },
      }));
    if (!lider) {
      throw new Error(
        'Nenhum usuário disponível para receber a ligação de cobrança.',
      );
    }
    return lider.id;
  }

  /** Cria a ligação (registro + atividade + aviso ao responsável). Na transação de quem chama. */
  async criarLigacao(
    tx: Tx,
    o: {
      parcela: Parcela;
      etapa: ReguaEtapa;
      contato: ContatoDeCobranca;
      contrato: { id: string; numero: number; produto: string } | null;
      execucaoId: string | null;
      hoje: string;
      diasEmAtraso: number;
      prazoEm: Date;
      responsavelId: string;
    },
  ): Promise<ReguaEnvio> {
    const titulo = `Cobrança: ${o.contato.nome} — ${o.etapa.nome}`;
    const descricao = [
      o.etapa.roteiroLigacao,
      `Título ${o.parcela.numero}: R$ ${formatarValor(o.parcela.valor)}, venceu em ${deDataDoBanco(o.parcela.vencimento)} (${Math.max(0, o.diasEmAtraso)} dia(s) de atraso).`,
      o.contrato
        ? `Contrato ${codigoDoContrato(o.contrato.numero)} — ${o.contrato.produto}.`
        : null,
      `Telefone: ${o.contato.telefone ?? 'não informado'}. Registre o resultado em Financeiro > Régua > Ligações.`,
    ]
      .filter(Boolean)
      .join('\n');
    const atividade = await tx.atividade.create({
      data: {
        tipo: 'LIGACAO',
        titulo,
        descricao,
        prioridade: o.diasEmAtraso >= 30 ? 'ALTA' : 'MEDIA',
        venceEm: o.prazoEm,
        responsavelId: o.responsavelId,
        criadoPorId: null,
        contatoId: o.contato.id,
        empresaId: o.parcela.empresaId,
      },
    });
    await this.auditoria.registrar(tx, {
      acao: 'atividade.criada',
      entidade: 'atividade',
      entidadeId: atividade.id,
      resumo: `Régua de cobrança criou a ligação "${titulo}"`,
      dados: { tipo: 'LIGACAO', parcelaId: o.parcela.id, regra: 'R24.5' },
      relacionados: { contato: o.contato.id, usuario: o.responsavelId },
    });
    await this.eventos.publicar(tx, 'atividade.criada', {
      atividadeId: atividade.id,
      tipo: 'LIGACAO',
      titulo,
      responsavelId: o.responsavelId,
      contatoId: o.contato.id,
      empresaId: o.parcela.empresaId,
      negocioId: null,
      venceEm: o.prazoEm.toISOString(),
    });
    const ligacao = await tx.reguaEnvio.create({
      data: {
        parcelaId: o.parcela.id,
        ciclo: o.parcela.cicloRegua,
        etapaId: o.etapa.id,
        marco: o.etapa.marco,
        etapaNome: o.etapa.nome,
        tipo: 'ETAPA',
        canal: 'LIGACAO',
        situacao: 'AGUARDANDO_LIGACAO',
        dia: paraDataDoBanco(o.hoje),
        execucaoId: o.execucaoId,
        destino: o.contato.telefone,
        texto: o.etapa.roteiroLigacao,
        prazoEm: o.prazoEm,
        atividadeId: atividade.id,
      },
    });
    await this.notificacoes.notificar(tx, o.responsavelId, {
      tipo: TIPO_NOTIFICACAO_LIGACAO,
      titulo: 'Ligação de cobrança',
      texto: `Ligue para ${o.contato.nome} (${o.etapa.nome}, título ${o.parcela.numero}).`,
      link: `/financeiro/regua/ligacoes?envio=${ligacao.id}`,
      dados: { envioId: ligacao.id, parcelaId: o.parcela.id },
    });
    return ligacao;
  }

  // ---- consulta ---------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    f: FiltroLigacoesDto,
  ): Promise<Pagina<unknown>> {
    this.parcelas.exigirAtuacao(usuario);
    const where = {
      canal: 'LIGACAO' as const,
      ...(f.pendentes === false
        ? {}
        : { situacao: 'AGUARDANDO_LIGACAO' as const }),
      parcela: filtroDeParcelasVisiveis(usuario),
    };
    const [itens, total] = await Promise.all([
      this.prisma.reguaEnvio.findMany({
        where,
        orderBy: [{ prazoEm: 'asc' }, { criadoEm: 'asc' }],
        include: {
          parcela: {
            include: {
              contato: {
                select: { id: true, nome: true, telefone: true, email: true },
              },
              empresa: { select: { id: true, nome: true } },
            },
          },
          etapa: { select: { roteiroLigacao: true } },
        },
        ...paraSkipTake(f),
      }),
      this.prisma.reguaEnvio.count({ where }),
    ]);
    return montarPagina(
      itens.map((e) => ({
        id: e.id,
        etapa: e.etapaNome,
        marco: e.marco,
        situacao: e.situacao,
        resultado: e.resultado,
        resultadoEm: e.resultadoEm?.toISOString() ?? null,
        observacao: e.observacao,
        promessaAte: e.promessaAte ? deDataDoBanco(e.promessaAte) : null,
        prazoEm: e.prazoEm?.toISOString() ?? null,
        atividadeId: e.atividadeId,
        roteiro: e.etapa?.roteiroLigacao ?? e.texto,
        telefone: e.destino ?? e.parcela.contato?.telefone ?? null,
        contato: e.parcela.contato,
        empresa: e.parcela.empresa,
        parcela: {
          id: e.parcela.id,
          numero: e.parcela.numero,
          valor: formatarValor(e.parcela.valor),
          vencimento: deDataDoBanco(e.parcela.vencimento),
          status: e.parcela.status,
          linkPagamento: e.parcela.linkPagamento,
        },
      })),
      total,
      f,
    );
  }

  // ---- resultado ------------------------------------------------------------------------

  /** R24.5 — registra o resultado da ligação. */
  async registrarResultado(
    usuario: UsuarioAutenticado,
    envioId: string,
    dto: ResultadoLigacaoDto,
  ) {
    this.parcelas.exigirAtuacao(usuario);
    const hoje = hojeLocal();
    if (dto.resultado === 'PROMESSA') {
      if (!dto.promessaAte || !ehDataIso(dto.promessaAte)) {
        throw new DadosInvalidosException(
          'Informe a data prometida para o pagamento.',
          {
            regra: 'R24.5',
            campos: [
              {
                campo: 'promessaAte',
                mensagens: ['obrigatória na promessa (AAAA-MM-DD)'],
              },
            ],
          },
        );
      }
      if (dto.promessaAte < hoje) {
        throw new RegraVioladaException(
          'R24.5',
          'A data prometida não pode ser no passado.',
        );
      }
    }
    const visivel = await this.prisma.reguaEnvio.findFirst({
      where: {
        id: envioId,
        canal: 'LIGACAO',
        parcela: filtroDeParcelasVisiveis(usuario),
      },
      select: { id: true, parcelaId: true },
    });
    if (!visivel) throw new NaoEncontradoException('Ligação não encontrada.');

    const agenda = await this.envios.proximoHorarioDeWhatsapp();
    const config = await this.configuracao.configuracao();
    let parcelaPaga: Parcela | null = null;
    const parcelaId = await this.prisma.$transaction(async (tx) => {
      // Ordem das travas igual à da baixa: primeiro o título, depois o envio.
      await tx.$queryRaw`SELECT id FROM parcelas WHERE id = ${visivel.parcelaId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM regua_envios WHERE id = ${envioId}::uuid FOR UPDATE`;
      const ligacao = await tx.reguaEnvio.findUniqueOrThrow({
        where: { id: envioId },
        include: {
          parcela: {
            include: {
              contrato: { select: { id: true, numero: true, produto: true } },
            },
          },
        },
      });
      if (ligacao.situacao !== 'AGUARDANDO_LIGACAO') {
        throw new ConflitoException(
          'Esta ligação já teve o resultado registrado ou foi cancelada.',
          { regra: 'R24.5', situacao: ligacao.situacao },
        );
      }
      const parcela = ligacao.parcela;
      await tx.reguaEnvio.update({
        where: { id: envioId },
        data: {
          situacao: 'LIGACAO_REGISTRADA',
          resultado: dto.resultado,
          resultadoEm: new Date(),
          resultadoPorId: usuario.id,
          observacao: dto.observacao ?? null,
          promessaAte:
            dto.resultado === 'PROMESSA' && dto.promessaAte
              ? paraDataDoBanco(dto.promessaAte)
              : null,
        },
      });
      await this.concluirAtividade(tx, ligacao.atividadeId, usuario.id);
      await this.auditoria.registrar(tx, {
        acao: 'regua.ligacao_registrada',
        entidade: 'parcela',
        entidadeId: parcela.id,
        resumo: `${usuario.nome} registrou a ligação de cobrança (${ligacao.etapaNome}, título ${parcela.numero}): ${dto.resultado}`,
        dados: {
          envioId,
          resultado: dto.resultado,
          promessaAte: dto.promessaAte ?? null,
          observacao: dto.observacao ?? null,
          regra: 'R24.5',
        },
        relacionados: relacionadosDe(parcela),
      });
      const aberta =
        parcela.status === 'ABERTO' || parcela.status === 'ATRASADO';
      if (!aberta) {
        await this.liberarOuCancelar(
          tx,
          ligacao,
          false,
          agenda,
          'Título não está mais em aberto.',
        );
        return parcela.id;
      }
      if (dto.resultado === 'JA_PAGOU') {
        parcelaPaga = await this.parcelas.darBaixa(
          tx,
          parcela,
          { pagoEm: hoje, valorPago: parcela.valor, formaPagamento: null },
          'LIGACAO',
          usuario.id,
        );
      } else if (dto.resultado === 'PROMESSA' && dto.promessaAte) {
        await tx.parcela.update({
          where: { id: parcela.id },
          data: {
            promessaAte: paraDataDoBanco(dto.promessaAte),
            promessaRegistradaEm: new Date(),
          },
        });
        await this.liberarOuCancelar(
          tx,
          ligacao,
          false,
          agenda,
          'Promessa de pagamento registrada: a régua foi suspensa.',
        );
        const contato = await this.envios.contatoDeCobranca(parcela);
        if (contato) {
          await this.envios.criarAviso(tx, {
            parcela,
            contato,
            produto: parcela.contrato?.produto ?? null,
            tipo: 'PROMESSA_CONFIRMADA',
            nome: 'Confirmação de promessa',
            texto: config.textoPromessaConfirmada,
            assuntoEmail: 'Combinado: pagamento da parcela {{titulo.numero}}',
            promessaAte: dto.promessaAte,
            execucaoId: ligacao.execucaoId,
            hoje,
            agendarWhatsapp: agenda.proximo,
          });
        }
        await this.auditoria.registrar(tx, {
          acao: 'regua.promessa_registrada',
          entidade: 'parcela',
          entidadeId: parcela.id,
          resumo: `Promessa de pagamento do título ${parcela.numero} para ${dto.promessaAte}: a régua fica suspensa até a data`,
          dados: { promessaAte: dto.promessaAte, regra: 'R24.5' },
          relacionados: relacionadosDe(parcela),
        });
      } else {
        await this.liberarOuCancelar(tx, ligacao, true, agenda);
      }
      return parcela.id;
    });
    if (parcelaPaga) await this.parcelas.avisarBaixa(parcelaPaga);
    else {
      const p = await this.prisma.parcela.findUniqueOrThrow({
        where: { id: parcelaId },
      });
      this.tempoReal.parcela(p, 'promessa');
    }
    this.tempoReal.regua({
      execucaoId: null,
      status: 'EM_ANDAMENTO',
      resumo: {},
      envioId,
      situacao: 'LIGACAO_REGISTRADA',
    });
    const lista = await this.prisma.reguaEnvio.findUniqueOrThrow({
      where: { id: envioId },
    });
    return {
      id: lista.id,
      situacao: lista.situacao,
      resultado: lista.resultado,
      promessaAte: lista.promessaAte ? deDataDoBanco(lista.promessaAte) : null,
    };
  }

  /** Passou do horário limite sem resultado: a mensagem da etapa sai sozinha (R24.5). */
  async expirar(agora: Date = new Date()): Promise<number> {
    const vencidas = await this.prisma.reguaEnvio.findMany({
      where: {
        canal: 'LIGACAO',
        situacao: 'AGUARDANDO_LIGACAO',
        prazoEm: { lte: agora },
      },
      select: { id: true },
    });
    let total = 0;
    for (const { id } of vencidas) {
      const feito = await executarComoAtor(
        { tipoAtor: 'AUTOMACAO', descricao: DESCRICAO_DO_ATOR_DA_REGUA },
        async () => {
          const agenda = await this.envios.proximoHorarioDeWhatsapp();
          return this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM regua_envios WHERE id = ${id}::uuid FOR UPDATE`;
            const ligacao = await tx.reguaEnvio.findUniqueOrThrow({
              where: { id },
            });
            if (ligacao.situacao !== 'AGUARDANDO_LIGACAO') return false;
            await tx.reguaEnvio.update({
              where: { id },
              data: {
                situacao: 'LIGACAO_REGISTRADA',
                resultado: 'EXPIRADA',
                resultadoEm: new Date(),
                motivo: 'Sem registro até o horário limite.',
              },
            });
            if (ligacao.atividadeId) {
              await tx.atividade.updateMany({
                where: { id: ligacao.atividadeId, status: 'PENDENTE' },
                data: { status: 'CANCELADA', canceladaEm: new Date() },
              });
            }
            await this.liberarOuCancelar(tx, ligacao, true, agenda);
            await this.auditoria.registrar(tx, {
              acao: 'regua.ligacao_expirada',
              entidade: 'parcela',
              entidadeId: ligacao.parcelaId,
              resumo: `Ligação "${ligacao.etapaNome}" sem registro até o horário limite: as mensagens da etapa foram liberadas`,
              dados: { envioId: id, regra: 'R24.5' },
            });
            return true;
          });
        },
      );
      if (feito) total++;
    }
    return total;
  }

  /** Libera as mensagens retidas da ligação (`liberar`) ou as cancela com o motivo. */
  private async liberarOuCancelar(
    tx: Tx,
    ligacao: ReguaEnvio,
    liberar: boolean,
    agenda: { proximo: () => Date },
    motivo?: string,
  ): Promise<void> {
    const retidas = await tx.reguaEnvio.findMany({
      where: { ligacaoId: ligacao.id, situacao: 'RETIDO' },
      orderBy: { criadoEm: 'asc' },
    });
    for (const r of retidas) {
      if (!liberar) {
        await tx.reguaEnvio.update({
          where: { id: r.id },
          data: { situacao: 'CANCELADO', motivo },
        });
        continue;
      }
      const quando = r.canal === 'WHATSAPP' ? agenda.proximo() : new Date();
      await tx.reguaEnvio.update({
        where: { id: r.id },
        data: {
          situacao: 'AGENDADO',
          agendadoPara: quando,
          motivo: 'Liberada após a ligação.',
        },
      });
      await this.envios.enfileirar(
        tx,
        r,
        r.canal === 'WHATSAPP' ? quando : undefined,
      );
    }
  }

  private async concluirAtividade(
    tx: Tx,
    atividadeId: string | null,
    usuarioId: string,
  ): Promise<void> {
    if (!atividadeId) return;
    const r = await tx.atividade.updateMany({
      where: { id: atividadeId, status: 'PENDENTE' },
      data: {
        status: 'CONCLUIDA',
        concluidaEm: new Date(),
        concluidaPorId: usuarioId,
      },
    });
    if (r.count > 0) {
      await this.eventos.publicar(tx, 'atividade.concluida', {
        atividadeId,
        tipo: 'LIGACAO',
      });
    }
  }
}
