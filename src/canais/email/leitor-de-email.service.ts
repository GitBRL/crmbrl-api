import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import { AtendimentoService } from '../../atendimento/atendimento.service';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { descreverTamanho } from '../../arquivos/politica';
import { executarComoAtor } from '../../comum/contexto/contexto-requisicao';
import { ErroApi } from '../../comum/erros/excecoes';
import { FilaService } from '../../fila/fila.service';
import type { Canal, TipoMensagem } from '../../generated/prisma/client';
import { LogsTecnicosService } from '../../logs/logs-tecnicos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfiguracaoDeCanais } from '../comum/configuracao-de-canais.service';
import { entregarComAnexos } from '../comum/anexos-soltos';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import {
  type ConfiguracaoEmail,
  type EstadoEmail,
  lerConfiguracaoEmail,
  lerEstadoEmail,
  type SegredosEmail,
} from './configuracao-email';
import { criarClienteImap, traduzirErroDeEmail } from './conexoes-email';
import {
  type EmailInterpretado,
  interpretarEmail,
  lerEmail,
} from './interpretacao-email';

/** Fila (pg-boss) da varredura das caixas, agendada a cada minuto. */
export const FILA_VARRER_EMAIL = 'email.varrer';

/** Ator das entradas por e-mail (auditoria, outbox). */
export const ATOR_DO_EMAIL = {
  tipoAtor: 'SISTEMA',
  descricao: 'E-mail',
} as const;

/** Mensagens importadas por canal em cada varredura (o resto fica para a próxima). */
const MENSAGENS_POR_VARREDURA = 50;
/** E-mails maiores que isto não são baixados (só o aviso entra na conversa). */
export const TAMANHO_MAXIMO_EMAIL_BYTES = 30 * 1024 * 1024;
/** Anexos importados por e-mail. */
const ANEXOS_POR_EMAIL = 10;
/** Folga para o relógio do servidor de e-mail na primeira varredura. */
const FOLGA_DA_PRIMEIRA_VARREDURA_MS = 60_000;
/** Erros repetidos do mesmo canal vão para os logs técnicos no máximo uma vez neste intervalo. */
const INTERVALO_DO_LOG_DE_ERRO_MS = 60 * 60_000;

/** Resultado da varredura de um canal (testes, diagnóstico). */
export interface ResultadoDaVarredura {
  importadas: number;
  ignoradas: number;
  erro: string | null;
}

/**
 * Leitura das caixas de e-mail (§2.5, R14): a cada minuto (job
 * `email.varrer`), cada canal de e-mail ativo é lido pelo IMAP a partir do
 * último UID importado — só mensagens novas (na primeira vez, as que chegaram
 * depois da criação do canal). Cada e-mail vira mensagens do Atendimento: o
 * texto (sem HTML, sem a citação da anterior) e uma mensagem por anexo
 * (salvo pelo `ArquivosService`), encadeadas pelo Message-ID/In-Reply-To.
 * Idempotente pelo Message-ID (o mesmo e-mail não entra duas vezes).
 */
