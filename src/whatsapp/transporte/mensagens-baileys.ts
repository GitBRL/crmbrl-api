/**
 * Tradução entre o Baileys e o transporte do gateway, em funções puras (sem
 * carregar o pacote, que é ESM): o que chegou do WhatsApp vira
 * `MensagemDoTransporte`, o envio vira o conteúdo do `sendMessage`, os recibos
 * viram status e os motivos de queda viram `MotivoDaQueda`.
 */
import type { AnyMessageContent, proto } from 'baileys' with {
  'resolution-mode': 'import',
};
import { FalhaDefinitivaDeEnvio } from '../../canais/adaptador-canal';
import type { TipoMensagem } from '../../generated/prisma/client';
import type { EnvioDoTransporte, MotivoDaQueda } from './transporte';

/** Códigos de desconexão do Baileys (`DisconnectReason`). */
export const CODIGOS_DE_DESCONEXAO = {
  conexaoFechada: 428,
  conexaoPerdida: 408,
  conexaoSubstituida: 440,
  sessaoDesconectada: 401,
  sessaoInvalida: 500,
  reinicioNecessario: 515,
  multiAparelhoIncompativel: 411,
  proibido: 403,
  servicoIndisponivel: 503,
} as const;

/** O que fazer quando a conexão do Baileys fecha. */
export type ReacaoAQueda =
  /** Abrir outro socket na hora, sem avisar o gerenciador (ex.: logo depois da leitura do QR). */
  { reiniciar: true } | { reiniciar: false; queda: MotivoDaQueda };

/**
 * Classifica o fechamento da conexão.
 *
 * - 515 (reinício necessário, logo depois de ler o QR) → reinicia na hora;
 * - 401 (aparelho desvinculado pelo celular) e 500 (sessão inválida) → logout:
 *   apaga as chaves e pede QR novo;
 * - 403 → o WhatsApp bloqueou o número;
 * - 440 (sessão aberta em outro lugar) e 411 → erro grave (reconectar brigaria
 *   com a outra sessão);
 * - QR que expirou sem leitura (ainda não registrado) → volta a desconectado;
 * - o resto (rede, 408, 428, 503…) → queda comum, com reconexão.
 */
export function classificarQueda(
  codigo: number | undefined,
  mensagem: string | undefined,
  contexto: { registrado: boolean },
): ReacaoAQueda {
  const texto = mensagem ?? '';
  switch (codigo) {
    case CODIGOS_DE_DESCONEXAO.reinicioNecessario:
      return { reiniciar: true };
    case CODIGOS_DE_DESCONEXAO.sessaoDesconectada:
      return {
        reiniciar: false,
        queda: {
          motivo:
            'O aparelho foi desconectado pelo celular. Leia o QR de novo para reconectar.',
          logout: true,
        },
      };
    case CODIGOS_DE_DESCONEXAO.sessaoInvalida:
      return {
        reiniciar: false,
        queda: {
          motivo:
            'A sessão do WhatsApp ficou inválida. Leia o QR de novo para reconectar.',
          logout: true,
        },
      };
    case CODIGOS_DE_DESCONEXAO.proibido:
      return {
        reiniciar: false,
        queda: {
          motivo:
            'O WhatsApp bloqueou este número. Confira o aplicativo no celular antes de tentar de novo.',
          banido: true,
        },
      };
    case CODIGOS_DE_DESCONEXAO.conexaoSubstituida:
      return {
        reiniciar: false,
        queda: {
          motivo:
            'A sessão deste número foi aberta em outro lugar (outro computador ou WhatsApp Web). Reconecte pelo CRM quando quiser voltar.',
          erroGrave: true,
        },
      };
    case CODIGOS_DE_DESCONEXAO.multiAparelhoIncompativel:
      return {
        reiniciar: false,
        queda: {
          motivo:
            'O celular não aceitou o aparelho conectado. Atualize o WhatsApp no celular e leia o QR de novo.',
          erroGrave: true,
        },
      };
    default:
      break;
  }
  if (!contexto.registrado) {
    // Ainda sem leitura do QR: os QRs acabaram (408 "QR refs attempts ended")
    // ou a conexão nova caiu. Não reconecta sozinho: alguém pede de novo.
    return {
      reiniciar: false,
      queda: {
        motivo: /qr refs|attempts ended/i.test(texto)
          ? 'O QR expirou sem ser lido. Peça um novo para conectar.'
          : 'A conexão caiu antes da leitura do QR. Peça um novo QR para conectar.',
        semLeituraDoQr: true,
      },
    };
  }
  return {
    reiniciar: false,
    queda: {
      motivo: `A conexão com o WhatsApp caiu${codigo ? ` (código ${codigo})` : ''}.`,
    },
  };
}

