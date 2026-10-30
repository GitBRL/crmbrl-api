import { NotificacoesService } from '../src/notificacoes/notificacoes.service';
import { salas } from '../src/tempo-real/catalogo';
import { OuvinteDoBanco } from '../src/tempo-real/ouvinte-do-banco';
import { TempoRealPublicador } from '../src/tempo-real/tempo-real.publicador';
import {
  type AppTeste,
  conectarTempoReal,
  criarAppTeste,
  criarChatCanal,
  criarConversa,
  criarFila,
  criarUsuario,
  entrarComo,
  esperarDesconexao,
  esperarEvento,
  fecharSockets,
  pedirAoTempoReal,
  processarEventos,
  semEvento,
  type SocketDeTeste,
  tentarConectarTempoReal,
} from './utils';

/**
 * Tempo real (§2.2 do contrato da Onda A): Socket.IO em `/api/socket.io`,
 * namespace `/tempo-real`, com um cliente `socket.io-client` de verdade
 * autenticado pelo cookie `crmbrl_sessao`.
 */
describe('Tempo real (e2e)', () => {
  let t: AppTeste;
  const abertos: SocketDeTeste[] = [];

  async function conectar(cliente: {
    cookie?: string;
  }): Promise<SocketDeTeste> {
    const socket = await conectarTempoReal(t, cliente);
    abertos.push(socket);
    return socket;
  }

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterEach(() => fecharSockets(...abertos.splice(0)));
  afterAll(() => t.fechar());

  describe('conexão', () => {
    it('conecta com o cookie da sessão e entra nas salas do usuário, do papel e da área', async () => {
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const socket = await conectar(await entrarComo(t, usuario));
      expect(socket.connected).toBe(true);
      expect(await t.tempoReal.estaConectado(usuario.id)).toBe(true);

      for (const sala of [
        salas.usuario(usuario.id),
        salas.papel('COMERCIAL'),
        salas.area('COMERCIAL'),
      ]) {
        const chegou = esperarEvento(socket, 'nao-lidas');
        t.tempoReal.emitir(sala, 'nao-lidas', { chat: 3 });
        await expect(chegou).resolves.toEqual({ chat: 3 });
      }
    });

    it('cenário 32 — recusa a conexão sem cookie ou com sessão inválida (nao_autenticado)', async () => {
      await expect(
        tentarConectarTempoReal(t, undefined),
      ).resolves.toMatchObject({ conectado: false, erro: 'nao_autenticado' });
      await expect(
        tentarConectarTempoReal(t, 'token-que-nao-existe'),
      ).resolves.toMatchObject({ conectado: false, erro: 'nao_autenticado' });
    });

    it('recusa origem fora de ORIGENS_PERMITIDAS ou sem origem (origem_nao_permitida)', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      await expect(
        tentarConectarTempoReal(t, cliente, {
          origem: 'https://site-malicioso.example',
        }),
      ).resolves.toMatchObject({
        conectado: false,
        erro: 'origem_nao_permitida',
      });
      await expect(
        tentarConectarTempoReal(t, cliente, { origem: null }),
      ).resolves.toMatchObject({
        conectado: false,
        erro: 'origem_nao_permitida',
      });
    });

    it('recusa quem tem troca de senha pendente (R2.7)', async () => {
      const usuario = await criarUsuario(t, { deveTrocarSenha: true });
      await expect(
        tentarConectarTempoReal(t, await entrarComo(t, usuario)),
      ).resolves.toMatchObject({
        conectado: false,
        erro: 'troca_de_senha_pendente',
      });
    });

    it('cenário 32 — R2.4: sair (sessão revogada) derruba o socket na hora, com sessao.encerrada', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const socket = await conectar(cliente);
      const encerrada = esperarEvento(socket, 'sessao.encerrada');
      const caiu = esperarDesconexao(socket);
      await cliente.post('/api/v1/auth/sair').expect(204);
      await expect(encerrada).resolves.toEqual({ motivo: 'sessao_revogada' });
      await expect(caiu).resolves.toBe('io server disconnect');
    });

    it('R12.5 — trocar o papel do usuário derruba o socket, para reconectar nas salas do papel novo', async () => {
      const admin = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'ADMIN' }),
      );
      const liderMarketing = await criarUsuario(t, {
        papel: 'LIDER_MARKETING',
      });
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const socket = await conectar(await entrarComo(t, usuario));
      const caiu = esperarDesconexao(socket);
      await admin
        .patch(`/api/v1/usuarios/${usuario.id}`, {
          papel: 'MARKETING',
          liderId: liderMarketing.id,
        })
        .expect(200);
      await expect(caiu).resolves.toBe('io server disconnect');

      const novo = await conectar(await entrarComo(t, usuario));
      const naAreaAntiga = semEvento(novo, 'nao-lidas');
      t.tempoReal.emitir(salas.area('COMERCIAL'), 'nao-lidas', { chat: 1 });
      await naAreaAntiga;
    });

    it('a varredura derruba o socket de uma sessão que expirou', async () => {
      const cliente = await entrarComo(t, await criarUsuario(t));
      const socket = await conectar(cliente);
      await t.prisma.sessao.updateMany({
        where: { usuarioId: cliente.usuario!.id },
        data: { expiraEm: new Date(Date.now() - 1_000) },
      });
      const caiu = esperarDesconexao(socket);
      await expect(t.get(OuvinteDoBanco).varrerSessoes()).resolves.toBe(1);
      await caiu;
    });
  });

  describe('emissões', () => {
    it('notificação nova chega na hora como notificacao.nova, com a contagem do sino', async () => {
      const usuario = await criarUsuario(t, { papel: 'CS' });
      const socket = await conectar(await entrarComo(t, usuario));
      const nova = esperarEvento(socket, 'notificacao.nova');
      const contagem = esperarEvento(socket, 'nao-lidas');
      const notificacao = await t.prisma.$transaction((tx) =>
        t.get(NotificacoesService).notificar(tx, usuario.id, {
          tipo: 'negocio.atribuido',
          titulo: 'Novo lead para você',
          link: '/funis/cs',
        }),
      );
      await expect(nova).resolves.toMatchObject({
        notificacao: { id: notificacao.id, titulo: 'Novo lead para você' },
      });
      await expect(contagem).resolves.toEqual({ notificacoes: 1 });
    });

    it('R10.1 — emitirAposCommit só emite depois do commit (pela outbox) e nada se a transação desfaz', async () => {
      const usuario = await criarUsuario(t, { papel: 'COMERCIAL' });
      const socket = await conectar(await entrarComo(t, usuario));
      const publicador = t.get(TempoRealPublicador);

      await t.prisma.$transaction((tx) =>
        publicador.emitirAposCommit(tx, {
          salas: salas.usuario(usuario.id),
          evento: 'nao-lidas',
          dados: { atendimento: 2 },
        }),
      );
      await semEvento(socket, 'nao-lidas', 200);
      const chegou = esperarEvento(socket, 'nao-lidas');
      await processarEventos(t);
      await expect(chegou).resolves.toEqual({ atendimento: 2 });

      await expect(
        t.prisma.$transaction(async (tx) => {
          await publicador.emitirAposCommit(tx, {
            salas: salas.usuario(usuario.id),
            evento: 'nao-lidas',
            dados: { atendimento: 99 },
          });
          throw new Error('desfaz');
        }),
      ).rejects.toThrow('desfaz');
      await processarEventos(t);
      await semEvento(socket, 'nao-lidas', 200);
    });
  });

  describe('salas pedidas pelo cliente', () => {
    it('cenário 32 — R12: conversa.entrar: quem vê a conversa entra; quem não vê recebe sem_permissao', async () => {
      const fila = await criarFila(t, { area: 'COMERCIAL' });
      const conversa = await criarConversa(t, { fila });
      const comercial = await conectar(
        await entrarComo(t, await criarUsuario(t, { papel: 'COMERCIAL' })),
      );
      const cs = await conectar(
        await entrarComo(t, await criarUsuario(t, { papel: 'CS' })),
      );
      const marketing = await conectar(
        await entrarComo(
          t,
          await criarUsuario(t, { papel: 'LIDER_MARKETING' }),
        ),
      );

      await expect(
        pedirAoTempoReal(comercial, 'conversa.entrar', {
          conversaId: conversa.id,
        }),
      ).resolves.toEqual({ ok: true });
      for (const socket of [cs, marketing]) {
        await expect(
          pedirAoTempoReal(socket, 'conversa.entrar', {
            conversaId: conversa.id,
          }),
        ).resolves.toMatchObject({ ok: false, erro: 'sem_permissao' });
      }
      await expect(
        pedirAoTempoReal(comercial, 'conversa.entrar', {
          conversaId: 'nao-e-uuid',
        }),
      ).resolves.toMatchObject({ ok: false, erro: 'dados_invalidos' });

      const chegou = esperarEvento(comercial, 'conversa.atualizada');
      const naoChega = semEvento(cs, 'conversa.atualizada');
      t.tempoReal.emitir(salas.conversa(conversa.id), 'conversa.atualizada', {
        conversa: { id: conversa.id },
      });
      await expect(chegou).resolves.toEqual({ conversa: { id: conversa.id } });
      await naoChega;

      await expect(
        pedirAoTempoReal(comercial, 'conversa.sair', {
          conversaId: conversa.id,
        }),
      ).resolves.toEqual({ ok: true });
      const depoisDeSair = semEvento(comercial, 'conversa.atualizada');
      t.tempoReal.emitir(salas.conversa(conversa.id), 'conversa.atualizada', {
        conversa: { id: conversa.id },
      });
      await depoisDeSair;
    });

    it('R15 — chat.entrar só para membros do canal (nem o Admin entra numa conversa direta)', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const bia = await criarUsuario(t, { papel: 'CS' });
      const direto = await criarChatCanal(t, {
        tipo: 'DIRETO',
        membros: [ana, bia],
      });
      const socketAna = await conectar(await entrarComo(t, ana));
      const socketAdmin = await conectar(
        await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' })),
      );
      await expect(
        pedirAoTempoReal(socketAna, 'chat.entrar', { canalId: direto.id }),
      ).resolves.toEqual({ ok: true });
      await expect(
        pedirAoTempoReal(socketAdmin, 'chat.entrar', { canalId: direto.id }),
      ).resolves.toMatchObject({ ok: false, erro: 'sem_permissao' });
    });

    it('digitando é repassado aos outros da sala (não ao autor) e exige estar na sala', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' });
      const bia = await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bia' });
      const grupo = await criarChatCanal(t, { membros: [ana, bia] });
      const socketAna = await conectar(await entrarComo(t, ana));
      const socketBia = await conectar(await entrarComo(t, bia));

      await expect(
        pedirAoTempoReal(socketAna, 'digitando', { canalId: grupo.id }),
      ).resolves.toMatchObject({ ok: false, erro: 'sem_permissao' });

      for (const socket of [socketAna, socketBia]) {
        await expect(
          pedirAoTempoReal(socket, 'chat.entrar', { canalId: grupo.id }),
        ).resolves.toEqual({ ok: true });
      }
      const paraBia = esperarEvento(socketBia, 'digitando');
      const naoParaAna = semEvento(socketAna, 'digitando');
      await expect(
        pedirAoTempoReal(socketAna, 'digitando', {
          canalId: grupo.id,
          ativo: true,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(paraBia).resolves.toEqual({
        canalId: grupo.id,
        ativo: true,
        usuario: { id: ana.id, nome: 'Ana' },
      });
      await naoParaAna;
    });
  });
});
