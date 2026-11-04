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
import type {
  FormatoWebhookSaida,
  Prisma,
  WebhookSaida,
} from '../../generated/prisma/client';
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
  FormatoClintDto,
  WebhookSaidaComSegredoDto,
  WebhookSaidaDto,
} from './dto/webhook-saida.dto';
import {
  CAMPOS_DE_SAIDA,
  CAMPOS_DE_SAIDA_MAXIMOS,
  type CampoDeSaida,
  DESCRICAO_DOS_GATILHOS,
  type Gatilho,
  problemasDoCampo,
  TIPOS_DE_GATILHO,
} from './formato-clint';
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
  'contrato.criado': 'Contrato criado no Financeiro.',
  'contrato.atualizado': 'Contrato alterado (valor, prazo, responsável).',
  'contrato.suspenso': 'Contrato suspenso.',
  'contrato.reativado': 'Contrato reativado.',
  'contrato.cancelado': 'Contrato cancelado, com o motivo.',
  'contrato.encerrado': 'Contrato encerrado ao fim do prazo.',
  'parcela.paga': 'Parcela paga (baixa manual, importação ou ligação).',
  'parcela.atrasada': 'Parcela venceu sem pagamento.',
  'ligacao.encerrada':
    'Ligação do WhatsApp encerrada (atendida, perdida, recusada, sem resposta ou com falha): ids, direção, resultado, duração, atendente e contato. Sem áudio nem transcrição; o resumo só se o Admin marcar no canal.',
  'sdr.lead_qualificado':
    'Lead qualificado pela IA (SDR) e passado ao Comercial: contato, negócio, vendedor, canal, nota, temperatura, critérios descobertos, motivo e resumo. Nunca o histórico da conversa.',
  'sdr.lead_desqualificado':
    'Lead desqualificado pela IA (SDR): contato, negócio (se houver), canal, nota, temperatura, critérios descobertos, motivo e resumo. Nunca o histórico da conversa.',
  'webhook.teste':
    'Evento de teste disparado pelo Admin (sempre entregue ao destino testado).',
};

