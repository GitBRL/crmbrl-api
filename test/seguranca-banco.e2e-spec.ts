/**
 * Segurança do banco (R35): a API conecta com o papel próprio da aplicação
 * (sem superusuário, só DML, auditoria só leitura e inclusão) e a RLS é a
 * segunda barreira nas tabelas principais — mesmo uma consulta "errada" (sem
 * filtro) feita pelo papel da aplicação no contexto de uma pessoa só devolve o
 * que ela vê; sem contexto, nada.
 */
import {
  executarComoAtor,
  executarComoSistemaNoBanco,
} from '../src/comum/contexto/contexto-requisicao';
import { funisAcessiveis } from '../src/funis/acessos-no-banco';
import type { Usuario } from '../src/generated/prisma/client';
import { SaudeDoSistemaService } from '../src/saude/monitoramento/saude-do-sistema.service';
import {
  type AppTeste,
  criarAppTeste,
  criarArquivo,
  criarAtividade,
  criarCanal,
  criarChatCanal,
  criarChatMensagem,
  criarContato,
  criarConversa,
  criarEquipe,
  criarFila,
  criarMensagem,
  criarNegocio,
  criarUsuario,
  entrarComo,
  type Equipe,
  funilBase,
} from './utils';

/** Roda `fn` no contexto de uma pessoa, como uma requisição autenticada dela. */
function comoUsuario<T>(pessoa: Usuario, fn: () => Promise<T>): Promise<T> {
  return executarComoAtor(
    {
      tipoAtor: 'USUARIO',
      usuario: { id: pessoa.id, papel: pessoa.papel, nome: pessoa.nome },
    },
    fn,
  );
}

function comoSistema<T>(fn: () => Promise<T>): Promise<T> {
  return executarComoAtor({ tipoAtor: 'SISTEMA', descricao: 'Teste' }, fn);
}

const ids = (linhas: Array<{ id: string }>): string[] =>
  linhas.map(({ id }) => id).sort();

