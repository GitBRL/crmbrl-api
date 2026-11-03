import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ArquivosService } from '../../arquivos/arquivos.service';
import { DadosInvalidosException } from '../../comum/erros/excecoes';
import type {
  Canal,
  Conversa,
  Mensagem,
  Prisma,
  TipoMensagem,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { naoContatarPorWhatsapp } from '../../contatos/nao-contatar-whatsapp';
import {
  ConversorDeMidia,
  ConversorIndisponivelError,
} from '../../whatsapp/midia/conversor-de-midia';
import {
  type AdaptadorCanal,
  FalhaDefinitivaDeEnvio,
  type PedidoDeTemplate,
  type PermissaoDeResposta,
  type ResultadoEnvio,
  type TemplatePreparado,
} from '../adaptador-canal';
import { ConfiguracaoDeCanais } from '../comum/configuracao-de-canais.service';
import { SegredosDoCanal } from '../comum/segredos-do-canal';
import { ErroDaGraph } from '../meta/graph-api';
import { RegistroCanais } from '../registro-canais';
import type { TemplateDoCanalDto } from '../templates-canal.dto';
import { templateParaDto } from './template-dto';
import {
  componentesDoEnvio,
  corpoDeMidia,
  corpoDeTemplate,
  corpoDeTexto,
  type DestinoOficial,
  estruturaDoTemplate,
  ehJanelaFechada,
  LIMITE_DE_DOCUMENTO_BYTES,
  LIMITE_DE_MIDIA_BYTES,
  lerConfiguracaoOficial,
  type SegredosOficiais,
  textoDoTemplate,
  traduzirErroDaMeta,
  type ValoresDoTemplate,
  valoresQueFaltam,
} from './formato-meta';
import { GraphWhatsappOficial } from './graph-whatsapp-oficial';
import { TemplatesOficiaisService } from './templates-oficiais.service';

/** Por que não dá para mandar mensagem livre fora da janela de 24 h (R28.4). */
export const MOTIVO_JANELA_FECHADA_OFICIAL =
  'Passaram mais de 24 horas desde a última mensagem do contato: o WhatsApp só permite enviar um template aprovado. Escolha um template para retomar a conversa.';

/** Áudios que o navegador grava e viram mensagem de voz (como no Baileys). */
const MIMES_DE_VOZ = new Set(['audio/webm', 'audio/ogg', 'audio/opus']);

/** Códigos que passam sozinhos (limite de velocidade, instabilidade da Meta): vale tentar de novo. */
const CODIGOS_PASSAGEIROS = new Set([130429, 131000, 131016, 131057]);

/** Janela de 24 h do WhatsApp oficial (R28.4): até `conversa.janelaAte`. */
export function permissaoNaJanelaOficial(
  conversa: Pick<Conversa, 'janelaAte'>,
  agora: Date = new Date(),
): PermissaoDeResposta {
  return conversa.janelaAte && conversa.janelaAte > agora
    ? { pode: true }
    : {
        pode: false,
        motivo: MOTIVO_JANELA_FECHADA_OFICIAL,
        apenasTemplate: true,
      };
}

type Json = Record<string, unknown>;

const objeto = (valor: unknown): Json =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Json)
    : {};

/** O que `metadados.template` guarda na mensagem. */
interface TemplateDaMensagem {
  id: string;
  nome: string;
  idioma: string;
  categoria: string;
  variaveis: ValoresDoTemplate;
}

function lerTemplateDaMensagem(metadados: unknown): TemplateDaMensagem | null {
  const t = objeto(objeto(metadados).template);
  if (typeof t.id !== 'string' || typeof t.nome !== 'string') {
    return null;
  }
  return {
    id: t.id,
    nome: t.nome,
    idioma: typeof t.idioma === 'string' ? t.idioma : 'pt_BR',
    categoria: typeof t.categoria === 'string' ? t.categoria : 'UTILITY',
    variaveis: objeto(t.variaveis) as ValoresDoTemplate,
  };
}

