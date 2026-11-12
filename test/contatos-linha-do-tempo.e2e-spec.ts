import { AuditoriaService } from '../src/auditoria/auditoria.service';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarConversa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
} from './utils';

const HORA = 3_600_000;

interface RegistroDaApi {
  tipo: 'evento' | 'atividade';
  ocorridoEm: string;
  evento: { acao: string; resumo: string } | null;
  atividade: { titulo: string; atrasada: boolean } | null;
}

interface PaginaDaApi {
  itens: RegistroDaApi[];
  total: number;
}

/** `evento:<acao>` ou `atividade:<titulo>`, na ordem da resposta. */
const registros = (pagina: PaginaDaApi) =>
  pagina.itens.map((item) =>
    item.tipo === 'evento'
      ? `evento:${item.evento?.acao}`
      : `atividade:${item.atividade?.titulo}`,
  );

describe('Contatos — linha do tempo (e2e)', () => {
  let t: AppTeste;
  let auditoria: AuditoriaService;

  beforeAll(async () => {
    t = await criarAppTeste();
    auditoria = t.get(AuditoriaService);
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  const linhaDoTempo = async (
    usuario: Usuario,
    caminho: string,
  ): Promise<PaginaDaApi> => {
    const cliente = await entrarComo(t, usuario);
    return (await cliente.get(caminho).expect(200)).body as PaginaDaApi;
  };

  it('R3.5 — junta auditoria e atividades do contato (e dos negócios dele), mais recentes primeiro, com paginação', async () => {
    const usuario = await criarUsuario(t);
    const admin = await entrarComo(t, usuario);
    const id = (
      await admin
        .post('/api/v1/contatos', { nome: 'Maria', email: 'maria@x.com' })
        .expect(201)
    ).body.contato.id as string;
    await admin.patch(`/api/v1/contatos/${id}`, { cargo: 'CEO' }).expect(200);
    await criarAtividade(t, {
      responsavel: usuario,
      contato: id,
      titulo: 'Atrasada',
      venceEm: new Date(Date.now() - 24 * HORA),
    });
    await criarAtividade(t, {
      responsavel: usuario,
      contato: id,
      titulo: 'Nota',
      tipo: 'NOTA',
    });
    await criarAtividade(t, {
      responsavel: usuario,
      contato: id,
      titulo: 'Reunião futura',
      tipo: 'REUNIAO',
      inicioEm: new Date(Date.now() + 48 * HORA),
      fimEm: new Date(Date.now() + 49 * HORA),
    });
    const negocio = await criarNegocio(t, { contato: id });
    await criarAtividade(t, {
      responsavel: usuario,
      negocio,
      titulo: 'Do negócio',
      venceEm: new Date(Date.now() + 24 * HORA),
    });
    await criarAtividade(t, {
      responsavel: usuario,
      contato: (await criarContato(t)).id,
      titulo: 'De outro contato',
    });

    const pagina = (
      await admin.get(`/api/v1/contatos/${id}/linha-do-tempo`).expect(200)
    ).body as PaginaDaApi & { pagina: number; porPagina: number };
    expect(pagina).toMatchObject({ total: 6, pagina: 1, porPagina: 20 });
    expect(registros(pagina)).toEqual([
      'atividade:Reunião futura',
      'atividade:Do negócio',
      'atividade:Nota',
      'evento:contato.atualizado',
      'evento:contato.criado',
      'atividade:Atrasada',
    ]);
    const datas = pagina.itens.map((item) => Date.parse(item.ocorridoEm));
    expect([...datas].sort((a, b) => b - a)).toEqual(datas);

    const atrasada = pagina.itens.find(
      (item) => item.atividade?.titulo === 'Atrasada',
    );
    expect(atrasada?.atividade).toMatchObject({
      status: 'PENDENTE',
      atrasada: true,
      responsavel: { id: usuario.id },
      contatoId: id,
    });
    expect(
      pagina.itens.find((item) => item.atividade?.titulo === 'Nota')?.atividade
        ?.atrasada,
    ).toBe(false);
    const edicao = pagina.itens.find(
      (item) => item.evento?.acao === 'contato.atualizado',
    )?.evento;
    expect(edicao).toMatchObject({
      entidade: 'contato',
      entidadeId: id,
      tipoAtor: 'USUARIO',
      usuarioId: usuario.id,
      atorDescricao: usuario.nome,
      dados: { alteracoes: { cargo: { antes: null, depois: 'CEO' } } },
    });
    // A linha do tempo não expõe IP, user agent nem id da requisição.
    expect(edicao).not.toHaveProperty('ip');
    expect(edicao).not.toHaveProperty('userAgent');

    const segunda = (
      await admin
        .get(`/api/v1/contatos/${id}/linha-do-tempo`)
        .query({ porPagina: 4, pagina: 2 })
        .expect(200)
    ).body as PaginaDaApi;
    expect(segunda.total).toBe(6);
    expect(registros(segunda)).toEqual([
      'evento:contato.criado',
      'atividade:Atrasada',
    ]);
    const atividades = (
      await admin
        .get(`/api/v1/contatos/${id}/linha-do-tempo`)
        .query({ incluir: 'atividades' })
        .expect(200)
    ).body as PaginaDaApi;
    expect(atividades.total).toBe(4);
    const eventos = (
      await admin
        .get(`/api/v1/contatos/${id}/linha-do-tempo`)
        .query({ incluir: 'eventos' })
        .expect(200)
    ).body as PaginaDaApi;
    expect(registros(eventos)).toEqual([
      'evento:contato.atualizado',
      'evento:contato.criado',
    ]);
    await admin
      .get(`/api/v1/contatos/${id}/linha-do-tempo`)
      .query({ incluir: 'outro' })
      .expect(400);
  });

  it('R3.5/R6.4 — membro vê as atividades de que é responsável ou criador; o líder, as da equipe; o C-level, todas', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL');
    const [ana, bruno] = comercial.membros;
    const marketing = await criarEquipe(t, 'MARKETING', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const carla = marketing.membros[0];
    const contato = await criarContato(t);
    await criarAtividade(t, { responsavel: ana, contato, titulo: 'Da Ana' });
    const doBruno = await criarAtividade(t, {
      responsavel: bruno,
      contato,
      titulo: 'Do Bruno',
    });
    await criarAtividade(t, {
      responsavel: bruno,
      criadoPor: ana,
      contato,
      titulo: 'Criada pela Ana',
    });
    await criarAtividade(t, {
      responsavel: carla,
      contato,
      titulo: 'Da Carla',
    });
    await auditoria.registrar(t.prisma, {
      acao: 'atividade.criada',
      entidade: 'atividade',
      entidadeId: doBruno.id,
      resumo: 'Atividade "Do Bruno" criada',
      relacionados: { contato: contato.id },
    });

    const visivel = async (usuario: Usuario) => {
      const pagina = await linhaDoTempo(
        usuario,
        `/api/v1/contatos/${contato.id}/linha-do-tempo`,
      );
      return { total: pagina.total, itens: registros(pagina).sort() };
    };
    expect(await visivel(ana)).toEqual({
      total: 2,
      itens: ['atividade:Criada pela Ana', 'atividade:Da Ana'],
    });
    expect(await visivel(bruno)).toEqual({
      total: 3,
      itens: [
        'atividade:Criada pela Ana',
        'atividade:Do Bruno',
        'evento:atividade.criada',
      ],
    });
    expect(await visivel(comercial.lider)).toEqual({
      total: 4,
      itens: [
        'atividade:Criada pela Ana',
        'atividade:Da Ana',
        'atividade:Do Bruno',
        'evento:atividade.criada',
      ],
    });
    expect(await visivel(carla)).toEqual({
      total: 1,
      itens: ['atividade:Da Carla'],
    });
    expect((await visivel(comercial.cLevel)).total).toBe(5);
  });

  it('R3.5/R12.2/R22.1 — eventos de conversa, contrato, parcela e de entidades fora da lista seguem a visibilidade do módulo', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL');
    const [ana, bruno] = comercial.membros;
    const contato = await criarContato(t);
    const deAna = await criarConversa(t, { contato, responsavel: ana });
    const deBruno = await criarConversa(t, { contato, responsavel: bruno });
    const evento = (entidade: string, entidadeId: string, acao: string) =>
      auditoria.registrar(t.prisma, {
        acao,
        entidade,
        entidadeId,
        resumo: acao,
        relacionados: { contato: contato.id },
      });
    await evento('conversa', deAna.id, 'conversa.da_ana');
    await evento('conversa', deBruno.id, 'conversa.do_bruno');
    // Contrato e parcela de que ninguém do Comercial vê além dos próprios negócios ganhos (R22.1).
    await evento('contrato', deAna.id, 'contrato.alheio');
    await evento('parcela', deAna.id, 'parcela.alheia');
    await evento('configuracao', deAna.id, 'configuracao.interna');
    await evento('contato', contato.id, 'contato.visivel');

    const acoes = async (usuario: Usuario) =>
      (
        await linhaDoTempo(
          usuario,
          `/api/v1/contatos/${contato.id}/linha-do-tempo`,
        )
      ).itens
        .map((item) => item.evento?.acao)
        .sort();
    expect(await acoes(ana)).toEqual(['contato.visivel', 'conversa.da_ana']);
    expect(await acoes(bruno)).toEqual([
      'contato.visivel',
      'conversa.do_bruno',
    ]);
    expect(await acoes(comercial.cLevel)).toEqual([
      'configuracao.interna',
      'contato.visivel',
      'contrato.alheio',
      'conversa.da_ana',
      'conversa.do_bruno',
      'parcela.alheia',
    ]);
  });

  it('R3.5/R5.9 — eventos de negócio seguem a visibilidade dos funis', async () => {
    const comercial = await criarEquipe(t, 'COMERCIAL');
    const [ana, bruno] = comercial.membros;
    const marketing = await criarEquipe(t, 'MARKETING', {
      membros: 1,
      cLevel: comercial.cLevel,
    });
    const carla = marketing.membros[0];
    const contato = await criarContato(t);
    const negocios = [
      await criarNegocio(t, {
        contato,
        area: 'COMERCIAL',
        responsavel: bruno,
        titulo: 'Comercial do Bruno',
      }),
      await criarNegocio(t, {
        contato,
        area: 'COMERCIAL',
        titulo: 'Comercial sem dono',
      }),
      await criarNegocio(t, {
        contato,
        area: 'MARKETING',
        responsavel: carla,
        titulo: 'Marketing da Carla',
      }),
    ];
    for (const negocio of negocios) {
      await auditoria.registrar(t.prisma, {
        acao: 'negocio.movido',
        entidade: 'negocio',
        entidadeId: negocio.id,
        resumo: `Negócio "${negocio.titulo}" movido`,
        relacionados: { contato: contato.id },
      });
    }
    await auditoria.registrar(t.prisma, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: contato.id,
      resumo: 'Contato atualizado',
    });

    const resumos = async (usuario: Usuario) =>
      (
        await linhaDoTempo(
          usuario,
          `/api/v1/contatos/${contato.id}/linha-do-tempo`,
        )
      ).itens
        .map((item) => item.evento?.resumo ?? '')
        .sort();
    expect(await resumos(ana)).toEqual([
      'Contato atualizado',
      'Negócio "Comercial sem dono" movido',
    ]);
    expect(await resumos(bruno)).toEqual([
      'Contato atualizado',
      'Negócio "Comercial do Bruno" movido',
      'Negócio "Comercial sem dono" movido',
    ]);
    expect(await resumos(comercial.lider)).toEqual([
      'Contato atualizado',
      'Negócio "Comercial do Bruno" movido',
      'Negócio "Comercial sem dono" movido',
    ]);
    expect(await resumos(carla)).toEqual([
      'Contato atualizado',
      'Negócio "Marketing da Carla" movido',
    ]);
    expect(await resumos(comercial.cLevel)).toHaveLength(4);
  });

  it('R3.5 — linha do tempo da empresa: eventos dela e dos contatos ligados, atividades dela e dos negócios dela', async () => {
    const usuario = await criarUsuario(t);
    const admin = await entrarComo(t, usuario);
    const empresa = (
      await admin.post('/api/v1/empresas', { nome: 'ACME' }).expect(201)
    ).body as { id: string };
    await admin
      .post('/api/v1/contatos', {
        nome: 'Ana',
        email: 'ana@acme.com',
        empresaId: empresa.id,
      })
      .expect(201);
    await criarAtividade(t, {
      responsavel: usuario,
      empresa: empresa.id,
      titulo: 'Visita',
    });
    const negocio = await criarNegocio(t, { empresa: empresa.id });
    await criarAtividade(t, {
      responsavel: usuario,
      negocio,
      titulo: 'Proposta',
    });
    await criarAtividade(t, { responsavel: usuario, titulo: 'Solta' });

    const pagina = await linhaDoTempo(
      usuario,
      `/api/v1/empresas/${empresa.id}/linha-do-tempo`,
    );
    expect(pagina.total).toBe(4);
    expect(registros(pagina).sort()).toEqual([
      'atividade:Proposta',
      'atividade:Visita',
      'evento:contato.criado',
      'evento:empresa.criada',
    ]);
    await admin
      .get(
        '/api/v1/empresas/00000000-0000-4000-8000-000000000000/linha-do-tempo',
      )
      .expect(404);
    await admin
      .get(
        '/api/v1/contatos/00000000-0000-4000-8000-000000000000/linha-do-tempo',
      )
      .expect(404);
  });
});
