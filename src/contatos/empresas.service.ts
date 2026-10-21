import { Injectable } from '@nestjs/common';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { contextoAtual } from '../comum/contexto/contexto-requisicao';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { normalizarCnpjOpcional } from '../comum/dominio/cnpj';
import { normalizarEmailOpcional } from '../comum/dominio/email';
import { normalizarEtiquetas } from '../comum/dominio/etiquetas';
import { normalizarTelefoneOpcional } from '../comum/dominio/telefone';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
} from '../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../comum/paginacao/paginacao';
import { EventosDominioService } from '../eventos/eventos-dominio.service';
import { type Empresa, Prisma } from '../generated/prisma/client';
import { NotificacoesService } from '../notificacoes/notificacoes.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { travarChave } from '../prisma/travas';
import { filtroDeBuscaDeEmpresas } from './busca';
import {
  NOTIFICACAO_EMPRESA_ATRIBUIDA,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_SITE,
  TRAVA_CNPJ_DA_EMPRESA,
  TRAVA_NOME_DA_EMPRESA,
} from './contatos.constantes';
import {
  aplicarPatchDosCampos,
  normalizarCamposPersonalizados,
  normalizarTextoCurto,
} from './deduplicacao';
import type { EtiquetaEmUsoDto, FiltroEtiquetasDto } from './dto/comum.dto';
import {
  type AtualizarEmpresaDto,
  type CriarEmpresaDto,
  EmpresaDto,
  type FiltroEmpresasDto,
  type OrdenacaoDeEmpresas,
} from './dto/empresa.dto';
import type {
  FiltroDaLinhaDoTempoDto,
  RegistroDaLinhaDoTempoDto,
} from './dto/linha-do-tempo.dto';
import { grafiasDaEtiqueta, listarEtiquetasEmUso } from './etiquetas-em-uso';
import {
  CAMPOS_AUDITADOS_DA_EMPRESA,
  instantaneoDaEmpresa,
} from './instantaneos';
import { LinhaDoTempoService } from './linha-do-tempo.service';
import {
  type AlcanceDeEdicao,
  PermissoesContatosService,
} from './permissoes-contatos.service';
import { type EmpresaComRelacoes, INCLUIR_NA_EMPRESA } from './relacoes';
import { descreverAlteracoes } from './rotulos';

const ORDENACAO: Readonly<
  Record<
    OrdenacaoDeEmpresas,
    (ordem: Prisma.SortOrder) => Prisma.EmpresaOrderByWithRelationInput
  >
> = {
  nome: (ordem) => ({ nome: ordem }),
  criadoEm: (ordem) => ({ criadoEm: ordem }),
  atualizadoEm: (ordem) => ({ atualizadoEm: ordem }),
};

/**
 * Empresas (R4.4, R4.5, R4.7): nome obrigatório, CNPJ opcional mas válido e
 * único, responsável ativo (padrão: quem criou), etiquetas e campos
 * personalizados. Edição conforme a matriz §12; toda alteração com auditoria
 * e evento de domínio na mesma transação.
 */
