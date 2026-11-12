import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import type {
  EntradaDeAtendimento,
  MensagemDaEntrada,
  RemetenteDaEntrada,
} from '../../atendimento/entrada';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import { ErroApi } from '../../comum/erros/excecoes';
import { FilaService, type Trabalho } from '../../fila/fila.service';
import type { Canal, TipoMensagem } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { entregarComAnexos } from '../comum/anexos-soltos';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { ErroDaGraph } from '../meta/graph-api';
import {
  type ConteudoOficial,
  type EventoOficial,
  eventosDoValor,
  type RemetenteOficial,
  textoDoConteudo,
} from './eventos-oficial';
import { type SegredosOficiais } from './formato-meta';
import { GraphWhatsappOficial } from './graph-whatsapp-oficial';

/** Fila (pg-boss) das mudanças do webhook do WhatsApp oficial, processadas fora da requisição. */
export const FILA_WEBHOOK_WHATSAPP_OFICIAL = 'whatsapp-oficial.webhook';

/** Um job: uma mudança (`changes[]`) de um número. */
export interface TrabalhoDoWebhookOficial {
  canalId: string;
  /** `changes[].field` (`messages`, `calls`…). */
  campo: string;
  /** `changes[].value` como veio. */
  valor: Record<string, unknown>;
}

/** O que trata um campo do webhook (`messages`; a fatia das ligações registra `calls`). */
export type TratadorDeCampo = (
  canal: Canal,
  valor: Record<string, unknown>,
  segredos: Partial<SegredosOficiais>,
) => Promise<void>;

/** O que trata a resposta do cliente ao pedido de permissão para ligar (a fatia das ligações registra). */
export type TratadorDePermissaoDeLigacao = (
  canal: Canal,
  remetente: RemetenteOficial,
  resposta: Extract<ConteudoOficial, { tipo: 'permissao_de_ligacao' }>,
  mensagem: { id: string; em: Date },
) => Promise<void>;

/** Tamanho do status esperado de uma mensagem nossa que ainda não foi gravada (corrida com o envio). */
const ESPERA_PELO_ENVIO_MS = 2 * 60 * 1000;

const ATOR = { tipoAtor: 'SISTEMA' as const, descricao: 'WhatsApp oficial' };

/** Nome do arquivo de uma mídia recebida, quando a Meta não manda. */
const EXTENSAO_POR_TIPO: Readonly<Partial<Record<TipoMensagem, string>>> = {
  IMAGEM: 'jpg',
  AUDIO: 'ogg',
  VIDEO: 'mp4',
  DOCUMENTO: 'bin',
  FIGURINHA: 'webp',
};

/** A extensão segue o tipo real da mídia (a Meta converte imagens, por exemplo); o tipo da mensagem é só o plano B. */
const EXTENSAO_POR_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

/** `5511988887777` <-> `551188887777`: a outra forma de um celular brasileiro (com ou sem o nono dígito). */
export function outraFormaDoCelularBr(telefone: string): string | null {
  const comNove = /^55(\d{2})9(\d{8})$/.exec(telefone);
  if (comNove) {
    return `55${comNove[1]}${comNove[2]}`;
  }
  const semNove = /^55(\d{2})([6-9]\d{7})$/.exec(telefone);
  return semNove ? `55${semNove[1]}9${semNove[2]}` : null;
}

/**
 * Processa o que o webhook do WhatsApp oficial entregou (R28). O roteamento é
 * por **campo** (`changes[].field`): `messages` é tratado aqui; outro módulo
 * (ligações, campo `calls`) acrescenta o seu com `registrarCampo` — campo sem
 * tratador é ignorado com log em nível debug.
 *
 * `messages`:
 *
 * - mensagem do contato → `AtendimentoService.receber` (mesmas regras de filas,
 *   distribuição, SLA, horário, chatbot e automações dos outros canais), com
 *   idempotência pelo wamid (`mensagens.id_externo`); a mídia é baixada para o
 *   MinIO (`ArquivosService`);
 * - contato: telefone (E.164 só com dígitos, o mesmo do Baileys — a mesma
 *   pessoa fala pelos dois canais) ou, quando a Meta o omite, o BSUID; se o
 *   telefone aparecer depois, os dois identificadores ficam no mesmo contato;
 * - status `sent`/`delivered`/`read`/`failed` → `atualizarStatus` (o motivo da
 *   falha em português).
 */