@Injectable()
export class LeitorDeEmail implements OnModuleInit {
  private readonly logger = new Logger('Email');
  /** Canais sendo lidos agora (uma varredura por canal de cada vez). */
  private readonly emLeitura = new Set<string>();
  private readonly ultimoLogDeErro = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly atendimento: AtendimentoService,
    private readonly arquivos: ArquivosService,
    private readonly segredos: SegredosDoCanal,
    private readonly configuracao: ConfiguracaoDeCanais,
    private readonly logs: LogsTecnicosService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.fila.trabalhar(FILA_VARRER_EMAIL, () => this.varrerTodos(), {
      concorrencia: 1,
      tentativas: 0,
      prazoDeExecucaoSegundos: 600,
      guardarConcluidosPorSegundos: 3600,
    });
    await this.fila.agendar(FILA_VARRER_EMAIL, '* * * * *');
  }

  /**
   * Marca o ponto de partida da leitura (o UID atual da pasta): só o que
   * chegar depois entra no Atendimento. Chamado ao criar o canal ou trocar a
   * caixa; se o IMAP não responde agora, a primeira varredura usa a data.
   */
  async marcarInicio(canal: Canal): Promise<boolean> {
    const config = lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const { senhaImap } =
      this.segredos.lerSemFalhar<SegredosEmail>(canal) ?? {};
    if (!config.imap.host || !senhaImap) {
      return false;
    }
    const cliente = criarClienteImap(config, senhaImap);
    cliente.on('error', () => undefined);
    try {
      await cliente.connect();
      const caixa = await cliente.mailboxOpen(config.imap.pasta, {
        readOnly: true,
      });
      await this.configuracao.atualizarEstado(canal.id, {
        uidValidity: String(caixa.uidValidity),
        ultimoUid: Math.max(0, (caixa.uidNext ?? 1) - 1),
        ultimaVarreduraEm: new Date().toISOString(),
      } satisfies EstadoEmail);
      return true;
    } catch {
      return false;
    } finally {
      await cliente.logout().catch(() => cliente.close());
    }
  }

  /** Lê todos os canais de e-mail ativos, um de cada vez. */
  async varrerTodos(): Promise<void> {
    const canais = await this.prisma.canal.findMany({
      where: { tipo: 'EMAIL', ativo: true, excluidoEm: null },
      orderBy: { criadoEm: 'asc' },
    });
    for (const canal of canais) {
      await this.varrerCanal(canal);
    }
  }

  /** Lê as mensagens novas de um canal. Nunca lança: o erro fica no canal. */
  async varrerCanal(canal: Canal): Promise<ResultadoDaVarredura> {
    if (this.emLeitura.has(canal.id)) {
      return { importadas: 0, ignoradas: 0, erro: null };
    }
    this.emLeitura.add(canal.id);
    try {
      const resultado = await this.ler(canal);
      await this.configuracao.registrarErro(canal.id, null);
      return { ...resultado, erro: null };
    } catch (erro) {
      const mensagem =
        erro instanceof ErroApi
          ? erro.mensagem
          : traduzirErroDeEmail(erro, 'IMAP').mensagem;
      await this.configuracao.registrarErro(canal.id, mensagem);
      await this.registrarFalha(canal, mensagem, erro);
      return { importadas: 0, ignoradas: 0, erro: mensagem };
    } finally {
      this.emLeitura.delete(canal.id);
    }
  }

  private async ler(
    canal: Canal,
  ): Promise<{ importadas: number; ignoradas: number }> {
    const config = lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const { senhaImap } = await this.segredos.ler<SegredosEmail>(canal);
    if (!config.imap.host || !senhaImap) {
      throw new ErroApi(
        400,
        'dados_invalidos',
        'Configure o servidor IMAP e a senha do canal para ler as mensagens.',
      );
    }
    const cliente = criarClienteImap(config, senhaImap);
    cliente.on('error', (erro: unknown) =>
      this.logger.warn(
        `IMAP do canal "${canal.nome}": ${erro instanceof Error ? erro.message : String(erro)}`,
      ),
    );
    await cliente.connect();
    let importadas = 0;
    let ignoradas = 0;
    try {
      const trava = await cliente.getMailboxLock(config.imap.pasta, {
        readOnly: true,
      });
      try {
        const caixa = cliente.mailbox;
        if (!caixa) {
          throw new Error('Pasta não aberta.');
        }
        const uidValidity = String(caixa.uidValidity);
        const estado = lerEstadoEmail(canal.estado);
        const pendentes = await this.listarNovas(
          cliente,
          canal,
          estado,
          uidValidity,
        );
        let ultimoUid =
          estado.uidValidity === uidValidity ? (estado.ultimoUid ?? 0) : 0;
        for (const pendente of pendentes.slice(0, MENSAGENS_POR_VARREDURA)) {
          const importou = await this.importarSemTravar(
            cliente,
            canal,
            config,
            pendente,
          );
          if (importou) {
            importadas++;
          } else {
            ignoradas++;
          }
          ultimoUid = Math.max(ultimoUid, pendente.uid);
          await this.configuracao.atualizarEstado(canal.id, {
            uidValidity,
            ultimoUid,
          } satisfies EstadoEmail);
        }
        await this.configuracao.atualizarEstado(canal.id, {
          uidValidity,
          ultimoUid: Math.max(
            ultimoUid,
            pendentes.length === 0 ? (caixa.uidNext ?? 1) - 1 : ultimoUid,
          ),
          ultimaVarreduraEm: new Date().toISOString(),
        } satisfies EstadoEmail);
      } finally {
        trava.release();
      }
    } finally {
      await cliente.logout().catch(() => cliente.close());
    }
    return { importadas, ignoradas };
  }

  /**
   * UIDs a importar, em ordem. Com cursor válido, os maiores que o último;
   * sem cursor (primeira leitura, ou a pasta foi recriada), os que chegaram
   * depois da criação do canal (ou da última varredura).
   */
  private async listarNovas(
    cliente: ImapFlow,
    canal: Canal,
    estado: EstadoEmail,
    uidValidity: string,
  ): Promise<Array<{ uid: number; tamanho: number; chegada: Date | null }>> {
    const comCursor =
      estado.uidValidity === uidValidity && estado.ultimoUid !== undefined;
    const lista: Array<{ uid: number; tamanho: number; chegada: Date | null }> =
      [];
    if (comCursor) {
      const ultimo = estado.ultimoUid ?? 0;
      for await (const item of cliente.fetch(
        `${ultimo + 1}:*`,
        { uid: true, size: true, internalDate: true },
        { uid: true },
      )) {
        if (item.uid > ultimo) {
          lista.push({
            uid: item.uid,
            tamanho: item.size ?? 0,
            chegada: dataDe(item.internalDate),
          });
        }
      }
    } else {
      const desde = new Date(
        (estado.ultimaVarreduraEm
          ? new Date(estado.ultimaVarreduraEm).getTime()
          : canal.criadoEm.getTime()) - FOLGA_DA_PRIMEIRA_VARREDURA_MS,
      );
      const uids =
        (await cliente.search({ since: desde }, { uid: true })) || [];
      if (uids.length > 0) {
        for await (const item of cliente.fetch(
          uids.join(','),
          { uid: true, size: true, internalDate: true },
          { uid: true },
        )) {
          const chegada = dataDe(item.internalDate);
          if (!chegada || chegada >= desde) {
            lista.push({ uid: item.uid, tamanho: item.size ?? 0, chegada });
          }
        }
      }
    }
    return lista.sort((a, b) => a.uid - b.uid);
  }

  /**
   * Como `importar`, mas um e-mail com dados recusados (4xx: remetente
   * inválido, anexo recusado…) é pulado e registrado, para não travar a caixa;
   * falha passageira (banco, rede) interrompe a varredura (tenta de novo na próxima).
   */
  private async importarSemTravar(
    cliente: ImapFlow,
    canal: Canal,
    config: ConfiguracaoEmail,
    pendente: { uid: number; tamanho: number; chegada: Date | null },
  ): Promise<boolean> {
    try {
      return await this.importar(cliente, canal, config, pendente);
    } catch (erro) {
      if (erro instanceof ErroApi && erro.getStatus() < 500) {
        await this.logs.aviso(
          'Email',
          `E-mail UID ${pendente.uid} do canal "${canal.nome}" não importado: ${erro.mensagem}`,
          { canalId: canal.id, uid: pendente.uid },
        );
        return false;
      }
      throw erro;
    }
  }

  /** Baixa, interpreta e entrega um e-mail ao Atendimento. `false` = ignorado. */
  private async importar(
    cliente: ImapFlow,
    canal: Canal,
    config: ConfiguracaoEmail,
    pendente: { uid: number; tamanho: number; chegada: Date | null },
  ): Promise<boolean> {
    if (pendente.tamanho > TAMANHO_MAXIMO_EMAIL_BYTES) {
      const envelope = await cliente.fetchOne(
        String(pendente.uid),
        { envelope: true },
        { uid: true },
      );
      // Como em `contatoDoEmail`: quem recebe a resposta (Reply-To ou remetente).
      if (!envelope) {
        return false;
      }
      const endereco =
        envelope.envelope?.replyTo?.[0] ?? envelope.envelope?.from?.[0];
      const de = endereco?.address?.trim().toLowerCase();
      if (!de || de === config.endereco.toLowerCase()) {
        return false;
      }
      await this.entregarAviso(canal, {
        messageId: envelope.envelope?.messageId ?? `imap:${pendente.uid}`,
        de,
        nome: endereco?.name || null,
        assunto: envelope.envelope?.subject ?? null,
        chegada: pendente.chegada,
        tamanho: pendente.tamanho,
      });
      return true;
    }
    const mensagem = await cliente.fetchOne(
      String(pendente.uid),
      { source: true },
      { uid: true },
    );
    if (!mensagem || !mensagem.source) {
      return false;
    }
    return this.processar(canal, mensagem.source, {
      chegada: pendente.chegada,
      uid: pendente.uid,
      config,
    });
  }

  /**
   * Processa o conteúdo bruto (RFC 822) de um e-mail recebido pelo canal.
   * Público para os testes e para reprocessar um e-mail guardado.
   */
  async processar(
    canal: Canal,
    bruto: Buffer,
    opcoes: {
      chegada?: Date | null;
      uid?: number;
      config?: ConfiguracaoEmail;
    } = {},
  ): Promise<boolean> {
    const config =
      opcoes.config ??
      lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const lido = await lerEmail(bruto);
    const email = interpretarEmail(lido);
    const nosso = config.endereco.toLowerCase();
    const contato = contatoDoEmail(email);
    if (
      !email.de ||
      !contato ||
      email.de.email === nosso ||
      contato.email === nosso
    ) {
      // Sem remetente, ou cópia de uma resposta nossa: não é do contato.
      return false;
    }
    const messageId =
      email.messageId ?? `imap:${canal.id}:${opcoes.uid ?? Date.now()}`;
    const recebidaEm = opcoes.chegada ?? email.data ?? new Date();
    const anexos = lido.attachments
      .filter((anexo) => !anexo.related)
      .slice(0, ANEXOS_POR_EMAIL);
    const metadados = metadadosDoEmail(email, messageId);
    const idDoAnexo = (indice: number) => `${messageId}#anexo-${indice + 1}`;
    // Reimportação (a varredura caiu no meio): o que já entrou não é salvo de novo.
    const jaImportados = new Set(
      (
        await this.prisma.mensagem.findMany({
          where: {
            canalId: canal.id,
            idExterno: {
              in: [messageId, ...anexos.map((_, i) => idDoAnexo(i))],
            },
          },
          select: { idExterno: true },
        })
      ).map(({ idExterno }) => idExterno),
    );

    const avisos: string[] = [];
    const salvos: Array<{ indice: number; id: string; mime: string }> = [];
    for (const [indice, anexo] of anexos.entries()) {
      if (jaImportados.has(idDoAnexo(indice))) {
        continue;
      }
      const nome = anexo.filename?.trim() || 'anexo';
      try {
        const arquivo = await this.arquivos.salvar(anexo.content, {
          nome,
          mime: anexo.contentType || 'application/octet-stream',
          tamanho: anexo.size,
          contexto: 'MENSAGEM',
          criadoPorId: null,
        });
        salvos.push({ indice, id: arquivo.id, mime: arquivo.mime });
      } catch (erro) {
        avisos.push(
          `[Anexo "${nome}" não importado: ${erro instanceof ErroApi ? erro.mensagem : 'falha ao guardar o arquivo'}]`,
        );
      }
    }
    if (lido.attachments.length > anexos.length) {
      avisos.push(
        `[${lido.attachments.length - anexos.length} anexo(s) a mais não importado(s): veja o e-mail na caixa de entrada]`,
      );
    }

    const texto = [email.texto, ...avisos].filter(Boolean).join('\n\n');
    const comTexto = Boolean(texto) || anexos.length === 0;
    if (
      (!comTexto || jaImportados.has(messageId)) &&
      salvos.length === 0 &&
      jaImportados.size > 0
    ) {
      return false;
    }
    const remetente = {
      tipo: 'EMAIL' as const,
      valor: contato.email,
      nome: contato.nome ?? undefined,
    };
    const daConversa = {
      canalId: canal.id,
      remetente,
      idExternoConversa: email.raiz ?? messageId,
      assunto: email.assuntoLimpo ?? undefined,
    };
    await entregarComAnexos(
      this.prisma,
      this.arquivos,
      salvos.map(({ id }) => id),
      () =>
        executarComoAtor(ATOR_DO_EMAIL, async () => {
          if (comTexto) {
            await this.atendimento.receber({
              ...daConversa,
              mensagem: {
                idExterno: messageId,
                tipo: 'TEXTO',
                texto: texto || '(e-mail sem texto)',
                respondeAIdExterno: email.inReplyTo ?? undefined,
                recebidaEm,
                metadados,
              },
            });
          }
          for (const { indice, id, mime } of salvos) {
            await this.atendimento.receber({
              ...daConversa,
              mensagem: {
                idExterno: idDoAnexo(indice),
                tipo: tipoDoAnexo(mime),
                arquivoId: id,
                recebidaEm: new Date(recebidaEm.getTime() + indice + 1),
                metadados: { email: { messageId, anexoDe: messageId } },
              },
            });
          }
        }),
    );
    return true;
  }

  /** E-mail grande demais: entra só o aviso, com o remetente e o assunto. */
  private async entregarAviso(
    canal: Canal,
    dados: {
      messageId: string;
      de: string;
      nome: string | null;
      assunto: string | null;
      chegada: Date | null;
      tamanho: number;
    },
  ): Promise<void> {
    const messageId = dados.messageId.replace(/^<|>$/g, '');
    await executarComoAtor(ATOR_DO_EMAIL, () =>
      this.atendimento.receber({
        canalId: canal.id,
        remetente: {
          tipo: 'EMAIL',
          valor: dados.de,
          nome: dados.nome ?? undefined,
        },
        idExternoConversa: messageId,
        assunto: dados.assunto ?? undefined,
        mensagem: {
          idExterno: messageId,
          tipo: 'TEXTO',
          texto: `[E-mail de ${descreverTamanho(dados.tamanho)} grande demais para importar: veja na caixa de entrada.]`,
          recebidaEm: dados.chegada ?? new Date(),
          metadados: {
            email: {
              messageId,
              de: dados.de,
              assunto: dados.assunto,
              grandeDemais: true,
            },
          },
        },
      }),
    );
  }

  private async registrarFalha(
    canal: Canal,
    mensagem: string,
    erro: unknown,
  ): Promise<void> {
    const agora = Date.now();
    if (
      agora - (this.ultimoLogDeErro.get(canal.id) ?? 0) <
      INTERVALO_DO_LOG_DE_ERRO_MS
    ) {
      return;
    }
    this.ultimoLogDeErro.set(canal.id, agora);
    await this.logs.aviso(
      'Email',
      `Leitura do canal de e-mail "${canal.nome}" falhou: ${mensagem}`,
      {
        canalId: canal.id,
        erro: erro instanceof Error ? erro.message : String(erro),
      },
    );
  }
}

