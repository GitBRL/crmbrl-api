import { Inject, Injectable } from '@nestjs/common';
import { AuditoriaService } from '../../auditoria/auditoria.service';
import type { UsuarioAutenticado } from '../../auth/usuario-autenticado';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import {
  ConflitoException,
  DadosInvalidosException,
  NaoEncontradoException,
  RegraVioladaException,
} from '../../comum/erros/excecoes';
import {
  montarPagina,
  type Pagina,
  paraSkipTake,
} from '../../comum/paginacao/paginacao';
import {
  type ProblemaDeCampo,
  resumirProblemas,
} from '../../comum/validacao/validacao';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import {
  EVENTOS_DE_WEBHOOK,
  type EventoDeWebhook,
} from '../../eventos/tipos-eventos';
import type { Prisma, WebhookSaida } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../prisma/prisma.service';
import { travarChave } from '../../prisma/travas';
import { UsuarioDoWebhookDto } from '../dto-comum';
import type { FiltroWebhooksDto } from '../entrada/dto/webhook-entrada.dto';
import { BYTES_DO_SEGREDO, TRAVA_NOME_SAIDA } from '../webhooks.constantes';
import {
  type CabecalhosExtras,
  juntarCabecalhos,
  validarCabecalhos,
} from './cabecalhos-extras';
import type {
  AtualizarWebhookSaidaDto,
  CriarWebhookSaidaDto,
  EventoDisponivelDto,
  WebhookSaidaComSegredoDto,
  WebhookSaidaDto,
} from './dto/webhook-saida.dto';
import { verificarDestino } from './protecao-ssrf';

/** O que cada evento significa (R9.2), para a tela de configuração. */
const DESCRICAO_DOS_EVENTOS: Readonly<Record<EventoDeWebhook, string>> = {
  'contato.criado':
    'Contato criado (cadastro manual, webhook de entrada, importação).',
  'contato.atualizado':
    'Contato alterado (edição, reconversão, responsável definido, anonimização).',
  'negocio.criado': 'Negócio criado (manual, por automação ou por passagem).',
  'negocio.movido': 'Negócio mudou de etapa.',
  'negocio.ganho': 'Negócio ganho.',
  'negocio.perdido': 'Negócio perdido, com o motivo.',
  'atividade.criada': 'Atividade criada.',
  'atividade.concluida': 'Atividade concluída.',
  'usuario.desligado':
    'Usuário desligado, com quem recebeu os itens e as contagens.',
  'webhook.teste':
    'Evento de teste disparado pelo Admin (sempre entregue ao destino testado).',
};

const CAMPOS_AUDITADOS = ['nome', 'eventos', 'ativo'] as const;

type WebhookSaidaComCriador = WebhookSaida & {
  criadoPor: { id: string; nome: string } | null;
};

/**
 * Destinos dos webhooks de saída (R9.1), só para o Admin (§12): URL com
 * proteção contra SSRF, eventos assinados (R9.2), cabeçalhos extras e o
 * segredo das assinaturas, gerado pelo sistema e mostrado uma vez (os dois
 * cifrados, R10.3). Toda alteração vai numa transação com a auditoria (R3.1).
 */
