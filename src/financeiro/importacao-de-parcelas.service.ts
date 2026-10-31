import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { formatarValor, lerValor } from '../comum/dominio/dinheiro';
import { DadosInvalidosException } from '../comum/erros/excecoes';
import { ehEmailValido, normalizarEmail } from '../comum/dominio/email';
import { normalizarTelefone } from '../comum/dominio/telefone';
import { ContatosService } from '../contatos/contatos.service';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import type {
  Importacao,
  Parcela,
  Prisma,
  ResultadoLinhaImportacao,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  lerDataDaPlanilha,
  lerFormaDePagamento,
  lerSituacaoDaPlanilha,
  lerValorDaPlanilha,
} from './campos-de-parcela';
import { deDataDoBanco, hojeLocal, paraDataDoBanco } from './datas';
import { ParcelasService, relacionadosDe } from './parcelas.service';

export interface ResultadoDaLinhaDeParcela {
  resultado: ResultadoLinhaImportacao;
  entidadeId?: string | null;
  motivo?: string | null;
  /** Parcela que recebeu baixa (o chamador avisa o tempo real). */
  paga?: Parcela;
}

/** Erro de dado da linha (vira ERRO no relatório, sem parar a importação). */
export class LinhaDeParcelaInvalida extends DadosInvalidosException {}

/**
 * Importação de títulos (R22.5, tipo `PARCELAS`): reimportar atualiza pelo número,
 * dá baixa nos pagos e reinicia a régua de quem teve o vencimento alterado
 * (R24.3); colunas ausentes (ou células vazias) não apagam dados.
 */
