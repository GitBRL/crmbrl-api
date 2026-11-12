import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { ehDiretoria, ehLider, setorDaPessoa } from '../comum/dominio/papeis';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { validarModelo } from '../comum/modelos/modelos';
import {
  montarPagina,
  paraSkipTake,
  type Pagina,
} from '../comum/paginacao/paginacao';
import type { Prisma, TipoCanal } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REGRA_DISPAROS } from './disparos.constantes';
import type {
  AtualizarModeloMensagemDto,
  CriarModeloMensagemDto,
  FiltroModelosMensagemDto,
} from './disparos.dto';
import type { Area } from '../comum/dominio/setores';
import { garantirSetorAtivoSeHouver } from '../setores/setores-no-banco';

export interface ModeloMensagemDto {
  id: string;
  nome: string;
  canal: TipoCanal | null;
  assunto: string | null;
  texto: string;
  arquivo: ArquivoDto | null;
  area: Area | null;
  /** Variáveis usadas no texto (`contato.nome`, `x`…). */
  variaveis: string[];
  criadoPor: { id: string; nome: string } | null;
  podeEditar: boolean;
  criadoEm: string;
  atualizadoEm: string;
}

const INCLUIR = {
  arquivo: true,
  criadoPor: { select: { id: true, nome: true } },
} satisfies Prisma.ModeloMensagemInclude;

type ModeloCompleto = Prisma.ModeloMensagemGetPayload<{
  include: typeof INCLUIR;
}>;

const CAMPOS_AUDITADOS = [
  'nome',
  'canal',
  'assunto',
  'texto',
  'arquivoId',
  'area',
] as const;

/**
 * Modelos de mensagem salvos (CRUD em `/modelos-mensagem`). Todos veem os de
 * todas as áreas e os da própria área; Admin e C-level veem e editam todos; o
 * líder edita os da área; quem criou edita os seus.
 */