/**
 * Canal WhatsApp oficial (Cloud API da Meta, R28), ao lado do Baileys:
 *
 * - **Janela de 24 h** (`podeResponder`): mensagem livre só até
 *   `conversa.janelaAte` (última mensagem do contato + 24 h); depois, só template.
 * - **Texto**, **mídia** (upload em `POST /{phone_number_id}/media` e envio por
 *   id; áudio sem texto, com a legenda em mensagem separada), **mensagem de
 *   voz** (webm/opus do navegador → ogg/opus pelo `ffmpeg`, o mesmo conversor
 *   do gateway) e **template** com variáveis (`metadados.template`).
 * - **Opt-out** (R4.6, "não contatar por WhatsApp"): fora da janela (ou seja,
 *   mensagem ativa), a marca do contato bloqueia o envio; template de
 *   marketing também respeita o opt-out de marketing.
 * - Destino: o telefone (E.164 só com dígitos) do contato; sem ele, o BSUID.
 * - Envio síncrono: o wamid devolvido vira o `idExterno` (e é gravado já, para o
 *   status que chegar antes do fim do job achar a mensagem); `ENVIADA` aqui,
 *   `ENTREGUE`/`LIDA`/`FALHOU` pelo webhook.
 */
@Injectable()
export class AdaptadorWhatsappOficial implements AdaptadorCanal, OnModuleInit {
  readonly tipo = 'WHATSAPP_OFICIAL' as const;
  private readonly logger = new Logger('WhatsAppOficial');
  /** O mesmo conversor do gateway (ffmpeg); público para os testes trocarem. */
  conversor = new ConversorDeMidia();

  constructor(
    private readonly registro: RegistroCanais,
    private readonly prisma: PrismaService,
    private readonly segredos: SegredosDoCanal,
    private readonly graph: GraphWhatsappOficial,
    private readonly arquivos: ArquivosService,
    private readonly templates: TemplatesOficiaisService,
    private readonly configuracao: ConfiguracaoDeCanais,
  ) {}

  onModuleInit(): void {
    this.registro.registrar(this);
  }

  podeResponder(conversa: Conversa, _canal: Canal): PermissaoDeResposta {
    return permissaoNaJanelaOficial(conversa);
  }

  async listarTemplates(
    canal: Canal,
    opcoes: { somenteUsaveis?: boolean } = {},
  ): Promise<TemplateDoCanalDto[]> {
    const lista = await this.templates.listar(canal.id);
    const dtos = lista.map((template) => templateParaDto(template));
    return opcoes.somenteUsaveis ? dtos.filter((item) => item.usavel) : dtos;
  }

  // -------------------------------------------------------------------------
  // Template: validação e texto (usados pelo Atendimento ao criar a mensagem)
  // -------------------------------------------------------------------------