@Injectable()
export class WebhooksSaidaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaService,
    private readonly cripto: CriptografiaService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  eventosDisponiveis(): EventoDisponivelDto[] {
    return EVENTOS_DE_WEBHOOK.map((evento) => ({
      evento,
      descricao: DESCRICAO_DOS_EVENTOS[evento],
    }));
  }

  async listar(filtro: FiltroWebhooksDto): Promise<Pagina<WebhookSaidaDto>> {
    const where: Prisma.WebhookSaidaWhereInput = {
      excluidoEm: null,
      ...(filtro.ativo === undefined ? {} : { ativo: filtro.ativo }),
      ...(filtro.busca
        ? { nome: { contains: filtro.busca, mode: 'insensitive' } }
        : {}),
    };
    const [destinos, total] = await Promise.all([
      this.prisma.webhookSaida.findMany({
        where,
        include: { criadoPor: { select: { id: true, nome: true } } },
        orderBy: [{ nome: 'asc' }, { id: 'asc' }],
        ...paraSkipTake(filtro),
      }),
      this.prisma.webhookSaida.count({ where }),
    ]);
    const contagens = await this.contarEntregas(destinos.map(({ id }) => id));
    return montarPagina(
      destinos.map((destino) => this.paraDto(destino, contagens)),
      total,
      filtro,
    );
  }

  async detalhar(id: string): Promise<WebhookSaidaDto> {
    const destino = await this.prisma.webhookSaida.findFirst({
      where: { id, excluidoEm: null },
      include: { criadoPor: { select: { id: true, nome: true } } },
    });
    if (!destino) {
      throw new NaoEncontradoException('Webhook de saída não encontrado.');
    }
    return this.paraDto(destino, await this.contarEntregas([id]));
  }

  async criar(
    usuario: UsuarioAutenticado,
    dto: CriarWebhookSaidaDto,
  ): Promise<WebhookSaidaComSegredoDto> {
    const url = await this.verificarUrl(dto.url);
    const cabecalhos = this.lerCabecalhosDaEntrada(dto.cabecalhos ?? {});
    const segredo = this.cripto.gerarToken(BYTES_DO_SEGREDO);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.garantirNomeLivre(tx, dto.nome);
      const destino = await tx.webhookSaida.create({
        data: {
          nome: dto.nome,
          url,
          eventos: [...dto.eventos],
          segredoCifrado: this.cripto.cifrar(segredo),
          cabecalhosCifrados: this.cifrarCabecalhos(cabecalhos),
          ativo: dto.ativo ?? true,
          criadoPorId: usuario.id,
        },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_saida.criado',
        entidade: 'webhook_saida',
        entidadeId: destino.id,
        resumo: `Webhook de saída "${destino.nome}" criado para ${new URL(url).host}`,
        dados: {
          destino: mascararUrl(url),
          eventos: destino.eventos,
          ativo: destino.ativo,
          cabecalhosExtras: Object.keys(cabecalhos),
        },
      });
      return destino.id;
    });
    return { webhook: await this.detalhar(id), segredo };
  }

  async atualizar(
    id: string,
    dto: AtualizarWebhookSaidaDto,
  ): Promise<WebhookSaidaDto> {
    const url = dto.url !== undefined ? await this.verificarUrl(dto.url) : null;
    await this.prisma.$transaction(async (tx) => {
      const antes = await this.travarAtivo(tx, id);
      const dados: Prisma.WebhookSaidaUncheckedUpdateInput = {};
      if (dto.nome !== undefined && dto.nome !== antes.nome) {
        await this.garantirNomeLivre(tx, dto.nome, id);
        dados.nome = dto.nome;
      }
      if (url !== null) {
        dados.url = url;
      }
      if (dto.eventos !== undefined) {
        dados.eventos = [...dto.eventos];
      }
      const nomesAntes = Object.keys(this.lerCabecalhos(antes));
      let nomesDepois = nomesAntes;
      if (dto.cabecalhos !== undefined) {
        const novos =
          dto.cabecalhos === null
            ? {}
            : this.juntarComAtuais(antes, dto.cabecalhos);
        dados.cabecalhosCifrados = this.cifrarCabecalhos(novos);
        nomesDepois = Object.keys(novos);
      }
      if (dto.ativo !== undefined && dto.ativo !== antes.ativo) {
        dados.ativo = dto.ativo;
        if (dto.ativo) {
          // Reativar recomeça a contagem de falhas (R9.4).
          dados.falhasConsecutivas = 0;
          dados.desativadoAutomaticamenteEm = null;
        }
      }
      const depois = await tx.webhookSaida.update({
        where: { id },
        data: dados,
      });

      const alteracoes: Record<string, { antes: unknown; depois: unknown }> =
        {};
      for (const campo of CAMPOS_AUDITADOS) {
        if (JSON.stringify(antes[campo]) !== JSON.stringify(depois[campo])) {
          alteracoes[campo] = { antes: antes[campo], depois: depois[campo] };
        }
      }
      if (antes.url !== depois.url) {
        alteracoes.url = {
          antes: mascararUrl(antes.url),
          depois: mascararUrl(depois.url),
        };
      }
      if (dto.cabecalhos !== undefined) {
        alteracoes.cabecalhosExtras = {
          antes: nomesAntes,
          depois: nomesDepois,
        };
      }
      if (Object.keys(alteracoes).length > 0) {
        await this.auditoria.registrar(tx, {
          acao: 'webhook_saida.atualizado',
          entidade: 'webhook_saida',
          entidadeId: id,
          resumo:
            antes.ativo !== depois.ativo
              ? `Webhook de saída "${depois.nome}" ${depois.ativo ? 'reativado' : 'desativado'}`
              : `Webhook de saída "${depois.nome}" alterado`,
          dados: { alteracoes },
        });
      }
    });
    return this.detalhar(id);
  }

  /** Exclusão lógica: o destino não recebe mais eventos; o histórico das entregas fica. */
  async excluir(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const destino = await this.travarAtivo(tx, id);
      await tx.webhookSaida.update({
        where: { id },
        data: { excluidoEm: new Date(), ativo: false },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_saida.excluido',
        entidade: 'webhook_saida',
        entidadeId: id,
        resumo: `Webhook de saída "${destino.nome}" excluído`,
        dados: { destino: mascararUrl(destino.url) },
      });
    });
  }

  /** Segredo novo (R9.1): as assinaturas seguintes já usam o novo. */
  async regenerarSegredo(id: string): Promise<WebhookSaidaComSegredoDto> {
    const segredo = this.cripto.gerarToken(BYTES_DO_SEGREDO);
    await this.prisma.$transaction(async (tx) => {
      const destino = await this.travarAtivo(tx, id);
      await tx.webhookSaida.update({
        where: { id },
        data: { segredoCifrado: this.cripto.cifrar(segredo) },
      });
      await this.auditoria.registrar(tx, {
        acao: 'webhook_saida.segredo_regenerado',
        entidade: 'webhook_saida',
        entidadeId: id,
        resumo: `Segredo do webhook de saída "${destino.nome}" regenerado (as próximas entregas usam o novo)`,
      });
    });
    return { webhook: await this.detalhar(id), segredo };
  }

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  /** Cabeçalhos extras decifrados (vazio se não houver). Lança erro se o texto foi adulterado ou a chave mudou. */
  lerCabecalhos(
    destino: Pick<WebhookSaida, 'cabecalhosCifrados'>,
  ): CabecalhosExtras {
    if (!destino.cabecalhosCifrados) {
      return {};
    }
    const valor: unknown = JSON.parse(
      this.cripto.decifrar(destino.cabecalhosCifrados),
    );
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(valor).filter(
        (entrada): entrada is [string, string] =>
          typeof entrada[1] === 'string',
      ),
    );
  }

  private paraDto(
    destino: WebhookSaidaComCriador,
    contagens: ReadonlyMap<string, { pendentes: number; falhas: number }>,
  ): WebhookSaidaDto {
    let cabecalhos: CabecalhosExtras = {};
    try {
      cabecalhos = this.lerCabecalhos(destino);
    } catch {
      cabecalhos = {};
    }
    let segredoMascarado = '••••••••';
    try {
      segredoMascarado = this.cripto.mascarar(
        this.cripto.decifrar(destino.segredoCifrado),
      );
    } catch {
      // A chave de criptografia mudou: regenere o segredo.
    }
    return {
      id: destino.id,
      nome: destino.nome,
      url: destino.url,
      eventos: destino.eventos,
      cabecalhos: Object.entries(cabecalhos).map(([nome, valor]) => ({
        nome,
        valorMascarado: this.cripto.mascarar(valor),
      })),
      segredoMascarado,
      ativo: destino.ativo,
      falhasConsecutivas: destino.falhasConsecutivas,
      desativadoAutomaticamenteEm:
        destino.desativadoAutomaticamenteEm?.toISOString() ?? null,
      entregas: contagens.get(destino.id) ?? { pendentes: 0, falhas: 0 },
      criadoPor: UsuarioDoWebhookDto.de(destino.criadoPor),
      criadoEm: destino.criadoEm.toISOString(),
      atualizadoEm: destino.atualizadoEm.toISOString(),
    };
  }

  private async contarEntregas(
    ids: readonly string[],
  ): Promise<Map<string, { pendentes: number; falhas: number }>> {
    const contagens = new Map<string, { pendentes: number; falhas: number }>();
    if (ids.length === 0) {
      return contagens;
    }
    const grupos = await this.prisma.webhookEntrega.groupBy({
      by: ['webhookId', 'status'],
      where: {
        webhookId: { in: [...ids] },
        status: { in: ['PENDENTE', 'FALHOU'] },
      },
      _count: { _all: true },
    });
    for (const grupo of grupos) {
      const atual = contagens.get(grupo.webhookId) ?? {
        pendentes: 0,
        falhas: 0,
      };
      if (grupo.status === 'PENDENTE') {
        atual.pendentes += grupo._count._all;
      } else {
        atual.falhas += grupo._count._all;
      }
      contagens.set(grupo.webhookId, atual);
    }
    return contagens;
  }

  /** R9.1: formato, HTTPS em produção e proteção contra SSRF. Devolve a URL normalizada. */
  private async verificarUrl(texto: string): Promise<string> {
    const resultado = await verificarDestino(texto, {
      producao: this.ambiente.producao,
      permitirRedeInterna: this.ambiente.webhooksPermitirRedeInterna,
    });
    if (resultado.permitido) {
      return resultado.url.toString();
    }
    const campos: ProblemaDeCampo[] = [
      { campo: 'url', mensagens: [resultado.mensagem] },
    ];
    if (resultado.motivo === 'formato') {
      throw new DadosInvalidosException(resultado.mensagem, { campos });
    }
    throw new RegraVioladaException('R9.1', resultado.mensagem, {
      motivo: resultado.motivo,
      campos,
    });
  }

  private lerCabecalhosDaEntrada(entrada: unknown): CabecalhosExtras {
    const resultado = validarCabecalhos(entrada);
    if (!resultado.validos) {
      throw new DadosInvalidosException(resumirProblemas(resultado.problemas), {
        campos: resultado.problemas,
      });
    }
    return resultado.cabecalhos;
  }

  private juntarComAtuais(
    antes: WebhookSaida,
    entrada: Record<string, string | null>,
  ): CabecalhosExtras {
    const resultado = validarCabecalhos(entrada, { permitirNulos: true });
    if (!resultado.validos) {
      throw new DadosInvalidosException(resumirProblemas(resultado.problemas), {
        campos: resultado.problemas,
      });
    }
    let atuais: CabecalhosExtras = {};
    try {
      atuais = this.lerCabecalhos(antes);
    } catch {
      // Ilegíveis (chave trocada): a atualização recomeça do que veio.
    }
    const juntos = juntarCabecalhos(
      atuais,
      resultado.cabecalhos,
      resultado.removidos,
    );
    return this.lerCabecalhosDaEntrada(juntos);
  }

  private cifrarCabecalhos(cabecalhos: CabecalhosExtras): string | null {
    return Object.keys(cabecalhos).length > 0
      ? this.cripto.cifrar(JSON.stringify(cabecalhos))
      : null;
  }

  private async travarAtivo(tx: Tx, id: string): Promise<WebhookSaida> {
    const [linha] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhooks_saida
       WHERE id = ${id}::uuid AND excluido_em IS NULL
         FOR UPDATE`;
    if (!linha) {
      throw new NaoEncontradoException('Webhook de saída não encontrado.');
    }
    return tx.webhookSaida.findUniqueOrThrow({ where: { id } });
  }

  private async garantirNomeLivre(
    tx: Tx,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    await travarChave(tx, TRAVA_NOME_SAIDA, nome.toLocaleLowerCase('pt-BR'));
    const outro = await tx.webhookSaida.findFirst({
      where: {
        nome: { equals: nome, mode: 'insensitive' },
        excluidoEm: null,
        ...(exceto ? { NOT: { id: exceto } } : {}),
      },
      select: { id: true },
    });
    if (outro) {
      throw new ConflitoException(
        'Já existe um webhook de saída com esse nome.',
        { campos: ['nome'], webhookId: outro.id },
      );
    }
  }
}

/**
 * URL para a auditoria (consultada também pelo C-level, R3.4): só o protocolo
 * e o servidor — caminho e query podem levar chaves (`/hooks/T0/B1/XYZ`).
 */
export function mascararUrl(url: string): string {
  if (!URL.canParse(url)) {
    return '…';
  }
  const { origin, pathname, search } = new URL(url);
  return pathname === '/' && !search ? origin : `${origin}/…`;
}
