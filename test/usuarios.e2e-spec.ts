import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarAtividade,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  entrarComo,
  entrarPeloLogin,
  SENHA_DE_TESTE,
} from './utils';

const SENHA_TEMPORARIA = 'Temporaria@123';

describe('Usuários — gestão, hierarquia e visibilidade (e2e)', () => {
  let t: AppTeste;
  let admin: Usuario;
  let comoAdmin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    admin = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin Geral' });
    comoAdmin = await entrarComo(t, admin);
  });

  afterAll(async () => {
    await t.fechar();
  });

  describe('criação e hierarquia (R1.1, R1.2)', () => {
    it('cenário 2 — R1.2: hierarquia válida é aceita (C-level → líder → membro)', async () => {
      const cLevel = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Carla Diretora',
          email: 'carla@brl.com.br',
          papel: 'C_LEVEL',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(201);
      expect(cLevel.body).toMatchObject({
        usuario: {
          nome: 'Carla Diretora',
          papel: 'C_LEVEL',
          rotuloPapel: 'C-level',
          area: null,
          nivel: 'DIRETORIA',
          lider: null,
          ativo: true,
          deveTrocarSenha: true,
          senhaDefinida: true,
        },
        convite: null,
      });

      const lider = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Léo Líder',
          email: 'leo@brl.com.br',
          papel: 'LIDER',
          area: 'COMERCIAL',
          liderId: cLevel.body.usuario.id,
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(201);
      expect(lider.body.usuario).toMatchObject({
        papel: 'LIDER',
        rotuloPapel: 'Líder Comercial',
        area: 'COMERCIAL',
        nomeSetor: 'Comercial',
        nivel: 'LIDER',
        lider: { id: cLevel.body.usuario.id, papel: 'C_LEVEL' },
      });

      const membro = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Ana Vendas',
          email: 'ana@brl.com.br',
          papel: 'MEMBRO',
          area: 'comercial',
          liderId: lider.body.usuario.id,
          telefone: '(11) 98765-4321',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(201);
      expect(membro.body.usuario).toMatchObject({
        papel: 'MEMBRO',
        rotuloPapel: 'Comercial',
        area: 'COMERCIAL',
        nivel: 'MEMBRO',
        telefone: '5511987654321',
        lider: { id: lider.body.usuario.id, nome: 'Léo Líder' },
      });
      expect(membro.body.usuario).not.toHaveProperty('senhaHash');

      const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.criado', entidadeId: membro.body.usuario.id },
      });
      expect(auditoria).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: admin.id,
      });
      expect(JSON.stringify(auditoria.dados)).not.toContain(SENHA_TEMPORARIA);

      // A senha temporária vale e exige troca no primeiro acesso.
      const { resposta } = await entrarPeloLogin(
        t,
        'ana@brl.com.br',
        SENHA_TEMPORARIA,
      );
      expect(resposta.status).toBe(200);
      expect(resposta.body.deveTrocarSenha).toBe(true);
    });

    it('cenário 2 — R1.2: membro com líder de outro setor é recusado com mensagem clara', async () => {
      const { lider: liderDeMarketing } = await criarEquipe(t, 'MARKETING', {
        membros: 0,
      });
      const resposta = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Ana Vendas',
          email: 'ana@brl.com.br',
          papel: 'MEMBRO',
          area: 'COMERCIAL',
          liderId: liderDeMarketing.id,
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(resposta.body).toMatchObject({
        erro: 'regra_violada',
        mensagem: `O líder de quem é Comercial precisa ser um Líder Comercial ativo, do mesmo setor — ${liderDeMarketing.nome} é Líder Marketing, de outro setor.`,
        detalhes: {
          regra: 'R1.2',
          liderEsperado: { papel: 'LIDER', area: 'COMERCIAL' },
          papelDoLider: 'LIDER',
          areaDoLider: 'MARKETING',
        },
      });
      expect(
        await t.prisma.usuario.count({ where: { email: 'ana@brl.com.br' } }),
      ).toBe(0);
    });

    it('cenário 2 — R1.2: líder sem C-level é recusado com mensagem clara', async () => {
      const semLider = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Léo Líder',
          email: 'leo@brl.com.br',
          papel: 'LIDER',
          area: 'CS',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(semLider.body).toMatchObject({
        mensagem:
          'Quem é Líder Customer Success precisa de um C-level ativo como líder (o C-level responsável).',
        detalhes: {
          regra: 'R1.2',
          liderEsperado: { papel: 'C_LEVEL', area: null },
        },
      });

      const { lider: outroLider } = await criarEquipe(t, 'COMERCIAL', {
        membros: 0,
      });
      const comLiderErrado = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Léo Líder',
          email: 'leo@brl.com.br',
          papel: 'LIDER',
          area: 'CS',
          liderId: outroLider.id,
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(comLiderErrado.body.mensagem).toBe(
        `O líder de quem é Líder Customer Success precisa ser um C-level ativo — ${outroLider.nome} é Líder Comercial.`,
      );
    });

    it('R1.2 — Admin e C-level não têm líder; líder desligado ou inexistente não serve', async () => {
      const { cLevel, lider } = await criarEquipe(t, 'CS', { membros: 0 });
      const cLevelComLider = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Outro C',
          email: 'outro-c@brl.com.br',
          papel: 'C_LEVEL',
          liderId: cLevel.id,
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(cLevelComLider.body.mensagem).toBe(
        'Quem é C-level não tem líder: deixe o líder em branco.',
      );

      await t.prisma.usuario.update({
        where: { id: lider.id },
        data: { ativo: false, desligadoEm: new Date() },
      });
      const liderDesligado = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Cris CS',
          email: 'cris@brl.com.br',
          papel: 'MEMBRO',
          area: 'CS',
          liderId: lider.id,
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(liderDesligado.body.mensagem).toBe(
        `O líder escolhido, ${lider.nome}, foi desligado: o líder precisa estar ativo.`,
      );

      const inexistente = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Cris CS',
          email: 'cris@brl.com.br',
          papel: 'MEMBRO',
          area: 'CS',
          liderId: '00000000-0000-4000-8000-000000000000',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(inexistente.body.detalhes.regra).toBe('R1.2');
    });

    it('R1.1 — e-mail único sem diferença de maiúsculas, gravado aparado e em minúsculas', async () => {
      const criado = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: '  Bia Admin  ',
          email: '  Bia@BRL.com.BR ',
          papel: 'ADMIN',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(201);
      expect(criado.body.usuario).toMatchObject({
        nome: 'Bia Admin',
        email: 'bia@brl.com.br',
      });

      const repetido = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Outra Bia',
          email: 'BIA@brl.com.br',
          papel: 'ADMIN',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(409);
      expect(repetido.body).toMatchObject({
        erro: 'conflito',
        detalhes: { regra: 'R1.1', campos: ['email'] },
      });

      // Também na edição — e o e-mail de um desligado continua ocupado.
      const outro = await criarUsuario(t, { papel: 'C_LEVEL' });
      await comoAdmin
        .patch(`/api/v1/usuarios/${outro.id}`, { email: 'Bia@brl.com.br' })
        .expect(409);
      const desligado = await criarUsuario(t, {
        papel: 'C_LEVEL',
        email: 'saiu@brl.com.br',
        ativo: false,
      });
      const deDesligado = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Voltou',
          email: 'SAIU@brl.com.br',
          papel: 'C_LEVEL',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(409);
      expect(deDesligado.body).toMatchObject({
        mensagem:
          'Já existe um usuário desligado com este e-mail: reative-o em vez de criar outro.',
        detalhes: { usuarioId: desligado.id },
      });
    });

    it('valida a entrada (400 em português, lista branca)', async () => {
      const resposta = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: '',
          email: 'nao-e-email',
          papel: 'GERENTE',
          liderId: 'abc',
          extra: true,
        })
        .expect(400);
      expect(resposta.body.erro).toBe('dados_invalidos');
      expect(resposta.body.detalhes.campos).toEqual(
        expect.arrayContaining([
          { campo: 'nome', mensagens: ['é obrigatório'] },
          { campo: 'email', mensagens: ['deve ser um e-mail válido'] },
          {
            campo: 'papel',
            mensagens: [expect.stringContaining('deve ser um destes valores')],
          },
          {
            campo: 'liderId',
            mensagens: ['deve ser um identificador (UUID) válido'],
          },
          { campo: 'extra', mensagens: ['não é um campo aceito'] },
        ]),
      );

      const telefone = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Ana',
          email: 'ana@brl.com.br',
          papel: 'C_LEVEL',
          telefone: '(20) 98765-4321',
          senhaTemporaria: SENHA_TEMPORARIA,
        })
        .expect(400);
      expect(telefone.body.detalhes.campos).toEqual([
        { campo: 'telefone', mensagens: ['DDD 20 não existe.'] },
      ]);
      await comoAdmin.get('/api/v1/usuarios/nao-e-uuid').expect(400);
    });
  });

  describe('edição (R1.3, R1.4)', () => {
    it('R1.3 — líder com liderados não deixa de ser líder nem muda de setor: o erro lista quem precisa de novo líder', async () => {
      const { lider, membros } = await criarEquipe(t, 'COMERCIAL');
      const rebaixar = await comoAdmin
        .patch(`/api/v1/usuarios/${lider.id}`, { papel: 'MEMBRO' })
        .expect(422);
      expect(rebaixar.body).toMatchObject({
        erro: 'regra_violada',
        detalhes: {
          regra: 'R1.3',
          novoPapel: 'MEMBRO',
          novaArea: 'COMERCIAL',
          liderados: expect.arrayContaining(
            membros.map(({ id, nome }) => ({
              id,
              nome,
              papel: 'MEMBRO',
              area: 'COMERCIAL',
            })),
          ),
        },
      });
      expect(rebaixar.body.mensagem).toContain(
        '2 liderados que precisam de um novo líder',
      );
      for (const membro of membros) {
        expect(rebaixar.body.mensagem).toContain(membro.nome);
      }

      const mudarDeArea = await comoAdmin
        .patch(`/api/v1/usuarios/${lider.id}`, { area: 'MARKETING' })
        .expect(422);
      expect(mudarDeArea.body.detalhes.regra).toBe('R1.3');

      // Com os liderados em outro líder, a mudança passa.
      const { lider: outroLider } = await criarEquipe(t, 'COMERCIAL', {
        membros: 0,
      });
      for (const membro of membros) {
        await comoAdmin
          .patch(`/api/v1/usuarios/${membro.id}`, { liderId: outroLider.id })
          .expect(200);
      }
      const mudou = await comoAdmin
        .patch(`/api/v1/usuarios/${lider.id}`, {
          papel: 'MEMBRO',
          liderId: outroLider.id,
        })
        .expect(200);
      expect(mudou.body).toMatchObject({
        papel: 'MEMBRO',
        area: 'COMERCIAL',
        rotuloPapel: 'Comercial',
        lider: { id: outroLider.id },
      });
    });

    it('R1.3 — mudar o papel revalida o líder; Admin e C-level ficam sem líder', async () => {
      const { cLevel, membros } = await criarEquipe(t, 'COMERCIAL', {
        membros: 1,
      });
      const [membro] = membros;
      const semNovoLider = await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { area: 'MARKETING' })
        .expect(422);
      expect(semNovoLider.body.detalhes.regra).toBe('R1.2');
      // Setor que não existe: 422 (R1.9).
      const setorInexistente = await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { area: 'VENDAS' })
        .expect(422);
      expect(setorInexistente.body.detalhes).toMatchObject({
        regra: 'R1.9',
        campo: 'area',
      });

      const { lider: liderDeMarketing } = await criarEquipe(t, 'MARKETING', {
        membros: 0,
        cLevel,
      });
      const mudou = await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, {
          area: 'MARKETING',
          liderId: liderDeMarketing.id,
          nome: 'Nome Novo',
        })
        .expect(200);
      expect(mudou.body).toMatchObject({
        papel: 'MEMBRO',
        area: 'MARKETING',
        nome: 'Nome Novo',
        lider: { id: liderDeMarketing.id },
      });

      const promovido = await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { papel: 'C_LEVEL' })
        .expect(200);
      expect(promovido.body).toMatchObject({
        papel: 'C_LEVEL',
        area: null,
        lider: null,
      });

      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'usuario.atualizado', entidadeId: membro.id },
        orderBy: { id: 'asc' },
      });
      expect(auditoria).toHaveLength(2);
      expect(auditoria[0].dados).toMatchObject({
        alteracoes: {
          area: { antes: 'COMERCIAL', depois: 'MARKETING' },
          nome: { depois: 'Nome Novo' },
          liderId: { depois: liderDeMarketing.id },
        },
      });

      // Editar outros campos não revalida a hierarquia; sem mudança, sem auditoria.
      await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { telefone: null })
        .expect(200);
      await comoAdmin.patch(`/api/v1/usuarios/${membro.id}`, {}).expect(200);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'usuario.atualizado', entidadeId: membro.id },
        }),
      ).toBe(2);
      const nomeNulo = await comoAdmin
        .patch(`/api/v1/usuarios/${membro.id}`, { nome: null })
        .expect(400);
      expect(nomeNulo.body.detalhes.campos[0].campo).toBe('nome');
    });

    it('R1.4 — o último Admin ativo não é rebaixado nem desligado', async () => {
      const rebaixar = await comoAdmin
        .patch(`/api/v1/usuarios/${admin.id}`, { papel: 'C_LEVEL' })
        .expect(422);
      expect(rebaixar.body).toMatchObject({
        detalhes: { regra: 'R1.4' },
        mensagem: expect.stringContaining('último Admin ativo'),
      });
      const desligar = await comoAdmin
        .post(`/api/v1/usuarios/${admin.id}/desligar`, {})
        .expect(422);
      expect(desligar.body.detalhes.regra).toBe('R1.4');

      // Com outro Admin ativo, o rebaixamento passa.
      const outro = await criarUsuario(t, { papel: 'ADMIN' });
      await comoAdmin
        .patch(`/api/v1/usuarios/${outro.id}`, { papel: 'C_LEVEL' })
        .expect(200);
      await comoAdmin
        .patch(`/api/v1/usuarios/${admin.id}`, { papel: 'C_LEVEL' })
        .expect(422);
    });
  });

  describe('permissões e visibilidade (R1.5)', () => {
    it('R1.5 — só o Admin cria, edita, desliga, reativa e define senha', async () => {
      const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
        membros: 1,
      });
      const alvo = membros[0].id;
      for (const usuario of [cLevel, lider, membros[0]]) {
        const cliente = await entrarComo(t, usuario);
        // Criados um a um: o supertest abre e fecha o servidor a cada pedido.
        const pedidos = [
          () =>
            cliente.post('/api/v1/usuarios', {
              nome: 'X',
              email: 'x@brl.com.br',
              papel: 'C_LEVEL',
              senhaTemporaria: SENHA_TEMPORARIA,
            }),
          () => cliente.patch(`/api/v1/usuarios/${alvo}`, { nome: 'Outro' }),
          () =>
            cliente.post(`/api/v1/usuarios/${alvo}/senha-temporaria`, {
              senha: SENHA_TEMPORARIA,
            }),
          () => cliente.post(`/api/v1/usuarios/${alvo}/convite`),
          () => cliente.get(`/api/v1/usuarios/${alvo}/desligamento/previa`),
          () => cliente.post(`/api/v1/usuarios/${alvo}/desligar`, {}),
          () => cliente.post(`/api/v1/usuarios/${alvo}/reativar`, {}),
        ];
        for (const pedido of pedidos) {
          const resposta = await pedido().expect(403);
          expect(resposta.body.erro).toBe('sem_permissao');
        }
      }
      expect(
        (await t.prisma.usuario.findUniqueOrThrow({ where: { id: alvo } }))
          .ativo,
      ).toBe(true);
      await clienteAnonimo(t).get('/api/v1/usuarios').expect(401);
    });

    it('R1.5 — C-level vê todos; líder vê a própria equipe; membro vê a si mesmo', async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      const marketing = await criarEquipe(t, 'MARKETING', {
        membros: 1,
        cLevel: comercial.cLevel,
      });
      const total = await t.prisma.usuario.count();

      const comoCLevel = await entrarComo(t, comercial.cLevel);
      const todos = await comoCLevel
        .get('/api/v1/usuarios?porPagina=100')
        .expect(200);
      expect(todos.body.total).toBe(total);

      const comoLider = await entrarComo(t, comercial.lider);
      const equipe = await comoLider.get('/api/v1/usuarios').expect(200);
      expect(
        equipe.body.itens.map(({ id }: { id: string }) => id).sort(),
      ).toEqual(
        [comercial.lider.id, ...comercial.membros.map(({ id }) => id)].sort(),
      );
      await comoLider
        .get(`/api/v1/usuarios/${comercial.membros[0].id}`)
        .expect(200);
      await comoLider.get(`/api/v1/usuarios/${marketing.lider.id}`).expect(404);
      await comoLider
        .get(`/api/v1/usuarios/${comercial.cLevel.id}`)
        .expect(404);

      const comoMembro = await entrarComo(t, comercial.membros[0]);
      const proprio = await comoMembro.get('/api/v1/usuarios').expect(200);
      expect(proprio.body).toMatchObject({
        total: 1,
        itens: [{ id: comercial.membros[0].id }],
      });
      await comoMembro
        .get(`/api/v1/usuarios/${comercial.membros[1].id}`)
        .expect(404);
      const eu = await comoMembro
        .get(`/api/v1/usuarios/${comercial.membros[0].id}`)
        .expect(200);
      expect(eu.body.lider).toMatchObject({ id: comercial.lider.id });
    });

    it('lista com filtros e paginação', async () => {
      const { lider, membros } = await criarEquipe(t, 'CS', { membros: 3 });
      await criarEquipe(t, 'MARKETING', { membros: 1 });
      await t.prisma.usuario.update({
        where: { id: membros[2].id },
        data: { ativo: false, desligadoEm: new Date(), nome: 'Zeca Desligado' },
      });

      const daArea = await comoAdmin
        .get('/api/v1/usuarios?area=CS')
        .expect(200);
      expect(daArea.body.total).toBe(4);
      const ativosDoLider = await comoAdmin
        .get(`/api/v1/usuarios?liderId=${lider.id}&ativo=true`)
        .expect(200);
      expect(ativosDoLider.body.total).toBe(2);
      const busca = await comoAdmin
        .get('/api/v1/usuarios?busca=zeca')
        .expect(200);
      expect(busca.body.itens).toEqual([
        expect.objectContaining({ id: membros[2].id, ativo: false }),
      ]);
      const pagina = await comoAdmin
        .get('/api/v1/usuarios?papel=MEMBRO&area=cs&porPagina=2&pagina=2')
        .expect(200);
      expect(pagina.body).toMatchObject({ total: 3, pagina: 2, porPagina: 2 });
      expect(pagina.body.itens).toHaveLength(1);
      await comoAdmin.get('/api/v1/usuarios?ativo=talvez').expect(400);
    });
  });

  describe('senha temporária e convite (R2.8)', () => {
    it('R2.8 — senha temporária: encerra as sessões e exige troca no próximo acesso', async () => {
      const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
      const [membro] = membros;
      const sessaoAntiga = await entrarComo(t, membro);
      await sessaoAntiga.get('/api/v1/auth/eu').expect(200);

      const resposta = await comoAdmin
        .post(`/api/v1/usuarios/${membro.id}/senha-temporaria`, {
          senha: SENHA_TEMPORARIA,
        })
        .expect(200);
      expect(resposta.body).toMatchObject({
        id: membro.id,
        deveTrocarSenha: true,
      });
      await sessaoAntiga.get('/api/v1/auth/eu').expect(401);

      const antiga = await clienteAnonimo(t).post('/api/v1/auth/entrar', {
        email: membro.email,
        senha: SENHA_DE_TESTE,
      });
      expect(antiga.status).toBe(401);
      const { resposta: login, cliente } = await entrarPeloLogin(
        t,
        membro.email,
        SENHA_TEMPORARIA,
      );
      expect(login.body.deveTrocarSenha).toBe(true);
      await cliente.get('/api/v1/usuarios').expect(403); // R2.7
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: 'usuario.senha_temporaria_definida',
            entidadeId: membro.id,
            usuarioId: admin.id,
          },
        }),
      ).toBe(1);

      const curta = await comoAdmin
        .post(`/api/v1/usuarios/${membro.id}/senha-temporaria`, {
          senha: '123',
        })
        .expect(400);
      expect(curta.body.detalhes.campos).toEqual([
        { campo: 'senha', mensagens: ['deve ter de 8 a 128 caracteres'] },
      ]);
    });

    it('R2.8 — senha temporária não vale para quem está desligado nem para a própria conta', async () => {
      const desligado = await criarUsuario(t, {
        papel: 'C_LEVEL',
        ativo: false,
      });
      const resposta = await comoAdmin
        .post(`/api/v1/usuarios/${desligado.id}/senha-temporaria`, {
          senha: SENHA_TEMPORARIA,
        })
        .expect(422);
      expect(resposta.body.mensagem).toContain(
        'está desligado: reative-o antes',
      );
      await comoAdmin
        .post(`/api/v1/usuarios/${admin.id}/senha-temporaria`, {
          senha: SENHA_TEMPORARIA,
        })
        .expect(422);
      await comoAdmin
        .post(
          '/api/v1/usuarios/00000000-0000-4000-8000-000000000000/senha-temporaria',
          { senha: SENHA_TEMPORARIA },
        )
        .expect(404);
    });

    it('R2.8 — sem senha temporária, a criação envia o convite por e-mail; o link define a senha', async () => {
      const criado = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Carla Convidada',
          email: 'carla@brl.com.br',
          papel: 'C_LEVEL',
        })
        .expect(201);
      expect(criado.body).toMatchObject({
        usuario: { senhaDefinida: false, deveTrocarSenha: false },
        convite: { enviado: true, expiraEm: expect.any(String) },
      });
      const mensagem = t.email.ultimo('carla@brl.com.br');
      expect(mensagem?.assunto).toBe('Seu acesso ao BRL CRM');
      const token = t.email.tokenDoUltimo('carla@brl.com.br');
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token,
          novaSenha: 'minha-senha-nova',
        })
        .expect(204);
      const { resposta } = await entrarPeloLogin(
        t,
        'carla@brl.com.br',
        'minha-senha-nova',
      );
      expect(resposta.status).toBe(200);

      // Reenviar o convite pelo Admin.
      const reenvio = await comoAdmin
        .post(`/api/v1/usuarios/${criado.body.usuario.id}/convite`)
        .expect(202);
      expect(reenvio.body).toMatchObject({
        mensagem: 'Convite enviado para carla@brl.com.br.',
        expiraEm: expect.any(String),
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'usuario.convite_enviado' },
        }),
      ).toBe(2);
    });

    it('R2.8 — sem SMTP, criar exige senha temporária (422) e o convite fica indisponível', async () => {
      t.email.configurado = false;
      const semSenha = await comoAdmin
        .post('/api/v1/usuarios', {
          nome: 'Carla',
          email: 'carla@brl.com.br',
          papel: 'C_LEVEL',
        })
        .expect(422);
      expect(semSenha.body).toMatchObject({
        detalhes: { regra: 'R2.8' },
        mensagem:
          'O envio de e-mails não está configurado: informe uma senha temporária para o novo usuário.',
      });
      expect(
        await t.prisma.usuario.count({ where: { email: 'carla@brl.com.br' } }),
      ).toBe(0);

      const outro = await criarUsuario(t, { papel: 'C_LEVEL', senha: null });
      const convite = await comoAdmin
        .post(`/api/v1/usuarios/${outro.id}/convite`)
        .expect(422);
      expect(convite.body.detalhes.regra).toBe('R2.8');
    });
  });

  describe('visão de equipe', () => {
    it('o líder vê a própria equipe com a carga de trabalho de cada um', async () => {
      const { lider, membros } = await criarEquipe(t, 'COMERCIAL');
      const [ana, bia] = membros;
      const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await criarAtividade(t, { responsavel: ana, venceEm: ontem });
      await criarAtividade(t, { responsavel: ana, venceEm: amanha });
      await criarAtividade(t, { responsavel: ana, status: 'CONCLUIDA' });
      const contato = await criarContato(t, { responsavel: ana });
      await criarNegocio(t, { contato, responsavel: ana, valor: '1500.50' });
      await criarNegocio(t, { contato, responsavel: ana, valor: '500.00' });
      await criarNegocio(t, {
        contato,
        responsavel: ana,
        etapa: 'ganho',
        valor: '9999.00',
      });
      await criarAtividade(t, { responsavel: lider });

      const comoLider = await entrarComo(t, lider);
      const resposta = await comoLider
        .get('/api/v1/usuarios/equipes')
        .expect(200);
      expect(resposta.body).toHaveLength(1);
      const [equipe] = resposta.body;
      expect(equipe).toMatchObject({
        area: 'COMERCIAL',
        lider: {
          usuario: { id: lider.id },
          indicadores: { atividadesPendentes: 1 },
          aguardandoNovoLider: false,
        },
      });
      const porId = new Map(
        equipe.membros.map((membro: { usuario: { id: string } }) => [
          membro.usuario.id,
          membro,
        ]),
      );
      expect(porId.get(ana.id)).toMatchObject({
        aguardandoNovoLider: false,
        indicadores: {
          atividadesPendentes: 2,
          atividadesAtrasadas: 1,
          negociosAbertos: 2,
          valorEmAberto: '2000.50',
          contatos: 1,
        },
      });
      expect(porId.get(bia.id)).toMatchObject({
        indicadores: {
          atividadesPendentes: 0,
          negociosAbertos: 0,
          valorEmAberto: '0.00',
        },
      });

      // Só a própria equipe.
      const { lider: outroLider } = await criarEquipe(t, 'CS', { membros: 0 });
      await comoLider
        .get(`/api/v1/usuarios/equipes?liderId=${outroLider.id}`)
        .expect(403);
    });

    it('C-level e Admin veem todas as equipes; o membro não acessa', async () => {
      const comercial = await criarEquipe(t, 'COMERCIAL');
      const cs = await criarEquipe(t, 'CS', {
        membros: 1,
        cLevel: comercial.cLevel,
      });

      const comoCLevel = await entrarComo(t, comercial.cLevel);
      const todas = await comoCLevel
        .get('/api/v1/usuarios/equipes')
        .expect(200);
      const cabecas = todas.body.map(
        (equipe: { lider: { usuario: { id: string } } }) =>
          equipe.lider.usuario.id,
      );
      expect(cabecas).toEqual([
        comercial.cLevel.id,
        comercial.lider.id,
        cs.lider.id,
      ]);
      expect(todas.body[0]).toMatchObject({
        area: null,
        membros: expect.arrayContaining([
          expect.objectContaining({
            usuario: expect.objectContaining({ id: cs.lider.id }),
          }),
        ]),
      });

      const soCs = await comoAdmin
        .get('/api/v1/usuarios/equipes?area=CS')
        .expect(200);
      expect(soCs.body).toHaveLength(1);
      expect(soCs.body[0].membros).toHaveLength(1);
      const umaEquipe = await comoAdmin
        .get(`/api/v1/usuarios/equipes?liderId=${comercial.lider.id}`)
        .expect(200);
      expect(umaEquipe.body[0].membros).toHaveLength(2);
      await comoAdmin
        .get(
          '/api/v1/usuarios/equipes?liderId=00000000-0000-4000-8000-000000000000',
        )
        .expect(404);

      const comoMembro = await entrarComo(t, comercial.membros[0]);
      await comoMembro.get('/api/v1/usuarios/equipes').expect(403);
    });
  });

  it('as rotas de usuários estão na documentação OpenAPI', async () => {
    const documento = await comoAdmin.get('/api/docs-json').expect(200);
    expect(Object.keys(documento.body.paths as object)).toEqual(
      expect.arrayContaining([
        '/api/v1/usuarios',
        '/api/v1/usuarios/equipes',
        '/api/v1/usuarios/{id}',
        '/api/v1/usuarios/{id}/senha-temporaria',
        '/api/v1/usuarios/{id}/convite',
        '/api/v1/usuarios/{id}/desligamento/previa',
        '/api/v1/usuarios/{id}/desligar',
        '/api/v1/usuarios/{id}/reativar',
      ]),
    );
  });
});
