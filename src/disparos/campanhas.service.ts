import { Injectable } from '@nestjs/common';
import { ArquivoDto } from '../arquivos/arquivos.dto';
import { ArquivosService } from '../arquivos/arquivos.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../auth/usuario-autenticado';
import { limiteDoDia } from '../canais/whatsapp/protecoes';
import { calcularAlteracoes } from '../comum/dados/sanitizar';
import { normalizarTelefone } from '../comum/dominio/telefone';
import { executarComoAtor } from '../comum/contexto/contexto-requisicao';
import {
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
  SemPermissaoException,
} from '../comum/erros/excecoes';
import { ModelosService } from '../comum/modelos/modelos.service';
import { validarModelo } from '../comum/modelos/modelos';
import {
  montarPagina,
  paraSkipTake,
  type Pagina,
} from '../comum/paginacao/paginacao';
import { SegmentosService } from '../comum/segmentos/segmentos.service';
import { ContatosService } from '../contatos/contatos.service';
import { validarHorario } from '../atendimento/horario';
import {
  type Campanha,
  Prisma,
  type StatusCampanha,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AcessoDisparos } from './acesso-disparos.service';
import { CanaisDaCampanha } from './canais-da-campanha.service';
import {
  type AcoesDaCampanha,
  type AguardandoDaCampanha,
  type CampanhaDto,
  type CampanhaResumoDto,
  iso,
  progressoDe,
} from './campanha.dto-saida';
import { CicloDaCampanha } from './ciclo-da-campanha.service';
import { ConfiguracaoDisparosService } from './configuracao-disparos.service';
import { REGRA_DISPAROS } from './disparos.constantes';
import type {
  AtualizarCampanhaDto,
  CriarCampanhaDto,
  EnvioDeTesteDto,
  EstimativaDto,
  FiltroCampanhasDto,
  FiltroDestinatariosDto,
  IniciarCampanhaDto,
  PreviaDaMensagemDto,
  PreviaDoPublicoDto,
} from './disparos.dto';
import { EntregaDeCampanha } from './entrega-de-campanha.service';
import {
  areaDaNovaCampanha,
  dispensaAprovacao,
  filtroDeCampanhasVisiveis,
  podeAprovarCampanha,
} from './permissoes-disparos';
import { ProgressoDaCampanha } from './progresso-da-campanha.service';
import { type Estimativa, estimarDuracao, situacaoDaJanela } from './ritmo';
import { type PreviaDoPublico, PublicoDaCampanha } from './publico.service';
import { garantirSetorAtivoSeHouver } from '../setores/setores-no-banco';

const INCLUIR = {
  canais: {
    orderBy: { ordem: 'asc' },
    include: {
      canal: {
        include: {
          whatsappNumero: {
            select: { telefone: true, status: true, pausadoEm: true },
          },
        },
      },
    },
  },
  criadoPor: { select: { id: true, nome: true } },
  aprovadaPor: { select: { id: true, nome: true } },
  arquivo: true,
} satisfies Prisma.CampanhaInclude;

type CampanhaCompleta = Prisma.CampanhaGetPayload<{ include: typeof INCLUIR }>;

const CAMPOS_AUDITADOS = [
  'nome',
  'descricao',
  'tipoPublico',
  'segmento',
  'importacaoId',
  'modeloId',
  'assunto',
  'texto',
  'arquivoId',
  'intervaloMinimoSegundos',
  'intervaloMaximoSegundos',
  'loteTamanho',
  'lotePausaSegundos',
  'simularDigitando',
  'janelaEnvio',
  'pausarAposFalhas',
] as const;

const STATUS_QUE_EDITAM_RITMO: readonly StatusCampanha[] = [
  'RASCUNHO',
  'AGENDADA',
  'EM_ANDAMENTO',
  'PAUSADA',
];

export interface ProblemaDaRevisao {
  gravidade: 'erro' | 'aviso';
  campo: string;
  mensagem: string;
}

export interface RevisaoDaCampanha {
  campanhaId: string;
  publico: PreviaDoPublico;
  estimativa: Estimativa & { limiteDiarioTotal: number | null };
  canais: Array<{
    id: string;
    nome: string;
    telefone: string | null;
    disponivel: boolean;
    motivo: string | null;
    limiteDoDia: number | null;
  }>;
  previa: { texto: string; assunto: string | null };
  problemas: ProblemaDaRevisao[];
  podeIniciar: boolean;
  exigeAprovacao: boolean;
}

/**
 * Campanhas de disparo (R17): criação e edição do rascunho, revisão antes de
 * iniciar (público, prévia, estimativa de duração, problemas), ciclo de vida
 * (iniciar/agendar, aprovação do líder opcional, pausar, retomar, cancelar,
 * reenviar falhas, duplicar), prévia da mensagem e envio de teste. As
 * transições ficam em `CicloDaCampanha`; o envio, em `EnvioDeCampanha`.
 */