  async prepararTemplate(
    canal: Canal,
    pedido: PedidoDeTemplate,
    opcoes: { arquivoMime?: string | null },
  ): Promise<TemplatePreparado> {
    const template = await this.templates.obter(canal.id, pedido.templateId);
    if (template.status !== 'APPROVED') {
      throw new DadosInvalidosException(
        `O template "${template.nome}" não está aprovado pela Meta (situação: ${template.status}).`,
        {
          campos: [
            {
              campo: 'template.templateId',
              mensagens: ['template não aprovado'],
            },
          ],
        },
      );
    }
    const estrutura = estruturaDoTemplate(template.componentes);
    const variaveis: ValoresDoTemplate = pedido.variaveis ?? {};
    const faltas = valoresQueFaltam(estrutura, variaveis);
    if (faltas.length > 0) {
      throw new DadosInvalidosException(
        `Preencha as variáveis do template: ${faltas.join(', ')}.`,
        {
          campos: [
            {
              campo: 'template.variaveis',
              mensagens: faltas.map((f) => `falta ${f}`),
            },
          ],
        },
      );
    }
    let tipo: TipoMensagem = 'TEXTO';
    const formato = estrutura.cabecalho?.formato;
    if (formato === 'IMAGE' || formato === 'VIDEO' || formato === 'DOCUMENT') {
      if (!opcoes.arquivoMime) {
        throw new DadosInvalidosException(
          'Este template tem mídia no cabeçalho: anexe o arquivo.',
          {
            campos: [
              {
                campo: 'arquivoId',
                mensagens: ['é obrigatório neste template'],
              },
            ],
          },
        );
      }
      tipo = { IMAGE: 'IMAGEM', VIDEO: 'VIDEO', DOCUMENT: 'DOCUMENTO' }[
        formato
      ] as TipoMensagem;
    } else if (formato === 'LOCATION') {
      throw new DadosInvalidosException(
        'Templates com localização no cabeçalho ainda não são suportados.',
      );
    }
    return {
      tipo,
      texto: textoDoTemplate(estrutura, variaveis),
      metadados: {
        template: {
          id: template.id,
          nome: template.nome,
          idioma: template.idioma,
          categoria: template.categoria,
          variaveis,
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Envio
  // -------------------------------------------------------------------------

  async enviar(
    mensagem: Mensagem,
    conversa: Conversa,
    canal: Canal,
  ): Promise<ResultadoEnvio> {
    // Nova tentativa depois de um envio que a Meta já aceitou: não duplica.
    if (mensagem.idExterno) {
      return { idExterno: mensagem.idExterno, enviadaEm: new Date() };
    }
    const { token } = await this.segredos.ler<SegredosOficiais>(canal);
    const { phoneNumberId } = lerConfiguracaoOficial(canal.configuracao);
    if (!token || !phoneNumberId) {
      throw new FalhaDefinitivaDeEnvio(
        'O token ou o id do número deste canal do WhatsApp oficial não estão configurados.',
        'canal_incompleto',
      );
    }
    const template = lerTemplateDaMensagem(mensagem.metadados);
    const janelaAberta = permissaoNaJanelaOficial(conversa).pode;
    if (!template && !janelaAberta) {
      throw new FalhaDefinitivaDeEnvio(
        MOTIVO_JANELA_FECHADA_OFICIAL,
        'janela_fechada',
      );
    }
    await this.exigirPermissaoDoContato(conversa, janelaAberta, template);
    const destino = await this.destino(conversa);
    const citacao = await this.citacao(mensagem);

    try {
      const idExterno = template
        ? await this.enviarTemplate(
            token,
            phoneNumberId,
            destino,
            mensagem,
            template,
          )
        : await this.enviarLivre(
            token,
            phoneNumberId,
            destino,
            mensagem,
            citacao,
          );
      return { idExterno, enviadaEm: new Date() };
    } catch (erro) {
      throw await this.traduzir(erro, canal);
    }
  }

  private async enviarTemplate(
    token: string,
    phoneNumberId: string,
    destino: DestinoOficial,
    mensagem: Mensagem,
    modelo: TemplateDaMensagem,
  ): Promise<string> {
    const template = await this.prisma.whatsappOficialTemplate.findUnique({
      where: { id: modelo.id },
    });
    if (!template || template.status !== 'APPROVED') {
      throw new FalhaDefinitivaDeEnvio(
        `O template "${modelo.nome}" não está mais aprovado na Meta. Sincronize os templates e escolha outro.`,
        'template_indisponivel',
      );
    }
    const estrutura = estruturaDoTemplate(template.componentes);
    let mediaId: string | null = null;
    if (
      estrutura.cabecalho &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(estrutura.cabecalho.formato)
    ) {
      if (!mensagem.arquivoId) {
        throw new FalhaDefinitivaDeEnvio(
          'O template pede uma mídia no cabeçalho e a mensagem não tem arquivo.',
          'cabecalho_sem_midia',
        );
      }
      mediaId = await this.subir(
        token,
        phoneNumberId,
        mensagem.arquivoId,
        false,
      );
    }
    const wamid = await this.graph.enviar(
      token,
      phoneNumberId,
      corpoDeTemplate(
        destino,
        template.nome,
        template.idioma,
        componentesDoEnvio(estrutura, modelo.variaveis, mediaId),
      ),
    );
    await this.guardarId(mensagem.id, wamid);
    return wamid;
  }

  private async enviarLivre(
    token: string,
    phoneNumberId: string,
    destino: DestinoOficial,
    mensagem: Mensagem,
    citacao: { idExterno: string } | null,
  ): Promise<string> {
    const texto = mensagem.texto?.trim() || null;
    const ehMidia =
      !!mensagem.arquivoId &&
      ['IMAGEM', 'AUDIO', 'VIDEO', 'DOCUMENTO', 'FIGURINHA'].includes(
        mensagem.tipo,
      );
    if (!ehMidia) {
      if (!texto) {
        throw new FalhaDefinitivaDeEnvio(
          'A mensagem está vazia.',
          'mensagem_vazia',
        );
      }
      const wamid = await this.graph.enviar(
        token,
        phoneNumberId,
        corpoDeTexto(destino, texto, citacao),
      );
      await this.guardarId(mensagem.id, wamid);
      return wamid;
    }
    const metadados = objeto(mensagem.metadados);
    const voz = await this.ehVoz(mensagem, metadados);
    const arquivo = await this.arquivo(mensagem.arquivoId as string);
    const midia = voz ? await this.paraVoz(arquivo) : arquivo;
    this.exigirTamanho(midia.conteudo.length, mensagem.tipo);
    const mediaId = await this.graph.subirMidia(token, phoneNumberId, midia);
    // A Meta não aceita legenda em áudio nem em figurinha: o texto vai à parte.
    const comLegenda =
      mensagem.tipo !== 'AUDIO' && mensagem.tipo !== 'FIGURINHA';
    const wamidDaMidia = await this.graph.enviar(
      token,
      phoneNumberId,
      corpoDeMidia(
        destino,
        mensagem.tipo,
        mediaId,
        {
          legenda: comLegenda ? texto : null,
          nomeArquivo: midia.nome,
        },
        citacao,
      ),
    );
    if (comLegenda || !texto) {
      await this.guardarId(mensagem.id, wamidDaMidia);
      return wamidDaMidia;
    }
    // Áudio/figurinha com texto: o id da mensagem é o da mídia (o que o contato ouve primeiro).
    await this.guardarId(mensagem.id, wamidDaMidia);
    await this.graph.enviar(token, phoneNumberId, corpoDeTexto(destino, texto));
    return wamidDaMidia;
  }

  /** Sobe o arquivo do CRM para a Meta; devolve o id da mídia. */
  private async subir(
    token: string,
    phoneNumberId: string,
    arquivoId: string,
    voz: boolean,
  ): Promise<string> {
    const lido = await this.arquivo(arquivoId);
    const midia = voz ? await this.paraVoz(lido) : lido;
    return this.graph.subirMidia(token, phoneNumberId, midia);
  }

  private async arquivo(
    arquivoId: string,
  ): Promise<{ conteudo: Buffer; mime: string; nome: string }> {
    try {
      const { arquivo, conteudo } = await this.arquivos.lerConteudo(arquivoId);
      return { conteudo, mime: arquivo.mime, nome: arquivo.nome };
    } catch {
      throw new FalhaDefinitivaDeEnvio(
        'O anexo não existe mais.',
        'anexo_ausente',
      );
    }
  }

  /** webm/opus (o que o navegador grava) → ogg/opus mono, como o gateway faz para o Baileys. */
  private async paraVoz(midia: {
    conteudo: Buffer;
    mime: string;
    nome: string;
  }): Promise<{ conteudo: Buffer; mime: string; nome: string }> {
    const jaEOgg = midia.mime.startsWith('audio/ogg');
    try {
      const convertido = await this.conversor.paraVoz(
        midia.conteudo,
        midia.nome,
      );
      return {
        conteudo: convertido,
        mime: 'audio/ogg',
        nome: midia.nome.replace(/\.[a-z0-9]{1,8}$/i, '') + '.ogg',
      };
    } catch (erro) {
      if (jaEOgg) {
        return { ...midia, mime: 'audio/ogg' };
      }
      this.logger.warn(
        `Conversão do áudio de voz falhou${erro instanceof ConversorIndisponivelError ? ' (sem ffmpeg)' : ''}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      throw new FalhaDefinitivaDeEnvio(
        'Não foi possível converter o áudio para mensagem de voz.',
        'conversao_de_audio',
      );
    }
  }

  private async ehVoz(mensagem: Mensagem, metadados: Json): Promise<boolean> {
    if (mensagem.tipo !== 'AUDIO') {
      return false;
    }
    if (typeof metadados.voz === 'boolean') {
      return metadados.voz;
    }
    if (!mensagem.arquivoId) {
      return false;
    }
    const arquivo = await this.prisma.arquivo.findUnique({
      where: { id: mensagem.arquivoId },
      select: { mime: true },
    });
    return arquivo ? MIMES_DE_VOZ.has(arquivo.mime.split(';')[0] ?? '') : false;
  }

  private exigirTamanho(bytes: number, tipo: TipoMensagem): void {
    const limite =
      tipo === 'DOCUMENTO' ? LIMITE_DE_DOCUMENTO_BYTES : LIMITE_DE_MIDIA_BYTES;
    if (bytes > limite) {
      throw new FalhaDefinitivaDeEnvio(
        `O arquivo passa do limite do WhatsApp (${Math.round(limite / 1024 / 1024)} MB).`,
        'arquivo_grande',
      );
    }
  }

  /**
   * Opt-out (R4.6): "não contatar por WhatsApp" bloqueia a mensagem ativa (fora
   * da janela, ou seja, sem o contato ter escrito há menos de 24 h); template de
   * marketing também respeita o opt-out de marketing.
   */
  private async exigirPermissaoDoContato(
    conversa: Conversa,
    janelaAberta: boolean,
    template: TemplateDaMensagem | null,
  ): Promise<void> {
    const contato = await this.prisma.contato.findUnique({
      where: { id: conversa.contatoId },
      select: {
        etiquetas: true,
        camposPersonalizados: true,
        optOutMarketing: true,
      },
    });
    if (!contato) {
      return;
    }
    if (!janelaAberta && naoContatarPorWhatsapp(contato)) {
      throw new FalhaDefinitivaDeEnvio(
        'O contato pediu para não ser contatado por WhatsApp.',
        'nao_contatar',
      );
    }
    if (template?.categoria === 'MARKETING' && contato.optOutMarketing) {
      throw new FalhaDefinitivaDeEnvio(
        'O contato pediu para não receber mensagens de marketing (opt-out).',
        'opt_out_marketing',
      );
    }
  }

  /** O telefone do contato (E.164 só com dígitos); sem ele, o BSUID. */
  private async destino(conversa: Conversa): Promise<DestinoOficial> {
    const identificadores = await this.prisma.contatoIdentificador.findMany({
      where: {
        contatoId: conversa.contatoId,
        tipo: { in: ['WHATSAPP', 'WHATSAPP_BSUID'] },
      },
      orderBy: { ultimoUsoEm: { sort: 'desc', nulls: 'last' } },
    });
    let telefone =
      identificadores.find((item) => item.tipo === 'WHATSAPP')?.valor ?? null;
    if (!telefone) {
      const contato = await this.prisma.contato.findUnique({
        where: { id: conversa.contatoId },
        select: { telefone: true },
      });
      telefone = contato?.telefone ?? null;
    }
    const bsuid =
      identificadores.find((item) => item.tipo === 'WHATSAPP_BSUID')?.valor ??
      null;
    if (!telefone && !bsuid) {
      throw new FalhaDefinitivaDeEnvio(
        'O contato não tem um número de WhatsApp.',
        'sem_destino',
      );
    }
    return { telefone, bsuid };
  }

  private async citacao(
    mensagem: Mensagem,
  ): Promise<{ idExterno: string } | null> {
    if (!mensagem.respostaAId) {
      return null;
    }
    const citada = await this.prisma.mensagem.findUnique({
      where: { id: mensagem.respostaAId },
      select: { idExterno: true },
    });
    return citada?.idExterno ? { idExterno: citada.idExterno } : null;
  }

  /** Grava o wamid já (o webhook de status pode chegar antes do fim do job de envio). */
  private async guardarId(
    mensagemId: string,
    idExterno: string,
  ): Promise<void> {
    await this.prisma.mensagem.update({
      where: { id: mensagemId },
      data: { idExterno } satisfies Prisma.MensagemUpdateInput,
    });
  }

  private async traduzir(erro: unknown, canal: Canal): Promise<Error> {
    if (
      erro instanceof FalhaDefinitivaDeEnvio ||
      !(erro instanceof ErroDaGraph)
    ) {
      return erro instanceof Error ? erro : new Error(String(erro));
    }
    if (erro.tokenInvalido) {
      const mensagem = traduzirErroDaMeta(190);
      await this.configuracao.registrarErro(canal.id, mensagem);
      return new FalhaDefinitivaDeEnvio(mensagem, 'token_invalido');
    }
    if (ehJanelaFechada(erro.codigo)) {
      return new FalhaDefinitivaDeEnvio(
        MOTIVO_JANELA_FECHADA_OFICIAL,
        'janela_fechada',
      );
    }
    if (erro.passageiro || CODIGOS_PASSAGEIROS.has(erro.codigo ?? -1)) {
      this.logger.warn(
        `Envio pela Cloud API falhou (vai tentar de novo): ${erro.message}`,
      );
      return erro;
    }
    return new FalhaDefinitivaDeEnvio(
      traduzirErroDaMeta(erro.codigo, erro.message),
      `meta_${erro.codigo ?? erro.status}`,
    );
  }
}