const CAMPOS_AUDITADOS = [
  'nome',
  'eventos',
  'ativo',
  'metodo',
  'gatilhos',
  'campos',
] as const;

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

  /** O que o formato do Clint oferece: gatilhos, campos e métodos (R32.12). */
  formatoClint(): FormatoClintDto {
    return {
      gatilhos: TIPOS_DE_GATILHO.map((tipo) => ({
        tipo,
        descricao: DESCRICAO_DOS_GATILHOS[tipo],
        exigeEtapa: tipo === 'ENTRA_NA_ETAPA',
        aceitaStatus: tipo === 'MUDA_DE_STATUS',
      })),
      campos: CAMPOS_DE_SAIDA.map((campo) => ({ ...campo })),
      metodos: ['POST', 'GET'],
    };
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
    const formato: FormatoWebhookSaida = dto.formato ?? 'ENVELOPE_CRM';
    const metodo = dto.metodo ?? 'POST';
    const id = await this.prisma.$transaction(async (tx) => {
      await this.garantirNomeLivre(tx, dto.nome);
      const clint = await this.lerFormato(tx, formato, {
        eventos: dto.eventos,
        metodo: dto.metodo,
        gatilhos: dto.gatilhos,
        campos: dto.campos,
      });
      const destino = await tx.webhookSaida.create({
        data: {
          nome: dto.nome,
          url,
          eventos: formato === 'CLINT' ? [] : [...(dto.eventos ?? [])],
          formato,
          metodo,
          gatilhos: clint.gatilhos as unknown as Prisma.InputJsonArray,
          campos: clint.campos as unknown as Prisma.InputJsonArray,
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
          ...(formato === 'CLINT'
            ? {
                formato,
                metodo,
                gatilhos: clint.gatilhos,
                campos: clint.campos.map(({ origem, identificador }) => ({
                  origem,
                  identificador,
                })),
              }
            : {}),
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
      if (antes.formato === 'CLINT') {
        if (dto.eventos !== undefined) {
          throw erroDeCampo(
            'eventos',
            'o formato CLINT usa gatilhos em vez de eventos',
          );
        }
        if (
          dto.gatilhos !== undefined ||
          dto.campos !== undefined ||
          dto.metodo !== undefined
        ) {
          const clint = await this.lerFormato(tx, 'CLINT', {
            metodo: dto.metodo ?? antes.metodo,
            gatilhos: dto.gatilhos ?? lerLista(antes.gatilhos),
            campos: dto.campos ?? lerLista(antes.campos),
          });
          dados.gatilhos = clint.gatilhos as unknown as Prisma.InputJsonArray;
          dados.campos = clint.campos as unknown as Prisma.InputJsonArray;
          if (dto.metodo !== undefined) {
            dados.metodo = dto.metodo;
          }
        }
      } else {
        if (
          dto.gatilhos !== undefined ||
          dto.campos !== undefined ||
          dto.metodo === 'GET'
        ) {
          throw erroDeCampo(
            dto.gatilhos !== undefined
              ? 'gatilhos'
              : dto.campos !== undefined
                ? 'campos'
                : 'metodo',
            'só vale no formato CLINT',
          );
        }
        if (dto.eventos !== undefined) {
          dados.eventos = [...dto.eventos];
        }
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
      formato: destino.formato,
      metodo: destino.metodo,
      gatilhos: lerLista(
        destino.gatilhos,
      ) as unknown as WebhookSaidaDto['gatilhos'],
      campos: lerLista(destino.campos) as unknown as WebhookSaidaDto['campos'],
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

  /**
   * Confere os campos do formato (R32.12). `ENVELOPE_CRM`: precisa de eventos e
   * não aceita gatilhos, campos nem GET. `CLINT`: não aceita eventos; gatilhos (com
   * etapa e funil existentes e coerentes) e campos (origem conhecida, identificador
   * único) obrigatórios.
   */
  private async lerFormato(
    tx: Tx,
    formato: FormatoWebhookSaida,
    entrada: {
      eventos?: readonly string[];
      metodo?: string;
      gatilhos?: readonly unknown[];
      campos?: readonly unknown[];
    },
  ): Promise<{ gatilhos: Gatilho[]; campos: CampoDeSaida[] }> {
    if (formato === 'ENVELOPE_CRM') {
      if (!entrada.eventos || entrada.eventos.length === 0) {
        throw erroDeCampo('eventos', 'escolha pelo menos um evento');
      }
      for (const campo of ['gatilhos', 'campos'] as const) {
        if (entrada[campo] !== undefined) {
          throw erroDeCampo(campo, 'só vale no formato CLINT');
        }
      }
      if (entrada.metodo === 'GET') {
        throw erroDeCampo('metodo', 'GET só vale no formato CLINT');
      }
      return { gatilhos: [], campos: [] };
    }
    if (entrada.eventos !== undefined && entrada.eventos.length > 0) {
      throw erroDeCampo(
        'eventos',
        'o formato CLINT usa gatilhos em vez de eventos',
      );
    }
    const problemas: ProblemaDeCampo[] = [];
    const gatilhos: Gatilho[] = [];
    const brutos = entrada.gatilhos ?? [];
    if (brutos.length === 0) {
      problemas.push({
        campo: 'gatilhos',
        mensagens: ['escolha pelo menos um gatilho'],
      });
    }
    for (const [indice, bruto] of brutos.entries()) {
      const g = bruto as Gatilho;
      const base = `gatilhos.${indice}`;
      if (g.tipo !== 'MUDA_DE_STATUS' && g.status !== undefined) {
        problemas.push({
          campo: `${base}.status`,
          mensagens: ['só vale em MUDA_DE_STATUS'],
        });
      }
      if (g.tipo !== 'ENTRA_NA_ETAPA' && g.etapaId !== undefined) {
        problemas.push({
          campo: `${base}.etapaId`,
          mensagens: ['só vale em ENTRA_NA_ETAPA'],
        });
      }
      let funilId = g.funilId;
      if (g.tipo === 'ENTRA_NA_ETAPA') {
        if (!g.etapaId) {
          problemas.push({
            campo: `${base}.etapaId`,
            mensagens: ['é obrigatório em ENTRA_NA_ETAPA'],
          });
        } else {
          const etapa = await tx.etapa.findUnique({
            where: { id: g.etapaId },
            select: { funilId: true, funil: { select: { excluidoEm: true } } },
          });
          if (!etapa || etapa.funil.excluidoEm) {
            problemas.push({
              campo: `${base}.etapaId`,
              mensagens: ['a etapa não existe'],
            });
          } else if (funilId && funilId !== etapa.funilId) {
            problemas.push({
              campo: `${base}.etapaId`,
              mensagens: ['a etapa não pertence ao funil escolhido'],
            });
          } else {
            funilId = etapa.funilId;
          }
        }
      } else if (funilId) {
        const funil = await tx.funil.findFirst({
          where: { id: funilId, excluidoEm: null },
          select: { id: true },
        });
        if (!funil) {
          problemas.push({
            campo: `${base}.funilId`,
            mensagens: ['o funil não existe'],
          });
        }
      }
      gatilhos.push({
        tipo: g.tipo,
        ...(funilId ? { funilId } : {}),
        ...(g.etapaId ? { etapaId: g.etapaId } : {}),
        ...(g.status ? { status: g.status } : {}),
      });
    }
    const campos: CampoDeSaida[] = [];
    const brutosDosCampos = entrada.campos ?? [];
    if (brutosDosCampos.length === 0) {
      problemas.push({
        campo: 'campos',
        mensagens: ['escolha pelo menos um campo'],
      });
    }
    if (brutosDosCampos.length > CAMPOS_DE_SAIDA_MAXIMOS) {
      problemas.push({
        campo: 'campos',
        mensagens: [`deve ter no máximo ${CAMPOS_DE_SAIDA_MAXIMOS} campos`],
      });
    }
    const usados = new Set<string>();
    for (const [indice, bruto] of brutosDosCampos.entries()) {
      const c = bruto as CampoDeSaida;
      for (const problema of problemasDoCampo(c)) {
        problemas.push({
          campo: `campos.${indice}.${problema.campo}`,
          mensagens: [problema.mensagem],
        });
      }
      if (typeof c.identificador === 'string') {
        if (usados.has(c.identificador)) {
          problemas.push({
            campo: `campos.${indice}.identificador`,
            mensagens: ['já usado em outro campo'],
          });
        }
        usados.add(c.identificador);
      }
      campos.push({ origem: c.origem, identificador: c.identificador });
    }
    if (problemas.length > 0) {
      throw new DadosInvalidosException(resumirProblemas(problemas), {
        regra: 'R32.12',
        campos: problemas,
      });
    }
    return { gatilhos, campos };
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

function erroDeCampo(campo: string, mensagem: string): DadosInvalidosException {
  const campos: ProblemaDeCampo[] = [{ campo, mensagens: [mensagem] }];
  return new DadosInvalidosException(resumirProblemas(campos), { campos });
}

/** Lista gravada em JSON (gatilhos, campos): vazia se estiver malformada. */
export function lerLista(valor: Prisma.JsonValue): Record<string, unknown>[] {
  if (!Array.isArray(valor)) {
    return [];
  }
  return (valor as unknown[]).filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}