/** Recibo de uma mensagem enviada (`WebMessageInfo.Status`) → status do CRM. */
export function statusDoRecibo(
  status: number | null | undefined,
): 'ENTREGUE' | 'LIDA' | 'FALHOU' | null {
  switch (status) {
    case 0:
      return 'FALHOU';
    case 3:
      return 'ENTREGUE';
    case 4:
    case 5:
      return 'LIDA';
    default:
      // 1 (pendente) e 2 (aceita pelo servidor): o gateway já publicou ENVIADA.
      return null;
  }
}

/** Presença do contato (`presence.update`) → "digitando…"? */
export function presencaDigitando(
  presenca: string | null | undefined,
): boolean {
  return presenca === 'composing' || presenca === 'recording';
}

/** Mídia de uma mensagem recebida, antes do download. */
export interface MidiaDoConteudo {
  nome: string;
  mime: string;
  tamanho: number | null;
  duracaoSegundos: number | null;
  largura: number | null;
  altura: number | null;
}

/** Uma mensagem recebida, já interpretada (sem remetente nem horário). */
export interface ConteudoInterpretado {
  tipo: TipoMensagem;
  texto: string | null;
  respondeAIdExterno: string | null;
  midia: MidiaDoConteudo | null;
  metadados: Record<string, unknown>;
}

/** Texto para o que o CRM ainda não mostra (enquete, botões, ligação…). */
export const TEXTO_DE_TIPO_NAO_SUPORTADO =
  '(O contato enviou um tipo de mensagem que o CRM ainda não mostra. Veja no celular.)';

/** Conteúdos que não são mensagem para o atendimento (controle, criptografia, edição…). */
const CONTEUDOS_IGNORADOS = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'pinInChatMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'deviceSentMessage',
  'botInvokeMessage',
  'peerDataOperationRequestMessage',
  'peerDataOperationRequestResponseMessage',
  'placeholderMessage',
  'call',
]);

/**
 * Interpreta o conteúdo (já normalizado com `normalizeMessageContent`) de uma
 * mensagem recebida. `null` = não é mensagem para o atendimento (controle,
 * edição, criptografia…).
 */
