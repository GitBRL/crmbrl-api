import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import { formatarValor, lerValor } from '../comum/dominio/dinheiro';
import { ehLiderDoSetor } from '../comum/dominio/papeis';
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
  type Contrato,
  type PeriodicidadeContrato,
  Prisma,
  type TipoMovimentoMrr,
} from '../generated/prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import {
  deDataDoBanco,
  ehDataIso,
  hojeLocal,
  mesesDaPeriodicidade,
  mrrEmCentavos,
  paraDataDoBanco,
  somarMeses,
  vencimentosDoContrato,
} from './datas';
import { LIMITE_DE_PARCELAS_GERADAS } from './financeiro.constantes';
import type {
  AtualizarContratoDto,
  CancelarContratoDto,
  CriarContratoDto,
  FiltroContratosDto,
} from './financeiro.dto';
import {
  type ContratoDto,
  codigoDoContrato,
  contratoParaDto,
  INCLUIR_CONTRATO,
  type ResumoDasParcelas,
} from './financeiro.mapas';
import {
  ehCsDaCarteira,
  ehGestorFinanceiro,
  filtroDeContratosVisiveis,
  podeAtuarNoFinanceiro,
} from './permissoes-financeiro';
import { ParcelasService } from './parcelas.service';

/**
 * Contratos (R22.2): cliente (empresa e/ou contato), negócio ganho de origem, produto,
 * valor e periodicidade, prazo, renovação, status e responsável de CS. O MRR mensal
 * vira movimentos (novo, expansão, contração, churn — R23.1).
 */
