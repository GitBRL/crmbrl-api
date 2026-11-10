import ExcelJS from 'exceljs';
import { RegraVioladaException } from '../src/comum/erros/excecoes';
import { NegociosService } from '../src/funis/negocios.service';
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
  criarNegocio,
  funilBase,
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

  it('cenário 34 — R16.1 — só Admin, C-level e líderes importam; membro recebe 403', async () => {
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

  it('cenário 35 — R16.2/R16.3 — o rascunho traz colunas, prévia e o mapeamento sugerido; separador e codificação detectados', async () => {
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

  it('cenário 36 — R16.4/R16.8 — importa contatos: dedup R4.2, normalização R4.1, origem IMPORTACAO, etiquetas, responsável, progresso, relatório, auditoria resumida e evento', async () => {
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
    // R16.8: além do resumo, cada contato criado ou reconvertido tem a sua auditoria (ator = quem importou).
    const porContato = await t.prisma.eventoAuditoria.groupBy({
      by: ['acao'],
      where: { acao: { in: ['contato.criado', 'contato.reconvertido'] } },
      _count: true,
    });
    expect(
      Object.fromEntries(porContato.map((g) => [g.acao, g._count])),
    ).toEqual({ 'contato.criado': 3, 'contato.reconvertido': 1 });
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

  it('cenário 37 — R16.5 — duplicados: ignorar não toca no existente; sobrescrever troca os valores; atualizar vazios só completa', async () => {
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

  it('cenário 38 — R16.6 — responsável fixo (ao alcance de quem importa) ou rodízio da área; padrão é quem importou (R4.5)', async () => {
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

  it('cenário 39 — R16.7 — cancelar antes de processar: nada é importado; depois de terminada não cancela', async () => {
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

  it('cenário 40 — R16.9 — a planilha e o relatório só são baixados por quem importou, Admin e C-level', async () => {
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

  it('R16.10 — a planilha modelo sai em XLSX para líder (contatos e empresas); membro e tipo inválido são barrados; parcelas seguem a regra do Financeiro', async () => {
    const { membros, cliente } = await lider();
    const baixar = (c: ClienteHttp, tipo: string) =>
      c
        .get(`/api/v1/importacoes/planilha-modelo?tipo=${tipo}`)
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (p: Buffer) => partes.push(p));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
    for (const tipo of ['CONTATOS', 'EMPRESAS']) {
      const ok = await baixar(cliente, tipo).expect(200);
      expect(ok.headers['content-type']).toContain('spreadsheetml');
      expect(ok.headers['content-disposition']).toContain(
        `modelo-importacao-${tipo.toLowerCase()}.xlsx`,
      );
      expect(ok.headers['cache-control']).toContain('no-store');
      expect(Number(ok.headers['content-length'])).toBe(
        (ok.body as Buffer).length,
      );
      const livro = new ExcelJS.Workbook();
      await livro.xlsx.load(ok.body as unknown as ArrayBuffer);
      expect(livro.worksheets[1].name).toBe('Como preencher');
    }
    await baixar(await entrarComo(t, membros[0]), 'CONTATOS').expect(403);
    await baixar(cliente, 'PARCELAS').expect(403);
    await baixar(cliente, 'OUTRO').expect(400);
    const cs = await criarEquipe(t, 'CS', { membros: 0 });
    await baixar(await entrarComo(t, cs.lider), 'PARCELAS').expect(200);
  });

  // =========================================================================
  // Importação v2: filtro, negócio por linha, cabeçalho e DDI (R16.11–R16.13)
  // =========================================================================

  async function comercial() {
    const funil = await funilBase(t, 'COMERCIAL');
    const aberta = funil.etapas.filter((e) => e.tipo === 'ABERTA');
    const perdida = funil.etapas.find((e) => e.tipo === 'PERDIDO')!;
    return { funil, entrada: aberta[0], segunda: aberta[1], perdida };
  }

  const linhasDe = (id: string, cliente: ClienteHttp, resultado?: string) =>
    cliente
      .get(
        `/api/v1/importacoes/${id}/linhas?pagina=1&porPagina=100${resultado ? `&resultado=${resultado}` : ''}`,
      )
      .expect(200)
      .then(
        (r) =>
          (
            r.body as {
              itens: Array<{
                numero: number;
                motivo: string | null;
                resultado: string;
                entidadeId: string | null;
              }>;
            }
          ).itens,
      );

  const CSV_FILTRO =
    'Nome,E-mail,Cidade,Status\n' +
    'Ana,ana@fil.com,São Paulo,Quente\n' +
    'Bia,bia@fil.com,Recife,Quente\n' +
    'Caio,caio@fil.com,sao paulo,Frio\n' +
    'Davi,davi@fil.com,SÃO  PAULO,Quente\n';

  it('cenário 404 — R16.11 — filtro: valida as regras, a prévia traz só as linhas que passam e processar ignora (sem gravar linha) as demais', async () => {
    const { cliente } = await lider();
    const criada = await rascunho(cliente, CSV_FILTRO);
    const url = `/api/v1/importacoes/${criada.id}`;
    const regra = (coluna: string, operador: string, valor?: string) => ({
      coluna,
      operador,
      ...(valor === undefined ? {} : { valor }),
    });
    // Validação (400, em português)
    for (const filtro of [
      { combinacao: 'TODAS', regras: [regra('Inexistente', 'IGUAL', 'x')] },
      { combinacao: 'TODAS', regras: [regra('Cidade', 'IGUAL')] },
      { combinacao: 'TODAS', regras: [regra('Cidade', 'PARECIDO', 'x')] },
      { combinacao: 'TODAS', regras: [] },
      {
        combinacao: 'TODAS',
        regras: Array.from({ length: 11 }, () => regra('Cidade', 'VAZIO')),
      },
    ]) {
      await cliente.patch(url, { filtro }).expect(400);
    }
    const filtro = {
      combinacao: 'TODAS',
      regras: [
        regra('Cidade', 'IGUAL', 'sao paulo'),
        regra('Status', 'IGUAL', 'quente'),
      ],
    };
    const atualizada = await cliente.patch(url, { filtro }).expect(200);
    expect(atualizada.body).toMatchObject({
      filtro,
      filtradas: 0,
      ddiPadrao: '55',
      negocio: null,
    });
    const previa = await cliente.get(`${url}/previa?linhas=10`).expect(200);
    const corpo = previa.body as {
      totalLinhas: number;
      linhasNoFiltro: number;
      linhas: Array<{ numero: number; valores: string[] }>;
    };
    expect(corpo.totalLinhas).toBe(4);
    expect(corpo.linhasNoFiltro).toBe(2);
    expect(corpo.linhas.map((l) => l.numero)).toEqual([2, 5]);
    // Nenhuma linha passa: 422
    await cliente
      .patch(url, {
        filtro: {
          combinacao: 'TODAS',
          regras: [regra('Cidade', 'IGUAL', 'Manaus')],
        },
      })
      .expect(200);
    const sem = await cliente.post(`${url}/iniciar`).expect(422);
    expect((sem.body as { mensagem: string }).mensagem).toBe(
      'Nenhuma linha da planilha passa no filtro.',
    );
    // QUALQUER + processamento
    await cliente
      .patch(url, {
        filtro: {
          combinacao: 'QUALQUER',
          regras: [
            regra('Cidade', 'IGUAL', 'Recife'),
            regra('Status', 'IGUAL', 'frio'),
          ],
        },
      })
      .expect(200);
    await cliente.post(`${url}/iniciar`).expect(200);
    await drenarTudo(t);
    const final = (await cliente.get(url).expect(200))
      .body as ImportacaoDaApi & { filtradas: number };
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      totalLinhas: 4,
      processadas: 2,
      criados: 2,
      filtradas: 2,
      progresso: 100,
    });
    expect((await linhasDe(criada.id, cliente)).map((l) => l.numero)).toEqual([
      3, 4,
    ]);
    expect(
      await t.prisma.contato.count({
        where: { email: { endsWith: '@fil.com' } },
      }),
    ).toBe(2);
    expect(
      await t.prisma.contato.count({ where: { email: 'ana@fil.com' } }),
    ).toBe(0);
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'importacao.concluida' },
    });
    expect(JSON.stringify(auditoria.dados)).toContain('"filtradas":2');
  });

  it('cenário 405 — R16.11/R16.7 — retomar com filtro não conta as filtradas duas vezes nem pula linhas', async () => {
    const { cliente, lider: dono } = await lider();
    const criada = await rascunho(
      cliente,
      'Nome,E-mail,Grupo\nA,a@rf.com,x\nB,b@rf.com,y\nC,c@rf.com,x\nD,d@rf.com,y\nE,e@rf.com,x\n',
    );
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        filtro: {
          combinacao: 'TODAS',
          regras: [{ coluna: 'Grupo', operador: 'IGUAL', valor: 'x' }],
        },
      })
      .expect(200);
    // Execução interrompida depois da linha 2 (A); as filtradas B (3) e D (5) ficam para trás ou à frente.
    const contatoA = await criarContato(t, { nome: 'A', email: 'a@rf.com' });
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
      data: {
        status: 'FALHOU',
        erro: 'queda',
        criadoPorId: dono.id,
        filtradas: 1,
      },
    });
    await cliente.post(`/api/v1/importacoes/${criada.id}/retomar`).expect(200);
    await drenarTudo(t);
    const final = (
      await cliente.get(`/api/v1/importacoes/${criada.id}`).expect(200)
    ).body as ImportacaoDaApi & { filtradas: number };
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      processadas: 3,
      criados: 3,
      filtradas: 2,
    });
    expect((await linhasDe(criada.id, cliente)).map((l) => l.numero)).toEqual([
      2, 4, 6,
    ]);
    expect(
      await t.prisma.contato.count({
        where: { email: { endsWith: '@rf.com' } },
      }),
    ).toBe(3);
  });

  it('cenário 406 — R16.12 — negócio para todos: valida o cartão, devolve funil e etapa com nome e cria um negócio por contato', async () => {
    const { cliente, lider: dono } = await lider();
    const { funil, entrada, segunda, perdida } = await comercial();
    const criada = await rascunho(
      cliente,
      'Nome,E-mail\nAna,ana@neg.com\nBia,bia@neg.com\n',
    );
    const url = `/api/v1/importacoes/${criada.id}`;
    const negocio = (extra: Record<string, unknown> = {}) => ({
      funilId: funil.id,
      etapaId: segunda.id,
      ...extra,
    });
    // Funil inexistente: 404, como o funil que a pessoa não vê (R5.9).
    await cliente
      .patch(url, {
        negocio: negocio({ funilId: '00000000-0000-4000-8000-000000000000' }),
      })
      .expect(404);
    await cliente
      .patch(url, { negocio: negocio({ etapaId: perdida.id }) })
      .expect(422);
    await cliente
      .patch(url, {
        negocio: negocio({ etapaId: '00000000-0000-4000-8000-000000000000' }),
      })
      .expect(422);
    await cliente.patch(url, { negocio: negocio({ valor: '-5' }) }).expect(400);
    await cliente
      .patch(url, { negocio: negocio({ valor: 'abc' }) })
      .expect(400);
    const ok = await cliente
      .patch(url, {
        negocio: negocio({ titulo: 'Proposta BRL', valor: '1.500,50' }),
      })
      .expect(200);
    expect((ok.body as { negocio: unknown }).negocio).toEqual({
      funilId: funil.id,
      etapaId: segunda.id,
      titulo: 'Proposta BRL',
      valor: '1500.50',
      funil: { id: funil.id, nome: funil.nome },
      etapa: { id: segunda.id, nome: segunda.nome },
    });
    await cliente.post(`${url}/iniciar`).expect(200);
    await drenarTudo(t);
    const final = (await cliente.get(url).expect(200))
      .body as ImportacaoDaApi & {
      negociosCriados: number;
      negociosReconvertidos: number;
    };
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      criados: 2,
      negociosCriados: 2,
      negociosReconvertidos: 0,
    });
    const negocios = await t.prisma.negocio.findMany({
      where: { contato: { email: { endsWith: '@neg.com' } } },
    });
    expect(negocios).toHaveLength(2);
    for (const n of negocios) {
      expect(n).toMatchObject({
        funilId: funil.id,
        etapaId: segunda.id,
        titulo: 'Proposta BRL',
        origem: 'IMPORTACAO',
        responsavelId: dono.id,
      });
      expect(n.valor.toString()).toBe('1500.5');
    }
    // Só para contatos
    const empresas = await rascunho(cliente, 'Nome\nAcme\n', 'EMPRESAS');
    await cliente
      .patch(`/api/v1/importacoes/${empresas.id}`, { negocio: negocio() })
      .expect(400);
    // Título padrão = nome do contato; etapa de entrada quando só o funil vem do cartão por coluna
    expect(entrada.id).not.toBe(segunda.id);
  });

  it('cenário 407 — R16.12 — funil e etapa por coluna (nome sem acento nem caixa), padrões e aviso de funil inexistente sem perder o contato', async () => {
    const { cliente } = await lider();
    const { funil, entrada, segunda } = await comercial();
    const csv =
      'Nome,E-mail,Funil,Etapa,Título do negócio,Valor\n' +
      `Ana,ana@col.com,${funil.nome.toUpperCase()},${segunda.nome
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()},Plano Ana,"R$ 2.000,00"\n` +
      `Bia,bia@col.com,  ${funil.nome}  ,,,\n` +
      'Caio,caio@col.com,Funil Fantasma,,,\n' +
      `Davi,davi@col.com,,${segunda.nome},,\n` +
      'Eva,eva@col.com,,,,\n' +
      `Fred,fred@col.com,${funil.nome},Etapa que não existe,,\n`;
    const final = await importar(cliente, csv);
    expect(final).toMatchObject({ status: 'CONCLUIDA', criados: 6, erros: 0 });
    const negocioDe = (email: string) =>
      t.prisma.negocio.findFirst({ where: { contato: { email } } });
    const ana = await negocioDe('ana@col.com');
    expect(ana).toMatchObject({ etapaId: segunda.id, titulo: 'Plano Ana' });
    expect(ana!.valor.toString()).toBe('2000');
    expect(await negocioDe('bia@col.com')).toMatchObject({
      etapaId: entrada.id,
      titulo: 'Bia',
    });
    expect(await negocioDe('caio@col.com')).toBeNull();
    expect(await negocioDe('eva@col.com')).toBeNull();
    expect(await negocioDe('fred@col.com')).toBeNull();
    // Davi: só etapa, sem cartão → aviso e sem negócio
    expect(await negocioDe('davi@col.com')).toBeNull();
    const linhas = await linhasDe(final.id, cliente);
    const motivo = (n: number) => linhas.find((l) => l.numero === n)?.motivo;
    expect(motivo(4)).toBe(
      'Negócio não criado: funil "Funil Fantasma" não encontrado.',
    );
    expect(motivo(5)).toMatch(/informe o funil/);
    expect(motivo(7)).toMatch(/etapa "Etapa que não existe" não encontrada/);
    expect(linhas.every((l) => l.resultado === 'CRIADO')).toBe(true);
    expect(
      await t.prisma.contato.count({
        where: { email: { endsWith: '@col.com' } },
      }),
    ).toBe(6);
    expect(final).toMatchObject({ negociosCriados: 2 });
  });

  it('cenário 408 — R16.12/R5.6 — reconversão: contato com negócio aberto no funil não ganha outro; duplicado IGNORAR não cria negócio', async () => {
    const { cliente } = await lider();
    const { funil, segunda } = await comercial();
    const existente = await criarContato(t, {
      nome: 'Rex',
      email: 'rex@rec.com',
    });
    const ignorado = await criarContato(t, {
      nome: 'Ivo',
      email: 'ivo@rec.com',
    });
    const aberto = await criarNegocio(t, { contato: existente });
    const csv =
      'Nome,E-mail\nRex,rex@rec.com\nIvo,ivo@rec.com\nNovo,novo@rec.com\n';
    const criada = await rascunho(cliente, csv);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        negocio: { funilId: funil.id, etapaId: segunda.id },
        duplicados: 'ATUALIZAR_VAZIOS',
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const final = (
      await cliente.get(`/api/v1/importacoes/${criada.id}`).expect(200)
    ).body as ImportacaoDaApi & {
      negociosCriados: number;
      negociosReconvertidos: number;
    };
    expect(final).toMatchObject({
      negociosCriados: 2,
      negociosReconvertidos: 1,
    });
    expect(
      await t.prisma.negocio.count({ where: { contatoId: existente.id } }),
    ).toBe(1);
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: aberto.id } }))
        .etapaId,
    ).toBe(aberto.etapaId);
    expect(
      await t.prisma.negocio.count({ where: { contatoId: ignorado.id } }),
    ).toBe(1);
    // Com IGNORAR, o existente não é tocado e não ganha negócio.
    const outra = await rascunho(
      cliente,
      'Nome,E-mail\nIvo,ivo@rec.com\nNovo,novo@rec.com\n',
    );
    await cliente
      .patch(`/api/v1/importacoes/${outra.id}`, {
        negocio: { funilId: funil.id, etapaId: segunda.id },
        duplicados: 'IGNORAR',
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${outra.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const depois = (
      await cliente.get(`/api/v1/importacoes/${outra.id}`).expect(200)
    ).body as ImportacaoDaApi & {
      negociosCriados: number;
      negociosReconvertidos: number;
    };
    expect(depois).toMatchObject({
      ignorados: 2,
      negociosCriados: 0,
      negociosReconvertidos: 0,
    });
    expect(
      await t.prisma.negocio.count({ where: { contatoId: ignorado.id } }),
    ).toBe(1);
  });

  it('cenário 409 — R16.12 — responsável por coluna (e-mail ou nome): vale no contato novo e no negócio; coluna inválida ou fora do alcance cai na estratégia com aviso', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const cliente = await entrarComo(t, equipe.lider);
    const outraEquipe = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const { funil, segunda } = await comercial();
    const [a, b] = equipe.membros;
    const contatoAntigo = await criarContato(t, {
      nome: 'Velho',
      email: 'velho@resp.com',
      responsavel: b,
    });
    const csv =
      'Nome,E-mail,Responsável\n' +
      `Ana,ana@resp.com,${a.email}\n` +
      `Bia,bia@resp.com,${b.nome.toUpperCase()}\n` +
      'Caio,caio@resp.com,Ninguém Aqui\n' +
      `Davi,davi@resp.com,${outraEquipe.membros[0].email}\n` +
      `Velho,velho@resp.com,${a.email}\n`;
    const criada = await rascunho(cliente, csv);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        negocio: { funilId: funil.id, etapaId: segunda.id },
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const dono = async (email: string) => ({
      contato: (await t.prisma.contato.findFirstOrThrow({ where: { email } }))
        .responsavelId,
      negocio: (
        await t.prisma.negocio.findFirstOrThrow({
          where: { contato: { email } },
        })
      ).responsavelId,
    });
    expect(await dono('ana@resp.com')).toEqual({
      contato: a.id,
      negocio: a.id,
    });
    expect(await dono('bia@resp.com')).toEqual({
      contato: b.id,
      negocio: b.id,
    });
    expect(await dono('caio@resp.com')).toEqual({
      contato: equipe.lider.id,
      negocio: equipe.lider.id,
    });
    expect(await dono('davi@resp.com')).toEqual({
      contato: equipe.lider.id,
      negocio: equipe.lider.id,
    });
    // Contato que já existia nunca troca de responsável; o negócio vai para o da coluna.
    expect(await dono('velho@resp.com')).toEqual({
      contato: contatoAntigo.responsavelId,
      negocio: a.id,
    });
    const linhas = await linhasDe(criada.id, cliente);
    expect(linhas.find((l) => l.numero === 4)?.motivo).toMatch(
      /Responsável "Ninguém Aqui" não encontrado/,
    );
    expect(linhas.find((l) => l.numero === 5)?.motivo).toMatch(
      /fora do seu alcance/,
    );
  });

  it('cenário 410 — R16.13 — sem cabeçalho (Coluna 1…N, linha 1 é dado) e DDI padrão', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 0 });
    const cli = await entrarComo(t, equipe.lider);
    const arq = await criarArquivo(t, {
      contexto: 'IMPORTACAO',
      nome: 'sem-cabecalho.csv',
      mime: 'text/csv',
      conteudo:
        'Ana,ana@ddi.com,912345678\nBia,bia@ddi.com,+55 11 98765-4321\n',
      criadoPor: equipe.lider,
    });
    const criada = (
      await cli
        .post('/api/v1/importacoes', {
          tipo: 'CONTATOS',
          arquivoId: arq.id,
          leitura: { semCabecalho: true },
        })
        .expect(201)
    ).body as ImportacaoDaApi & {
      leitura: { semCabecalho: boolean };
      previa: { colunas: string[]; linhas: Array<{ numero: number }> };
    };
    expect(criada.leitura.semCabecalho).toBe(true);
    expect(criada.previa.colunas).toEqual(['Coluna 1', 'Coluna 2', 'Coluna 3']);
    expect(criada.previa.linhas.map((l) => l.numero)).toEqual([1, 2]);
    expect(criada.totalLinhas).toBe(2);
    expect(criada.mapeamento).toEqual({});
    const com = await cli.get(`/api/v1/importacoes/${criada.id}`).expect(200);
    expect((com.body as { ddiPadrao: string }).ddiPadrao).toBe('55');
    await cli
      .patch(`/api/v1/importacoes/${criada.id}`, { ddiPadrao: '12345' })
      .expect(400);
    await cli
      .patch(`/api/v1/importacoes/${criada.id}`, {
        ddiPadrao: '351',
        mapeamento: {
          'Coluna 1': 'nome',
          'Coluna 2': 'email',
          'Coluna 3': 'telefone',
        },
      })
      .expect(200);
    await cli.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const telefone = async (email: string) =>
      (await t.prisma.contato.findFirstOrThrow({ where: { email } })).telefone;
    expect(await telefone('ana@ddi.com')).toBe('351912345678');
    expect(await telefone('bia@ddi.com')).toBe('5511987654321');
    // Voltar a "com cabeçalho" refaz as colunas
    const outra = await rascunho(cli, 'Nome,E-mail\nCaio,caio@ddi.com\n');
    const refeita = await cli
      .patch(`/api/v1/importacoes/${outra.id}`, {
        leitura: { semCabecalho: true },
      })
      .expect(200);
    expect(refeita.body).toMatchObject({
      totalLinhas: 2,
      colunas: ['Coluna 1', 'Coluna 2'],
      mapeamento: {},
    });
  });

  it('cenário 411 — R16.12/R5.9 — funil que a pessoa não vê (de outra área) é como inexistente: 404 no cartão, sem nome', async () => {
    const { cliente } = await lider();
    const marketing = await funilBase(t, 'MARKETING');
    const criada = await rascunho(cliente, 'Nome,E-mail\nAna,ana@403.com\n');
    const resposta = await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        negocio: { funilId: marketing.id, etapaId: marketing.etapas[0].id },
      })
      .expect(404);
    expect((resposta.body as { mensagem: string }).mensagem).toBe(
      'Funil não encontrado.',
    );
    expect(JSON.stringify(resposta.body)).not.toContain(marketing.nome);
    // Funil de marketing por coluna: contato entra, negócio não, com aviso
    const final = await importar(
      cliente,
      `Nome,E-mail,Funil\nAna,ana@403.com,${marketing.nome}\n`,
    );
    expect(final).toMatchObject({ criados: 1 });
    expect(
      await t.prisma.negocio.count({
        where: { contato: { email: 'ana@403.com' } },
      }),
    ).toBe(0);
    expect((await linhasDe(final.id, cliente))[0].motivo).toMatch(
      /funil "Marketing" não encontrado/,
    );
  });

  it('cenário 412 — R16.12 — uma notificação por responsável ao concluir (nada de uma por negócio) e a linha inteira é desfeita se o negócio falha', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
    const cliente = await entrarComo(t, equipe.lider);
    const { funil, segunda } = await comercial();
    const [a, b] = equipe.membros;
    const csv =
      'Nome,E-mail,Responsável\n' +
      `A1,a1@not.com,${a.email}\nA2,a2@not.com,${a.email}\nA3,a3@not.com,${a.email}\nB1,b1@not.com,${b.email}\nL1,l1@not.com,\n`;
    const criada = await rascunho(cliente, csv);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        negocio: { funilId: funil.id, etapaId: segunda.id },
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const nota = (usuarioId: string) =>
      t.prisma.notificacao.findMany({
        where: { usuarioId, tipo: 'negocio.atribuido' },
      });
    const deA = await nota(a.id);
    expect(deA).toHaveLength(1);
    expect(deA[0].texto).toBe(
      'Você recebeu 3 negócios da importação planilha.csv.',
    );
    const deB = await nota(b.id);
    expect(deB).toHaveLength(1);
    expect(deB[0].texto).toBe(
      'Você recebeu 1 negócio da importação planilha.csv.',
    );
    // Quem importou ficou com um negócio, e não é notificado do que é dele.
    expect(await nota(equipe.lider.id)).toHaveLength(0);
    expect(
      await t.prisma.negocio.count({
        where: { contato: { email: { endsWith: '@not.com' } } },
      }),
    ).toBe(5);

    // Falha no negócio: contato, negócio e linha na mesma transação.
    const negocios = t.get(NegociosService);
    const espiao = jest
      .spyOn(negocios, 'criarAutomatico')
      .mockRejectedValueOnce(
        new RegraVioladaException('R5.1', 'Funil indisponível.'),
      );
    const falha = await rascunho(
      cliente,
      'Nome,E-mail\nZed,zed@not.com\nZoe,zoe@not.com\n',
    );
    await cliente
      .patch(`/api/v1/importacoes/${falha.id}`, {
        negocio: { funilId: funil.id, etapaId: segunda.id },
      })
      .expect(200);
    await cliente.post(`/api/v1/importacoes/${falha.id}/iniciar`).expect(200);
    await drenarTudo(t);
    espiao.mockRestore();
    const linhas = await linhasDe(falha.id, cliente);
    expect(linhas.find((l) => l.numero === 2)).toMatchObject({
      resultado: 'ERRO',
      motivo: expect.stringContaining(
        'Negócio não criado: Funil indisponível.',
      ),
    });
    expect(linhas.find((l) => l.numero === 3)?.resultado).toBe('CRIADO');
    expect(
      await t.prisma.contato.count({ where: { email: 'zed@not.com' } }),
    ).toBe(0);
    expect(
      await t.prisma.contato.count({ where: { email: 'zoe@not.com' } }),
    ).toBe(1);
    const final = (
      await cliente.get(`/api/v1/importacoes/${falha.id}`).expect(200)
    ).body as ImportacaoDaApi & { negociosCriados: number };
    expect(final).toMatchObject({ erros: 1, criados: 1, negociosCriados: 1 });
  });

  it('cenário 413 — R16.13 — campos com grupo e modelo de mapeamento que guarda filtro, negócio e DDI (colunas inexistentes são descartadas ao aplicar)', async () => {
    const { cliente } = await lider();
    const { funil, segunda } = await comercial();
    const campos = (
      await cliente.get('/api/v1/importacoes/campos?tipo=CONTATOS').expect(200)
    ).body as Array<{ chave: string; grupo: string }>;
    const grupo = (chave: string) =>
      campos.find((c) => c.chave === chave)?.grupo;
    expect(grupo('nome')).toBe('Contato');
    expect(grupo('negocio.funil')).toBe('Negócio');
    expect(campos.map((c) => c.chave)).toEqual(
      expect.arrayContaining([
        'responsavel',
        'negocio.funil',
        'negocio.etapa',
        'negocio.titulo',
        'negocio.valor',
        'negocio.valorRecorrente',
      ]),
    );
    const emp = (
      await cliente.get('/api/v1/importacoes/campos?tipo=EMPRESAS').expect(200)
    ).body as Array<{ grupo: string }>;
    expect(emp.every((c) => c.grupo === 'Empresa')).toBe(true);

    const modelo = await cliente
      .post('/api/v1/importacoes/modelos', {
        nome: 'Modelo v2',
        tipo: 'CONTATOS',
        mapeamento: { Nome: 'nome', 'E-mail': 'email' },
        opcoes: {
          filtro: {
            combinacao: 'TODAS',
            regras: [
              { coluna: 'Cidade', operador: 'IGUAL', valor: 'Recife' },
              { coluna: 'Coluna Que Some', operador: 'PREENCHIDO' },
            ],
          },
          negocio: {
            funilId: funil.id,
            etapaId: segunda.id,
            titulo: 'Do modelo',
          },
          ddiPadrao: '351',
        },
      })
      .expect(201);
    const novo = await rascunho(
      cliente,
      'Nome,E-mail,Cidade\nAna,ana@mod.com,Recife\n',
    );
    const aplicado = await cliente
      .patch(`/api/v1/importacoes/${novo.id}`, {
        modeloId: (modelo.body as { id: string }).id,
      })
      .expect(200);
    expect(aplicado.body).toMatchObject({
      filtro: {
        combinacao: 'TODAS',
        regras: [{ coluna: 'Cidade', operador: 'IGUAL', valor: 'Recife' }],
      },
      negocio: {
        funilId: funil.id,
        etapaId: segunda.id,
        titulo: 'Do modelo',
        funil: { nome: funil.nome },
        etapa: { nome: segunda.nome },
      },
      ddiPadrao: '351',
    });
  });

  // -------------------------------------------------------------------------
  // Exportação do Clint (R16.14) — dados inventados, só o cabeçalho é o real
  // -------------------------------------------------------------------------

  const CABECALHO_CLINT =
    'id,created_at,name,email,ddi,phone,complete_phone,tags,status,stage,value,lost_status,user_email,user_name,origin,won_at,lost_at,origem';

  function csvClint(linhas: string[]): string {
    return `${CABECALHO_CLINT}\n${linhas.join('\n')}\n`;
  }

  interface ConferenciaDaApi {
    semFunil: number;
    funis: Array<{
      valor: string;
      linhas: number;
      porStatus: Record<string, number>;
      funil: { id: string; nome: string } | null;
      como: string | null;
      problema: string | null;
      etapas: Array<{
        valor: string;
        linhas: number;
        etapa: { id: string; nome: string; tipo: string } | null;
        como: string | null;
        problema: string | null;
      }>;
    }>;
  }

  it('cenário 414 — R16.14 — exportação do Clint: formato detectado, conferência de funis, tradução, ganho e perdido já fechados (datas, motivo, sem passagem) e criadoEm respeitado', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const cliente = await entrarComo(t, equipe.lider);
    const dono = equipe.membros[0].email;
    const { funil, entrada, segunda, perdida } = await comercial();
    const ganha = funil.etapas.find((e) => e.tipo === 'GANHO')!;
    const csv = csvClint([
      `id-001,01/11/2026 09:00:00,Ana Teste,ana@cli.com,55,61988880001,+55 61988880001,"t1,t2",Aberto,1º CONTATO - 1º DIA,0,,${dono},Fulano,SDR,,,x`,
      `id-002,02/11/2026 10:30:00,Bia Teste,bia@cli.com,55,61988880002,+55 61988880002,,Aberto,SEGUNDA ETAPA,100,,${dono},Fulano,SDR,,,x`,
      `id-003,02/11/2026 11:00:00,Caio Teste,caio@cli.com,55,61988880003,+55 61988880003,,Ganho,VENDA REALIZADA ,1500,,${dono},Fulano,SDR,05/11/2026 13:08:29,,x`,
      `id-004,03/11/2026 08:00:00,Davi Teste,davi@cli.com,55,61988880004,+55 61988880004,,Perdido,1º CONTATO - 1º DIA,0,Sem interesse,${dono},Fulano,SDR,,06/11/2026 08:00:00,x`,
      `id-005,03/11/2026 09:15:00,Eva Teste,eva@cli.com,55,61988880005,+55 61988880005,,Perdido,SEGUNDA ETAPA,0,,${dono},Fulano,SDR,,,x`,
      `id-006,04/11/2026 09:00:00,Fred Teste,fred@cli.com,55,61988880006,+55 61988880006,,Aberto,ETAPA DESCONHECIDA,0,,${dono},Fulano,SDR,,,x`,
    ]);
    const criada = await rascunho(cliente, csv);
    // Formato detectado e mapeamento sugerido (origin → funil, `origem` do formulário não).
    expect(criada.previa).toMatchObject({ formatoOrigem: 'CLINT' });
    expect(criada).toMatchObject({ formatoOrigem: 'CLINT' });
    expect(criada.mapeamento).toMatchObject({
      id: 'negocio.idExterno',
      created_at: 'negocio.criadoEm',
      complete_phone: 'telefone',
      status: 'negocio.status',
      stage: 'negocio.etapa',
      lost_status: 'negocio.motivoPerda',
      user_email: 'responsavel',
      origin: 'negocio.funil',
      won_at: 'negocio.ganhoEm',
      lost_at: 'negocio.perdidoEm',
    });
    expect(criada.mapeamento.origem).toBeUndefined();
    expect(criada.mapeamento.phone).toBeUndefined();
    const semClint = await rascunho(cliente, 'Nome,E-mail\nAna,ana@x.com\n');
    expect(semClint.previa).toMatchObject({ formatoOrigem: null });

    // Conferência antes da tradução: "SDR" não existe.
    const conferir = async () =>
      (
        await cliente
          .get(`/api/v1/importacoes/${criada.id}/funis-da-planilha`)
          .expect(200)
      ).body as ConferenciaDaApi;
    const antes = await conferir();
    expect(antes.semFunil).toBe(0);
    expect(antes.funis).toHaveLength(1);
    expect(antes.funis[0]).toMatchObject({
      valor: 'SDR',
      linhas: 6,
      porStatus: { ABERTO: 3, GANHO: 1, PERDIDO: 2 },
      funil: null,
      como: null,
      problema: 'NAO_ENCONTRADO',
    });
    // Só linhas abertas entram nas etapas.
    expect(antes.funis[0].etapas.map((e) => e.valor).sort()).toEqual([
      '1º CONTATO - 1º DIA',
      'ETAPA DESCONHECIDA',
      'SEGUNDA ETAPA',
    ]);

    // Validação da tradução (R16.14): funil inexistente ou de outra área (que a
    // pessoa não vê, R5.9) 404, forma errada 400.
    const lixo = '00000000-0000-4000-8000-000000000000';
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        traducaoFunis: { sdr: lixo },
      })
      .expect(404);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { traducaoFunis: { sdr: 1 } })
      .expect(400);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, { traducaoFunis: 'x' })
      .expect(400);
    const marketing = await funilBase(t, 'MARKETING');
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        traducaoFunis: { SDR: marketing.id },
      })
      .expect(404);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        traducaoFunis: { SDR: funil.id },
        traducaoEtapas: { [funil.id]: { x: marketing.etapas[0].id } },
      })
      .expect(422);
    await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        traducaoFunis: { SDR: funil.id },
        traducaoEtapas: { [funil.id]: { x: perdida.id } },
      })
      .expect(422);

    const gravada = await cliente
      .patch(`/api/v1/importacoes/${criada.id}`, {
        traducaoFunis: { ' SDR ': funil.id },
        traducaoEtapas: {
          [funil.id]: {
            '1º contato - 1º dia': entrada.id,
            'Segunda Etapa': segunda.id,
          },
        },
      })
      .expect(200);
    expect(gravada.body).toMatchObject({
      traducaoFunis: { sdr: funil.id },
      traducaoEtapas: {
        [funil.id]: {
          '1º contato - 1º dia': entrada.id,
          'segunda etapa': segunda.id,
        },
      },
    });
    const depois = await conferir();
    expect(depois.funis[0]).toMatchObject({
      funil: { id: funil.id, nome: funil.nome },
      como: 'TRADUCAO',
      problema: null,
    });
    const etapaDe = (valor: string) =>
      depois.funis[0].etapas.find((e) => e.valor === valor);
    expect(etapaDe('1º CONTATO - 1º DIA')).toMatchObject({
      linhas: 1,
      como: 'TRADUCAO',
      problema: null,
      etapa: { id: entrada.id },
    });
    expect(etapaDe('ETAPA DESCONHECIDA')).toMatchObject({
      etapa: null,
      como: null,
      problema: 'NAO_ENCONTRADA',
    });

    // Passagem do Comercial (ganho → CS) existe; negócio importado como ganho não a dispara.
    expect(
      await t.prisma.passagem.count({ where: { etapaGatilhoId: ganha.id } }),
    ).toBeGreaterThan(0);

    await cliente.post(`/api/v1/importacoes/${criada.id}/iniciar`).expect(200);
    await drenarTudo(t);
    const final = (
      await cliente.get(`/api/v1/importacoes/${criada.id}`).expect(200)
    ).body as ImportacaoDaApi & {
      negociosCriados: number;
      negociosAtualizados: number;
    };
    expect(final).toMatchObject({
      status: 'CONCLUIDA',
      criados: 6,
      erros: 0,
      negociosCriados: 5,
      negociosAtualizados: 0,
    });
    const negocioDe = (email: string) =>
      t.prisma.negocio.findFirst({
        where: { contato: { email } },
        include: { movimentacoes: true },
      });

    const ana = (await negocioDe('ana@cli.com'))!;
    expect(ana).toMatchObject({
      etapaId: entrada.id,
      status: 'ABERTO',
      idExterno: 'id-001',
    });
    // 01/11/2026 09:00 em São Paulo = 12:00Z (R16.14: criadoEm, etapaDesde e a entrada no histórico)
    expect(ana.criadoEm.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(ana.etapaDesde.toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(ana.movimentacoes[0].criadoEm.toISOString()).toBe(
      '2026-11-01T12:00:00.000Z',
    );
    expect(ana.responsavelId).toBe(equipe.membros[0].id);
    expect(await negocioDe('bia@cli.com')).toMatchObject({
      etapaId: segunda.id,
    });

    const caio = (await negocioDe('caio@cli.com'))!;
    expect(caio).toMatchObject({
      status: 'GANHO',
      etapaId: ganha.id,
      idExterno: 'id-003',
    });
    expect(caio.valor.toString()).toBe('1500');
    expect(caio.ganhoEm?.toISOString()).toBe('2026-11-05T16:08:29.000Z');
    expect(caio.perdidoEm).toBeNull();
    expect(caio.criadoEm.toISOString()).toBe('2026-11-02T14:00:00.000Z');

    const davi = (await negocioDe('davi@cli.com'))!;
    expect(davi).toMatchObject({
      status: 'PERDIDO',
      etapaId: perdida.id,
      motivoPerda: 'Sem interesse',
    });
    expect(davi.perdidoEm?.toISOString()).toBe('2026-11-06T11:00:00.000Z');
    // Perdido sem motivo nem data: motivo padrão e data = criação do negócio.
    const eva = (await negocioDe('eva@cli.com'))!;
    expect(eva).toMatchObject({
      status: 'PERDIDO',
      motivoPerda: 'Importado como perdido',
    });
    expect(eva.perdidoEm?.toISOString()).toBe(eva.criadoEm.toISOString());

    // Etapa sem destino: contato entra, negócio não, linha com aviso.
    expect(await negocioDe('fred@cli.com')).toBeNull();
    const linhas = await linhasDe(final.id, cliente);
    expect(linhas.find((l) => l.numero === 7)?.motivo).toMatch(
      /etapa "ETAPA DESCONHECIDA" não encontrada/,
    );

    // Nenhuma passagem para o CS (nem negócio derivado) por causa do ganho importado.
    expect(
      await t.prisma.negocio.count({ where: { negocioOrigemId: caio.id } }),
    ).toBe(0);
    expect(
      await t.prisma.negocio.count({ where: { funil: { area: 'CS' } } }),
    ).toBe(0);
    // A etapa original da planilha fica na auditoria da criação do negócio fechado.
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'negocio.criado', entidadeId: caio.id },
    });
    expect(JSON.stringify(auditoria.dados)).toContain('VENDA REALIZADA');
    // Fechado não entra na notificação de "negócios recebidos"; os 3 abertos entram.
    const notas = await t.prisma.notificacao.findMany({
      where: { usuarioId: equipe.membros[0].id, tipo: 'negocio.atribuido' },
    });
    const nota = notas.map((n) => n.texto).join(' ');
    expect(nota).toMatch(/2 negócios/);
  });

  it('cenário 415 — R16.14 — reimportar o mesmo ID não duplica: pular, completar e trocar (com movimentação); reconversão passa a guardar o ID', async () => {
    const { cliente } = await lider();
    const { funil, entrada } = await comercial();
    const ganha = funil.etapas.find((e) => e.tipo === 'GANHO')!;
    const traducao = {
      traducaoFunis: { sdr: funil.id },
      traducaoEtapas: { [funil.id]: { 'etapa a': entrada.id } },
    };
    const csv1 = csvClint([
      'k-1,01/11/2026 09:00:00,Gil Teste,gil@rei.com,55,61977770001,+55 61977770001,,Aberto,Etapa A,0,,,,SDR,,,x',
      'k-2,01/11/2026 09:00:00,Hana Teste,hana@rei.com,55,61977770002,+55 61977770002,,Ganho,Etapa A,200,,,,SDR,03/11/2026 10:00:00,,x',
    ]);
    const primeira = await importar(cliente, csv1, traducao);
    expect(primeira).toMatchObject({ status: 'CONCLUIDA' });
    expect(await t.prisma.negocio.count()).toBe(2);

    // Pular: nada muda e nenhum negócio é criado.
    const pulada = (await importar(cliente, csv1, {
      ...traducao,
      duplicados: 'IGNORAR',
    })) as ImportacaoDaApi & {
      negociosCriados: number;
      negociosAtualizados: number;
    };
    expect(pulada).toMatchObject({
      ignorados: 2,
      negociosCriados: 0,
      negociosAtualizados: 0,
    });
    expect(await t.prisma.negocio.count()).toBe(2);

    // Completar: preenche só o vazio (valor 0 do Gil e motivo ausente); o valor do Hana (200) fica.
    const csv2 = csvClint([
      'k-1,01/11/2026 09:00:00,Gil Teste,gil@rei.com,55,61977770001,+55 61977770001,,Aberto,Etapa A,750,,,,SDR,,,x',
      'k-2,01/11/2026 09:00:00,Hana Teste,hana@rei.com,55,61977770002,+55 61977770002,,Ganho,Etapa A,999,,,,SDR,03/11/2026 10:00:00,,x',
    ]);
    const completada = (await importar(cliente, csv2, {
      ...traducao,
      duplicados: 'ATUALIZAR_VAZIOS',
    })) as ImportacaoDaApi & {
      negociosCriados: number;
      negociosAtualizados: number;
    };
    expect(completada).toMatchObject({
      negociosCriados: 0,
      negociosAtualizados: 1,
    });
    expect(await t.prisma.negocio.count()).toBe(2);
    const gil = (await t.prisma.negocio.findFirst({
      where: { idExterno: 'k-1' },
    }))!;
    const hana = (await t.prisma.negocio.findFirst({
      where: { idExterno: 'k-2' },
    }))!;
    expect(gil.valor.toString()).toBe('750');
    expect(hana.valor.toString()).toBe('200');

    // Trocar: Gil virou ganho no Clint → o negócio existente é movido (histórico), sem outro negócio.
    const csv3 = csvClint([
      'k-1,01/11/2026 09:00:00,Gil Teste,gil@rei.com,55,61977770001,+55 61977770001,,Ganho,Etapa A,800,,,,SDR,04/11/2026 15:00:00,,x',
      'k-2,01/11/2026 09:00:00,Hana Teste,hana@rei.com,55,61977770002,+55 61977770002,,Perdido,Etapa A,300,Preço,,,SDR,,05/11/2026 09:00:00,x',
    ]);
    const trocada = (await importar(cliente, csv3, {
      ...traducao,
      duplicados: 'SOBRESCREVER',
    })) as ImportacaoDaApi & {
      negociosCriados: number;
      negociosAtualizados: number;
    };
    expect(trocada).toMatchObject({
      negociosCriados: 0,
      negociosAtualizados: 2,
    });
    expect(await t.prisma.negocio.count()).toBe(2);
    const gilDepois = await t.prisma.negocio.findUniqueOrThrow({
      where: { id: gil.id },
      include: { movimentacoes: { orderBy: { criadoEm: 'asc' } } },
    });
    expect(gilDepois).toMatchObject({ status: 'GANHO', etapaId: ganha.id });
    expect(gilDepois.valor.toString()).toBe('800');
    expect(gilDepois.ganhoEm?.toISOString()).toBe('2026-11-04T18:00:00.000Z');
    expect(gilDepois.movimentacoes).toHaveLength(2);
    expect(gilDepois.movimentacoes[1]).toMatchObject({
      deEtapaId: entrada.id,
      paraEtapaId: ganha.id,
    });
    // Sem passagem para o CS e sem negócio novo.
    expect(
      await t.prisma.negocio.count({ where: { funil: { area: 'CS' } } }),
    ).toBe(0);

    // Reconversão: contato com negócio aberto (sem ID) no funil → reconverte e passa a guardar o ID.
    const contato = await criarContato(t, {
      nome: 'Ivo',
      email: 'ivo@rei.com',
    });
    const aberto = await criarNegocio(t, { contato });
    const csv4 = csvClint([
      'k-9,01/11/2026 09:00:00,Ivo Teste,ivo@rei.com,55,61977770009,+55 61977770009,,Aberto,Etapa A,0,,,,SDR,,,x',
    ]);
    const reconv = (await importar(
      cliente,
      csv4,
      traducao,
    )) as ImportacaoDaApi & {
      negociosCriados: number;
      negociosReconvertidos: number;
    };
    expect(reconv).toMatchObject({
      negociosCriados: 0,
      negociosReconvertidos: 1,
    });
    expect(
      (await t.prisma.negocio.findUniqueOrThrow({ where: { id: aberto.id } }))
        .idExterno,
    ).toBe('k-9');
    const de2 = (await importar(cliente, csv4, traducao)) as ImportacaoDaApi & {
      negociosCriados: number;
      negociosReconvertidos: number;
      negociosAtualizados: number;
    };
    expect(de2).toMatchObject({
      negociosCriados: 0,
      negociosReconvertidos: 0,
    });
    expect(
      await t.prisma.negocio.count({
        where: { contato: { email: 'ivo@rei.com' } },
      }),
    ).toBe(1);
  });

  it('cenário 416 — R16.14 — status desconhecido entra aberto com aviso; data inválida ou futura é ignorada com aviso; modelo guarda as traduções; relatório traz negócios atualizados', async () => {
    const { cliente } = await lider();
    const { funil, entrada } = await comercial();
    const csv = csvClint([
      'z-1,31/02/2026 09:00:00,Jo Teste,jo@st.com,55,61966660001,+55 61966660001,,Congelado,Etapa A,0,,,,SDR,,,x',
      'z-2,01/01/2099 09:00:00,Kim Teste,kim@st.com,55,61966660002,+55 61966660002,,Ganho,Etapa A,0,,,,SDR,,,x',
    ]);
    const final = await importar(cliente, csv, {
      traducaoFunis: { sdr: funil.id },
      traducaoEtapas: { [funil.id]: { 'etapa a': entrada.id } },
    });
    expect(final).toMatchObject({ status: 'CONCLUIDA', criados: 2 });
    const linhas = await linhasDe(final.id, cliente);
    expect(linhas.find((l) => l.numero === 2)?.motivo).toMatch(
      /Status "Congelado" desconhecido: o negócio entrou aberto\./,
    );
    expect(linhas.find((l) => l.numero === 2)?.motivo).toMatch(
      /Data de criação do negócio inválida/,
    );
    expect(linhas.find((l) => l.numero === 3)?.motivo).toMatch(
      /Data de criação do negócio no futuro/,
    );
    const jo = await t.prisma.negocio.findFirstOrThrow({
      where: { contato: { email: 'jo@st.com' } },
    });
    expect(jo.status).toBe('ABERTO');
    const kim = await t.prisma.negocio.findFirstOrThrow({
      where: { contato: { email: 'kim@st.com' } },
    });
    // Data de criação futura ignorada: vale "agora" (ganhoEm também).
    expect(kim.criadoEm.getTime()).toBeLessThan(Date.now() + 1000);
    expect(kim.ganhoEm).not.toBeNull();

    // O modelo de mapeamento guarda as traduções.
    const modelo = await cliente
      .post('/api/v1/importacoes/modelos', {
        nome: 'Clint',
        tipo: 'CONTATOS',
        mapeamento: { origin: 'negocio.funil' },
        opcoes: {
          traducaoFunis: { SDR: funil.id },
          traducaoEtapas: { [funil.id]: { 'Etapa A': entrada.id } },
        },
      })
      .expect(201);
    const novo = await rascunho(cliente, csv);
    const aplicado = await cliente
      .patch(`/api/v1/importacoes/${novo.id}`, {
        modeloId: (modelo.body as { id: string }).id,
      })
      .expect(200);
    expect(aplicado.body).toMatchObject({
      traducaoFunis: { sdr: funil.id },
      traducaoEtapas: { [funil.id]: { 'etapa a': entrada.id } },
    });
  });
});
