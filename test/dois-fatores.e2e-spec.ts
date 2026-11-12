import { gerarTotp } from '../src/auth/dois-fatores/totp';
import { SenhasService } from '../src/auth/senhas.service';
import { RotasDeTesteModule } from './base-rotas-de-teste';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  cookieDaSessao,
  criarAppTeste,
  criarUsuario,
  entrarComo,
  SENHA_DE_TESTE,
} from './utils';
import type { Usuario } from '../src/generated/prisma/client';

const PASSO = 30_000;

describe('Verificação em duas etapas — TOTP (R2.11, e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste({ importar: [RotasDeTesteModule] });
  });

  beforeEach(async () => {
    await t.limparBanco();
  });

  afterAll(async () => {
    await t.fechar();
  });

  /** O mesmo passo não vale duas vezes (replay): os testes liberam o passo entre os logins. */
  async function liberarPasso(usuario: Usuario): Promise<void> {
    await t.prisma.usuario.update({
      where: { id: usuario.id },
      data: { doisFatoresUltimoPasso: null },
    });
  }

  /** Ativa o 2FA pela API e devolve a chave e os códigos de recuperação. */
  async function ativar(
    usuario: Usuario,
  ): Promise<{ cliente: ClienteHttp; chave: string; codigos: string[] }> {
    const cliente = await entrarComo(t, usuario);
    const inicio = await cliente
      .post('/api/v1/auth/dois-fatores/ativar')
      .expect(200);
    const chave = inicio.body.chave as string;
    const confirmada = await cliente
      .post('/api/v1/auth/dois-fatores/confirmar', {
        codigo: gerarTotp(chave),
      })
      .expect(200);
    return { cliente, chave, codigos: confirmada.body.codigos as string[] };
  }

  async function primeiraEtapa(email: string, senha = SENHA_DE_TESTE) {
    return clienteAnonimo(t).post('/api/v1/auth/entrar', { email, senha });
  }

  describe('ativar e entrar em duas etapas', () => {
    it('R2.11 — ativar devolve QR e chave; confirmar devolve 10 códigos uma única vez e guarda só o hash', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const cliente = await entrarComo(t, ana);

      const inicio = await cliente
        .post('/api/v1/auth/dois-fatores/ativar')
        .expect(200);
      expect(inicio.body.chave).toMatch(/^[A-Z2-7]{32}$/);
      expect(inicio.body.qrCode).toMatch(/^data:image\/png;base64,/);
      expect(inicio.body.urlOtpauth).toContain(`secret=${inicio.body.chave}`);

      // Antes de confirmar, a conta ainda não exige o código.
      const pendente = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: ana.id },
      });
      expect(pendente.doisFatoresAtivadoEm).toBeNull();
      expect(pendente.doisFatoresSegredo).not.toContain(inicio.body.chave);
      await primeiraEtapa(ana.email).then((r) => expect(r.status).toBe(200));

      const errada = await cliente
        .post('/api/v1/auth/dois-fatores/confirmar', { codigo: '000000' })
        .expect(400);
      expect(errada.body.mensagem).toBe('Código incorreto.');

      const confirmada = await cliente
        .post('/api/v1/auth/dois-fatores/confirmar', {
          codigo: gerarTotp(inicio.body.chave),
        })
        .expect(200);
      const codigos = confirmada.body.codigos as string[];
      expect(codigos).toHaveLength(10);
      expect(new Set(codigos).size).toBe(10);
      for (const codigo of codigos) {
        expect(codigo).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      }

      const gravados = await t.prisma.codigoRecuperacao.findMany({
        where: { usuarioId: ana.id },
      });
      expect(gravados).toHaveLength(10);
      for (const gravado of gravados) {
        expect(
          codigos.some((c) => gravado.codigoHash.includes(c.replace('-', ''))),
        ).toBe(false);
      }

      const situacao = await cliente
        .get('/api/v1/auth/dois-fatores')
        .expect(200);
      expect(situacao.body).toMatchObject({
        ativo: true,
        codigosRestantes: 10,
      });
      const eu = await cliente.get('/api/v1/auth/eu').expect(200);
      expect(eu.body.usuario.doisFatoresAtivo).toBe(true);

      await cliente.post('/api/v1/auth/dois-fatores/ativar').expect(422);
      await cliente
        .post('/api/v1/auth/dois-fatores/confirmar', {
          codigo: gerarTotp(inicio.body.chave),
        })
        .expect(422);
    });

    it('R2.11 — senha certa com 2FA devolve um desafio e nenhuma sessão; o código abre a sessão', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);

      const etapa1 = await primeiraEtapa(ana.email);
      expect(etapa1.status).toBe(200);
      expect(etapa1.body).toMatchObject({ doisFatoresNecessario: true });
      expect(etapa1.body.usuario).toBeUndefined();
      expect(cookieDaSessao(etapa1)).toBeUndefined();
      const desafio = etapa1.body.desafio as string;
      expect(
        new Date(etapa1.body.expiraEm).getTime() - Date.now(),
      ).toBeLessThanOrEqual(5 * 60_000);
      // O banco guarda só o hash do desafio.
      expect(
        await t.prisma.desafioDoisFatores.count({
          where: { tokenHash: desafio },
        }),
      ).toBe(0);

      const etapa2 = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave),
        })
        .expect(200);
      const cookie = cookieDaSessao(etapa2);
      expect(cookie).toBeDefined();
      expect(etapa2.body.usuario.email).toBe(ana.email);

      // O desafio é de uma vez só.
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave, Date.now() + PASSO),
        })
        .expect(401);

      const login = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.login', entidadeId: ana.id },
        orderBy: { id: 'desc' },
      });
      expect(login.dados).toMatchObject({ doisFatores: 'totp' });
    });

    it('R2.11 — o mesmo código não vale duas vezes (passo já usado)', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);
      const codigo = gerarTotp(chave);
      const d1 = (await primeiraEtapa(ana.email)).body.desafio as string;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', { desafio: d1, codigo })
        .expect(200);
      const d2 = (await primeiraEtapa(ana.email)).body.desafio as string;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', { desafio: d2, codigo })
        .expect(400);
    });

    it('R2.11 — senha errada continua com a mesma mensagem genérica, sem desafio', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      await ativar(ana);
      const resposta = await primeiraEtapa(ana.email, 'senha-errada-123');
      expect(resposta.status).toBe(401);
      expect(resposta.body.mensagem).toBe('E-mail ou senha incorretos.');
    });
  });

  describe('código errado, bloqueio e desafio expirado', () => {
    it('R2.11/R2.5 — código errado conta: 5 erros descartam o desafio e bloqueiam o e-mail, mesmo com o código certo', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);
      const { desafio } = (await primeiraEtapa(ana.email)).body;

      for (let i = 1; i <= 4; i++) {
        const r = await clienteAnonimo(t)
          .post('/api/v1/auth/entrar/dois-fatores', {
            desafio,
            codigo: '000000',
          })
          .expect(400);
        expect(r.body.detalhes.tentativasRestantes).toBe(5 - i);
      }
      const quinta = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', { desafio, codigo: '000000' })
        .expect(401);
      expect(quinta.body.mensagem).toContain('expirou');

      // 5 falhas em 15 min: o e-mail está bloqueado (R2.5), até para a senha certa.
      const bloqueado = await primeiraEtapa(ana.email);
      expect(bloqueado.status).toBe(429);
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave),
        })
        .expect(401);

      const acoes = await t.prisma.eventoAuditoria.findMany({
        where: { entidadeId: ana.id, acao: { startsWith: 'usuario.' } },
        select: { acao: true },
      });
      const nomes = acoes.map((a) => a.acao);
      expect(
        nomes.filter((n) => n === 'usuario.dois_fatores_codigo_incorreto'),
      ).toHaveLength(5);
      expect(nomes).toContain('usuario.bloqueado_forca_bruta');
    });

    it('R2.11 — desafio com mais de 5 minutos expira', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);
      const { desafio } = (await primeiraEtapa(ana.email)).body;
      await t.prisma.desafioDoisFatores.updateMany({
        where: { usuarioId: ana.id },
        data: { expiraEm: new Date(Date.now() - 1000) },
      });
      const r = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave),
        })
        .expect(401);
      expect(r.body.mensagem).toContain('Entre de novo');
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: 'inventado',
          codigo: gerarTotp(chave),
        })
        .expect(401);
    });

    it('R2.11 — o desafio de quem foi desligado no meio do caminho não abre sessão (403)', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);
      const { desafio } = (await primeiraEtapa(ana.email)).body;
      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { ativo: false },
      });
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave),
        })
        .expect(403);
    });
  });

  describe('códigos de recuperação', () => {
    it('R2.11 — código de recuperação entra uma vez só, avisa a pessoa e conta os restantes', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { codigos } = await ativar(ana);

      const d1 = (await primeiraEtapa(ana.email)).body.desafio as string;
      const ok = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: d1,
          // Minúsculas e sem hífen também valem.
          codigo: codigos[0].replace('-', '').toLowerCase(),
        })
        .expect(200);
      expect(cookieDaSessao(ok)).toBeDefined();

      const d2 = (await primeiraEtapa(ana.email)).body.desafio as string;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: d2,
          codigo: codigos[0],
        })
        .expect(400);
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: d2,
          codigo: codigos[1],
        })
        .expect(200);

      const cliente = await entrarComo(t, ana);
      const situacao = await cliente
        .get('/api/v1/auth/dois-fatores')
        .expect(200);
      expect(situacao.body.codigosRestantes).toBe(8);
      const avisos = await t.prisma.notificacao.findMany({
        where: {
          usuarioId: ana.id,
          tipo: 'seguranca.codigo_recuperacao_usado',
        },
      });
      expect(avisos).toHaveLength(2);
      const uso = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.dois_fatores_recuperacao_usada' },
        orderBy: { id: 'asc' },
      });
      expect(uso.dados).toMatchObject({ restantes: 9 });
    });

    it('R2.11 — gerar novos códigos pede um código do aplicativo e invalida os antigos', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { cliente, chave, codigos } = await ativar(ana);
      await liberarPasso(ana);

      await cliente
        .post('/api/v1/auth/dois-fatores/codigos', { codigo: codigos[0] })
        .expect(400);
      const nova = await cliente
        .post('/api/v1/auth/dois-fatores/codigos', { codigo: gerarTotp(chave) })
        .expect(200);
      expect(nova.body.codigos).toHaveLength(10);
      expect(nova.body.codigos).not.toContain(codigos[0]);

      const d = (await primeiraEtapa(ana.email)).body.desafio as string;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: d,
          codigo: codigos[0],
        })
        .expect(400);
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: d,
          codigo: nova.body.codigos[0],
        })
        .expect(200);
    });
  });

  describe('desativar e redefinir', () => {
    it('R2.11 — desativar pede a senha atual e um código; depois o login volta a ser direto', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { cliente, chave, codigos } = await ativar(ana);
      await liberarPasso(ana);

      const senhaErrada = await cliente
        .post('/api/v1/auth/dois-fatores/desativar', {
          senha: 'outra-senha-123',
          codigo: gerarTotp(chave),
        })
        .expect(400);
      expect(senhaErrada.body.mensagem).toBe('A senha atual está incorreta.');
      await cliente
        .post('/api/v1/auth/dois-fatores/desativar', {
          senha: SENHA_DE_TESTE,
          codigo: '111111',
        })
        .expect(400);
      // Com um código de recuperação também vale.
      await cliente
        .post('/api/v1/auth/dois-fatores/desativar', {
          senha: SENHA_DE_TESTE,
          codigo: codigos[3],
        })
        .expect(204);

      const depois = await t.prisma.usuario.findUniqueOrThrow({
        where: { id: ana.id },
      });
      expect(depois).toMatchObject({
        doisFatoresSegredo: null,
        doisFatoresAtivadoEm: null,
      });
      expect(
        await t.prisma.codigoRecuperacao.count({
          where: { usuarioId: ana.id },
        }),
      ).toBe(0);
      const direto = await primeiraEtapa(ana.email);
      expect(direto.status).toBe(200);
      expect(direto.body.usuario.email).toBe(ana.email);
      expect(cookieDaSessao(direto)).toBeDefined();
      await cliente
        .post('/api/v1/auth/dois-fatores/desativar', {
          senha: SENHA_DE_TESTE,
          codigo: gerarTotp(chave),
        })
        .expect(422);
    });

    it('R2.11 — o Admin redefine o 2FA de quem perdeu o aparelho: auditado e a pessoa é avisada', async () => {
      const admin = await criarUsuario(t, { papel: 'ADMIN' });
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const bia = await criarUsuario(t, { papel: 'COMERCIAL' });
      await ativar(ana);
      const clienteAdmin = await entrarComo(t, admin);

      await clienteAdmin
        .post(`/api/v1/usuarios/${bia.id}/dois-fatores/redefinir`)
        .expect(422);
      await clienteAdmin
        .post(`/api/v1/usuarios/${admin.id}/dois-fatores/redefinir`)
        .expect(422);
      const comum = await entrarComo(t, bia);
      await comum
        .post(`/api/v1/usuarios/${ana.id}/dois-fatores/redefinir`)
        .expect(403);

      const lista = await clienteAdmin.get(`/api/v1/usuarios/${ana.id}`);
      expect(lista.body.doisFatoresAtivo).toBe(true);
      const r = await clienteAdmin
        .post(`/api/v1/usuarios/${ana.id}/dois-fatores/redefinir`)
        .expect(200);
      expect(r.body.doisFatoresAtivo).toBe(false);

      const direto = await primeiraEtapa(ana.email);
      expect(cookieDaSessao(direto)).toBeDefined();

      const evento = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'usuario.dois_fatores_redefinido' },
      });
      expect(evento).toMatchObject({ entidadeId: ana.id, usuarioId: admin.id });
      const aviso = await t.prisma.notificacao.findFirstOrThrow({
        where: {
          usuarioId: ana.id,
          tipo: 'seguranca.dois_fatores_redefinido',
        },
      });
      expect(aviso.texto).toContain(admin.nome);
    });
  });

  describe('combinações', () => {
    it('R2.11/R2.7 — com troca obrigatória de senha: o código vem primeiro, e a sessão nasce restrita à troca', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { deveTrocarSenha: true },
      });
      await liberarPasso(ana);

      const etapa1 = await primeiraEtapa(ana.email);
      expect(etapa1.body.doisFatoresNecessario).toBe(true);
      const etapa2 = await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: etapa1.body.desafio,
          codigo: gerarTotp(chave),
        })
        .expect(200);
      expect(etapa2.body.deveTrocarSenha).toBe(true);
      const cookie = cookieDaSessao(etapa2) as string;
      const resposta = await clienteAnonimo(t)
        .get('/api/v1/notificacoes')
        .set('Cookie', cookie);
      expect(resposta.status).toBe(403);
    });

    it('R2.11/R2.8 — "esqueci a senha" redefine a senha, mas o login seguinte ainda pede o código', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { chave } = await ativar(ana);
      await liberarPasso(ana);
      const { token } = await t.prisma.$transaction((tx) =>
        t.get(SenhasService).emitirToken(tx, ana.id, 'REDEFINICAO'),
      );
      await t.get(SenhasService).redefinirComToken(token, 'senha-nova-456');

      const etapa1 = await primeiraEtapa(ana.email, 'senha-nova-456');
      expect(etapa1.body.doisFatoresNecessario).toBe(true);
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio: etapa1.body.desafio,
          codigo: gerarTotp(chave),
        })
        .expect(200);
    });

    it('R2.11/R3.1 — a auditoria nunca guarda segredo, código nem hash', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const { cliente, chave, codigos } = await ativar(ana);
      await liberarPasso(ana);
      const { desafio } = (await primeiraEtapa(ana.email)).body;
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', { desafio, codigo: '123456' })
        .expect(400);
      await clienteAnonimo(t)
        .post('/api/v1/auth/entrar/dois-fatores', {
          desafio,
          codigo: gerarTotp(chave),
        })
        .expect(200);
      await cliente
        .post('/api/v1/auth/dois-fatores/desativar', {
          senha: SENHA_DE_TESTE,
          codigo: codigos[0],
        })
        .expect(204);

      const eventos = await t.prisma.eventoAuditoria.findMany();
      const texto = JSON.stringify(eventos, (_chave, valor: unknown) =>
        typeof valor === 'bigint' ? valor.toString() : valor,
      );
      expect(
        eventos.some((e) => e.acao.startsWith('usuario.dois_fatores_')),
      ).toBe(true);
      expect(texto).not.toContain(chave);
      expect(texto).not.toContain(desafio);
      expect(texto).not.toContain('123456');
      for (const codigo of codigos) {
        expect(texto).not.toContain(codigo);
        expect(texto).not.toContain(codigo.replace('-', ''));
      }
      expect(texto).not.toContain('otpauth');
    });
  });
});
