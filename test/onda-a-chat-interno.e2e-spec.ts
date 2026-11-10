import {
  FILA_SINCRONIZAR_CHAT,
  SincronizacaoChatService,
} from '../src/chat-interno/sincronizacao-chat.service';
import {
  marcarMencao,
  marcarReferencia,
} from '../src/chat-interno/regras-chat';
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  conectarTempoReal,
  criarAppTeste,
  criarArquivo,
  criarContato,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  entrarComo,
  esperarEvento,
  fecharSockets,
  PNG_DE_TESTE,
  pedirAoTempoReal,
  processarEventos,
  semEvento,
  type SocketDeTeste,
} from './utils';

const API = '/api/v1/chat';

interface CanalDaLista {
  id: string;
  tipo: string;
  nome: string;
  area: string | null;
  automatico: boolean;
  administrador: boolean;
  silenciado: boolean;
  naoLidas: number;
  mencoesNaoLidas: number;
  podeEnviar: boolean;
  podeSair: boolean;
  podeGerenciar: boolean;
  totalMembros: number;
  arquivadoEm: string | null;
  ultimaMensagem: { resumo: string; autorId: string | null } | null;
  outraPessoa: { id: string; nome: string } | null;
}

/**
 * Chat interno da equipe (§2.6 do contrato da Onda A, R15): canais padrão
 * mantidos pelo papel, grupos, diretas privadas, mensagens com anexo, menções
 * que notificam, referências, não lidas, busca e tempo real.
 */
