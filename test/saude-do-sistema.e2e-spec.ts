import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AlertasDeSaudeService,
  CHAVE_DOS_ALERTAS_ENVIADOS,
} from '../src/saude/monitoramento/alertas-de-saude.service';
import type { SaudeDoSistemaDto } from '../src/saude/monitoramento/saude-do-sistema.dto';
import {
  type AppTeste,
  clienteAnonimo,
  criarAppTeste,
  criarCanal,
  criarCanalWhatsapp,
  criarUsuario,
  entrarComo,
} from './utils';

const API = '/api/v1/administracao/saude-do-sistema';

describe('Saúde do sistema (e2e)', () => {
  let t: AppTeste;
  let pasta: string;
  let gateway: Server;
  let urlDoGateway: string;
  const emitirBackup = (extra: object = {}) =>
    writeFileSync(
      join(pasta, 'ultimo.json'),
      JSON.stringify({
        inicio: new Date(Date.now() - 120_000).toISOString(),
        fim: new Date(Date.now() - 60_000).toISOString(),
        arquivo: 'crmbrl-teste.dump',
        tamanhoBytes: 2048,
        ok: true,
        erro: null,
        ...extra,
      }),
    );
  const painel = async (): Promise<SaudeDoSistemaDto> => {
    const admin = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'ADMIN' }),
    );
    return (await admin.get(API).expect(200)).body as SaudeDoSistemaDto;
  };

  beforeAll(async () => {
    pasta = mkdtempSync(join(tmpdir(), 'backup-saude-'));
    gateway = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', simulado: true, numeros: {} }));
    });
    await new Promise<void>((ok) => gateway.listen(0, '127.0.0.1', ok));
    const porta = (gateway.address() as { port: number }).port;
    urlDoGateway = `http://127.0.0.1:${porta}`;
    t = await criarAppTeste({
      variaveis: { BACKUP_DIR: pasta, WHATSAPP_URL_INTERNA: urlDoGateway },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    t.email.limpar();
    rmSync(join(pasta, 'ultimo.json'), { force: true });
  });

  afterAll(async () => {
    await t.fechar();
    await new Promise((ok) => gateway.close(ok));
    rmSync(pasta, { recursive: true, force: true });
  });

  it('R27.8 — só o Admin vê o painel (401 sem sessão, 403 aos demais papéis)', async () => {
    await clienteAnonimo(t).get(API).expect(401);
    for (const papel of ['C_LEVEL', 'COMERCIAL', 'CS'] as const) {
      const cliente = await entrarComo(t, await criarUsuario(t, { papel }));
      await cliente.get(API).expect(403);
    }
    await painel();
  });

  it('R27.8 — sistema saudável: situação ok, gateway no ar, banco e disco medidos', async () => {
    emitirBackup();
    const corpo = await painel();
    expect(corpo.situacao).toBe('ok');
    expect(corpo.alertas).toEqual([]);
    expect(corpo.gateway).toEqual({ status: 'ok', simulado: true });
    expect(corpo.backup.situacao).toBe('ok');
    expect(corpo.backup.ultimo?.arquivo).toBe('crmbrl-teste.dump');
    expect(corpo.disco?.totalBytes).toBeGreaterThan(0);
    expect(corpo.disco?.bancoBytes).toBeGreaterThan(0);
    expect(corpo.filas.disponivel).toBe(true);
    expect(corpo.erros.total24h).toBe(0);
  });

  it('R27.3 — sem ultimo.json: "nenhum backup registrado" (aviso), com ok=false: crítico', async () => {
    let corpo = await painel();
    expect(corpo.backup).toMatchObject({ situacao: 'nenhum', ultimo: null });
    expect(corpo.situacao).toBe('atencao');
    emitirBackup({ ok: false, erro: 'pg_dump falhou' });
    corpo = await painel();
    expect(corpo.backup.situacao).toBe('falhou');
    expect(corpo.situacao).toBe('critico');
    expect(corpo.alertas[0]).toMatchObject({
      codigo: 'backup_falhou',
      porEmail: true,
    });
  });

  it('R27.2 — número desconectado vira alerta crítico e aparece na lista', async () => {
    const { numero } = await criarCanalWhatsapp(t, {
      nome: 'Vendas',
      status: 'CONECTADO',
      telefone: '5511988887777',
    });
    await t.prisma.whatsappNumero.update({
      where: { id: numero.id },
      data: {
        status: 'DESCONECTADO',
        motivo: 'Desconectado pelo celular',
        desconectadoEm: new Date(Date.now() - 10 * 60_000),
      },
    });
    emitirBackup();
    const corpo = await painel();
    expect(corpo.situacao).toBe('critico');
    expect(corpo.numeros).toHaveLength(1);
    expect(corpo.numeros[0]).toMatchObject({
      nome: 'Vendas',
      status: 'DESCONECTADO',
      comProblema: true,
    });
    expect(corpo.alertas.map((a) => a.codigo)).toEqual(['numero_desconectado']);
  });

  it('R27.1 — job pronto parado há mais de 10 minutos trava a fila', async () => {
    emitirBackup();
    await t.fila.enviar('teste.saude.travada', { x: 1 });
    await t.prisma.$executeRaw`UPDATE pgboss.job
        SET start_after = now() - interval '25 minutes', created_on = now() - interval '25 minutes'
      WHERE name = 'teste.saude.travada'`;
    const corpo = await painel();
    const fila = corpo.filas.itens.find(
      (f) => f.nome === 'teste.saude.travada',
    );
    expect(fila).toMatchObject({ pendentes: 1, travada: true });
    expect(fila?.maisAntigaParadaSegundos).toBeGreaterThanOrEqual(25 * 60);
    expect(corpo.alertas.map((a) => a.chave)).toContain(
      'fila:teste.saude.travada',
    );
  });

  it('R27.5 — canal com erro recente e erros técnicos recentes aparecem no painel', async () => {
    emitirBackup();
    const canal = await criarCanal(t, { tipo: 'EMAIL', nome: 'Caixa suporte' });
    await t.prisma.canal.update({
      where: { id: canal.id },
      data: { ultimoErro: 'IMAP recusou o login', ultimoErroEm: new Date() },
    });
    await t.prisma.logTecnico.create({
      data: { nivel: 'ERRO', contexto: 'HTTP', mensagem: 'Falha de teste' },
    });
    await t.prisma.logTecnico.create({
      data: { nivel: 'INFO', contexto: 'HTTP', mensagem: 'Só informação' },
    });
    const corpo = await painel();
    expect(corpo.canais[0]).toMatchObject({
      nome: 'Caixa suporte',
      comErroRecente: true,
      ultimoErro: 'IMAP recusou o login',
    });
    expect(corpo.erros.total24h).toBe(1);
    expect(corpo.erros.recentes.map((e) => e.mensagem)).toEqual([
      'Falha de teste',
    ]);
    expect(corpo.situacao).toBe('atencao');
  });

  describe('alertas por e-mail', () => {
    const monitorar = () => t.get(AlertasDeSaudeService).monitorar();

    it('R27.7 — backup que falhou avisa todos os Admins ativos, uma vez só', async () => {
      const ana = await criarUsuario(t, { papel: 'ADMIN' });
      const bia = await criarUsuario(t, { papel: 'ADMIN' });
      await t.prisma.usuario.update({
        where: { id: bia.id },
        data: { ativo: false },
      });
      await criarUsuario(t, { papel: 'COMERCIAL' });
      emitirBackup({ ok: false, erro: 'sem espaço' });

      const primeira = await monitorar();
      expect(primeira).toMatchObject({ enviados: 1, destinatarios: 1 });
      expect(t.email.enviados).toHaveLength(1);
      const mensagem = t.email.enviados[0];
      expect(mensagem?.para).toEqual([ana.email]);
      expect(mensagem?.assunto).toContain('backup falhou');
      expect(mensagem?.texto).toContain('sem espaço');

      const segunda = await monitorar();
      expect(segunda.enviados).toBe(0);
      expect(t.email.enviados).toHaveLength(1);
    });

    it('R27.7 — resolvido e de novo com problema: avisa outra vez', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      emitirBackup({ ok: false, erro: 'x' });
      await monitorar();
      emitirBackup();
      await monitorar();
      const registro = await t.prisma.configuracao.findUnique({
        where: { chave: CHAVE_DOS_ALERTAS_ENVIADOS },
      });
      expect(registro?.valor).toEqual({});
      emitirBackup({ ok: false, erro: 'y' });
      await monitorar();
      expect(t.email.enviados).toHaveLength(2);
    });

    it('R27.7 — lembrete só depois de 6 horas', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      emitirBackup({ ok: false, erro: 'x' });
      await monitorar();
      await t.prisma.configuracao.update({
        where: { chave: CHAVE_DOS_ALERTAS_ENVIADOS },
        data: {
          valor: {
            backup: new Date(Date.now() - 7 * 3_600_000).toISOString(),
          },
        },
      });
      await monitorar();
      expect(t.email.enviados).toHaveLength(2);
    });

    it('R27.2 — número que desconecta e fila que trava saem juntos num só e-mail', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      emitirBackup();
      const { numero } = await criarCanalWhatsapp(t, {
        status: 'CONECTADO',
        telefone: '5511977776666',
      });
      await t.prisma.whatsappNumero.update({
        where: { id: numero.id },
        data: {
          status: 'BANIDO',
          motivo: 'Conta banida',
        },
      });
      await t.fila.enviar('teste.saude.parada', {});
      await t.prisma
        .$executeRaw`UPDATE pgboss.job SET start_after = now() - interval '30 minutes'
        WHERE name = 'teste.saude.parada'`;
      const resultado = await monitorar();
      expect(resultado.enviados).toBe(2);
      expect(t.email.enviados).toHaveLength(1);
      expect(t.email.enviados[0]?.assunto).toContain('2 alertas');
    });

    it('R27.7 — sem SMTP nada é enviado nem registrado (volta a tentar depois)', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      emitirBackup({ ok: false, erro: 'x' });
      t.email.configurado = false;
      const sem = await monitorar();
      expect(sem).toMatchObject({ ativos: 1, enviados: 0 });
      expect(t.email.enviados).toHaveLength(0);
      t.email.configurado = true;
      expect((await monitorar()).enviados).toBe(1);
    });

    it('R27.7 — alertas só de tela (sem e-mail) não geram mensagem', async () => {
      await criarUsuario(t, { papel: 'ADMIN' });
      // sem ultimo.json: "nenhum backup registrado"
      const r = await monitorar();
      expect(r).toMatchObject({ ativos: 1, enviados: 0 });
      expect(t.email.enviados).toHaveLength(0);
    });
  });
});
