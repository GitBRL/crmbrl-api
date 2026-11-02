import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditoriaService } from '../src/auditoria/auditoria.service';
import { codificarCursor } from '../src/auditoria/consulta/consulta-comum';
import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { calcularAlteracoes } from '../src/comum/dados/sanitizar';
import type {
  EventoAuditoria,
  Prisma,
  TipoAtor,
  Usuario,
} from '../src/generated/prisma/client';
import {
  type AppTeste,
  clienteAnonimo,
  type ClienteHttp,
  cookieDaSessao,
  criarAppTeste,
  criarContato,
  criarEquipe,
  criarUsuario,
  entrarComo,
  ORIGEM_DE_TESTE,
  SENHA_DE_TESTE,
} from './utils';

interface DadosDeEvento {
  acao: string;
  entidade: string;
  entidadeId?: string | null;
  resumo: string;
  usuario?: Usuario | null;
  /** Usuário sem cadastro (ex.: que não existe mais); o padrão é o de `usuario`. */
  usuarioId?: string | null;
  tipoAtor?: TipoAtor;
  atorDescricao?: string | null;
  criadoEm?: Date;
  dados?: Prisma.InputJsonObject;
  relacionados?: string[];
  requisicaoId?: string | null;
}

/** Grava um evento direto no banco (INSERT é permitido; R3.3 só recusa UPDATE/DELETE). */
function registrarEvento(
  t: AppTeste,
  dados: DadosDeEvento,
): Promise<EventoAuditoria> {
  const entidadeId = dados.entidadeId ?? null;
  return t.prisma.eventoAuditoria.create({
    data: {
      acao: dados.acao,
      entidade: dados.entidade,
      entidadeId,
      resumo: dados.resumo,
      tipoAtor: dados.tipoAtor ?? (dados.usuario ? 'USUARIO' : 'SISTEMA'),
      usuarioId: dados.usuarioId ?? dados.usuario?.id ?? null,
      atorDescricao: dados.atorDescricao ?? dados.usuario?.nome ?? null,
      criadoEm: dados.criadoEm,
      dados: dados.dados,
      relacionados:
        dados.relacionados ??
        (entidadeId ? [`${dados.entidade}:${entidadeId}`] : []),
      requisicaoId: dados.requisicaoId ?? null,
    },
  });
}

interface ItemDaLista {
  id: string;
  acao: string;
  entidade: string;
  entidadeId: string | null;
  resumo: string;
  tipoAtor: TipoAtor;
  usuarioId: string | null;
  quantidadeAlteracoes: number;
}

interface PaginaDaLista {
  itens: ItemDaLista[];
  proximoCursor: string | null;
}

async function listar(
  cliente: ClienteHttp,
  consulta: string,
  status = 200,
): Promise<PaginaDaLista> {
  const resposta = await cliente
    .get(`/api/v1/auditoria${consulta ? `?${consulta}` : ''}`)
    .expect(status);
  return resposta.body as PaginaDaLista;
}

const acoesDe = (pagina: PaginaDaLista) => pagina.itens.map(({ acao }) => acao);
const idsDe = (pagina: PaginaDaLista) => pagina.itens.map(({ id }) => id);