/**
 * Com quem é a conversa: o endereço que recebe a resposta — o Reply-To, ou o
 * remetente. Assim um e-mail com remetente forjado e Reply-To de outra pessoa
 * não desvia as respostas da conversa de quem foi imitado (cai na conversa do
 * Reply-To), e o formulário do site que envia de um "não responda" com o
 * Reply-To do cliente vira o contato certo.
 */
export function contatoDoEmail(
  email: Pick<EmailInterpretado, 'de' | 'responderPara'>,
): { email: string; nome: string | null } | null {
  const { de, responderPara } = email;
  if (!responderPara || responderPara.email === de?.email) {
    return de;
  }
  return { email: responderPara.email, nome: responderPara.nome };
}

/** Cabeçalhos do encadeamento e endereços, guardados em `mensagem.metadados.email`. */
export function metadadosDoEmail(
  email: EmailInterpretado,
  messageId: string,
): Record<string, unknown> {
  return {
    email: {
      messageId,
      inReplyTo: email.inReplyTo,
      references: email.references,
      de: email.de?.email ?? null,
      nomeDe: email.de?.nome ?? null,
      responderPara: email.responderPara?.email ?? null,
      para: email.para,
      cc: email.cc,
      assunto: email.assunto,
      ...(email.automatica ? { automatica: true } : {}),
      ...(email.textoCompleto ? { textoCompleto: email.textoCompleto } : {}),
    },
  };
}

function tipoDoAnexo(mime: string): TipoMensagem {
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

function dataDe(valor: Date | string | undefined): Date | null {
  if (!valor) {
    return null;
  }
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}
