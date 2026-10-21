import { executarComoAtor } from '../src/comum/contexto/contexto-requisicao';
import { ContatosService } from '../src/contatos/contatos.service';
import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarEmpresa,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  processarEventos,
} from './utils';

interface ContatoDaApi {
  id: string;
  nome: string;
  criado?: boolean;
}

const nomesDe = (corpo: { itens: ContatoDaApi[] }) =>
  corpo.itens.map((contato) => contato.nome);

describe('Contatos (e2e)', () => {
  let t: AppTeste;
  let contatos: ContatosService;

  beforeAll(async () => {
    t = await criarAppTeste();
    contatos = t.get(ContatosService);
  });

  beforeEach(() => t.limparBanco());

  afterAll(() => t.fechar());

  const comoWebhook = <T>(fn: () => Promise<T>) =>
    executarComoAtor({ tipoAtor: 'WEBHOOK', descricao: 'Webhook Landing' }, fn);

  describe('criação e validação (R4.1, R4.5)', () => {
    it('R4.1 — cria com e-mail em minúsculas e telefone em E.164; R4.5 — o responsável padrão é quem criou', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'COMERCIAL');
      const cliente = await entrarComo(t, ana);
      const resposta = await cliente
        .post('/api/v1/contatos', {
          nome: '  Maria   Souza ',
          email: ' Maria.Souza@EMPRESA.com.br ',
          telefone: '(11) 98765-4321',
          cargo: 'Diretora',
          etiquetas: ['VIP', ' vip ', 'Evento'],
        })
        .expect(201);
      expect(resposta.body.criado).toBe(true);
      expect(resposta.body.contato).toMatchObject({
        nome: 'Maria Souza',
        email: 'maria.souza@empresa.com.br',
        telefone: '5511987654321',
        cargo: 'Diretora',
        responsavel: { id: ana.id, nome: ana.nome, ativo: true },
        criadoPor: { id: ana.id },
        primeiraOrigem: { tipo: 'MANUAL', detalhe: null, utm: null },
        ultimaOrigem: { tipo: 'MANUAL', detalhe: null, utm: null },
        conversoes: 1,
        etiquetas: ['VIP', 'Evento'],
        optOutMarketing: false,
        consentimento: null,
        podeEditar: true,
      });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.criado' },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: ana.id,
        entidade: 'contato',
        entidadeId: resposta.body.contato.id,
        resumo: 'Contato "Maria Souza" criado por cadastro manual',
      });
      expect(auditoria.dados).toMatchObject({
        alteracoes: {
          email: { antes: null, depois: 'maria.souza@empresa.com.br' },
          telefone: { antes: null, depois: '5511987654321' },
        },
      });
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'contato.criado' },
      });
      expect(evento.dados).toMatchObject({
        contatoId: resposta.body.contato.id,
        email: 'maria.souza@empresa.com.br',
        responsavelId: ana.id,
      });
      // Sem notificação: quem criou é o próprio responsável.
      expect(await t.prisma.notificacao.count()).toBe(0);
    });

    it('R4.1 — sem e-mail e sem telefone devolve 400 com a regra; formatos inválidos, por campo', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const semMeio = await admin
        .post('/api/v1/contatos', { nome: 'Sem contato' })
        .expect(400);
      expect(semMeio.body).toMatchObject({
        erro: 'dados_invalidos',
        mensagem: 'O contato precisa de e-mail ou telefone (R4.1).',
        detalhes: { regra: 'R4.1' },
      });
      expect(
        semMeio.body.detalhes.campos.map(
          (campo: { campo: string }) => campo.campo,
        ),
      ).toEqual(['email', 'telefone']);

      const invalidos = await admin
        .post('/api/v1/contatos', {
          nome: 'X',
          email: 'nao-e-email',
          telefone: '(20) 98765-4321',
        })
        .expect(400);
      expect(invalidos.body.detalhes.campos).toEqual(
        expect.arrayContaining([
          { campo: 'email', mensagens: ['deve ser um e-mail válido'] },
          {
            campo: 'telefone',
            mensagens: ['deve ser um telefone válido (DDD 20 não existe)'],
          },
        ]),
      );
      const semNome = await admin
        .post('/api/v1/contatos', { nome: '   ', email: 'a@b.com' })
        .expect(400);
      expect(semNome.body.detalhes.campos).toEqual([
        { campo: 'nome', mensagens: ['é obrigatório'] },
      ]);
      expect(await t.prisma.contato.count()).toBe(0);
    });

    it('lista branca: campo desconhecido é recusado; origens do sistema não entram pela criação manual', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const intruso = await admin
        .post('/api/v1/contatos', { nome: 'X', email: 'x@y.com', intruso: 1 })
        .expect(400);
      expect(intruso.body.detalhes.campos).toContainEqual({
        campo: 'intruso',
        mensagens: ['não é um campo aceito'],
      });
      const origem = await admin
        .post('/api/v1/contatos', {
          nome: 'X',
          email: 'x@y.com',
          origem: 'WEBHOOK',
        })
        .expect(400);
      expect(origem.body.detalhes.campos[0].campo).toBe('origem');
      const utm = await admin
        .post('/api/v1/contatos', {
          nome: 'X',
          email: 'x@y.com',
          utm: { utm_source: 'google' },
        })
        .expect(400);
      expect(utm.body.detalhes.campos[0].campo).toBe('utm.utm_source');
    });
  });

  describe('deduplicação (R4.2, R4.3)', () => {
    it('R4.2 — mesmo e-mail (em outra caixa) não duplica: completa os vazios, não sobrescreve e registra a reconversão', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const existente = await criarContato(t, {
        nome: 'Maria Souza',
        email: 'maria@x.com',
        responsavel: ana,
        etiquetas: ['VIP'],
      });
      await t.prisma.contato.update({
        where: { id: existente.id },
        data: { cargo: 'CEO' },
      });
      const cliente = await entrarComo(t, bruno);
      const resposta = await cliente
        .post('/api/v1/contatos', {
          nome: 'Maria S.',
          email: 'MARIA@X.com',
          telefone: '11 98765-4321',
          cargo: 'Estagiária',
          etiquetas: ['vip', 'Evento'],
          origem: 'INDICACAO',
          origemDetalhe: 'Indicação da ACME',
          utm: { source: 'parceiro' },
          camposPersonalizados: { faturamento: '1 mi' },
        })
        .expect(201);
      expect(resposta.body.criado).toBe(false);
      expect(resposta.body.contato).toMatchObject({
        id: existente.id,
        nome: 'Maria Souza',
        cargo: 'CEO',
        telefone: '5511987654321',
        etiquetas: ['VIP', 'Evento'],
        responsavel: { id: ana.id },
        conversoes: 2,
        primeiraOrigem: { tipo: 'MANUAL', detalhe: null, utm: null },
        ultimaOrigem: {
          tipo: 'INDICACAO',
          detalhe: 'Indicação da ACME',
          utm: { source: 'parceiro' },
        },
        camposPersonalizados: { faturamento: '1 mi' },
        podeEditar: false,
      });
      expect(await t.prisma.contato.count()).toBe(1);
      const reconversao = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.reconvertido' },
      });
      expect(reconversao).toMatchObject({
        usuarioId: bruno.id,
        entidadeId: existente.id,
        resumo:
          'Contato "Maria Souza" reconvertido por indicação (Indicação da ACME)',
      });
      expect(reconversao.dados).toMatchObject({
        conversoes: 2,
        camposCompletados: [
          'telefone',
          'etiquetas',
          'camposPersonalizados.faturamento',
        ],
        origem: { tipo: 'INDICACAO', detalhe: 'Indicação da ACME' },
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'contato.criado' },
        }),
      ).toBe(0);
      const tipos = (await t.prisma.eventoDominio.findMany()).map(
        (evento) => evento.tipo,
      );
      expect(tipos.sort()).toEqual([
        'contato.atualizado',
        'contato.reconvertido',
      ]);
      // Os eventos chegam aos manipuladores (outbox → fila → manipuladores).
      expect(await processarEventos(t)).toBeGreaterThanOrEqual(2);
    });

    it('R4.2 — mesmo telefone em outro formato também reconverte', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const fixo = await criarContato(t, {
        email: null,
        telefone: '(21) 3333-4444',
      });
      const resposta = await admin
        .post('/api/v1/contatos', {
          nome: 'Fixo',
          telefone: '+55 21 3333-4444',
          email: 'fixo@x.com',
        })
        .expect(201);
      expect(resposta.body).toMatchObject({
        criado: false,
        contato: {
          id: fixo.id,
          telefone: '552133334444',
          email: 'fixo@x.com',
          conversoes: 2,
        },
      });
      expect(await t.prisma.contato.count()).toBe(1);
    });

    it('R4.2 — duas criações simultâneas com o mesmo e-mail geram um contato só', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const [clienteAna, clienteBruno] = await Promise.all([
        entrarComo(t, ana),
        entrarComo(t, bruno),
      ]);
      const respostas = await Promise.all([
        clienteAna.post('/api/v1/contatos', {
          nome: 'Maria',
          email: 'maria@x.com',
        }),
        clienteBruno.post('/api/v1/contatos', {
          nome: 'Maria S.',
          email: 'MARIA@x.com',
          telefone: '11 98765-4321',
        }),
        clienteAna.post('/api/v1/contatos', {
          nome: 'Maria Souza',
          email: ' maria@X.com ',
        }),
      ]);
      expect(respostas.map((resposta) => resposta.status)).toEqual([
        201, 201, 201,
      ]);
      expect(
        respostas.filter((resposta) => resposta.body.criado === true),
      ).toHaveLength(1);
      expect(
        new Set(respostas.map((resposta) => resposta.body.contato.id)).size,
      ).toBe(1);
      expect(await t.prisma.contato.count()).toBe(1);
      const contato = await t.prisma.contato.findFirstOrThrow();
      expect(contato).toMatchObject({
        email: 'maria@x.com',
        telefone: '5511987654321',
        conversoes: 3,
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'contato.criado' },
        }),
      ).toBe(1);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'contato.reconvertido' },
        }),
      ).toBe(2);
    });

    it('R4.2 — encontrarOuCriar em paralelo (webhooks) cria um contato e reconverte os demais', async () => {
      const resultados = await Promise.all(
        Array.from({ length: 6 }, (_valor, indice) =>
          comoWebhook(() =>
            t.prisma.$transaction((tx) =>
              contatos.encontrarOuCriar(tx, {
                nome: `Lead ${indice}`,
                email: 'Lead@X.com',
                telefone: indice % 2 === 1 ? '11 98765-4321' : undefined,
                origem: 'WEBHOOK',
                origemDetalhe: 'Webhook Landing',
              }),
            ),
          ),
        ),
      );
      expect(resultados.filter(({ criado }) => criado)).toHaveLength(1);
      expect(new Set(resultados.map(({ contato }) => contato.id)).size).toBe(1);
      expect(await t.prisma.contato.count()).toBe(1);
      expect(await t.prisma.contato.findFirstOrThrow()).toMatchObject({
        email: 'lead@x.com',
        telefone: '5511987654321',
        conversoes: 6,
      });
    });

    it('R4.3 — a primeira origem não muda; a última, com UTM, muda a cada reconversão', async () => {
      const { contato } = await comoWebhook(() =>
        t.prisma.$transaction((tx) =>
          contatos.encontrarOuCriar(tx, {
            nome: 'Lead',
            email: 'lead@x.com',
            origem: 'WEBHOOK',
            origemDetalhe: 'Landing A',
            utm: { source: 'google', medium: 'cpc' },
          }),
        ),
      );
      await t.prisma.$transaction((tx) =>
        contatos.encontrarOuCriar(tx, {
          nome: 'Lead',
          email: 'lead@x.com',
          origem: 'SITE',
          origemDetalhe: 'Formulário',
          utm: { source: 'instagram' },
        }),
      );
      const admin = await entrarComo(t, await criarUsuario(t));
      const detalhe = await admin
        .get(`/api/v1/contatos/${contato.id}`)
        .expect(200);
      expect(detalhe.body).toMatchObject({
        primeiraOrigem: {
          tipo: 'WEBHOOK',
          detalhe: 'Landing A',
          utm: { source: 'google', medium: 'cpc' },
        },
        ultimaOrigem: {
          tipo: 'SITE',
          detalhe: 'Formulário',
          utm: { source: 'instagram' },
        },
        conversoes: 2,
      });
      expect(Date.parse(detalhe.body.ultimaOrigem.em)).toBeGreaterThan(
        contato.ultimaOrigemEm.getTime(),
      );
      // O banco também protege a primeira origem (gatilho).
      await expect(
        t.prisma.contato.update({
          where: { id: contato.id },
          data: { primeiraOrigem: 'MANUAL' },
        }),
      ).rejects.toThrow(/imutável/);
    });

    it('R4.2/R4.5 — encontrarOuCriar como WEBHOOK: empresa pelo nome, responsável informado, auditoria do webhook e eventos', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t, 'MARKETING');
      const resultado = await comoWebhook(() =>
        t.prisma.$transaction((tx) =>
          contatos.encontrarOuCriar(tx, {
            nome: 'Lead Webhook',
            email: 'lead@x.com',
            telefone: 'não informado',
            empresaNome: '  ACME   Ltda ',
            cargo: 'CEO',
            origem: 'WEBHOOK',
            origemDetalhe: 'Webhook Landing',
            utm: { source: 'meta' },
            etiquetas: ['Black Friday'],
            camposPersonalizados: { faturamento: '50 mil' },
            responsavelId: ana.id,
          }),
        ),
      );
      expect(resultado.criado).toBe(true);
      expect(resultado.contato).toMatchObject({
        email: 'lead@x.com',
        telefone: null,
        responsavelId: ana.id,
        criadoPorId: null,
        primeiraOrigem: 'WEBHOOK',
        primeiraOrigemUtm: { source: 'meta' },
      });
      const empresa = await t.prisma.empresa.findFirstOrThrow();
      expect(empresa).toMatchObject({
        nome: 'ACME Ltda',
        responsavelId: ana.id,
      });
      expect(resultado.contato.empresaId).toBe(empresa.id);

      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: { in: ['empresa.criada', 'contato.criado'] } },
        orderBy: { id: 'asc' },
      });
      expect(
        auditoria.map((evento) => [
          evento.acao,
          evento.tipoAtor,
          evento.atorDescricao,
        ]),
      ).toEqual([
        ['empresa.criada', 'WEBHOOK', 'Webhook Landing'],
        ['contato.criado', 'WEBHOOK', 'Webhook Landing'],
      ]);
      // O telefone inválido foi descartado (modo tolerante) e ficou registrado.
      expect(auditoria[1].dados).toMatchObject({
        descartados: [{ campo: 'telefone' }],
      });
      expect(auditoria[1].relacionados).toEqual(
        expect.arrayContaining([
          `contato:${resultado.contato.id}`,
          `empresa:${empresa.id}`,
        ]),
      );

      // Outro lead com o mesmo nome de empresa reaproveita a empresa.
      const outro = await comoWebhook(() =>
        t.prisma.$transaction((tx) =>
          contatos.encontrarOuCriar(tx, {
            nome: 'Outro',
            email: 'outro@x.com',
            empresaNome: 'acme ltda',
            origem: 'WEBHOOK',
          }),
        ),
      );
      expect(outro.contato.empresaId).toBe(empresa.id);
      expect(await t.prisma.empresa.count()).toBe(1);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'contato.criado' },
        }),
      ).toBe(2);
      // Automação não gera a notificação de "contato atribuído".
      expect(await t.prisma.notificacao.count()).toBe(0);
    });

    it('R4.2 — e-mail de um contato e telefone de outro: reconverte pelo e-mail sem copiar o telefone alheio', async () => {
      const comEmail = await criarContato(t, { email: 'maria@x.com' });
      const comTelefone = await criarContato(t, {
        email: null,
        telefone: '11 98765-4321',
      });
      const { contato, criado } = await t.prisma.$transaction((tx) =>
        contatos.encontrarOuCriar(tx, {
          nome: 'Maria',
          email: 'maria@x.com',
          telefone: '(11) 98765-4321',
          origem: 'WEBHOOK',
        }),
      );
      expect(criado).toBe(false);
      expect(contato.id).toBe(comEmail.id);
      expect(contato.telefone).toBeNull();
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.reconvertido' },
      });
      expect(auditoria.dados).toMatchObject({
        deOutroContato: [{ campo: 'telefone', contatoId: comTelefone.id }],
      });
    });

    it('R4.2 — contato anonimizado não é encontrado: o mesmo e-mail cria um contato novo', async () => {
      const antigo = await criarContato(t, { email: 'maria@x.com' });
      const admin = await entrarComo(t, await criarUsuario(t));
      await admin
        .post(`/api/v1/contatos/${antigo.id}/anonimizar`, {})
        .expect(204);
      const { contato, criado } = await t.prisma.$transaction((tx) =>
        contatos.encontrarOuCriar(tx, {
          nome: 'Maria',
          email: 'maria@x.com',
          origem: 'WEBHOOK',
        }),
      );
      expect(criado).toBe(true);
      expect(contato.id).not.toBe(antigo.id);
    });

    it('R3.1 — se a transação de quem chama desfaz, o contato, a auditoria e o evento somem juntos', async () => {
      await expect(
        t.prisma.$transaction(async (tx) => {
          await contatos.encontrarOuCriar(tx, {
            nome: 'X',
            email: 'x@x.com',
            origem: 'WEBHOOK',
          });
          throw new Error('falha depois');
        }),
      ).rejects.toThrow('falha depois');
      expect(await t.prisma.contato.count()).toBe(0);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { entidade: 'contato' },
        }),
      ).toBe(0);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'contato.criado' },
        }),
      ).toBe(0);
    });

    it('R4.5 — definirResponsavelSeVazio dá ao contato e à empresa sem responsável o do negócio, sem sobrescrever', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const empresa = await criarEmpresa(t);
      const contato = await criarContato(t, { empresa });
      await t.prisma.$transaction((tx) =>
        contatos.definirResponsavelSeVazio(tx, contato.id, ana.id),
      );
      await t.prisma.$transaction((tx) =>
        contatos.definirResponsavelSeVazio(tx, contato.id, bruno.id),
      );
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contato.id },
          })
        ).responsavelId,
      ).toBe(ana.id);
      expect(
        (
          await t.prisma.empresa.findUniqueOrThrow({
            where: { id: empresa.id },
          })
        ).responsavelId,
      ).toBe(ana.id);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: { in: ['contato.atualizado', 'empresa.atualizada'] } },
        }),
      ).toBe(2);
    });
  });

  describe('listagem (busca, filtros e paginação)', () => {
    it('busca por nome, e-mail e telefone em qualquer formato', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      await criarContato(t, { nome: 'Maria Souza', email: 'maria@gmail.com' });
      await criarContato(t, {
        nome: 'João Silva',
        email: 'joao@empresa.com',
        telefone: '(11) 98765-4321',
      });
      await criarContato(t, { nome: 'Ana Maria Lima', email: 'ana@outra.com' });
      const buscar = async (busca: string) =>
        nomesDe(
          (
            await admin
              .get('/api/v1/contatos')
              .query({ busca, ordenarPor: 'nome' })
              .expect(200)
          ).body,
        );
      expect(await buscar('maria')).toEqual(['Ana Maria Lima', 'Maria Souza']);
      expect(await buscar('MARIA gmail')).toEqual(['Maria Souza']);
      expect(await buscar('EMPRESA.COM')).toEqual(['João Silva']);
      expect(await buscar('(11) 98765-4321')).toEqual(['João Silva']);
      expect(await buscar('+55 11 98765')).toEqual(['João Silva']);
      // Curingas do LIKE são literais.
      expect(await buscar('%')).toEqual([]);
      expect(await buscar('_')).toEqual([]);
    });

    it('filtra por responsável, origem, etiqueta (sem diferenciar maiúsculas) e opt-out, com paginação', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const admin = await entrarComo(t, await criarUsuario(t));
      await criarContato(t, {
        nome: 'A1',
        responsavel: ana,
        etiquetas: ['VIP'],
        origem: 'WEBHOOK',
      });
      await criarContato(t, {
        nome: 'A2',
        responsavel: ana,
        etiquetas: ['vip', 'Evento'],
      });
      const b1 = await criarContato(t, {
        nome: 'B1',
        responsavel: bruno,
        origem: 'WEBHOOK',
      });
      await t.prisma.contato.update({
        where: { id: b1.id },
        data: { optOutMarketing: true, optOutEm: new Date() },
      });
      await criarContato(t, { nome: 'Sem dono' });
      const filtrar = async (query: Record<string, string>) =>
        nomesDe(
          (
            await admin
              .get('/api/v1/contatos')
              .query({ ordenarPor: 'nome', ...query })
              .expect(200)
          ).body,
        );
      expect(await filtrar({ responsavelId: ana.id })).toEqual(['A1', 'A2']);
      expect(await filtrar({ semResponsavel: 'true' })).toEqual(['Sem dono']);
      expect(await filtrar({ origem: 'WEBHOOK' })).toEqual(['A1', 'B1']);
      expect(await filtrar({ etiqueta: 'VIP' })).toEqual(['A1', 'A2']);
      expect(await filtrar({ etiqueta: 'evento' })).toEqual(['A2']);
      expect(await filtrar({ etiqueta: 'inexistente' })).toEqual([]);
      expect(await filtrar({ optOut: 'true' })).toEqual(['B1']);
      expect(await filtrar({ optOut: 'false' })).toEqual([
        'A1',
        'A2',
        'Sem dono',
      ]);

      const pagina = await admin
        .get('/api/v1/contatos')
        .query({ porPagina: 2, pagina: 2, ordenarPor: 'nome' })
        .expect(200);
      expect(pagina.body).toMatchObject({ total: 4, pagina: 2, porPagina: 2 });
      expect(nomesDe(pagina.body)).toEqual(['B1', 'Sem dono']);
      await admin.get('/api/v1/contatos').query({ porPagina: 101 }).expect(400);
      await admin
        .get('/api/v1/contatos')
        .query({ responsavelId: ana.id, semResponsavel: 'true' })
        .expect(400);
      await admin.get('/api/v1/contatos').query({ origem: 'FAX' }).expect(400);
    });

    it('R4.7 — GET /contatos/etiquetas lista as etiquetas em uso, com a grafia mais comum', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      await criarContato(t, { etiquetas: ['VIP', 'Evento'] });
      await criarContato(t, { etiquetas: ['vip'] });
      await criarContato(t, { etiquetas: ['VIP'] });
      const todas = await admin.get('/api/v1/contatos/etiquetas').expect(200);
      expect(todas.body).toEqual([
        { etiqueta: 'VIP', quantidade: 3 },
        { etiqueta: 'Evento', quantidade: 1 },
      ]);
      const filtradas = await admin
        .get('/api/v1/contatos/etiquetas')
        .query({ busca: 'ev' })
        .expect(200);
      expect(filtradas.body).toEqual([{ etiqueta: 'Evento', quantidade: 1 }]);
    });
  });

  describe('edição e permissões (§12, R4.5)', () => {
    it('§12 — membro edita os seus e recebe 403 nos dos outros; todos veem todos', async () => {
      const {
        membros: [ana, bruno],
      } = await criarEquipe(t, 'COMERCIAL');
      const daAna = await criarContato(t, { responsavel: ana });
      const doBruno = await criarContato(t, { responsavel: bruno });
      const cliente = await entrarComo(t, ana);
      await cliente
        .patch(`/api/v1/contatos/${daAna.id}`, { cargo: 'CEO' })
        .expect(200);
      const negado = await cliente
        .patch(`/api/v1/contatos/${doBruno.id}`, { cargo: 'CEO' })
        .expect(403);
      expect(negado.body).toMatchObject({
        erro: 'sem_permissao',
        mensagem: 'Você só edita contatos dos quais é o responsável.',
      });
      const visto = await cliente
        .get(`/api/v1/contatos/${doBruno.id}`)
        .expect(200);
      expect(visto.body.podeEditar).toBe(false);
      const lista = await cliente.get('/api/v1/contatos').expect(200);
      expect(lista.body.total).toBe(2);
    });

    it('§12 — líder edita os da equipe (e os seus), não os de outra equipe; C-level edita qualquer um', async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      const marketing = await criarEquipe(t, 'MARKETING', {
        cLevel: comercial.cLevel,
      });
      const doMembro = await criarContato(t, {
        responsavel: comercial.membros[0],
      });
      const doLider = await criarContato(t, { responsavel: comercial.lider });
      const deOutraEquipe = await criarContato(t, {
        responsavel: marketing.membros[0],
      });
      const semResponsavel = await criarContato(t);
      const lider = await entrarComo(t, comercial.lider);
      await lider
        .patch(`/api/v1/contatos/${doMembro.id}`, { cargo: 'X' })
        .expect(200);
      await lider
        .patch(`/api/v1/contatos/${doLider.id}`, { cargo: 'X' })
        .expect(200);
      await lider
        .patch(`/api/v1/contatos/${deOutraEquipe.id}`, { cargo: 'X' })
        .expect(403);
      await lider
        .patch(`/api/v1/contatos/${semResponsavel.id}`, { cargo: 'X' })
        .expect(403);
      const cLevel = await entrarComo(t, comercial.cLevel);
      await cLevel
        .patch(`/api/v1/contatos/${deOutraEquipe.id}`, { cargo: 'Y' })
        .expect(200);
      await cLevel
        .patch(`/api/v1/contatos/${semResponsavel.id}`, { cargo: 'Y' })
        .expect(200);
    });

    it('R4.5 — responsável precisa ser ativo; membro só atribui a si; líder atribui na equipe e o novo responsável é notificado', async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      const [ana, bruno] = comercial.membros;
      const desligado = await criarUsuario(t, {
        papel: 'COMERCIAL',
        lider: comercial.lider,
        ativo: false,
      });
      const contato = await criarContato(t, { responsavel: ana });
      const clienteAna = await entrarComo(t, ana);
      const paraOutro = await clienteAna
        .patch(`/api/v1/contatos/${contato.id}`, { responsavelId: bruno.id })
        .expect(403);
      expect(paraOutro.body.mensagem).toBe(
        'Você só pode atribuir o contato a você mesmo.',
      );
      await clienteAna
        .post('/api/v1/contatos', {
          nome: 'X',
          email: 'x@x.com',
          responsavelId: bruno.id,
        })
        .expect(403);

      const lider = await entrarComo(t, comercial.lider);
      const inativo = await lider
        .patch(`/api/v1/contatos/${contato.id}`, {
          responsavelId: desligado.id,
        })
        .expect(422);
      expect(inativo.body).toMatchObject({
        erro: 'regra_violada',
        detalhes: { regra: 'R4.5' },
      });
      const transferido = await lider
        .patch(`/api/v1/contatos/${contato.id}`, { responsavelId: bruno.id })
        .expect(200);
      expect(transferido.body.responsavel.id).toBe(bruno.id);
      const notificacao = await t.prisma.notificacao.findFirstOrThrow({
        where: { usuarioId: bruno.id },
      });
      expect(notificacao).toMatchObject({
        tipo: 'contato.atribuido',
        link: `/contatos/${contato.id}`,
      });
      const deFora = await criarUsuario(t, { papel: 'MARKETING' });
      await lider
        .patch(`/api/v1/contatos/${contato.id}`, { responsavelId: deFora.id })
        .expect(403);
      const admin = await entrarComo(t, await criarUsuario(t));
      await admin
        .post('/api/v1/contatos', {
          nome: 'Y',
          email: 'y@y.com',
          responsavelId: desligado.id,
        })
        .expect(422);
    });

    it('R4.2 — e-mail ou telefone de outro contato ativo na edição devolve 409 com o id dele', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const maria = await criarContato(t, {
        email: 'maria@x.com',
        telefone: '11 98765-4321',
      });
      const outro = await criarContato(t, { email: 'outro@x.com' });
      const email = await admin
        .patch(`/api/v1/contatos/${outro.id}`, { email: 'MARIA@x.com' })
        .expect(409);
      expect(email.body).toMatchObject({
        erro: 'conflito',
        detalhes: { campos: ['email'], contatoId: maria.id },
      });
      const telefone = await admin
        .patch(`/api/v1/contatos/${outro.id}`, {
          telefone: '+55 11 98765-4321',
        })
        .expect(409);
      expect(telefone.body.detalhes).toMatchObject({
        campos: ['telefone'],
        contatoId: maria.id,
      });
    });

    it('R4.1 — a edição não tira o último meio de contato', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const contato = await criarContato(t, { email: 'so@email.com' });
      const semMeio = await admin
        .patch(`/api/v1/contatos/${contato.id}`, { email: null })
        .expect(400);
      expect(semMeio.body.detalhes.regra).toBe('R4.1');
      const trocado = await admin
        .patch(`/api/v1/contatos/${contato.id}`, {
          email: '',
          telefone: '11 3333-4444',
        })
        .expect(200);
      expect(trocado.body).toMatchObject({
        email: null,
        telefone: '551133334444',
      });
      await admin
        .patch(`/api/v1/contatos/${contato.id}`, { nome: null })
        .expect(400);
      await admin
        .patch(`/api/v1/contatos/${contato.id}`, { primeiraOrigem: 'SITE' })
        .expect(400);
    });

    it('R4.7 — etiquetas normalizadas e campos personalizados mesclados; auditoria com antes/depois e evento contato.atualizado', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const contato = await criarContato(t, { etiquetas: ['Antiga'] });
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { camposPersonalizados: { a: 1, b: 2 } },
      });
      const resposta = await admin
        .patch(`/api/v1/contatos/${contato.id}`, {
          etiquetas: [' Nova ', 'nova', 'Outra'],
          camposPersonalizados: { b: null, c: 'x' },
        })
        .expect(200);
      expect(resposta.body.etiquetas).toEqual(['Nova', 'Outra']);
      expect(resposta.body.camposPersonalizados).toEqual({ a: 1, c: 'x' });
      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.atualizado' },
      });
      expect(auditoria.resumo).toBe(
        `Contato "${contato.nome}" atualizado: etiquetas, campos personalizados`,
      );
      expect(auditoria.dados).toEqual({
        alteracoes: {
          etiquetas: { antes: ['Antiga'], depois: ['Nova', 'Outra'] },
          camposPersonalizados: {
            antes: { a: 1, b: 2 },
            depois: { a: 1, c: 'x' },
          },
        },
      });
      const evento = await t.prisma.eventoDominio.findFirstOrThrow({
        where: { tipo: 'contato.atualizado' },
      });
      expect(evento.dados).toMatchObject({
        contatoId: contato.id,
        camposAlterados: ['etiquetas', 'camposPersonalizados'],
        motivo: 'edicao',
      });
    });

    it('edição sem mudança real não gera auditoria nem evento', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      const contato = await criarContato(t, { email: 'a@a.com' });
      await admin
        .patch(`/api/v1/contatos/${contato.id}`, {
          email: 'A@A.com',
          etiquetas: [],
        })
        .expect(200);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { entidade: 'contato' },
        }),
      ).toBe(0);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: { startsWith: 'contato.' } },
        }),
      ).toBe(0);
    });

    it('contato inexistente e id inválido', async () => {
      const admin = await entrarComo(t, await criarUsuario(t));
      await admin
        .get('/api/v1/contatos/00000000-0000-4000-8000-000000000000')
        .expect(404);
      await admin.get('/api/v1/contatos/nao-e-uuid').expect(400);
      await admin
        .patch('/api/v1/contatos/00000000-0000-4000-8000-000000000000', {
          cargo: 'X',
        })
        .expect(404);
    });
  });

  describe('LGPD (R4.6)', () => {
    it('R4.6 — opt-out e consentimento guardam data e origem', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t);
      const cliente = await entrarComo(t, ana);
      const criado = await cliente
        .post('/api/v1/contatos', {
          nome: 'Maria',
          email: 'maria@x.com',
          consentimento: {
            origem: 'Formulário do site',
            em: '2026-10-01T10:00:00.000Z',
          },
        })
        .expect(201);
      expect(criado.body.contato.consentimento).toEqual({
        em: '2026-10-01T10:00:00.000Z',
        origem: 'Formulário do site',
      });
      const id = criado.body.contato.id as string;
      const optOut = await cliente
        .patch(`/api/v1/contatos/${id}`, { optOutMarketing: true })
        .expect(200);
      expect(optOut.body.optOutMarketing).toBe(true);
      expect(Date.parse(optOut.body.optOutEm)).toBeGreaterThan(
        Date.now() - 60_000,
      );
      const futuro = await cliente
        .patch(`/api/v1/contatos/${id}`, {
          consentimento: { origem: 'X', em: '2999-01-01T00:00:00Z' },
        })
        .expect(400);
      expect(futuro.body.detalhes.campos).toEqual([
        { campo: 'consentimento.em', mensagens: ['não pode ser no futuro'] },
      ]);
      const desfeito = await cliente
        .patch(`/api/v1/contatos/${id}`, {
          consentimento: null,
          optOutMarketing: false,
        })
        .expect(200);
      expect(desfeito.body).toMatchObject({
        consentimento: null,
        optOutMarketing: false,
        optOutEm: null,
      });
    });

    it('R4.6 — só o Admin anonimiza (C-level e membro recebem 403)', async () => {
      const {
        cLevel,
        membros: [ana],
      } = await criarEquipe(t);
      const contato = await criarContato(t, { responsavel: ana });
      for (const usuario of [cLevel, ana]) {
        const cliente = await entrarComo(t, usuario);
        const resposta = await cliente
          .post(`/api/v1/contatos/${contato.id}/anonimizar`, {})
          .expect(403);
        expect(resposta.body.erro).toBe('sem_permissao');
      }
      expect(
        (
          await t.prisma.contato.findUniqueOrThrow({
            where: { id: contato.id },
          })
        ).excluidoEm,
      ).toBeNull();
    });

    it('R4.6 — anonimização apaga os dados pessoais (também de negócios e atividades), some das listas, libera o e-mail e audita sem os dados', async () => {
      const {
        membros: [ana],
      } = await criarEquipe(t);
      const admin = await entrarComo(t, await criarUsuario(t));
      const empresa = await criarEmpresa(t, { nome: 'ACME' });
      const criado = (
        await admin
          .post('/api/v1/contatos', {
            nome: 'Maria Souza',
            email: 'maria@x.com',
            telefone: '11 98765-4321',
            cargo: 'CEO',
            empresaId: empresa.id,
            etiquetas: ['VIP'],
            camposPersonalizados: { cpf: '123.456.789-00' },
            origem: 'INDICACAO',
            origemDetalhe: 'Indicação do João',
            utm: { source: 'parceiro' },
            responsavelId: ana.id,
            consentimento: { origem: 'Evento' },
          })
          .expect(201)
      ).body.contato as ContatoDaApi;
      const negocio = await criarNegocio(t, {
        contato: criado.id,
        titulo: 'Maria Souza - Plano anual',
        responsavel: ana,
      });
      const { id: atividadeId } = await criarAtividade(t, {
        responsavel: ana,
        contato: criado.id,
        titulo: 'Ligar para Maria Souza',
      });
      const atividade = await t.prisma.atividade.update({
        where: { id: atividadeId },
        data: { descricao: 'Telefone 11987654321, e-mail maria@x.com' },
      });

      await admin
        .post(`/api/v1/contatos/${criado.id}/anonimizar`, {
          motivo: 'Pedido do titular',
        })
        .expect(204);

      const anonimizado = await t.prisma.contato.findUniqueOrThrow({
        where: { id: criado.id },
      });
      expect(anonimizado).toMatchObject({
        nome: 'Contato anonimizado',
        email: null,
        telefone: null,
        cargo: null,
        empresaId: null,
        etiquetas: [],
        camposPersonalizados: {},
        primeiraOrigem: 'INDICACAO',
        primeiraOrigemDetalhe: null,
        primeiraOrigemUtm: { source: 'parceiro' },
        ultimaOrigemDetalhe: null,
        optOutMarketing: true,
        consentimentoEm: null,
        consentimentoOrigem: null,
        responsavelId: ana.id,
      });
      expect(anonimizado.excluidoEm).not.toBeNull();
      expect(anonimizado.optOutEm).not.toBeNull();
      expect(
        (
          await t.prisma.negocio.findUniqueOrThrow({
            where: { id: negocio.id },
          })
        ).titulo,
      ).toBe('Contato anonimizado - Plano anual');
      expect(
        await t.prisma.atividade.findUniqueOrThrow({
          where: { id: atividade.id },
        }),
      ).toMatchObject({
        titulo: 'Ligar para Contato anonimizado',
        descricao: 'Telefone Contato anonimizado, e-mail Contato anonimizado',
      });

      await admin.get(`/api/v1/contatos/${criado.id}`).expect(404);
      await admin
        .get(`/api/v1/contatos/${criado.id}/linha-do-tempo`)
        .expect(404);
      expect((await admin.get('/api/v1/contatos').expect(200)).body.total).toBe(
        0,
      );
      // Sem corpo também vale (o motivo é opcional); já anonimizado, 404.
      await admin.post(`/api/v1/contatos/${criado.id}/anonimizar`).expect(404);

      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'contato.anonimizado' },
      });
      expect(auditoria).toMatchObject({
        usuarioId: admin.usuario?.id,
        resumo: 'Contato anonimizado pelo Admin (LGPD, R4.6)',
      });
      expect(auditoria.dados).toMatchObject({
        motivo: 'Pedido do titular',
        negociosAtualizados: 1,
        atividadesAtualizadas: 1,
      });
      expect(JSON.stringify(auditoria.dados)).not.toMatch(
        /Maria|maria@x\.com|98765|123\.456/,
      );
      expect(
        await t.prisma.eventoAuditoria.findMany({
          where: {
            acao: { in: ['negocio.atualizado', 'atividade.atualizada'] },
          },
          select: { acao: true, entidadeId: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual([
        { acao: 'negocio.atualizado', entidadeId: negocio.id },
        { acao: 'atividade.atualizada', entidadeId: atividade.id },
      ]);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'contato.anonimizado' },
        }),
      ).toBe(1);

      // O e-mail ficou livre: um contato novo nasce com ele.
      const novo = await admin
        .post('/api/v1/contatos', {
          nome: 'Maria de novo',
          email: 'maria@x.com',
        })
        .expect(201);
      expect(novo.body.criado).toBe(true);
    });
  });

  describe('documentação', () => {
    it('as rotas de contatos e empresas aparecem no OpenAPI, com os DTOs', async () => {
      const documento = await clienteAnonimo(t)
        .get('/api/docs-json')
        .expect(200);
      expect(Object.keys(documento.body.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/contatos',
          '/api/v1/contatos/etiquetas',
          '/api/v1/contatos/{id}',
          '/api/v1/contatos/{id}/anonimizar',
          '/api/v1/contatos/{id}/linha-do-tempo',
          '/api/v1/empresas',
          '/api/v1/empresas/etiquetas',
          '/api/v1/empresas/{id}',
          '/api/v1/empresas/{id}/linha-do-tempo',
        ]),
      );
      expect(Object.keys(documento.body.components.schemas)).toEqual(
        expect.arrayContaining([
          'ContatoDto',
          'CriarContatoDto',
          'AtualizarContatoDto',
          'ResultadoCriacaoContatoDto',
          'EmpresaDto',
          'RegistroDaLinhaDoTempoDto',
        ]),
      );
      expect(documento.body.paths['/api/v1/contatos'].post.tags).toEqual([
        'Contatos',
      ]);
    });
  });
});
