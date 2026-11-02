import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { situacaoDoHorario, lerHorario } from '../../atendimento/horario';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import { normalizarEmail } from '../../comum/dominio/email';
import { normalizarTelefone } from '../../comum/dominio/telefone';
import { normalizarUtm } from '../../comum/dominio/utm';
import {
  DadosInvalidosException,
  NaoAutenticadoException,
  NaoEncontradoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import { AMBIENTE, type Ambiente } from '../../config/ambiente';
import { ContatosService } from '../../contatos/contatos.service';
import type { EntradaDeContato } from '../../contatos/deduplicacao';
import {
  type Arquivo,
  type Canal,
  type Mensagem,
  Prisma,
  type TipoMensagem,
  type WebchatVisitante,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EVENTOS_DO_SERVIDOR, salas } from '../../tempo-real/catalogo';
import {
  type AvisoDeDigitando,
  TempoRealService,
} from '../../tempo-real/tempo-real.service';
import { ArquivosPublicos } from '../comum/arquivos-publicos';
import { LimitadorDeRequisicoes } from '../comum/limitador';
import {
  type ConfiguracaoWebchat,
  lerConfiguracaoWebchat,
  origemPermitida,
} from './configuracao-webchat';
import {
  type ConfiguracaoPublicaDto,
  type HistoricoPublicoDto,
  type MensagemPublicaDto,
  type NovoVisitanteDto,
  type SessaoDoVisitanteDto,
  TAMANHO_MAXIMO_MENSAGEM_VISITANTE,
  type VisitanteCriadoDto,
} from './webchat.dto';
import {
  EVENTOS_PARA_O_VISITANTE,
  WebchatTempoReal,
} from './webchat-tempo-real';

/** Ator das entradas do chat do site (auditoria, outbox). */
export const ATOR_DO_WEBCHAT = {
  tipoAtor: 'SISTEMA',
  descricao: 'Chat do site',
} as const;

/** Validade do token do visitante, renovada a cada uso. */
export const VALIDADE_DO_TOKEN_MS = 90 * 24 * 60 * 60 * 1000;
/** Renova a validade no máximo uma vez neste intervalo (não grava a cada pedido). */
const RENOVACAO_DO_TOKEN_MS = 10 * 60 * 1000;
/** Validade dos links dos anexos mostrados ao visitante. */
export const VALIDADE_DO_LINK_DE_ARQUIVO_MS = 24 * 60 * 60 * 1000;
/** Tamanho máximo de um anexo enviado pelo visitante. */
export const TAMANHO_MAXIMO_ANEXO_VISITANTE = 10 * 1024 * 1024;
/** Mensagens por página do histórico. */
const MENSAGENS_POR_PAGINA = 50;

/** Limites das rotas públicas (por processo, ver `LimitadorDeRequisicoes`). */
export const LIMITES_DO_WEBCHAT = {
  /** Qualquer rota pública, por IP. */
  porIp: { limite: 120, janelaMs: 60_000 },
  /** Visitantes novos, por IP e canal. */
  novoVisitante: { limite: 10, janelaMs: 10 * 60_000 },
  /** Mensagens de texto, por visitante. */
  mensagens: { limite: 20, janelaMs: 60_000 },
  /** Anexos, por visitante. */
  anexos: { limite: 10, janelaMs: 10 * 60_000 },
  /** Conexões do Socket.IO, por IP. */
  conexoes: { limite: 30, janelaMs: 60_000 },
} as const;

/** Id que não casa com nenhuma conversa (filtro de visitante sem conversa). */
const SEM_CONVERSA = '00000000-0000-0000-0000-000000000000';

/** Mensagens da equipe que já saíram para o visitante (as pendentes ainda não chegaram). */
const STATUS_ENVIADOS = ['ENVIADA', 'ENTREGUE', 'LIDA'] as const;

type MensagemComAutor = Mensagem & {
  arquivo: Arquivo | null;
  autor: { nome: string } | null;
};

/** Canal do chat do site com a configuração já lida. */
export interface CanalWebchat {
  canal: Canal;
  configuracao: ConfiguracaoWebchat;
}

/**
 * Chat do site (§2.5, R14) — o lado do visitante: canal pela chave pública,
 * origem permitida, formulário inicial (contato com consentimento, R4.6),
 * token anônimo, mensagens e anexos (entrada pelo `AtendimentoService.receber`),
 * histórico, "digitando" e lidas, e os links assinados dos anexos.
 *
 * Privacidade: o e-mail digitado no formulário não é verificado, e outro
 * navegador com o mesmo e-mail cai no mesmo contato — e, pela R12, na mesma
 * conversa aberta. Por isso cada mensagem guarda o seu visitante
 * (`metadados.webchat.visitanteId`): o visitante só vê as mensagens que ele
 * escreveu e as respostas da equipe dirigidas a ele (a equipe responde a quem
 * escreveu por último), e nada de antes de o token dele existir.
 */
@Injectable()
export class WebchatService implements OnModuleInit {
  private readonly logger = new Logger('Webchat');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly atendimento: AtendimentoService,
    private readonly contatos: ContatosService,
    private readonly arquivos: ArquivosService,
    private readonly arquivosPublicos: ArquivosPublicos,
    private readonly limitador: LimitadorDeRequisicoes,
    private readonly tempoRealDoWebchat: WebchatTempoReal,
    private readonly tempoReal: TempoRealService,
    @Inject(AMBIENTE) private readonly ambiente: Ambiente,
  ) {}

  onModuleInit(): void {
    // "Digitando" da equipe numa conversa do chat do site vai para o widget.
    this.tempoReal.aoDigitar((aviso) => this.repassarDigitandoDaEquipe(aviso));
  }

  // -------------------------------------------------------------------------
  // Canal e origem
  // -------------------------------------------------------------------------

  /** O canal ativo da chave pública; 404 se não existe, foi excluído ou está desligado. */
  async canalPelaChave(chave: string): Promise<CanalWebchat> {
    const canal = /^wc_[A-Za-z0-9_-]{8,64}$/.test(chave)
      ? await this.prisma.canal.findFirst({
          where: { tipo: 'WEBCHAT', idExterno: chave, excluidoEm: null },
        })
      : null;
    if (!canal || !canal.ativo) {
      throw new NaoEncontradoException('Este chat não está disponível.');
    }
    return { canal, configuracao: lerConfiguracaoWebchat(canal.configuracao) };
  }

  /**
   * A origem do navegador pode usar o canal? Sem `Origin` (pedido fora do
   * navegador), sim; com, precisa estar nos domínios do canal ou ser o próprio
   * CRM (prévia na tela de configuração).
   */
  origemAceita(
    { configuracao }: CanalWebchat,
    origem: string | undefined,
  ): boolean {
    if (origem === undefined) {
      return true;
    }
    if (origem === '' || origem === 'null') {
      return false;
    }
    return (
      this.ambiente.origensPermitidas.includes(origem.toLowerCase()) ||
      origemPermitida(origem, configuracao.dominios)
    );
  }

  /** 403 se a origem não pode usar o canal. */
  exigirOrigem(canal: CanalWebchat, origem: string | undefined): void {
    if (!this.origemAceita(canal, origem)) {
      throw new SemPermissaoException(
        'Este site não está autorizado a usar o chat. Confira os domínios do canal.',
        { origem },
      );
    }
  }

  /** Limite por IP de todas as rotas públicas do chat. */
  limitarIp(ip: string | undefined): void {
    this.limitador.exigir(
      `webchat:ip:${ip ?? 'desconhecido'}`,
      LIMITES_DO_WEBCHAT.porIp,
      'Muitas requisições ao chat em pouco tempo.',
    );
  }

  /** O que o widget precisa para se desenhar. */
  configuracaoPublica({
    canal,
    configuracao,
  }: CanalWebchat): ConfiguracaoPublicaDto {
    const situacao = situacaoDoHorario(lerHorario(canal.horarioAtendimento));
    return {
      nome: canal.nome,
      aparencia: { ...configuracao.aparencia },
      contato: configuracao.contato,
      textoConsentimento: configuracao.textoConsentimento,
      urlPrivacidade: configuracao.urlPrivacidade,
      permitirAnexos: configuracao.permitirAnexos,
      horario: {
        aberto: situacao.aberto,
        proximaAbertura: situacao.proximaAbertura?.toISOString() ?? null,
      },
      mensagemForaHorario: canal.mensagemForaHorario,
      limites: {
        tamanhoMaximoTexto: TAMANHO_MAXIMO_MENSAGEM_VISITANTE,
        tamanhoMaximoAnexo: TAMANHO_MAXIMO_ANEXO_VISITANTE,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Visitante
  // -------------------------------------------------------------------------

  /**
   * Formulário inicial: cria o visitante (token anônimo, consentimento) e o
   * contato — deduplicado pelo e-mail/telefone (R4.2), com o consentimento e
   * as UTMs da página — ligado pelo identificador `WEBCHAT`.
   */
  async registrarVisitante(
    { canal, configuracao }: CanalWebchat,
    dto: NovoVisitanteDto,
    cliente: { ip?: string; userAgent?: string },
  ): Promise<VisitanteCriadoDto> {
    this.limitador.exigir(
      `webchat:novo:${canal.id}:${cliente.ip ?? 'desconhecido'}`,
      LIMITES_DO_WEBCHAT.novoVisitante,
      'Muitas conversas iniciadas a partir deste endereço.',
    );
    const { email, telefone } = this.meioDeContato(configuracao, dto);
    const pagina = paginaValida(dto.pagina);
    const token = this.cripto.gerarToken();
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + VALIDADE_DO_TOKEN_MS);
    const visitante = await executarComoAtor(ATOR_DO_WEBCHAT, () =>
      this.prisma.$transaction(async (tx) => {
        const criado = await tx.webchatVisitante.create({
          data: {
            canalId: canal.id,
            tokenHash: this.cripto.sha256(token),
            consentimentoEm: agora,
            ip: cliente.ip?.slice(0, 100) ?? null,
            userAgent: cliente.userAgent?.slice(0, 300) ?? null,
            pagina,
            ultimoAcessoEm: agora,
            expiraEm,
          },
        });
        const entrada: EntradaDeContato = {
          nome: dto.nome,
          ...(email ? { email } : {}),
          ...(telefone ? { telefone } : {}),
          origem: 'SITE',
          origemDetalhe: `Chat do site — ${canal.nome}`,
          consentimento: {
            em: agora,
            origem: `Chat do site — ${canal.nome}`,
          },
          ...utmDaPagina(pagina),
        };
        const { contato } = await this.contatos.encontrarOuCriar(tx, entrada);
        await tx.contatoIdentificador.create({
          data: {
            contatoId: contato.id,
            tipo: 'WEBCHAT',
            valor: criado.id,
            canalId: canal.id,
            nomeExibicao: dto.nome,
            ultimoUsoEm: agora,
          },
        });
        return tx.webchatVisitante.update({
          where: { id: criado.id },
          data: { contatoId: contato.id },
        });
      }),
    );
    return {
      token,
      visitanteId: visitante.id,
      expiraEm: expiraEm.toISOString(),
    };
  }

  /** O visitante do token no canal; 401 se o token não vale (expirou, foi encerrado). */
  async autenticar(canal: Canal, token: string): Promise<WebchatVisitante> {
    const visitante =
      token.length >= 20
        ? await this.prisma.webchatVisitante.findUnique({
            where: { tokenHash: this.cripto.sha256(token) },
          })
        : null;
    const agora = Date.now();
    if (
      !visitante ||
      visitante.canalId !== canal.id ||
      (visitante.expiraEm && visitante.expiraEm.getTime() <= agora)
    ) {
      throw new NaoAutenticadoException(
        'Sua conversa expirou. Recarregue a página para começar outra.',
      );
    }
    if (agora - visitante.ultimoAcessoEm.getTime() > RENOVACAO_DO_TOKEN_MS) {
      return this.prisma.webchatVisitante.update({
        where: { id: visitante.id },
        data: {
          ultimoAcessoEm: new Date(agora),
          expiraEm: new Date(agora + VALIDADE_DO_TOKEN_MS),
        },
      });
    }
    return visitante;
  }

  /** O visitante encerra a conversa no navegador: o token deixa de valer. */
  async encerrar(visitante: WebchatVisitante): Promise<void> {
    await this.prisma.webchatVisitante.update({
      where: { id: visitante.id },
      data: { expiraEm: new Date() },
    });
    this.tempoRealDoWebchat.desconectar(visitante.id);
  }

  /** Retomada do widget: a conversa atual e as últimas mensagens. */
  async sessao(
    canal: Canal,
    visitante: WebchatVisitante,
  ): Promise<SessaoDoVisitanteDto> {
    const conversa = visitante.conversaId
      ? await this.prisma.conversa.findUnique({
          where: { id: visitante.conversaId },
          select: { id: true, status: true },
        })
      : null;
    const { mensagens, haMais } = await this.historico(canal, visitante);
    return {
      visitanteId: visitante.id,
      expiraEm: (
        visitante.expiraEm ?? new Date(Date.now() + VALIDADE_DO_TOKEN_MS)
      ).toISOString(),
      conversa: conversa ? { id: conversa.id, status: conversa.status } : null,
      mensagens,
      haMais,
    };
  }

  /** Mensagens da conversa do visitante (as mais novas; com `antes`, as anteriores a ela). */
  async historico(
    canal: Canal,
    visitante: WebchatVisitante,
    antes?: string,
  ): Promise<HistoricoPublicoDto> {
    if (!visitante.conversaId) {
      return { mensagens: [], haMais: false };
    }
    let limite: Date | undefined;
    if (antes) {
      const referencia = await this.prisma.mensagem.findFirst({
        where: { id: antes, conversaId: visitante.conversaId },
        select: { ocorridaEm: true },
      });
      if (!referencia) {
        return { mensagens: [], haMais: false };
      }
      limite = referencia.ocorridaEm;
    }
    const lista = await this.prisma.mensagem.findMany({
      where: {
        ...this.filtroDoVisitante(visitante),
        ...(limite
          ? { ocorridaEm: { gte: visitante.criadoEm, lt: limite } }
          : {}),
      },
      include: { arquivo: true, autor: { select: { nome: true } } },
      orderBy: [{ ocorridaEm: 'desc' }, { criadoEm: 'desc' }],
      take: MENSAGENS_POR_PAGINA + 1,
    });
    const haMais = lista.length > MENSAGENS_POR_PAGINA;
    return {
      mensagens: lista
        .slice(0, MENSAGENS_POR_PAGINA)
        .reverse()
        .map((mensagem) => this.paraVisitante(mensagem, canal, visitante.id)),
      haMais,
    };
  }

  // -------------------------------------------------------------------------
  // Mensagens do visitante
  // -------------------------------------------------------------------------

  /** Texto do visitante → `AtendimentoService.receber`. */
  async enviarTexto(
    canal: Canal,
    visitante: WebchatVisitante,
    texto: string,
    idCliente?: string,
  ): Promise<MensagemPublicaDto> {
    this.limitarMensagens(visitante);
    return this.receber(canal, visitante, { tipo: 'TEXTO', texto, idCliente });
  }

  /** Anexo do visitante (já salvo pelo armazenamento do upload) → `receber`. */
  async enviarAnexo(
    canal: Canal,
    visitante: WebchatVisitante,
    arquivo: Arquivo,
    texto?: string | null,
    idCliente?: string,
  ): Promise<MensagemPublicaDto> {
    return this.receber(canal, visitante, {
      tipo: tipoDoArquivo(arquivo.mime),
      texto: texto ?? undefined,
      arquivoId: arquivo.id,
      idCliente,
    });
  }

  /** Limite de mensagens por visitante (texto). */
  limitarMensagens(visitante: Pick<WebchatVisitante, 'id'>): void {
    this.limitador.exigir(
      `webchat:mensagens:${visitante.id}`,
      LIMITES_DO_WEBCHAT.mensagens,
      'Muitas mensagens em pouco tempo.',
    );
  }

  /** Limite de anexos por visitante (conferido antes de receber o arquivo). */
  limitarAnexos(visitante: Pick<WebchatVisitante, 'id'>): void {
    this.limitador.exigir(
      `webchat:anexos:${visitante.id}`,
      LIMITES_DO_WEBCHAT.anexos,
      'Muitos arquivos enviados em pouco tempo.',
    );
  }

  /** Limite de conexões do Socket.IO por IP; `false` se passou. */
  podeConectar(ip: string): boolean {
    return this.limitador.consumir(
      `webchat:conexoes:${ip}`,
      LIMITES_DO_WEBCHAT.conexoes,
    ).permitido;
  }

  /**
   * O visitante está digitando: avisa quem está na conversa (`digitando` com
   * `contato: true`). Efêmero, direto no tempo real.
   */
  async avisarDigitando(
    visitante: Pick<WebchatVisitante, 'id'>,
    ativo: boolean,
  ): Promise<void> {
    const atual = await this.prisma.webchatVisitante.findUnique({
      where: { id: visitante.id },
      select: { conversaId: true },
    });
    if (!atual?.conversaId) {
      return;
    }
    this.tempoReal.emitir(
      salas.conversa(atual.conversaId),
      EVENTOS_DO_SERVIDOR.DIGITANDO,
      { conversaId: atual.conversaId, ativo, contato: true },
    );
  }

  /** O visitante viu a conversa: as mensagens da equipe ficam lidas (R14). */
  async marcarLidas(visitante: Pick<WebchatVisitante, 'id'>): Promise<number> {
    const atual = await this.prisma.webchatVisitante.findUnique({
      where: { id: visitante.id },
    });
    if (!atual?.conversaId) {
      return 0;
    }
    const naoLidas = await this.prisma.mensagem.findMany({
      where: {
        ...this.filtroDoVisitante(atual),
        direcao: 'SAIDA',
        status: { in: ['ENVIADA', 'ENTREGUE'] },
        idExterno: { not: null },
      },
      select: { idExterno: true },
      orderBy: { ocorridaEm: 'asc' },
      take: 100,
    });
    const agora = new Date();
    await executarComoAtor(ATOR_DO_WEBCHAT, async () => {
      for (const { idExterno } of naoLidas) {
        await this.atendimento.atualizarStatus(
          atual.canalId,
          idExterno as string,
          'LIDA',
          undefined,
          agora,
        );
      }
    });
    return naoLidas.length;
  }

  // -------------------------------------------------------------------------
  // Saída (adaptador) e arquivos
  // -------------------------------------------------------------------------

  /**
   * O visitante com quem a equipe fala nesta conversa: o autor da última
   * mensagem do contato (cada navegador é um visitante). Sem essa marca, o
   * visitante ligado à conversa que apareceu por último.
   */
  async visitanteAtualDaConversa(
    conversaId: string,
  ): Promise<WebchatVisitante | null> {
    const ultimaEntrada = await this.prisma.mensagem.findFirst({
      where: { conversaId, direcao: 'ENTRADA' },
      orderBy: [{ ocorridaEm: 'desc' }, { criadoEm: 'desc' }],
      select: { metadados: true },
    });
    const visitanteId = visitanteDaMensagem(ultimaEntrada?.metadados);
    const autor = visitanteId
      ? await this.prisma.webchatVisitante.findFirst({
          where: { id: visitanteId, conversaId },
        })
      : null;
    return (
      autor ??
      this.prisma.webchatVisitante.findFirst({
        where: { conversaId },
        orderBy: { ultimoAcessoEm: 'desc' },
      })
    );
  }

  /** Marca na mensagem da equipe o visitante a quem ela se dirige (ver a classe). */
  async dirigirAoVisitante(
    mensagem: Pick<Mensagem, 'id' | 'metadados'>,
    visitanteId: string,
  ): Promise<void> {
    const metadados = objeto(mensagem.metadados);
    await this.prisma.mensagem.update({
      where: { id: mensagem.id },
      data: {
        metadados: {
          ...metadados,
          webchat: { ...objeto(metadados.webchat), visitanteId },
        } as Prisma.InputJsonObject,
      },
    });
  }

  /** A mensagem como o visitante vê, com o link assinado do anexo. */
  paraVisitante(
    mensagem: MensagemComAutor,
    canal: Pick<Canal, 'idExterno'>,
    visitanteId: string,
  ): MensagemPublicaDto {
    const webchat = objeto(objeto(mensagem.metadados).webchat);
    return {
      id: mensagem.id,
      de: mensagem.direcao === 'ENTRADA' ? 'visitante' : 'equipe',
      tipo: mensagem.tipo,
      texto: mensagem.texto,
      botoes: botoesDaMensagem(mensagem),
      arquivo:
        mensagem.arquivo && !mensagem.arquivo.removidoEm
          ? {
              nome: mensagem.arquivo.nome,
              mime: mensagem.arquivo.mime,
              tamanho: mensagem.arquivo.tamanho,
              url: this.urlDoArquivo(
                canal.idExterno as string,
                mensagem.arquivo.id,
                visitanteId,
              ),
            }
          : null,
      autor:
        mensagem.direcao === 'SAIDA' && mensagem.autor
          ? { nome: primeiroNome(mensagem.autor.nome) }
          : null,
      em: mensagem.ocorridaEm.toISOString(),
      idCliente:
        typeof webchat.idCliente === 'string' ? webchat.idCliente : null,
    };
  }

  /** Carrega a mensagem com o que o visitante vê. */
  carregarMensagem(id: string): Promise<MensagemComAutor | null> {
    return this.prisma.mensagem.findUnique({
      where: { id },
      include: { arquivo: true, autor: { select: { nome: true } } },
    });
  }

  /** Abre um anexo pelo link assinado (404 se o link não vale ou o arquivo não é do canal). */
  async abrirArquivo(
    canal: Canal,
    arquivoId: string,
    link: { v: string; e: string; a: string },
  ): Promise<{ arquivo: Arquivo; stream: Readable }> {
    const valido = this.arquivosPublicos.conferir(
      arquivoId,
      `webchat:${link.v}`,
      link.e,
      link.a,
    );
    const daConversa =
      valido &&
      (await this.prisma.mensagem.findFirst({
        where: { arquivoId, canalId: canal.id },
        select: { id: true },
      }));
    if (!daConversa) {
      throw new NaoEncontradoException('Arquivo não encontrado.');
    }
    return this.arquivos.abrirLeitura(arquivoId);
  }

  private urlDoArquivo(
    chave: string,
    arquivoId: string,
    visitanteId: string,
  ): string {
    const { e, a } = this.arquivosPublicos.assinar(
      arquivoId,
      `webchat:${visitanteId}`,
      VALIDADE_DO_LINK_DE_ARQUIVO_MS,
    );
    return `/api/v1/publico/webchat/${encodeURIComponent(chave)}/arquivos/${arquivoId}?v=${visitanteId}&e=${e}&a=${a}`;
  }

  /**
   * O que o visitante vê da conversa: as mensagens dele e as respostas da
   * equipe dirigidas a ele (já enviadas), a partir de quando o token dele foi
   * criado (privacidade, ver a classe).
   */
  private filtroDoVisitante(
    visitante: Pick<WebchatVisitante, 'id' | 'conversaId' | 'criadoEm'>,
  ): Prisma.MensagemWhereInput {
    const dele: Prisma.MensagemWhereInput = {
      metadados: { path: ['webchat', 'visitanteId'], equals: visitante.id },
    };
    return {
      // Sem conversa, nenhuma mensagem (o id nulo nunca casa).
      conversaId: visitante.conversaId ?? SEM_CONVERSA,
      excluidaEm: null,
      ocorridaEm: { gte: visitante.criadoEm },
      OR: [
        { direcao: 'ENTRADA', ...dele },
        { direcao: 'SAIDA', status: { in: [...STATUS_ENVIADOS] }, ...dele },
      ],
    };
  }

  private async receber(
    canal: Canal,
    visitante: WebchatVisitante,
    mensagem: {
      tipo: TipoMensagem;
      texto?: string;
      arquivoId?: string;
      idCliente?: string;
    },
  ): Promise<MensagemPublicaDto> {
    const resultado = await executarComoAtor(ATOR_DO_WEBCHAT, () =>
      this.atendimento.receber({
        canalId: canal.id,
        remetente: { tipo: 'WEBCHAT', valor: visitante.id },
        idExternoConversa: visitante.id,
        mensagem: {
          idExterno: mensagem.idCliente
            ? `wc:${visitante.id}:${mensagem.idCliente}`
            : undefined,
          tipo: mensagem.tipo,
          texto: mensagem.texto,
          arquivoId: mensagem.arquivoId,
          recebidaEm: new Date(),
          metadados: {
            webchat: {
              visitanteId: visitante.id,
              ...(mensagem.idCliente ? { idCliente: mensagem.idCliente } : {}),
            },
          },
        },
      }),
    );
    if (resultado.conversaId !== visitante.conversaId) {
      await this.prisma.webchatVisitante.update({
        where: { id: visitante.id },
        data: { conversaId: resultado.conversaId },
      });
    }
    const gravada = await this.carregarMensagem(resultado.mensagemId);
    if (!gravada || gravada.conversaId !== resultado.conversaId) {
      throw new NaoEncontradoException('Mensagem não encontrada.');
    }
    const dto = this.paraVisitante(gravada, canal, visitante.id);
    // As outras abas do visitante também mostram (o widget ignora repetidas).
    this.tempoRealDoWebchat.emitir(
      [visitante.id],
      EVENTOS_PARA_O_VISITANTE.MENSAGEM,
      dto,
    );
    return dto;
  }

  private meioDeContato(
    configuracao: ConfiguracaoWebchat,
    dto: NovoVisitanteDto,
  ): { email: string | null; telefone: string | null } {
    const email = dto.email ? normalizarEmail(dto.email) : null;
    let telefone: string | null = null;
    if (dto.telefone) {
      const lido = normalizarTelefone(dto.telefone);
      if (!lido.valido) {
        throw new DadosInvalidosException(`Telefone inválido: ${lido.motivo}`, {
          campos: [{ campo: 'telefone', mensagens: [lido.motivo] }],
        });
      }
      telefone = lido.telefone;
    }
    const falta = (campo: 'email' | 'telefone', mensagem: string) =>
      new DadosInvalidosException(mensagem, {
        campos: [{ campo, mensagens: ['é obrigatório'] }],
      });
    if (configuracao.contato === 'EMAIL' && !email) {
      throw falta('email', 'Informe o seu e-mail para começar a conversa.');
    }
    if (configuracao.contato === 'TELEFONE' && !telefone) {
      throw falta(
        'telefone',
        'Informe o seu telefone para começar a conversa.',
      );
    }
    if (!email && !telefone) {
      throw new DadosInvalidosException(
        'Informe o seu e-mail ou telefone para começar a conversa.',
        {
          campos: [
            { campo: 'email', mensagens: ['informe o e-mail ou o telefone'] },
            {
              campo: 'telefone',
              mensagens: ['informe o e-mail ou o telefone'],
            },
          ],
        },
      );
    }
    return { email, telefone };
  }

  private async repassarDigitandoDaEquipe(
    aviso: AvisoDeDigitando,
  ): Promise<void> {
    if (aviso.tipo !== 'conversa') {
      return;
    }
    const visitante = await this.visitanteAtualDaConversa(aviso.id);
    if (!visitante) {
      return;
    }
    this.tempoRealDoWebchat.emitir(
      [visitante.id],
      EVENTOS_PARA_O_VISITANTE.DIGITANDO,
      { ativo: aviso.ativo, nome: primeiroNome(aviso.usuario.nome) },
    );
  }
}

/** O visitante gravado na mensagem (`metadados.webchat.visitanteId`). */
export function visitanteDaMensagem(metadados: unknown): string | null {
  const id = objeto(objeto(metadados).webchat).visitanteId;
  return typeof id === 'string' ? id : null;
}

/** As opções de resposta rápida do bot (`metadados.botoes`), só nas mensagens da equipe. */
export function botoesDaMensagem(
  mensagem: Pick<Mensagem, 'direcao' | 'metadados'>,
): { id: string; rotulo: string }[] | null {
  if (mensagem.direcao !== 'SAIDA') {
    return null;
  }
  const bruto = objeto(mensagem.metadados).botoes;
  if (!Array.isArray(bruto)) {
    return null;
  }
  const botoes = bruto.flatMap((b) => {
    const o = objeto(b);
    return typeof o.rotulo === 'string' && o.rotulo.trim()
      ? [
          {
            id: typeof o.id === 'string' ? o.id : o.rotulo,
            rotulo: o.rotulo.trim(),
          },
        ]
      : [];
  });
  return botoes.length > 0 ? botoes : null;
}

function objeto(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** Tipo da mensagem pelo MIME do anexo. */
export function tipoDoArquivo(mime: string): TipoMensagem {
  if (mime.startsWith('image/')) {
    return 'IMAGEM';
  }
  if (mime.startsWith('audio/')) {
    return 'AUDIO';
  }
  if (mime.startsWith('video/')) {
    return 'VIDEO';
  }
  return 'DOCUMENTO';
}

/** Primeiro nome de quem atende (o visitante não vê o nome completo). */
export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}

/** Só endereços http(s), cortados. */
function paginaValida(pagina: string | null | undefined): string | null {
  if (!pagina || !URL.canParse(pagina)) {
    return null;
  }
  const url = new URL(pagina);
  return url.protocol === 'https:' || url.protocol === 'http:'
    ? url.toString().slice(0, 1000)
    : null;
}

/** UTMs da página onde o chat foi aberto (`?utm_source=…`). */
function utmDaPagina(pagina: string | null): { utm?: Record<string, string> } {
  if (!pagina) {
    return {};
  }
  const parametros = Object.fromEntries(new URL(pagina).searchParams);
  const utm = normalizarUtm(parametros);
  return utm ? { utm: utm as Record<string, string> } : {};
}
