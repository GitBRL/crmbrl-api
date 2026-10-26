import { FalhaDefinitivaDeEnvio } from '../../canais/adaptador-canal';
import {
  classificarQueda,
  conteudoDoEnvio,
  ehLimiteDoWhatsapp,
  interpretarConteudo,
  mensagemCitada,
  numeroDoProtobuf,
  presencaDigitando,
  statusDoRecibo,
  TEXTO_DE_TIPO_NAO_SUPORTADO,
} from './mensagens-baileys';
import type { EnvioDoTransporte } from './transporte';

describe('mensagens do Baileys', () => {
  describe('classificarQueda', () => {
    const registrado = { registrado: true };

    it('515 (logo depois de ler o QR) reinicia o socket na hora', () => {
      expect(classificarQueda(515, 'restart required', registrado)).toEqual({
        reiniciar: true,
      });
      expect(
        classificarQueda(515, undefined, { registrado: false }).reiniciar,
      ).toBe(true);
    });

    it('401 e 500 são logout (apaga as chaves e pede QR)', () => {
      for (const codigo of [401, 500]) {
        const reacao = classificarQueda(codigo, '', registrado);
        expect(reacao).toMatchObject({
          reiniciar: false,
          queda: { logout: true },
        });
      }
    });

    it('403 é banimento; 440 e 411 são erro grave', () => {
      expect(classificarQueda(403, '', registrado)).toMatchObject({
        queda: { banido: true },
      });
      expect(classificarQueda(440, 'conflict', registrado)).toMatchObject({
        queda: { erroGrave: true },
      });
      expect(classificarQueda(411, '', registrado)).toMatchObject({
        queda: { erroGrave: true },
      });
    });

    it('sem leitura do QR: não reconecta sozinho', () => {
      expect(
        classificarQueda(408, 'QR refs attempts ended', { registrado: false }),
      ).toEqual({
        reiniciar: false,
        queda: {
          motivo: 'O QR expirou sem ser lido. Peça um novo para conectar.',
          semLeituraDoQr: true,
        },
      });
      expect(
        classificarQueda(428, 'Connection Closed', { registrado: false }),
      ).toMatchObject({ queda: { semLeituraDoQr: true } });
    });

    it('já registrado: rede, 408, 428 e 503 são queda comum', () => {
      for (const codigo of [408, 428, 503, undefined]) {
        const reacao = classificarQueda(codigo, 'x', registrado);
        expect(reacao.reiniciar).toBe(false);
        if (!reacao.reiniciar) {
          expect(reacao.queda.logout).toBeUndefined();
          expect(reacao.queda.erroGrave).toBeUndefined();
          expect(reacao.queda.semLeituraDoQr).toBeUndefined();
          expect(reacao.queda.motivo).toMatch(/^A conexão com o WhatsApp caiu/);
        }
      }
    });
  });

  it('recibos: 3 entregue, 4 e 5 lida, 0 falhou; 1 e 2 não mudam nada', () => {
    expect(statusDoRecibo(3)).toBe('ENTREGUE');
    expect(statusDoRecibo(4)).toBe('LIDA');
    expect(statusDoRecibo(5)).toBe('LIDA');
    expect(statusDoRecibo(0)).toBe('FALHOU');
    expect(statusDoRecibo(1)).toBeNull();
    expect(statusDoRecibo(2)).toBeNull();
    expect(statusDoRecibo(undefined)).toBeNull();
  });

  it('presença: composing e recording são "digitando"', () => {
    expect(presencaDigitando('composing')).toBe(true);
    expect(presencaDigitando('recording')).toBe(true);
    expect(presencaDigitando('paused')).toBe(false);
    expect(presencaDigitando('available')).toBe(false);
    expect(presencaDigitando(undefined)).toBe(false);
  });

  describe('interpretarConteudo', () => {
    it('texto simples e texto com citação', () => {
      expect(interpretarConteudo({ conversation: 'Oi' }, 'A1')).toEqual({
        tipo: 'TEXTO',
        texto: 'Oi',
        respondeAIdExterno: null,
        midia: null,
        metadados: {},
      });
      expect(
        interpretarConteudo(
          {
            extendedTextMessage: {
              text: 'Sim',
              contextInfo: { stanzaId: '3EB0CITADA' },
            },
          },
          'A2',
        ),
      ).toMatchObject({
        tipo: 'TEXTO',
        texto: 'Sim',
        respondeAIdExterno: '3EB0CITADA',
      });
    });

    it('imagem com legenda e tamanho em Long', () => {
      const long = { toNumber: () => 2048 };
      expect(
        interpretarConteudo(
          {
            imageMessage: {
              caption: 'Foto',
              mimetype: 'image/jpeg',
              fileLength: long as never,
              width: 800,
              height: 600,
            },
          },
          'IMG1',
        ),
      ).toEqual({
        tipo: 'IMAGEM',
        texto: 'Foto',
        respondeAIdExterno: null,
        metadados: {},
        midia: {
          nome: 'imagem-IMG1.jpg',
          mime: 'image/jpeg',
          tamanho: 2048,
          duracaoSegundos: null,
          largura: 800,
          altura: 600,
        },
      });
    });

    it('áudio de voz, documento com nome, figurinha e vídeo', () => {
      expect(
        interpretarConteudo(
          {
            audioMessage: {
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true,
              seconds: 7,
            },
          },
          'AU1',
        ),
      ).toMatchObject({
        tipo: 'AUDIO',
        texto: null,
        metadados: { voz: true },
        midia: {
          nome: 'audio-AU1.ogg',
          mime: 'audio/ogg; codecs=opus',
          duracaoSegundos: 7,
        },
      });
      expect(
        interpretarConteudo(
          {
            documentMessage: {
              fileName: 'proposta.pdf',
              mimetype: 'application/pdf',
              caption: 'Segue',
            },
          },
          'DOC1',
        ),
      ).toMatchObject({
        tipo: 'DOCUMENTO',
        texto: 'Segue',
        midia: { nome: 'proposta.pdf', mime: 'application/pdf' },
      });
      expect(
        interpretarConteudo({ stickerMessage: { isAnimated: true } }, 'F1'),
      ).toMatchObject({
        tipo: 'FIGURINHA',
        metadados: { animada: true },
        midia: { nome: 'figurinha-F1.webp', mime: 'image/webp' },
      });
      expect(
        interpretarConteudo(
          { videoMessage: { mimetype: 'video/mp4', gifPlayback: true } },
          'V1',
        ),
      ).toMatchObject({
        tipo: 'VIDEO',
        metadados: { gif: true },
        midia: { nome: 'video-V1.mp4' },
      });
    });

    it('localização, contato, vários contatos e reação', () => {
      expect(
        interpretarConteudo(
          {
            locationMessage: {
              degreesLatitude: -23.5,
              degreesLongitude: -46.6,
              name: 'Escritório',
              address: 'Av. Paulista, 1000',
            },
          },
          'L1',
        ),
      ).toMatchObject({
        tipo: 'LOCALIZACAO',
        texto: 'Escritório — Av. Paulista, 1000',
        metadados: {
          latitude: -23.5,
          longitude: -46.6,
          nome: 'Escritório',
          endereco: 'Av. Paulista, 1000',
        },
      });
      expect(
        interpretarConteudo(
          {
            contactMessage: {
              displayName: 'Ana',
              vcard: 'BEGIN:VCARD\nEND:VCARD',
            },
          },
          'C1',
        ),
      ).toMatchObject({
        tipo: 'CONTATO',
        texto: 'Ana',
        metadados: { nome: 'Ana', vcard: 'BEGIN:VCARD\nEND:VCARD' },
      });
      expect(
        interpretarConteudo(
          {
            contactsArrayMessage: {
              contacts: [{ displayName: 'A' }, { displayName: 'B' }],
            },
          },
          'C2',
        ),
      ).toMatchObject({
        tipo: 'CONTATO',
        texto: '2 contatos',
        metadados: { contatos: [{ nome: 'A' }, { nome: 'B' }] },
      });
      expect(
        interpretarConteudo(
          { reactionMessage: { text: '👍', key: { id: '3EB0ALVO' } } },
          'R1',
        ),
      ).toMatchObject({
        tipo: 'REACAO',
        texto: '👍',
        metadados: { emoji: '👍', alvoIdExterno: '3EB0ALVO' },
      });
    });

    it('controle (edição, chaves) é ignorado; tipo novo vira aviso em texto', () => {
      expect(
        interpretarConteudo({ protocolMessage: { type: 0 } }, 'P1'),
      ).toBeNull();
      expect(
        interpretarConteudo(
          {
            senderKeyDistributionMessage: {},
            messageContextInfo: {},
          },
          'P2',
        ),
      ).toBeNull();
      expect(interpretarConteudo(null, 'P3')).toBeNull();
      expect(
        interpretarConteudo({ pollCreationMessage: { name: 'Enquete' } }, 'E1'),
      ).toMatchObject({
        tipo: 'TEXTO',
        texto: TEXTO_DE_TIPO_NAO_SUPORTADO,
        metadados: { tipoOriginal: 'pollCreationMessage' },
      });
    });
  });

  describe('conteudoDoEnvio', () => {
    const base: EnvioDoTransporte = {
      idExterno: '3EB0X',
      para: '5511999990000@s.whatsapp.net',
      tipo: 'TEXTO',
      texto: 'Olá',
    };
    const arquivo = {
      conteudo: Buffer.from('x'),
      nome: 'a.pdf',
      mime: 'application/pdf',
    };

    it('texto, mídias com legenda, voz e documento com nome', () => {
      expect(conteudoDoEnvio(base)).toEqual({ text: 'Olá' });
      expect(
        conteudoDoEnvio({
          ...base,
          tipo: 'IMAGEM',
          midia: { ...arquivo, mime: 'image/png' },
        }),
      ).toEqual({
        image: arquivo.conteudo,
        caption: 'Olá',
        mimetype: 'image/png',
      });
      expect(
        conteudoDoEnvio({
          ...base,
          tipo: 'AUDIO',
          texto: null,
          voz: true,
          midia: { ...arquivo, mime: 'audio/ogg; codecs=opus' },
        }),
      ).toEqual({
        audio: arquivo.conteudo,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      });
      expect(
        conteudoDoEnvio({ ...base, tipo: 'DOCUMENTO', midia: arquivo }),
      ).toEqual({
        document: arquivo.conteudo,
        mimetype: 'application/pdf',
        fileName: 'a.pdf',
        caption: 'Olá',
      });
    });

    it('localização, contato e reação pelos metadados', () => {
      expect(
        conteudoDoEnvio({
          ...base,
          tipo: 'LOCALIZACAO',
          metadados: { latitude: -23.5, longitude: '-46.6', nome: 'Sede' },
        }),
      ).toEqual({
        location: {
          degreesLatitude: -23.5,
          degreesLongitude: -46.6,
          name: 'Sede',
          address: undefined,
        },
      });
      expect(
        conteudoDoEnvio({
          ...base,
          tipo: 'CONTATO',
          metadados: { vcard: 'BEGIN:VCARD', nome: 'Ana' },
        }),
      ).toEqual({
        contacts: {
          displayName: 'Ana',
          contacts: [{ displayName: 'Ana', vcard: 'BEGIN:VCARD' }],
        },
      });
      expect(
        conteudoDoEnvio({
          ...base,
          tipo: 'REACAO',
          metadados: {
            emoji: '❤️',
            alvoIdExterno: '3EB0ALVO',
            alvoDeMim: true,
          },
        }),
      ).toEqual({
        react: {
          text: '❤️',
          key: { remoteJid: base.para, id: '3EB0ALVO', fromMe: true },
        },
      });
    });

    it('falha definitiva quando falta o necessário', () => {
      const casos: EnvioDoTransporte[] = [
        { ...base, texto: '   ' },
        { ...base, tipo: 'IMAGEM', midia: null },
        { ...base, tipo: 'LOCALIZACAO', metadados: { latitude: 'x' } },
        { ...base, tipo: 'CONTATO', metadados: {} },
        { ...base, tipo: 'REACAO', metadados: { emoji: '👍' } },
      ];
      for (const caso of casos) {
        expect(() => conteudoDoEnvio(caso)).toThrow(FalhaDefinitivaDeEnvio);
      }
    });
  });

  it('citação mínima e limite do WhatsApp', () => {
    expect(
      mensagemCitada('5511@s.whatsapp.net', '3EB0C', {
        texto: 'Oi',
        deMim: true,
      }),
    ).toEqual({
      key: { remoteJid: '5511@s.whatsapp.net', id: '3EB0C', fromMe: true },
      message: { conversation: 'Oi' },
    });
    expect(mensagemCitada('x@lid', 'Y', null).key.fromMe).toBe(false);
    const limite = Object.assign(new Error('rate-overlimit'), {
      data: 429,
    });
    expect(ehLimiteDoWhatsapp(limite)).toBe(true);
    expect(
      ehLimiteDoWhatsapp(
        Object.assign(new Error('x'), { output: { statusCode: 429 } }),
      ),
    ).toBe(true);
    expect(ehLimiteDoWhatsapp(new Error('timed out'))).toBe(false);
    expect(ehLimiteDoWhatsapp('rate-overlimit')).toBe(false);
  });

  it('números do protobuf (number, Long, texto)', () => {
    expect(numeroDoProtobuf(5)).toBe(5);
    expect(numeroDoProtobuf({ toNumber: () => 9 })).toBe(9);
    expect(numeroDoProtobuf('12')).toBe(12);
    expect(numeroDoProtobuf(null)).toBeNull();
    expect(numeroDoProtobuf(Number.NaN)).toBeNull();
  });
});