describe('Chat interno (e2e)', () => {
  let t: AppTeste;
  const abertos: SocketDeTeste[] = [];

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(() => t.limparBanco());
  afterEach(() => fecharSockets(...abertos.splice(0)));
  afterAll(() => t.fechar());

  async function conectar(cliente: ClienteHttp): Promise<SocketDeTeste> {
    const socket = await conectarTempoReal(t, cliente);
    abertos.push(socket);
    return socket;
  }

  async function canais(cliente: ClienteHttp): Promise<CanalDaLista[]> {
    const resposta = await cliente.get(`${API}/canais`).expect(200);
    return resposta.body as CanalDaLista[];
  }

  async function geral(cliente: ClienteHttp): Promise<CanalDaLista> {
    const lista = await canais(cliente);
    const canal = lista.find((item) => item.tipo === 'GERAL');
    if (!canal) {
      throw new Error('Sem o canal Geral.');
    }
    return canal;
  }

  async function criarGrupo(
    cliente: ClienteHttp,
    membros: Usuario[],
    nome = 'Lançamento',
  ): Promise<CanalDaLista> {
    const resposta = await cliente
      .post(`${API}/grupos`, { nome, membrosIds: membros.map(({ id }) => id) })
      .expect(201);
    return resposta.body as CanalDaLista;
  }

  async function enviar(
    cliente: ClienteHttp,
    canalId: string,
    corpo: Record<string, unknown>,
    status = 201,
  ) {
    return cliente
      .post(`${API}/canais/${canalId}/mensagens`, corpo)
      .expect(status);
  }

  function sincronizar(usuarioIds?: string[]) {
    return t
      .get(SincronizacaoChatService)
      .sincronizar(usuarioIds ? { usuarioIds } : {});
  }

  // -------------------------------------------------------------------------
  describe('canais padrão (R15.1)', () => {
    it('cenário 31 — cria o Geral e o canal da área para quem abre o chat, pelo papel', async () => {
      const { cLevel, lider, membros } = await criarEquipe(t, 'COMERCIAL', {
        membros: 1,
      });
      const admin = await criarUsuario(t, { papel: 'ADMIN' });

      const doComercial = await canais(await entrarComo(t, membros[0]));
      expect(doComercial.map(({ tipo, nome }) => [tipo, nome])).toEqual([
        ['GERAL', 'Geral'],
        ['AREA', 'Comercial'],
      ]);
      expect(doComercial[0]).toMatchObject({
        automatico: true,
        podeSair: false,
        podeGerenciar: false,
        podeEnviar: true,
      });

      const doCLevel = await canais(await entrarComo(t, cLevel));
      expect(doCLevel.map(({ nome }) => nome)).toEqual([
        'Geral',
        'Comercial',
        'Customer Success',
        'Marketing',
      ]);
      expect(
        (await canais(await entrarComo(t, admin))).map((c) => c.nome),
      ).toEqual(['Geral']);
      expect(
        (await canais(await entrarComo(t, lider))).map((c) => c.nome),
      ).toEqual(['Geral', 'Comercial']);
      expect(await t.prisma.chatCanal.count({ where: { tipo: 'GERAL' } })).toBe(
        1,
      );
    });

    it('o job acerta os membros: entra quem é novo, troca de área quem muda de papel e tira quem é desligado', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      const bia = await criarUsuario(t, { papel: 'CS' });
      await sincronizar();
      const comercial = await t.prisma.chatCanal.findUniqueOrThrow({
        where: { chave: 'area:COMERCIAL' },
      });
      const cs = await t.prisma.chatCanal.findUniqueOrThrow({
        where: { chave: 'area:CS' },
      });
      expect(
        await t.prisma.chatMembro.count({ where: { canalId: comercial.id } }),
      ).toBe(1);

      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { papel: 'MEMBRO', area: 'CS' },
      });
      await t.prisma.usuario.update({
        where: { id: bia.id },
        data: { ativo: false, desligadoEm: new Date() },
      });
      const resultado = await sincronizar();
      expect(resultado.entraram).toEqual([
        { canalId: cs.id, usuarioId: ana.id },
      ]);
      expect(resultado.sairam).toEqual(
        expect.arrayContaining([
          { canalId: comercial.id, usuarioId: ana.id },
          { canalId: cs.id, usuarioId: bia.id },
        ]),
      );
      expect(
        (
          await t.prisma.chatMembro.findMany({
            where: { canalId: cs.id },
            select: { usuarioId: true },
          })
        ).map(({ usuarioId }) => usuarioId),
      ).toEqual([ana.id]);
      // Idempotente.
      expect(await sincronizar()).toEqual({ entraram: [], sairam: [] });
    });

    it('o job agendado roda a sincronização; quem muda de papel troca de canal já no próximo acesso', async () => {
      const ana = await criarUsuario(t, { papel: 'COMERCIAL' });
      await t.fila.enviar(FILA_SINCRONIZAR_CHAT, {});
      expect(await drenarFilas(t, FILA_SINCRONIZAR_CHAT)).toBe(1);
      expect(
        await t.prisma.chatMembro.count({ where: { usuarioId: ana.id } }),
      ).toBe(2);

      const cliente = await entrarComo(t, ana);
      const comercial = (await canais(cliente)).find((c) => c.tipo === 'AREA');
      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { papel: 'MEMBRO', area: 'CS' },
      });
      // Sem esperar o job: o próximo pedido ao chat já acerta.
      expect((await canais(cliente)).map((c) => c.nome)).toEqual([
        'Geral',
        'Customer Success',
      ]);
      await cliente.get(`${API}/canais/${comercial?.id}/mensagens`).expect(404);
      const socket = await conectar(cliente);
      await expect(
        pedirAoTempoReal(socket, 'chat.entrar', { canalId: comercial?.id }),
      ).resolves.toMatchObject({ ok: false });

      // Reativado depois de desligado: volta aos canais padrão.
      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { ativo: false, desligadoEm: new Date() },
      });
      await sincronizar([ana.id]);
      expect(
        await t.prisma.chatMembro.count({ where: { usuarioId: ana.id } }),
      ).toBe(0);
      await t.prisma.usuario.update({
        where: { id: ana.id },
        data: { ativo: true, desligadoEm: null },
      });
      await sincronizar();
      expect(
        await t.prisma.chatMembro.count({ where: { usuarioId: ana.id } }),
      ).toBe(2);
    });

    it('não dá para sair, renomear nem arquivar os canais padrão (só silenciar)', async () => {
      const ana = await entrarComo(t, await criarUsuario(t, { papel: 'CS' }));
      const canal = await geral(ana);
      const sair = await ana.post(`${API}/canais/${canal.id}/sair`).expect(422);
      expect(sair.body.detalhes).toMatchObject({ regra: 'R15.1' });
      expect(sair.body.mensagem).not.toMatch(/R15/);
      await ana
        .patch(`${API}/canais/${canal.id}`, { nome: 'Outro' })
        .expect(422);
      await ana.post(`${API}/canais/${canal.id}/arquivar`).expect(422);
      const silenciado = await ana
        .put(`${API}/canais/${canal.id}/preferencias`, { silenciado: true })
        .expect(200);
      expect(silenciado.body).toMatchObject({ silenciado: true });
    });

    it('desligamento: sai dos canais padrão e dos grupos, com aviso e novo administrador', async () => {
      const admin = await entrarComo(
        t,
        await criarUsuario(t, { papel: 'ADMIN' }),
      );
      const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
        membros: 2,
      });
      const [ana, bruno] = membros;
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno, lider]);
      await sincronizar();

      await admin.post(`/api/v1/usuarios/${ana.id}/desligar`, {}).expect(200);
      await processarEventos(t);

      expect(
        await t.prisma.chatMembro.count({ where: { usuarioId: ana.id } }),
      ).toBe(0);
      const restantes = await t.prisma.chatMembro.findMany({
        where: { canalId: grupo.id },
        orderBy: { criadoEm: 'asc' },
      });
      expect(restantes.map(({ usuarioId }) => usuarioId).sort()).toEqual(
        [bruno.id, lider.id].sort(),
      );
      expect(restantes.filter((m) => m.administrador)).toHaveLength(1);
      const aviso = await t.prisma.chatMensagem.findFirstOrThrow({
        where: { canalId: grupo.id, autorId: null },
        orderBy: { criadoEm: 'desc' },
      });
      expect(aviso.texto).toContain(marcarMencao(ana.id));
      expect(aviso.texto).toContain('não está mais no CRM');
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: 'chat_canal.membros_removidos', entidadeId: grupo.id },
        }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('grupos (R15.2)', () => {
    it('quem cria administra; só administrador renomeia, adiciona e tira pessoas', async () => {
      const [ana, bruno, carla, dani] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'CS', nome: 'Bruno' }),
        criarUsuario(t, { papel: 'MARKETING', nome: 'Carla' }),
        criarUsuario(t, { papel: 'MARKETING', nome: 'Dani' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      expect(grupo).toMatchObject({
        tipo: 'GRUPO',
        nome: 'Lançamento',
        administrador: true,
        podeGerenciar: true,
        podeSair: true,
        totalMembros: 2,
      });
      const criacao = await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'chat_canal.criado', entidadeId: grupo.id },
      });
      expect(criacao.usuarioId).toBe(ana.id);

      await clienteBruno
        .patch(`${API}/canais/${grupo.id}`, { nome: 'Meu' })
        .expect(403);
      const renomeado = await clienteAna
        .patch(`${API}/canais/${grupo.id}`, {
          nome: 'Lançamento de novembro',
          descricao: 'Combinados',
        })
        .expect(200);
      expect(renomeado.body).toMatchObject({
        nome: 'Lançamento de novembro',
        descricao: 'Combinados',
      });

      const adicionados = await clienteAna
        .post(`${API}/canais/${grupo.id}/membros`, {
          usuariosIds: [carla.id, dani.id, bruno.id],
        })
        .expect(200);
      expect(adicionados.body).toHaveLength(4);
      await clienteAna
        .delete(`${API}/canais/${grupo.id}/membros/${dani.id}`)
        .expect(204);
      await clienteBruno
        .delete(`${API}/canais/${grupo.id}/membros/${carla.id}`)
        .expect(403);

      const desligada = await criarUsuario(t, {
        papel: 'CS',
        ativo: false,
      });
      const recusa = await clienteAna
        .post(`${API}/canais/${grupo.id}/membros`, {
          usuariosIds: [desligada.id],
        })
        .expect(409);
      expect(recusa.body.detalhes).toMatchObject({
        usuarioIds: [desligada.id],
      });

      const mensagens = await clienteBruno
        .get(`${API}/canais/${grupo.id}/mensagens`)
        .expect(200);
      expect(
        (
          mensagens.body.itens as Array<{
            sistema: boolean;
            partes: Array<{ texto: string }>;
          }>
        )
          .filter((m) => m.sistema)
          .map((m) => m.partes.map((p) => p.texto).join('')),
      ).toEqual([
        '@Ana criou o grupo.',
        '@Ana renomeou o grupo para "Lançamento de novembro".',
        '@Ana adicionou @Carla e @Dani.',
        '@Ana removeu @Dani do grupo.',
      ]);
      // Avisos do sistema não contam como não lidas.
      expect(
        (await canais(clienteBruno)).find((c) => c.id === grupo.id),
      ).toMatchObject({
        naoLidas: 0,
      });
      // Quem saiu não vê mais o grupo.
      const clienteDani = await entrarComo(t, dani);
      await clienteDani.get(`${API}/canais/${grupo.id}`).expect(404);
    });

    it('sempre há alguém administrando: o último não perde a administração; quem sai passa ao mais antigo', async () => {
      const [ana, bruno, carla] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL' }),
        criarUsuario(t, { papel: 'COMERCIAL' }),
        criarUsuario(t, { papel: 'COMERCIAL' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      await clienteAna
        .post(`${API}/canais/${grupo.id}/membros`, { usuariosIds: [carla.id] })
        .expect(200);
      const ultimo = await clienteAna
        .patch(`${API}/canais/${grupo.id}/membros/${ana.id}`, {
          administrador: false,
        })
        .expect(422);
      expect(ultimo.body.detalhes).toMatchObject({ regra: 'R15.2' });

      await clienteAna.post(`${API}/canais/${grupo.id}/sair`).expect(204);
      const membros = await t.prisma.chatMembro.findMany({
        where: { canalId: grupo.id },
      });
      expect(membros.find((m) => m.usuarioId === bruno.id)?.administrador).toBe(
        true,
      );
      expect(membros.find((m) => m.usuarioId === carla.id)?.administrador).toBe(
        false,
      );
      await clienteAna.get(`${API}/canais/${grupo.id}`).expect(404);

      // O último a sair deixa o grupo arquivado.
      await (
        await entrarComo(t, bruno)
      )
        .post(`${API}/canais/${grupo.id}/sair`)
        .expect(204);
      await (
        await entrarComo(t, carla)
      )
        .post(`${API}/canais/${grupo.id}/sair`)
        .expect(204);
      const vazio = await t.prisma.chatCanal.findUniqueOrThrow({
        where: { id: grupo.id },
      });
      expect(vazio.arquivadoEm).not.toBeNull();
    });

    it('grupo arquivado fica só para leitura até desarquivar', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'CS' }),
        criarUsuario(t, { papel: 'CS' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      const arquivado = await clienteAna
        .post(`${API}/canais/${grupo.id}/arquivar`)
        .expect(200);
      expect(arquivado.body).toMatchObject({ podeEnviar: false });
      expect(arquivado.body.arquivadoEm).not.toBeNull();
      const recusa = await enviar(
        await entrarComo(t, bruno),
        grupo.id,
        { texto: 'oi' },
        422,
      );
      expect(recusa.body.detalhes).toMatchObject({ regra: 'R15.2' });
      await clienteAna
        .patch(`${API}/canais/${grupo.id}`, { nome: 'X' })
        .expect(422);
      await clienteAna
        .post(`${API}/canais/${grupo.id}/desarquivar`)
        .expect(200);
      await enviar(clienteAna, grupo.id, { texto: 'voltamos' });
    });
  });

  // -------------------------------------------------------------------------
  describe('conversas diretas (R15.3)', () => {
    it('cenário 31 — uma por par, privada: nem o Admin vê a conversa, as mensagens ou o anexo', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'CS', nome: 'Bruno' }),
      ]);
      const admin = await entrarComo(t, await criarUsuario(t));
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);

      const primeira = await clienteAna
        .post(`${API}/diretas`, { usuarioId: bruno.id })
        .expect(200);
      expect(primeira.body).toMatchObject({
        criada: true,
        canal: {
          tipo: 'DIRETO',
          nome: 'Bruno',
          outraPessoa: { id: bruno.id, nome: 'Bruno' },
          podeSair: false,
        },
      });
      const canalId = primeira.body.canal.id as string;
      const segunda = await clienteBruno
        .post(`${API}/diretas`, { usuarioId: ana.id })
        .expect(200);
      expect(segunda.body).toMatchObject({
        criada: false,
        canal: { id: canalId, nome: 'Ana' },
      });

      const anexo = await clienteAna
        .post('/api/v1/arquivos?contexto=CHAT')
        .attach('arquivo', PNG_DE_TESTE, {
          filename: 'print.png',
          contentType: 'image/png',
        })
        .expect(201);
      await enviar(clienteAna, canalId, {
        texto: 'segredo',
        arquivoId: anexo.body.id,
      });

      await admin.get(`${API}/canais/${canalId}`).expect(404);
      await admin.get(`${API}/canais/${canalId}/mensagens`).expect(404);
      await enviar(admin, canalId, { texto: 'oi' }, 404);
      await admin.get(`/api/v1/arquivos/${anexo.body.id}`).expect(404);
      await clienteBruno.get(`/api/v1/arquivos/${anexo.body.id}`).expect(200);
      const busca = await admin
        .get(`${API}/mensagens/busca?texto=segredo`)
        .expect(200);
      expect(busca.body.total).toBe(0);
      // A auditoria guarda só quem e quando, nunca o conteúdo.
      const auditoria = await t.prisma.eventoAuditoria.findMany({
        where: { entidadeId: canalId },
      });
      expect(auditoria.length).toBeGreaterThan(0);
      expect(
        JSON.stringify(
          auditoria.map(({ resumo, dados }) => ({ resumo, dados })),
        ),
      ).not.toContain('segredo');
      expect(
        await t.prisma.chatCanal.count({ where: { tipo: 'DIRETO' } }),
      ).toBe(1);

      const sozinho = await clienteAna
        .post(`${API}/diretas`, { usuarioId: ana.id })
        .expect(422);
      expect(sozinho.body.detalhes).toMatchObject({ regra: 'R15.3' });
    });

    it('com a outra pessoa desligada, a conversa fica só para leitura', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const direta = await clienteAna
        .post(`${API}/diretas`, { usuarioId: bruno.id })
        .expect(200);
      await t.prisma.usuario.update({
        where: { id: bruno.id },
        data: { ativo: false, desligadoEm: new Date() },
      });
      const canal = await clienteAna
        .get(`${API}/canais/${direta.body.canal.id}`)
        .expect(200);
      expect(canal.body).toMatchObject({
        podeEnviar: false,
        motivoSemEnvio:
          'Bruno não está mais no CRM: a conversa fica só para leitura.',
      });
      await enviar(clienteAna, direta.body.canal.id, { texto: 'oi' }, 422);
      // Nova direta com quem saiu também não.
      const outra = await criarUsuario(t, { papel: 'CS', ativo: false });
      await clienteAna
        .post(`${API}/diretas`, { usuarioId: outra.id })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  describe('mensagens (R15.4)', () => {
    it('envia, responde, edita e exclui as próprias; não mexe nas dos outros', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const grupo = await criarGrupo(clienteAna, [bruno]);

      await enviar(clienteAna, grupo.id, { texto: '   ' }, 400);
      const primeira = await enviar(clienteAna, grupo.id, {
        texto: '  Bom dia\r\nequipe  ',
      });
      expect(primeira.body).toMatchObject({
        texto: 'Bom dia\nequipe',
        autor: { id: ana.id, nome: 'Ana', papel: 'MEMBRO', area: 'COMERCIAL' },
        sistema: false,
        excluida: false,
        editadaEm: null,
        partes: [{ tipo: 'texto', texto: 'Bom dia\nequipe' }],
      });
      const resposta = await enviar(clienteBruno, grupo.id, {
        texto: 'Bom dia!',
        respostaAId: primeira.body.id,
      });
      expect(resposta.body.respostaA).toMatchObject({
        id: primeira.body.id,
        autor: 'Ana',
        resumo: 'Bom dia equipe',
        excluida: false,
      });

      await clienteBruno
        .patch(`${API}/mensagens/${primeira.body.id}`, { texto: 'invadido' })
        .expect(403);
      await clienteBruno
        .delete(`${API}/mensagens/${primeira.body.id}`)
        .expect(403);
      const editada = await clienteAna
        .patch(`${API}/mensagens/${primeira.body.id}`, { texto: 'Boa tarde' })
        .expect(200);
      expect(editada.body.texto).toBe('Boa tarde');
      expect(editada.body.editadaEm).not.toBeNull();

      await clienteAna
        .delete(`${API}/mensagens/${primeira.body.id}`)
        .expect(204);
      await clienteAna
        .delete(`${API}/mensagens/${primeira.body.id}`)
        .expect(204);
      const guardada = await t.prisma.chatMensagem.findUniqueOrThrow({
        where: { id: primeira.body.id as string },
      });
      expect(guardada).toMatchObject({ texto: null });
      expect(guardada.excluidaEm).not.toBeNull();
      await clienteAna
        .patch(`${API}/mensagens/${primeira.body.id}`, { texto: 'volta' })
        .expect(422);

      const historico = await clienteBruno
        .get(`${API}/canais/${grupo.id}/mensagens`)
        .expect(200);
      const itens = historico.body.itens as Array<{
        id: string;
        excluida: boolean;
        texto: string | null;
        respostaA: { resumo: string; excluida: boolean } | null;
      }>;
      expect(itens.find((m) => m.id === primeira.body.id)).toMatchObject({
        excluida: true,
        texto: null,
      });
      expect(
        itens.find((m) => m.id === resposta.body.id)?.respostaA,
      ).toMatchObject({ resumo: 'Mensagem excluída', excluida: true });
      // Não dá para responder a uma excluída.
      await enviar(
        clienteBruno,
        grupo.id,
        { texto: 'e aí?', respostaAId: primeira.body.id },
        422,
      );
    });

    it('anexo: só o arquivo do chat enviado por quem escreve, uma vez; a exclusão remove o arquivo', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'CS' }),
        criarUsuario(t, { papel: 'CS' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const grupo = await criarGrupo(clienteAna, [bruno]);

      const doBruno = await criarArquivo(t, {
        contexto: 'CHAT',
        criadoPor: bruno,
      });
      await enviar(clienteAna, grupo.id, { arquivoId: doBruno.id }, 404);
      const deMensagem = await criarArquivo(t, {
        contexto: 'MENSAGEM',
        criadoPor: ana,
      });
      const contexto = await enviar(
        clienteAna,
        grupo.id,
        { arquivoId: deMensagem.id },
        422,
      );
      expect(contexto.body.detalhes).toMatchObject({ regra: 'R15.4' });

      const anexo = await criarArquivo(t, {
        contexto: 'CHAT',
        criadoPor: ana,
        mime: 'application/pdf',
      });
      const comAnexo = await enviar(clienteAna, grupo.id, {
        arquivoId: anexo.id,
      });
      expect(comAnexo.body).toMatchObject({
        texto: null,
        partes: [],
        anexo: {
          id: anexo.id,
          nome: 'documento.pdf',
          url: `/api/v1/arquivos/${anexo.id}`,
        },
      });
      await enviar(clienteAna, grupo.id, { arquivoId: anexo.id }, 409);
      await clienteBruno.get(`/api/v1/arquivos/${anexo.id}`).expect(200);
      const lista = await canais(clienteBruno);
      expect(
        lista.find((c) => c.id === grupo.id)?.ultimaMensagem,
      ).toMatchObject({
        resumo: 'Anexo: documento.pdf',
      });

      // Quem não é do grupo não baixa.
      const outro = await entrarComo(t, await criarUsuario(t, { papel: 'CS' }));
      await outro.get(`/api/v1/arquivos/${anexo.id}`).expect(404);

      await clienteAna
        .delete(`${API}/mensagens/${comAnexo.body.id}`)
        .expect(204);
      const removido = await t.prisma.arquivo.findUniqueOrThrow({
        where: { id: anexo.id },
      });
      expect(removido.removidoEm).not.toBeNull();
      await clienteBruno.get(`/api/v1/arquivos/${anexo.id}`).expect(404);
    });

    it('histórico com rolagem: últimas, antesDe, depoisDe e aoRedorDe', async () => {
      const ana = await criarUsuario(t, { papel: 'CS' });
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, []);
      const ids: string[] = [];
      for (let indice = 1; indice <= 7; indice++) {
        const enviada = await enviar(clienteAna, grupo.id, {
          texto: `m${indice}`,
        });
        ids.push(enviada.body.id as string);
      }
      const textos = (corpo: {
        itens: Array<{ texto: string | null; sistema: boolean }>;
      }) => corpo.itens.filter((m) => !m.sistema).map((m) => m.texto);

      const ultimas = await clienteAna
        .get(`${API}/canais/${grupo.id}/mensagens?limite=3`)
        .expect(200);
      expect(textos(ultimas.body)).toEqual(['m5', 'm6', 'm7']);
      expect(ultimas.body).toMatchObject({
        temAnteriores: true,
        temPosteriores: false,
      });
      const anteriores = await clienteAna
        .get(`${API}/canais/${grupo.id}/mensagens?limite=3&antesDe=${ids[4]}`)
        .expect(200);
      expect(textos(anteriores.body)).toEqual(['m2', 'm3', 'm4']);
      const posteriores = await clienteAna
        .get(`${API}/canais/${grupo.id}/mensagens?limite=10&depoisDe=${ids[4]}`)
        .expect(200);
      expect(textos(posteriores.body)).toEqual(['m6', 'm7']);
      expect(posteriores.body.temPosteriores).toBe(false);
      const meio = await clienteAna
        .get(`${API}/canais/${grupo.id}/mensagens?limite=3&aoRedorDe=${ids[3]}`)
        .expect(200);
      expect(textos(meio.body)).toEqual(['m3', 'm4', 'm5']);
      expect(meio.body).toMatchObject({
        temAnteriores: true,
        temPosteriores: true,
      });
      await clienteAna
        .get(
          `${API}/canais/${grupo.id}/mensagens?antesDe=${ids[1]}&depoisDe=${ids[2]}`,
        )
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('menções (R15.5) e referências (R15.6)', () => {
    it('cenário 31 — menção notifica quem é mencionado (com link), só membros; edição notifica só as novas', async () => {
      const [ana, bruno, carla, fora] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Carla' }),
        criarUsuario(t, { papel: 'CS', nome: 'Fora' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno, carla], 'Time');

      const naoMembro = await enviar(
        clienteAna,
        grupo.id,
        { texto: `oi ${marcarMencao(fora.id)}` },
        422,
      );
      expect(naoMembro.body.detalhes).toMatchObject({
        regra: 'R15.5',
        usuarioIds: [fora.id],
      });

      const mensagem = await enviar(clienteAna, grupo.id, {
        texto: `${marcarMencao(bruno.id)} viu? ${marcarMencao(ana.id)}`,
      });
      expect(mensagem.body.partes).toEqual([
        { tipo: 'mencao', texto: '@Bruno', usuarioId: bruno.id },
        { tipo: 'texto', texto: ' viu? ' },
        { tipo: 'mencao', texto: '@Ana', usuarioId: ana.id },
      ]);
      expect(mensagem.body.mencoes).toEqual([bruno.id, ana.id]);
      const notificacoes = await t.prisma.notificacao.findMany({
        where: { tipo: 'chat.mencao' },
      });
      expect(notificacoes).toHaveLength(1);
      expect(notificacoes[0]).toMatchObject({
        usuarioId: bruno.id,
        titulo: 'Ana mencionou você no grupo Time',
        texto: '@Bruno viu? @Ana',
        link: `/chat/${grupo.id}?mensagem=${mensagem.body.id}`,
      });

      await clienteAna
        .patch(`${API}/mensagens/${mensagem.body.id}`, {
          texto: `${marcarMencao(bruno.id)} e ${marcarMencao(carla.id)}`,
        })
        .expect(200);
      expect(
        (
          await t.prisma.notificacao.findMany({
            where: { tipo: 'chat.mencao' },
            select: { usuarioId: true },
          })
        )
          .map(({ usuarioId }) => usuarioId)
          .sort(),
      ).toEqual([bruno.id, carla.id].sort());
    });

    it('no Geral, menciona quem nunca abriu o chat (sincroniza antes de conferir)', async () => {
      const [ana, novato] = await Promise.all([
        criarUsuario(t, { papel: 'CS', nome: 'Ana' }),
        criarUsuario(t, { papel: 'MARKETING', nome: 'Novato' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const canal = await geral(clienteAna);
      await enviar(clienteAna, canal.id, {
        texto: `Bem-vindo, ${marcarMencao(novato.id)}!`,
      });
      expect(
        await t.prisma.notificacao.count({
          where: { usuarioId: novato.id, tipo: 'chat.mencao' },
        }),
      ).toBe(1);
      // Entrou no Geral antes da mensagem: ela conta como não lida, com a menção.
      const doNovato = await geral(await entrarComo(t, novato));
      expect(doNovato).toMatchObject({ naoLidas: 1, mencoesNaoLidas: 1 });
    });

    it('se algo é recusado, nada fica: nem mensagem, nem notificação, nem evento', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'CS' }),
        criarUsuario(t, { papel: 'CS' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      const antes = {
        mensagens: await t.prisma.chatMensagem.count(),
        eventos: await t.prisma.eventoDominio.count({
          where: { tipo: { startsWith: 'chat_mensagem.' } },
        }),
      };
      await enviar(
        clienteAna,
        grupo.id,
        {
          texto: `${marcarMencao(bruno.id)} ${marcarReferencia('negocio', '00000000-0000-4000-8000-000000000000')}`,
        },
        422,
      );
      expect(await t.prisma.chatMensagem.count()).toBe(antes.mensagens);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: { startsWith: 'chat_mensagem.' } },
        }),
      ).toBe(antes.eventos);
      expect(await t.prisma.notificacao.count()).toBe(0);
    });

    it('referências viram links; só itens que existem e que a pessoa vê', async () => {
      const { lider, membros } = await criarEquipe(t, 'COMERCIAL', {
        membros: 1,
      });
      const comercial = membros[0];
      const contato = await criarContato(t, { nome: 'Maria Souza' });
      const negocio = await criarNegocio(t, {
        contato,
        area: 'COMERCIAL',
        responsavel: comercial,
        titulo: 'ACME — implantação',
      });
      const doMarketing = await criarNegocio(t, {
        contato,
        area: 'MARKETING',
        titulo: 'Lead do Marketing',
      });
      const clienteMembro = await entrarComo(t, comercial);
      const grupo = await criarGrupo(clienteMembro, [lider]);

      const enviada = await enviar(clienteMembro, grupo.id, {
        texto: `Olha ${marcarReferencia('negocio', negocio.id)} da ${marcarReferencia('contato', contato.id)}`,
      });
      expect(enviada.body.partes).toEqual([
        { tipo: 'texto', texto: 'Olha ' },
        {
          tipo: 'referencia',
          texto: 'ACME — implantação',
          referencia: {
            tipo: 'negocio',
            id: negocio.id,
            titulo: 'ACME — implantação',
            link: `/funis/${negocio.funilId}?negocio=${negocio.id}`,
            disponivel: true,
          },
        },
        { tipo: 'texto', texto: ' da ' },
        {
          tipo: 'referencia',
          texto: 'Maria Souza',
          referencia: {
            tipo: 'contato',
            id: contato.id,
            titulo: 'Maria Souza',
            link: `/contatos/${contato.id}`,
            disponivel: true,
          },
        },
      ]);
      expect(enviada.body.referencias).toHaveLength(2);

      const invisivel = await enviar(
        clienteMembro,
        grupo.id,
        { texto: `e ${marcarReferencia('negocio', doMarketing.id)}` },
        422,
      );
      expect(invisivel.body.detalhes).toMatchObject({ regra: 'R15.6' });
      await enviar(
        clienteMembro,
        grupo.id,
        {
          texto: `e ${marcarReferencia('empresa', '00000000-0000-4000-8000-000000000000')}`,
        },
        422,
      );

      // Item excluído depois: a referência fica indisponível (sem link).
      await t.prisma.contato.update({
        where: { id: contato.id },
        data: { excluidoEm: new Date() },
      });
      const historico = await (
        await entrarComo(t, lider)
      )
        .get(`${API}/canais/${grupo.id}/mensagens`)
        .expect(200);
      const comReferencia = (
        historico.body.itens as Array<{
          id: string;
          partes: Array<{
            tipo: string;
            texto: string;
            referencia?: { disponivel: boolean; link: string | null };
          }>;
        }>
      ).find((m) => m.id === enviada.body.id);
      expect(comReferencia?.partes[3]).toMatchObject({
        texto: 'item indisponível',
        referencia: { disponivel: false, link: null },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('não lidas, silenciar e busca', () => {
    it('conta as mensagens dos outros depois da última leitura; silenciado só conta menções', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      // Quem escreve leu o canal até a própria mensagem.
      await enviar(clienteBruno, grupo.id, { texto: 'minha' });
      await enviar(clienteAna, grupo.id, { texto: 'um' });
      await enviar(clienteAna, grupo.id, { texto: 'dois' });

      expect(
        (await clienteBruno.get(`${API}/nao-lidas`).expect(200)).body,
      ).toEqual({
        total: 2,
        canais: [
          { canalId: grupo.id, naoLidas: 2, mencoes: 0, silenciado: false },
        ],
      });
      expect(
        (await clienteAna.get(`${API}/nao-lidas`).expect(200)).body.total,
      ).toBe(0);

      await clienteBruno
        .put(`${API}/canais/${grupo.id}/preferencias`, { silenciado: true })
        .expect(200);
      expect(
        (await clienteBruno.get(`${API}/nao-lidas`).expect(200)).body.total,
      ).toBe(0);
      await enviar(clienteAna, grupo.id, {
        texto: `${marcarMencao(bruno.id)} urgente`,
      });
      const comMencao = await clienteBruno.get(`${API}/nao-lidas`).expect(200);
      expect(comMencao.body).toMatchObject({
        total: 1,
        canais: [{ naoLidas: 3, mencoes: 1, silenciado: true }],
      });

      const lido = await clienteBruno
        .post(`${API}/canais/${grupo.id}/leitura`, {})
        .expect(200);
      expect(lido.body).toMatchObject({ naoLidas: 0, mencoesNaoLidas: 0 });
      expect(
        (await clienteBruno.get(`${API}/nao-lidas`).expect(200)).body,
      ).toEqual({ total: 0, canais: [] });
    });

    it('busca sem acentos só nos canais da pessoa e fora das marcações', async () => {
      const [ana, bruno, carla] = await Promise.all([
        criarUsuario(t, { papel: 'CS', nome: 'Ana' }),
        criarUsuario(t, { papel: 'CS', nome: 'Bruno' }),
        criarUsuario(t, { papel: 'CS', nome: 'Carla' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const grupo = await criarGrupo(clienteAna, [bruno], 'Propostas');
      const contato = await criarContato(t, { nome: 'Negócio Fictício' });
      await enviar(clienteAna, grupo.id, {
        texto: 'Revisar a Proposta da ACME',
      });
      await enviar(clienteAna, grupo.id, {
        texto: `ver ${marcarReferencia('contato', contato.id)}`,
      });
      const direta = await (
        await entrarComo(t, carla)
      )
        .post(`${API}/diretas`, { usuarioId: bruno.id })
        .expect(200);
      await enviar(await entrarComo(t, carla), direta.body.canal.id, {
        texto: 'proposta secreta',
      });

      const resultado = await (
        await entrarComo(t, bruno)
      )
        .get(`${API}/mensagens/busca?texto=propósta`)
        .expect(200);
      expect(resultado.body.total).toBe(2);
      expect(
        (resultado.body.itens as Array<{ canal: { nome: string } }>).map(
          (item) => item.canal.nome,
        ),
      ).toEqual(['Carla', 'Propostas']);
      const daAna = await clienteAna
        .get(`${API}/mensagens/busca?texto=proposta`)
        .expect(200);
      expect(daAna.body.total).toBe(1);
      const marcacao = await clienteAna
        .get(`${API}/mensagens/busca?texto=contato`)
        .expect(200);
      expect(marcacao.body.total).toBe(0);
      await clienteAna.get(`${API}/mensagens/busca?texto=a`).expect(400);
    });

    it('diretório de pessoas: só ativas, com busca sem acento', async () => {
      const ana = await criarUsuario(t, { papel: 'CS', nome: 'Ana Júlia' });
      await criarUsuario(t, { papel: 'CS', nome: 'Antônio', ativo: false });
      await criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' });
      const cliente = await entrarComo(t, ana);
      const todas = await cliente.get(`${API}/pessoas`).expect(200);
      expect(todas.body.total).toBe(2);
      const busca = await cliente.get(`${API}/pessoas?busca=julia`).expect(200);
      expect(busca.body.itens).toEqual([
        expect.objectContaining({
          id: ana.id,
          nome: 'Ana Júlia',
          rotuloPapel: 'Customer Success',
          area: 'CS',
          ativo: true,
        }),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  describe('tempo real', () => {
    it('chat.mensagem na sala do canal; chat.atualizado e nao-lidas para cada membro; nada para quem não é membro', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Ana' }),
        criarUsuario(t, { papel: 'COMERCIAL', nome: 'Bruno' }),
      ]);
      const admin = await criarUsuario(t);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const direta = await clienteAna
        .post(`${API}/diretas`, { usuarioId: bruno.id })
        .expect(200);
      const canalId = direta.body.canal.id as string;
      await processarEventos(t);

      const socketAna = await conectar(clienteAna);
      const socketBruno = await conectar(clienteBruno);
      const socketAdmin = await conectar(await entrarComo(t, admin));
      await expect(
        pedirAoTempoReal(socketAna, 'chat.entrar', { canalId }),
      ).resolves.toEqual({ ok: true });
      await expect(
        pedirAoTempoReal(socketAdmin, 'chat.entrar', { canalId }),
      ).resolves.toMatchObject({ ok: false, erro: 'sem_permissao' });
      // Entrar numa sala sincroniza os canais padrão (Geral, área): esses
      // avisos saem antes do que o teste espera.
      await processarEventos(t);

      const naSala = esperarEvento(socketAna, 'chat.mensagem');
      const listaDoBruno = esperarEvento(socketBruno, 'chat.atualizado');
      const contagemDoBruno = esperarEvento(socketBruno, 'nao-lidas');
      const nadaParaOAdmin = semEvento(socketAdmin, 'chat.atualizado', 500);
      const enviada = await enviar(clienteAna, canalId, { texto: 'oi Bruno' });
      await processarEventos(t);

      await expect(naSala).resolves.toMatchObject({
        canalId,
        mensagem: { id: enviada.body.id, texto: 'oi Bruno' },
      });
      await expect(listaDoBruno).resolves.toMatchObject({
        canalId,
        canal: {
          id: canalId,
          nome: 'Ana',
          naoLidas: 1,
          ultimaMensagem: { resumo: 'oi Bruno' },
        },
      });
      await expect(contagemDoBruno).resolves.toEqual({ chat: 1 });
      await nadaParaOAdmin;

      // Ler atualiza as outras abas na hora (sem outbox).
      const zerado = esperarEvento(socketBruno, 'nao-lidas');
      await clienteBruno
        .post(`${API}/canais/${canalId}/leitura`, {})
        .expect(200);
      await expect(zerado).resolves.toEqual({ chat: 0 });

      // Edição e exclusão também chegam na sala.
      const edicao = esperarEvento(socketAna, 'chat.mensagem');
      await clienteAna
        .patch(`${API}/mensagens/${enviada.body.id}`, { texto: 'oi, Bruno!' })
        .expect(200);
      await processarEventos(t);
      await expect(edicao).resolves.toMatchObject({
        mensagem: { id: enviada.body.id, texto: 'oi, Bruno!' },
      });
      const exclusao = esperarEvento(socketAna, 'chat.mensagem');
      await clienteAna
        .delete(`${API}/mensagens/${enviada.body.id}`)
        .expect(204);
      await processarEventos(t);
      await expect(exclusao).resolves.toMatchObject({
        mensagem: { id: enviada.body.id, excluida: true, texto: null },
      });
    });

    it('quem é tirado do grupo recebe removido e sai da sala chat:<id>', async () => {
      const [ana, bruno] = await Promise.all([
        criarUsuario(t, { papel: 'CS' }),
        criarUsuario(t, { papel: 'CS' }),
      ]);
      const clienteAna = await entrarComo(t, ana);
      const clienteBruno = await entrarComo(t, bruno);
      const grupo = await criarGrupo(clienteAna, [bruno]);
      await processarEventos(t);
      const socketBruno = await conectar(clienteBruno);
      await expect(
        pedirAoTempoReal(socketBruno, 'chat.entrar', { canalId: grupo.id }),
      ).resolves.toEqual({ ok: true });
      await processarEventos(t);

      const removido = esperarEvento(socketBruno, 'chat.atualizado');
      await clienteAna
        .delete(`${API}/canais/${grupo.id}/membros/${bruno.id}`)
        .expect(204);
      await processarEventos(t);
      // O aviso do sistema ("removeu") e a mudança do canal chegam juntos; o
      // que importa ao Bruno é o `removido`.
      const recebidos: unknown[] = [await removido];
      if (!(recebidos[0] as { removido?: boolean }).removido) {
        recebidos.push(await esperarEvento(socketBruno, 'chat.atualizado'));
      }
      expect(recebidos).toContainEqual({ canalId: grupo.id, removido: true });

      const depois = semEvento(socketBruno, 'chat.mensagem', 500);
      await enviar(clienteAna, grupo.id, { texto: 'sem o Bruno' });
      await processarEventos(t);
      await depois;
    });
  });
});
