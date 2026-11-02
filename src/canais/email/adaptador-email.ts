import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../../arquivos/arquivos.service';
import type { Canal, Conversa, Mensagem } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type ResultadoEnvio,
} from '../adaptador-canal';
import { ConfiguracaoDeCanais } from '../comum/configuracao-de-canais.service';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { RegistroCanais } from '../registro-canais';
import {
  dominioDoEndereco,
  lerConfiguracaoEmail,
  type SegredosEmail,
  senhaDoSmtp,
} from './configuracao-email';
import { criarTransporteSmtp, traduzirErroDeEmail } from './conexoes-email';
import { limparAssunto } from './interpretacao-email';

/** References guardadas numa resposta (as mais recentes). */
const REFERENCIAS_MAXIMAS = 20;

interface EmailDaEntrada {
  messageId?: string;
  references?: string[];
  de?: string | null;
  nomeDe?: string | null;
  responderPara?: string | null;
  assunto?: string | null;
}

/** Erro passageiro do envio (o Atendimento tenta de novo). */
class FalhaPassageiraDeEmail extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FalhaPassageiraDeEmail';
  }
}

/**
 * E-mail (§2.5, R14): a resposta sai pelo SMTP do canal (`nodemailer`) como
 * **texto**, com os cabeçalhos de encadeamento — `In-Reply-To` com o
 * Message-ID do último e-mail do contato e `References` com a cadeia — e
 * `Re: <assunto>`, para o cliente de e-mail do contato juntar na mesma
 * conversa. O Message-ID gerado é o id externo (a próxima resposta do
 * contato chega com ele no `In-Reply-To`).
 */
@Injectable()
export class AdaptadorEmail implements AdaptadorCanal, OnModuleInit {
  readonly tipo = 'EMAIL' as const;

  constructor(
    private readonly registro: RegistroCanais,
    private readonly prisma: PrismaService,
    private readonly segredos: SegredosDoCanal,
    private readonly arquivos: ArquivosService,
    private readonly configuracao: ConfiguracaoDeCanais,
  ) {}

  onModuleInit(): void {
    this.registro.registrar(this);
  }

  async enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    const config = lerConfiguracaoEmail(canal.configuracao, canal.idExterno);
    const segredos = await this.segredos.ler<SegredosEmail>(canal);
    if (!config.smtp.host || !config.endereco) {
      throw new FalhaDefinitivaDeEnvio(
        'O SMTP deste canal de e-mail não está configurado.',
        'smtp_nao_configurado',
      );
    }
    const entrada = await this.ultimaEntrada(conversa.id, mensagem.id);
    const destino = await this.destino(conversa, entrada);
    const references = [
      ...(entrada?.references ?? []),
      ...(entrada?.messageId ? [entrada.messageId] : []),
    ]
      .filter((id, indice, todos) => todos.indexOf(id) === indice)
      .slice(-REFERENCIAS_MAXIMAS);
    const assunto =
      limparAssunto(conversa.assunto) ??
      limparAssunto(entrada?.assunto) ??
      `Atendimento — ${config.nomeRemetente ?? canal.nome}`;
    const messageId = `${randomUUID()}@${dominioDoEndereco(config.endereco)}`;
    const texto = [
      mensagem.texto ?? '',
      config.assinatura ? `-- \n${config.assinatura}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const anexos = mensagem.arquivoId
      ? [await this.anexo(mensagem.arquivoId)]
      : [];
    if (!texto && anexos.length === 0) {
      throw new FalhaDefinitivaDeEnvio(
        'A mensagem está vazia.',
        'mensagem_vazia',
      );
    }

    const transporte = criarTransporteSmtp(config, senhaDoSmtp(segredos));
    try {
      await transporte.sendMail({
        from: {
          name: config.nomeRemetente ?? canal.nome,
          address: config.endereco,
        },
        to: destino,
        // Campanha (primeiro contato, sem e-mail do contato antes): o assunto vai como está.
        subject: ehPrimeiroContatoDeCampanha(mensagem, entrada)
          ? assunto
          : `Re: ${assunto}`,
        text: texto || ' ',
        messageId: `<${messageId}>`,
        ...(entrada?.messageId ? { inReplyTo: `<${entrada.messageId}>` } : {}),
        ...(references.length > 0
          ? { references: references.map((id) => `<${id}>`) }
          : {}),
        attachments: anexos,
        headers: { 'X-Mailer': 'BRL CRM' },
      });
    } catch (erro) {
      const traduzido = traduzirErroDeEmail(erro, 'SMTP');
      if (traduzido.definitivo) {
        await this.configuracao.registrarErro(canal.id, traduzido.mensagem);
        throw new FalhaDefinitivaDeEnvio(traduzido.mensagem, 'smtp_recusou');
      }
      throw new FalhaPassageiraDeEmail(traduzido.mensagem);
    } finally {
      transporte.close();
    }
    return { idExterno: messageId, enviadaEm: new Date() };
  }

  /** O último e-mail do contato na conversa (para o encadeamento e o destino). */
  private async ultimaEntrada(
    conversaId: string,
    mensagemId: string,
  ): Promise<EmailDaEntrada | null> {
    const mensagens = await this.prisma.mensagem.findMany({
      where: {
        conversaId,
        direcao: 'ENTRADA',
        id: { not: mensagemId },
      },
      orderBy: { ocorridaEm: 'desc' },
      take: 20,
      select: { metadados: true },
    });
    for (const { metadados } of mensagens) {
      const email = (metadados as { email?: EmailDaEntrada } | null)?.email;
      if (email?.messageId && !('anexoDe' in email)) {
        return email;
      }
    }
    return null;
  }

  /** Para onde vai a resposta: Reply-To ou remetente do último e-mail; senão, o e-mail do contato. */
  private async destino(
    conversa: Conversa,
    entrada: EmailDaEntrada | null,
  ): Promise<{ name: string; address: string }> {
    const contato = await this.prisma.contato.findUnique({
      where: { id: conversa.contatoId },
      select: {
        nome: true,
        email: true,
        identificadores: {
          where: { tipo: 'EMAIL' },
          orderBy: { ultimoUsoEm: 'desc' },
          take: 1,
          select: { valor: true },
        },
      },
    });
    // O mesmo endereço que identificou o contato na entrada (`contatoDoEmail`).
    const responderPara =
      entrada?.responderPara && entrada.responderPara !== entrada.de
        ? entrada.responderPara
        : null;
    const endereco =
      responderPara ??
      entrada?.de ??
      contato?.identificadores[0]?.valor ??
      contato?.email;
    if (!endereco) {
      throw new FalhaDefinitivaDeEnvio(
        'O contato desta conversa não tem e-mail para responder.',
        'contato_sem_email',
      );
    }
    const nome = responderPara
      ? contato?.nome
      : (entrada?.nomeDe ?? contato?.nome);
    return { name: nome ?? '', address: endereco };
  }

  private async anexo(arquivoId: string) {
    const { arquivo, conteudo } = await this.arquivos.lerConteudo(arquivoId);
    return {
      filename: arquivo.nome,
      content: conteudo,
      contentType: arquivo.mime,
    };
  }
}

/** Mensagem de campanha para quem ainda não escreveu na conversa: sem o "Re:". */
function ehPrimeiroContatoDeCampanha(
  mensagem: Mensagem,
  entrada: unknown,
): boolean {
  const metadados = mensagem.metadados;
  return (
    !entrada &&
    typeof metadados === 'object' &&
    metadados !== null &&
    !Array.isArray(metadados) &&
    typeof (metadados as Record<string, unknown>).campanhaId === 'string'
  );
}
