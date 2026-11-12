import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarArquivo,
  criarUsuario,
  entrarComo,
  PNG_DE_TESTE,
} from './utils';

/**
 * Foto de perfil pela própria pessoa (R2.10): envia a imagem como `AVATAR`, liga ao
 * perfil, troca (a anterior sai do armazenamento) e remove; colegas abrem a foto.
 */
describe('Foto de perfil (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function enviarFoto(cliente: Awaited<ReturnType<typeof entrarComo>>) {
    const envio = await cliente
      .post('/api/v1/arquivos?contexto=AVATAR')
      .attach('arquivo', PNG_DE_TESTE, {
        filename: 'eu.png',
        contentType: 'image/png',
      })
      .expect(201);
    return envio.body.id as string;
  }

  it('R2.10 — membro troca a própria foto; aparece no auth/eu e um colega abre a imagem', async () => {
    const membro = await criarUsuario(t, { papel: 'COMERCIAL' });
    const cliente = await entrarComo(t, membro);
    const arquivoId = await enviarFoto(cliente);

    const resposta = await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId })
      .expect(200);
    expect(resposta.body).toEqual({
      avatarUrl: `/api/v1/arquivos/${arquivoId}`,
    });

    const eu = await cliente.get('/api/v1/auth/eu').expect(200);
    expect(eu.body.usuario.avatarUrl).toBe(`/api/v1/arquivos/${arquivoId}`);

    const colega = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'COMERCIAL' }),
    );
    await colega.get(`/api/v1/arquivos/${arquivoId}`).expect(200);

    const auditoria = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'usuario.atualizado', entidadeId: membro.id },
    });
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].resumo).toContain('trocou a foto de perfil');
  });

  it('R2.10 — trocar de novo remove a foto anterior; remover volta a null e apaga a atual', async () => {
    const membro = await criarUsuario(t, { papel: 'LIDER_CS' });
    const cliente = await entrarComo(t, membro);
    const primeira = await enviarFoto(cliente);
    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: primeira })
      .expect(200);
    const segunda = await enviarFoto(cliente);
    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: segunda })
      .expect(200);

    const anterior = await t.prisma.arquivo.findUniqueOrThrow({
      where: { id: primeira },
    });
    expect(anterior.removidoEm).not.toBeNull();
    await cliente.get(`/api/v1/arquivos/${primeira}`).expect(404);

    // Repetir a mesma foto não muda nada (nem audita de novo).
    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: segunda })
      .expect(200);

    const removida = await cliente
      .delete('/api/v1/usuarios/eu/foto')
      .expect(200);
    expect(removida.body).toEqual({ avatarUrl: null });
    const usuario = await t.prisma.usuario.findUniqueOrThrow({
      where: { id: membro.id },
    });
    expect(usuario.avatarUrl).toBeNull();
    const atual = await t.prisma.arquivo.findUniqueOrThrow({
      where: { id: segunda },
    });
    expect(atual.removidoEm).not.toBeNull();
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'usuario.atualizado', entidadeId: membro.id },
      }),
    ).toBe(3);
  });

  it('R2.10 — arquivo de outra pessoa é 404; de outro contexto é 422; id inválido é 400', async () => {
    const dono = await criarUsuario(t, { papel: 'COMERCIAL' });
    const outro = await criarUsuario(t, { papel: 'COMERCIAL' });
    const doDono = await enviarFoto(await entrarComo(t, dono));
    const cliente = await entrarComo(t, outro);

    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: doDono })
      .expect(404);

    const mensagem = await criarArquivo(t, {
      mime: 'image/png',
      contexto: 'MENSAGEM',
      criadoPor: outro,
    });
    const recusa = await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: mensagem.id })
      .expect(422);
    expect(recusa.body.detalhes).toMatchObject({
      regra: 'R2.10',
      campo: 'arquivoId',
    });

    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId: 'x' })
      .expect(400);
    const usuario = await t.prisma.usuario.findUniqueOrThrow({
      where: { id: outro.id },
    });
    expect(usuario.avatarUrl).toBeNull();
  });

  it('R2.10 — a foto externa posta pelo Admin não é apagada ao trocar; sem login, 401', async () => {
    const membro = await criarUsuario(t, { papel: 'COMERCIAL' });
    await t.prisma.usuario.update({
      where: { id: membro.id },
      data: { avatarUrl: 'https://exemplo.com/foto.png' },
    });
    const cliente = await entrarComo(t, membro);
    const arquivoId = await enviarFoto(cliente);
    await cliente
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId })
      .expect(200);
    expect(
      await t.prisma.arquivo.count({ where: { removidoEm: { not: null } } }),
    ).toBe(0);

    await clienteAnonimo(t)
      .put('/api/v1/usuarios/eu/foto')
      .send({ arquivoId })
      .expect(401);
    await clienteAnonimo(t).delete('/api/v1/usuarios/eu/foto').expect(401);
  });
});
