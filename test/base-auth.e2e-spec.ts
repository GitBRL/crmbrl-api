import request from 'supertest';
import { NOME_COOKIE_SESSAO } from '../src/auth/cookies';
import { SenhasService } from '../src/auth/senhas.service';
import { SessoesService } from '../src/auth/sessoes.service';
import { CriptografiaService } from '../src/comum/criptografia/criptografia.service';
import { SeedsService } from '../src/seeds/seeds.service';
import { RotasDeTesteModule } from './base-rotas-de-teste';
import {
  type AppTeste,
  clienteAnonimo,
  cookieDaSessao,
  criarAppTeste,
  criarUsuario,
  drenarTudo,
  entrarComo,
  entrarPeloLogin,
  ORIGEM_DE_TESTE,
  SENHA_DE_TESTE,
} from './utils';

const ADMIN_INICIAL = {
  ADMIN_EMAIL: ' Admin@BRL.com.br ',
  ADMIN_NOME: 'Admin Inicial',
  ADMIN_SENHA_INICIAL: 'senha-inicial-123',
};

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;

describe('Base — autenticação e sessões (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste({
      variaveis: ADMIN_INICIAL,
      importar: [RotasDeTesteModule],
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
  });

  afterAll(async () => {
    await t.fechar();
  });

  describe('primeiro acesso', () => {
    it('cenário 1 — R2.6/R2.7: base vazia cria o Admin; o login exige trocar a senha antes de qualquer outra coisa', async () => {
      const admin = await t.prisma.usuario.findUniqueOrThrow({
        where: { email: 'admin@brl.com.br' },
      });
      expect(admin).toMatchObject({
        nome: 'Admin Inicial',
        papel: 'ADMIN',
        ativo: true,
        deveTrocarSenha: true,
      });
      expect(admin.senhaHash).toMatch(/^scrypt\$32768\$8\$3\$/);

      const { cliente, resposta } = await entrarPeloLogin(
        t,
        'ADMIN@brl.com.br',
        'senha-inicial-123',
      );
      expect(resposta.status).toBe(200);
      expect(resposta.body).toMatchObject({
        deveTrocarSenha: true,
        usuario: {
          email: 'admin@brl.com.br',
          papel: 'ADMIN',
          area: null,
          nivel: 'ADMINISTRADOR',
        },
        permissoes: { gerenciarUsuarios: true, verLogsTecnicos: true },
      });

      // R2.7: só auth/eu, auth/senha e auth/sair.
      await cliente.get('/api/v1/auth/eu').expect(200);
      const bloqueada = await cliente.get('/api/v1/notificacoes').expect(403);
      expect(bloqueada.body).toMatchObject({
        erro: 'sem_permissao',
        detalhes: { regra: 'R2.7', motivo: 'troca_de_senha_pendente' },
      });

      const trocada = await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: 'senha-inicial-123',
          novaSenha: 'nova-senha-forte',
        })
        .expect(200);
      expect(trocada.body.deveTrocarSenha).toBe(false);
      await cliente.get('/api/v1/notificacoes').expect(200);

      const acoes = await t.prisma.eventoAuditoria.findMany({
        where: { entidadeId: admin.id },
        orderBy: { id: 'asc' },
        select: { acao: true, tipoAtor: true },
      });
      expect(acoes).toEqual([
        { acao: 'usuario.criado', tipoAtor: 'SISTEMA' },
        { acao: 'usuario.login', tipoAtor: 'USUARIO' },
        { acao: 'usuario.senha_alterada', tipoAtor: 'USUARIO' },
      ]);
    });

    it('R2.6 — com usuários cadastrados, a configuração inicial não cria outro Admin', async () => {
      await t.get(SeedsService).executar();
      expect(await t.prisma.usuario.count()).toBe(1);
    });

    it('R2.7 — auth/sair funciona com a troca pendente', async () => {
      const { cliente } = await entrarPeloLogin(
        t,
        'admin@brl.com.br',
        'senha-inicial-123',
      );
      await cliente.post('/api/v1/auth/sair').expect(204);
    });
  });

  describe('login', () => {
    it('R2.2 — entrega o cookie crmbrl_sessao HttpOnly, SameSite=Lax, Path=/ e guarda só o SHA-256 do token', async () => {
      const usuario = await criarUsuario(t, {
        papel: 'COMERCIAL',
        email: 'Ana@Teste.local',
      });
      const { resposta } = await entrarPeloLogin(t, '  ana@teste.LOCAL ');
      expect(resposta.status).toBe(200);
      const setCookie = ([] as string[]).concat(
        resposta.headers['set-cookie'] ?? [],
      );
      const cookie =
        setCookie.find((valor) => valor.startsWith(`${NOME_COOKIE_SESSAO}=`)) ??
        '';
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Secure/i); // COOKIE_SEGURO=false fora de produção
      expect(cookie).toMatch(/Max-Age=2592000/); // 30 dias

      const token = (cookieDaSessao(resposta) ?? '').split('=')[1];
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      const sessao = await t.prisma.sessao.findFirstOrThrow({
        where: { usuarioId: usuario.id },
      });
      expect(sessao.tokenHash).toBe(t.get(CriptografiaService).sha256(token));
      expect(sessao.tokenHash).not.toContain(token);
      expect(sessao.expiraEm.getTime() - sessao.criadoEm.getTime()).toBe(
        7 * DIA,
      );
    });

    it('R2.3 — e-mail inexistente e senha errada recebem a mesma mensagem genérica', async () => {
      await criarUsuario(t, { email: 'bia@teste.local' });
      const senhaErrada = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'bia@teste.local',
          senha: 'errada-errada',
        })
        .expect(401);
      const inexistente = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'ninguem@teste.local',
          senha: 'errada-errada',
        })
        .expect(401);
      expect(senhaErrada.body.mensagem).toBe('E-mail ou senha incorretos.');
      expect(inexistente.body.mensagem).toBe(senhaErrada.body.mensagem);
      expect(senhaErrada.body.erro).toBe('nao_autenticado');
      expect(
        await t.prisma.tentativaLogin.count({ where: { sucesso: false } }),
      ).toBe(2);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'usuario.login_falhou' },
        }),
      ).toBe(2);
    });

    it('R3.2 — falha de login num navegador com a sessão de outra pessoa: o ator é o e-mail tentado, sem usuário', async () => {
      const dona = await criarUsuario(t, {
        email: 'dona@teste.local',
        nome: 'Dona da Sessão',
      });
      const alvo = await criarUsuario(t, { email: 'alvo@teste.local' });
      const sessao = await entrarComo(t, dona);
      const tentar = (email: string, senha: string) =>
        request(t.servidor)
          .post('/api/v1/auth/entrar')
          .set('Origin', ORIGEM_DE_TESTE)
          .set('Cookie', sessao.cookie ?? '')
          .send({ email, senha });
      await tentar('ninguem@teste.local', 'errada-errada').expect(401);
      for (let vez = 1; vez <= 5; vez++) {
        await tentar('alvo@teste.local', `errada-${vez}`).expect(401);
      }

      const falhas = await t.prisma.eventoAuditoria.findMany({
        where: { acao: 'usuario.login_falhou' },
        orderBy: { id: 'asc' },
      });
      expect(falhas).toHaveLength(6);
      expect(falhas[0]).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: null,
        atorDescricao: 'ninguem@teste.local',
        entidadeId: null,
      });
      expect(falhas[1]).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: null,
        atorDescricao: 'alvo@teste.local',
        entidadeId: alvo.id,
      });
      // O bloqueio que a 5ª falha fechou também não é da dona da sessão.
      const bloqueio = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.bloqueado_forca_bruta' },
      });
      expect(bloqueio).toMatchObject({
        usuarioId: null,
        atorDescricao: 'alvo@teste.local',
      });
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { usuarioId: dona.id, acao: { not: 'usuario.login' } },
        }),
      ).toBe(0);
      // A sessão de quem estava no navegador continua valendo.
      await sessao.get('/api/v1/auth/eu').expect(200);
    });

    it('R2.3 — usuário desligado com a senha certa recebe "Acesso desativado"', async () => {
      await criarUsuario(t, { email: 'saiu@teste.local', ativo: false });
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'saiu@teste.local',
          senha: SENHA_DE_TESTE,
        })
        .expect(403);
      expect(resposta.body.mensagem).toBe(
        'Acesso desativado. Fale com o administrador.',
      );
    });

    it('usuário convidado ainda sem senha não entra (mensagem genérica)', async () => {
      await criarUsuario(t, { email: 'convidado@teste.local', senha: null });
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'convidado@teste.local',
          senha: 'qualquer-coisa',
        })
        .expect(401);
    });

    it('valida a entrada (400 com os campos, em português)', async () => {
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', { email: 'a@b.com', senha: '', extra: 1 })
        .expect(400);
      expect(resposta.body.erro).toBe('dados_invalidos');
      expect(resposta.body.detalhes.campos).toEqual(
        expect.arrayContaining([
          { campo: 'extra', mensagens: ['não é um campo aceito'] },
          { campo: 'senha', mensagens: ['é obrigatória'] },
        ]),
      );
    });

    it('um novo login encerra a sessão do cookie anterior', async () => {
      const usuario = await criarUsuario(t);
      const primeiro = await entrarPeloLogin(t, usuario.email);
      const segundo = await request(t.servidor)
        .post('/api/v1/auth/entrar')
        .set('Origin', ORIGEM_DE_TESTE)
        .set('Cookie', primeiro.cliente.cookie ?? '')
        .send({ email: usuario.email, senha: SENHA_DE_TESTE })
        .expect(200);
      expect(cookieDaSessao(segundo)).not.toBe(primeiro.cliente.cookie);
      await primeiro.cliente.get('/api/v1/auth/eu').expect(401);
    });
  });

  describe('sessão', () => {
    it('R2.2 — "encerrar as outras sessões" mantém a atual, revoga as demais e audita', async () => {
      const usuario = await criarUsuario(t);
      const atual = await entrarComo(t, usuario);
      const outroNavegador = await entrarComo(t, usuario);
      const outroAparelho = await entrarComo(t, usuario);
      const deOutraPessoa = await entrarComo(t, await criarUsuario(t));

      const resposta = await atual
        .post('/api/v1/auth/sessoes/encerrar-outras')
        .expect(200);
      expect(resposta.body).toEqual({ encerradas: 2 });
      await atual.get('/api/v1/auth/eu').expect(200);
      await outroNavegador.get('/api/v1/auth/eu').expect(401);
      await outroAparelho.get('/api/v1/auth/eu').expect(401);
      await deOutraPessoa.get('/api/v1/auth/eu').expect(200);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: 'usuario.sessoes_encerradas',
            entidadeId: usuario.id,
          },
        }),
      ).toBe(1);
      await clienteAnonimo(t)
        .post('/api/v1/auth/sessoes/encerrar-outras')
        .expect(401);
    });

    it('respostas de /api/v1/* levam Cache-Control: no-store', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      const resposta = await cliente.get('/api/v1/auth/eu').expect(200);
      expect(resposta.headers['cache-control']).toBe('no-store');
    });

    it('cenário 3 — R2.4: login → auth/eu responde; desligar o usuário → a próxima requisição dele dá 401', async () => {
      const usuario = await criarUsuario(t, { papel: 'MARKETING' });
      const { cliente } = await entrarPeloLogin(t, usuario.email);
      const eu = await cliente.get('/api/v1/auth/eu').expect(200);
      expect(eu.body).toMatchObject({
        usuario: {
          id: usuario.id,
          papel: 'MEMBRO',
          area: 'MARKETING',
          nomeSetor: 'Marketing',
          nivel: 'MEMBRO',
          rotuloPapel: 'Marketing',
        },
        permissoes: {
          verNegocios: 'PROPRIOS',
          areasVisiveis: ['MARKETING'],
          gerenciarUsuarios: false,
        },
      });

      await t.prisma.usuario.update({
        where: { id: usuario.id },
        data: { ativo: false },
      });
      const negado = await cliente.get('/api/v1/auth/eu').expect(401);
      expect(negado.body.erro).toBe('nao_autenticado');
      const sessao = await t.prisma.sessao.findFirstOrThrow({
        where: { usuarioId: usuario.id },
      });
      expect(sessao).toMatchObject({ motivoRevogacao: 'usuario_inativo' });
      expect(sessao.revogadaEm).not.toBeNull();
    });

    it('R2.2 — sessão expirada dá 401 e apaga o cookie', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      await t.prisma.sessao.updateMany({
        where: { usuarioId: usuario.id },
        data: { expiraEm: new Date(Date.now() - 1000) },
      });
      const resposta = await cliente.get('/api/v1/auth/eu').expect(401);
      expect(resposta.body.mensagem).toMatch(/sessão expirou/i);
      const setCookie = ([] as string[]).concat(
        resposta.headers['set-cookie'] ?? [],
      );
      expect(setCookie.join(';')).toMatch(
        new RegExp(`${NOME_COOKIE_SESSAO}=;`),
      );
    });

    it('R2.2 — sessão revogada (outro dispositivo saiu de todas) dá 401', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      await t
        .get(SessoesService)
        .revogarTodas(t.prisma, usuario.id, 'desligamento');
      await cliente.get('/api/v1/auth/eu').expect(401);
    });

    it('R2.2 — o uso renova a validade (no máximo a cada 5 minutos), sem passar de 30 dias do login', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      const inicial = await t.prisma.sessao.findFirstOrThrow({
        where: { usuarioId: usuario.id },
      });

      await cliente.get('/api/v1/auth/eu').expect(200);
      const semRenovar = await t.prisma.sessao.findUniqueOrThrow({
        where: { id: inicial.id },
      });
      expect(semRenovar.ultimoUsoEm).toEqual(inicial.ultimoUsoEm);

      const dezMinutosAtras = new Date(Date.now() - 10 * MINUTO);
      await t.prisma.sessao.update({
        where: { id: inicial.id },
        data: { ultimoUsoEm: dezMinutosAtras },
      });
      await cliente.get('/api/v1/auth/eu').expect(200);
      const renovada = await t.prisma.sessao.findUniqueOrThrow({
        where: { id: inicial.id },
      });
      expect(renovada.ultimoUsoEm.getTime()).toBeGreaterThan(
        dezMinutosAtras.getTime(),
      );
      expect(renovada.expiraEm.getTime()).toBeGreaterThan(
        Date.now() + 7 * DIA - MINUTO,
      );
      expect(
        (
          await t.prisma.usuario.findUniqueOrThrow({
            where: { id: usuario.id },
          })
        ).ultimoAcessoEm,
      ).not.toBeNull();

      // Login há 29 dias: a renovação não passa dos 30 dias.
      const criadaHa29Dias = new Date(Date.now() - 29 * DIA);
      await t.prisma.sessao.update({
        where: { id: inicial.id },
        data: { criadoEm: criadaHa29Dias, ultimoUsoEm: dezMinutosAtras },
      });
      await cliente.get('/api/v1/auth/eu').expect(200);
      const limitada = await t.prisma.sessao.findUniqueOrThrow({
        where: { id: inicial.id },
      });
      expect(limitada.expiraEm.getTime()).toBe(
        criadaHa29Dias.getTime() + 30 * DIA,
      );
    });

    it('sem cookie, rota protegida dá 401 no formato padrão', async () => {
      const resposta = await clienteAnonimo(t)
        .get('/api/v1/auth/eu')
        .expect(401);
      expect(resposta.body).toEqual({
        statusCode: 401,
        erro: 'nao_autenticado',
        mensagem: 'Faça login para continuar.',
        requisicaoId: resposta.headers['x-request-id'],
      });
    });

    it('logout encerra a sessão, apaga o cookie e audita', async () => {
      const usuario = await criarUsuario(t);
      const { cliente } = await entrarPeloLogin(t, usuario.email);
      const resposta = await cliente.post('/api/v1/auth/sair').expect(204);
      expect(
        ([] as string[]).concat(resposta.headers['set-cookie'] ?? []).join(';'),
      ).toMatch(new RegExp(`${NOME_COOKIE_SESSAO}=;`));
      await cliente.get('/api/v1/auth/eu').expect(401);
      const sessao = await t.prisma.sessao.findFirstOrThrow({
        where: { usuarioId: usuario.id },
      });
      expect(sessao.motivoRevogacao).toBe('logout');
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'usuario.logout', entidadeId: usuario.id },
        }),
      ).toBe(1);
    });

    it('rota @Publico() enxerga o usuário quando há sessão válida', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      const resposta = await cliente
        .get('/api/v1/teste-base/publico')
        .expect(200);
      expect(resposta.body.usuarioId).toBe(usuario.id);
      const anonimo = await clienteAnonimo(t)
        .get('/api/v1/teste-base/publico')
        .expect(200);
      expect(anonimo.body.usuarioId).toBeNull();
    });
  });

  describe('força bruta', () => {
    it('cenário 15 — R2.5: 5 senhas erradas → a 6ª tentativa é bloqueada (429), mesmo com a senha certa', async () => {
      const usuario = await criarUsuario(t, { email: 'alvo@teste.local' });
      for (let tentativa = 1; tentativa <= 5; tentativa++) {
        await clienteAnonimo(t)
          .post('/api/v1/auth/entrar', {
            email: 'alvo@teste.local',
            senha: `errada-${tentativa}`,
          })
          .expect(401);
      }
      const bloqueada = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'alvo@teste.local',
          senha: SENHA_DE_TESTE,
        })
        .expect(429);
      expect(bloqueada.body).toMatchObject({
        erro: 'muitas_tentativas',
        detalhes: { regra: 'R2.5', motivo: 'BLOQUEADO_EMAIL' },
      });
      expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(14 * 60);
      expect(
        await t.prisma.eventoAuditoria.count({
          where: {
            acao: 'usuario.bloqueado_forca_bruta',
            entidadeId: usuario.id,
          },
        }),
      ).toBe(1);
      expect(
        await t.prisma.tentativaLogin.count({
          where: { email: 'alvo@teste.local' },
        }),
      ).toBe(6);
      expect(
        await t.prisma.tentativaLogin.count({
          where: { email: 'alvo@teste.local', motivo: 'BLOQUEADO_EMAIL' },
        }),
      ).toBe(1);

      // 16 minutos depois, o bloqueio acabou.
      await t.prisma
        .$executeRaw`UPDATE tentativas_login SET criado_em = criado_em - interval '16 minutes'`;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'alvo@teste.local',
          senha: SENHA_DE_TESTE,
        })
        .expect(200);
    });

    it('R2.5 — um login com sucesso zera a contagem de falhas do e-mail', async () => {
      await criarUsuario(t, { email: 'zera@teste.local' });
      const errar = () =>
        clienteAnonimo(t)
          .post('/api/v1/auth/entrar', {
            email: 'zera@teste.local',
            senha: 'errada-xx',
          })
          .expect(401);
      for (let tentativa = 0; tentativa < 4; tentativa++) {
        await errar();
      }
      await entrarPeloLogin(t, 'zera@teste.local');
      await errar();
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: 'zera@teste.local',
          senha: SENHA_DE_TESTE,
        })
        .expect(200);
    });

    it('R2.5 — 30 tentativas sem sucesso do mesmo IP em 15 minutos bloqueiam o IP', async () => {
      const ip = '203.0.113.7';
      const tentativas = Array.from({ length: 30 }, (_valor, indice) => ({
        email: `varios-${indice % 10}@teste.local`,
        ip,
        sucesso: false,
        motivo: 'USUARIO_INEXISTENTE',
      }));
      await t.prisma.tentativaLogin.createMany({ data: tentativas });
      const usuario = await criarUsuario(t, { email: 'inocente@teste.local' });

      const doIpBloqueado = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: usuario.email,
          senha: SENHA_DE_TESTE,
        })
        .set('X-Forwarded-For', ip)
        .expect(429);
      expect(doIpBloqueado.body.detalhes.motivo).toBe('BLOQUEADO_IP');

      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: usuario.email,
          senha: SENHA_DE_TESTE,
        })
        .set('X-Forwarded-For', '203.0.113.8')
        .expect(200);
    });

    it('R2.5 — tentativas recusadas por já estarem bloqueadas não contam no limite do IP nem o renovam', async () => {
      const ip = '203.0.113.9';
      const falhas = Array.from({ length: 25 }, (_valor, indice) => ({
        email: `varios-${indice % 5}@teste.local`,
        ip,
        sucesso: false,
        motivo: 'USUARIO_INEXISTENTE',
      }));
      const recusadas = Array.from({ length: 20 }, () => ({
        email: 'bloqueado@teste.local',
        ip,
        sucesso: false,
        motivo: 'BLOQUEADO_EMAIL',
      }));
      await t.prisma.tentativaLogin.createMany({
        data: [...falhas, ...recusadas],
      });
      const usuario = await criarUsuario(t, { email: 'livre@teste.local' });
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar', {
          email: usuario.email,
          senha: SENHA_DE_TESTE,
        })
        .set('X-Forwarded-For', ip)
        .expect(200);
    });

    it('R2.5 — requisições simultâneas não furam o limite do e-mail (a conferência é serializada)', async () => {
      await criarUsuario(t, { email: 'corrida@teste.local' });
      const respostas = await Promise.all(
        Array.from({ length: 12 }, (_valor, indice) =>
          clienteAnonimo(t).post('/api/v1/auth/entrar', {
            email: 'corrida@teste.local',
            senha: `errada-${indice}`,
          }),
        ),
      );
      const status = respostas.map((resposta) => resposta.status);
      expect(status.filter((valor) => valor === 401)).toHaveLength(5);
      expect(status.filter((valor) => valor === 429)).toHaveLength(7);
      expect(
        await t.prisma.tentativaLogin.count({
          where: {
            email: 'corrida@teste.local',
            sucesso: false,
            motivo: { not: 'BLOQUEADO_EMAIL' },
          },
        }),
      ).toBe(5);
    });
  });

  describe('CSRF', () => {
    it('R2.9 — requisição que altera dados sem Origin nem Referer é recusada', async () => {
      const resposta = await request(t.servidor)
        .post('/api/v1/auth/entrar')
        .send({ email: 'x@teste.local', senha: 'qualquer' })
        .expect(403);
      expect(resposta.body).toMatchObject({
        erro: 'sem_permissao',
        detalhes: { regra: 'R2.9', origem: null },
      });
    });

    it('R2.9 — origem fora de ORIGENS_PERMITIDAS é recusada, mesmo com sessão', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      const resposta = await cliente
        .post('/api/v1/auth/sair')
        .set('Origin', 'https://site-malicioso.exemplo')
        .expect(403);
      expect(resposta.body.detalhes).toEqual({
        regra: 'R2.9',
        origem: 'https://site-malicioso.exemplo',
      });
      await cliente.get('/api/v1/auth/eu').expect(200);
    });

    it('R2.9 — sem Origin, vale a origem do Referer', async () => {
      await request(t.servidor)
        .post('/api/v1/auth/entrar')
        .set('Referer', `${ORIGEM_DE_TESTE}/login?volta=/funis`)
        .send({ email: 'x@teste.local', senha: 'qualquer' })
        .expect(401);
    });

    it('R2.9 — GET não confere a origem; rota @SemVerificacaoDeOrigem() aceita qualquer uma', async () => {
      await request(t.servidor).get('/api/v1/teste-base/publico').expect(200);
      await request(t.servidor)
        .post('/api/v1/teste-base/sem-origem')
        .set('Origin', 'https://sistema-externo.exemplo')
        .expect(201);
    });
  });

  describe('papéis', () => {
    it('@Papeis — só os papéis listados acessam a rota', async () => {
      const comercial = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'COMERCIAL' }),
      );
      const resposta = await comercial
        .get('/api/v1/teste-base/so-admin')
        .expect(403);
      expect(resposta.body.erro).toBe('sem_permissao');
      const admin = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'ADMIN' }),
      );
      await admin.get('/api/v1/teste-base/so-admin').expect(200);
    });
  });

  describe('troca de senha', () => {
    it('R2.12 — senha comum é recusada na troca e na senha temporária definida pelo Admin', async () => {
      const usuario = await criarUsuario(t);
      const { cliente } = await entrarPeloLogin(t, usuario.email);
      const comum = await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: SENHA_DE_TESTE,
          novaSenha: 'Senha@123',
        })
        .expect(400);
      expect(comum.body.detalhes.campos).toEqual([
        {
          campo: 'novaSenha',
          mensagens: [expect.stringContaining('muito comum')],
        },
      ]);
      const admin = await criarUsuario(t, { papel: 'ADMIN' });
      const clienteAdmin = await entrarComo(t, admin);
      await clienteAdmin
        .post(`/api/v1/usuarios/${usuario.id}/senha-temporaria`, {
          senha: '12345678',
        })
        .expect(400);
    });

    it('R2.1 — confere a senha atual, exige 8 a 128 caracteres e encerra as outras sessões', async () => {
      const usuario = await criarUsuario(t);
      const { cliente } = await entrarPeloLogin(t, usuario.email);
      const outro = await entrarComo(t, usuario);

      const curta = await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: SENHA_DE_TESTE,
          novaSenha: '1234567',
        })
        .expect(400);
      expect(curta.body.detalhes.campos).toEqual([
        { campo: 'novaSenha', mensagens: ['deve ter de 8 a 128 caracteres'] },
      ]);
      await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: SENHA_DE_TESTE,
          novaSenha: 'x'.repeat(129),
        })
        .expect(400);
      const igual = await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: SENHA_DE_TESTE,
          novaSenha: SENHA_DE_TESTE,
        })
        .expect(400);
      expect(igual.body.mensagem).toBe(
        'A nova senha precisa ser diferente da atual.',
      );
      const errada = await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: 'nao-e-essa',
          novaSenha: 'outra-senha-boa',
        })
        .expect(400);
      expect(errada.body.mensagem).toBe('A senha atual está incorreta.');

      await cliente
        .post('/api/v1/auth/senha', {
          senhaAtual: SENHA_DE_TESTE,
          novaSenha: 'outra-senha-boa',
        })
        .expect(200);
      await cliente.get('/api/v1/auth/eu').expect(200);
      await outro.get('/api/v1/auth/eu').expect(401);
      await entrarPeloLogin(t, usuario.email, 'outra-senha-boa');
      const registro = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: usuario.id },
      });
      expect(registro.senhaAlteradaEm).not.toBeNull();
    });
  });

  describe('convite, redefinição e senha temporária', () => {
    it('R2.8 — "esqueci minha senha": link de uso único por e-mail, válido por 24 horas', async () => {
      const usuario = await criarUsuario(t, { email: 'esqueceu@teste.local' });
      const sessaoAntiga = await entrarComo(t, usuario);

      const pedido = await clienteAnonimo(t)
        .post('/api/v1/auth/senha/esqueci', { email: 'ESQUECEU@teste.local' })
        .expect(202);
      expect(pedido.body.mensagem).toMatch(/Se o e-mail estiver cadastrado/);
      // R2.8: a resposta não espera a busca nem o envio (tempo igual com e-mail existente ou não).
      expect(t.email.enviados).toHaveLength(0);
      await drenarTudo(t);
      const token = t.email.tokenDoUltimo('esqueceu@teste.local');
      expect(token).toBeDefined();
      expect(t.email.ultimo()?.texto).toContain(
        `${ORIGEM_DE_TESTE}/redefinir-senha?token=`,
      );

      const registro = await t.prisma.tokenSenha.findFirstOrThrow({
        where: { usuarioId: usuario.id },
      });
      expect(registro.tokenHash).toBe(
        t.get(CriptografiaService).sha256(token ?? ''),
      );
      expect(registro.expiraEm.getTime() - registro.criadoEm.getTime()).toBe(
        DIA,
      );

      const consulta = await clienteAnonimo(t)
        .post('/api/v1/auth/senha/token', { token })
        .expect(200);
      expect(consulta.body).toMatchObject({
        valido: true,
        tipo: 'REDEFINICAO',
        email: 'esqueceu@teste.local',
      });

      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token,
          novaSenha: 'senha-redefinida',
        })
        .expect(204);
      await sessaoAntiga.get('/api/v1/auth/eu').expect(401);
      const reuso = await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token,
          novaSenha: 'outra-tentativa',
        })
        .expect(422);
      expect(reuso.body.detalhes.regra).toBe('R2.8');
      expect(
        (
          await clienteAnonimo(t)
            .post('/api/v1/auth/senha/token', { token })
            .expect(200)
        ).body,
      ).toEqual({
        valido: false,
      });
      await entrarPeloLogin(t, 'esqueceu@teste.local', 'senha-redefinida');
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'usuario.senha_redefinida', entidadeId: usuario.id },
        }),
      ).toBe(1);
    });

    it('R3.2 — "esqueci minha senha" pedido de um navegador com a sessão de outra pessoa: o ator é o e-mail informado', async () => {
      const dono = await criarUsuario(t, { email: 'dono@teste.local' });
      const usuario = await criarUsuario(t, { email: 'esqueceu@teste.local' });
      const sessao = await entrarComo(t, dono);
      await sessao
        .post('/api/v1/auth/senha/esqueci', { email: 'esqueceu@teste.local' })
        .expect(202);
      await drenarTudo(t);
      const pedido = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.redefinicao_solicitada' },
      });
      expect(pedido).toMatchObject({
        tipoAtor: 'USUARIO',
        usuarioId: null,
        atorDescricao: 'esqueceu@teste.local',
        entidadeId: usuario.id,
      });
    });

    it('R2.8 — e-mail inexistente recebe a mesma resposta e nenhum e-mail sai', async () => {
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/esqueci', { email: 'nao-existe@teste.local' })
        .expect(202);
      await drenarTudo(t);
      expect(t.email.enviados).toHaveLength(0);
    });

    it('R2.8 — token expirado não vale', async () => {
      const usuario = await criarUsuario(t, { email: 'expira@teste.local' });
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/esqueci', { email: usuario.email })
        .expect(202);
      await drenarTudo(t);
      const token = t.email.tokenDoUltimo();
      await t.prisma.tokenSenha.updateMany({
        data: { expiraEm: new Date(Date.now() - 1000) },
      });
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token,
          novaSenha: 'senha-qualquer',
        })
        .expect(422);
    });

    it('R2.8 — sem SMTP configurado, a redefinição por e-mail fica indisponível (422)', async () => {
      t.email.configurado = false;
      const resposta = await clienteAnonimo(t)
        .post('/api/v1/auth/senha/esqueci', { email: 'qualquer@teste.local' })
        .expect(422);
      expect(resposta.body.detalhes.regra).toBe('R2.8');
    });

    it('R2.8 — convite: o usuário sem senha define a primeira pelo link', async () => {
      const usuario = await criarUsuario(t, {
        email: 'novo@teste.local',
        senha: null,
        nome: 'Novo Colega',
      });
      await t.get(SenhasService).enviarConvite(usuario.id);
      const mensagem = t.email.ultimo('novo@teste.local');
      expect(mensagem?.assunto).toBe('Seu acesso ao BRL CRM');
      expect(mensagem?.html).toContain('Novo Colega');
      const token = t.email.tokenDoUltimo('novo@teste.local');

      const consulta = await clienteAnonimo(t)
        .post('/api/v1/auth/senha/token', { token })
        .expect(200);
      expect(consulta.body).toMatchObject({
        valido: true,
        tipo: 'CONVITE',
        nome: 'Novo Colega',
      });
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token,
          novaSenha: 'minha-primeira-senha',
        })
        .expect(204);
      const { resposta } = await entrarPeloLogin(
        t,
        'novo@teste.local',
        'minha-primeira-senha',
      );
      expect(resposta.body.deveTrocarSenha).toBe(false);
    });

    it('R2.8 — reenviar o convite invalida o link anterior', async () => {
      const usuario = await criarUsuario(t, { senha: null });
      const senhas = t.get(SenhasService);
      await senhas.enviarConvite(usuario.id);
      const primeiro = t.email.tokenDoUltimo();
      await senhas.enviarConvite(usuario.id);
      await clienteAnonimo(t)
        .post('/api/v1/auth/senha/redefinir', {
          token: primeiro,
          novaSenha: 'senha-qualquer',
        })
        .expect(422);
    });

    it('R2.8 — senha temporária: encerra as sessões e exige troca no próximo acesso', async () => {
      const usuario = await criarUsuario(t);
      const cliente = await entrarComo(t, usuario);
      await t.prisma.$transaction((tx) =>
        t
          .get(SenhasService)
          .definirSenhaTemporaria(tx, usuario, 'temporaria-123'),
      );
      await cliente.get('/api/v1/auth/eu').expect(401);
      const { resposta, cliente: novo } = await entrarPeloLogin(
        t,
        usuario.email,
        'temporaria-123',
      );
      expect(resposta.body.deveTrocarSenha).toBe(true);
      await novo.get('/api/v1/notificacoes').expect(403);
    });
  });
});
