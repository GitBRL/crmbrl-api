import { interpretarFaixa } from './faixa';
import {
  avaliarTipo,
  cabecalhoContentDisposition,
  conferirConteudo,
  descreverTamanho,
  LIMITE_AVATAR_BYTES,
  LIMITE_DOCUMENTOS_BYTES,
  LIMITE_PADRAO_BYTES,
  normalizarMime,
  podeExibirNoNavegador,
  resolverMime,
  sanitizarNomeDeArquivo,
} from './politica';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\n...');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

describe('política de arquivos (R11)', () => {
  describe('tipos e limites', () => {
    it('aceita imagem, áudio e vídeo até 25 MB e documentos até 100 MB', () => {
      expect(avaliarTipo('image/jpeg', 'MENSAGEM')).toEqual({
        aceito: true,
        categoria: 'imagem',
        limiteBytes: LIMITE_PADRAO_BYTES,
      });
      expect(avaliarTipo('audio/webm', 'MENSAGEM')).toMatchObject({
        aceito: true,
        categoria: 'audio',
        limiteBytes: LIMITE_PADRAO_BYTES,
      });
      for (const mime of [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
        'application/zip',
      ]) {
        expect(avaliarTipo(mime, 'CHAT')).toMatchObject({
          aceito: true,
          limiteBytes: LIMITE_DOCUMENTOS_BYTES,
        });
      }
    });

    it('recusa SVG, HTML, scripts e tipos desconhecidos', () => {
      for (const mime of [
        'image/svg+xml',
        'text/html',
        'application/xhtml+xml',
        'application/javascript',
        'application/x-msdownload',
        'application/octet-stream',
      ]) {
        expect(avaliarTipo(mime, 'MENSAGEM')).toMatchObject({ aceito: false });
      }
    });

    it('foto de perfil: só imagem comum, até 5 MB', () => {
      expect(avaliarTipo('image/png', 'AVATAR')).toMatchObject({
        aceito: true,
        limiteBytes: LIMITE_AVATAR_BYTES,
      });
      expect(avaliarTipo('application/pdf', 'AVATAR')).toMatchObject({
        aceito: false,
      });
    });

    it('normaliza o MIME e usa a extensão quando ele vem genérico', () => {
      expect(normalizarMime(' Audio/WebM; codecs=opus ')).toBe('audio/webm');
      expect(normalizarMime('')).toBe('application/octet-stream');
      expect(resolverMime('application/octet-stream', 'nota.OPUS')).toBe(
        'audio/opus',
      );
      expect(resolverMime(undefined, 'planilha.xlsx')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(resolverMime('application/octet-stream', 'sem-extensao')).toBe(
        'application/octet-stream',
      );
      expect(resolverMime('image/png', 'foto.jpg')).toBe('image/png');
    });

    it('descreve tamanhos em português', () => {
      expect(descreverTamanho(LIMITE_PADRAO_BYTES)).toBe('25 MB');
      expect(descreverTamanho(1.5 * 1024 * 1024)).toBe('1,5 MB');
      expect(descreverTamanho(2048)).toBe('2 KB');
    });

    it('R16.2 — planilha de importação vai até 10 MB', () => {
      expect(avaliarTipo('text/csv', 'IMPORTACAO')).toMatchObject({
        aceito: true,
        limiteBytes: 10 * 1024 * 1024,
      });
    });
  });

  describe('conteúdo', () => {
    it('confere a assinatura de PNG, PDF e dos formatos zip', () => {
      expect(conferirConteudo(PNG, 'image/png')).toBeNull();
      expect(conferirConteudo(PDF, 'application/pdf')).toBeNull();
      expect(
        conferirConteudo(
          ZIP,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBeNull();
      expect(conferirConteudo(PDF, 'image/png')).toMatch(/não corresponde/);
      expect(conferirConteudo(PNG, 'application/pdf')).toMatch(
        /não corresponde/,
      );
    });

    it('confere o WebP pelo RIFF…WEBP', () => {
      const webp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([1, 2, 3, 4]),
        Buffer.from('WEBPVP8 '),
      ]);
      expect(conferirConteudo(webp, 'image/webp')).toBeNull();
      expect(
        conferirConteudo(Buffer.from('RIFF1234WAVE'), 'image/webp'),
      ).not.toBeNull();
    });

    it('recusa HTML ou SVG disfarçado, mesmo como texto ou imagem', () => {
      expect(
        conferirConteudo(
          Buffer.from('\uFEFF  <!DOCTYPE html><p>oi'),
          'text/plain',
        ),
      ).toMatch(/página ou um SVG/);
      expect(
        conferirConteudo(
          Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'),
          'image/png',
        ),
      ).toMatch(/página ou um SVG/);
      expect(
        conferirConteudo(Buffer.from('<script>alert(1)</script>'), 'text/csv'),
      ).toMatch(/página ou um SVG/);
      expect(
        conferirConteudo(Buffer.from('nome;email\nAna;a@x'), 'text/csv'),
      ).toBeNull();
      expect(
        conferirConteudo(Buffer.from('<b>negrito</b>'), 'text/plain'),
      ).toBeNull();
    });

    it('não confere tipos sem assinatura conhecida', () => {
      expect(conferirConteudo(Buffer.from('qualquer'), 'audio/ogg')).toBeNull();
    });
  });

  describe('nome do arquivo', () => {
    it('tira o caminho, os controles e os espaços repetidos', () => {
      expect(sanitizarNomeDeArquivo('../../etc/passwd')).toBe('passwd');
      expect(sanitizarNomeDeArquivo('C:\\Users\\ana\\proposta final.pdf')).toBe(
        'proposta final.pdf',
      );
      expect(sanitizarNomeDeArquivo('nota\u0000\u202e  fiscal\t.pdf')).toBe(
        'nota fiscal.pdf',
      );
      expect(sanitizarNomeDeArquivo('...oculto')).toBe('oculto');
      expect(sanitizarNomeDeArquivo('   ')).toBe('arquivo');
      expect(sanitizarNomeDeArquivo(undefined)).toBe('arquivo');
    });

    it('corta nomes longos preservando a extensão', () => {
      const nome = sanitizarNomeDeArquivo(`${'a'.repeat(300)}.pdf`);
      expect(nome).toHaveLength(200);
      expect(nome.endsWith('.pdf')).toBe(true);
    });

    it('monta o Content-Disposition com ASCII seguro e o nome em UTF-8', () => {
      expect(
        cabecalhoContentDisposition('Orçamento "final"; v2.pdf', 'inline'),
      ).toBe(
        `inline; filename="Orcamento _final__ v2.pdf"; filename*=UTF-8''Or%C3%A7amento%20%22final%22%3B%20v2.pdf`,
      );
      expect(cabecalhoContentDisposition('日本.txt', 'attachment')).toBe(
        `attachment; filename="__.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`,
      );
    });

    it('só abre no navegador imagem comum, áudio, vídeo e PDF', () => {
      expect(podeExibirNoNavegador('image/png')).toBe(true);
      expect(podeExibirNoNavegador('audio/ogg')).toBe(true);
      expect(podeExibirNoNavegador('video/mp4')).toBe(true);
      expect(podeExibirNoNavegador('application/pdf')).toBe(true);
      expect(podeExibirNoNavegador('text/plain')).toBe(false);
      expect(podeExibirNoNavegador('image/tiff')).toBe(false);
      expect(podeExibirNoNavegador('application/zip')).toBe(false);
    });
  });

  describe('faixa de bytes (Range)', () => {
    it('sem Range ou com formato não tratado, devolve o arquivo inteiro', () => {
      expect(interpretarFaixa(undefined, 100)).toEqual({ tipo: 'inteiro' });
      expect(interpretarFaixa('items=0-1', 100)).toEqual({ tipo: 'inteiro' });
      expect(interpretarFaixa('bytes=0-1,5-6', 100)).toEqual({
        tipo: 'inteiro',
      });
      expect(interpretarFaixa('bytes=-', 100)).toEqual({ tipo: 'inteiro' });
    });

    it('interpreta início-fim, início- e o sufixo', () => {
      expect(interpretarFaixa('bytes=0-9', 100)).toEqual({
        tipo: 'parcial',
        faixa: { inicio: 0, fim: 9 },
      });
      expect(interpretarFaixa('bytes=90-', 100)).toEqual({
        tipo: 'parcial',
        faixa: { inicio: 90, fim: 99 },
      });
      expect(interpretarFaixa('bytes=50-500', 100)).toEqual({
        tipo: 'parcial',
        faixa: { inicio: 50, fim: 99 },
      });
      expect(interpretarFaixa('bytes=-10', 100)).toEqual({
        tipo: 'parcial',
        faixa: { inicio: 90, fim: 99 },
      });
      expect(interpretarFaixa('bytes=-500', 100)).toEqual({
        tipo: 'parcial',
        faixa: { inicio: 0, fim: 99 },
      });
    });

    it('faixa fora do arquivo é inválida (416)', () => {
      expect(interpretarFaixa('bytes=100-', 100)).toEqual({ tipo: 'invalida' });
      expect(interpretarFaixa('bytes=9-2', 100)).toEqual({ tipo: 'invalida' });
      expect(interpretarFaixa('bytes=-0', 100)).toEqual({ tipo: 'invalida' });
      expect(interpretarFaixa('bytes=0-0', 0)).toEqual({ tipo: 'invalida' });
    });
  });
});