describe('Segurança do banco (R35) (e2e)', () => {
  let t: AppTeste;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  afterAll(() => t.fechar());

  describe('R35.1 — papel próprio da aplicação', () => {
    it('R35.1 — a API conecta com crmbrl_app: sem superusuário nem BYPASSRLS; a Saúde não alerta', async () => {
      await expect(t.apiPrisma.papelDaConexao()).resolves.toEqual({
        usuario: 'crmbrl_app',
        ignoraRls: false,
      });
      const [papel] = await t.prisma.$queryRaw<
        Array<{
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolbypassrls: boolean;
        }>
      >`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'crmbrl_app'`;
      expect(papel).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
      });
      const { alertas } = await t
        .get(SaudeDoSistemaService)
        .consultar(true, new Date());
      expect(alertas.map(({ codigo }) => codigo)).not.toContain(
        'banco_sem_papel_proprio',
      );
      // O dono (superusuário do container de teste) seria alertado.
      const saude = t.get(SaudeDoSistemaService);
      const fatos = await saude.coletar();
      const comDono = saude.montar(
        { ...fatos, papelDoBanco: await t.prisma.papelDaConexao() },
        true,
        new Date(),
      );
      expect(comDono.alertas.map(({ codigo }) => codigo)).toContain(
        'banco_sem_papel_proprio',
      );
    });

    it('R35.1 — a auditoria não aceita UPDATE nem DELETE pelo papel da aplicação (permissão negada), nem com contexto de sistema', async () => {
      const admin = await criarUsuario(t, { papel: 'ADMIN' });
      const cliente = await entrarComo(t, admin);
      await cliente
        .post('/api/v1/contatos', { nome: 'Ana', email: 'ana@r35.local' })
        .expect(201);
      expect(await t.prisma.eventoAuditoria.count()).toBeGreaterThan(0);
      await comoSistema(async () => {
        await expect(
          t.apiPrisma.$executeRawUnsafe(
            'UPDATE eventos_auditoria SET acao = acao',
          ),
        ).rejects.toThrow(/permission denied|permissão negada/i);
        await expect(
          t.apiPrisma.$executeRawUnsafe('DELETE FROM eventos_auditoria'),
        ).rejects.toThrow(/permission denied|permissão negada/i);
        await expect(
          t.apiPrisma.$executeRawUnsafe('TRUNCATE eventos_auditoria'),
        ).rejects.toThrow(/permission denied|permissão negada/i);
        // Ler e incluir continuam (é o que a API faz).
        await expect(
          t.apiPrisma.eventoAuditoria.count(),
        ).resolves.toBeGreaterThan(0);
      });
    });

    it('R35.1 — o papel da aplicação não muda a estrutura do banco (DDL negado)', async () => {
      await comoSistema(async () => {
        await expect(
          t.apiPrisma.$executeRawUnsafe('CREATE TABLE r35_proibida (id int)'),
        ).rejects.toThrow(/permission denied|permissão negada/i);
        await expect(
          t.apiPrisma.$executeRawUnsafe(
            'ALTER TABLE contatos DISABLE ROW LEVEL SECURITY',
          ),
        ).rejects.toThrow(/must be owner|dono/i);
        await expect(
          t.apiPrisma.$executeRawUnsafe('TRUNCATE contatos'),
        ).rejects.toThrow(/permission denied|permissão negada/i);
      });
    });
  });

  describe('R35.2 — RLS nas tabelas principais', () => {
    let comercial: Equipe;
    let marketing: Equipe;
    let a: Usuario;
    let b: Usuario;
    let membroMkt: Usuario;
    let admin: Usuario;
    const dados = {} as Record<string, string>;

    beforeAll(async () => {
      await t.limparBanco();
      admin = await criarUsuario(t, { papel: 'ADMIN' });
      comercial = await criarEquipe(t, 'COMERCIAL', { membros: 2 });
      marketing = await criarEquipe(t, 'MARKETING', {
        membros: 1,
        cLevel: comercial.cLevel,
      });
      [a, b] = comercial.membros;
      [membroMkt] = marketing.membros;

      // Negócios: os do funil-base comercial (SETOR) e um do Marketing.
      dados.nA = (await criarNegocio(t, { responsavel: a })).id;
      dados.nB = (await criarNegocio(t, { responsavel: b })).id;
      dados.nSem = (await criarNegocio(t, { responsavel: null })).id;
      dados.nMkt = (
        await criarNegocio(t, { area: 'MARKETING', responsavel: membroMkt })
      ).id;

      // Atividades (R6.4).
      dados.atvA = (
        await criarAtividade(t, { responsavel: a, criadoPor: a })
      ).id;
      dados.atvB = (
        await criarAtividade(t, { responsavel: b, criadoPor: b })
      ).id;
      dados.atvBdeA = (
        await criarAtividade(t, { responsavel: b, criadoPor: a })
      ).id;
      dados.atvMkt = (
        await criarAtividade(t, {
          responsavel: membroMkt,
          criadoPor: membroMkt,
        })
      ).id;

      // Conversas (R12.5): fila comercial; uma sem fila; uma com o Marketing.
      const fila = await criarFila(t, { area: 'COMERCIAL' });
      const canal = await criarCanal(t);
      dados.cA = (await criarConversa(t, { canal, fila, responsavel: a })).id;
      dados.cB = (await criarConversa(t, { canal, fila, responsavel: b })).id;
      dados.cSem = (await criarConversa(t, { canal, fila })).id;
      dados.cSemFila = (await criarConversa(t, { canal })).id;
      dados.cMkt = (
        await criarConversa(t, { canal, responsavel: membroMkt })
      ).id;

      // Mensagens e mídia (R11.4).
      dados.arqDeA = (await criarArquivo(t, { contexto: 'MENSAGEM' })).id;
      dados.arqDeB = (await criarArquivo(t, { contexto: 'MENSAGEM' })).id;
      dados.mA = (
        await criarMensagem(t, { conversa: dados.cA, arquivo: dados.arqDeA })
      ).id;
      dados.mB = (
        await criarMensagem(t, { conversa: dados.cB, arquivo: dados.arqDeB })
      ).id;
      dados.mSem = (await criarMensagem(t, { conversa: dados.cSem })).id;
      dados.mSemFila = (
        await criarMensagem(t, { conversa: dados.cSemFila })
      ).id;

      // Chat interno: nem o Admin vê o anexo de um canal de que não é membro (R15.3).
      const chat = await criarChatCanal(t, { membros: [a, b] });
      dados.arqChat = (await criarArquivo(t, { contexto: 'CHAT' })).id;
      await criarChatMensagem(t, {
        canal: chat,
        autor: b,
        arquivo: dados.arqChat,
      });
      dados.arqAvatar = (
        await criarArquivo(t, { contexto: 'AVATAR', mime: 'image/png' })
      ).id;
      dados.arqOutro = (await criarArquivo(t, { contexto: 'OUTRO' })).id;

      // Ligações (R29.8): atendente, conversa visível e contato no alcance.
      const contatoDeB = await criarContato(t, { responsavel: b });
      const ligacao = (dadosDaLigacao: object) =>
        t.prisma.ligacao.create({
          data: {
            // 3C+ (R34): não exige canal.
            provedor: 'TRESC_PLUS',
            direcao: 'RECEBIDA',
            estado: 'ENCERRADA',
            contatoId: dados.contatoQualquer,
            ...dadosDaLigacao,
          },
        });
      dados.contatoQualquer = (await criarContato(t)).id;
      dados.lA = (await ligacao({ atendenteId: a.id })).id;
      dados.lConvB = (await ligacao({ conversaId: dados.cB })).id;
      dados.lContatoB = (await ligacao({ contatoId: contatoDeB.id })).id;
    });

    it('R35.2 — sem contexto, nenhuma tabela protegida devolve linhas nem aceita inclusão', async () => {
      const contagens = await Promise.all([
        t.apiPrisma.negocio.count(),
        t.apiPrisma.contato.count(),
        t.apiPrisma.empresa.count(),
        t.apiPrisma.atividade.count(),
        t.apiPrisma.conversa.count(),
        t.apiPrisma.mensagem.count(),
        t.apiPrisma.ligacao.count(),
        t.apiPrisma.arquivo.count(),
      ]);
      expect(contagens).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      const [{ total }] = await t.apiPrisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT (SELECT count(*) FROM negocios) + (SELECT count(*) FROM contatos)
             + (SELECT count(*) FROM conversas) + (SELECT count(*) FROM arquivos) AS total`;
      expect(Number(total)).toBe(0);
      // O dono vê tudo (a RLS não apagou nada).
      expect(await t.prisma.negocio.count()).toBe(4);
      await expect(
        t.apiPrisma.contato.create({
          data: { nome: 'Sem contexto', email: 'sem@r35.local' },
        }),
      ).rejects.toThrow(/row-level security|row level security/i);
      // Requisição sem login: nada das tabelas protegidas.
      const anonimo = await executarComoAtor({ tipoAtor: 'USUARIO' }, () =>
        t.apiPrisma.contato.count(),
      );
      expect(anonimo).toBe(0);
    });

    it('R35.2 — consulta sem filtro no contexto de um membro devolve só o que ele vê, em cada tabela', async () => {
      const vistoPor = (pessoa: Usuario) =>
        comoUsuario(pessoa, async () => ({
          negocios: ids(
            await t.apiPrisma.negocio.findMany({ select: { id: true } }),
          ),
          atividades: ids(
            await t.apiPrisma.atividade.findMany({ select: { id: true } }),
          ),
          conversas: ids(
            await t.apiPrisma.conversa.findMany({ select: { id: true } }),
          ),
          mensagens: ids(
            await t.apiPrisma.mensagem.findMany({ select: { id: true } }),
          ),
          ligacoes: ids(
            await t.apiPrisma.ligacao.findMany({ select: { id: true } }),
          ),
          arquivos: ids(
            await t.apiPrisma.arquivo.findMany({ select: { id: true } }),
          ),
          contatos: await t.apiPrisma.contato.count(),
          empresas: await t.apiPrisma.empresa.count(),
        }));
      const totalDeContatos = await t.prisma.contato.count();
      const totalDeEmpresas = await t.prisma.empresa.count();

      // Membro do Comercial: os seus e os sem responsável (R5.9, R6.4, R12.5, R29.8, R11.4).
      const deA = await vistoPor(a);
      expect(deA.negocios).toEqual([dados.nA, dados.nSem].sort());
      expect(deA.atividades).toEqual([dados.atvA, dados.atvBdeA].sort());
      expect(deA.conversas).toEqual([dados.cA, dados.cSem].sort());
      expect(deA.mensagens).toEqual([dados.mA, dados.mSem].sort());
      expect(deA.ligacoes).toEqual([dados.lA]);
      expect(deA.arquivos).toEqual(
        [dados.arqDeA, dados.arqChat, dados.arqAvatar].sort(),
      );
      expect(deA.contatos).toBe(totalDeContatos);
      expect(deA.empresas).toBe(totalDeEmpresas);

      // O colega: o mesmo recorte, do outro lado.
      const deB = await vistoPor(b);
      expect(deB.negocios).toEqual([dados.nB, dados.nSem].sort());
      expect(deB.atividades).toEqual([dados.atvB, dados.atvBdeA].sort());
      expect(deB.conversas).toEqual([dados.cB, dados.cSem].sort());
      expect(deB.ligacoes).toEqual([dados.lConvB, dados.lContatoB].sort());

      // Líder: o setor inteiro e a equipe; não vê o Marketing nem a conversa sem fila.
      const doLider = await vistoPor(comercial.lider);
      expect(doLider.negocios).toEqual([dados.nA, dados.nB, dados.nSem].sort());
      expect(doLider.atividades).toEqual(
        [dados.atvA, dados.atvB, dados.atvBdeA].sort(),
      );
      expect(doLider.conversas).toEqual(
        [dados.cA, dados.cB, dados.cSem].sort(),
      );
      // A ligação atendida por a sem conversa nem contato da equipe não é do líder (R29.8).
      expect(doLider.ligacoes).toEqual([dados.lConvB, dados.lContatoB].sort());

      // Marketing: não usa o Atendimento — nem a conversa que está com ele (R12.5).
      const doMkt = await vistoPor(membroMkt);
      expect(doMkt.negocios).toEqual([dados.nMkt]);
      expect(doMkt.atividades).toEqual([dados.atvMkt]);
      expect(doMkt.conversas).toEqual([]);
      expect(doMkt.mensagens).toEqual([]);

      // Admin: tudo, menos o anexo do chat de que não é membro (R15.3); só ele vê OUTRO.
      const doAdmin = await vistoPor(admin);
      expect(doAdmin.negocios).toHaveLength(4);
      expect(doAdmin.conversas).toHaveLength(5);
      expect(doAdmin.arquivos).toContain(dados.arqOutro);
      expect(doAdmin.arquivos).not.toContain(dados.arqChat);
      const doCLevel = await vistoPor(comercial.cLevel);
      expect(doCLevel.arquivos).not.toContain(dados.arqOutro);
      expect(doCLevel.negocios).toHaveLength(4);
    });

    it('R35.2 — pelo id também não: o membro não lê, não altera e não exclui linha que não vê', async () => {
      await comoUsuario(a, async () => {
        await expect(
          t.apiPrisma.negocio.findUnique({ where: { id: dados.nB } }),
        ).resolves.toBeNull();
        await expect(
          t.apiPrisma
            .$executeRaw`UPDATE negocios SET titulo = 'invadido' WHERE id = ${dados.nB}::uuid`,
        ).resolves.toBe(0);
        await expect(
          t.apiPrisma
            .$executeRaw`DELETE FROM mensagens WHERE id = ${dados.mB}::uuid`,
        ).resolves.toBe(0);
        await expect(
          t.apiPrisma.atividade.updateMany({
            where: { id: dados.atvB },
            data: { titulo: 'invadida' },
          }),
        ).resolves.toEqual({ count: 0 });
      });
      const negocio = await t.prisma.negocio.findUniqueOrThrow({
        where: { id: dados.nB },
      });
      expect(negocio.titulo).not.toBe('invadido');
      expect(await t.prisma.mensagem.count({ where: { id: dados.mB } })).toBe(
        1,
      );
    });

    it('R35.2 — o membro não cria negócio num funil que não vê', async () => {
      const marketingBase = await funilBase(t, 'MARKETING');
      const contato = await criarContato(t);
      await expect(
        comoUsuario(a, () =>
          t.apiPrisma.negocio.create({
            data: {
              titulo: 'Fora do meu funil',
              contatoId: contato.id,
              funilId: marketingBase.id,
              etapaId: marketingBase.etapas[0].id,
              responsavelId: a.id,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security|row level security/i);
    });

    it('R35.2 — fluxo legítimo: o membro passa o próprio negócio a um colega (e deixa de vê-lo)', async () => {
      const proprio = await criarNegocio(t, { responsavel: a });
      const cliente = await entrarComo(t, a);
      const resposta = await cliente
        .patch(`/api/v1/negocios/${proprio.id}`, { responsavelId: b.id })
        .expect(200);
      expect(resposta.body.responsavel?.id ?? resposta.body.responsavelId).toBe(
        b.id,
      );
      await cliente.get(`/api/v1/negocios/${proprio.id}`).expect(404);
      expect(
        await comoUsuario(a, () =>
          t.apiPrisma.negocio.findUnique({ where: { id: proprio.id } }),
        ),
      ).toBeNull();
    });

    it('R35.2 — fluxo legítimo: quem é responsável (e não criou) passa a atividade a outra pessoa (e deixa de vê-la)', async () => {
      const atividade = await criarAtividade(t, {
        responsavel: b,
        criadoPor: comercial.lider,
      });
      const cliente = await entrarComo(t, b);
      const resposta = await cliente
        .patch(`/api/v1/atividades/${atividade.id}`, { responsavelId: a.id })
        .expect(200);
      expect(resposta.body.responsavel?.id ?? resposta.body.responsavelId).toBe(
        a.id,
      );
      await cliente.get(`/api/v1/atividades/${atividade.id}`).expect(404);
    });

    it('R35.2 — contextos diferentes no mesmo instante não se misturam (cada consulta com o seu)', async () => {
      const [deA, deB, doSistema] = await Promise.all([
        comoUsuario(a, () =>
          t.apiPrisma.negocio.findUnique({ where: { id: dados.nB } }),
        ),
        comoUsuario(b, () =>
          t.apiPrisma.negocio.findUnique({ where: { id: dados.nB } }),
        ),
        executarComoSistemaNoBanco(() =>
          comoUsuario(a, () =>
            t.apiPrisma.negocio.findUnique({ where: { id: dados.nB } }),
          ),
        ),
      ]);
      expect(deA).toBeNull();
      expect(deB?.id).toBe(dados.nB);
      // Dentro de comoUsuario o ator volta a ser a pessoa (o contexto novo vale).
      expect(doSistema).toBeNull();
      const elevado = await comoUsuario(a, () =>
        executarComoSistemaNoBanco(() =>
          t.apiPrisma.negocio.findUnique({ where: { id: dados.nB } }),
        ),
      );
      expect(elevado?.id).toBe(dados.nB);
    });

    it('R35.2 — a transação interativa leva o contexto, e um ROLLBACK não deixa contexto velho na conexão', async () => {
      await expect(
        comoUsuario(a, () =>
          t.apiPrisma.$transaction(async (tx) => {
            const vistos = await tx.negocio.findMany({ select: { id: true } });
            expect(ids(vistos)).toEqual([dados.nA, dados.nSem].sort());
            throw new Error('desfaz');
          }),
        ),
      ).rejects.toThrow('desfaz');
      // Depois: sem contexto, nada; como o líder, o setor.
      expect(await t.apiPrisma.negocio.count()).toBe(0);
      expect(
        await comoUsuario(comercial.lider, () =>
          t.apiPrisma.$transaction((tx) => tx.negocio.count()),
        ),
      ).toBe(
        await t.prisma.negocio.count({
          where: { funil: { area: 'COMERCIAL' } },
        }),
      );
    });

    it('R35.2 — a RLS dos negócios bate com funisAcessiveis (acessos extras, funil restrito, VER)', async () => {
      const comercialBase = await funilBase(t, 'COMERCIAL');
      const marketingBase = await funilBase(t, 'MARKETING');
      const conferir = async (pessoa: Usuario) => {
        const acesso = await funisAcessiveis(t.prisma, pessoa);
        const esperado = ids(
          await t.prisma.negocio.findMany({
            where: acesso.filtroDeNegocios(),
            select: { id: true },
          }),
        );
        const pelaRls = ids(
          await comoUsuario(pessoa, () =>
            t.apiPrisma.negocio.findMany({ select: { id: true } }),
          ),
        );
        expect(pelaRls).toEqual(esperado);
      };
      const pessoas = [a, b, comercial.lider, membroMkt, marketing.lider];

      // 1. Acesso VER de a no funil do Marketing (vê todos os negócios dele).
      await t.prisma.acessoFunil.create({
        data: { funilId: marketingBase.id, usuarioId: a.id, nivel: 'VER' },
      });
      // 2. Acesso GESTOR do setor Marketing nos funis do Comercial (pelo setor).
      await t.prisma.acessoSetor.create({
        data: { areaDono: 'COMERCIAL', area: 'MARKETING', nivel: 'GESTOR' },
      });
      for (const pessoa of pessoas) {
        await conferir(pessoa);
      }
      // 3. Funil comercial restrito: do setor, só o líder e quem está na lista (b como MEMBRO);
      //    o acesso do setor deixa de valer.
      await t.prisma.funil.update({
        where: { id: comercialBase.id },
        data: { visibilidade: 'RESTRITA' },
      });
      await t.prisma.acessoFunil.create({
        data: { funilId: comercialBase.id, usuarioId: b.id, nivel: 'MEMBRO' },
      });
      for (const pessoa of pessoas) {
        await conferir(pessoa);
      }
      // 4. Acesso dado a um setor criado e depois desativado não conta (R5.11).
      await t.prisma.setor.create({
        data: { chave: 'POS_VENDA', nome: 'Pós-venda', ativo: true },
      });
      const lider = await criarUsuario(t, {
        papel: 'LIDER',
        area: 'POS_VENDA' as never,
        lider: comercial.cLevel,
      });
      const membro = await criarUsuario(t, {
        papel: 'MEMBRO',
        area: 'POS_VENDA' as never,
        lider,
      });
      await t.prisma.acessoFunil.create({
        data: { funilId: marketingBase.id, area: 'POS_VENDA', nivel: 'GESTOR' },
      });
      await conferir(membro);
      await t.prisma.setor.update({
        where: { chave: 'POS_VENDA' },
        data: { ativo: false },
      });
      await conferir(membro);
      await t.prisma.funil.update({
        where: { id: comercialBase.id },
        data: { visibilidade: 'SETOR' },
      });
      for (const pessoa of pessoas) {
        await conferir(pessoa);
      }
    });
  });
});
