import { Readable } from 'node:stream';
import type request from 'supertest';
import {
  ArquivosService,
  FILA_APAGAR_CONTEUDO,
} from '../src/arquivos/arquivos.service';
import { LIMITE_AVATAR_BYTES } from '../src/arquivos/politica';
import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarArquivo,
  criarChatCanal,
  criarChatMensagem,
  criarConversa,
  criarFila,
  criarMensagem,
  criarRespostaRapida,
  criarUsuario,
  drenarFilas,
  entrarComo,
  PDF_DE_TESTE,
  PNG_DE_TESTE,
} from './utils';

/** Lê o corpo da resposta como bytes, qualquer que seja o tipo. */
function binario(
  resposta: request.Response,
  callback: (erro: Error | null, corpo: Buffer) => void,
): void {
  const pedacos: Buffer[] = [];
  resposta.on('data', (pedaco: Buffer) => pedacos.push(pedaco));
  resposta.on('end', () => callback(null, Buffer.concat(pedacos)));
}

/**
 * Arquivos (R11, §2.1 do contrato da Onda A) com o driver em memória
 * (`ARQUIVOS_DRIVER=memoria`, padrão dos testes): envio multipart, download só
 * pela API com a permissão do item, cabeçalhos seguros, tipos e limites.
 */