@Injectable()
export class ModelosMensagemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly arquivos: ArquivosService,
  ) {}

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroModelosMensagemDto,
  ): Promise<Pagina<ModeloMensagemDto>> {
    const e: Prisma.ModeloMensagemWhereInput[] = [
      { excluidoEm: null },
      this.visiveis(usuario),
    ];
    if (filtro.canal) {
      e.push({ OR: [{ canal: filtro.canal }, { canal: null }] });
    }
    if (filtro.busca) {
      e.push({ nome: { contains: filtro.busca, mode: 'insensitive' } });
    }
    const where: Prisma.ModeloMensagemWhereInput = { AND: e };
    const [itens, total] = await Promise.all([
      this.prisma.modeloMensagem.findMany({
        where,
        include: INCLUIR,
        orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.modeloMensagem.count({ where }),
    ]);
    return montarPagina(
      itens.map((m) => this.paraDto(usuario, m)),
      total,
      filtro,
    );
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ModeloMensagemDto> {
    return this.paraDto(usuario, await this.obter(usuario, id));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarModeloMensagemDto,
  ): Promise<ModeloMensagemDto> {
    this.validar(dto.texto, dto.assunto ?? null);
    if (dto.arquivoId) {
      await this.validarArquivo(usuario, dto.arquivoId);
    }
    const area = ehDiretoria(usuario.papel)
      ? (dto.area ?? null)
      : setorDaPessoa(usuario);
    const id = await this.prisma.$transaction(async (tx) => {
      await garantirSetorAtivoSeHouver(tx, area);
      const criado = await tx.modeloMensagem.create({
        data: {
          nome: dto.nome,
          canal: dto.canal ?? null,
          assunto: dto.assunto ?? null,
          texto: dto.texto,
          arquivoId: dto.arquivoId ?? null,
          area,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'modelo_mensagem.criado',
        entidade: 'modelo_mensagem',
        entidadeId: criado.id,
        resumo: `${usuario.nome} criou o modelo de mensagem "${criado.nome}"`,
        dados: { canal: criado.canal, regra: REGRA_DISPAROS },
      });
      return criado.id;
    });
    return this.detalhar(usuario, id);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarModeloMensagemDto,
  ): Promise<ModeloMensagemDto> {
    const atual = await this.obter(usuario, id);
    this.exigirEdicao(usuario, atual);
    this.validar(
      dto.texto ?? atual.texto,
      dto.assunto !== undefined ? dto.assunto : atual.assunto,
    );
    if (dto.arquivoId) {
      await this.validarArquivo(usuario, dto.arquivoId);
    }
    if (
      dto.area !== undefined &&
      !ehDiretoria(usuario.papel) &&
      dto.area !== setorDaPessoa(usuario)
    ) {
      throw new SemPermissaoException(
        'Você só pode deixar o modelo no seu setor.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.area !== undefined && dto.area !== atual.area) {
        await garantirSetorAtivoSeHouver(tx, dto.area);
      }
      const depois = await tx.modeloMensagem.update({
        where: { id },
        data: {
          ...(dto.nome !== undefined ? { nome: dto.nome } : {}),
          ...(dto.canal !== undefined ? { canal: dto.canal } : {}),
          ...(dto.assunto !== undefined ? { assunto: dto.assunto } : {}),
          ...(dto.texto !== undefined ? { texto: dto.texto } : {}),
          ...(dto.arquivoId !== undefined ? { arquivoId: dto.arquivoId } : {}),
          ...(dto.area !== undefined ? { area: dto.area } : {}),
        },
      });
      const alteracoes = calcularAlteracoes(atual, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'modelo_mensagem.atualizado',
          entidade: 'modelo_mensagem',
          entidadeId: id,
          resumo: `${usuario.nome} alterou o modelo de mensagem "${depois.nome}"`,
          dados: { alteracoes, regra: REGRA_DISPAROS },
        });
      }
    });
    return this.detalhar(usuario, id);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const atual = await this.obter(usuario, id);
    this.exigirEdicao(usuario, atual);
    await this.prisma.$transaction(async (tx) => {
      await tx.modeloMensagem.update({
        where: { id },
        data: { excluidoEm: new Date() },
      });
      await this.auditoria.registrar(tx, {
        acao: 'modelo_mensagem.excluido',
        entidade: 'modelo_mensagem',
        entidadeId: id,
        resumo: `${usuario.nome} excluiu o modelo de mensagem "${atual.nome}"`,
        dados: { regra: REGRA_DISPAROS },
      });
    });
  }

  // -------------------------------------------------------------------------

  private visiveis(
    usuario: UsuarioAutenticado,
  ): Prisma.ModeloMensagemWhereInput {
    return filtroDeModelosVisiveis(usuario);
  }

  private async obter(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<ModeloCompleto> {
    const modelo = await this.prisma.modeloMensagem.findFirst({
      where: { id, excluidoEm: null, ...this.visiveis(usuario) },
      include: INCLUIR,
    });
    if (!modelo) {
      throw new NaoEncontradoException('Modelo de mensagem não encontrado.');
    }
    return modelo;
  }

  private podeEditar(
    usuario: UsuarioAutenticado,
    modelo: Pick<ModeloCompleto, 'area' | 'criadoPorId'>,
  ): boolean {
    if (ehDiretoria(usuario.papel) || modelo.criadoPorId === usuario.id) {
      return true;
    }
    return (
      ehLider(usuario.papel) &&
      modelo.area !== null &&
      setorDaPessoa(usuario) === modelo.area
    );
  }

  private exigirEdicao(
    usuario: UsuarioAutenticado,
    modelo: ModeloCompleto,
  ): void {
    if (!this.podeEditar(usuario, modelo)) {
      throw new SemPermissaoException('Você não pode alterar este modelo.');
    }
  }

  private validar(texto: string, assunto: string | null): void {
    const problemas = [
      ...validarModelo(texto).erros.map((e) => ({
        campo: 'texto',
        mensagem: e.mensagem,
      })),
      ...(assunto
        ? validarModelo(assunto).erros.map((e) => ({
            campo: 'assunto',
            mensagem: e.mensagem,
          }))
        : []),
    ];
    if (problemas.length > 0) {
      throw new DadosInvalidosException(
        `Modelo inválido — ${problemas[0]?.campo}: ${problemas[0]?.mensagem}`,
        {
          campos: problemas.map((p) => ({
            campo: p.campo,
            mensagens: [p.mensagem],
          })),
        },
      );
    }
  }

  private async validarArquivo(
    usuario: UsuarioAutenticado,
    arquivoId: string,
  ): Promise<void> {
    const arquivo = await this.prisma.arquivo.findFirst({
      where: { id: arquivoId, removidoEm: null },
    });
    if (
      !arquivo ||
      !(await this.arquivos.podeLer(usuario, arquivo)) ||
      arquivo.contexto !== 'CAMPANHA'
    ) {
      throw new DadosInvalidosException(
        'Mídia não encontrada (envie com contexto=CAMPANHA).',
        {
          campos: [
            { campo: 'arquivoId', mensagens: ['arquivo não encontrado'] },
          ],
        },
      );
    }
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    m: ModeloCompleto,
  ): ModeloMensagemDto {
    return {
      id: m.id,
      nome: m.nome,
      canal: m.canal,
      assunto: m.assunto,
      texto: m.texto,
      arquivo: m.arquivo ? ArquivoDto.de(m.arquivo) : null,
      area: m.area,
      variaveis: validarModelo(m.texto).variaveis,
      criadoPor: m.criadoPor,
      podeEditar: this.podeEditar(usuario, m),
      criadoEm: m.criadoEm.toISOString(),
      atualizadoEm: m.atualizadoEm.toISOString(),
    };
  }
}

/**
 * Modelos de mensagem que a pessoa vê (R17): todos para a diretoria; senão os de todas as áreas
 * (`area` nula), os do próprio setor e os que ela criou. Vale também para quem usa o modelo
 * numa campanha ou automação.
 */
export function filtroDeModelosVisiveis(
  usuario: Pick<UsuarioAutenticado, 'id' | 'papel' | 'area'>,
): Prisma.ModeloMensagemWhereInput {
  if (ehDiretoria(usuario.papel)) {
    return {};
  }
  const area = setorDaPessoa(usuario);
  return {
    OR: [
      { area: null },
      ...(area ? [{ area }] : []),
      { criadoPorId: usuario.id },
    ],
  };
}