export function interpretarConteudo(
  conteudo: proto.IMessage | null | undefined,
  idExterno: string,
): ConteudoInterpretado | null {
  if (!conteudo) {
    return null;
  }
  const base = (
    tipo: TipoMensagem,
    texto: string | null | undefined,
    contexto: proto.IContextInfo | null | undefined,
    extras: Partial<ConteudoInterpretado> = {},
  ): ConteudoInterpretado => ({
    tipo,
    texto: textoOuNulo(texto),
    respondeAIdExterno: contexto?.stanzaId ?? null,
    midia: null,
    metadados: {},
    ...extras,
  });

  if (typeof conteudo.conversation === 'string' && conteudo.conversation) {
    return base('TEXTO', conteudo.conversation, null);
  }
  if (conteudo.extendedTextMessage) {
    const texto = conteudo.extendedTextMessage;
    return base('TEXTO', texto.text, texto.contextInfo);
  }
  if (conteudo.imageMessage) {
    const imagem = conteudo.imageMessage;
    return base('IMAGEM', imagem.caption, imagem.contextInfo, {
      midia: midia(imagem, `imagem-${idExterno}`, 'image/jpeg'),
    });
  }
  if (conteudo.videoMessage) {
    const video = conteudo.videoMessage;
    return base('VIDEO', video.caption, video.contextInfo, {
      midia: midia(video, `video-${idExterno}`, 'video/mp4'),
      metadados: video.gifPlayback ? { gif: true } : {},
    });
  }
  if (conteudo.ptvMessage) {
    const video = conteudo.ptvMessage;
    return base('VIDEO', video.caption, video.contextInfo, {
      midia: midia(video, `video-${idExterno}`, 'video/mp4'),
      metadados: { recado: true },
    });
  }
  if (conteudo.audioMessage) {
    const audio = conteudo.audioMessage;
    return base('AUDIO', null, audio.contextInfo, {
      midia: midia(audio, `audio-${idExterno}`, 'audio/ogg'),
      metadados: audio.ptt ? { voz: true } : {},
    });
  }
  if (conteudo.documentMessage) {
    const documento = conteudo.documentMessage;
    return base('DOCUMENTO', documento.caption, documento.contextInfo, {
      midia: midia(
        documento,
        documento.fileName || documento.title || `documento-${idExterno}`,
        'application/octet-stream',
      ),
    });
  }
  if (conteudo.stickerMessage) {
    const figurinha = conteudo.stickerMessage;
    return base('FIGURINHA', null, figurinha.contextInfo, {
      midia: midia(figurinha, `figurinha-${idExterno}`, 'image/webp'),
      metadados: figurinha.isAnimated ? { animada: true } : {},
    });
  }
  const local = conteudo.locationMessage ?? conteudo.liveLocationMessage;
  if (local) {
    const nome =
      'name' in local ? textoOuNulo(local.name as string | null) : null;
    const endereco =
      'address' in local ? textoOuNulo(local.address as string | null) : null;
    return base(
      'LOCALIZACAO',
      [nome, endereco].filter(Boolean).join(' — ') || 'Localização',
      local.contextInfo,
      {
        metadados: semNulos({
          latitude: local.degreesLatitude ?? null,
          longitude: local.degreesLongitude ?? null,
          nome,
          endereco,
          tempoReal: conteudo.liveLocationMessage ? true : null,
        }),
      },
    );
  }
  if (conteudo.contactMessage) {
    const contato = conteudo.contactMessage;
    return base(
      'CONTATO',
      contato.displayName || 'Contato',
      contato.contextInfo,
      {
        metadados: semNulos({
          nome: textoOuNulo(contato.displayName),
          vcard: textoOuNulo(contato.vcard),
        }),
      },
    );
  }
  if (conteudo.contactsArrayMessage) {
    const lista = conteudo.contactsArrayMessage;
    const contatos = (lista.contacts ?? []).map((contato) =>
      semNulos({
        nome: textoOuNulo(contato.displayName),
        vcard: textoOuNulo(contato.vcard),
      }),
    );
    return base(
      'CONTATO',
      lista.displayName || `${contatos.length} contatos`,
      lista.contextInfo,
      { metadados: { contatos } },
    );
  }
  if (conteudo.reactionMessage) {
    const reacao = conteudo.reactionMessage;
    return base('REACAO', reacao.text ?? '', null, {
      metadados: semNulos({
        emoji: reacao.text ?? '',
        alvoIdExterno: reacao.key?.id ?? null,
        removida: reacao.text ? null : true,
      }),
    });
  }
  const tipos = Object.keys(conteudo).filter(
    (chave) =>
      (conteudo as Record<string, unknown>)[chave] !== null &&
      (conteudo as Record<string, unknown>)[chave] !== undefined,
  );
  // Sem nada (ou só controle): não é mensagem para o atendimento.
  if (tipos.every((tipo) => CONTEUDOS_IGNORADOS.has(tipo))) {
    return null;
  }
  return base('TEXTO', TEXTO_DE_TIPO_NAO_SUPORTADO, null, {
    metadados: {
      tipoOriginal: tipos.find((tipo) => !CONTEUDOS_IGNORADOS.has(tipo)),
    },
  });
}