describe('Arquivos (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  it('R11 — envia por multipart e baixa pela API com cabeçalhos seguros (sem expor a chave)', async () => {
    const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
    const cliente = await entrarComo(t, usuario);
    const envio = await cliente
      .post('/api/v1/arquivos?contexto=MENSAGEM')
      .attach('arquivo', PNG_DE_TESTE, {
        filename: 'foto "da" loja.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect(envio.body).toMatchObject({
      nome: 'foto "da" loja.png',
      mime: 'image/png',
      tamanho: PNG_DE_TESTE.length,
      contexto: 'MENSAGEM',
      url: `/api/v1/arquivos/${envio.body.id}`,
    });
    expect(envio.body).not.toHaveProperty('chave');
    const registro = await t.prisma.arquivo.findUniqueOrThrow({
      where: { id: envio.body.id as string },
    });
    expect(registro).toMatchObject({ criadoPorId: usuario.id });
    expect(registro.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.arquivos.conteudoDe(registro.chave)).toEqual(PNG_DE_TESTE);

    const download = await cliente
      .get(envio.body.url as string)
      .buffer(true)
      .parse(binario)
      .expect(200);
    expect(download.body).toEqual(PNG_DE_TESTE);
    expect(download.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      etag: `"${registro.sha256}"`,
      'accept-ranges': 'bytes',
    });
    expect(download.headers['content-disposition']).toBe(
      `inline; filename="foto _da_ loja.png"; filename*=UTF-8''foto%20%22da%22%20loja.png`,
    );
    expect(download.headers['content-security-policy']).toContain('sandbox');

    const forcado = await cliente
      .get(`${envio.body.url as string}?download=true`)
      .expect(200);
    expect(forcado.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('R11 — Range devolve 206 com o pedaço e If-None-Match devolve 304', async () => {
    const usuario = await criarUsuario(t);
    const cliente = await entrarComo(t, usuario);
    const arquivo = await criarArquivo(t, {
      contexto: 'OUTRO',
      conteudo: 'abcdefghij',
      criadoPor: usuario,
    });
    const parcial = await cliente
      .get(`/api/v1/arquivos/${arquivo.id}`)
      .set('Range', 'bytes=2-5')
      .buffer(true)
      .parse(binario)
      .expect(206);
    expect(parcial.body.toString()).toBe('cdef');
    expect(parcial.headers['content-range']).toBe('bytes 2-5/10');
    await cliente
      .get(`/api/v1/arquivos/${arquivo.id}`)
      .set('Range', 'bytes=50-60')
      .expect(416);
    await cliente
      .get(`/api/v1/arquivos/${arquivo.id}`)
      .set('If-None-Match', `"${arquivo.sha256}"`)
      .expect(304);
  });

  it('cenário 16 — R11: recusa SVG e HTML (415), inclusive disfarçados de outro tipo', async () => {
    const cliente = await entrarComo(t, await criarUsuario(t));
    const svg = await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach(
        'arquivo',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        {
          filename: 'logo.svg',
          contentType: 'image/svg+xml',
        },
      )
      .expect(415);
    expect(svg.body).toMatchObject({
      erro: 'tipo_nao_suportado',
      detalhes: { regra: 'R11' },
    });
    expect(svg.body.mensagem).not.toMatch(/R11/);
    await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach('arquivo', Buffer.from('<html><body>oi</body></html>'), {
        filename: 'pagina.html',
        contentType: 'text/html',
      })
      .expect(415);
    // Texto que na verdade é HTML; PNG que não é PNG.
    await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach(
        'arquivo',
        Buffer.from('<!DOCTYPE html><script>alert(1)</script>'),
        {
          filename: 'nota.txt',
          contentType: 'text/plain',
        },
      )
      .expect(415);
    await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach('arquivo', Buffer.from('não sou uma imagem'), {
        filename: 'foto.png',
        contentType: 'image/png',
      })
      .expect(415);
    expect(await t.prisma.arquivo.count()).toBe(0);
    expect(t.arquivos.quantidade).toBe(0);
  });

  it('cenário 16 — R11: respeita o limite do contexto (413) e recusa arquivo vazio ou ausente (400)', async () => {
    const cliente = await entrarComo(t, await criarUsuario(t));
    const grande = Buffer.alloc(LIMITE_AVATAR_BYTES + 1);
    PNG_DE_TESTE.copy(grande);
    const resposta = await cliente
      .post('/api/v1/arquivos?contexto=AVATAR')
      .attach('arquivo', grande, {
        filename: 'eu.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(resposta.body).toMatchObject({
      erro: 'muito_grande',
      detalhes: { regra: 'R11', limiteBytes: LIMITE_AVATAR_BYTES },
    });
    await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach('arquivo', Buffer.alloc(0), {
        filename: 'vazio.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    await cliente
      .post('/api/v1/arquivos?contexto=OUTRO')
      .field('outro', 'x')
      .expect(400);
    await cliente
      .post('/api/v1/arquivos?contexto=QUALQUER')
      .attach('arquivo', PDF_DE_TESTE, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(await t.prisma.arquivo.count()).toBe(0);
    expect(t.arquivos.quantidade).toBe(0);
  });

  it('sem login, envio e download respondem 401', async () => {
    const arquivo = await criarArquivo(t, {
      contexto: 'AVATAR',
      mime: 'image/png',
    });
    await clienteAnonimo(t).get(`/api/v1/arquivos/${arquivo.id}`).expect(401);
    await clienteAnonimo(t)
      .post('/api/v1/arquivos?contexto=OUTRO')
      .attach('arquivo', PDF_DE_TESTE, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(401);
  });

  it('cenário 17 — R11: mídia de mensagem: quem vê a conversa baixa; quem não vê recebe 404', async () => {
    const fila = await criarFila(t, { area: 'COMERCIAL' });
    const conversa = await criarConversa(t, { fila });
    const arquivo = await criarArquivo(t, {
      contexto: 'MENSAGEM',
      mime: 'application/pdf',
    });
    await criarMensagem(t, {
      conversa,
      tipo: 'DOCUMENTO',
      arquivo,
      texto: null,
    });
    const url = `/api/v1/arquivos/${arquivo.id}`;

    for (const papel of [
      'ADMIN',
      'C_LEVEL',
      'LIDER_COMERCIAL',
      'COMERCIAL',
    ] as const) {
      await (
        await entrarComo(t, await criarUsuario(t, { papel }))
      )
        .get(url)
        .expect(200);
    }
    for (const papel of [
      'CS',
      'LIDER_CS',
      'MARKETING',
      'LIDER_MARKETING',
    ] as const) {
      await (
        await entrarComo(t, await criarUsuario(t, { papel }))
      )
        .get(url)
        .expect(404);
    }
    // Com responsável, o membro que não é o responsável deixa de ver.
    const responsavel = await criarUsuario(t, { papel: 'COMERCIAL' });
    await t.prisma.conversa.update({
      where: { id: conversa.id },
      data: { responsavelId: responsavel.id },
    });
    await (await entrarComo(t, responsavel)).get(url).expect(200);
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'COMERCIAL' }))
    )
      .get(url)
      .expect(404);

    // Anexo de resposta rápida: quem usa o Atendimento.
    const anexo = await criarArquivo(t, { contexto: 'MENSAGEM' });
    await criarRespostaRapida(t, { arquivo: anexo });
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'CS' }))
    )
      .get(`/api/v1/arquivos/${anexo.id}`)
      .expect(200);
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'MARKETING' }))
    )
      .get(`/api/v1/arquivos/${anexo.id}`)
      .expect(404);
  });

  it('cenário 17 — R11/R15: anexo do chat interno: só membros do canal (nem o Admin)', async () => {
    const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
    const bia = await criarUsuario(t, { papel: 'CS' });
    const direto = await criarChatCanal(t, {
      tipo: 'DIRETO',
      membros: [ana, bia],
    });
    const arquivo = await criarArquivo(t, { contexto: 'CHAT', criadoPor: ana });
    await criarChatMensagem(t, { canal: direto, autor: ana, arquivo });
    const url = `/api/v1/arquivos/${arquivo.id}`;
    await (await entrarComo(t, ana)).get(url).expect(200);
    await (await entrarComo(t, bia)).get(url).expect(200);
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }))
    )
      .get(url)
      .expect(404);
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'CS' }))
    )
      .get(url)
      .expect(404);
  });

  it('R11 — sem verificador: AVATAR para qualquer logado; IMPORTACAO e OUTRO só o Admin (ou quem enviou)', async () => {
    const dono = await criarUsuario(t, { papel: 'CS' });
    const avatar = await criarArquivo(t, {
      contexto: 'AVATAR',
      mime: 'image/png',
      criadoPor: dono,
    });
    const outro = await criarArquivo(t, { contexto: 'OUTRO', criadoPor: dono });
    const colega = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'COMERCIAL' }),
    );
    await colega.get(`/api/v1/arquivos/${avatar.id}`).expect(200);
    await colega.get(`/api/v1/arquivos/${outro.id}`).expect(404);
    await (
      await entrarComo(t, dono)
    )
      .get(`/api/v1/arquivos/${outro.id}`)
      .expect(200);
    await (
      await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }))
    )
      .get(`/api/v1/arquivos/${outro.id}`)
      .expect(200);
  });

  it('R11 — remover marca removidoEm, audita e apaga o conteúdo só depois do commit', async () => {
    const usuario = await criarUsuario(t);
    const cliente = await entrarComo(t, usuario);
    const arquivos = t.get(ArquivosService);
    const arquivo = await criarArquivo(t, {
      contexto: 'OUTRO',
      criadoPor: usuario,
    });
    expect(t.arquivos.quantidade).toBe(1);

    // Transação desfeita: nada muda.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await arquivos.remover(arquivo.id, { tx });
        throw new Error('desfaz');
      }),
    ).rejects.toThrow('desfaz');
    expect(
      (await t.prisma.arquivo.findUniqueOrThrow({ where: { id: arquivo.id } }))
        .removidoEm,
    ).toBeNull();
    expect(await drenarFilas(t, FILA_APAGAR_CONTEUDO)).toBe(0);

    await arquivos.remover(arquivo.id, { motivo: 'teste' });
    await arquivos.remover(arquivo.id); // idempotente
    await cliente.get(`/api/v1/arquivos/${arquivo.id}`).expect(404);
    expect(t.arquivos.quantidade).toBe(1);
    expect(await drenarFilas(t, FILA_APAGAR_CONTEUDO)).toBe(1);
    expect(t.arquivos.quantidade).toBe(0);
    const auditoria = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'arquivo.removido', entidadeId: arquivo.id },
    });
    expect(auditoria).toHaveLength(1);
  });

  it('ArquivosService.salvar aceita stream, mede o tamanho e o SHA-256 lendo uma vez', async () => {
    const arquivos = t.get(ArquivosService);
    const partes = ['primeira parte, ', 'segunda parte, ', 'fim'];
    const arquivo = await arquivos.salvar(
      Readable.from(partes.map((parte) => Buffer.from(parte))),
      {
        nome: '../../etc/passwd.txt',
        mime: 'application/octet-stream',
        contexto: 'OUTRO',
      },
    );
    expect(arquivo).toMatchObject({
      nome: 'passwd.txt',
      mime: 'text/plain',
      tamanho: partes.join('').length,
    });
    const { stream } = await arquivos.abrirLeitura(arquivo.id);
    const lidos: Buffer[] = [];
    for await (const pedaco of stream) {
      lidos.push(pedaco as Buffer);
    }
    expect(Buffer.concat(lidos).toString()).toBe(partes.join(''));
  });
});
