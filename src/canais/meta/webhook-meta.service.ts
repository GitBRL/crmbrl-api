import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { CriptografiaService } from '../../comum/criptografia/criptografia.service';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import {
  ErroApi,
  NaoAutenticadoException,
  SemPermissaoException,
} from '../../comum/erros/excecoes';
import { FilaService, type Trabalho } from '../../fila/fila.service';
import type { Canal, TipoMensagem } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ROTULO_DO_TIPO_DE_CANAL } from '../registro-canais';
import type { EntradaDeAtendimento } from '../../atendimento/entrada';
import { entregarComAnexos } from '../comum/anexos-soltos';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import {
  type AnexoMeta,
  entradasDoWebhook,
  type EventoMeta,
  eventosDaEntrada,
  type SegredosMeta,
  type TipoCanalMeta,
  TIPOS_META,
  tipoDaMensagemDoAnexo,
} from './eventos-meta';
import { GraphApi } from './graph-api';

/** Fila (pg-boss) das entradas do webhook, processadas fora da requisição. */
export const FILA_WEBHOOK_META = 'meta.webhook';

/** Tamanho máximo de um anexo baixado da Meta. */
const TAMANHO_MAXIMO_ANEXO_META = 25 * 1024 * 1024;

/** Um job: a entrada do webhook de um canal. */
export interface TrabalhoDoWebhookMeta {
  canalId: string;
  entrada: Record<string, unknown>;
}

/** Ator das entradas da Meta. */
function atorDo(tipo: TipoCanalMeta) {
  return {
    tipoAtor: 'SISTEMA' as const,
    descricao: ROTULO_DO_TIPO_DE_CANAL[tipo],
  };
}

/**
 * Webhook da Meta (§2.5, R14), um endereço só para todos os canais de
 * Instagram e Messenger:
 *
 * - `GET`: o desafio de verificação (`hub.verify_token` = o token de
 *   verificação de algum canal) devolve o `hub.challenge`;
 * - `POST`: confere a assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo
 *   bruto com o app secret do canal da entrada), põe cada entrada numa fila e
 *   responde 200 na hora; o job entrega as mensagens ao Atendimento (contato
 *   pelo PSID/IGSID, nome pelo perfil da Graph, anexos baixados para o
 *   `ArquivosService`), as entregas e as leituras.
 */
