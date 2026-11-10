import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import { type Prisma, TipoImportacao } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { camposDoTipo, grupoDoCampo, validarMapeamento } from './campos';
import {
  type AtualizarModeloDto,
  CampoDeImportacaoDto,
  type CriarModeloDto,
  ModeloDeImportacaoDto,
} from './importacao.dto';
import { ImportacaoService } from './importacao.service';
import { DDI_PADRAO, PADRAO_DDI } from './ddi';
import { lerFiltro, lerNegocio } from './opcoes';

/**
 * Opções de um modelo (R16.13): filtro, negócio e DDI são conferidos na forma
 * (o que não serve é descartado); as demais chaves (duplicados, etiquetas…) seguem como vieram.
 */
function limparOpcoesDoModelo(
  opcoes: Record<string, unknown>,
): Prisma.InputJsonObject {
  const { filtro, negocio, ddiPadrao, ...resto } = opcoes;
  const limpas: Record<string, unknown> = { ...resto };
  const f = lerFiltro(filtro);
  if (f) limpas.filtro = f;
  const n = lerNegocio(negocio);
  if (n) limpas.negocio = n;
  if (
    typeof ddiPadrao === 'string' &&
    PADRAO_DDI.test(ddiPadrao) &&
    ddiPadrao !== DDI_PADRAO
  ) {
    limpas.ddiPadrao = ddiPadrao;
  }
  return limpas as Prisma.InputJsonObject;
}

/** Modelos de mapeamento salvos (R16.3): coluna da planilha → campo, para reaproveitar. */
@Injectable()
export class ModelosDeImportacaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly importacoes: ImportacaoService,
  ) {}

  campos(tipo: TipoImportacao): CampoDeImportacaoDto[] {
    return camposDoTipo(tipo).map((c) => ({
      chave: c.chave,
      rotulo: c.rotulo,
      obrigatorio: c.obrigatorio === true,
      grupo: grupoDoCampo(tipo, c),
    }));
  }

  async listar(
    usuario: UsuarioAutenticado,
    tipo?: TipoImportacao,
  ): Promise<ModeloDeImportacaoDto[]> {
    this.importacoes.garantirPodeImportar(usuario);
    const modelos = await this.prisma.importacaoModelo.findMany({
      where: tipo ? { tipo } : {},
      orderBy: [{ nome: 'asc' }],
    });
    return modelos.map((m) => ModeloDeImportacaoDto.de(m));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarModeloDto,
  ): Promise<ModeloDeImportacaoDto> {
    this.importacoes.garantirPodeImportar(usuario);
    this.conferirMapeamento(dto.tipo, dto.mapeamento);
    const nome = dto.nome.trim();
    await this.garantirNomeLivre(dto.tipo, nome);
    const modelo = await this.prisma.$transaction(async (tx) => {
      const criado = await tx.importacaoModelo.create({
        data: {
          nome,
          tipo: dto.tipo,
          mapeamento: dto.mapeamento,
          opcoes: limparOpcoesDoModelo(dto.opcoes ?? {}),
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'importacao.modelo_criado',
        entidade: 'importacao_modelo',
        entidadeId: criado.id,
        resumo: `Modelo de mapeamento "${nome}" criado`,
        dados: { tipo: dto.tipo },
      });
      return criado;
    });
    return ModeloDeImportacaoDto.de(modelo);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarModeloDto,
  ): Promise<ModeloDeImportacaoDto> {
    const atual = await this.obter(usuario, id);
    const dados: Prisma.ImportacaoModeloUpdateInput = {};
    if (dto.nome !== undefined && dto.nome.trim() !== atual.nome) {
      await this.garantirNomeLivre(atual.tipo, dto.nome.trim(), id);
      dados.nome = dto.nome.trim();
    }
    if (dto.mapeamento !== undefined) {
      this.conferirMapeamento(atual.tipo, dto.mapeamento);
      dados.mapeamento = dto.mapeamento;
    }
    if (dto.opcoes !== undefined) {
      dados.opcoes = limparOpcoesDoModelo(dto.opcoes);
    }
    const modelo = await this.prisma.$transaction(async (tx) => {
      const atualizado = await tx.importacaoModelo.update({
        where: { id },
        data: dados,
      });
      await this.auditoria.registrar(tx, {
        acao: 'importacao.modelo_atualizado',
        entidade: 'importacao_modelo',
        entidadeId: id,
        resumo: `Modelo de mapeamento "${atualizado.nome}" atualizado`,
      });
      return atualizado;
    });
    return ModeloDeImportacaoDto.de(modelo);
  }

  async remover(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const atual = await this.obter(usuario, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.importacaoModelo.delete({ where: { id } });
      await this.auditoria.registrar(tx, {
        acao: 'importacao.modelo_removido',
        entidade: 'importacao_modelo',
        entidadeId: id,
        resumo: `Modelo de mapeamento "${atual.nome}" removido`,
      });
    });
  }

  private async obter(usuario: UsuarioAutenticado, id: string) {
    this.importacoes.garantirPodeImportar(usuario);
    const modelo = await this.prisma.importacaoModelo.findUnique({
      where: { id },
    });
    if (!modelo) {
      throw new NaoEncontradoException('Modelo não encontrado.');
    }
    return modelo;
  }

  private async garantirNomeLivre(
    tipo: TipoImportacao,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    const outro = await this.prisma.importacaoModelo.findFirst({
      where: { tipo, nome, ...(exceto ? { id: { not: exceto } } : {}) },
      select: { id: true },
    });
    if (outro) {
      throw new ConflitoException('Já existe um modelo com este nome.', {
        outroId: outro.id,
      });
    }
  }

  /** O modelo guarda nomes de coluna livres, mas os campos de destino precisam existir. */
  private conferirMapeamento(
    tipo: TipoImportacao,
    mapeamento: Record<string, string>,
  ): void {
    const colunas = Object.keys(mapeamento);
    const problemas = validarMapeamento(tipo, colunas, mapeamento, false);
    if (problemas.length > 0) {
      throw new DadosInvalidosException('O mapeamento tem problemas.', {
        regra: 'R16.3',
        campos: problemas.map((p) => ({
          campo: p.campo,
          mensagens: [p.mensagem],
        })),
      });
    }
  }
}
