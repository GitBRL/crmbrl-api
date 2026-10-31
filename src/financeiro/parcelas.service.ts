import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { formatarValor, lerValor } from '../comum/dominio/dinheiro';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import {
  type FormaPagamento,
  Prisma,
  type Parcela,
  type StatusParcela,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  deDataDoBanco,
  ehDataIso,
  hojeLocal,
  limitesDaFaixa,
  paraDataDoBanco,
  somarDias,
} from './datas';
import {
  type AtualizarParcelaDto,
  type BaixaDto,
  type CriarParcelaDto,
  type FiltroParcelasDto,
  type RenegociarParcelaDto,
} from './financeiro.dto';
import {
  INCLUIR_PARCELA,
  type ParcelaDto,
  parcelaParaDto,
  statusEfetivo,
} from './financeiro.mapas';
import {
  filtroDeContratosVisiveis,
  filtroDeParcelasVisiveis,
  podeAtuarNoFinanceiro,
  temAcessoAoFinanceiro,
} from './permissoes-financeiro';
import { TempoRealFinanceiro } from './tempo-real-financeiro.service';
import { escreverExportacao } from './exportacao';

export type OrigemDaBaixa = 'MANUAL' | 'IMPORTACAO' | 'LIGACAO';

export interface DadosDaBaixa {
  pagoEm: string;
  valorPago: Prisma.Decimal;
  formaPagamento: FormaPagamento | null;
}

const ROTULO_STATUS: Record<StatusParcela, string> = {
  ABERTO: 'Aberto',
  PAGO: 'Pago',
  ATRASADO: 'Atrasado',
  CANCELADO: 'Cancelado',
  RENEGOCIADO: 'Renegociado',
};

/**
 * Parcelas (títulos a receber, R22.3–R22.5): consulta com visibilidade por papel,
 * criação, edição, baixa manual, cancelamento, renegociação e o atraso automático.
 * A baixa (por qualquer origem) encerra a régua do título (R24.6).
 */