@Injectable()
export class ImportacaoDeParcelasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly parcelas: ParcelasService,
    private readonly contatos: ContatosService,
  ) {}

  async tratarLinha(
    importacao: Pick<Importacao, 'duplicados' | 'nome' | 'id'>,
    usuario: Pick<UsuarioAutenticado, 'id' | 'nome'>,
    v: Record<string, string>,
  ): Promise<ResultadoDaLinhaDeParcela> {
    const numero = v.numero?.trim();
    if (!numero)
      throw new LinhaDeParcelaInvalida('Número do título é obrigatório.');
    const vencimento = this.data(v.vencimento, 'Vencimento');
    const valor = v.valor ? this.valor(v.valor, 'Valor') : undefined;
    const pagoEm = this.data(v.pagoEm, 'Data do pagamento');
    const valorPago = v.valorPago
      ? this.valor(v.valorPago, 'Valor pago')
      : undefined;
    const situacao = v.status ? lerSituacaoDaPlanilha(v.status) : undefined;
    if (v.status && !situacao) {
      throw new LinhaDeParcelaInvalida(
        `Situação não reconhecida ("${v.status}"). Use pago, aberto ou cancelado.`,
      );
    }
    const forma = v.formaPagamento
      ? lerFormaDePagamento(v.formaPagamento)
      : null;
    const textos = {
      linkBoleto: v.linkBoleto,
      linkPagamento: v.linkPagamento,
      pix: v.pix,
      descricao: v.descricao,
    };
    const existente = await this.prisma.parcela.findUnique({
      where: { numero },
    });
    if (existente) {
      if (importacao.duplicados === 'IGNORAR') {
        return {
          resultado: 'IGNORADO',
          entidadeId: existente.id,
          motivo: 'Título já cadastrado.',
        };
      }
      const r = await this.atualizar(existente, usuario, {
        vencimento,
        valor,
        pagoEm,
        valorPago,
        situacao: situacao ?? undefined,
        forma,
        textos,
      });
      if (r.paga) await this.parcelas.avisarBaixa(r.paga);
      return r;
    }
    const criado = await this.criar(importacao, usuario, numero, v, {
      vencimento,
      valor,
      pagoEm,
      valorPago,
      situacao: situacao ?? undefined,
      forma,
      textos,
    });
    if (criado.paga) await this.parcelas.avisarBaixa(criado.paga);
    return criado;
  }

  private async atualizar(
    atual: Parcela,
    usuario: Pick<UsuarioAutenticado, 'id' | 'nome'>,
    d: Dados,
  ): Promise<ResultadoDaLinhaDeParcela> {
    const aberta = atual.status === 'ABERTO' || atual.status === 'ATRASADO';
    if (!aberta) {
      return {
        resultado: 'IGNORADO',
        entidadeId: atual.id,
        motivo: `Título já está ${atual.status === 'PAGO' ? 'pago' : atual.status === 'CANCELADO' ? 'cancelado' : 'renegociado'}.`,
      };
    }
    let paga: Parcela | undefined;
    const resultado = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM parcelas WHERE id = ${atual.id}::uuid FOR UPDATE`;
      let corrente = await tx.parcela.findUniqueOrThrow({
        where: { id: atual.id },
      });
      if (corrente.status !== 'ABERTO' && corrente.status !== 'ATRASADO') {
        return {
          resultado: 'IGNORADO' as const,
          motivo: 'Título já foi baixado ou cancelado.',
        };
      }
      const dados: Prisma.ParcelaUncheckedUpdateInput = {};
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      for (const campo of [
        'linkBoleto',
        'linkPagamento',
        'pix',
        'descricao',
      ] as const) {
        const novo = d.textos[campo]?.trim();
        if (novo && novo !== corrente[campo]) {
          dados[campo] = novo;
          antes[campo] = corrente[campo];
          depois[campo] = novo;
        }
      }
      if (d.valor && !lerValor(d.valor).equals(corrente.valor)) {
        dados.valor = lerValor(d.valor);
        antes.valor = formatarValor(corrente.valor);
        depois.valor = d.valor;
      }
      let reiniciou = false;
      if (d.vencimento && d.vencimento !== deDataDoBanco(corrente.vencimento)) {
        dados.vencimento = paraDataDoBanco(d.vencimento);
        dados.status = d.vencimento < hojeLocal() ? 'ATRASADO' : 'ABERTO';
        dados.cicloRegua = { increment: 1 };
        dados.promessaAte = null;
        dados.promessaRegistradaEm = null;
        antes.vencimento = deDataDoBanco(corrente.vencimento);
        depois.vencimento = d.vencimento;
        reiniciou = true;
        await this.parcelas.cancelarPendenciasDaRegua(
          tx,
          corrente.id,
          'Vencimento alterado pela importação: a régua recomeça.',
        );
      }
      if (Object.keys(dados).length > 0) {
        corrente = await tx.parcela.update({
          where: { id: corrente.id },
          data: dados,
        });
        await this.auditoria.registrar(tx, {
          acao: 'parcela.atualizada',
          entidade: 'parcela',
          entidadeId: corrente.id,
          resumo: `Importação atualizou o título ${corrente.numero}${reiniciou ? ' (a régua recomeça)' : ''}`,
          dados: {
            antes,
            depois,
            origem: 'importacao',
            reguaReiniciada: reiniciou,
            regra: reiniciou ? 'R24.3' : 'R22.5',
          },
          relacionados: relacionadosDe(corrente),
        });
      }
      const pago =
        d.situacao === 'PAGO' || (d.situacao === undefined && !!d.pagoEm);
      if (pago) {
        paga = await this.parcelas.darBaixa(
          tx,
          corrente,
          {
            pagoEm: d.pagoEm ?? hojeLocal(),
            valorPago: d.valorPago ? lerValor(d.valorPago) : corrente.valor,
            formaPagamento: d.forma,
          },
          'IMPORTACAO',
          usuario.id,
        );
        return {
          resultado: 'ATUALIZADO' as const,
          motivo: 'Baixa registrada.',
        };
      }
      if (d.situacao === 'CANCELADO') {
        await tx.parcela.update({
          where: { id: corrente.id },
          data: { status: 'CANCELADO', promessaAte: null },
        });
        await this.parcelas.cancelarPendenciasDaRegua(
          tx,
          corrente.id,
          'Título cancelado pela importação.',
        );
        await this.auditoria.registrar(tx, {
          acao: 'parcela.cancelada',
          entidade: 'parcela',
          entidadeId: corrente.id,
          resumo: `Importação cancelou o título ${corrente.numero}`,
          dados: { origem: 'importacao', regra: 'R22.5' },
          relacionados: relacionadosDe(corrente),
        });
        return {
          resultado: 'ATUALIZADO' as const,
          motivo: 'Título cancelado.',
        };
      }
      return Object.keys(dados).length > 0
        ? {
            resultado: 'ATUALIZADO' as const,
            motivo: reiniciou ? 'Vencimento alterado: régua reiniciada.' : null,
          }
        : { resultado: 'IGNORADO' as const, motivo: 'Sem alterações.' };
    });
    return { ...resultado, entidadeId: atual.id, paga };
  }

  private async criar(
    importacao: Pick<Importacao, 'nome' | 'id'>,
    usuario: Pick<UsuarioAutenticado, 'id' | 'nome'>,
    numero: string,
    v: Record<string, string>,
    d: Dados,
  ): Promise<ResultadoDaLinhaDeParcela> {
    const { vencimento, valor } = d;
    if (!vencimento)
      throw new LinhaDeParcelaInvalida(
        'Vencimento é obrigatório para um título novo.',
      );
    if (!valor)
      throw new LinhaDeParcelaInvalida(
        'Valor é obrigatório para um título novo.',
      );
    let paga: Parcela | undefined;
    const criada = await this.prisma.$transaction(async (tx) => {
      let contratoId: string | null = null;
      let contatoId: string | null = null;
      let empresaId: string | null = null;
      if (v.contrato) {
        const n = /^c?-?0*(\d{1,9})$/i.exec(v.contrato.trim())?.[1];
        const contrato = n
          ? await tx.contrato.findUnique({ where: { numero: Number(n) } })
          : null;
        if (!contrato)
          throw new LinhaDeParcelaInvalida(
            `Contrato "${v.contrato}" não encontrado.`,
          );
        contratoId = contrato.id;
        contatoId = contrato.contatoId;
        empresaId = contrato.empresaId;
      }
      if (!contatoId && (v.nome || v.email || v.telefone)) {
        let email: string | undefined;
        let telefone: string | undefined;
        if (v.email && ehEmailValido(v.email)) email = normalizarEmail(v.email);
        if (v.telefone) {
          const t = normalizarTelefone(v.telefone);
          if (t.valido) telefone = t.telefone;
        }
        if (!email && !telefone) {
          throw new LinhaDeParcelaInvalida(
            'Informe um e-mail ou telefone válido do cliente.',
          );
        }
        const { contato } = await this.contatos.encontrarOuCriar(tx, {
          nome: v.nome?.trim() || email || telefone || 'Cliente',
          email,
          telefone,
          empresaNome: v.empresa?.trim() || undefined,
          origem: 'IMPORTACAO',
          origemDetalhe: importacao.nome,
        });
        contatoId = contato.id;
        empresaId ??= contato.empresaId;
      }
      if (!contatoId && !empresaId) {
        throw new LinhaDeParcelaInvalida(
          'Informe o cliente (nome com e-mail ou telefone) ou o contrato do título.',
        );
      }
      const cancelado = d.situacao === 'CANCELADO';
      const sequencia = contratoId
        ? ((
            await tx.parcela.aggregate({
              where: { contratoId },
              _max: { sequencia: true },
            })
          )._max.sequencia ?? 0) + 1
        : null;
      const parcela = await tx.parcela.create({
        data: {
          numero,
          sequencia,
          contratoId,
          contatoId,
          empresaId,
          origem: 'IMPORTACAO',
          descricao: d.textos.descricao?.trim() || null,
          vencimento: paraDataDoBanco(vencimento),
          vencimentoOriginal: paraDataDoBanco(vencimento),
          valor: lerValor(valor),
          status: cancelado
            ? 'CANCELADO'
            : vencimento < hojeLocal()
              ? 'ATRASADO'
              : 'ABERTO',
          linkBoleto: d.textos.linkBoleto?.trim() || null,
          linkPagamento: d.textos.linkPagamento?.trim() || null,
          pix: d.textos.pix?.trim() || null,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'parcela.criada',
        entidade: 'parcela',
        entidadeId: parcela.id,
        resumo: `Importação "${importacao.nome}" criou o título ${numero} (R$ ${valor}, vence ${vencimento})`,
        dados: {
          numero,
          vencimento: vencimento,
          valor: valor,
          origem: 'importacao',
          importacaoId: importacao.id,
          regra: 'R22.5',
        },
        relacionados: relacionadosDe(parcela),
      });
      const pago =
        d.situacao === 'PAGO' || (d.situacao === undefined && !!d.pagoEm);
      if (pago) {
        paga = await this.parcelas.darBaixa(
          tx,
          parcela,
          {
            pagoEm: d.pagoEm ?? hojeLocal(),
            valorPago: d.valorPago ? lerValor(d.valorPago) : parcela.valor,
            formaPagamento: d.forma,
          },
          'IMPORTACAO',
          usuario.id,
        );
      }
      return parcela;
    });
    return {
      resultado: 'CRIADO',
      entidadeId: criada.id,
      motivo: paga ? 'Criado já pago.' : null,
      paga,
    };
  }

  private data(texto: string | undefined, rotulo: string): string | undefined {
    if (!texto) return undefined;
    const d = lerDataDaPlanilha(texto);
    if (!d)
      throw new LinhaDeParcelaInvalida(
        `${rotulo} inválido ("${texto}"). Use dd/mm/aaaa ou aaaa-mm-dd.`,
      );
    return d;
  }

  private valor(texto: string, rotulo: string): string {
    const v = lerValorDaPlanilha(texto);
    if (!v)
      throw new LinhaDeParcelaInvalida(`${rotulo} inválido ("${texto}").`);
    return v;
  }
}

interface Dados {
  vencimento?: string;
  valor?: string;
  pagoEm?: string;
  valorPago?: string;
  situacao?: 'PAGO' | 'CANCELADO' | 'ABERTO';
  forma: ReturnType<typeof lerFormaDePagamento>;
  textos: {
    linkBoleto?: string;
    linkPagamento?: string;
    pix?: string;
    descricao?: string;
  };
}
