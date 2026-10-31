import ExcelJS from 'exceljs';
import { FILA_IMPORTACAO } from '../src/importacao/importacao.constantes';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarArquivo,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  drenarTudo,
  entrarComo,
} from './utils';

interface ImportacaoDaApi {
  id: string;
  status: string;
  totalLinhas: number;
  processadas: number;
  criados: number;
  atualizados: number;
  ignorados: number;
  erros: number;
  relatorioId: string | null;
  mapeamento: Record<string, string>;
  erro: string | null;
  progresso: number;
  previa?: {
    colunas: string[];
    sugestao: Record<string, string>;
    totalLinhas: number;
  };
}

describe('Importação de contatos e empresas (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  async function lider() {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    return { ...equipe, cliente: await entrarComo(t, equipe.lider) };
  }

  /** Envia o CSV (arquivo no contexto IMPORTACAO) e cria o rascunho. */
  async function rascunho(
    cliente: ClienteHttp,
    csv: string | Buffer,
    tipo: 'CONTATOS' | 'EMPRESAS' = 'CONTATOS',
    nome = 'planilha.csv',
  ): Promise<ImportacaoDaApi> {
    const arquivo = await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome,
      mime: nome.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
      conteudo: csv,
      criadoPor: cliente.usuario!,
    });
    const resposta = await cliente
      .post('/api/v1/importacoes', { tipo, arquivoId: arquivo.id })
      .expect(201);
    return resposta.body as ImportacaoDaApi;
  }

  async function importar(
    cliente: ClienteHttp,
    csv: string,
    opcoes: Record<string, unknown> = {},
    tipo: 'CONTATOS' | 'EMPRESAS' = 'CONTATOS',
  ): Promise<ImportacaoDaApi> {
    const criada = await rascunho(cliente, csv, tipo);
    if (Object.keys(opcoes).length > 0) {
      await cliente
        .patch(`/api/v1/importacoes/${criada.id}`, opcoes)
        .expect(200);
    }
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const final = await cliente
      .get(`/api/v1/importacoes/${criada.id}`)
      .expect(200);
    return final.body as ImportacaoDaApi;
  }

  it('R16.1 — só Admin, C-level e líderes importam; membro recebe 403', async () => {
    const { membros, cliente: clienteLider, cLevel } = await lider();
    const membro = await entrarComo(t, membros[0]);
    await membro.get('/api/v1/importacoes').expect(403);
    await membro.get('/api/v1/importacoes/campos?tipo=CONTATOS').expect(403);
    await membro
      .post('/api/v1/importacoes', {
        tipo: 'CONTATOS',
        arquivoId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(403);
    await clienteLider.get('/api/v1/importacoes').expect(200);
    await (await entrarComo(t, cLevel)).get('/api/v1/importacoes').expect(200);
    const eu = await clienteLider.get('/api/v1/auth/eu').expect(200);
    expect(
      (eu.body as { permissoes: { importarContatos: boolean } }).permissoes
        .importarContatos,
    ).toBe(true);
    const euMembro = await membro.get('/api/v1/auth/eu').expect(200);
    expect(
      (euMembro.body as { permissoes: { importarContatos: boolean } })
        .permissoes.importarContatos,
    ).toBe(false);
  });

  it('R16.2 — o rascunho traz colunas, prévia e o mapeamento sugerido; separador e codificação detectados', async () => {
    const { cliente } = await lider();
    const criada = await rascunho(
      cliente,
      Buffer.from(
        'Nome;E-mail;Celular;Cidade\nJosé;jose@x.com;11987654321;Recife\nMaria;maria@x.com;;Olinda\n',
        'latin1',
      ),
    );
    expect(criada.status).toBe('RASCUNHO');
    expect(criada.totalLinhas).toBe(2);
    expect(criada.previa).toMatchObject({
      colunas: ['Nome', 'E-mail', 'Celular', 'Cidade'],
      totalLinhas: 2,
      sugestao: { Nome: 'nome', 'E-mail': 'email', Celular: 'telefone' },
    });
    expect(criada.mapeamento).toEqual({
      Nome: 'nome',
      'E-mail': 'email',
      Celular: 'telefone',
    });
    const previa = await cliente
      .get(`/api/v1/importacoes/${criada.id}/previa?linhas=1`)
      .expect(200);
    expect(
      (previa.body as { linhas: Array<{ valores: string[] }> }).linhas,
    ).toEqual([
      { numero: 2, valores: ['José', 'jose@x.com', '11987654321', 'Recife'] },
    ]);
    const auditoria = await t.prisma.eventoAuditoria.findFirst({
      where: { acao: 'importacao.criada' },
    });
    expect(auditoria).not.toBeNull();
  });

  it('R16.2 — recusa arquivo que não é planilha, planilha sem linhas e arquivo de outra pessoa', async () => {
    const { cliente, lider: dono } = await lider();
    const pdf = await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome: 'x.pdf',
      mime: 'application/pdf',
      criadoPor: dono,
    });
    await cliente
      .post('/api/v1/importacoes', { tipo: 'CONTATOS', arquivoId: pdf.id })
      .expect(400);
    const vazio = await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome: 'v.csv',
      mime: 'text/csv',
      conteudo: 'Nome,E-mail\n',
      criadoPor: dono,
    });
    const resposta = await cliente
      .post('/api/v1/importacoes', { tipo: 'CONTATOS', arquivoId: vazio.id })
      .expect(422);
    expect(
      (resposta.body as { detalhes: { regra: string } }).detalhes.regra,
    ).toBe('R16.2');
    const outra = await lider();
    const alheio = await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome: 'a.csv',
      mime: 'text/csv',
      conteudo: 'Nome,E-mail\nA,a@a.com\n',
      criadoPor: outra.lider,
    });
    await cliente
      .post('/api/v1/importacoes', { tipo: 'CONTATOS', arquivoId: alheio.id })
      .expect(404);
    const mensagem = await criarArquivo(t, {
      contexto: 'MENSAGEM',
      nome: 'm.csv',
      mime: 'text/csv',
      conteudo: 'Nome,E-mail\nA,a@a.com\n',
      criadoPor: dono,
    });
    await cliente
      .post('/api/v1/importacoes', { tipo: 'CONTATOS', arquivoId: mensagem.id })
      .expect(404);
  });

  it('R16.3 — o mapeamento é conferido (coluna, campo e repetição) e o início exige nome e e-mail ou telefone', async () => {
    const { cliente } = await lider();
    const criada = await rascunho(cliente, 'A,B,C\nx,y,z\n');
    expect(criada.mapeamento).toEqual({});
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(422);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        mapeamento: { A: 'nome', B: 'nome' },
      })
      .expect(400);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { mapeamento: { Z: 'nome' } })
      .expect(400);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { mapeamento: { A: 'cnpj' } })
      .expect(400);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { mapeamento: { A: 'nome' } })
      .expect(200);
    const sem = await cliente
      .post(`/api/v1/importacoes/${criada.id}/iniciar`)
      .expect(422);
    expect((sem.body as { detalhes: { regra: string } }).detalhes.regra).toBe(
      'R16.3',
    );
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        mapeamento: { A: 'nome', B: 'email', C: 'campos.cidade' },
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { duplicados: 'IGNORAR' })
      .expect(422);
  });

  it('R16.3 — modelo de mapeamento salvo é aplicado às colunas do outro arquivo', async () => {
    const { cliente } = await lider();
    await cliente
      .post('/api/v1/importacoes/modelos', {
        nome: 'Feira',
        tipo: 'CONTATOS',
        mapeamento: {
          'Nome do lead': 'nome',
          Mail: 'email',
          Cidade: 'campos.cidade',
        },
        opcoes: { duplicados: 'IGNORAR', etiquetas: ['feira'] },
      })
      .expect(201);
    await cliente
      .post('/api/v1/importacoes/modelos', {
        nome: 'Feira',
        tipo: 'CONTATOS',
        mapeamento: {},
      })
      .expect(409);
    await cliente
      .post('/api/v1/importacoes/modelos', {
        nome: 'Ruim',
        tipo: 'CONTATOS',
        mapeamento: { A: 'cnpj' },
      })
      .expect(400);
    const lista = await cliente
      .get('/api/v1/importacoes/modelos?tipo=CONTATOS')
      .expect(200);
    const [modelo] = lista.body as Array<{ id: string }>;
    const criada = await rascunho(
      cliente,
      'nome do lead,mail,cidade,outra\nAna,ana@x.com,Recife,1\n',
    );
    const aplicada = await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { modeloId: modelo.id })
      .expect(200);
    expect(aplicada.body).toMatchObject({
      mapeamento: {
        'nome do lead': 'nome',
        mail: 'email',
        cidade: 'campos.cidade',
      },
      modeloId: modelo.id,
      duplicados: 'IGNORAR',
      etiquetas: ['feira'],
    });
    await cliente
      .delete(`/api/v1/importacoes/modelos/${modelo.id}`)
      .expect(204);
    await cliente.get('/api/v1/importacoes/campos?tipo=EMPRESAS').expect(200);
  });

  it('R16.4/R16.8 — importa contatos: dedup R4.2, normalização R4.1, origem IMPORTACAO, etiquetas, responsável, progresso, relatório, auditoria resumida e evento', async () => {
    const { cliente, lider: dono } = await lider();
    const emitido = jest.spyOn(t.tempoReal, 'emitirParaUsuario');
    await criarContato(t, { nome: 'Ana Antiga', email: 'ana@x.com' });
    const final = await importar(
      cliente,
      [
        'Nome,E-mail,Telefone,Empresa,Cidade,Etiquetas',
        'Ana Souza,ANA@x.com,,ACME,Recife,vip;feira',
        'Bruno Lima,bruno@x.com,(11) 98765-4321,,Olinda,',
        'Carla,,(11) 91234-5678,Beta,,',
        ',sem-nome@x.com,,,,',
        'Davi,email-ruim,,,,',
        'Eva,eva@x.com,123,,,',
        ',,,,,',
      ].join('\n'),
      {
        mapeamento: {
          Nome: 'nome',
          'E-mail': 'email',
          Telefone: 'telefone',
          Empresa: 'empresa',
          Cidade: 'campos.cidade',
          Etiquetas: 'etiquetas',
        },
        etiquetas: ['Importado'],
        origemDetalhe: 'Feira 2026',
      },
    );
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      totalLinhas: 6,
      processadas: 6,
      criados: 3,
      atualizados: 1,
      ignorados: 0,
      erros: 2,
      progresso: 100,
    });
    const ana = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'ana@x.com' },
    });
    expect(ana).toMatchObject({
      ultimaOrigem: 'IMPORTACAO',
      ultimaOrigemDetalhe: 'Feira 2026',
      conversoes: 2,
    });
    expect(ana.etiquetas).toEqual(
      expect.arrayContaining(['vip', 'feira', 'Importado']),
    );
    const bruno = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'bruno@x.com' },
    });
    expect(bruno).toMatchObject({
      telefone: '5511987654321',
      primeiraOrigem: 'IMPORTACAO',
      responsavelId: dono.id,
      camposPersonalizados: { cidade: 'Olinda' },
    });
    expect(
      await t.prisma.empresa.count({
        where: { nome: { in: ['ACME', 'Beta'] } },
      }),
    ).toBe(2);
    // Eva: e-mail válido e telefone inválido -> importa e avisa no relatório.
    const eva = await cliente
      .get(`/api/v1/importacoes/${final.id}/linhas?pagina=1&porPagina=50`)
      .expect(200);
    const linhas = (
      eva.body as {
        itens: Array<{
          numero: number;
          resultado: string;
          motivo: string | null;
        }>;
      }
    ).itens;
    expect(linhas.map((l) => [l.numero, l.resultado])).toEqual([
      [2, 'ATUALIZADO'],
      [3, 'CRIADO'],
      [4, 'CRIADO'],
      [5, 'ERRO'],
      [6, 'ERRO'],
      [7, 'CRIADO'],
    ]);
    expect(linhas[3].motivo).toMatch(/Nome/);
    expect(linhas[4].motivo).toMatch(/inválido/i);
    expect(linhas[5].motivo).toMatch(/Telefone inválido/);
    const erros = await cliente
      .get(`/api/v1/importacoes/${final.id}/linhas?resultado=ERRO`)
      .expect(200);
    expect((erros.body as { total: number }).total).toBe(2);

    // Auditoria resumida: um evento por importação (além dos eventos dos contatos criados).
    const resumo = await t.prisma.eventoAuditoria.findMany({
      where: { acao: { startsWith: 'importacao.' } },
    });
    expect(resumo.map((e) => e.acao).sort()).toEqual([
      'importacao.concluida',
      'importacao.criada',
      'importacao.iniciada',
    ]);
    const concluida = await t.prisma.eventoDominio.findFirstOrThrow({
      where: { tipo: 'importacao.concluida' },
    });
    expect(concluida.dados).toMatchObject({
      importacaoId: final.id,
      tipo: 'CONTATOS',
      criados: 3,
      atualizados: 1,
      ignorados: 0,
      erros: 2,
    });
    // Progresso ao vivo.
    const progressos = emitido.mock.calls.filter(
      ([, evento]) => evento === 'importacao.progresso',
    );
    expect(progressos.length).toBeGreaterThanOrEqual(2);
    expect(progressos[progressos.length - 1][0]).toBe(dono.id);
    emitido.mockRestore();

    // Relatório XLSX.
    expect(final.relatorioId).not.toBeNull();
    const baixado = await cliente
      .get(`/api/v1/importacoes/${final.id}/relatorio`)
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(baixado.headers['content-type']).toContain('spreadsheetml');
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(baixado.body as unknown as ArrayBuffer);
    expect(livro.worksheets.map((a) => a.name)).toEqual([
      'Resumo',
      'Erros e ignoradas',
    ]);
    const problemas = livro.getWorksheet('Erros e ignoradas')!;
    expect(problemas.rowCount).toBe(3);
    expect(problemas.getRow(2).getCell(1).value).toBe(5);
  });

  it('R16.5 — duplicados: ignorar não toca no existente; sobrescrever troca os valores; atualizar vazios só completa', async () => {
    const { cliente } = await lider();
    const base = async () => {
      const contato = await criarContato(t, {
        nome: 'Antigo',
        email: 'dup@x.com',
      });
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { cargo: 'Analista' },
      });
    };
    const csv = 'Nome,E-mail,Cargo\nNovo Nome,dup@x.com,Diretor\n';
    const mapeamento = { Nome: 'nome', 'E-mail': 'email', Cargo: 'cargo' };

    await base();
    const ignorado = await importar(cliente, csv, {
      mapeamento,
      duplicados: 'IGNORAR',
    });
    expect(ignorado).toMatchObject({
      status: 'CONCLUIDA',
      ignorados: 1,
      criados: 0,
      atualizados: 0,
    });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'dup@x.com' },
      }),
    ).toMatchObject({ nome: 'Antigo', cargo: 'Analista' });

    const vazios = await importar(cliente, csv, {
      mapeamento,
      duplicados: 'ATUALIZAR_VAZIOS',
    });
    expect(vazios).toMatchObject({ atualizados: 1, ignorados: 0 });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'dup@x.com' },
      }),
    ).toMatchObject({ nome: 'Antigo', cargo: 'Analista', conversoes: 2 });

    const sobrescrito = await importar(cliente, csv, {
      mapeamento,
      duplicados: 'SOBRESCREVER',
    });
    expect(sobrescrito).toMatchObject({ atualizados: 1, ignorados: 0 });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'dup@x.com' },
      }),
    ).toMatchObject({ nome: 'Novo Nome', cargo: 'Diretor' });

    const igual = await importar(cliente, csv, {
      mapeamento,
      duplicados: 'SOBRESCREVER',
    });
    expect(igual).toMatchObject({ atualizados: 0, ignorados: 1 });
  });

  it('R16.6 — responsável fixo (ao alcance de quem importa) ou rodízio da área; padrão é quem importou (R4.5)', async () => {
    const { cliente, membros, lider: dono } = await lider();
    const mapeamento = { Nome: 'nome', 'E-mail': 'email' };
    const fixo = await importar(cliente, 'Nome,E-mail\nA,a@fixo.com\n', {
      mapeamento,
      estrategiaResponsavel: 'RESPONSAVEL_FIXO',
      responsavelId: membros[0].id,
    });
    expect(fixo.criados).toBe(1);
    expect(
      (
        await t.prisma.contato.findFirstOrThrow({
          where: { email: 'a@fixo.com' },
        })
      ).responsavelId,
    ).toBe(membros[0].id);

    const fora = await criarUsuario(t, {
      papel: 'COMERCIAL',
      lider: (await criarEquipe(t, 'COMERCIAL')).lider,
    });
    const criada = await rascunho(cliente, 'Nome,E-mail\nB,b@fixo.com\n');
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        mapeamento,
        estrategiaResponsavel: 'RESPONSAVEL_FIXO',
        responsavelId: fora.id,
      })
      .expect(403);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        estrategiaResponsavel: 'RODIZIO',
      })
      .expect(400);

    const semEstrategia = await importar(
      cliente,
      'Nome,E-mail\nC,c@padrao.com\n',
      { mapeamento },
    );
    expect(semEstrategia.criados).toBe(1);
    expect(
      (
        await t.prisma.contato.findFirstOrThrow({
          where: { email: 'c@padrao.com' },
        })
      ).responsavelId,
    ).toBe(dono.id);

    const rodizio = await importar(
      cliente,
      'Nome,E-mail\nD,d@rod.com\nE,e@rod.com\n',
      {
        mapeamento,
        estrategiaResponsavel: 'RODIZIO',
        areaRodizio: 'COMERCIAL',
      },
    );
    expect(rodizio.criados).toBe(2);
    const responsaveis = (
      await t.prisma.contato.findMany({
        where: { email: { in: ['d@rod.com', 'e@rod.com'] } },
      })
    ).map((c) => c.responsavelId);
    expect(responsaveis.every((r) => r !== null)).toBe(true);
  });

  it('R16.4 — importa empresas: CNPJ validado, UF, dedup por CNPJ e por nome, campos personalizados', async () => {
    const { cliente, membros } = await lider();
    await criarEmpresa(t, {
      nome: 'Velha SA',
      cnpj: '11222333000181',
      responsavel: membros[0],
    });
    const final = await importar(
      cliente,
      [
        'Razão Social,CNPJ,UF,Cidade,Porte',
        'Nova Ltda,45.723.174/0001-10,sp,São Paulo,médio',
        'Velha SA,11.222.333/0001-81,rj,Rio,grande',
        'Ruim,123,,,',
        'Sem UF Boa,,XX,,',
        'Só Nome,,,,',
      ].join('\n'),
      {
        mapeamento: {
          'Razão Social': 'nome',
          CNPJ: 'cnpj',
          UF: 'uf',
          Cidade: 'cidade',
          Porte: 'campos.porte',
        },
        duplicados: 'ATUALIZAR_VAZIOS',
      },
      'EMPRESAS',
    );
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      criados: 2,
      atualizados: 1,
      erros: 2,
    });
    expect(
      await t.prisma.empresa.findFirstOrThrow({ where: { nome: 'Nova Ltda' } }),
    ).toMatchObject({
      cnpj: '45723174000110',
      uf: 'SP',
      camposPersonalizados: { porte: 'médio' },
    });
    expect(
      await t.prisma.empresa.findFirstOrThrow({ where: { nome: 'Velha SA' } }),
    ).toMatchObject({ uf: 'RJ', cidade: 'Rio' });
    const erros = await cliente
      .get(`/api/v1/importacoes/${final.id}/linhas?resultado=ERRO`)
      .expect(200);
    const motivos = (
      erros.body as { itens: Array<{ motivo: string }> }
    ).itens.map((i) => i.motivo);
    expect(motivos[0]).toMatch(/CNPJ/);
    expect(motivos[1]).toMatch(/UF/);
  });

  it('R16.7 — cancelar antes de processar: nada é importado; depois de terminada não cancela', async () => {
    const { cliente } = await lider();
    const criada = await rascunho(cliente, 'Nome,E-mail\nA,a@cancel.com\n');
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    const cancelada = await cliente
      .post(`/api/v1/importacoes/${criada.id}/cancelar`)
      .expect(200);
    expect((cancelada.body as ImportacaoDaApi).status).toBe('CANCELADA');
    await drenarTudo(t);
    expect(
      await t.prisma.contato.count({ where: { email: 'a@cancel.com' } }),
    ).toBe(0);
    expect(
      (await cliente.get(`/api/v1/importacoes/${criada.id}`).expect(200)).body,
    ).toMatchObject({ status: 'CANCELADA' });
    await cliente.post(`/api/v1/importacoes/${criada.id}/cancelar`).expect(422);

    const feita = await importar(cliente, 'Nome,E-mail\nA,a@feita.com\n');
    await cliente.post(`/api/v1/importacoes/${feita.id}/cancelar`).expect(422);
    await cliente.delete(`/api/v1/importacoes/${feita.id}`).expect(422);
    await cliente.delete(`/api/v1/importacoes/${criada.id}`).expect(204);
  });

  it('R16.7 — retomada continua depois da última linha gravada e os contadores somam tudo', async () => {
    const { cliente, lider: dono } = await lider();
    const criada = await rascunho(
      cliente,
      'Nome,E-mail\nA,a@ret.com\nB,b@ret.com\nC,c@ret.com\n',
    );
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        mapeamento: { Nome: 'nome', 'E-mail': 'email' },
      })
      .expect(200);
    // Simula uma execução interrompida depois da linha 2.
    const contatoA = await criarContato(t, { nome: 'A', email: 'a@ret.com' });
    await t.prisma.importacaoLinha.create({
      data: {
        importacaoId: criada.id,
        numero: 2,
        resultado: 'CRIADO',
        entidadeId: contatoA.id,
      },
    });
    await t.prisma.importacao.update({
      where: { id: criada.id },
      data: { status: 'FALHOU', erro: 'queda', criadoPorId: dono.id },
    });
    await cliente.post(`/api/v1/importacoes/${criada.id}/retomar`).expect(200);
    await drenarTudo(t);
    const final = (
      await cliente.get(`/api/v1/importacoes/${criada.id}`).expect(200)
    ).body as ImportacaoDaApi;
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      processadas: 3,
      criados: 3,
      erro: null,
    });
    expect(
      await t.prisma.contato.count({
        where: { email: { endsWith: '@ret.com' } },
      }),
    ).toBe(3);
    await cliente.post(`/api/v1/importacoes/${criada.id}/retomar`).expect(422);
  });

  it('R16.8 — planilha XLSX também é lida; se quem importou foi desligado, a importação falha sem importar', async () => {
    const { cliente, lider: dono } = await lider();
    const livro = new ExcelJS.Workbook();
    const aba = livro.addWorksheet('Leads');
    aba.addRow(['Nome', 'Telefone']);
    aba.addRow(['Xavier', 11987650000]);
    const buffer = Buffer.from(await livro.xlsx.writeBuffer());
    const criada = await rascunho(cliente, buffer, 'CONTATOS', 'leads.xlsx');
    expect(criada.previa?.sugestao).toEqual({
      Nome: 'nome',
      Telefone: 'telefone',
    });
    const final = await importar(
      cliente,
      'Nome,E-mail\nZ,z@x.com\n',
      {},
      'CONTATOS',
    );
    expect(final.status).toBe('CONCLUIDA');
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await t.prisma.usuario.update({
      where: { id: dono.id },
      data: { ativo: false, desligadoEm: new Date() },
    });
    await drenarFilas(t, FILA_IMPORTACAO);
    const falhou = await t.prisma.importacao.findUniqueOrThrow({
      where: { id: criada.id },
    });
    expect(falhou.status).toBe('FALHOU');
    expect(falhou.erro).toMatch(/não está mais ativa/);
    expect(await t.prisma.contato.count({ where: { nome: 'Xavier' } })).toBe(0);
  });

  it('R16.9 — a planilha e o relatório só são baixados por quem importou, Admin e C-level', async () => {
    const { cliente, cLevel } = await lider();
    const final = await importar(cliente, 'Nome,E-mail\nA,a@acesso.com\n');
    const importacao = await t.prisma.importacao.findUniqueOrThrow({
      where: { id: final.id },
    });
    const outro = await lider();
    const atual = await outro.cliente.get(`/api/v1/importacoes/${final.id}`);
    expect(atual.status).toBe(404);
    await outro.cliente
      .get(`/api/v1/arquivos/${importacao.arquivoId}`)
      .expect(404);
    await outro.cliente
      .get(`/api/v1/arquivos/${final.relatorioId}`)
      .expect(404);
    await outro.cliente
      .get(`/api/v1/importacoes/${final.id}/relatorio`)
      .expect(404);
    const lista = await outro.cliente.get('/api/v1/importacoes').expect(200);
    expect((lista.body as { total: number }).total).toBe(0);
    await cliente.get(`/api/v1/arquivos/${final.relatorioId}`).expect(200);
    const diretoria = await entrarComo(t, cLevel);
    await diretoria.get(`/api/v1/arquivos/${importacao.arquivoId}`).expect(200);
    await diretoria.get(`/api/v1/arquivos/${final.relatorioId}`).expect(200);
    expect(
      (
        (await diretoria.get('/api/v1/importacoes').expect(200)).body as {
          total: number;
        }
      ).total,
    ).toBe(1);
  });
});