@Injectable()
export class ParcelasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly tempoReal: TempoRealFinanceiro,
    private readonly arquivos: ArquivosService,
  ) {}

  // ---- acesso ------------------------------------------------------------

  exigirAcesso(usuario: UsuarioAutenticado): void {
    if (!temAcessoAoFinanceiro(usuario.papel)) {
      throw new SemPermissaoException('Você não tem acesso ao Financeiro.', {
        regra: 'R22.1',
      });
    }
  }

  exigirAtuacao(usuario: UsuarioAutenticado): void {
    this.exigirAcesso(usuario);
    if (!podeAtuarNoFinanceiro(usuario.papel)) {
      throw new SemPermissaoException('O Comercial só consulta o Financeiro.', {
        regra: 'R22.1',
      });
    }
  }

  // ---- consulta ----------------------------------------------------------

  private filtro(
    usuario: UsuarioAutenticado,
    f: Partial<FiltroParcelasDto>,
    hoje: string,
  ): Prisma.ParcelaWhereInput {
    const e: Prisma.ParcelaWhereInput[] = [filtroDeParcelasVisiveis(usuario)];
    if (f.status?.length) {
      const ou: Prisma.ParcelaWhereInput[] = [];
      const hojeData = paraDataDoBanco(hoje);
      for (const s of f.status) {
        if (s === 'ATRASADO') {
          ou.push(
            { status: 'ATRASADO' },
            { status: 'ABERTO', vencimento: { lt: hojeData } },
          );
        } else if (s === 'ABERTO') {
          ou.push({ status: 'ABERTO', vencimento: { gte: hojeData } });
        } else {
          ou.push({ status: s });
        }
      }
      e.push({ OR: ou });
    }
    if (f.contratoId) e.push({ contratoId: f.contratoId });
    if (f.contatoId) e.push({ contatoId: f.contatoId });
    if (f.empresaId) e.push({ empresaId: f.empresaId });
    if (f.responsavelCsId) {
      e.push({ contrato: { responsavelCsId: f.responsavelCsId } });
    }
    if (f.vencimentoDe)
      e.push({ vencimento: { gte: paraDataDoBanco(f.vencimentoDe) } });
    if (f.vencimentoAte)
      e.push({ vencimento: { lte: paraDataDoBanco(f.vencimentoAte) } });
    if (f.faixa) {
      const { de, ate } = limitesDaFaixa(f.faixa);
      e.push({
        status: { in: ['ABERTO', 'ATRASADO'] },
        vencimento: {
          lte: paraDataDoBanco(somarDias(hoje, -de)),
          ...(ate !== null
            ? { gte: paraDataDoBanco(somarDias(hoje, -ate)) }
            : {}),
        },
      });
    }
    if (f.comPromessa) {
      e.push({ promessaAte: { gte: paraDataDoBanco(hoje) } });
    }
    if (f.busca) {
      const t = f.busca;
      e.push({
        OR: [
          { numero: { contains: t, mode: 'insensitive' } },
          { contato: { nome: { contains: t, mode: 'insensitive' } } },
          { contato: { email: { contains: t, mode: 'insensitive' } } },
          { contato: { telefone: { contains: t.replace(/\D/g, '') || '§' } } },
          { empresa: { nome: { contains: t, mode: 'insensitive' } } },
        ],
      });
    }
    return { AND: e };
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroParcelasDto,
  ): Promise<Pagina<ParcelaDto>> {
    this.exigirAcesso(usuario);
    const hoje = hojeLocal();
    const where = this.filtro(usuario, filtro, hoje);
    const [itens, total] = await Promise.all([
      this.prisma.parcela.findMany({
        where,
        include: INCLUIR_PARCELA,
        orderBy: [{ vencimento: 'asc' }, { numero: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.parcela.count({ where }),
    ]);
    return montarPagina(
      itens.map((p) => parcelaParaDto(p, hoje, this.podeEditar(usuario, p))),
      total,
      filtro,
    );
  }

  /** Totais por status (considerando o vencimento) com os mesmos filtros da lista. */
  async totais(usuario: UsuarioAutenticado, filtro: FiltroParcelasDto) {
    this.exigirAcesso(usuario);
    const hoje = hojeLocal();
    const where = this.filtro(usuario, { ...filtro, status: undefined }, hoje);
    const grupos = await this.prisma.parcela.groupBy({
      by: ['status'],
      where,
      _sum: { valor: true },
      _count: { _all: true },
    });
    const vencidas = await this.prisma.parcela.aggregate({
      where: {
        AND: [
          where,
          { status: 'ABERTO', vencimento: { lt: paraDataDoBanco(hoje) } },
        ],
      },
      _sum: { valor: true },
      _count: { _all: true },
    });
    const por: Record<string, { quantidade: number; valor: string }> = {};
    const soma = (s: StatusParcela, q: number, v: Prisma.Decimal | null) => {
      const a = por[s] ?? { quantidade: 0, valor: '0.00' };
      por[s] = {
        quantidade: a.quantidade + q,
        valor: new Prisma.Decimal(a.valor).plus(v ?? 0).toFixed(2),
      };
    };
    for (const g of grupos) {
      soma(g.status, g._count._all, g._sum.valor);
    }
    // Abertas vencidas migram de ABERTO para ATRASADO.
    if (vencidas._count._all > 0) {
      const q = vencidas._count._all;
      const v = vencidas._sum.valor ?? new Prisma.Decimal(0);
      const ab = por.ABERTO;
      por.ABERTO = {
        quantidade: ab.quantidade - q,
        valor: new Prisma.Decimal(ab.valor).minus(v).toFixed(2),
      };
      soma('ATRASADO', q, v);
    }
    const quantidade = Object.values(por).reduce((a, x) => a + x.quantidade, 0);
    return { quantidade, porStatus: por };
  }

  async detalhar(usuario: UsuarioAutenticado, id: string): Promise<ParcelaDto> {
    const p = await this.obterVisivel(usuario, id);
    return parcelaParaDto(p, hojeLocal(), this.podeEditar(usuario, p));
  }

  async obterVisivel(usuario: UsuarioAutenticado, id: string) {
    this.exigirAcesso(usuario);
    const p = await this.prisma.parcela.findFirst({
      where: { AND: [{ id }, filtroDeParcelasVisiveis(usuario)] },
      include: INCLUIR_PARCELA,
    });
    if (!p) {
      throw new NaoEncontradoException('Parcela não encontrada.');
    }
    return p;
  }

  private podeEditar(
    usuario: UsuarioAutenticado,
    _p: Pick<Parcela, 'id'>,
  ): boolean {
    return podeAtuarNoFinanceiro(usuario.papel);
  }

  /** Linha do tempo: envios da régua e eventos de auditoria do título. */
  async linhaDoTempo(usuario: UsuarioAutenticado, id: string) {
    const parcela = await this.obterVisivel(usuario, id);
    const [envios, auditoria] = await Promise.all([
      this.prisma.reguaEnvio.findMany({
        where: { parcelaId: id },
        orderBy: [{ criadoEm: 'asc' }, { marco: 'asc' }],
      }),
      this.prisma.eventoAuditoria.findMany({
        where: { relacionados: { has: `parcela:${id}` } },
        orderBy: { criadoEm: 'asc' },
        take: 200,
      }),
    ]);
    return {
      parcela: parcelaParaDto(
        parcela,
        hojeLocal(),
        this.podeEditar(usuario, parcela),
      ),
      envios: envios.map((e) => ({
        id: e.id,
        ciclo: e.ciclo,
        marco: e.marco,
        etapa: e.etapaNome,
        tipo: e.tipo,
        canal: e.canal,
        situacao: e.situacao,
        dia: deDataDoBanco(e.dia),
        destino: e.destino,
        agendadoPara: e.agendadoPara?.toISOString() ?? null,
        enviadoEm: e.enviadoEm?.toISOString() ?? null,
        motivo: e.motivo,
        erro: e.erro,
        resultado: e.resultado,
        resultadoEm: e.resultadoEm?.toISOString() ?? null,
        observacao: e.observacao,
        promessaAte: e.promessaAte ? deDataDoBanco(e.promessaAte) : null,
        atividadeId: e.atividadeId,
        mensagemId: e.mensagemId,
      })),
      historico: auditoria.map((a) => ({
        id: String(a.id),
        acao: a.acao,
        resumo: a.resumo,
        ator: a.atorDescricao,
        tipoAtor: a.tipoAtor,
        em: a.criadoEm.toISOString(),
      })),
    };
  }

  // ---- escrita -----------------------------------------------------------

  /** R22.3 — título manual (ou avulso). Exige cliente: contrato, contato ou empresa. */
  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarParcelaDto,
  ): Promise<ParcelaDto> {
    this.exigirAtuacao(usuario);
    if (!ehDataIso(dto.vencimento)) {
      throw dataInvalida('vencimento');
    }
    if (!dto.contratoId && !dto.contatoId && !dto.empresaId) {
      throw new DadosInvalidosException(
        'Informe o contrato ou o cliente do título.',
        {
          regra: 'R22.3',
          campos: [
            {
              campo: 'contratoId',
              mensagens: ['informe contrato, contato ou empresa'],
            },
          ],
        },
      );
    }
    const criada = await this.prisma.$transaction(async (tx) => {
      let contatoId = dto.contatoId ?? null;
      let empresaId = dto.empresaId ?? null;
      let sequencia: number | null = null;
      if (dto.contratoId) {
        const contrato = await tx.contrato.findFirst({
          where: { AND: [{ id: dto.contratoId }, visivelDoContrato(usuario)] },
        });
        if (!contrato) {
          throw new NaoEncontradoException('Contrato não encontrado.');
        }
        contatoId ??= contrato.contatoId;
        empresaId ??= contrato.empresaId;
        sequencia =
          ((
            await tx.parcela.aggregate({
              where: { contratoId: contrato.id },
              _max: { sequencia: true },
            })
          )._max.sequencia ?? 0) + 1;
      }
      await this.conferirCliente(tx, contatoId, empresaId);
      const numero = dto.numero ?? numeroAutomatico();
      if (await tx.parcela.findUnique({ where: { numero } })) {
        throw new ConflitoException('Já existe um título com este número.', {
          regra: 'R22.3',
          numero,
        });
      }
      const parcela = await tx.parcela.create({
        data: {
          numero,
          sequencia,
          contratoId: dto.contratoId ?? null,
          contatoId,
          empresaId,
          origem: 'MANUAL',
          descricao: dto.descricao ?? null,
          vencimento: paraDataDoBanco(dto.vencimento),
          vencimentoOriginal: paraDataDoBanco(dto.vencimento),
          valor: lerValor(dto.valor),
          linkBoleto: dto.linkBoleto ?? null,
          linkPagamento: dto.linkPagamento ?? null,
          pix: dto.pix ?? null,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'parcela.criada',
        entidade: 'parcela',
        entidadeId: parcela.id,
        resumo: `${usuario.nome} criou o título ${parcela.numero} (R$ ${formatarValor(parcela.valor)}, vence ${dto.vencimento})`,
        dados: {
          numero,
          vencimento: dto.vencimento,
          valor: dto.valor,
          regra: 'R22.3',
        },
        relacionados: relacionadosDe(parcela),
      });
      return parcela;
    });
    this.tempoReal.parcela(criada, 'alterada');
    return this.detalhar(usuario, criada.id);
  }

  /** R22.3 — edição. Mudar o vencimento reinicia a régua (R24.3). */
  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarParcelaDto,
  ): Promise<ParcelaDto> {
    this.exigirAtuacao(usuario);
    if (dto.vencimento !== undefined && !ehDataIso(dto.vencimento)) {
      throw dataInvalida('vencimento');
    }
    const atualizada = await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      this.exigirAberta(atual, 'R22.3');
      const dados: Prisma.ParcelaUncheckedUpdateInput = {};
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      const marcar = (campo: string, a: unknown, d: unknown) => {
        antes[campo] = a;
        depois[campo] = d;
      };
      if (dto.descricao !== undefined && dto.descricao !== atual.descricao) {
        dados.descricao = dto.descricao;
        marcar('descricao', atual.descricao, dto.descricao);
      }
      for (const campo of ['linkBoleto', 'linkPagamento', 'pix'] as const) {
        if (dto[campo] !== undefined && dto[campo] !== atual[campo]) {
          dados[campo] = dto[campo];
          marcar(campo, atual[campo], dto[campo]);
        }
      }
      if (dto.valor !== undefined) {
        const novo = lerValor(dto.valor);
        if (!novo.equals(atual.valor)) {
          dados.valor = novo;
          marcar('valor', formatarValor(atual.valor), dto.valor);
        }
      }
      let reiniciar = false;
      if (
        dto.vencimento !== undefined &&
        dto.vencimento !== deDataDoBanco(atual.vencimento)
      ) {
        dados.vencimento = paraDataDoBanco(dto.vencimento);
        dados.status = dto.vencimento < hojeLocal() ? 'ATRASADO' : 'ABERTO';
        dados.cicloRegua = { increment: 1 };
        dados.promessaAte = null;
        dados.promessaRegistradaEm = null;
        marcar('vencimento', deDataDoBanco(atual.vencimento), dto.vencimento);
        reiniciar = true;
      }
      if (Object.keys(dados).length === 0) {
        return atual;
      }
      if (reiniciar) {
        await this.cancelarPendenciasDaRegua(
          tx,
          id,
          'Vencimento alterado: a régua recomeça.',
        );
      }
      const nova = await tx.parcela.update({ where: { id }, data: dados });
      await this.auditoria.registrar(tx, {
        acao: 'parcela.atualizada',
        entidade: 'parcela',
        entidadeId: id,
        resumo: `${usuario.nome} alterou o título ${nova.numero}${reiniciar ? ' (a régua recomeça)' : ''}`,
        dados: {
          antes,
          depois,
          reguaReiniciada: reiniciar,
          regra: reiniciar ? 'R24.3' : 'R22.3',
        },
        relacionados: relacionadosDe(nova),
      });
      return nova;
    });
    this.tempoReal.parcela(atualizada, 'alterada');
    return this.detalhar(usuario, id);
  }

  /** R22.4 — baixa manual. */
  async baixar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: BaixaDto,
  ): Promise<ParcelaDto> {
    this.exigirAtuacao(usuario);
    if (dto.pagoEm !== undefined && !ehDataIso(dto.pagoEm)) {
      throw dataInvalida('pagoEm');
    }
    const paga = await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      this.exigirAberta(
        atual,
        'R22.4',
        'Só uma parcela em aberto recebe baixa.',
      );
      return this.darBaixa(
        tx,
        atual,
        {
          pagoEm: dto.pagoEm ?? hojeLocal(),
          valorPago: dto.valorPago ? lerValor(dto.valorPago) : atual.valor,
          formaPagamento: dto.formaPagamento ?? null,
        },
        'MANUAL',
        usuario.id,
      );
    });
    await this.avisarBaixa(paga);
    return this.detalhar(usuario, id);
  }

  /** Emite o tempo real da baixa (depois do commit). */
  async avisarBaixa(parcela: Parcela): Promise<void> {
    const contrato = parcela.contratoId
      ? await this.prisma.contrato.findUnique({
          where: { id: parcela.contratoId },
          select: { responsavelCsId: true },
        })
      : null;
    this.tempoReal.parcela(parcela, 'paga', contrato?.responsavelCsId);
  }

  /**
   * Dá baixa dentro da transação (R22.4, R24.6): marca paga, encerra a régua do
   * título (cancela mensagens, e-mails e ligações que não saíram), audita e publica
   * `parcela.paga`. Quem chama já conferiu que está em aberto.
   */
  async darBaixa(
    tx: Tx,
    atual: Parcela,
    dados: DadosDaBaixa,
    origem: OrigemDaBaixa,
    usuarioId: string | null,
  ): Promise<Parcela> {
    const paga = await tx.parcela.update({
      where: { id: atual.id },
      data: {
        status: 'PAGO',
        pagoEm: paraDataDoBanco(dados.pagoEm),
        valorPago: dados.valorPago,
        formaPagamento: dados.formaPagamento ?? atual.formaPagamento,
        baixaOrigem: origem,
        baixaPorId: usuarioId,
        promessaAte: null,
      },
    });
    const cancelados = await this.cancelarPendenciasDaRegua(
      tx,
      atual.id,
      'Título pago: a régua foi encerrada.',
    );
    await this.auditoria.registrar(tx, {
      acao: 'parcela.baixada',
      entidade: 'parcela',
      entidadeId: atual.id,
      resumo: `Baixa do título ${atual.numero}: R$ ${formatarValor(dados.valorPago)} em ${dados.pagoEm} (${origem === 'MANUAL' ? 'manual' : origem === 'IMPORTACAO' ? 'importação' : 'ligação da régua'})`,
      dados: {
        pagoEm: dados.pagoEm,
        valorPago: formatarValor(dados.valorPago),
        formaPagamento: dados.formaPagamento,
        origem,
        reguaEncerrada: true,
        pendenciasCanceladas: cancelados,
        regra: 'R22.4',
      },
      relacionados: relacionadosDe(paga),
    });
    await this.eventos.publicar(tx, 'parcela.paga', {
      parcelaId: paga.id,
      numero: paga.numero,
      contratoId: paga.contratoId,
      contatoId: paga.contatoId,
      empresaId: paga.empresaId,
      valor: formatarValor(paga.valor),
      valorPago: formatarValor(dados.valorPago),
      pagoEm: dados.pagoEm,
      origem,
    });
    return paga;
  }

  async cancelar(usuario: UsuarioAutenticado, id: string): Promise<ParcelaDto> {
    this.exigirAtuacao(usuario);
    const cancelada = await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      this.exigirAberta(
        atual,
        'R22.3',
        'Só uma parcela em aberto pode ser cancelada.',
      );
      const nova = await tx.parcela.update({
        where: { id },
        data: { status: 'CANCELADO', promessaAte: null },
      });
      await this.cancelarPendenciasDaRegua(tx, id, 'Título cancelado.');
      await this.auditoria.registrar(tx, {
        acao: 'parcela.cancelada',
        entidade: 'parcela',
        entidadeId: id,
        resumo: `${usuario.nome} cancelou o título ${nova.numero}`,
        dados: { regra: 'R22.3' },
        relacionados: relacionadosDe(nova),
      });
      return nova;
    });
    this.tempoReal.parcela(cancelada, 'cancelada');
    return this.detalhar(usuario, id);
  }

  /** R22.3 — renegocia: a parcela vira RENEGOCIADO e nasce outra, com a régua do zero. */
  async renegociar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: RenegociarParcelaDto,
  ): Promise<ParcelaDto> {
    this.exigirAtuacao(usuario);
    if (!ehDataIso(dto.vencimento)) {
      throw dataInvalida('vencimento');
    }
    const nova = await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      this.exigirAberta(
        atual,
        'R22.3',
        'Só uma parcela em aberto pode ser renegociada.',
      );
      const quantas = await tx.parcela.count({
        where: { numero: { startsWith: `${atual.numero}-R` } },
      });
      const criada = await tx.parcela.create({
        data: {
          numero: `${atual.numero}-R${quantas + 1}`,
          sequencia: atual.sequencia,
          contratoId: atual.contratoId,
          contatoId: atual.contatoId,
          empresaId: atual.empresaId,
          origem: 'RENEGOCIACAO',
          descricao: atual.descricao,
          vencimento: paraDataDoBanco(dto.vencimento),
          vencimentoOriginal: paraDataDoBanco(dto.vencimento),
          valor: dto.valor ? lerValor(dto.valor) : atual.valor,
          status: dto.vencimento < hojeLocal() ? 'ATRASADO' : 'ABERTO',
          linkBoleto: null,
          linkPagamento: atual.linkPagamento,
          pix: null,
          criadoPorId: usuario.id,
        },
      });
      await tx.parcela.update({
        where: { id },
        data: {
          status: 'RENEGOCIADO',
          renegociadaParaId: criada.id,
          promessaAte: null,
        },
      });
      await this.cancelarPendenciasDaRegua(tx, id, 'Título renegociado.');
      await this.auditoria.registrar(tx, {
        acao: 'parcela.renegociada',
        entidade: 'parcela',
        entidadeId: id,
        resumo: `${usuario.nome} renegociou o título ${atual.numero}: novo título ${criada.numero}, vence ${dto.vencimento}`,
        dados: {
          novaParcelaId: criada.id,
          novoNumero: criada.numero,
          vencimento: dto.vencimento,
          valor: formatarValor(criada.valor),
          regra: 'R22.3',
        },
        relacionados: relacionadosDe(atual),
      });
      return criada;
    });
    this.tempoReal.parcela(nova, 'renegociada');
    return this.detalhar(usuario, nova.id);
  }

  /** Exportação (XLSX/CSV) da situação dos títulos visíveis, com os filtros da lista. */
  async exportar(
    usuario: UsuarioAutenticado,
    filtro: FiltroParcelasDto,
    formato: 'xlsx' | 'csv' = 'xlsx',
  ): Promise<ArquivoDto> {
    this.exigirAcesso(usuario);
    const hoje = hojeLocal();
    const where = this.filtro(usuario, filtro, hoje);
    const linhas: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const lote = await this.prisma.parcela.findMany({
        where,
        include: INCLUIR_PARCELA,
        orderBy: { id: 'asc' },
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (lote.length === 0) break;
      cursor = lote.at(-1)?.id;
      const ids = lote.map((p) => p.id);
      const ultimos = await this.prisma.reguaEnvio.findMany({
        where: { parcelaId: { in: ids }, canal: { not: null } },
        orderBy: { criadoEm: 'desc' },
        select: {
          parcelaId: true,
          etapaNome: true,
          situacao: true,
          canal: true,
        },
      });
      const ultimoPor = new Map<string, string>();
      for (const e of ultimos) {
        if (!ultimoPor.has(e.parcelaId)) {
          ultimoPor.set(
            e.parcelaId,
            `${e.etapaNome} (${e.canal}: ${e.situacao})`,
          );
        }
      }
      for (const p of lote) {
        const d = parcelaParaDto(p, hoje, false);
        linhas.push([
          d.numero,
          d.contrato?.codigo ?? '',
          d.contato?.nome ?? d.empresa?.nome ?? '',
          d.contato?.telefone ?? '',
          d.contato?.email ?? '',
          d.vencimento,
          d.valor,
          ROTULO_STATUS[d.status],
          String(d.diasEmAtraso),
          d.pagoEm ?? '',
          d.valorPago ?? '',
          d.formaPagamento ?? '',
          d.promessaAte ?? '',
          ultimoPor.get(p.id) ?? '',
        ]);
      }
    }
    const arquivo = await escreverExportacao(this.arquivos, {
      base: `titulos-${hoje}`,
      formato,
      folha: 'Títulos',
      cabecalho: [
        'Número',
        'Contrato',
        'Cliente',
        'Telefone',
        'E-mail',
        'Vencimento',
        'Valor',
        'Situação',
        'Dias em atraso',
        'Pago em',
        'Valor pago',
        'Forma de pagamento',
        'Promessa até',
        'Última etapa da régua',
      ],
      linhas,
      usuarioId: usuario.id,
    });
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'parcela.exportada',
        entidade: 'parcela',
        entidadeId: null,
        resumo: `${usuario.nome} exportou ${linhas.length} títulos (${formato.toUpperCase()})`,
        dados: {
          linhas: linhas.length,
          formato,
          arquivoId: arquivo.id,
          regra: 'R24.9',
        },
      }),
    );
    return ArquivoDto.de(arquivo);
  }

  // ---- atraso automático ---------------------------------------------------

  /**
   * R22.7 — marca como ATRASADO as abertas vencidas antes de `hoje`, audita como
   * sistema e publica `parcela.atrasada`. Idempotente.
   */
  async marcarAtrasadas(hoje: string = hojeLocal()): Promise<number> {
    let total = 0;
    for (;;) {
      const lote = await this.prisma.parcela.findMany({
        where: { status: 'ABERTO', vencimento: { lt: paraDataDoBanco(hoje) } },
        take: 200,
        select: { id: true },
      });
      if (lote.length === 0) break;
      const marcadas = await executarComoAtor(
        { tipoAtor: 'SISTEMA', descricao: 'Atraso de parcelas' },
        () =>
          this.prisma.$transaction(async (tx) => {
            const r: Parcela[] = [];
            for (const { id } of lote) {
              const feita = await tx.parcela.updateManyAndReturn({
                where: { id, status: 'ABERTO' },
                data: { status: 'ATRASADO', atrasadaEm: new Date() },
              });
              for (const p of feita) {
                r.push(p);
                await this.auditoria.registrar(tx, {
                  acao: 'parcela.atrasada',
                  entidade: 'parcela',
                  entidadeId: p.id,
                  resumo: `Título ${p.numero} venceu em ${deDataDoBanco(p.vencimento)} sem pagamento`,
                  dados: {
                    vencimento: deDataDoBanco(p.vencimento),
                    regra: 'R22.7',
                  },
                  relacionados: relacionadosDe(p),
                });
                await this.eventos.publicar(tx, 'parcela.atrasada', {
                  parcelaId: p.id,
                  numero: p.numero,
                  contratoId: p.contratoId,
                  contatoId: p.contatoId,
                  empresaId: p.empresaId,
                  valor: formatarValor(p.valor),
                  vencimento: deDataDoBanco(p.vencimento),
                });
              }
            }
            return r;
          }),
      );
      total += marcadas.length;
      for (const p of marcadas) this.tempoReal.parcela(p, 'atrasada');
      if (marcadas.length === 0) break;
    }
    return total;
  }

  // ---- peças usadas pela régua e pela importação ----------------------------

  /**
   * Cancela o que a régua ainda não enviou do título (mensagens agendadas ou
   * retidas, ligações pendentes e as atividades delas). Devolve quantos itens.
   */
  async cancelarPendenciasDaRegua(
    tx: Tx,
    parcelaId: string,
    motivo: string,
  ): Promise<number> {
    const pendentes = await tx.reguaEnvio.findMany({
      where: {
        parcelaId,
        situacao: { in: ['AGENDADO', 'RETIDO', 'AGUARDANDO_LIGACAO'] },
      },
      select: { id: true, atividadeId: true },
    });
    if (pendentes.length === 0) return 0;
    await tx.reguaEnvio.updateMany({
      where: { id: { in: pendentes.map((p) => p.id) } },
      data: { situacao: 'CANCELADO', motivo },
    });
    const atividades = pendentes.flatMap((p) =>
      p.atividadeId ? [p.atividadeId] : [],
    );
    if (atividades.length > 0) {
      await tx.atividade.updateMany({
        where: { id: { in: atividades }, status: 'PENDENTE' },
        data: { status: 'CANCELADA', canceladaEm: new Date() },
      });
    }
    return pendentes.length;
  }

  private async travar(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<Parcela> {
    const visivel = await tx.parcela.findFirst({
      where: { AND: [{ id }, filtroDeParcelasVisiveis(usuario)] },
      select: { id: true },
    });
    if (!visivel) {
      throw new NaoEncontradoException('Parcela não encontrada.');
    }
    const [linha] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM parcelas WHERE id = ${id}::uuid FOR UPDATE`;
    void linha;
    return tx.parcela.findUniqueOrThrow({ where: { id } });
  }

  private exigirAberta(
    p: Pick<Parcela, 'status' | 'vencimento'>,
    regra: string,
    mensagem = 'Só uma parcela em aberto pode ser alterada.',
  ): void {
    const s = statusEfetivo(p, hojeLocal());
    if (s !== 'ABERTO' && s !== 'ATRASADO') {
      throw new RegraVioladaException(regra, mensagem, { status: p.status });
    }
  }

  private async conferirCliente(
    tx: Tx,
    contatoId: string | null,
    empresaId: string | null,
  ): Promise<void> {
    if (
      contatoId &&
      !(await tx.contato.findFirst({
        where: { id: contatoId, excluidoEm: null },
        select: { id: true },
      }))
    ) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
    if (
      empresaId &&
      !(await tx.empresa.findFirst({
        where: { id: empresaId, excluidoEm: null },
        select: { id: true },
      }))
    ) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
  }
}

const visivelDoContrato = filtroDeContratosVisiveis;

export function relacionadosDe(
  p: Pick<Parcela, 'contratoId' | 'contatoId' | 'empresaId'>,
): Record<string, string> {
  return {
    ...(p.contratoId ? { contrato: p.contratoId } : {}),
    ...(p.contatoId ? { contato: p.contatoId } : {}),
    ...(p.empresaId ? { empresa: p.empresaId } : {}),
  };
}

function dataInvalida(campo: string): DadosInvalidosException {
  return new DadosInvalidosException('Data inválida.', {
    campos: [{ campo, mensagens: ['deve ser uma data AAAA-MM-DD válida'] }],
  });
}

function numeroAutomatico(): string {
  return `T-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
}