/** O conteúdo do `sendMessage` para um envio. */
export function conteudoDoEnvio(envio: EnvioDoTransporte): AnyMessageContent {
  const texto = envio.texto?.trim() ? envio.texto : undefined;
  const exigirMidia = () => {
    if (!envio.midia) {
      throw new FalhaDefinitivaDeEnvio(
        'O arquivo da mensagem não foi encontrado.',
        'sem_arquivo',
      );
    }
    return envio.midia;
  };
  const metadados = envio.metadados ?? {};
  switch (envio.tipo) {
    case 'TEXTO':
      if (!texto) {
        throw new FalhaDefinitivaDeEnvio('A mensagem está vazia.', 'vazia');
      }
      return { text: texto };
    case 'IMAGEM': {
      const arquivo = exigirMidia();
      return {
        image: arquivo.conteudo,
        caption: texto,
        mimetype: arquivo.mime,
      };
    }
    case 'VIDEO': {
      const arquivo = exigirMidia();
      return {
        video: arquivo.conteudo,
        caption: texto,
        mimetype: arquivo.mime,
      };
    }
    case 'AUDIO': {
      const arquivo = exigirMidia();
      return {
        audio: arquivo.conteudo,
        ptt: envio.voz ?? false,
        mimetype: arquivo.mime,
      };
    }
    case 'DOCUMENTO': {
      const arquivo = exigirMidia();
      return {
        document: arquivo.conteudo,
        mimetype: arquivo.mime,
        fileName: arquivo.nome,
        caption: texto,
      };
    }
    case 'FIGURINHA':
      return { sticker: exigirMidia().conteudo };
    case 'LOCALIZACAO': {
      const latitude = Number(metadados.latitude);
      const longitude = Number(metadados.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new FalhaDefinitivaDeEnvio(
          'A localização precisa de latitude e longitude.',
          'localizacao_invalida',
        );
      }
      return {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          name: textoOuIndefinido(metadados.nome),
          address: textoOuIndefinido(metadados.endereco),
        },
      };
    }
    case 'CONTATO': {
      const vcard = textoOuIndefinido(metadados.vcard);
      if (!vcard) {
        throw new FalhaDefinitivaDeEnvio(
          'O contato compartilhado precisa do vCard.',
          'contato_invalido',
        );
      }
      const nome = textoOuIndefinido(metadados.nome) ?? texto ?? 'Contato';
      return {
        contacts: {
          displayName: nome,
          contacts: [{ displayName: nome, vcard }],
        },
      };
    }
    case 'REACAO': {
      const alvo = textoOuIndefinido(metadados.alvoIdExterno);
      if (!alvo) {
        throw new FalhaDefinitivaDeEnvio(
          'A reação precisa da mensagem reagida.',
          'reacao_invalida',
        );
      }
      return {
        react: {
          text: textoOuIndefinido(metadados.emoji) ?? texto ?? '',
          key: {
            remoteJid: envio.para,
            id: alvo,
            fromMe: metadados.alvoDeMim === true,
          },
        },
      };
    }
    default:
      throw new FalhaDefinitivaDeEnvio(
        'Este tipo de mensagem não pode ser enviado pelo WhatsApp.',
        'tipo_nao_suportado',
      );
  }
}

/** A mensagem citada, no formato que o `sendMessage({ quoted })` espera. */
export function mensagemCitada(
  para: string,
  idExterno: string,
  citada: { texto: string | null; deMim: boolean } | null | undefined,
): { key: proto.IMessageKey; message: proto.IMessage } {
  return {
    key: { remoteJid: para, id: idExterno, fromMe: citada?.deMim ?? false },
    message: { conversation: citada?.texto ?? '' },
  };
}

/** O erro do Baileys é o limite de envios do WhatsApp (`rate-overlimit`, 429)? */
export function ehLimiteDoWhatsapp(erro: unknown): boolean {
  if (!(erro instanceof Error)) {
    return false;
  }
  const codigo = (erro as { output?: { statusCode?: number } }).output
    ?.statusCode;
  const dados = (erro as { data?: unknown }).data;
  return (
    codigo === 429 ||
    dados === 429 ||
    /rate-overlimit|too many|429/i.test(erro.message)
  );
}

/** Número de um campo do protobuf (pode vir como `Long`). */
export function numeroDoProtobuf(valor: unknown): number | null {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? valor : null;
  }
  if (
    valor &&
    typeof valor === 'object' &&
    'toNumber' in valor &&
    typeof (valor as { toNumber: unknown }).toNumber === 'function'
  ) {
    return (valor as { toNumber(): number }).toNumber();
  }
  if (typeof valor === 'string' && valor.trim() !== '') {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
  }
  return null;
}

const EXTENSAO_POR_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

function midia(
  dados: {
    mimetype?: string | null;
    fileLength?: unknown;
    seconds?: number | null;
    width?: number | null;
    height?: number | null;
  },
  nomeBase: string,
  mimePadrao: string,
): MidiaDoConteudo {
  const mime = (dados.mimetype || mimePadrao).trim();
  const tipo = mime.split(';')[0].trim().toLowerCase();
  const extensao = EXTENSAO_POR_MIME[tipo];
  const temExtensao = /\.[a-z0-9]{1,8}$/i.test(nomeBase);
  return {
    nome: temExtensao || !extensao ? nomeBase : `${nomeBase}.${extensao}`,
    mime,
    tamanho: numeroDoProtobuf(dados.fileLength),
    duracaoSegundos: dados.seconds ?? null,
    largura: dados.width ?? null,
    altura: dados.height ?? null,
  };
}

function textoOuNulo(texto: string | null | undefined): string | null {
  return typeof texto === 'string' && texto.length > 0 ? texto : null;
}

function textoOuIndefinido(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor.trim() ? valor : undefined;
}

function semNulos(objeto: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(objeto).filter(
      ([, valor]) => valor !== null && valor !== undefined,
    ),
  );
}