@Injectable()
export class EntradaWhatsappOficialService implements OnModuleInit {
  private readonly logger = new Logger('WhatsAppOficial');
  private readonly tratadores = new Map<string, TratadorDeCampo>();
  private tratadorDePermissao: TratadorDePermissaoDeLigacao | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly atendimento: AtendimentoService,
    private readonly arquivos: ArquivosService,
    private readonly graph: GraphWhatsappOficial,
    private readonly segredos: SegredosDoCanal,
  ) {
    this.registrarCampo('messages', (canal, valor, segredosDoCanal) =>
      this.tratarMensagens(canal, valor, segredosDoCanal),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar<TrabalhoDoWebhookOficial>(
      FILA_WEBHOOK_WHATSAPP_OFICIAL,
      (trabalho) => this.processar(trabalho),
      {
        concorrencia: 1,
        // Ligação que toca não espera 2 s para o aviso chegar ao atendente.
        intervaloDeConsultaSegundos: 1,
        tentativas: 5,
        intervaloEntreTentativasSegundos: 10,
        esperaExponencial: true,
        guardarConcluidosPorSegundos: 24 * 3600,
      },
    );
  }

  /** Registra o tratador de um campo do webhook (`calls`, na fatia das ligações). */
  registrarCampo(campo: string, tratador: TratadorDeCampo): void {
    this.tratadores.set(campo, tratador);
  }

  /** Registra quem trata a resposta ao pedido de permissão para ligar (`interactive.call_permission_reply`). */
  registrarPermissaoDeLigacao(tratador: TratadorDePermissaoDeLigacao): void {
    this.tratadorDePermissao = tratador;
  }

  /**
   * Antes de a Atendimento ver o remetente: liga o BSUID e a outra forma do
   * celular brasileiro ao contato que já existe (as ligações usam o mesmo contato único).
   */
  async prepararContato(
    telefone: string | null,
    bsuid: string | null,
  ): Promise<void> {
    await this.ligarBsuidAoContatoDoTelefone(telefone, bsuid);
    await this.ligarTelefoneBrasileiroAoContato(telefone);
  }

  /** Depois de o contato existir: guarda o BSUID dele (se for de ninguém). */
  async registrarBsuid(conversaId: string, bsuid: string): Promise<void> {
    await this.guardarBsuid(conversaId, bsuid);
  }

  /** O campo tem tratador? (o recebimento só enfileira o que alguém trata). */
  trataCampo(campo: string): boolean {
    return this.tratadores.has(campo);
  }

  /** O job: entrega a mudança ao tratador do campo. */
  async processar(trabalho: Trabalho<TrabalhoDoWebhookOficial>): Promise<void> {
    const { canalId, campo, valor } = trabalho.dados;
    const canal = await this.prisma.canal.findFirst({
      where: { id: canalId, excluidoEm: null },
    });
    if (!canal || !canal.ativo || canal.tipo !== 'WHATSAPP_OFICIAL') {
      return;
    }
    const tratador = this.tratadores.get(campo);
    if (!tratador) {
      this.logger.debug?.(
        `Campo "${campo}" do webhook sem tratador: ignorado.`,
      );
      return;
    }
    const segredos = await this.segredos.ler<SegredosOficiais>(canal);
    await executarComoAtor(ATOR, () => tratador(canal, valor, segredos));
  }

  // -------------------------------------------------------------------------
  // Campo `messages`
  // -------------------------------------------------------------------------

  private async tratarMensagens(
    canal: Canal,
    valor: Record<string, unknown>,
    segredos: Partial<SegredosOficiais>,
  ): Promise<void> {
    for (const evento of eventosDoValor(valor)) {
      if (evento.tipo === 'mensagem') {
        await this.receberMensagem(canal, segredos, evento);
      } else {
        await this.aplicarStatus(canal, evento);
      }
    }
  }

  private async aplicarStatus(
    canal: Canal,
    evento: Extract<EventoOficial, { tipo: 'status' }>,
  ): Promise<void> {
    const conhecida = await this.prisma.mensagem.findUnique({
      where: { canalId_idExterno: { canalId: canal.id, idExterno: evento.id } },
      select: { id: true },
    });
    if (!conhecida) {
      // O pedido de permissão para ligar (R29.4) não vira mensagem da conversa: o wamid fica
      // só no registro da permissão, e os status dele não têm onde ser aplicados.
      const pedido = await this.prisma.permissaoDeLigacao.findFirst({
        where: { canalId: canal.id, ultimoPedidoMensagemId: evento.id },
        select: { id: true },
      });
      if (pedido) {
        if (evento.status === 'FALHOU') {
          this.logger.warn(
            `O pedido de permissão para ligar ${evento.id} falhou na entrega (${evento.erro ?? 'sem detalhe'}).`,
          );
        }
        return;
      }
      // O status pode chegar antes de o envio gravar o wamid: o job tenta de novo.
      if (Date.now() - evento.em.getTime() < ESPERA_PELO_ENVIO_MS) {
        throw new Error(
          `Status ${evento.status} de uma mensagem ainda não gravada (${evento.id}).`,
        );
      }
      return;
    }
    await this.atendimento.atualizarStatus(
      canal.id,
      evento.id,
      evento.status,
      evento.erro ?? undefined,
      evento.em,
    );
  }

  /**
   * Uma mensagem do contato. Idempotente pelo wamid: se já entrou, não baixa a
   * mídia de novo. A mídia é salva antes e descartada se a entrega falhar.
   */
  private async receberMensagem(
    canal: Canal,
    segredos: Partial<SegredosOficiais>,
    evento: Extract<EventoOficial, { tipo: 'mensagem' }>,
  ): Promise<void> {
    if (evento.conteudo.tipo === 'permissao_de_ligacao') {
      // Não é mensagem da conversa: atualiza a permissão de ligação do contato (R29.4).
      await this.tratadorDePermissao?.(
        canal,
        evento.remetente,
        evento.conteudo,
        {
          id: evento.id,
          em: evento.em,
        },
      );
      return;
    }
    const repetida = await this.prisma.mensagem.findUnique({
      where: { canalId_idExterno: { canalId: canal.id, idExterno: evento.id } },
      select: { id: true },
    });
    if (repetida) {
      return;
    }
    const { telefone, bsuid, nome } = evento.remetente;
    if (!telefone && !bsuid) {
      this.logger.warn(
        `Mensagem ${evento.id} sem telefone nem BSUID do remetente: ignorada.`,
      );
      return;
    }
    await this.prepararContato(telefone, bsuid);
    const remetente: RemetenteDaEntrada = telefone
      ? { tipo: 'WHATSAPP', valor: telefone, ...(nome ? { nome } : {}) }
      : {
          tipo: 'WHATSAPP_BSUID',
          valor: bsuid as string,
          ...(nome ? { nome } : {}),
        };
    const arquivoIds: string[] = [];
    const mensagem = await this.montarMensagem(segredos, evento, arquivoIds);
    const entrada: EntradaDeAtendimento = {
      canalId: canal.id,
      remetente,
      idExternoConversa: telefone ?? (bsuid as string),
      mensagem,
    };
    const resultado = await entregarComAnexos(
      this.prisma,
      this.arquivos,
      arquivoIds,
      () => this.atendimento.receber(entrada),
    );
    if (telefone && bsuid) {
      await this.guardarBsuid(resultado.conversaId, bsuid);
    }
  }

  private async montarMensagem(
    segredos: Partial<SegredosOficiais>,
    evento: Extract<EventoOficial, { tipo: 'mensagem' }>,
    arquivoIds: string[],
  ): Promise<MensagemDaEntrada> {
    const { conteudo } = evento;
    const base = {
      idExterno: evento.id,
      recebidaEm: evento.em,
      ...(evento.respondeAId ? { respondeAIdExterno: evento.respondeAId } : {}),
    };
    switch (conteudo.tipo) {
      case 'texto':
        return { ...base, tipo: 'TEXTO', texto: conteudo.corpo };
      case 'midia': {
        const salvo = await this.baixarMidia(segredos, conteudo, evento.id);
        if (!salvo) {
          return {
            ...base,
            tipo: 'TEXTO',
            texto: [conteudo.legenda, '[Mídia não disponível]']
              .filter(Boolean)
              .join('\n'),
            metadados: { midiaIndisponivel: true },
          };
        }
        arquivoIds.push(salvo);
        return {
          ...base,
          tipo: conteudo.tipoMensagem,
          arquivoId: salvo,
          ...(conteudo.legenda ? { texto: conteudo.legenda } : {}),
          metadados: {
            ...(conteudo.nomeArquivo
              ? { nomeArquivo: conteudo.nomeArquivo }
              : {}),
            ...(conteudo.voz ? { voz: true } : {}),
            ...(conteudo.animada ? { animada: true } : {}),
          },
        };
      }
      case 'localizacao':
        return {
          ...base,
          tipo: 'LOCALIZACAO',
          texto: textoDoConteudo(conteudo) ?? undefined,
          metadados: semNulos({
            latitude: conteudo.latitude,
            longitude: conteudo.longitude,
            nome: conteudo.nome,
            endereco: conteudo.endereco,
          }),
        };
      case 'contatos':
        return {
          ...base,
          tipo: 'CONTATO',
          texto: textoDoConteudo(conteudo) ?? undefined,
          metadados:
            conteudo.contatos.length === 1
              ? semNulos({
                  nome: conteudo.contatos[0]?.nome ?? null,
                  vcard: conteudo.contatos[0]?.vcard ?? null,
                  telefones: conteudo.contatos[0]?.telefones ?? [],
                })
              : {
                  contatos: conteudo.contatos.map((contato) =>
                    semNulos({ nome: contato.nome, vcard: contato.vcard }),
                  ),
                },
        };
      case 'interativo':
        return {
          ...base,
          tipo: 'TEXTO',
          texto: conteudo.titulo || '(resposta sem texto)',
          metadados: {
            interativo: semNulos({
              origem: conteudo.origem,
              id: conteudo.id,
              titulo: conteudo.titulo,
              descricao: conteudo.descricao,
            }),
          },
        };
      case 'reacao':
        return {
          ...base,
          tipo: 'REACAO',
          texto: conteudo.emoji,
          ...(conteudo.mensagemAlvo
            ? { respondeAIdExterno: conteudo.mensagemAlvo }
            : {}),
          metadados: semNulos({
            emoji: conteudo.emoji,
            alvoIdExterno: conteudo.mensagemAlvo,
            removida: conteudo.emoji ? null : true,
          }),
        };
      case 'permissao_de_ligacao':
        // Tratada antes (`receberMensagem`): nunca chega aqui.
        return {
          ...base,
          tipo: 'TEXTO',
          texto: textoDoConteudo(conteudo) ?? undefined,
        };
      case 'nao_suportado':
        return {
          ...base,
          tipo: 'TEXTO',
          texto: textoDoConteudo(conteudo) ?? undefined,
          metadados: { tipoOriginal: conteudo.tipoOriginal },
        };
    }
  }

  /**
   * Baixa a mídia (`GET /{media_id}` + `GET url` com Bearer) e guarda no MinIO.
   * Falha passageira da Meta relança (o job tenta de novo; o id da mídia vale 7
   * dias); falha definitiva (mídia expirada, tipo recusado) devolve `null` e a
   * conversa mostra "mídia não disponível".
   */
  private async baixarMidia(
    segredos: Partial<SegredosOficiais>,
    conteudo: Extract<ConteudoOficial, { tipo: 'midia' }>,
    idDaMensagem: string,
  ): Promise<string | null> {
    if (!conteudo.mediaId || !segredos.token) {
      return null;
    }
    try {
      const { conteudo: bytes, mime } = await this.graph.baixarMidia(
        { token: segredos.token, appSecret: segredos.appSecret },
        conteudo.mediaId,
      );
      const tipoMime =
        mime?.split(';')[0]?.trim() ||
        conteudo.mime?.split(';')[0]?.trim() ||
        'application/octet-stream';
      const extensao =
        EXTENSAO_POR_MIME[tipoMime] ??
        EXTENSAO_POR_TIPO[conteudo.tipoMensagem] ??
        'bin';
      const arquivo = await this.arquivos.salvar(bytes, {
        nome:
          conteudo.nomeArquivo ??
          `${conteudo.tipoMensagem.toLowerCase()}-${idDaMensagem.slice(-8)}.${extensao}`,
        mime: tipoMime,
        tamanho: bytes.length,
        contexto: 'MENSAGEM',
        criadoPorId: null,
      });
      return arquivo.id;
    } catch (erro) {
      if (erro instanceof ErroDaGraph && erro.passageiro) {
        throw erro;
      }
      this.logger.warn(
        `Mídia ${conteudo.mediaId} não guardada: ${erro instanceof ErroApi ? erro.mensagem : erro instanceof Error ? erro.message : String(erro)}`,
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // BSUID
  // -------------------------------------------------------------------------

  /**
   * Antes de entregar: se o BSUID já é de um contato (que só o tinha) e o
   * telefone que apareceu agora ainda não é de ninguém, o telefone passa a ser
   * identificador desse mesmo contato — assim o Atendimento o acha pelo telefone
   * e não cria um segundo contato.
   */
  private async ligarBsuidAoContatoDoTelefone(
    telefone: string | null,
    bsuid: string | null,
  ): Promise<void> {
    if (!telefone || !bsuid) {
      return;
    }
    const doBsuid = await this.prisma.contatoIdentificador.findUnique({
      where: { tipo_valor: { tipo: 'WHATSAPP_BSUID', valor: bsuid } },
      include: {
        contato: { select: { id: true, telefone: true, excluidoEm: true } },
      },
    });
    if (!doBsuid || doBsuid.contato.excluidoEm) {
      return;
    }
    const doTelefone = await this.prisma.contatoIdentificador.findUnique({
      where: { tipo_valor: { tipo: 'WHATSAPP', valor: telefone } },
      select: { contatoId: true },
    });
    if (doTelefone) {
      if (doTelefone.contatoId !== doBsuid.contatoId) {
        this.logger.warn(
          `O telefone e o BSUID de uma mensagem pertencem a contatos diferentes (${doTelefone.contatoId} e ${doBsuid.contatoId}): a deduplicação de contatos resolve.`,
        );
      }
      return;
    }
    const donoDoTelefone = await this.prisma.contato.findFirst({
      where: { telefone, excluidoEm: null },
      select: { id: true },
    });
    if (donoDoTelefone && donoDoTelefone.id !== doBsuid.contatoId) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.contatoIdentificador.create({
        data: {
          contatoId: doBsuid.contatoId,
          tipo: 'WHATSAPP',
          valor: telefone,
          canalId: doBsuid.canalId,
          ultimoUsoEm: new Date(),
        },
      });
      if (!doBsuid.contato.telefone) {
        await tx.contato.update({
          where: { id: doBsuid.contatoId },
          data: { telefone },
        });
      }
    });
  }

  /**
   * Celular brasileiro com e sem o nono dígito (`5511988887777` x `551188887777`):
   * a Meta pode mandar o `wa_id` de um jeito e o contato estar cadastrado do outro.
   * Se o telefone recebido ainda não é de ninguém e a outra forma é de um contato,
   * o telefone recebido passa a ser identificador desse contato (o Atendimento o
   * acha pelo identificador e não cria um segundo contato).
   */
  private async ligarTelefoneBrasileiroAoContato(
    telefone: string | null,
  ): Promise<void> {
    const outraForma = telefone ? outraFormaDoCelularBr(telefone) : null;
    if (!telefone || !outraForma) {
      return;
    }
    const jaTemDono =
      (await this.prisma.contatoIdentificador.findUnique({
        where: { tipo_valor: { tipo: 'WHATSAPP', valor: telefone } },
        select: { contatoId: true },
      })) ??
      (await this.prisma.contato.findFirst({
        where: { telefone, excluidoEm: null },
        select: { id: true },
      }));
    if (jaTemDono) {
      return;
    }
    const doOutro =
      (await this.prisma.contatoIdentificador.findUnique({
        where: { tipo_valor: { tipo: 'WHATSAPP', valor: outraForma } },
        select: { contatoId: true, contato: { select: { excluidoEm: true } } },
      })) ?? null;
    let contatoId =
      doOutro && !doOutro.contato.excluidoEm ? doOutro.contatoId : null;
    if (!contatoId) {
      contatoId =
        (
          await this.prisma.contato.findFirst({
            where: { telefone: outraForma, excluidoEm: null },
            select: { id: true },
          })
        )?.id ?? null;
    }
    if (!contatoId) {
      return;
    }
    await this.prisma.contatoIdentificador.create({
      data: {
        contatoId,
        tipo: 'WHATSAPP',
        valor: telefone,
        ultimoUsoEm: new Date(),
      },
    });
  }

  /** Depois de entregar: o contato da conversa passa a ter também o BSUID (se for de ninguém). */
  private async guardarBsuid(conversaId: string, bsuid: string): Promise<void> {
    const conversa = await this.prisma.conversa.findUnique({
      where: { id: conversaId },
      select: { contatoId: true, canalId: true },
    });
    if (!conversa) {
      return;
    }
    const existente = await this.prisma.contatoIdentificador.findUnique({
      where: { tipo_valor: { tipo: 'WHATSAPP_BSUID', valor: bsuid } },
      select: { contatoId: true },
    });
    if (existente) {
      return;
    }
    await this.prisma.contatoIdentificador
      .create({
        data: {
          contatoId: conversa.contatoId,
          tipo: 'WHATSAPP_BSUID',
          valor: bsuid,
          canalId: conversa.canalId,
          ultimoUsoEm: new Date(),
        },
      })
      .catch((erro: unknown) => {
        this.logger.warn(
          `BSUID não ligado ao contato: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      });
  }
}

/** Objeto sem as chaves nulas (os metadados ficam enxutos). */
function semNulos(valor: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(valor).filter(
      ([, item]) => item !== null && item !== undefined,
    ),
  );
}