@Injectable()
export class EmpresasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly eventos: EventosDominioService,
    private readonly notificacoes: NotificacoesService,
    private readonly permissoes: PermissoesContatosService,
    private readonly linhaDoTempoService: LinhaDoTempoService,
  ) {}

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroEmpresasDto,
  ): Promise<Pagina<EmpresaDto>> {
    if (filtro.responsavelId && filtro.semResponsavel === true) {
      throw new DadosInvalidosException(
        'Use responsavelId ou semResponsavel, não os dois.',
        {
          campos: [
            {
              campo: 'semResponsavel',
              mensagens: ['não combina com responsavelId'],
            },
          ],
        },
      );
    }
    const where: Prisma.EmpresaWhereInput = { excluidoEm: null };
    if (filtro.responsavelId) {
      where.responsavelId = filtro.responsavelId;
    } else if (filtro.semResponsavel !== undefined) {
      where.responsavelId = filtro.semResponsavel ? null : { not: null };
    }
    if (filtro.uf) {
      where.uf = filtro.uf;
    }
    if (filtro.etiqueta) {
      const grafias = await grafiasDaEtiqueta(
        this.prisma,
        'empresas',
        filtro.etiqueta,
      );
      if (grafias.length === 0) {
        return montarPagina([], 0, filtro);
      }
      where.etiquetas = { hasSome: grafias };
    }
    const busca = filtroDeBuscaDeEmpresas(filtro.busca);
    if (busca) {
      where.AND = [busca];
    }
    const ordem =
      filtro.ordem ?? (filtro.ordenarPor === 'nome' ? 'asc' : 'desc');
    const [empresas, total, alcance] = await Promise.all([
      this.prisma.empresa.findMany({
        where,
        include: INCLUIR_NA_EMPRESA,
        orderBy: [ORDENACAO[filtro.ordenarPor](ordem), { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.empresa.count({ where }),
      this.permissoes.alcance(usuario),
    ]);
    return montarPagina(
      empresas.map((empresa) =>
        EmpresaDto.de(empresa, alcance.permite(empresa.responsavelId)),
      ),
      total,
      filtro,
    );
  }

  etiquetasEmUso(filtro: FiltroEtiquetasDto): Promise<EtiquetaEmUsoDto[]> {
    return listarEtiquetasEmUso(this.prisma, 'empresas', filtro);
  }

  async detalhar(usuario: UsuarioAutenticado, id: string): Promise<EmpresaDto> {
    const [empresa, alcance] = await Promise.all([
      this.prisma.empresa.findFirst({
        where: { id, excluidoEm: null },
        include: INCLUIR_NA_EMPRESA,
      }),
      this.permissoes.alcance(usuario),
    ]);
    if (!empresa) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
    return EmpresaDto.de(empresa, alcance.permite(empresa.responsavelId));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarEmpresaDto,
  ): Promise<EmpresaDto> {
    const cnpj = normalizarCnpjOpcional(dto.cnpj);
    const responsavelId = dto.responsavelId ?? usuario.id;
    const alcance = await this.permissoes.alcance(usuario);
    const empresa = await this.prisma.$transaction(async (tx) => {
      if (cnpj) {
        // R4.4: CNPJ único — a trava enfileira duas criações com o mesmo CNPJ.
        await travarChave(tx, TRAVA_CNPJ_DA_EMPRESA, cnpj);
        await this.garantirCnpjLivre(tx, cnpj);
      }
      // Quem cria está ativo (a sessão garante); outro responsável passa pela R4.5 e pela §12.
      if (responsavelId !== usuario.id) {
        await this.permissoes.garantirPodeAtribuir(
          tx,
          alcance,
          responsavelId,
          'empresa',
        );
      }
      const criada = await tx.empresa.create({
        data: {
          nome: normalizarTextoCurto(dto.nome, TAMANHO_MAXIMO_NOME) as string,
          cnpj,
          site: normalizarTextoCurto(dto.site, TAMANHO_MAXIMO_SITE),
          email: normalizarEmailOpcional(dto.email),
          telefone: normalizarTelefoneOpcional(dto.telefone),
          segmento: normalizarTextoCurto(dto.segmento),
          cidade: normalizarTextoCurto(dto.cidade),
          uf: dto.uf ?? null,
          responsavelId,
          etiquetas: normalizarEtiquetas(dto.etiquetas),
          camposPersonalizados: normalizarCamposPersonalizados(
            dto.camposPersonalizados,
          ) as Prisma.InputJsonObject,
          criadoPorId: usuario.id,
        },
      });
      await this.registrarCriacao(tx, criada);
      await this.notificarAtribuicao(tx, criada);
      return criada;
    });
    return this.carregarDto(empresa.id, alcance);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarEmpresaDto,
  ): Promise<EmpresaDto> {
    const cnpj =
      dto.cnpj === undefined ? undefined : normalizarCnpjOpcional(dto.cnpj);
    const alcance = await this.permissoes.alcance(usuario);
    const empresa = await this.prisma.$transaction(async (tx) => {
      // Travas na ordem de sempre: chave do CNPJ antes da linha.
      if (cnpj) {
        await travarChave(tx, TRAVA_CNPJ_DA_EMPRESA, cnpj);
      }
      const antes = await this.travarEmpresaAtiva(tx, id);
      this.permissoes.garantirPodeEditar(
        alcance,
        antes.responsavelId,
        'empresa',
      );

      const dados: Prisma.EmpresaUncheckedUpdateInput = {};
      if (dto.nome !== undefined) {
        dados.nome = normalizarTextoCurto(
          dto.nome,
          TAMANHO_MAXIMO_NOME,
        ) as string;
      }
      if (cnpj !== undefined && cnpj !== antes.cnpj) {
        if (cnpj) {
          await this.garantirCnpjLivre(tx, cnpj, id);
        }
        dados.cnpj = cnpj;
      }
      if (dto.site !== undefined) {
        dados.site = normalizarTextoCurto(dto.site, TAMANHO_MAXIMO_SITE);
      }
      if (dto.email !== undefined) {
        dados.email = normalizarEmailOpcional(dto.email);
      }
      if (dto.telefone !== undefined) {
        dados.telefone = normalizarTelefoneOpcional(dto.telefone);
      }
      if (dto.segmento !== undefined) {
        dados.segmento = normalizarTextoCurto(dto.segmento);
      }
      if (dto.cidade !== undefined) {
        dados.cidade = normalizarTextoCurto(dto.cidade);
      }
      if (dto.uf !== undefined) {
        dados.uf = dto.uf;
      }
      if (
        dto.responsavelId !== undefined &&
        dto.responsavelId !== antes.responsavelId
      ) {
        await this.permissoes.garantirPodeAtribuir(
          tx,
          alcance,
          dto.responsavelId,
          'empresa',
        );
        dados.responsavelId = dto.responsavelId;
      }
      if (dto.etiquetas !== undefined) {
        dados.etiquetas = normalizarEtiquetas(dto.etiquetas);
      }
      if (dto.camposPersonalizados !== undefined) {
        dados.camposPersonalizados = aplicarPatchDosCampos(
          antes.camposPersonalizados,
          dto.camposPersonalizados,
        ) as Prisma.InputJsonObject;
      }

      const alteracoes = calcularAlteracoes(
        antes,
        { ...antes, ...dados },
        CAMPOS_AUDITADOS_DA_EMPRESA,
      );
      if (Object.keys(alteracoes).length === 0) {
        return antes;
      }
      const depois = await tx.empresa.update({ where: { id }, data: dados });
      await this.auditoria.registrar(tx, {
        acao: 'empresa.atualizada',
        entidade: 'empresa',
        entidadeId: depois.id,
        resumo: `Empresa "${depois.nome}" atualizada: ${descreverAlteracoes(alteracoes)}`,
        dados: { alteracoes },
      });
      await this.eventos.publicar(tx, 'empresa.atualizada', {
        ...instantaneoDaEmpresa(depois),
        camposAlterados: Object.keys(alteracoes),
      });
      if (dados.responsavelId !== undefined) {
        await this.notificarAtribuicao(tx, depois);
      }
      return depois;
    });
    return this.carregarDto(empresa.id, alcance);
  }

  async linhaDoTempo(
    usuario: UsuarioAutenticado,
    id: string,
    filtro: FiltroDaLinhaDoTempoDto,
  ): Promise<Pagina<RegistroDaLinhaDoTempoDto>> {
    const existe = await this.prisma.empresa.count({
      where: { id, excluidoEm: null },
    });
    if (existe === 0) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
    return this.linhaDoTempoService.listar(usuario, 'empresa', id, filtro);
  }

  // ---------------------------------------------------------------------------
  // Usados pelos contatos (na transação de quem chama)
  // ---------------------------------------------------------------------------

  /**
   * Empresa pelo nome, para a deduplicação de contatos (webhooks mandam só o
   * nome): a empresa ativa com o mesmo nome (sem diferenciar maiúsculas nem
   * espaços repetidos) ou uma nova, com o responsável informado (R4.5).
   */
  async encontrarOuCriarPorNome(
    tx: Tx,
    nome: string,
    opcoes: { responsavelId: string | null },
  ): Promise<{ empresa: Empresa; criada: boolean }> {
    const nomeNormalizado = normalizarTextoCurto(nome, TAMANHO_MAXIMO_NOME);
    if (!nomeNormalizado) {
      throw new DadosInvalidosException('Informe o nome da empresa.', {
        campos: [{ campo: 'empresaNome', mensagens: ['é obrigatório'] }],
      });
    }
    await travarChave(tx, TRAVA_NOME_DA_EMPRESA, nomeNormalizado.toLowerCase());
    const [existente] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM empresas
       WHERE excluido_em IS NULL
         AND lower(regexp_replace(btrim(nome), '\\s+', ' ', 'g')) = lower(${nomeNormalizado})
       ORDER BY criado_em, id
       LIMIT 1`;
    if (existente) {
      return {
        empresa: await tx.empresa.findUniqueOrThrow({
          where: { id: existente.id },
        }),
        criada: false,
      };
    }
    const contexto = contextoAtual();
    const empresa = await tx.empresa.create({
      data: {
        nome: nomeNormalizado,
        responsavelId: opcoes.responsavelId,
        criadoPorId: contexto.usuario?.id ?? null,
      },
    });
    await this.registrarCriacao(tx, empresa);
    return { empresa, criada: true };
  }

  /** A empresa existe e não foi excluída (400 no campo `empresaId` se não). */
  async garantirAtiva(tx: Tx, id: string): Promise<void> {
    const empresa = await tx.empresa.findFirst({
      where: { id, excluidoEm: null },
      select: { id: true },
    });
    if (!empresa) {
      throw new DadosInvalidosException('Empresa não encontrada.', {
        campos: [{ campo: 'empresaId', mensagens: ['empresa não encontrada'] }],
      });
    }
  }

  /** R4.5: a empresa sem responsável passa a ser de `responsavelId` (ex.: o do negócio que a originou). */
  async definirResponsavelSeVazio(
    tx: Tx,
    empresaId: string,
    responsavelId: string,
  ): Promise<Empresa | null> {
    const atualizadas = await tx.empresa.updateMany({
      where: { id: empresaId, responsavelId: null, excluidoEm: null },
      data: { responsavelId },
    });
    if (atualizadas.count === 0) {
      return null;
    }
    const empresa = await tx.empresa.findUniqueOrThrow({
      where: { id: empresaId },
    });
    const alteracoes = calcularAlteracoes({ responsavelId: null }, empresa, [
      'responsavelId',
    ]);
    await this.auditoria.registrar(tx, {
      acao: 'empresa.atualizada',
      entidade: 'empresa',
      entidadeId: empresa.id,
      resumo: `Empresa "${empresa.nome}" ganhou responsável (R4.5)`,
      dados: { alteracoes },
    });
    await this.eventos.publicar(tx, 'empresa.atualizada', {
      ...instantaneoDaEmpresa(empresa),
      camposAlterados: ['responsavelId'],
    });
    return empresa;
  }

  // ---------------------------------------------------------------------------

  private async registrarCriacao(tx: Tx, empresa: Empresa): Promise<void> {
    await this.auditoria.registrar(tx, {
      acao: 'empresa.criada',
      entidade: 'empresa',
      entidadeId: empresa.id,
      resumo: `Empresa "${empresa.nome}" criada`,
      dados: {
        alteracoes: calcularAlteracoes(
          {},
          empresa,
          CAMPOS_AUDITADOS_DA_EMPRESA,
        ),
      },
    });
    await this.eventos.publicar(
      tx,
      'empresa.criada',
      instantaneoDaEmpresa(empresa),
    );
  }

  /** Avisa quem recebeu a empresa por ação de outra pessoa (R10.2). */
  private async notificarAtribuicao(tx: Tx, empresa: Empresa): Promise<void> {
    const contexto = contextoAtual();
    if (
      !empresa.responsavelId ||
      contexto.tipoAtor !== 'USUARIO' ||
      contexto.usuario?.id === empresa.responsavelId
    ) {
      return;
    }
    await this.notificacoes.notificar(tx, empresa.responsavelId, {
      tipo: NOTIFICACAO_EMPRESA_ATRIBUIDA,
      titulo: 'Empresa atribuída a você',
      texto: `${contexto.usuario?.nome ?? 'Alguém'} passou a empresa ${empresa.nome} para você.`,
      link: `/empresas/${empresa.id}`,
      dados: { empresaId: empresa.id },
    });
  }

  private async garantirCnpjLivre(
    tx: Tx,
    cnpj: string,
    exceto?: string,
  ): Promise<void> {
    const outra = await tx.empresa.findFirst({
      where: {
        cnpj,
        excluidoEm: null,
        ...(exceto ? { NOT: { id: exceto } } : {}),
      },
      select: { id: true, nome: true },
    });
    if (outra) {
      throw new ConflitoException(
        `Já existe uma empresa com este CNPJ: ${outra.nome}.`,
        {
          regra: 'R4.4',
          campos: ['cnpj'],
          restricao: 'empresas_cnpj_ativo_key',
          empresaId: outra.id,
        },
      );
    }
  }

  /** Trava a linha da empresa ativa (`FOR NO KEY UPDATE`) e a devolve; 404 se não existir. */
  private async travarEmpresaAtiva(tx: Tx, id: string): Promise<Empresa> {
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM empresas WHERE id = ${id}::uuid AND excluido_em IS NULL FOR NO KEY UPDATE`;
    if (!linha) {
      throw new NaoEncontradoException('Empresa não encontrada.');
    }
    return tx.empresa.findUniqueOrThrow({ where: { id } });
  }

  /**
   * O DTO é montado depois do commit: um `include` com várias relações dentro
   * da transação faz o Prisma disparar consultas em paralelo na mesma conexão
   * (o `pg` 8 avisa; o 9 vai recusar).
   */
  private async carregarDto(
    id: string,
    alcance: AlcanceDeEdicao,
  ): Promise<EmpresaDto> {
    const empresa: EmpresaComRelacoes =
      await this.prisma.empresa.findUniqueOrThrow({
        where: { id },
        include: INCLUIR_NA_EMPRESA,
      });
    return EmpresaDto.de(empresa, alcance.permite(empresa.responsavelId));
  }
}