@Injectable()
export class WebhookMetaService implements OnModuleInit {
  private readonly logger = new Logger('Meta');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cripto: CriptografiaService,
    private readonly segredos: SegredosDoCanal,
    private readonly fila: FilaService,
    private readonly atendimento: AtendimentoService,
    private readonly arquivos: ArquivosService,
    private readonly graph: GraphApi,
    private readonly logs: LogsTecnicosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<TrabalhoDoWebhookMeta>(
      FILA_WEBHOOK_META,
      (trabalho) => this.processar(trabalho),
      {
        concorrencia: 1,
        tentativas: 5,
        intervaloEntreTentativasSegundos: 10,
        esperaExponencial: true,
        guardarConcluidosPorSegundos: 24 * 3600,
      },
    );
  }

  /** Desafio de verificação: o `hub.challenge` se o token é de algum canal; senão 403. */
  async verificarDesafio(
    modo: unknown,
    token: unknown,
    desafio: unknown,
  ): Promise<string> {
    if (
      modo === 'subscribe' &&
      typeof token === 'string' &&
      token !== '' &&
      typeof desafio === 'string'
    ) {
      const canais = await this.prisma.canal.findMany({
        where: { tipo: { in: [...TIPOS_META] }, excluidoEm: null },
      });
      for (const canal of canais) {
        const { tokenVerificacao } =
          this.segredos.lerSemFalhar<SegredosMeta>(canal) ?? {};
        if (
          tokenVerificacao &&
          this.cripto.compararSeguro(tokenVerificacao, token)
        ) {
          return desafio;
        }
      }
    }
    throw new SemPermissaoException('Token de verificação inválido.');
  }

  /**
   * Recebe o POST do webhook: confere a assinatura com o app secret dos
   * canais das entradas e enfileira uma entrada por canal. Entradas de canais
   * desconhecidos (ou desligados) são ignoradas.
   */
  async receber(
    corpo: unknown,
    bruto: Buffer | undefined,
    assinatura: string | undefined,
  ): Promise<{ recebidas: number }> {
    const entradas = entradasDoWebhook(corpo);
    if (entradas.length === 0) {
      return { recebidas: 0 };
    }
    const canais = await this.prisma.canal.findMany({
      where: {
        excluidoEm: null,
        OR: entradas.map(({ tipo, idDoCanal }) => ({
          tipo,
          idExterno: idDoCanal,
        })),
      },
    });
    if (canais.length === 0) {
      this.logger.debug?.(
        `Webhook da Meta para ${entradas.map(({ idDoCanal }) => idDoCanal).join(', ')}: nenhum canal.`,
      );
      return { recebidas: 0 };
    }
    const assinadoPor = canais.find((canal) => {
      const { appSecret } =
        this.segredos.lerSemFalhar<SegredosMeta>(canal) ?? {};
      return (
        !!appSecret &&
        !!bruto &&
        this.cripto.verificarHmac(appSecret, bruto, assinatura)
      );
    });
    if (!assinadoPor) {
      await this.logs.aviso(
        'Meta',
        assinatura
          ? 'Webhook da Meta com assinatura inválida (X-Hub-Signature-256 não confere com o app secret do canal).'
          : 'Webhook da Meta sem a assinatura X-Hub-Signature-256.',
        { canais: canais.map(({ id }) => id) },
      );
      throw new NaoAutenticadoException(
        assinatura
          ? 'Assinatura inválida: X-Hub-Signature-256 não confere.'
          : 'Assinatura ausente: envie X-Hub-Signature-256.',
      );
    }
    let recebidas = 0;
    for (const entrada of entradas) {
      const canal = canais.find(
        (item) =>
          item.tipo === entrada.tipo && item.idExterno === entrada.idDoCanal,
      );
      if (!canal || !canal.ativo) {
        continue;
      }
      // Canais do mesmo app: a assinatura é a mesma. De outro app, confere de novo.
      if (canal.id !== assinadoPor.id) {
        const { appSecret } =
          this.segredos.lerSemFalhar<SegredosMeta>(canal) ?? {};
        if (
          !appSecret ||
          !bruto ||
          !this.cripto.verificarHmac(appSecret, bruto, assinatura)
        ) {
          continue;
        }
      }
      await this.fila.enviar(FILA_WEBHOOK_META, {
        canalId: canal.id,
        entrada: entrada.bruta,
      } satisfies TrabalhoDoWebhookMeta);
      recebidas++;
    }
    return { recebidas };
  }

  /** O job: entrega os eventos da entrada ao Atendimento. */
  async processar(trabalho: Trabalho<TrabalhoDoWebhookMeta>): Promise<void> {
    const canal = await this.prisma.canal.findFirst({
      where: { id: trabalho.dados.canalId, excluidoEm: null },
    });
    if (
      !canal ||
      !canal.ativo ||
      (canal.tipo !== 'INSTAGRAM' && canal.tipo !== 'MESSENGER')
    ) {
      return;
    }
    const tipo = canal.tipo;
    const segredos = await this.segredos.ler<SegredosMeta>(canal);
    await executarComoAtor(atorDo(tipo), async () => {
      for (const evento of eventosDaEntrada(trabalho.dados.entrada)) {
        await this.aplicar(canal, tipo, segredos, evento);
      }
    });
  }

  private async aplicar(
    canal: Canal,
    tipo: TipoCanalMeta,
    segredos: Partial<SegredosMeta>,
    evento: EventoMeta,
  ): Promise<void> {
    switch (evento.tipo) {
      case 'mensagem':
        await this.receberMensagem(canal, tipo, segredos, evento);
        return;
      case 'reacao':
        await this.atendimento.receber({
          canalId: canal.id,
          remetente: await this.remetente(
            canal,
            tipo,
            segredos,
            evento.remetente,
          ),
          idExternoConversa: evento.remetente,
          mensagem: {
            idExterno: `reacao:${evento.mid}:${evento.remetente}:${evento.em.getTime()}`,
            tipo: 'REACAO',
            texto: evento.emoji,
            respondeAIdExterno: evento.mid,
            recebidaEm: evento.em,
            metadados: { reacao: { emoji: evento.emoji, mid: evento.mid } },
          },
        });
        return;
      case 'entrega':
        for (const mid of evento.mids) {
          await this.atendimento.atualizarStatus(
            canal.id,
            mid,
            'ENTREGUE',
            undefined,
            evento.em,
          );
        }
        return;
      case 'leitura':
        await this.marcarLidas(canal, evento.remetente, evento.ate, evento.mid);
        return;
    }
  }

  /**
   * Uma mensagem do contato. Ids externos fixos por posição: o `mid` vai na
   * mensagem principal (o texto; sem texto, o primeiro anexo — respostas e
   * reações apontam para ela) e `mid#anexo-N` nos outros anexos. A principal
   * é gravada por último: se o job é refeito depois de uma falha no meio, o
   * que já entrou é pulado (sem baixar de novo) e, com o `mid` gravado, o
   * evento inteiro já entrou.
   */
  private async receberMensagem(
    canal: Canal,
    tipo: TipoCanalMeta,
    segredos: Partial<SegredosMeta>,
    evento: Extract<EventoMeta, { tipo: 'mensagem' }>,
  ): Promise<void> {
    const { mid } = evento;
    const idDoAnexo = (indice: number) =>
      indice === 0 && !evento.texto ? mid : `${mid}#anexo-${indice + 1}`;
    const existentes = new Set(
      (
        await this.prisma.mensagem.findMany({
          where: {
            canalId: canal.id,
            idExterno: {
              in: [mid, ...evento.anexos.map((_, indice) => idDoAnexo(indice))],
            },
          },
          select: { idExterno: true },
        })
      ).map(({ idExterno }) => idExterno),
    );
    if (existentes.has(mid)) {
      return;
    }
    const base = {
      canalId: canal.id,
      remetente: await this.remetente(canal, tipo, segredos, evento.remetente),
      idExternoConversa: evento.remetente,
    };
    const avisos: string[] = [];
    let principal: { id: string; tipo: TipoMensagem } | null = null;
    for (const [indice, anexo] of evento.anexos.entries()) {
      const idExterno = idDoAnexo(indice);
      if (existentes.has(idExterno)) {
        continue;
      }
      const salvo = await this.salvarAnexo(anexo);
      if (!salvo) {
        avisos.push(descreverAnexo(anexo));
      } else if (idExterno === mid) {
        principal = salvo;
      } else {
        await this.entregar([salvo.id], {
          ...base,
          mensagem: {
            idExterno,
            tipo: salvo.tipo,
            arquivoId: salvo.id,
            recebidaEm: new Date(evento.em.getTime() + indice + 1),
            metadados: { meta: { mid } },
          },
        });
      }
    }
    const texto = [evento.texto, ...avisos].filter(Boolean).join('\n');
    await this.entregar(principal ? [principal.id] : [], {
      ...base,
      mensagem: {
        idExterno: mid,
        tipo: principal?.tipo ?? 'TEXTO',
        texto: texto || (principal ? undefined : '(mensagem sem texto)'),
        arquivoId: principal?.id,
        respondeAIdExterno: evento.respondeA ?? undefined,
        recebidaEm: evento.em,
        metadados: { meta: { mid } },
      },
    });
  }

  /** `receber`, descartando o anexo salvo se a entrega falhar (o job tenta de novo). */
  private entregar(
    arquivoIds: string[],
    entrada: EntradaDeAtendimento,
  ): Promise<unknown> {
    return entregarComAnexos(this.prisma, this.arquivos, arquivoIds, () =>
      this.atendimento.receber(entrada),
    );
  }

  /**
   * Remetente do Atendimento: o PSID/IGSID, com o nome do perfil da Graph na
   * primeira mensagem (depois o identificador já liga ao contato).
   */
  private async remetente(
    canal: Canal,
    tipo: TipoCanalMeta,
    segredos: Partial<SegredosMeta>,
    id: string,
  ) {
    const conhecido = await this.prisma.contatoIdentificador.findUnique({
      where: { tipo_valor: { tipo, valor: id } },
      select: { id: true },
    });
    let nome: string | undefined;
    if (!conhecido && segredos.tokenPagina) {
      try {
        const perfil = await this.graph.obter<Record<string, unknown>>(
          segredos.tokenPagina,
          id,
          tipo === 'INSTAGRAM'
            ? ['name', 'username']
            : ['first_name', 'last_name'],
        );
        nome = nomeDoPerfil(perfil);
      } catch (erro) {
        this.logger.warn(
          `Perfil ${id} do ${ROTULO_DO_TIPO_DE_CANAL[tipo]} (${canal.nome}) não lido: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
    }
    return { tipo, valor: id, ...(nome ? { nome } : {}) };
  }

  /** Baixa e guarda o anexo; `null` se não deu (fica o aviso no texto). */
  private async salvarAnexo(
    anexo: AnexoMeta,
  ): Promise<{ id: string; tipo: TipoMensagem } | null> {
    const tipo = tipoDaMensagemDoAnexo(anexo.tipo);
    if (!tipo || !anexo.url) {
      return null;
    }
    try {
      const { conteudo, mime } = await this.graph.baixar(
        anexo.url,
        TAMANHO_MAXIMO_ANEXO_META,
      );
      const arquivo = await this.arquivos.salvar(conteudo, {
        nome: nomeDoAnexo(anexo.url, anexo.tipo),
        mime: mime?.split(';')[0]?.trim() || 'application/octet-stream',
        tamanho: conteudo.length,
        contexto: 'MENSAGEM',
        criadoPorId: null,
      });
      return { id: arquivo.id, tipo };
    } catch (erro) {
      this.logger.warn(
        `Anexo da Meta não guardado: ${erro instanceof ErroApi ? erro.mensagem : erro instanceof Error ? erro.message : String(erro)}`,
      );
      return null;
    }
  }

  /**
   * Leitura (R14): as mensagens nossas na conversa com o contato, enviadas até
   * a marca d'água (Messenger) ou até a mensagem lida (Instagram), ficam lidas.
   */
  private async marcarLidas(
    canal: Canal,
    remetente: string,
    ate: Date,
    mid: string | null,
  ): Promise<void> {
    let limite = ate;
    if (mid) {
      const lida = await this.prisma.mensagem.findUnique({
        where: { canalId_idExterno: { canalId: canal.id, idExterno: mid } },
        select: { enviadaEm: true, ocorridaEm: true },
      });
      if (lida) {
        limite = lida.enviadaEm ?? lida.ocorridaEm;
      }
    }
    const pendentes = await this.prisma.mensagem.findMany({
      where: {
        canalId: canal.id,
        direcao: 'SAIDA',
        status: { in: ['ENVIADA', 'ENTREGUE'] },
        idExterno: { not: null },
        enviadaEm: { lte: limite },
        conversa: { idExterno: remetente },
      },
      select: { idExterno: true },
      take: 200,
    });
    for (const { idExterno } of pendentes) {
      await this.atendimento.atualizarStatus(
        canal.id,
        idExterno as string,
        'LIDA',
        undefined,
        ate,
      );
    }
  }
}

function nomeDoPerfil(perfil: Record<string, unknown>): string | undefined {
  const texto = (valor: unknown) =>
    typeof valor === 'string' && valor.trim() ? valor.trim() : '';
  const nome =
    texto(perfil.name) ||
    [texto(perfil.first_name), texto(perfil.last_name)]
      .filter(Boolean)
      .join(' ') ||
    texto(perfil.username);
  return nome || undefined;
}

function nomeDoAnexo(url: string, tipo: string): string {
  try {
    const nome = decodeURIComponent(
      new URL(url).pathname.split('/').pop() ?? '',
    );
    if (/^[\w.-]{1,120}\.[a-z0-9]{2,5}$/i.test(nome)) {
      return nome;
    }
  } catch {
    // URL estranha: nome genérico.
  }
  const extensao: Record<string, string> = {
    image: 'jpg',
    sticker: 'png',
    video: 'mp4',
    ig_reel: 'mp4',
    reel: 'mp4',
    audio: 'mp4',
    file: 'bin',
  };
  return `anexo.${extensao[tipo] ?? 'bin'}`;
}

function descreverAnexo(anexo: AnexoMeta): string {
  const nomes: Record<string, string> = {
    share: 'Compartilhamento',
    story_mention: 'Menção no story',
    ig_reel: 'Reel',
    reel: 'Reel',
    location: 'Localização',
    fallback: 'Conteúdo',
  };
  const rotulo = nomes[anexo.tipo] ?? 'Anexo';
  return anexo.url ? `[${rotulo}: ${anexo.url}]` : `[${rotulo} não disponível]`;
}