describe('Auditoria — consulta (e2e)', () => {
  let t: AppTeste;
  /** Eventos que a configuração inicial gravou no `limparBanco` (funis, passagens, rodízios…). */
  let iniciais: number;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    iniciais = await t.prisma.eventoAuditoria.count();
  });

  afterAll(async () => {
    await t.fechar();
  });

  async function adminLogado(): Promise<{
    admin: Usuario;
    cliente: ClienteHttp;
  }> {
    const admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    return { admin, cliente: await entrarComo(t, admin) };
  }

  it('R3.4 — só Admin e C-level consultam: membro e líder recebem 403; sem sessão, 401', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const membro = await entrarComo(t, equipe.membros[0]);
    const lider = await entrarComo(t, equipe.lider);
    const marketing = await entrarComo(
      t,
      (await criarEquipe(t, 'MARKETING', { membros: 1 })).membros[0],
    );
    const evento = await registrarEvento(t, {
      acao: 'teste.acesso',
      entidade: 'teste',
      resumo: 'Evento de teste',
    });
    const rotas = [
      '/api/v1/auditoria',
      '/api/v1/auditoria/filtros',
      `/api/v1/auditoria/${evento.id.toString()}`,
    ];
    for (const rota of rotas) {
      await clienteAnonimo(t).get(rota).expect(401);
      for (const cliente of [membro, lider, marketing]) {
        const negado = await cliente.get(rota).expect(403);
        expect(negado.body.erro).toBe('sem_permissao');
      }
    }
    const admin = (await adminLogado()).cliente;
    const cLevel = await entrarComo(t, equipe.cLevel);
    for (const cliente of [admin, cLevel]) {
      for (const rota of rotas) {
        await cliente.get(rota).expect(200);
      }
    }
  });

  it('R3.4 — lista do mais novo para o mais antigo, com ator, ação, entidade e resumo', async () => {
    const { cliente } = await adminLogado();
    const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
    const negocioId = randomUUID();
    await registrarEvento(t, {
      acao: 'negocio.criado',
      entidade: 'negocio',
      entidadeId: negocioId,
      resumo: 'Negócio "ACME" criado',
      usuario: ana,
      requisicaoId: 'req-1',
    });
    const movido = await registrarEvento(t, {
      acao: 'negocio.movido',
      entidade: 'negocio',
      entidadeId: negocioId,
      resumo: 'Negócio "ACME" movido para Proposta',
      usuario: ana,
      dados: {
        alteracoes: { etapaId: { antes: 'a', depois: 'b' } },
      } as Prisma.InputJsonObject,
    });

    const pagina = await listar(cliente, 'limite=100');
    expect(pagina.itens).toHaveLength(iniciais + 2);
    expect(pagina.proximoCursor).toBeNull();
    const ids = idsDe(pagina).map(BigInt);
    expect([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(ids);
    expect(pagina.itens[0]).toEqual({
      id: movido.id.toString(),
      criadoEm: movido.criadoEm.toISOString(),
      tipoAtor: 'USUARIO',
      usuarioId: ana.id,
      atorDescricao: 'Ana',
      acao: 'negocio.movido',
      entidade: 'negocio',
      entidadeId: negocioId,
      resumo: 'Negócio "ACME" movido para Proposta',
      quantidadeAlteracoes: 1,
      requisicaoId: null,
    });
    expect(pagina.itens[1]).toMatchObject({
      acao: 'negocio.criado',
      quantidadeAlteracoes: 0,
      requisicaoId: 'req-1',
    });
  });

  it('R3.4 — filtra por período: "de" inclusivo e "ate" exclusivo', async () => {
    const { cliente } = await adminLogado();
    for (const dia of ['10', '11', '12']) {
      await registrarEvento(t, {
        acao: 'contato.criado',
        entidade: 'contato',
        entidadeId: randomUUID(),
        resumo: `Contato do dia ${dia}`,
        criadoEm: new Date(`2026-01-${dia}T12:00:00.000Z`),
      });
    }
    const resumos = async (consulta: string) =>
      (await listar(cliente, consulta)).itens.map(({ resumo }) => resumo);

    expect(
      await resumos('de=2026-01-11T12:00:00Z&ate=2026-01-12T12:00:00Z'),
    ).toEqual(['Contato do dia 11']);
    expect(
      await resumos('de=2026-01-11T09:00:00-03:00&ate=2026-02-01'),
    ).toEqual(['Contato do dia 12', 'Contato do dia 11']);
    expect(await resumos('ate=2026-01-11')).toEqual(['Contato do dia 10']);
    // Sem "ate": vai até agora, e a configuração inicial (de hoje) entra.
    const desde12 = await listar(cliente, 'de=2026-01-12&limite=100');
    expect(desde12.itens).toHaveLength(iniciais + 1);
  });

  it('R3.4 — filtra por usuário, ação (uma ou várias), entidade, id da entidade, tipo de ator e requisição', async () => {
    const { cliente } = await adminLogado();
    const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
    const bruno = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' });
    const negocio = randomUUID();
    const contato = randomUUID();
    await registrarEvento(t, {
      acao: 'negocio.movido',
      entidade: 'negocio',
      entidadeId: negocio,
      resumo: 'Movido',
      usuario: ana,
      requisicaoId: 'req-ana',
    });
    await registrarEvento(t, {
      acao: 'negocio.ganho',
      entidade: 'negocio',
      entidadeId: negocio,
      resumo: 'Ganho',
      usuario: ana,
    });
    await registrarEvento(t, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: contato,
      resumo: 'Atualizado',
      usuario: bruno,
    });
    await registrarEvento(t, {
      acao: 'contato.criado',
      entidade: 'contato',
      entidadeId: randomUUID(),
      resumo: 'Criado pelo webhook',
      tipoAtor: 'WEBHOOK',
      atorDescricao: 'Landing page',
    });

    expect(acoesDe(await listar(cliente, `usuarioId=${ana.id}`))).toEqual([
      'negocio.ganho',
      'negocio.movido',
    ]);
    expect(acoesDe(await listar(cliente, 'acao=negocio.movido'))).toEqual([
      'negocio.movido',
    ]);
    expect(
      acoesDe(await listar(cliente, 'acao=negocio.movido,contato.criado')),
    ).toEqual(['contato.criado', 'negocio.movido']);
    expect(
      acoesDe(
        await listar(cliente, 'acao=negocio.ganho&acao=contato.atualizado'),
      ),
    ).toEqual(['contato.atualizado', 'negocio.ganho']);
    expect(acoesDe(await listar(cliente, 'entidade=contato'))).toEqual([
      'contato.criado',
      'contato.atualizado',
    ]);
    expect(
      acoesDe(await listar(cliente, `entidade=negocio&entidadeId=${negocio}`)),
    ).toEqual(['negocio.ganho', 'negocio.movido']);
    expect(acoesDe(await listar(cliente, `entidadeId=${contato}`))).toEqual([
      'contato.atualizado',
    ]);
    expect(acoesDe(await listar(cliente, 'tipoAtor=WEBHOOK'))).toEqual([
      'contato.criado',
    ]);
    expect(
      (await listar(cliente, 'tipoAtor=SISTEMA&limite=100')).itens,
    ).toHaveLength(
      await t.prisma.eventoAuditoria.count({ where: { tipoAtor: 'SISTEMA' } }),
    );
    expect(acoesDe(await listar(cliente, 'requisicaoId=req-ana'))).toEqual([
      'negocio.movido',
    ]);
    expect((await listar(cliente, `usuarioId=${randomUUID()}`)).itens).toEqual(
      [],
    );
  });

  it('R3.4/R3.5 — entidade + id com incluirRelacionados traz também os eventos ligados a ela', async () => {
    const { cliente } = await adminLogado();
    const contato = randomUUID();
    const negocio = randomUUID();
    await registrarEvento(t, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: contato,
      resumo: 'Contato atualizado',
    });
    await registrarEvento(t, {
      acao: 'negocio.criado',
      entidade: 'negocio',
      entidadeId: negocio,
      resumo: 'Negócio criado para o contato',
      relacionados: [`negocio:${negocio}`, `contato:${contato}`],
    });
    await registrarEvento(t, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: randomUUID(),
      resumo: 'Outro contato',
    });

    const consulta = `entidade=contato&entidadeId=${contato}`;
    expect(acoesDe(await listar(cliente, consulta))).toEqual([
      'contato.atualizado',
    ]);
    expect(
      acoesDe(await listar(cliente, `${consulta}&incluirRelacionados=true`)),
    ).toEqual(['negocio.criado', 'contato.atualizado']);
    const semId = await cliente
      .get('/api/v1/auditoria?entidade=contato&incluirRelacionados=true')
      .expect(400);
    expect(semId.body.detalhes.campos).toEqual([
      {
        campo: 'incluirRelacionados',
        mensagens: ['exige entidade e entidadeId'],
      },
    ]);
  });

  it('R3.4 — busca por texto sem diferenciar maiúsculas nem acentos; várias palavras precisam aparecer todas', async () => {
    const { cliente } = await adminLogado();
    const negocio = randomUUID();
    await registrarEvento(t, {
      acao: 'negocio.movido',
      entidade: 'negocio',
      entidadeId: negocio,
      resumo: 'Negócio "ACME Ltda." movido para Proposta',
      atorDescricao: 'João Gonçalves',
      tipoAtor: 'USUARIO',
    });
    await registrarEvento(t, {
      acao: 'contato.criado',
      entidade: 'contato',
      entidadeId: randomUUID(),
      resumo: 'Contato MARIA ÁVILA criado (100% pelo site)',
      atorDescricao: 'Landing page',
      tipoAtor: 'WEBHOOK',
    });
    const busca = async (texto: string) =>
      acoesDe(await listar(cliente, `texto=${encodeURIComponent(texto)}`));

    expect(await busca('negocio')).toEqual(['negocio.movido']);
    expect(await busca('NEGÓCIO')).toEqual(['negocio.movido']);
    expect(await busca('acme proposta')).toEqual(['negocio.movido']);
    expect(await busca('Proposta ACME')).toEqual(['negocio.movido']);
    expect(await busca('acme maria')).toEqual([]);
    expect(await busca('goncalves')).toEqual(['negocio.movido']);
    expect(await busca('maria avila')).toEqual(['contato.criado']);
    expect(await busca('avila')).toEqual(['contato.criado']);
    // A ação e o id da entidade também entram na busca.
    expect(await busca('contato.criado')).toEqual(['contato.criado']);
    expect(await busca(negocio)).toEqual(['negocio.movido']);
    // Curingas do LIKE são texto comum.
    expect(await busca('100%')).toEqual(['contato.criado']);
    expect(await busca('%')).toEqual(['contato.criado']);
    expect(await busca('ma_ia')).toEqual([]);
    expect(await busca('ma%ia')).toEqual([]);
  });

  it('R3.4 — filtros combinados: todos precisam valer ao mesmo tempo', async () => {
    const { cliente } = await adminLogado();
    const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
    const bruno = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' });
    const quando = (dia: string) => new Date(`2026-03-${dia}T15:00:00.000Z`);
    const alvo = await registrarEvento(t, {
      acao: 'negocio.ganho',
      entidade: 'negocio',
      entidadeId: randomUUID(),
      resumo: 'Negócio "Escola Alfa" ganho',
      usuario: ana,
      criadoEm: quando('05'),
    });
    // Cada um destes difere do alvo em um só critério.
    await registrarEvento(t, {
      acao: 'negocio.ganho',
      entidade: 'negocio',
      entidadeId: randomUUID(),
      resumo: 'Negócio "Escola Alfa" ganho',
      usuario: bruno,
      criadoEm: quando('05'),
    });
    await registrarEvento(t, {
      acao: 'negocio.perdido',
      entidade: 'negocio',
      entidadeId: randomUUID(),
      resumo: 'Negócio "Escola Alfa" perdido',
      usuario: ana,
      criadoEm: quando('05'),
    });
    await registrarEvento(t, {
      acao: 'negocio.ganho',
      entidade: 'negocio',
      entidadeId: randomUUID(),
      resumo: 'Negócio "Escola Beta" ganho',
      usuario: ana,
      criadoEm: quando('05'),
    });
    await registrarEvento(t, {
      acao: 'negocio.ganho',
      entidade: 'negocio',
      entidadeId: randomUUID(),
      resumo: 'Negócio "Escola Alfa" ganho',
      usuario: ana,
      criadoEm: quando('20'),
    });

    const combinado = [
      'de=2026-03-01T00:00:00Z',
      'ate=2026-03-10T00:00:00Z',
      `usuarioId=${ana.id}`,
      'acao=negocio.ganho',
      'entidade=negocio',
      'tipoAtor=USUARIO',
      'texto=escola%20ALFA',
    ].join('&');
    const pagina = await listar(cliente, combinado);
    expect(idsDe(pagina)).toEqual([alvo.id.toString()]);
    expect(
      (
        await listar(
          cliente,
          combinado.replace('tipoAtor=USUARIO', 'tipoAtor=WEBHOOK'),
        )
      ).itens,
    ).toEqual([]);
    // Sem o filtro de usuário, entra o do Bruno; sem o de texto, o da Beta.
    expect(
      (await listar(cliente, combinado.replace(`usuarioId=${ana.id}&`, '')))
        .itens,
    ).toHaveLength(2);
    expect(
      (await listar(cliente, combinado.replace('&texto=escola%20ALFA', '')))
        .itens,
    ).toHaveLength(2);
  });

  it('R3.4 — cursor percorre tudo sem repetir e é estável: eventos novos não deslocam as páginas seguintes', async () => {
    const { cliente } = await adminLogado();
    for (let indice = 1; indice <= 7; indice++) {
      await registrarEvento(t, {
        acao: 'atividade.criada',
        entidade: 'atividade',
        entidadeId: randomUUID(),
        resumo: `Atividade ${indice}`,
      });
    }
    const total = iniciais + 7;

    // Antes de qualquer evento novo: todas as páginas.
    const paginas: PaginaDaLista[] = [];
    let cursor: string | null = null;
    do {
      const pagina: PaginaDaLista = await listar(
        cliente,
        `limite=4${cursor ? `&cursor=${cursor}` : ''}`,
      );
      paginas.push(pagina);
      cursor = pagina.proximoCursor;
    } while (cursor);
    const cheias = Math.ceil(total / 4) - 1;
    expect(paginas.map(({ itens }) => itens.length)).toEqual([
      ...Array<number>(cheias).fill(4),
      total - cheias * 4,
    ]);
    const todos = paginas.flatMap(idsDe);
    expect(new Set(todos).size).toBe(total);
    expect(todos).toEqual(
      [...todos].sort((a, b) => Number(BigInt(b) - BigInt(a))),
    );

    // Com a primeira página na mão, chegam eventos novos...
    const primeira = await listar(cliente, 'limite=4');
    for (let indice = 1; indice <= 3; indice++) {
      await registrarEvento(t, {
        acao: 'atividade.concluida',
        entidade: 'atividade',
        entidadeId: randomUUID(),
        resumo: `Concluída ${indice}`,
      });
    }
    // ...e a segunda página continua exatamente onde a primeira parou.
    const segunda = await listar(
      cliente,
      `limite=4&cursor=${primeira.proximoCursor}`,
    );
    expect(idsDe(segunda)).toEqual(idsDe(paginas[1]));
    // Uma consulta nova começa pelos eventos novos.
    expect(acoesDe(await listar(cliente, 'limite=3'))).toEqual([
      'atividade.concluida',
      'atividade.concluida',
      'atividade.concluida',
    ]);

    // O cursor respeita os filtros da consulta.
    const filtrada = await listar(cliente, 'acao=atividade.criada&limite=5');
    const restante = await listar(
      cliente,
      `acao=atividade.criada&limite=5&cursor=${filtrada.proximoCursor}`,
    );
    expect(acoesDe(restante)).toEqual(['atividade.criada', 'atividade.criada']);
    expect(restante.proximoCursor).toBeNull();
    expect(new Set([...idsDe(filtrada), ...idsDe(restante)]).size).toBe(7);
  });

  it('R3.4 — entradas inválidas devolvem 400 com o campo: cursor, período, limite, data sem fuso e parâmetro desconhecido', async () => {
    const { cliente } = await adminLogado();
    const campos = async (consulta: string) => {
      const resposta = await cliente
        .get(`/api/v1/auditoria?${consulta}`)
        .expect(400);
      expect(resposta.body.erro).toBe('dados_invalidos');
      return (resposta.body.detalhes.campos as { campo: string }[]).map(
        ({ campo }) => campo,
      );
    };
    expect(await campos('cursor=nao-e-um-cursor')).toEqual(['cursor']);
    expect(await campos(`cursor=${codificarCursor('logs', 10n)}`)).toEqual([
      'cursor',
    ]);
    expect(
      await campos('de=2026-10-21T00:00:00Z&ate=2026-10-20T00:00:00Z'),
    ).toEqual(['ate']);
    expect(await campos('de=2026-10-20T10:00:00')).toEqual(['de']);
    expect(await campos('ate=ontem')).toEqual(['ate']);
    expect(await campos('limite=101')).toEqual(['limite']);
    expect(await campos('limite=0')).toEqual(['limite']);
    expect(await campos('tipoAtor=ROBO')).toEqual(['tipoAtor']);
    expect(await campos('usuarioId=123')).toEqual(['usuarioId']);
    expect(await campos('ordem=asc')).toEqual(['ordem']);
    expect(await campos(`texto=${'x'.repeat(201)}`)).toEqual(['texto']);
  });

  it('R3.4/R3.1 — detalhe com o diff (antes/depois), dados sem segredos, relacionados e o usuário', async () => {
    const { cliente } = await adminLogado();
    const ana = await criarUsuario(t, {
      papel: 'COMERCIAL',
      nome: 'Ana Souza',
      email: 'ana@teste.local',
    });
    const negocioId = randomUUID();
    const contatoId = randomUUID();
    const antes = {
      titulo: 'ACME',
      valor: '100.00',
      etapaId: 'proposta',
      senha: 'antiga',
    };
    const depois = {
      titulo: 'ACME Escola',
      valor: '100.00',
      etapaId: 'negociacao',
      senha: 'nova-secreta',
    };
    const evento = await executarComoAtor(
      {
        tipoAtor: 'USUARIO',
        usuario: { id: ana.id, papel: ana.papel, nome: ana.nome },
      },
      () =>
        t.prisma.$transaction((tx) =>
          t.get(AuditoriaService).registrar(tx, {
            acao: 'negocio.atualizado',
            entidade: 'negocio',
            entidadeId: negocioId,
            resumo: 'Negócio "ACME Escola" atualizado',
            dados: {
              alteracoes: calcularAlteracoes(antes, depois),
              token: 'abc123',
            },
            relacionados: { contato: contatoId },
          }),
        ),
    );

    const resposta = await cliente
      .get(`/api/v1/auditoria/${evento.id.toString()}`)
      .expect(200);
    expect(resposta.body).toEqual({
      id: evento.id.toString(),
      criadoEm: evento.criadoEm.toISOString(),
      tipoAtor: 'USUARIO',
      usuarioId: ana.id,
      atorDescricao: 'Ana Souza',
      acao: 'negocio.atualizado',
      entidade: 'negocio',
      entidadeId: negocioId,
      resumo: 'Negócio "ACME Escola" atualizado',
      quantidadeAlteracoes: 3,
      requisicaoId: evento.requisicaoId,
      alteracoes: [
        { campo: 'etapaId', antes: 'proposta', depois: 'negociacao' },
        { campo: 'senha', antes: '[omitido]', depois: '[omitido]' },
        { campo: 'titulo', antes: 'ACME', depois: 'ACME Escola' },
      ],
      dados: {
        alteracoes: {
          titulo: { antes: 'ACME', depois: 'ACME Escola' },
          etapaId: { antes: 'proposta', depois: 'negociacao' },
          // O sanitizador da auditoria tira o objeto inteiro do campo sensível.
          senha: '[omitido]',
        },
        token: '[omitido]',
      },
      relacionados: [
        { entidade: 'negocio', id: negocioId },
        { entidade: 'contato', id: contatoId },
      ],
      ip: null,
      userAgent: null,
      usuario: {
        id: ana.id,
        nome: 'Ana Souza',
        email: 'ana@teste.local',
        papel: 'COMERCIAL',
        ativo: true,
      },
    });
    expect(resposta.text).not.toContain('nova-secreta');
    expect(resposta.text).not.toContain('abc123');

    // Na lista, o mesmo evento aparece com a contagem de campos alterados.
    const lista = await listar(cliente, 'acao=negocio.atualizado');
    expect(lista.itens[0].quantidadeAlteracoes).toBe(3);

    // Evento de sistema: sem usuário; usuário que não existe mais: `usuario` nulo.
    const sistema = await registrarEvento(t, {
      acao: 'funil.criado',
      entidade: 'funil',
      entidadeId: randomUUID(),
      resumo: 'Funil criado pelo sistema',
      tipoAtor: 'SISTEMA',
      atorDescricao: 'Configuração inicial',
    });
    const deSistema = await cliente
      .get(`/api/v1/auditoria/${sistema.id.toString()}`)
      .expect(200);
    expect(deSistema.body).toMatchObject({
      tipoAtor: 'SISTEMA',
      usuario: null,
      alteracoes: [],
    });
    const orfao = await registrarEvento(t, {
      acao: 'usuario.login',
      entidade: 'usuario',
      resumo: 'Login de quem não existe mais',
      usuarioId: randomUUID(),
      tipoAtor: 'USUARIO',
      atorDescricao: 'Fantasma',
      dados: { contagens: { negocios: 2 } },
    });
    const semUsuario = await cliente
      .get(`/api/v1/auditoria/${orfao.id.toString()}`)
      .expect(200);
    expect(semUsuario.body).toMatchObject({
      usuario: null,
      alteracoes: [],
      dados: { contagens: { negocios: 2 } },
    });
  });

  it('textos sem código de regra: resumos antigos, gravados com "(R4.6)", saem limpos na consulta e na linha do tempo', async () => {
    const admin = await criarUsuario(t, { papel: 'ADMIN' });
    const comoAdmin = await entrarComo(t, admin);
    const contato = await criarContato(t, { nome: 'Titular' });
    const antigo = await registrarEvento(t, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: contato.id,
      resumo: 'Contato anonimizado pelo Admin (LGPD, R4.6)',
      usuario: admin,
    });
    await registrarEvento(t, {
      acao: 'contato.atualizado',
      entidade: 'contato',
      entidadeId: contato.id,
      resumo: 'Contato "Titular" ganhou responsável (R4.5)',
      usuario: admin,
    });

    const lista = await listar(
      comoAdmin,
      `entidade=contato&entidadeId=${contato.id}`,
    );
    expect(lista.itens.map(({ resumo }) => resumo)).toEqual([
      'Contato "Titular" ganhou responsável',
      'Contato anonimizado pelo Admin (LGPD)',
    ]);
    const detalhe = await comoAdmin
      .get(`/api/v1/auditoria/${antigo.id.toString()}`)
      .expect(200);
    expect(detalhe.body.resumo).toBe('Contato anonimizado pelo Admin (LGPD)');
    const linha = await comoAdmin
      .get(`/api/v1/contatos/${contato.id}/linha-do-tempo`)
      .expect(200);
    const resumos = (
      linha.body.itens as { evento: { resumo: string } | null }[]
    )
      .map((item) => item.evento?.resumo)
      .filter((resumo): resumo is string => resumo !== undefined);
    expect(resumos).toEqual(
      expect.arrayContaining([
        'Contato anonimizado pelo Admin (LGPD)',
        'Contato "Titular" ganhou responsável',
      ]),
    );
    expect(resumos.filter((resumo) => /\bR\d+\.\d+/.test(resumo))).toEqual([]);
    // O registro em si não muda (a auditoria é só inclusão).
    expect(
      (
        await t.prisma.eventoAuditoria.findUniqueOrThrow({
          where: { id: antigo.id },
        })
      ).resumo,
    ).toBe('Contato anonimizado pelo Admin (LGPD, R4.6)');
  });

  it('R3.4 — detalhe: id inexistente → 404; id inválido → 400', async () => {
    const { cliente } = await adminLogado();
    const inexistente = await cliente
      .get('/api/v1/auditoria/999999')
      .expect(404);
    expect(inexistente.body).toMatchObject({
      erro: 'nao_encontrado',
      mensagem: 'Evento de auditoria não encontrado.',
    });
    for (const invalido of ['abc', '0', '-1', '1.5', '99999999999999999999']) {
      const resposta = await cliente
        .get(`/api/v1/auditoria/${invalido}`)
        .expect(400);
      expect(resposta.body.detalhes.campos[0].campo).toBe('id');
    }
  });

  it('R3.2 — login, falha de login e logout aparecem na consulta, com IP e user agent', async () => {
    const { cliente } = await adminLogado();
    const carla = await criarUsuario(t, {
      papel: 'CS',
      nome: 'Carla',
      email: 'carla@teste.local',
    });
    const entrar = (senha: string) =>
      clienteAnonimo(t)
        .post('/api/v1/auth/entrar', { email: 'carla@teste.local', senha })
        .set('X-Forwarded-For', '203.0.113.7')
        .set('User-Agent', 'navegador-de-teste/1.0');
    await entrar('senha-errada').expect(401);
    const login = await entrar(SENHA_DE_TESTE).expect(200);
    await request(t.servidor)
      .post('/api/v1/auth/sair')
      .set('Origin', ORIGEM_DE_TESTE)
      .set('Cookie', cookieDaSessao(login) ?? '')
      .expect(204);

    const falhas = await listar(cliente, 'acao=usuario.login_falhou');
    expect(falhas.itens).toHaveLength(1);
    expect(falhas.itens[0]).toMatchObject({
      entidade: 'usuario',
      entidadeId: carla.id,
      resumo: 'Falha de login para carla@teste.local',
    });
    const detalhe = await cliente
      .get(`/api/v1/auditoria/${falhas.itens[0].id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      ip: '203.0.113.7',
      userAgent: 'navegador-de-teste/1.0',
      dados: { email: 'carla@teste.local', motivo: 'SENHA_INCORRETA' },
    });
    expect(detalhe.text).not.toContain('senha-errada');

    const entradas = await listar(
      cliente,
      `acao=usuario.login&usuarioId=${carla.id}`,
    );
    expect(entradas.itens).toHaveLength(1);
    expect(entradas.itens[0]).toMatchObject({
      tipoAtor: 'USUARIO',
      usuarioId: carla.id,
      resumo: 'Carla entrou no CRM',
    });
    expect(entradas.itens[0]).toHaveProperty(
      'requisicaoId',
      login.headers['x-request-id'],
    );
    const saidas = await listar(cliente, 'acao=usuario.logout');
    expect(saidas.itens).toHaveLength(1);
    expect(saidas.itens[0]).toMatchObject({
      usuarioId: carla.id,
      resumo: 'Carla saiu do CRM',
    });
  });

  it('R3.4 — filtros disponíveis: ações e entidades já registradas, em ordem, e os tipos de ator', async () => {
    const { cliente } = await adminLogado();
    for (const [acao, entidade] of [
      ['usuario.login', 'usuario'],
      ['negocio.movido', 'negocio'],
      ['usuario.login', 'usuario'],
      ['contato.criado', 'contato'],
    ]) {
      await registrarEvento(t, { acao, entidade, resumo: acao });
    }
    const resposta = await cliente.get('/api/v1/auditoria/filtros').expect(200);
    // Oráculo independente: DISTINCT do Prisma, na ordem do banco.
    const acoes = (
      await t.prisma.eventoAuditoria.findMany({
        distinct: ['acao'],
        select: { acao: true },
        orderBy: { acao: 'asc' },
      })
    ).map(({ acao }) => acao);
    const entidades = (
      await t.prisma.eventoAuditoria.findMany({
        distinct: ['entidade'],
        select: { entidade: true },
        orderBy: { entidade: 'asc' },
      })
    ).map(({ entidade }) => entidade);
    expect(resposta.body).toEqual({
      acoes,
      entidades,
      tiposAtor: ['USUARIO', 'SISTEMA', 'WEBHOOK', 'AUTOMACAO', 'IA'],
    });
    expect(acoes).toEqual(
      expect.arrayContaining([
        'contato.criado',
        'negocio.movido',
        'usuario.login',
      ]),
    );
    expect(entidades).toEqual(
      expect.arrayContaining(['contato', 'negocio', 'usuario']),
    );
    expect(acoes.filter((acao) => acao === 'usuario.login')).toHaveLength(1);
  });

  it('R3.3 — não há rota de edição nem de exclusão da auditoria', async () => {
    const { cliente } = await adminLogado();
    const evento = await registrarEvento(t, {
      acao: 'teste.imutavel',
      entidade: 'teste',
      resumo: 'Original',
    });
    const rota = `/api/v1/auditoria/${evento.id.toString()}`;
    for (const pedir of [
      () => cliente.put(rota, { resumo: 'x' }),
      () => cliente.patch(rota, { resumo: 'x' }),
      () => cliente.delete(rota),
      () => cliente.post('/api/v1/auditoria', { resumo: 'x' }),
    ]) {
      const resposta = await pedir().expect(404);
      expect(resposta.body.erro).toBe('nao_encontrado');
    }
    const depois = await t.prisma.eventoAuditoria.findUniqueOrThrow({
      where: { id: evento.id },
    });
    expect(depois.resumo).toBe('Original');
    expect(await t.prisma.eventoAuditoria.count()).toBe(iniciais + 1);
  });

  it('documentação: as rotas da consulta estão no Swagger', async () => {
    const documento = await clienteAnonimo(t).get('/api/docs-json').expect(200);
    const caminhos = documento.body.paths as Record<
      string,
      Record<string, { tags?: string[] }>
    >;
    expect(Object.keys(caminhos)).toEqual(
      expect.arrayContaining([
        '/api/v1/auditoria',
        '/api/v1/auditoria/filtros',
        '/api/v1/auditoria/{id}',
      ]),
    );
    expect(caminhos['/api/v1/auditoria'].get.tags).toEqual(['Auditoria']);
    expect(Object.keys(caminhos['/api/v1/auditoria/{id}'])).toEqual(['get']);
  });
});