@Injectable()
export class ContratosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly parcelas: ParcelasService,
  ) {}

  private exigirAcesso(usuario: UsuarioAutenticado): void {
    this.parcelas.exigirAcesso(usuario);
  }

  private exigirAtuacao(usuario: UsuarioAutenticado): void {
    this.parcelas.exigirAtuacao(usuario);
  }

  // ---- consulta ----------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    f: FiltroContratosDto,
  ): Promise<Pagina<ContratoDto>> {
    this.exigirAcesso(usuario);
    const e: Prisma.ContratoWhereInput[] = [filtroDeContratosVisiveis(usuario)];
    if (f.status?.length) e.push({ status: { in: f.status } });
    if (f.empresaId) e.push({ empresaId: f.empresaId });
    if (f.contatoId) e.push({ contatoId: f.contatoId });
    if (f.negocioId) e.push({ negocioId: f.negocioId });
    if (f.responsavelCsId) e.push({ responsavelCsId: f.responsavelCsId });
    if (f.busca) {
      const numero = /^c?-?0*(\d{1,9})$/i.exec(f.busca)?.[1];
      e.push({
        OR: [
          { produto: { contains: f.busca, mode: 'insensitive' } },
          { empresa: { nome: { contains: f.busca, mode: 'insensitive' } } },
          { contato: { nome: { contains: f.busca, mode: 'insensitive' } } },
          ...(numero ? [{ numero: Number(numero) }] : []),
        ],
      });
    }
    const where: Prisma.ContratoWhereInput = { AND: e };
    const [itens, total] = await Promise.all([
      this.prisma.contrato.findMany({
        where,
        include: INCLUIR_CONTRATO,
        orderBy: [{ criadoEm: 'desc' }],
        ...paraSkipTake(f),
      }),
      this.prisma.contrato.count({ where }),
    ]);
    return montarPagina(
      itens.map((c) => contratoParaDto(c, podeAtuarNoFinanceiro(usuario))),
      total,
      f,
    );
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ContratoDto> {
    const c = await this.obterVisivel(usuario, id);
    const dto = contratoParaDto(c, podeAtuarNoFinanceiro(usuario));
    dto.resumoParcelas = await this.resumoDasParcelas(id);
    return dto;
  }

  async obterVisivel(usuario: UsuarioAutenticado, id: string) {
    this.exigirAcesso(usuario);
    const c = await this.prisma.contrato.findFirst({
      where: { AND: [{ id }, filtroDeContratosVisiveis(usuario)] },
      include: INCLUIR_CONTRATO,
    });
    if (!c) throw new NaoEncontradoException('Contrato não encontrado.');
    return c;
  }

  private async resumoDasParcelas(
    contratoId: string,
  ): Promise<ResumoDasParcelas> {
    const hoje = paraDataDoBanco(hojeLocal());
    const [grupos, vencidas] = await Promise.all([
      this.prisma.parcela.groupBy({
        by: ['status'],
        where: { contratoId },
        _sum: { valor: true, valorPago: true },
        _count: { _all: true },
      }),
      this.prisma.parcela.aggregate({
        where: { contratoId, status: 'ABERTO', vencimento: { lt: hoje } },
        _sum: { valor: true },
        _count: { _all: true },
      }),
    ]);
    const r = { total: 0, abertas: 0, atrasadas: 0, pagas: 0 };
    let aberto = new Prisma.Decimal(0);
    let atrasado = new Prisma.Decimal(0);
    let pago = new Prisma.Decimal(0);
    for (const g of grupos) {
      r.total += g._count._all;
      if (g.status === 'ABERTO') {
        r.abertas += g._count._all;
        aberto = aberto.plus(g._sum.valor ?? 0);
      } else if (g.status === 'ATRASADO') {
        r.atrasadas += g._count._all;
        atrasado = atrasado.plus(g._sum.valor ?? 0);
      } else if (g.status === 'PAGO') {
        r.pagas += g._count._all;
        pago = pago.plus(g._sum.valorPago ?? g._sum.valor ?? 0);
      }
    }
    const q = vencidas._count._all;
    const v = vencidas._sum.valor ?? new Prisma.Decimal(0);
    return {
      ...r,
      abertas: r.abertas - q,
      atrasadas: r.atrasadas + q,
      valorEmAberto: aberto.minus(v).toFixed(2),
      valorAtrasado: atrasado.plus(v).toFixed(2),
      valorPago: pago.toFixed(2),
    };
  }

  /** R22.6 — dados para pré-preencher o contrato de um negócio ganho. */
  async sugestaoDoNegocio(usuario: UsuarioAutenticado, negocioId: string) {
    this.exigirAtuacao(usuario);
    const negocio = await this.prisma.negocio.findFirst({
      where: { id: negocioId, excluidoEm: null },
      include: { empresa: true, contato: true, funil: true },
    });
    if (!negocio || !(await this.negocioVisivel(usuario, negocio))) {
      throw new NaoEncontradoException('Negócio não encontrado.');
    }
    const contratos = await this.prisma.contrato.count({
      where: { negocioId },
    });
    return {
      negocioId,
      negocioGanho: negocio.status === 'GANHO',
      jaTemContrato: contratos > 0,
      sugestao: {
        negocioId,
        empresaId: negocio.empresaId,
        contatoId: negocio.contatoId,
        produto: negocio.titulo,
        valor: formatarValor(negocio.valorRecorrente ?? negocio.valor),
        periodicidade: negocio.valorRecorrente ? 'MENSAL' : 'UNICO',
        inicioEm: hojeLocal(),
        responsavelCsId: ehCsDaCarteira(usuario) ? usuario.id : null,
      },
    };
  }

  /** Negócios ganhos, visíveis ao usuário, que ainda não têm contrato (R22.6). */
  async negociosSemContrato(usuario: UsuarioAutenticado, limite = 50) {
    this.exigirAtuacao(usuario);
    const visiveis: Prisma.NegocioWhereInput = ehGestorFinanceiro(usuario)
      ? {}
      : {
          OR: [
            { responsavelId: usuario.id },
            { contato: { responsavelId: usuario.id } },
          ],
        };
    const negocios = await this.prisma.negocio.findMany({
      where: {
        AND: [
          { status: 'GANHO', excluidoEm: null, contratos: { none: {} } },
          visiveis,
        ],
      },
      include: {
        empresa: { select: { id: true, nome: true } },
        contato: { select: { id: true, nome: true } },
      },
      orderBy: { ganhoEm: 'desc' },
      take: limite,
    });
    return negocios.map((n) => ({
      id: n.id,
      titulo: n.titulo,
      valor: formatarValor(n.valor),
      valorRecorrente: formatarValor(n.valorRecorrente),
      ganhoEm: n.ganhoEm?.toISOString() ?? null,
      empresa: n.empresa,
      contato: n.contato,
    }));
  }

  private async negocioVisivel(
    usuario: UsuarioAutenticado,
    negocio: {
      responsavelId: string | null;
      contatoId: string;
      funil: { area: string };
    },
  ): Promise<boolean> {
    if (ehGestorFinanceiro(usuario) || negocio.responsavelId === usuario.id)
      return true;
    if (ehLiderDoSetor(usuario, negocio.funil.area)) return true;
    const contato = await this.prisma.contato.findUnique({
      where: { id: negocio.contatoId },
      select: { responsavelId: true },
    });
    return contato?.responsavelId === usuario.id;
  }

  // ---- criação ------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarContratoDto,
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    const inicio = exigirData(dto.inicioEm, 'inicioEm');
    if (dto.fimEm) exigirData(dto.fimEm, 'fimEm');
    if (dto.renovacaoEm) exigirData(dto.renovacaoEm, 'renovacaoEm');
    if (dto.fimEm && dto.fimEm < inicio) {
      throw new RegraVioladaException(
        'R22.2',
        'O fim do contrato não pode ser antes do início.',
      );
    }
    const periodicidade = dto.periodicidade ?? 'MENSAL';
    const valor = lerValor(dto.valor);
    const criado = await this.prisma.$transaction(async (tx) => {
      let empresaId = dto.empresaId ?? null;
      let contatoId = dto.contatoId ?? null;
      let responsavelCsId = dto.responsavelCsId ?? null;
      if (dto.negocioId) {
        const negocio = await tx.negocio.findFirst({
          where: { id: dto.negocioId, excluidoEm: null },
          include: { funil: { select: { area: true } } },
        });
        if (!negocio || !(await this.negocioVisivel(usuario, negocio))) {
          throw new NaoEncontradoException('Negócio não encontrado.');
        }
        if (negocio.status !== 'GANHO') {
          throw new RegraVioladaException(
            'R22.2',
            'Só um negócio ganho origina contrato.',
          );
        }
        empresaId ??= negocio.empresaId;
        contatoId ??= negocio.contatoId;
      }
      if (!empresaId && !contatoId) {
        throw new DadosInvalidosException(
          'Informe o cliente do contrato (empresa ou contato).',
          {
            regra: 'R22.2',
            campos: [
              {
                campo: 'empresaId',
                mensagens: ['informe a empresa ou o contato'],
              },
            ],
          },
        );
      }
      await this.conferirCliente(tx, empresaId, contatoId);
      if (ehCsDaCarteira(usuario)) {
        responsavelCsId = usuario.id;
      }
      if (responsavelCsId) await this.conferirResponsavel(tx, responsavelCsId);
      const mrr = new Prisma.Decimal(
        mrrEmCentavos(valor.mul(100).toNumber(), periodicidade),
      ).div(100);
      const contrato = await tx.contrato.create({
        data: {
          empresaId,
          contatoId,
          negocioId: dto.negocioId ?? null,
          produto: dto.produto,
          descricao: dto.descricao ?? null,
          valor,
          periodicidade,
          mrr,
          inicioEm: paraDataDoBanco(inicio),
          fimEm: dto.fimEm ? paraDataDoBanco(dto.fimEm) : null,
          renovacaoEm: dto.renovacaoEm
            ? paraDataDoBanco(dto.renovacaoEm)
            : null,
          renovacaoAutomatica: dto.renovacaoAutomatica ?? false,
          diaVencimento: dto.diaVencimento ?? null,
          responsavelCsId,
          criadoPorId: usuario.id,
        },
      });
      if (mrr.gt(0)) {
        await this.movimento(
          tx,
          contrato.id,
          'NOVO',
          new Prisma.Decimal(0),
          mrr,
          'Contrato criado',
          usuario.id,
        );
      }
      let geradas = 0;
      if (dto.gerarParcelas !== false) {
        geradas = await this.gerarParcelas(tx, contrato, {
          quantidade: dto.quantidadeParcelas,
          usuarioId: usuario.id,
        });
      }
      await this.auditoria.registrar(tx, {
        acao: 'contrato.criado',
        entidade: 'contrato',
        entidadeId: contrato.id,
        resumo: `${usuario.nome} criou o contrato ${codigoDoContrato(contrato.numero)} (${contrato.produto}, R$ ${formatarValor(valor)} ${periodicidade.toLowerCase()})`,
        dados: {
          produto: contrato.produto,
          valor: formatarValor(valor),
          periodicidade,
          mrr: formatarValor(mrr),
          parcelasGeradas: geradas,
          negocioId: dto.negocioId ?? null,
          regra: 'R22.2',
        },
        relacionados: relacionadosDoContrato(contrato),
      });
      await this.eventos.publicar(
        tx,
        'contrato.criado',
        dadosDoEvento(contrato),
      );
      return contrato;
    });
    return this.detalhar(usuario, criado.id);
  }

  /** Gera as parcelas do contrato (R22.3). Devolve quantas criou. */
  async gerarParcelas(
    tx: Tx,
    contrato: Contrato,
    opcoes: {
      quantidade?: number;
      usuarioId: string | null;
      /** Continua depois da última parcela existente. */
      estender?: boolean;
    },
  ): Promise<number> {
    const ultima = await tx.parcela.aggregate({
      where: { contratoId: contrato.id },
      _max: { sequencia: true },
    });
    const existentes = ultima._max.sequencia ?? 0;
    const inicio = deDataDoBanco(contrato.inicioEm);
    const meses = mesesDaPeriodicidade(contrato.periodicidade);
    const vencimentos = vencimentosDoContrato({
      inicio,
      periodicidade: contrato.periodicidade,
      diaVencimento: contrato.diaVencimento,
      ate:
        opcoes.quantidade === undefined && contrato.fimEm
          ? deDataDoBanco(contrato.fimEm)
          : null,
      quantidade: opcoes.quantidade,
      aPartirDoPeriodo: opcoes.estender ? existentes : 0,
      limite: LIMITE_DE_PARCELAS_GERADAS,
    });
    if (meses === 0 && existentes > 0) {
      return 0;
    }
    const codigo = codigoDoContrato(contrato.numero);
    let criadas = 0;
    for (const [i, vencimento] of vencimentos.entries()) {
      const sequencia = existentes + i + 1;
      await tx.parcela.create({
        data: {
          numero: `${codigo}-${String(sequencia).padStart(2, '0')}`,
          sequencia,
          contratoId: contrato.id,
          contatoId: contrato.contatoId,
          empresaId: contrato.empresaId,
          origem: 'CONTRATO',
          descricao: `${contrato.produto} — parcela ${sequencia}`,
          vencimento: paraDataDoBanco(vencimento),
          vencimentoOriginal: paraDataDoBanco(vencimento),
          valor: contrato.valor,
          status: vencimento < hojeLocal() ? 'ATRASADO' : 'ABERTO',
          criadoPorId: opcoes.usuarioId,
        },
      });
      criadas++;
    }
    return criadas;
  }

  async gerarMaisParcelas(
    usuario: UsuarioAutenticado,
    id: string,
    quantidade: number,
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const contrato = await this.travar(tx, usuario, id);
      if (contrato.status !== 'ATIVO' && contrato.status !== 'SUSPENSO') {
        throw new RegraVioladaException(
          'R22.2',
          'Só um contrato ativo ou suspenso gera parcelas.',
        );
      }
      const criadas = await this.gerarParcelas(tx, contrato, {
        quantidade,
        usuarioId: usuario.id,
        estender: true,
      });
      await this.auditoria.registrar(tx, {
        acao: 'contrato.parcelas_geradas',
        entidade: 'contrato',
        entidadeId: id,
        resumo: `${usuario.nome} gerou ${criadas} parcelas do contrato ${codigoDoContrato(contrato.numero)}`,
        dados: { criadas, regra: 'R22.3' },
        relacionados: relacionadosDoContrato(contrato),
      });
    });
    return this.detalhar(usuario, id);
  }

  // ---- alteração -----------------------------------------------------------

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarContratoDto,
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      if (atual.status === 'CANCELADO' || atual.status === 'ENCERRADO') {
        throw new RegraVioladaException(
          'R22.2',
          'Reative o contrato antes de alterá-lo.',
          { status: atual.status },
        );
      }
      const dados: Prisma.ContratoUncheckedUpdateInput = {};
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      const mudar = (campo: string, a: unknown, d: unknown) => {
        antes[campo] = a;
        depois[campo] = d;
      };
      if (dto.produto !== undefined && dto.produto !== atual.produto) {
        dados.produto = dto.produto;
        mudar('produto', atual.produto, dto.produto);
      }
      if (dto.descricao !== undefined && dto.descricao !== atual.descricao) {
        dados.descricao = dto.descricao;
        mudar('descricao', atual.descricao, dto.descricao);
      }
      const novoValor =
        dto.valor !== undefined ? lerValor(dto.valor) : atual.valor;
      const novaPeriodicidade: PeriodicidadeContrato =
        dto.periodicidade ?? atual.periodicidade;
      if (!novoValor.equals(atual.valor)) {
        dados.valor = novoValor;
        mudar('valor', formatarValor(atual.valor), formatarValor(novoValor));
      }
      if (novaPeriodicidade !== atual.periodicidade) {
        dados.periodicidade = novaPeriodicidade;
        mudar('periodicidade', atual.periodicidade, novaPeriodicidade);
      }
      for (const campo of ['fimEm', 'renovacaoEm'] as const) {
        if (dto[campo] !== undefined) {
          const v = dto[campo];
          if (v !== null) exigirData(v, campo);
          dados[campo] = v ? paraDataDoBanco(v) : null;
          mudar(campo, atual[campo] ? deDataDoBanco(atual[campo]) : null, v);
        }
      }
      const inicio = deDataDoBanco(atual.inicioEm);
      const fimNovo =
        dto.fimEm === undefined
          ? atual.fimEm
            ? deDataDoBanco(atual.fimEm)
            : null
          : dto.fimEm;
      if (fimNovo && fimNovo < inicio) {
        throw new RegraVioladaException(
          'R22.2',
          'O fim do contrato não pode ser antes do início.',
        );
      }
      if (
        dto.renovacaoAutomatica !== undefined &&
        dto.renovacaoAutomatica !== atual.renovacaoAutomatica
      ) {
        dados.renovacaoAutomatica = dto.renovacaoAutomatica;
        mudar(
          'renovacaoAutomatica',
          atual.renovacaoAutomatica,
          dto.renovacaoAutomatica,
        );
      }
      if (
        dto.diaVencimento !== undefined &&
        dto.diaVencimento !== atual.diaVencimento
      ) {
        dados.diaVencimento = dto.diaVencimento;
        mudar('diaVencimento', atual.diaVencimento, dto.diaVencimento);
      }
      if (
        dto.responsavelCsId !== undefined &&
        dto.responsavelCsId !== atual.responsavelCsId
      ) {
        if (ehCsDaCarteira(usuario)) {
          throw new SemPermissaoException(
            'Só a gestão troca o responsável de CS.',
            { regra: 'R22.1' },
          );
        }
        if (dto.responsavelCsId)
          await this.conferirResponsavel(tx, dto.responsavelCsId);
        dados.responsavelCsId = dto.responsavelCsId;
        mudar('responsavelCsId', atual.responsavelCsId, dto.responsavelCsId);
      }
      if (Object.keys(dados).length === 0) return;

      const mrrAnterior = atual.mrr;
      const mrrNovo = new Prisma.Decimal(
        mrrEmCentavos(novoValor.mul(100).toNumber(), novaPeriodicidade),
      ).div(100);
      if (!mrrNovo.equals(mrrAnterior)) {
        dados.mrr = mrrNovo;
        await this.movimento(
          tx,
          id,
          mrrNovo.gt(mrrAnterior) ? 'EXPANSAO' : 'CONTRACAO',
          mrrAnterior,
          mrrNovo,
          'Alteração de valor ou periodicidade',
          usuario.id,
        );
      }
      let parcelasAtualizadas = 0;
      if (dto.atualizarParcelasAbertas && !novoValor.equals(atual.valor)) {
        const r = await tx.parcela.updateMany({
          where: {
            contratoId: id,
            status: 'ABERTO',
            vencimento: { gte: paraDataDoBanco(hojeLocal()) },
          },
          data: { valor: novoValor },
        });
        parcelasAtualizadas = r.count;
      }
      const novo = await tx.contrato.update({ where: { id }, data: dados });
      await this.auditoria.registrar(tx, {
        acao: 'contrato.atualizado',
        entidade: 'contrato',
        entidadeId: id,
        resumo: `${usuario.nome} alterou o contrato ${codigoDoContrato(novo.numero)}`,
        dados: {
          antes,
          depois,
          mrr: formatarValor(mrrNovo),
          parcelasAtualizadas,
          regra: 'R22.2',
        },
        relacionados: relacionadosDoContrato(novo),
      });
      await this.eventos.publicar(tx, 'contrato.atualizado', {
        ...dadosDoEvento(novo),
        antes,
        depois,
      });
    });
    return this.detalhar(usuario, id);
  }

  async suspender(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ContratoDto> {
    return this.mudarStatus(usuario, id, {
      de: ['ATIVO'],
      para: 'SUSPENSO',
      acao: 'contrato.suspenso',
      verbo: 'suspendeu',
      erro: 'Só um contrato ativo pode ser suspenso.',
    });
  }

  /** Reativa um suspenso; cancelado ou encerrado volta como NOVO no MRR. */
  async reativar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      if (atual.status === 'ATIVO') {
        throw new ConflitoException('O contrato já está ativo.');
      }
      const voltando =
        atual.status === 'CANCELADO' || atual.status === 'ENCERRADO';
      if (voltando && !ehGestorFinanceiro(usuario)) {
        throw new SemPermissaoException(
          'Só a gestão reativa um contrato cancelado ou encerrado.',
          { regra: 'R22.1' },
        );
      }
      const novo = await tx.contrato.update({
        where: { id },
        data: {
          status: 'ATIVO',
          canceladoEm: null,
          motivoCancelamento: null,
          encerradoEm: null,
        },
      });
      if (voltando && novo.mrr.gt(0)) {
        await this.movimento(
          tx,
          id,
          'NOVO',
          new Prisma.Decimal(0),
          novo.mrr,
          'Contrato reativado',
          usuario.id,
        );
      }
      await this.auditoria.registrar(tx, {
        acao: 'contrato.reativado',
        entidade: 'contrato',
        entidadeId: id,
        resumo: `${usuario.nome} reativou o contrato ${codigoDoContrato(novo.numero)}`,
        dados: { de: atual.status, regra: 'R22.2' },
        relacionados: relacionadosDoContrato(novo),
      });
      await this.eventos.publicar(
        tx,
        'contrato.reativado',
        dadosDoEvento(novo),
      );
    });
    return this.detalhar(usuario, id);
  }

  async cancelar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: CancelarContratoDto,
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      if (atual.status === 'CANCELADO' || atual.status === 'ENCERRADO') {
        throw new ConflitoException('O contrato já está encerrado.', {
          status: atual.status,
        });
      }
      const novo = await this.encerrarContrato(
        tx,
        atual,
        'CANCELADO',
        dto.motivo,
        dto.cancelarParcelas !== false,
        usuario.id,
      );
      await this.auditoria.registrar(tx, {
        acao: 'contrato.cancelado',
        entidade: 'contrato',
        entidadeId: id,
        resumo: `${usuario.nome} cancelou o contrato ${codigoDoContrato(novo.numero)}: ${dto.motivo}`,
        dados: {
          motivo: dto.motivo,
          cancelouParcelas: dto.cancelarParcelas !== false,
          regra: 'R22.2',
        },
        relacionados: relacionadosDoContrato(novo),
      });
      await this.eventos.publicar(tx, 'contrato.cancelado', {
        ...dadosDoEvento(novo),
        motivo: dto.motivo,
      });
    });
    return this.detalhar(usuario, id);
  }

  private async mudarStatus(
    usuario: UsuarioAutenticado,
    id: string,
    o: {
      de: Contrato['status'][];
      para: Contrato['status'];
      acao: string;
      verbo: string;
      erro: string;
    },
  ): Promise<ContratoDto> {
    this.exigirAtuacao(usuario);
    await this.prisma.$transaction(async (tx) => {
      const atual = await this.travar(tx, usuario, id);
      if (!o.de.includes(atual.status)) {
        throw new RegraVioladaException('R22.2', o.erro, {
          status: atual.status,
        });
      }
      const novo = await tx.contrato.update({
        where: { id },
        data: { status: o.para },
      });
      await this.auditoria.registrar(tx, {
        acao: o.acao,
        entidade: 'contrato',
        entidadeId: id,
        resumo: `${usuario.nome} ${o.verbo} o contrato ${codigoDoContrato(novo.numero)}`,
        dados: { regra: 'R22.2' },
        relacionados: relacionadosDoContrato(novo),
      });
      await this.eventos.publicar(tx, o.acao, dadosDoEvento(novo));
    });
    return this.detalhar(usuario, id);
  }

  /** Cancela ou encerra: churn do MRR e (opcional) cancela as parcelas ainda não vencidas. */
  private async encerrarContrato(
    tx: Tx,
    atual: Contrato,
    status: 'CANCELADO' | 'ENCERRADO',
    motivo: string | null,
    cancelarParcelas: boolean,
    usuarioId: string | null,
  ): Promise<Contrato> {
    const agora = new Date();
    const novo = await tx.contrato.update({
      where: { id: atual.id },
      data:
        status === 'CANCELADO'
          ? { status, canceladoEm: agora, motivoCancelamento: motivo }
          : { status, encerradoEm: agora },
    });
    if (atual.mrr.gt(0)) {
      await this.movimento(
        tx,
        atual.id,
        'CHURN',
        atual.mrr,
        new Prisma.Decimal(0),
        motivo ?? 'Contrato encerrado',
        usuarioId,
      );
    }
    if (cancelarParcelas) {
      const futuras = await tx.parcela.findMany({
        where: {
          contratoId: atual.id,
          status: 'ABERTO',
          vencimento: { gte: paraDataDoBanco(hojeLocal()) },
        },
        select: { id: true },
      });
      for (const { id } of futuras) {
        await this.parcelas.cancelarPendenciasDaRegua(
          tx,
          id,
          'Contrato encerrado.',
        );
      }
      await tx.parcela.updateMany({
        where: { id: { in: futuras.map((f) => f.id) } },
        data: { status: 'CANCELADO' },
      });
    }
    return novo;
  }

  // ---- rotina diária: renovação e encerramento --------------------------------

  /**
   * R22.2 — contratos ativos com o fim já passado: renovação automática estende o
   * prazo (um ano) e gera as parcelas; sem renovação, o contrato é encerrado (churn).
   */
  async processarVencimentos(
    hoje: string = hojeLocal(),
  ): Promise<{ renovados: number; encerrados: number }> {
    const vencidos = await this.prisma.contrato.findMany({
      where: { status: 'ATIVO', fimEm: { lt: paraDataDoBanco(hoje) } },
    });
    let renovados = 0;
    let encerrados = 0;
    for (const c of vencidos) {
      await executarComoAtor(
        { tipoAtor: 'SISTEMA', descricao: 'Renovação de contratos' },
        () =>
          this.prisma.$transaction(async (tx) => {
            const atual = await tx.contrato.findUnique({ where: { id: c.id } });
            if (!atual || atual.status !== 'ATIVO' || !atual.fimEm) return;
            if (atual.renovacaoAutomatica) {
              const novoFim = somarMeses(deDataDoBanco(atual.fimEm), 12);
              const renovado = await tx.contrato.update({
                where: { id: c.id },
                data: {
                  fimEm: paraDataDoBanco(novoFim),
                  renovacaoEm: paraDataDoBanco(novoFim),
                },
              });
              const criadas = await this.gerarParcelas(tx, renovado, {
                usuarioId: null,
                estender: true,
                quantidade: periodosPorAno(renovado.periodicidade),
              });
              await this.auditoria.registrar(tx, {
                acao: 'contrato.atualizado',
                entidade: 'contrato',
                entidadeId: c.id,
                resumo: `Contrato ${codigoDoContrato(c.numero)} renovado automaticamente até ${novoFim}`,
                dados: { novoFim, parcelasGeradas: criadas, regra: 'R22.2' },
                relacionados: relacionadosDoContrato(renovado),
              });
              await this.eventos.publicar(tx, 'contrato.atualizado', {
                ...dadosDoEvento(renovado),
                renovado: true,
              });
              renovados++;
            } else {
              const novo = await this.encerrarContrato(
                tx,
                atual,
                'ENCERRADO',
                'Fim do prazo',
                false,
                null,
              );
              await this.auditoria.registrar(tx, {
                acao: 'contrato.encerrado',
                entidade: 'contrato',
                entidadeId: c.id,
                resumo: `Contrato ${codigoDoContrato(c.numero)} encerrado ao fim do prazo`,
                dados: { regra: 'R22.2' },
                relacionados: relacionadosDoContrato(novo),
              });
              await this.eventos.publicar(
                tx,
                'contrato.encerrado',
                dadosDoEvento(novo),
              );
              encerrados++;
            }
          }),
      );
    }
    return { renovados, encerrados };
  }

  // ---- apoio -----------------------------------------------------------------

  private async movimento(
    tx: Tx,
    contratoId: string,
    tipo: TipoMovimentoMrr,
    anterior: Prisma.Decimal,
    novo: Prisma.Decimal,
    motivo: string,
    usuarioId: string | null,
  ): Promise<void> {
    await tx.movimentoMrr.create({
      data: {
        contratoId,
        tipo,
        valorAnterior: anterior,
        valorNovo: novo,
        delta: novo.minus(anterior),
        dia: paraDataDoBanco(hojeLocal()),
        motivo,
        criadoPorId: usuarioId,
      },
    });
  }

  private async travar(
    tx: Tx,
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<Contrato> {
    const visivel = await tx.contrato.findFirst({
      where: { AND: [{ id }, filtroDeContratosVisiveis(usuario)] },
      select: { id: true },
    });
    if (!visivel) throw new NaoEncontradoException('Contrato não encontrado.');
    await tx.$queryRaw`SELECT id FROM contratos WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.contrato.findUniqueOrThrow({ where: { id } });
  }

  private async conferirCliente(
    tx: Tx,
    empresaId: string | null,
    contatoId: string | null,
  ): Promise<void> {
    if (
      empresaId &&
      !(await tx.empresa.findFirst({
        where: { id: empresaId, excluidoEm: null },
        select: { id: true },
      }))
    ) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
    if (
      contatoId &&
      !(await tx.contato.findFirst({
        where: { id: contatoId, excluidoEm: null },
        select: { id: true },
      }))
    ) {
      throw new NaoEncontradoException('Contato não encontrado.');
    }
  }

  private async conferirResponsavel(tx: Tx, usuarioId: string): Promise<void> {
    const u = await tx.usuario.findFirst({
      where: { id: usuarioId, ativo: true },
      select: { papel: true },
    });
    if (!u) {
      throw new DadosInvalidosException(
        'O responsável de CS não existe ou está inativo.',
        {
          campos: [
            { campo: 'responsavelCsId', mensagens: ['usuário inválido'] },
          ],
        },
      );
    }
  }
}

function periodosPorAno(p: PeriodicidadeContrato): number {
  const m = mesesDaPeriodicidade(p);
  return m === 0 ? 1 : 12 / m;
}

function exigirData(valor: string, campo: string): string {
  if (!ehDataIso(valor)) {
    throw new DadosInvalidosException('Data inválida.', {
      campos: [{ campo, mensagens: ['deve ser uma data AAAA-MM-DD válida'] }],
    });
  }
  return valor;
}

function relacionadosDoContrato(
  c: Pick<Contrato, 'empresaId' | 'contatoId' | 'negocioId'>,
): Record<string, string> {
  return {
    ...(c.empresaId ? { empresa: c.empresaId } : {}),
    ...(c.contatoId ? { contato: c.contatoId } : {}),
    ...(c.negocioId ? { negocio: c.negocioId } : {}),
  };
}

function dadosDoEvento(c: Contrato) {
  return {
    contratoId: c.id,
    codigo: codigoDoContrato(c.numero),
    empresaId: c.empresaId,
    contatoId: c.contatoId,
    negocioId: c.negocioId,
    produto: c.produto,
    valor: formatarValor(c.valor),
    periodicidade: c.periodicidade,
    mrr: formatarValor(c.mrr),
    status: c.status,
    responsavelCsId: c.responsavelCsId,
  };
}
