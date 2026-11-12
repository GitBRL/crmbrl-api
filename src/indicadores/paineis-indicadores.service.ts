import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { ehDiretoria, ehLider, setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import type {
  Papel,
  PainelIndicadores,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FiltrosIndicadoresService,
  mesclarFiltros,
} from './filtros-indicadores.service';
import {
  MAXIMO_DE_PAINEIS_POR_DONO,
  REGRA_INDICADORES,
  TAMANHO_DESCRICAO_PAINEL,
  TAMANHO_NOME_PAINEL,
} from './indicadores.constantes';
import type {
  Compartilhamento,
  FiltrosDoIndicador,
  Widget,
} from './indicadores.tipos';
import { modeloDePainel } from './modelos';
import { validarFiltros, validarWidgets } from './validacao-widgets';

export interface EntradaDePainel {
  nome?: string;
  descricao?: string | null;
  modelo?: string;
  filtrosPadrao?: unknown;
  widgets?: unknown;
  compartilhamento?: Partial<Compartilhamento>;
}

export interface PainelDeIndicadores {
  id: string;
  nome: string;
  descricao: string | null;
  dono: { id: string; nome: string };
  minha: boolean;
  podeEditar: boolean;
  modelo: string | null;
  filtrosPadrao: FiltrosDoIndicador;
  widgets: Widget[];
  quantidadeDeWidgets: number;
  /** Só quem edita vê com quem o painel foi compartilhado. */
  compartilhamento: Compartilhamento | null;
  criadoEm: string;
  atualizadoEm: string;
}

type PainelComDono = PainelIndicadores & { dono: { id: string; nome: string } };

const COM_DONO = { dono: { select: { id: true, nome: true } } } as const;

/** Quem cria, edita, duplica e exclui painéis: Admin, C-level e líderes (R33.6). */
export function podeCriarPaineis(
  usuario: Pick<UsuarioAutenticado, 'papel'>,
): boolean {
  return ehDiretoria(usuario.papel) || ehLider(usuario.papel);
}

/**
 * Painéis de indicadores (R33.6): CRUD, duplicação, compartilhamento e modelo pronto.
 * Compartilhar um painel **não amplia dados** (R33.4): quem vê calcula com o próprio recorte.
 */
@Injectable()
export class PaineisIndicadoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly filtros: FiltrosIndicadoresService,
  ) {}

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async listar(usuario: UsuarioAutenticado): Promise<PainelDeIndicadores[]> {
    const paineis = await this.prisma.painelIndicadores.findMany({
      where: { excluidoEm: null, ...this.filtroDeVisibilidade(usuario) },
      include: COM_DONO,
      orderBy: [{ nome: 'asc' }, { criadoEm: 'asc' }],
    });
    return paineis.map((painel) => this.paraDto(usuario, painel, false));
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<PainelDeIndicadores> {
    return this.paraDto(usuario, await this.carregarVisivel(usuario, id), true);
  }

  /** Para o cálculo: o painel (já conferido) que a pessoa vê. */
  async carregarVisivel(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<PainelComDono> {
    const painel = await this.prisma.painelIndicadores.findFirst({
      where: { id, excluidoEm: null, ...this.filtroDeVisibilidade(usuario) },
      include: COM_DONO,
    });
    if (!painel) {
      throw new NaoEncontradoException('Painel não encontrado.');
    }
    return painel;
  }

  /** O dono, os compartilhados com a pessoa (setor, pessoa ou papel) e, para Admin e C-level, todos. */
  private filtroDeVisibilidade(
    usuario: UsuarioAutenticado,
  ): Prisma.PainelIndicadoresWhereInput {
    if (ehDiretoria(usuario.papel)) {
      return {};
    }
    const area = setorDaPessoa(usuario);
    return {
      OR: [
        { donoId: usuario.id },
        ...(area ? [{ compartilhadoSetores: { has: area } }] : []),
        { compartilhadoPessoas: { has: usuario.id } },
        { compartilhadoPapeis: { has: usuario.papel } },
      ],
    };
  }

  private podeEditar(
    usuario: UsuarioAutenticado,
    painel: PainelIndicadores,
  ): boolean {
    return (
      ehDiretoria(usuario.papel) ||
      (ehLider(usuario.papel) && painel.donoId === usuario.id)
    );
  }

  private exigirCriador(usuario: UsuarioAutenticado): void {
    if (!podeCriarPaineis(usuario)) {
      throw new SemPermissaoException(
        'Só Admin, C-level e líderes montam painéis de indicadores.',
        { regra: REGRA_INDICADORES },
      );
    }
  }

  private exigirEdicao(
    usuario: UsuarioAutenticado,
    painel: PainelIndicadores,
  ): void {
    if (!this.podeEditar(usuario, painel)) {
      throw new SemPermissaoException('Você só edita os painéis que criou.', {
        regra: REGRA_INDICADORES,
      });
    }
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    painel: PainelComDono,
    completo: boolean,
  ): PainelDeIndicadores {
    const widgets = painel.widgets as unknown as Widget[];
    const podeEditar = this.podeEditar(usuario, painel);
    return {
      id: painel.id,
      nome: painel.nome,
      descricao: painel.descricao,
      dono: painel.dono,
      minha: painel.donoId === usuario.id,
      podeEditar,
      modelo: painel.modelo,
      filtrosPadrao: painel.filtrosPadrao as FiltrosDoIndicador,
      widgets: completo ? widgets : [],
      quantidadeDeWidgets: widgets.length,
      compartilhamento: podeEditar
        ? {
            setores: painel.compartilhadoSetores,
            pessoas: painel.compartilhadoPessoas,
            papeis: painel.compartilhadoPapeis,
          }
        : null,
      criadoEm: painel.criadoEm.toISOString(),
      atualizadoEm: painel.atualizadoEm.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    entrada: EntradaDePainel,
  ): Promise<PainelDeIndicadores> {
    this.exigirCriador(usuario);
    const modelo = entrada.modelo ? modeloDePainel(entrada.modelo) : undefined;
    if (entrada.modelo && !modelo) {
      throw new DadosInvalidosException('Modelo desconhecido.', {
        campos: [{ campo: 'modelo', mensagens: ['modelo desconhecido'] }],
      });
    }
    const nome = this.nomeValido(entrada.nome ?? modelo?.nome);
    const widgets = validarWidgets(entrada.widgets ?? modelo?.widgets ?? []);
    const filtrosPadrao = validarFiltros(
      entrada.filtrosPadrao,
      'filtrosPadrao',
    );
    const compartilhamento = this.compartilhamentoValido(
      entrada.compartilhamento,
    );
    await this.validarAlcance(usuario, filtrosPadrao, widgets);
    await this.validarCompartilhamento(usuario, compartilhamento);
    await this.exigirLimite(usuario);
    const criado = await this.prisma.$transaction(async (tx) => {
      const painel = await tx.painelIndicadores.create({
        data: {
          nome,
          descricao: this.descricaoValida(entrada.descricao),
          donoId: usuario.id,
          filtrosPadrao: filtrosPadrao as Prisma.InputJsonValue,
          widgets: widgets as unknown as Prisma.InputJsonValue,
          compartilhadoSetores: compartilhamento.setores,
          compartilhadoPessoas: compartilhamento.pessoas,
          compartilhadoPapeis: compartilhamento.papeis,
          modelo: modelo?.chave ?? null,
        },
        include: COM_DONO,
      });
      await this.auditoria.registrar(tx, {
        acao: 'indicadores.painel_criado',
        entidade: 'painel_indicadores',
        entidadeId: painel.id,
        resumo: `${usuario.nome} criou o painel de indicadores "${painel.nome}"${modelo ? ` (modelo ${modelo.nome})` : ''}`,
        dados: {
          nome: painel.nome,
          modelo: modelo?.chave ?? null,
          widgets: widgets.length,
          compartilhamento,
          regra: REGRA_INDICADORES,
        },
      });
      return painel;
    });
    return this.paraDto(usuario, criado, true);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    entrada: EntradaDePainel,
  ): Promise<PainelDeIndicadores> {
    const atual = await this.carregarVisivel(usuario, id);
    this.exigirEdicao(usuario, atual);
    const dados: Prisma.PainelIndicadoresUpdateInput = {};
    const campos: string[] = [];
    if (entrada.nome !== undefined) {
      dados.nome = this.nomeValido(entrada.nome);
      campos.push('nome');
    }
    if (entrada.descricao !== undefined) {
      dados.descricao = this.descricaoValida(entrada.descricao);
      campos.push('descricao');
    }
    let widgets = atual.widgets as unknown as Widget[];
    let filtrosPadrao = atual.filtrosPadrao as FiltrosDoIndicador;
    if (entrada.widgets !== undefined) {
      widgets = validarWidgets(entrada.widgets);
      dados.widgets = widgets as unknown as Prisma.InputJsonValue;
      campos.push('widgets');
    }
    if (entrada.filtrosPadrao !== undefined) {
      filtrosPadrao = validarFiltros(entrada.filtrosPadrao, 'filtrosPadrao');
      dados.filtrosPadrao = filtrosPadrao as Prisma.InputJsonValue;
      campos.push('filtrosPadrao');
    }
    if (entrada.widgets !== undefined || entrada.filtrosPadrao !== undefined) {
      await this.validarAlcance(usuario, filtrosPadrao, widgets);
    }
    let compartilhou: {
      antes: Compartilhamento;
      depois: Compartilhamento;
    } | null = null;
    if (entrada.compartilhamento !== undefined) {
      const depois = this.compartilhamentoValido(entrada.compartilhamento);
      await this.validarCompartilhamento(usuario, depois);
      const antes: Compartilhamento = {
        setores: atual.compartilhadoSetores,
        pessoas: atual.compartilhadoPessoas,
        papeis: atual.compartilhadoPapeis,
      };
      dados.compartilhadoSetores = depois.setores;
      dados.compartilhadoPessoas = depois.pessoas;
      dados.compartilhadoPapeis = depois.papeis;
      if (JSON.stringify(antes) !== JSON.stringify(depois)) {
        compartilhou = { antes, depois };
        campos.push('compartilhamento');
      }
    }
    const atualizado = await this.prisma.$transaction(async (tx) => {
      const painel = await tx.painelIndicadores.update({
        where: { id },
        data: dados,
        include: COM_DONO,
      });
      await this.auditoria.registrar(tx, {
        acao: 'indicadores.painel_atualizado',
        entidade: 'painel_indicadores',
        entidadeId: id,
        resumo: `${usuario.nome} alterou o painel de indicadores "${painel.nome}"`,
        dados: { campos, regra: REGRA_INDICADORES },
      });
      if (compartilhou) {
        await this.auditoria.registrar(tx, {
          acao: 'indicadores.painel_compartilhado',
          entidade: 'painel_indicadores',
          entidadeId: id,
          resumo: `${usuario.nome} mudou o compartilhamento do painel "${painel.nome}"`,
          dados: { ...compartilhou, regra: REGRA_INDICADORES },
        });
      }
      return painel;
    });
    return this.paraDto(usuario, atualizado, true);
  }

  async duplicar(
    usuario: UsuarioAutenticado,
    id: string,
    nome?: string,
  ): Promise<PainelDeIndicadores> {
    this.exigirCriador(usuario);
    const origem = await this.carregarVisivel(usuario, id);
    await this.exigirLimite(usuario);
    const novoNome = this.nomeValido(
      nome ?? `${origem.nome} (cópia)`.slice(0, TAMANHO_NOME_PAINEL),
    );
    const widgets = (origem.widgets as unknown as Widget[]).map((widget) => ({
      ...widget,
      id: undefined,
    }));
    const copia = await this.prisma.$transaction(async (tx) => {
      const painel = await tx.painelIndicadores.create({
        data: {
          nome: novoNome,
          descricao: origem.descricao,
          donoId: usuario.id,
          filtrosPadrao: origem.filtrosPadrao as Prisma.InputJsonValue,
          widgets: validarWidgets(widgets) as unknown as Prisma.InputJsonValue,
          modelo: origem.modelo,
        },
        include: COM_DONO,
      });
      await this.auditoria.registrar(tx, {
        acao: 'indicadores.painel_duplicado',
        entidade: 'painel_indicadores',
        entidadeId: painel.id,
        resumo: `${usuario.nome} duplicou o painel de indicadores "${origem.nome}"`,
        dados: { origemId: origem.id, regra: REGRA_INDICADORES },
      });
      return painel;
    });
    return this.paraDto(usuario, copia, true);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const painel = await this.carregarVisivel(usuario, id);
    this.exigirEdicao(usuario, painel);
    await this.prisma.$transaction(async (tx) => {
      await tx.painelIndicadores.update({
        where: { id },
        data: { excluidoEm: new Date() },
      });
      await this.auditoria.registrar(tx, {
        acao: 'indicadores.painel_excluido',
        entidade: 'painel_indicadores',
        entidadeId: id,
        resumo: `${usuario.nome} excluiu o painel de indicadores "${painel.nome}"`,
        dados: { nome: painel.nome, regra: REGRA_INDICADORES },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Validações
  // -------------------------------------------------------------------------

  private nomeValido(bruto: string | undefined): string {
    const nome = (bruto ?? '').trim();
    if (nome.length === 0 || nome.length > TAMANHO_NOME_PAINEL) {
      throw new DadosInvalidosException(
        `Dê um nome ao painel (até ${TAMANHO_NOME_PAINEL} caracteres).`,
        { campos: [{ campo: 'nome', mensagens: ['nome inválido'] }] },
      );
    }
    return nome;
  }

  private descricaoValida(bruta: string | null | undefined): string | null {
    const descricao = (bruta ?? '').trim();
    if (descricao.length > TAMANHO_DESCRICAO_PAINEL) {
      throw new DadosInvalidosException(
        `A descrição pode ter até ${TAMANHO_DESCRICAO_PAINEL} caracteres.`,
        {
          campos: [
            { campo: 'descricao', mensagens: ['descrição muito longa'] },
          ],
        },
      );
    }
    return descricao || null;
  }

  private compartilhamentoValido(
    bruto: Partial<Compartilhamento> | undefined,
  ): Compartilhamento {
    return {
      setores: [...new Set(bruto?.setores ?? [])],
      pessoas: [...new Set(bruto?.pessoas ?? [])],
      papeis: [...new Set(bruto?.papeis ?? [])] as Papel[],
    };
  }

  private async exigirLimite(usuario: UsuarioAutenticado): Promise<void> {
    const total = await this.prisma.painelIndicadores.count({
      where: { donoId: usuario.id, excluidoEm: null },
    });
    if (total >= MAXIMO_DE_PAINEIS_POR_DONO) {
      throw new DadosInvalidosException(
        `Você já tem ${MAXIMO_DE_PAINEIS_POR_DONO} painéis. Exclua algum antes de criar outro.`,
      );
    }
  }

  /** O líder compartilha só com o próprio setor e com pessoas dele; Admin e C-level, com todos (R33.6). */
  private async validarCompartilhamento(
    usuario: UsuarioAutenticado,
    compartilhamento: Compartilhamento,
  ): Promise<void> {
    const { setores, pessoas, papeis } = compartilhamento;
    if (setores.length > 0) {
      const existentes = await this.prisma.setor.findMany({
        where: { chave: { in: setores } },
        select: { chave: true },
      });
      if (existentes.length !== setores.length) {
        throw new NaoEncontradoException('Setor não encontrado.');
      }
    }
    if (pessoas.length > 0) {
      const existentes = await this.prisma.usuario.findMany({
        where: { id: { in: pessoas } },
        select: { id: true, area: true },
      });
      if (existentes.length !== pessoas.length) {
        throw new NaoEncontradoException('Pessoa não encontrada.');
      }
      if (!ehDiretoria(usuario.papel)) {
        const area = setorDaPessoa(usuario);
        if (existentes.some((pessoa) => pessoa.area !== area)) {
          throw new SemPermissaoException(
            'Você só compartilha com pessoas do seu setor.',
            { regra: REGRA_INDICADORES },
          );
        }
      }
    }
    if (!ehDiretoria(usuario.papel)) {
      const area = setorDaPessoa(usuario);
      if (setores.some((setor) => setor !== area)) {
        throw new SemPermissaoException(
          'Você só compartilha com o seu próprio setor.',
          { regra: REGRA_INDICADORES },
        );
      }
      if (papeis.length > 0) {
        throw new SemPermissaoException(
          'Só Admin e C-level compartilham por papel.',
          { regra: REGRA_INDICADORES },
        );
      }
    }
  }

  /** Filtros do painel e de cada widget, e funis e etapas dos parâmetros, dentro do alcance de quem salva. */
  private async validarAlcance(
    usuario: UsuarioAutenticado,
    filtrosPadrao: FiltrosDoIndicador,
    widgets: Widget[],
  ): Promise<void> {
    await this.filtros.resolver(usuario, filtrosPadrao);
    for (const [indice, widget] of widgets.entries()) {
      if (widget.filtros) {
        await this.filtros.resolver(
          usuario,
          mesclarFiltros(filtrosPadrao, widget.filtros),
        );
      }
      try {
        if (widget.parametros['funilId']) {
          await this.filtros.exigirFunilVisivel(
            usuario,
            widget.parametros['funilId'],
          );
        }
        for (const chave of ['etapaOrigemId', 'etapaDestinoId']) {
          if (widget.parametros[chave]) {
            await this.filtros.exigirEtapaVisivel(
              usuario,
              widget.parametros[chave],
            );
          }
        }
      } catch (erro) {
        if (erro instanceof NaoEncontradoException) {
          throw new NaoEncontradoException(
            `${erro.message} (indicador ${indice + 1} do painel)`,
          );
        }
        throw erro;
      }
    }
  }
}