@Injectable()
export class CampanhasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acesso: AcessoDisparos,
    private readonly ciclo: CicloDaCampanha,
    private readonly publico: PublicoDaCampanha,
    private readonly canais: CanaisDaCampanha,
    private readonly segmentos: SegmentosService,
    private readonly modelos: ModelosService,
    private readonly progresso: ProgressoDaCampanha,
    private readonly configuracao: ConfiguracaoDisparosService,
    private readonly arquivos: ArquivosService,
    private readonly auditoria: AuditoriaService,
    private readonly contatos: ContatosService,
    private readonly entrega: EntregaDeCampanha,
  ) {}

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  async listar(
    usuario: UsuarioAutenticado,
    filtro: FiltroCampanhasDto,
  ): Promise<Pagina<CampanhaResumoDto>> {
    const e: Prisma.CampanhaWhereInput[] = [
      { excluidoEm: null },
      filtroDeCampanhasVisiveis(usuario),
    ];
    if (filtro.status?.length) {
      e.push({ status: { in: filtro.status } });
    }
    if (filtro.canal) {
      e.push({ canal: filtro.canal });
    }
    if (filtro.area) {
      e.push({ area: filtro.area });
    }
    if (filtro.minhas) {
      e.push({ criadoPorId: usuario.id });
    }
    if (filtro.busca) {
      e.push({ nome: { contains: filtro.busca, mode: 'insensitive' } });
    }
    const where: Prisma.CampanhaWhereInput = { AND: e };
    const [campanhas, total] = await Promise.all([
      this.prisma.campanha.findMany({
        where,
        include: INCLUIR,
        orderBy: [{ criadoEm: 'desc' }, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.campanha.count({ where }),
    ]);
    const contadores = await this.progresso.contarVarias(
      campanhas.map((c) => c.id),
    );
    const itens = campanhas.map((c) => {
      const completo = this.paraDto(usuario, c, contadores.get(c.id));
      const {
        segmento: _s,
        texto: _t,
        assunto: _a,
        janelaEnvio: _j,
        ritmo: _r,
        aprovacao: _ap,
        ...resumo
      } = completo;
      return resumo;
    });
    return montarPagina(itens, total, filtro);
  }

  async detalhar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<CampanhaDto> {
    await this.acesso.obter(usuario, id);
    return this.carregarDto(usuario, id);
  }

  async destinatarios(
    usuario: UsuarioAutenticado,
    id: string,
    filtro: FiltroDestinatariosDto,
  ) {
    await this.acesso.obter(usuario, id);
    const where: Prisma.CampanhaDestinatarioWhereInput = {
      campanhaId: id,
      ...(filtro.status?.length ? { status: { in: filtro.status } } : {}),
      ...(filtro.respondeu === true ? { respondeuEm: { not: null } } : {}),
      ...(filtro.respondeu === false ? { respondeuEm: null } : {}),
      ...(filtro.busca
        ? {
            contato: {
              OR: [
                { nome: { contains: filtro.busca, mode: 'insensitive' } },
                { email: { contains: filtro.busca, mode: 'insensitive' } },
                {
                  telefone: {
                    contains: filtro.busca.replace(/\D/g, '') || filtro.busca,
                  },
                },
              ],
            },
          }
        : {}),
    };
    const [linhas, total] = await Promise.all([
      this.prisma.campanhaDestinatario.findMany({
        where,
        orderBy: [{ ordem: 'asc' }],
        ...paraSkipTake(filtro),
        include: {
          contato: {
            select: { id: true, nome: true, email: true, telefone: true },
          },
          canal: { select: { id: true, nome: true } },
        },
      }),
      this.prisma.campanhaDestinatario.count({ where }),
    ]);
    return montarPagina(
      linhas.map((d) => ({
        id: d.id,
        contato: d.contato,
        destino: d.destino,
        status: d.status,
        motivo: d.motivo,
        canal: d.canal,
        conversaMensagemId: d.mensagemId,
        enviadoEm: iso(d.enviadoEm),
        entregueEm: iso(d.entregueEm),
        lidoEm: iso(d.lidoEm),
        respondeuEm: iso(d.respondeuEm),
        optOutEm: iso(d.optOutEm),
        falhouEm: iso(d.falhouEm),
      })),
      total,
      filtro,
    );
  }

  // -------------------------------------------------------------------------
  // Criar, editar, duplicar, excluir
  // -------------------------------------------------------------------------

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarCampanhaDto,
  ): Promise<CampanhaDto> {
    const tipoPublico = dto.tipoPublico ?? 'SEGMENTO';
    const modelo = dto.modeloId
      ? await this.carregarModelo(dto.modeloId, dto.canal)
      : null;
    const texto = dto.texto ?? modelo?.texto ?? '';
    const assunto = dto.assunto ?? modelo?.assunto ?? null;
    const arquivoId =
      dto.arquivoId !== undefined ? dto.arquivoId : (modelo?.arquivoId ?? null);
    this.validarTexto(texto, assunto);
    this.validarRitmo(dto);
    const janela = this.validarJanela(dto.janelaEnvio);
    if (arquivoId) {
      await this.validarArquivo(usuario, arquivoId);
    }
    if (tipoPublico === 'SEGMENTO' && dto.segmento) {
      await this.segmentos.validarParaUsuario(dto.segmento, usuario);
    }
    if (tipoPublico === 'IMPORTACAO' && dto.importacaoId) {
      await this.publico.validarOrigem({
        tipoPublico,
        segmento: null,
        importacaoId: dto.importacaoId,
      });
    }
    const canalIds = await this.validarCanais(dto.canal, dto.canalIds ?? []);
    const area = areaDaNovaCampanha(usuario, dto.area);

    const id = await this.prisma.$transaction(async (tx) => {
      await garantirSetorAtivoSeHouver(tx, area);
      const criada = await tx.campanha.create({
        data: {
          nome: dto.nome,
          descricao: dto.descricao ?? null,
          area,
          canal: dto.canal,
          tipoPublico,
          segmento:
            tipoPublico === 'SEGMENTO'
              ? ((dto.segmento ?? {
                  combinacao: 'todas',
                  condicoes: [],
                }) as Prisma.InputJsonObject)
              : undefined,
          importacaoId:
            tipoPublico === 'IMPORTACAO' ? (dto.importacaoId ?? null) : null,
          modeloId: modelo?.id ?? null,
          assunto,
          texto,
          arquivoId,
          intervaloMinimoSegundos: dto.intervaloMinimoSegundos ?? 20,
          intervaloMaximoSegundos: dto.intervaloMaximoSegundos ?? 60,
          loteTamanho: dto.loteTamanho ?? null,
          lotePausaSegundos: dto.lotePausaSegundos ?? null,
          simularDigitando: dto.simularDigitando ?? true,
          janelaEnvio: janela
            ? (janela as unknown as Prisma.InputJsonObject)
            : undefined,
          pausarAposFalhas: dto.pausarAposFalhas ?? 5,
          criadoPorId: usuario.id,
          canais: {
            create: canalIds.map((canalId, ordem) => ({ canalId, ordem })),
          },
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'campanha.criada',
        entidade: 'campanha',
        entidadeId: criada.id,
        resumo: `${usuario.nome} criou a campanha "${criada.nome}" (${criada.canal === 'WHATSAPP' ? 'WhatsApp' : 'e-mail'})`,
        dados: { canal: criada.canal, tipoPublico, regra: REGRA_DISPAROS },
      });
      return criada.id;
    });
    return this.carregarDto(usuario, id);
  }

  async atualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: AtualizarCampanhaDto,
  ): Promise<CampanhaDto> {
    const atual = await this.acesso.obter(usuario, id);
    if (!STATUS_QUE_EDITAM_RITMO.includes(atual.status)) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        atual.status === 'AGUARDANDO_APROVACAO'
          ? 'A campanha está esperando aprovação: peça ao líder para reprovar ou espere a decisão.'
          : 'Esta campanha não pode mais ser editada.',
        { motivo: 'status_invalido', status: atual.status },
      );
    }
    const mexeNoConteudo = [
      dto.tipoPublico,
      dto.segmento,
      dto.importacaoId,
      dto.modeloId,
      dto.assunto,
      dto.texto,
      dto.arquivoId,
    ].some((v) => v !== undefined);
    if (mexeNoConteudo && atual.status !== 'RASCUNHO') {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'Depois de iniciada, só o ritmo, a janela e os números podem mudar. Duplique a campanha para alterar o texto ou o público.',
        { motivo: 'conteudo_travado', status: atual.status },
      );
    }

    const modelo = dto.modeloId
      ? await this.carregarModelo(
          dto.modeloId,
          atual.canal as 'WHATSAPP' | 'EMAIL',
        )
      : null;
    const texto =
      dto.texto ??
      (modelo && dto.texto === undefined ? modelo.texto : atual.texto);
    const assunto =
      dto.assunto !== undefined
        ? dto.assunto
        : modelo
          ? (modelo.assunto ?? atual.assunto)
          : atual.assunto;
    const arquivoId =
      dto.arquivoId !== undefined
        ? dto.arquivoId
        : (modelo?.arquivoId ?? atual.arquivoId);
    if (dto.texto !== undefined || dto.assunto !== undefined || modelo) {
      this.validarTexto(texto, assunto);
    }
    this.validarRitmo({
      intervaloMinimoSegundos:
        dto.intervaloMinimoSegundos ?? atual.intervaloMinimoSegundos,
      intervaloMaximoSegundos:
        dto.intervaloMaximoSegundos ?? atual.intervaloMaximoSegundos,
      loteTamanho:
        dto.loteTamanho !== undefined ? dto.loteTamanho : atual.loteTamanho,
      lotePausaSegundos:
        dto.lotePausaSegundos !== undefined
          ? dto.lotePausaSegundos
          : atual.lotePausaSegundos,
    });
    const janela =
      dto.janelaEnvio !== undefined
        ? this.validarJanela(dto.janelaEnvio)
        : undefined;
    if (dto.arquivoId) {
      await this.validarArquivo(usuario, dto.arquivoId);
    }
    const tipoPublico = dto.tipoPublico ?? atual.tipoPublico;
    if (dto.segmento) {
      await this.segmentos.validarParaUsuario(dto.segmento, usuario);
    }
    if (tipoPublico === 'IMPORTACAO' && dto.importacaoId) {
      await this.publico.validarOrigem({
        tipoPublico,
        segmento: null,
        importacaoId: dto.importacaoId,
      });
    }
    const canalIds = dto.canalIds
      ? await this.validarCanais(
          atual.canal as 'WHATSAPP' | 'EMAIL',
          dto.canalIds,
        )
      : null;

    const dados: Prisma.CampanhaUpdateInput = {};
    if (dto.nome !== undefined) dados.nome = dto.nome;
    if (dto.descricao !== undefined) dados.descricao = dto.descricao;
    if (dto.tipoPublico !== undefined) dados.tipoPublico = dto.tipoPublico;
    if (dto.segmento !== undefined) {
      dados.segmento = (dto.segmento ?? undefined) as
        Prisma.InputJsonObject | undefined;
    }
    if (
      tipoPublico === 'SEGMENTO' &&
      dto.importacaoId === undefined &&
      dto.tipoPublico !== undefined
    ) {
      dados.importacao = { disconnect: true };
    }
    if (dto.importacaoId !== undefined) {
      dados.importacao = dto.importacaoId
        ? { connect: { id: dto.importacaoId } }
        : { disconnect: true };
    }
    if (dto.modeloId !== undefined) {
      dados.modelo = dto.modeloId
        ? { connect: { id: dto.modeloId } }
        : { disconnect: true };
    }
    if (dto.texto !== undefined || modelo) dados.texto = texto;
    if (dto.assunto !== undefined || modelo) dados.assunto = assunto;
    if (dto.arquivoId !== undefined || modelo) {
      dados.arquivo = arquivoId
        ? { connect: { id: arquivoId } }
        : { disconnect: true };
    }
    if (dto.intervaloMinimoSegundos !== undefined)
      dados.intervaloMinimoSegundos = dto.intervaloMinimoSegundos;
    if (dto.intervaloMaximoSegundos !== undefined)
      dados.intervaloMaximoSegundos = dto.intervaloMaximoSegundos;
    if (dto.loteTamanho !== undefined) dados.loteTamanho = dto.loteTamanho;
    if (dto.lotePausaSegundos !== undefined)
      dados.lotePausaSegundos = dto.lotePausaSegundos;
    if (dto.simularDigitando !== undefined)
      dados.simularDigitando = dto.simularDigitando;
    if (dto.pausarAposFalhas !== undefined)
      dados.pausarAposFalhas = dto.pausarAposFalhas;
    if (dto.janelaEnvio !== undefined) {
      dados.janelaEnvio = janela
        ? (janela as unknown as Prisma.InputJsonObject)
        : Prisma.DbNull;
    }

    await this.prisma.$transaction(async (tx) => {
      const depois = await tx.campanha.update({ where: { id }, data: dados });
      if (canalIds) {
        await tx.campanhaCanal.deleteMany({ where: { campanhaId: id } });
        await tx.campanhaCanal.createMany({
          data: canalIds.map((canalId, ordem) => ({
            campanhaId: id,
            canalId,
            ordem,
          })),
        });
        await tx.campanha.update({
          where: { id },
          data: { ultimoCanalId: null },
        });
      }
      const alteracoes = calcularAlteracoes(atual, depois, CAMPOS_AUDITADOS);
      if (Object.keys(alteracoes).length > 0 || canalIds) {
        await this.auditoria.registrar(tx, {
          acao: 'campanha.atualizada',
          entidade: 'campanha',
          entidadeId: id,
          resumo: `${usuario.nome} alterou a campanha "${depois.nome}"`,
          dados: {
            alteracoes,
            canaisAlterados: canalIds !== null,
            regra: REGRA_DISPAROS,
          },
        });
      }
    });
    return this.carregarDto(usuario, id);
  }

  async duplicar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<CampanhaDto> {
    const origem = await this.acesso.obter(usuario, id);
    const canais = await this.prisma.campanhaCanal.findMany({
      where: { campanhaId: id },
      orderBy: { ordem: 'asc' },
    });
    const novoId = await this.prisma.$transaction(async (tx) => {
      const copia = await tx.campanha.create({
        data: {
          nome: `${origem.nome} (cópia)`.slice(0, 150),
          descricao: origem.descricao,
          area: areaDaNovaCampanha(usuario, origem.area),
          canal: origem.canal,
          tipoPublico: origem.tipoPublico,
          segmento: (origem.segmento ?? undefined) as
            Prisma.InputJsonObject | undefined,
          importacaoId: origem.importacaoId,
          modeloId: origem.modeloId,
          assunto: origem.assunto,
          texto: origem.texto,
          arquivoId: origem.arquivoId,
          intervaloMinimoSegundos: origem.intervaloMinimoSegundos,
          intervaloMaximoSegundos: origem.intervaloMaximoSegundos,
          loteTamanho: origem.loteTamanho,
          lotePausaSegundos: origem.lotePausaSegundos,
          simularDigitando: origem.simularDigitando,
          janelaEnvio: (origem.janelaEnvio ?? undefined) as
            Prisma.InputJsonObject | undefined,
          pausarAposFalhas: origem.pausarAposFalhas,
          campanhaOrigemId: origem.id,
          criadoPorId: usuario.id,
          canais: {
            create: canais.map((c) => ({ canalId: c.canalId, ordem: c.ordem })),
          },
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'campanha.duplicada',
        entidade: 'campanha',
        entidadeId: copia.id,
        resumo: `${usuario.nome} duplicou a campanha "${origem.nome}"`,
        dados: { origemId: origem.id, regra: REGRA_DISPAROS },
        relacionados: {},
      });
      return copia.id;
    });
    return this.carregarDto(usuario, novoId);
  }

  async excluir(usuario: UsuarioAutenticado, id: string): Promise<void> {
    const campanha = await this.acesso.obter(usuario, id);
    if (!['RASCUNHO', 'CANCELADA', 'CONCLUIDA'].includes(campanha.status)) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'Só dá para excluir campanhas em rascunho, canceladas ou concluídas. Cancele antes.',
        { motivo: 'status_invalido', status: campanha.status },
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.campanha.update({
        where: { id },
        data: { excluidoEm: new Date() },
      });
      await this.auditoria.registrar(tx, {
        acao: 'campanha.excluida',
        entidade: 'campanha',
        entidadeId: id,
        resumo: `${usuario.nome} excluiu a campanha "${campanha.nome}"`,
        dados: { status: campanha.status, regra: REGRA_DISPAROS },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  async iniciar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: IniciarCampanhaDto,
  ): Promise<CampanhaDto> {
    const campanha = await this.acesso.obter(usuario, id);
    if (campanha.status !== 'RASCUNHO') {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'Só campanhas em rascunho podem ser iniciadas.',
        { motivo: 'status_invalido', status: campanha.status },
      );
    }
    const agendadaPara = dto.agendadaPara ? new Date(dto.agendadaPara) : null;
    if (agendadaPara && agendadaPara.getTime() < Date.now() - 60_000) {
      throw new DadosInvalidosException('A data do agendamento já passou.', {
        campos: [{ campo: 'agendadaPara', mensagens: ['deve ser no futuro'] }],
      });
    }
    const revisao = await this.revisar(usuario, id);
    const erros = revisao.problemas.filter((p) => p.gravidade === 'erro');
    if (erros.length > 0) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        `A campanha ainda não está pronta: ${erros[0]?.mensagem}`,
        { motivo: 'campanha_incompleta', problemas: erros },
      );
    }
    const config = await this.configuracao.obter();
    if (config.aprovacaoDoLider && !dispensaAprovacao(usuario)) {
      await this.ciclo.solicitarAprovacao(id, agendadaPara);
    } else {
      await this.ciclo.liberar(id, agendadaPara);
    }
    return this.carregarDto(usuario, id);
  }

  async aprovar(usuario: UsuarioAutenticado, id: string): Promise<CampanhaDto> {
    const campanha = await this.acesso.obter(usuario, id);
    this.exigirAprovador(usuario, campanha);
    const liberada = await this.ciclo.liberar(
      id,
      campanha.agendadaPara,
      usuario.id,
    );
    await this.ciclo.avisarAprovacao(liberada, usuario.nome);
    return this.carregarDto(usuario, id);
  }

  async reprovar(
    usuario: UsuarioAutenticado,
    id: string,
    motivo: string,
  ): Promise<CampanhaDto> {
    const campanha = await this.acesso.obter(usuario, id);
    this.exigirAprovador(usuario, campanha);
    await this.ciclo.reprovar(id, motivo);
    return this.carregarDto(usuario, id);
  }

  async pausar(
    usuario: UsuarioAutenticado,
    id: string,
    motivo?: string,
  ): Promise<CampanhaDto> {
    await this.acesso.obter(usuario, id);
    await this.ciclo.pausar(id, motivo ?? null, false);
    return this.carregarDto(usuario, id);
  }

  async retomar(usuario: UsuarioAutenticado, id: string): Promise<CampanhaDto> {
    await this.acesso.obter(usuario, id);
    await this.ciclo.retomar(id);
    return this.carregarDto(usuario, id);
  }

  async cancelar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<CampanhaDto> {
    await this.acesso.obter(usuario, id);
    await this.ciclo.cancelar(id);
    return this.carregarDto(usuario, id);
  }

  async reenviarFalhas(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<{ campanha: CampanhaDto; reenfileirados: number }> {
    await this.acesso.obter(usuario, id);
    const { reenfileirados } = await this.ciclo.reabrirParaReenvio(id);
    return { campanha: await this.carregarDto(usuario, id), reenfileirados };
  }

  // -------------------------------------------------------------------------
  // Revisão, prévia, estimativa, teste
  // -------------------------------------------------------------------------

  async revisar(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<RevisaoDaCampanha> {
    const campanha = await this.acesso.obter(usuario, id);
    const agora = new Date();
    const problemas: ProblemaDaRevisao[] = [];
    const canais = await this.canais.listar(id);
    const infoCanais = canais.map((canal) => {
      const numero = canal.whatsappNumero;
      let motivo: string | null = null;
      if (!canal.ativo || canal.excluidoEm) motivo = 'Canal desativado.';
      else if (campanha.canal === 'WHATSAPP') {
        if (!numero) motivo = 'Sem número configurado.';
        else if (numero.status !== 'CONECTADO') motivo = 'Número desconectado.';
        else if (numero.pausadoEm) motivo = 'Número pausado.';
      }
      return {
        id: canal.id,
        nome: canal.nome,
        telefone: numero?.telefone ?? null,
        disponivel: motivo === null,
        motivo,
        limiteDoDia: numero ? limiteDoDia(numero, agora) : null,
      };
    });
    if (canais.length === 0) {
      problemas.push({
        gravidade: 'erro',
        campo: 'canalIds',
        mensagem:
          campanha.canal === 'WHATSAPP'
            ? 'Escolha ao menos um número de WhatsApp.'
            : 'Escolha ao menos uma caixa de e-mail.',
      });
    } else if (infoCanais.every((c) => !c.disponivel)) {
      problemas.push({
        gravidade: 'aviso',
        campo: 'canalIds',
        mensagem:
          'Nenhum dos canais está disponível agora; o envio só avança quando algum voltar.',
      });
    }
    if (campanha.texto.trim() === '' && !campanha.arquivoId) {
      problemas.push({
        gravidade: 'erro',
        campo: 'texto',
        mensagem: 'Escreva a mensagem ou anexe uma mídia.',
      });
    }
    if (campanha.canal === 'EMAIL' && !(campanha.assunto ?? '').trim()) {
      problemas.push({
        gravidade: 'erro',
        campo: 'assunto',
        mensagem: 'Informe o assunto do e-mail.',
      });
    }
    if (
      campanha.tipoPublico === 'SEGMENTO' &&
      Array.isArray(
        (campanha.segmento as { condicoes?: unknown } | null)?.condicoes,
      ) &&
      (campanha.segmento as { condicoes: unknown[] }).condicoes.length === 0
    ) {
      problemas.push({
        gravidade: 'aviso',
        campo: 'segmento',
        mensagem:
          'O segmento não tem filtros: a campanha vai para todos os contatos.',
      });
    }
    const validacao = validarModelo(campanha.texto);
    for (const erro of validacao.erros) {
      problemas.push({
        gravidade: 'erro',
        campo: 'texto',
        mensagem: erro.mensagem,
      });
    }
    if (campanha.janelaEnvio) {
      const janela = situacaoDaJanela(campanha.janelaEnvio, agora);
      if (!janela.aberta && !janela.proximaAbertura) {
        problemas.push({
          gravidade: 'erro',
          campo: 'janelaEnvio',
          mensagem:
            'A janela de envio nunca abre nos próximos dias. Revise os dias e horários.',
        });
      }
    }
    let publico: PreviaDoPublico = {
      total: 0,
      elegiveis: 0,
      semDestino: 0,
      optOutExcluidos: 0,
      amostra: [],
    };
    try {
      publico = await this.publico.previa(campanha);
      if (publico.elegiveis === 0) {
        problemas.push({
          gravidade: 'erro',
          campo: 'segmento',
          mensagem:
            'O público está vazio: nenhum contato com ' +
            (campanha.canal === 'WHATSAPP' ? 'telefone' : 'e-mail') +
            ' e sem opt-out.',
        });
      }
      if (publico.semDestino > 0) {
        problemas.push({
          gravidade: 'aviso',
          campo: 'segmento',
          mensagem: `${publico.semDestino} contatos ficam de fora por não terem ${campanha.canal === 'WHATSAPP' ? 'telefone' : 'e-mail'}.`,
        });
      }
    } catch (erro) {
      if (
        erro instanceof DadosInvalidosException ||
        erro instanceof NaoEncontradoException
      ) {
        problemas.push({
          gravidade: 'erro',
          campo: 'segmento',
          mensagem: erro.message,
        });
      } else {
        throw erro;
      }
    }
    const estimativa = this.estimar(
      campanha.canal,
      publico.elegiveis,
      canais,
      campanha,
      campanha.janelaEnvio,
      agora,
    );
    if (estimativa.dias > 7) {
      problemas.push({
        gravidade: 'aviso',
        campo: 'canalIds',
        mensagem: `Com este ritmo e os limites dos números, o envio leva cerca de ${estimativa.dias} dias. Considere mais números ou outro ritmo.`,
      });
    }
    const previa = await this.renderizarPrevia(
      campanha,
      publico.amostra[0]?.id,
    );
    const config = await this.configuracao.obter();
    return {
      campanhaId: id,
      publico,
      estimativa,
      canais: infoCanais,
      previa,
      problemas,
      podeIniciar:
        campanha.status === 'RASCUNHO' &&
        !problemas.some((p) => p.gravidade === 'erro'),
      exigeAprovacao: config.aprovacaoDoLider && !dispensaAprovacao(usuario),
    };
  }

  async previaDaMensagem(
    usuario: UsuarioAutenticado,
    id: string,
    dto: PreviaDaMensagemDto,
  ) {
    const campanha = await this.acesso.obter(usuario, id);
    return this.renderizarPrevia(campanha, dto.contatoId);
  }

  async previaDoPublico(
    usuario: UsuarioAutenticado,
    dto: PreviaDoPublicoDto,
  ): Promise<PreviaDoPublico> {
    return this.publico.previa(
      {
        canal: dto.canal,
        tipoPublico: dto.tipoPublico ?? 'SEGMENTO',
        segmento: (dto.segmento ?? null) as Prisma.JsonValue,
        importacaoId: dto.importacaoId ?? null,
      },
      usuario,
    );
  }

  async estimativa(_usuario: UsuarioAutenticado, dto: EstimativaDto) {
    const canais = dto.canalIds?.length
      ? await this.prisma.canal.findMany({
          where: { id: { in: dto.canalIds }, excluidoEm: null },
          include: { whatsappNumero: true },
        })
      : [];
    const janela = this.validarJanela(dto.janelaEnvio);
    return this.estimar(
      dto.canal,
      dto.total,
      canais,
      {
        intervaloMinimoSegundos: dto.ritmo?.intervaloMinimoSegundos ?? 20,
        intervaloMaximoSegundos: dto.ritmo?.intervaloMaximoSegundos ?? 60,
        loteTamanho: dto.ritmo?.loteTamanho ?? null,
        lotePausaSegundos: dto.ritmo?.lotePausaSegundos ?? null,
      },
      janela,
      dto.inicio ? new Date(dto.inicio) : new Date(),
    );
  }

  /** Envia a mensagem da campanha, uma vez, para o próprio número (ou o informado). */
  async enviarTeste(
    usuario: UsuarioAutenticado,
    id: string,
    dto: EnvioDeTesteDto,
  ) {
    const campanha = await this.acesso.obter(usuario, id);
    if (['CANCELADA', 'CONCLUIDA'].includes(campanha.status)) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'Esta campanha já terminou.',
        { motivo: 'status_invalido' },
      );
    }
    if (campanha.texto.trim() === '' && !campanha.arquivoId) {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'Escreva a mensagem antes de enviar um teste.',
        { motivo: 'sem_mensagem' },
      );
    }
    const dono = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuario.id },
      select: { nome: true, email: true, telefone: true },
    });
    let telefone: string | undefined;
    let email: string | undefined;
    if (!dto.contatoId) {
      if (campanha.canal === 'WHATSAPP') {
        const bruto = dto.telefone ?? dono.telefone ?? '';
        const normalizado = bruto ? normalizarTelefone(bruto) : null;
        if (!normalizado?.valido) {
          throw new RegraVioladaException(
            REGRA_DISPAROS,
            bruto
              ? `O telefone de teste não é válido: ${normalizado?.valido === false ? normalizado.motivo : ''}`
              : 'Informe o telefone de teste (o seu usuário não tem telefone cadastrado).',
            { motivo: 'sem_destino' },
          );
        }
        telefone = normalizado.telefone;
      } else {
        email = (dto.email ?? dono.email).toLowerCase();
      }
    }
    const escolha = await this.canais.escolher(campanha, new Date(), {
      ignorarLimite: true,
    });
    if (escolha.tipo !== 'canal') {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        `Nenhum canal da campanha está disponível para o teste: ${escolha.motivo}`,
        { motivo: 'sem_canal' },
      );
    }
    const arquivo = campanha.arquivoId
      ? await this.prisma.arquivo.findFirst({
          where: { id: campanha.arquivoId, removidoEm: null },
          select: { id: true, mime: true },
        })
      : null;
    const resultado = await executarComoAtor(
      { tipoAtor: 'AUTOMACAO', descricao: campanha.nome },
      () =>
        this.prisma.$transaction(async (tx) => {
          let contatoId = dto.contatoId;
          if (contatoId) {
            const existe = await tx.contato.findFirst({
              where: { id: contatoId, excluidoEm: null },
              select: { id: true },
            });
            if (!existe) {
              throw new NaoEncontradoException('Contato não encontrado.');
            }
          } else {
            const { contato } = await this.contatos.encontrarOuCriar(tx, {
              nome: `Teste de campanha (${dono.nome})`,
              ...(telefone ? { telefone } : {}),
              ...(email ? { email } : {}),
              origem: 'MANUAL',
              origemDetalhe: 'Teste de campanha',
              etiquetas: ['teste-de-campanha'],
            });
            contatoId = contato.id;
          }
          const entregue = await this.entrega.entregar(tx, {
            campanha,
            canal: escolha.canal,
            contatoId,
            semente: contatoId,
            arquivo,
            teste: true,
          });
          return { ...entregue, contatoId };
        }),
    );
    await this.prisma.$transaction((tx) =>
      this.auditoria.registrar(tx, {
        acao: 'campanha.teste_enviado',
        entidade: 'campanha',
        entidadeId: id,
        resumo: `${usuario.nome} enviou um teste da campanha "${campanha.nome}"`,
        dados: { contatoId: resultado.contatoId, regra: REGRA_DISPAROS },
        relacionados: { contato: resultado.contatoId },
      }),
    );
    return {
      conversaId: resultado.conversaId,
      mensagemId: resultado.mensagemId,
      texto: resultado.texto,
    };
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private exigirAprovador(
    usuario: UsuarioAutenticado,
    campanha: Campanha,
  ): void {
    if (!podeAprovarCampanha(usuario, campanha)) {
      throw new SemPermissaoException(
        'Só o líder da área, o C-level ou o Admin decidem a aprovação.',
      );
    }
    if (campanha.status !== 'AGUARDANDO_APROVACAO') {
      throw new RegraVioladaException(
        REGRA_DISPAROS,
        'A campanha não está esperando aprovação.',
        {
          motivo: 'status_invalido',
          status: campanha.status,
        },
      );
    }
  }

  private async renderizarPrevia(
    campanha: Pick<Campanha, 'texto' | 'assunto' | 'canal'>,
    contatoId?: string,
  ): Promise<{ texto: string; assunto: string | null; erros: string[] }> {
    const alvo = contatoId ? { contatoId } : {};
    const texto = await this.modelos.renderizarPara(campanha.texto, alvo, {
      semente: contatoId ?? 'previa',
    });
    const assunto =
      campanha.canal === 'EMAIL' && campanha.assunto
        ? await this.modelos.renderizarPara(campanha.assunto, alvo, {
            semente: contatoId ?? 'previa',
          })
        : null;
    return {
      texto: texto.texto,
      assunto: assunto?.texto ?? null,
      erros: [...texto.erros, ...(assunto?.erros ?? [])].map((e) => e.mensagem),
    };
  }

  private estimar(
    canal: string,
    total: number,
    canais: Array<{
      whatsappNumero:
        | (Parameters<typeof limiteDoDia>[0] & {
            intervaloMinimoSegundos: number;
            intervaloMaximoSegundos: number;
          })
        | null;
    }>,
    ritmo: Pick<
      Campanha,
      | 'intervaloMinimoSegundos'
      | 'intervaloMaximoSegundos'
      | 'loteTamanho'
      | 'lotePausaSegundos'
    >,
    janela: unknown,
    inicio: Date,
  ): Estimativa & { limiteDiarioTotal: number | null } {
    const numeros =
      canal === 'WHATSAPP' ? canais.map((c) => c.whatsappNumero) : [];
    const limites = numeros.map((n) => (n ? limiteDoDia(n, inicio) : null));
    const estimativa = estimarDuracao({
      total,
      ritmo,
      pisos: numeros.map((n) =>
        n
          ? {
              intervaloMinimoSegundos: n.intervaloMinimoSegundos,
              intervaloMaximoSegundos: n.intervaloMaximoSegundos,
            }
          : null,
      ),
      limitesDoDia: canal === 'WHATSAPP' ? limites : [],
      janela,
      inicio,
    });
    const todosComLimite =
      limites.length > 0 && limites.every((l) => l !== null);
    return {
      ...estimativa,
      limiteDiarioTotal: todosComLimite
        ? limites.reduce<number>((s, l) => s + (l ?? 0), 0)
        : null,
    };
  }

  private validarTexto(texto: string, assunto: string | null): void {
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

  private validarRitmo(r: {
    intervaloMinimoSegundos?: number;
    intervaloMaximoSegundos?: number;
    loteTamanho?: number | null;
    lotePausaSegundos?: number | null;
  }): void {
    const campos: Array<{ campo: string; mensagens: string[] }> = [];
    const minimo = r.intervaloMinimoSegundos ?? 20;
    const maximo = r.intervaloMaximoSegundos ?? 60;
    if (minimo > maximo) {
      campos.push({
        campo: 'intervaloMaximoSegundos',
        mensagens: ['deve ser maior ou igual ao mínimo'],
      });
    }
    if ((r.loteTamanho == null) !== (r.lotePausaSegundos == null)) {
      campos.push({
        campo: 'lotePausaSegundos',
        mensagens: [
          'informe o tamanho do lote e a pausa juntos (ou nenhum dos dois)',
        ],
      });
    }
    if (campos.length > 0) {
      throw new DadosInvalidosException(
        `Ritmo inválido — ${campos[0]?.campo}: ${campos[0]?.mensagens[0]}`,
        { campos },
      );
    }
  }

  private validarJanela(
    janela: Record<string, unknown> | null | undefined,
  ): unknown {
    if (janela === null || janela === undefined) {
      return null;
    }
    const resultado = validarHorario(janela);
    if ('erros' in resultado && resultado.erros) {
      throw new DadosInvalidosException(
        `Janela de envio inválida: ${resultado.erros[0]}`,
        {
          campos: resultado.erros.map((mensagem) => ({
            campo: 'janelaEnvio',
            mensagens: [mensagem],
          })),
        },
      );
    }
    return resultado.horario;
  }

  private async validarArquivo(
    usuario: UsuarioAutenticado,
    arquivoId: string,
  ): Promise<void> {
    const arquivo = await this.prisma.arquivo.findFirst({
      where: { id: arquivoId, removidoEm: null },
    });
    if (!arquivo || !(await this.arquivos.podeLer(usuario, arquivo))) {
      throw new DadosInvalidosException('Mídia não encontrada.', {
        campos: [{ campo: 'arquivoId', mensagens: ['arquivo não encontrado'] }],
      });
    }
    if (arquivo.contexto !== 'CAMPANHA') {
      throw new DadosInvalidosException(
        'Este arquivo não foi enviado como mídia de campanha.',
        {
          campos: [
            { campo: 'arquivoId', mensagens: ['envie com contexto=CAMPANHA'] },
          ],
        },
      );
    }
  }

  private async validarCanais(
    canal: 'WHATSAPP' | 'EMAIL',
    ids: string[],
  ): Promise<string[]> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) {
      return [];
    }
    const encontrados = await this.prisma.canal.findMany({
      where: { id: { in: unicos }, excluidoEm: null },
      select: { id: true, tipo: true },
    });
    if (encontrados.length !== unicos.length) {
      throw new DadosInvalidosException(
        'Algum dos canais não foi encontrado.',
        {
          campos: [{ campo: 'canalIds', mensagens: ['canal não encontrado'] }],
        },
      );
    }
    if (encontrados.some((c) => c.tipo !== canal)) {
      throw new DadosInvalidosException(
        `Escolha só canais de ${canal === 'WHATSAPP' ? 'WhatsApp' : 'e-mail'}.`,
        { campos: [{ campo: 'canalIds', mensagens: ['canal de outro tipo'] }] },
      );
    }
    return unicos;
  }

  private async carregarModelo(modeloId: string, canal: 'WHATSAPP' | 'EMAIL') {
    const modelo = await this.prisma.modeloMensagem.findFirst({
      where: { id: modeloId, excluidoEm: null },
    });
    if (!modelo) {
      throw new DadosInvalidosException('Modelo de mensagem não encontrado.', {
        campos: [{ campo: 'modeloId', mensagens: ['modelo não encontrado'] }],
      });
    }
    if (modelo.canal && modelo.canal !== canal) {
      throw new DadosInvalidosException('Este modelo é de outro canal.', {
        campos: [{ campo: 'modeloId', mensagens: ['modelo de outro canal'] }],
      });
    }
    return modelo;
  }

  private async carregarDto(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<CampanhaDto> {
    const campanha = await this.prisma.campanha.findFirstOrThrow({
      where: { id, excluidoEm: null },
      include: INCLUIR,
    });
    const contadores = await this.progresso.contar(this.prisma, id);
    return this.paraDto(usuario, campanha, contadores);
  }

  private paraDto(
    usuario: UsuarioAutenticado,
    c: CampanhaCompleta,
    contadores = {
      total: 0,
      pendentes: 0,
      enviando: 0,
      enviados: 0,
      entregues: 0,
      lidos: 0,
      respondidos: 0,
      falhas: 0,
      invalidos: 0,
      excluidos: 0,
      optOuts: 0,
    },
  ): CampanhaDto {
    const agora = new Date();
    let aguardando: AguardandoDaCampanha | null = null;
    if (c.status === 'EM_ANDAMENTO') {
      const janela = situacaoDaJanela(c.janelaEnvio, agora);
      if (!janela.aberta) {
        aguardando = {
          motivo: 'janela_de_envio',
          ate: iso(janela.proximaAbertura),
        };
      } else if (contadores.pendentes === 0 && contadores.enviando > 0) {
        aguardando = { motivo: 'confirmacoes', ate: iso(c.proximoEnvioEm) };
      } else if (c.proximoEnvioEm && c.proximoEnvioEm > agora) {
        aguardando = { motivo: 'intervalo', ate: iso(c.proximoEnvioEm) };
      }
    }
    const gerencia = true; // `acesso.obter` já barrou quem não vê/gerencia
    const aprovador = podeAprovarCampanha(usuario, c);
    const acoes: AcoesDaCampanha = {
      editar: gerencia && STATUS_QUE_EDITAM_RITMO.includes(c.status),
      editarConteudo: gerencia && c.status === 'RASCUNHO',
      iniciar: gerencia && c.status === 'RASCUNHO',
      aprovar: aprovador && c.status === 'AGUARDANDO_APROVACAO',
      reprovar: aprovador && c.status === 'AGUARDANDO_APROVACAO',
      pausar: gerencia && c.status === 'EM_ANDAMENTO',
      retomar: gerencia && c.status === 'PAUSADA',
      cancelar:
        gerencia &&
        [
          'RASCUNHO',
          'AGUARDANDO_APROVACAO',
          'AGENDADA',
          'EM_ANDAMENTO',
          'PAUSADA',
        ].includes(c.status),
      reenviarFalhas:
        gerencia &&
        ['EM_ANDAMENTO', 'PAUSADA', 'CONCLUIDA'].includes(c.status) &&
        contadores.falhas > 0,
      excluir:
        gerencia && ['RASCUNHO', 'CANCELADA', 'CONCLUIDA'].includes(c.status),
      duplicar: gerencia,
    };
    return {
      id: c.id,
      nome: c.nome,
      descricao: c.descricao,
      area: c.area,
      canal: c.canal as 'WHATSAPP' | 'EMAIL',
      status: c.status,
      tipoPublico: c.tipoPublico,
      segmento: c.segmento,
      importacaoId: c.importacaoId,
      modeloId: c.modeloId,
      assunto: c.assunto,
      texto: c.texto,
      arquivo: c.arquivo ? ArquivoDto.de(c.arquivo) : null,
      ritmo: {
        intervaloMinimoSegundos: c.intervaloMinimoSegundos,
        intervaloMaximoSegundos: c.intervaloMaximoSegundos,
        loteTamanho: c.loteTamanho,
        lotePausaSegundos: c.lotePausaSegundos,
        simularDigitando: c.simularDigitando,
        pausarAposFalhas: c.pausarAposFalhas,
      },
      janelaEnvio: c.janelaEnvio,
      agendadaPara: iso(c.agendadaPara),
      iniciadaEm: iso(c.iniciadaEm),
      pausadaEm: iso(c.pausadaEm),
      pausaMotivo: c.pausaMotivo,
      concluidaEm: iso(c.concluidaEm),
      canceladaEm: iso(c.canceladaEm),
      aprovacao: {
        solicitadaEm: iso(c.aprovacaoSolicitadaEm),
        aprovadaEm: iso(c.aprovadaEm),
        aprovadaPor: c.aprovadaPor,
        reprovacaoMotivo: c.reprovacaoMotivo,
      },
      proximoEnvioEm: iso(c.proximoEnvioEm),
      aguardando,
      canais: c.canais.map((l) => ({
        id: l.canal.id,
        nome: l.canal.nome,
        tipo: l.canal.tipo,
        ordem: l.ordem,
        telefone: l.canal.whatsappNumero?.telefone ?? null,
        statusDoNumero: l.canal.whatsappNumero?.status ?? null,
        numeroPausado: l.canal.whatsappNumero?.pausadoEm != null,
      })),
      contadores,
      progresso: progressoDe(contadores),
      campanhaOrigemId: c.campanhaOrigemId,
      criadoPor: c.criadoPor,
      criadoEm: c.criadoEm.toISOString(),
      atualizadoEm: c.atualizadoEm.toISOString(),
      acoes,
    };
  }
}

export type { CampanhaResumoDto };
