import {
  type AppTeste,
  criarAppTeste,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarUsuario,
  entrarComo,
} from './utils';

interface EmpresaDaApi {
  id: string;
  nome: string;
  quantidadeContatos: number;
}

describe('Contatos — empresas (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  it('R4.4 — cria empresa com CNPJ válido (gravado sem pontuação); R4.5 — o responsável padrão é quem criou', async () => {
    const {
      membros: [ana],
    } = await criarEquipe(t, 'COMERCIAL');
    const cliente = await entrarComo(t, ana);
    const resposta = await cliente
      .post('/api/v1/empresas', {
        nome: '  ACME   Ltda ',
        cnpj: '11.222.333/0001-81',
        email: 'Contato@ACME.com.br',
        telefone: '(11) 3333-4444',
        uf: 'sp',
        cidade: 'São Paulo',
        etiquetas: ['Cliente', 'cliente'],
        camposPersonalizados: { porte: 'médio' },
      })
      .expect(201);
    expect(resposta.body).toMatchObject({
      nome: 'ACME Ltda',
      cnpj: '11222333000181',
      cnpjFormatado: '11.222.333/0001-81',
      email: 'contato@acme.com.br',
      telefone: '551133334444',
      uf: 'SP',
      cidade: 'São Paulo',
      etiquetas: ['Cliente'],
      camposPersonalizados: { porte: 'médio' },
      responsavel: { id: ana.id },
      criadoPor: { id: ana.id },
      quantidadeContatos: 0,
      podeEditar: true,
    });
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'empresa.criada' },
    });
    expect(auditoria).toMatchObject({
      entidade: 'empresa',
      entidadeId: resposta.body.id,
      usuarioId: ana.id,
      resumo: 'Empresa "ACME Ltda" criada',
    });
    expect(
      await t.prisma.eventoDominio.count({ where: { tipo: 'empresa.criada' } }),
    ).toBe(1);
  });

  it('R4.4 — nome obrigatório; CNPJ com dígito verificador errado ou UF inexistente é 400', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const semNome = await admin
      .post('/api/v1/empresas', { cnpj: '11.222.333/0001-81' })
      .expect(400);
    expect(semNome.body.detalhes.campos).toContainEqual({
      campo: 'nome',
      mensagens: expect.arrayContaining(['é obrigatório']),
    });
    const cnpj = await admin
      .post('/api/v1/empresas', { nome: 'X', cnpj: '11.222.333/0001-82' })
      .expect(400);
    expect(cnpj.body.detalhes.campos).toEqual([
      {
        campo: 'cnpj',
        mensagens: [
          'deve ser um CNPJ válido (dígitos verificadores não conferem)',
        ],
      },
    ]);
    const uf = await admin
      .post('/api/v1/empresas', { nome: 'X', uf: 'XX' })
      .expect(400);
    expect(uf.body.detalhes.campos[0].campo).toBe('uf');
    expect(await t.prisma.empresa.count()).toBe(0);
  });

  it('R4.4 — CNPJ único entre as empresas (409 na criação e na edição); o CNPJ alfanumérico é aceito', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const acme = (
      await admin
        .post('/api/v1/empresas', { nome: 'ACME', cnpj: '11222333000181' })
        .expect(201)
    ).body as EmpresaDaApi;
    const repetido = await admin
      .post('/api/v1/empresas', { nome: 'Outra', cnpj: '11.222.333/0001-81' })
      .expect(409);
    expect(repetido.body).toMatchObject({
      erro: 'conflito',
      detalhes: { regra: 'R4.4', campos: ['cnpj'], empresaId: acme.id },
    });
    const alfanumerica = await admin
      .post('/api/v1/empresas', { nome: 'Nova', cnpj: '12.abc.345/01de-35' })
      .expect(201);
    expect(alfanumerica.body).toMatchObject({
      cnpj: '12ABC34501DE35',
      cnpjFormatado: '12.ABC.345/01DE-35',
    });
    await admin
      .patch(`/api/v1/empresas/${alfanumerica.body.id}`, {
        cnpj: '11222333000181',
      })
      .expect(409);
    const semCnpj = await admin
      .patch(`/api/v1/empresas/${alfanumerica.body.id}`, { cnpj: null })
      .expect(200);
    expect(semCnpj.body.cnpj).toBeNull();
    await admin
      .post('/api/v1/empresas', { nome: 'Terceira', cnpj: '12ABC34501DE35' })
      .expect(201);
  });

  it('R4.4 — criações simultâneas com o mesmo CNPJ: uma cria e as outras recebem 409', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const respostas = await Promise.all(
      [1, 2, 3].map((numero) =>
        admin.post('/api/v1/empresas', {
          nome: `Empresa ${numero}`,
          cnpj: '11.222.333/0001-81',
        }),
      ),
    );
    expect(
      respostas.map((resposta) => resposta.status).sort((a, b) => a - b),
    ).toEqual([201, 409, 409]);
    expect(await t.prisma.empresa.count()).toBe(1);
  });

  it('§12/R4.5 — edição segue o alcance; o responsável precisa ser ativo; o novo responsável é notificado', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL');
    const [ana, bruno] = comercial.membros;
    const daAna = await criarEmpresa(t, { responsavel: ana });
    const doBruno = await criarEmpresa(t, { responsavel: bruno });
    const clienteAna = await entrarComo(t, ana);
    const editada = await clienteAna
      .patch(`/api/v1/empresas/${daAna.id}`, {
        segmento: 'Varejo',
        site: 'https://acme.com.br',
      })
      .expect(200);
    expect(editada.body).toMatchObject({
      segmento: 'Varejo',
      site: 'https://acme.com.br',
    });
    const negada = await clienteAna
      .patch(`/api/v1/empresas/${doBruno.id}`, { segmento: 'X' })
      .expect(403);
    expect(negada.body.mensagem).toBe(
      'Você só edita empresas das quais é o responsável.',
    );
    await clienteAna
      .patch(`/api/v1/empresas/${daAna.id}`, { responsavelId: bruno.id })
      .expect(403);

    const lider = await entrarComo(t, comercial.lider);
    const inativo = await criarUsuario(t, {
      papel: 'COMERCIAL',
      lider: comercial.lider,
      ativo: false,
    });
    const recusada = await lider
      .patch(`/api/v1/empresas/${doBruno.id}`, { responsavelId: inativo.id })
      .expect(422);
    expect(recusada.body.detalhes.regra).toBe('R4.5');
    await lider
      .patch(`/api/v1/empresas/${doBruno.id}`, { responsavelId: ana.id })
      .expect(200);
    expect(
      await t.prisma.notificacao.findFirstOrThrow({
        where: { usuarioId: ana.id },
      }),
    ).toMatchObject({
      tipo: 'empresa.atribuida',
      link: `/empresas/${doBruno.id}`,
    });
    const auditoria = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'empresa.atualizada' },
      orderBy: { id: 'asc' },
    });
    expect(auditoria.map((evento) => evento.resumo)).toEqual([
      `Empresa "${daAna.nome}" atualizada: site, segmento`,
      `Empresa "${doBruno.nome}" atualizada: responsável`,
    ]);
    expect(
      await t.prisma.eventoDominio.count({
        where: { tipo: 'empresa.atualizada' },
      }),
    ).toBe(2);
  });

  it('listagem: busca por nome e CNPJ, filtros por UF e etiqueta, quantidade de contatos ativos', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const acme = await criarEmpresa(t, {
      nome: 'ACME Ltda',
      cnpj: '11222333000181',
      etiquetas: ['Cliente'],
    });
    await t.prisma.empresa.update({
      where: { id: acme.id },
      data: { uf: 'SP' },
    });
    await criarEmpresa(t, {
      nome: 'Beta Comércio',
      etiquetas: ['Cliente', 'Grande'],
    });
    await criarEmpresa(t, { nome: 'Gama', etiquetas: ['cliente'] });
    await criarContato(t, { empresa: acme });
    const excluido = await criarContato(t, { empresa: acme });
    await t.prisma.contato.update({
      where: { id: excluido.id },
      data: { excluidoEm: new Date() },
    });
    const listar = async (query: Record<string, string>) =>
      (
        (await admin.get('/api/v1/empresas').query(query).expect(200)).body
          .itens as EmpresaDaApi[]
      ).map((empresa) => empresa.nome);
    expect(await listar({})).toEqual(['ACME Ltda', 'Beta Comércio', 'Gama']);
    expect(await listar({ busca: 'acme' })).toEqual(['ACME Ltda']);
    expect(await listar({ busca: '11.222.333/0001' })).toEqual(['ACME Ltda']);
    expect(await listar({ uf: 'sp' })).toEqual(['ACME Ltda']);
    expect(await listar({ etiqueta: 'CLIENTE' })).toEqual([
      'ACME Ltda',
      'Beta Comércio',
      'Gama',
    ]);
    expect(await listar({ etiqueta: 'grande' })).toEqual(['Beta Comércio']);
    expect(await listar({ ordenarPor: 'nome', ordem: 'desc' })).toEqual([
      'Gama',
      'Beta Comércio',
      'ACME Ltda',
    ]);
    const lista = await admin
      .get('/api/v1/empresas')
      .query({ busca: 'acme' })
      .expect(200);
    expect(lista.body.itens[0].quantidadeContatos).toBe(1);
    const etiquetas = await admin.get('/api/v1/empresas/etiquetas').expect(200);
    expect(etiquetas.body).toEqual([
      { etiqueta: 'Cliente', quantidade: 3 },
      { etiqueta: 'Grande', quantidade: 1 },
    ]);
  });

  it('detalhe, 404 e lista branca', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    await admin
      .get('/api/v1/empresas/00000000-0000-4000-8000-000000000000')
      .expect(404);
    const empresa = await criarEmpresa(t, { nome: 'X' });
    await admin
      .patch(`/api/v1/empresas/${empresa.id}`, { excluidoEm: '2026-01-01' })
      .expect(400);
    const detalhe = await admin
      .get(`/api/v1/empresas/${empresa.id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      id: empresa.id,
      nome: 'X',
      cnpj: null,
      podeEditar: true,
    });
  });

  it('R4.2 — contato com empresaNome vincula a empresa ativa com o mesmo nome ou cria uma nova', async () => {
    const admin = await entrarComo(t, await criarUsuario(t));
    const acme = await criarEmpresa(t, { nome: 'ACME Ltda' });
    const primeiro = await admin
      .post('/api/v1/contatos', {
        nome: 'Ana',
        email: 'ana@acme.com',
        empresaNome: 'acme  ltda',
      })
      .expect(201);
    expect(primeiro.body.contato.empresa).toEqual({
      id: acme.id,
      nome: 'ACME Ltda',
    });
    const segundo = await admin
      .post('/api/v1/contatos', {
        nome: 'Bia',
        email: 'bia@nova.com',
        empresaNome: 'Nova S.A.',
      })
      .expect(201);
    expect(segundo.body.contato.empresa.nome).toBe('Nova S.A.');
    expect(await t.prisma.empresa.count()).toBe(2);
    await admin
      .post('/api/v1/contatos', {
        nome: 'Cid',
        email: 'cid@x.com',
        empresaId: acme.id,
        empresaNome: 'Outra',
      })
      .expect(400);
    const inexistente = await admin
      .post('/api/v1/contatos', {
        nome: 'Cid',
        email: 'cid@x.com',
        empresaId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(400);
    expect(inexistente.body.detalhes.campos).toEqual([
      { campo: 'empresaId', mensagens: ['empresa não encontrada'] },
    ]);
  });
});
