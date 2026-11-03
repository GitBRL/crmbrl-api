import { AtendimentoService } from '../src/atendimento/atendimento.service';
import { RegistroCanais } from '../src/canais/registro-canais';
import { EVENTO_EMISSAO_TEMPO_REAL } from '../src/tempo-real/tempo-real.publicador';
import {
  type AppTeste,
  criarAppTeste,
  criarArquivo,
  criarCanal,
  criarContato,
  criarConversa,
  criarFila,
  criarIdentificador,
  criarMensagem,
  criarUsuario,
} from './utils';

/**
 * A base do Atendimento (§2.4/§4 do contrato da Onda A): `receber` e
 * `atualizarStatus`, o schema (uma conversa em aberto por contato e canal,
 * contato só com identificador de canal, R4.1) e o registro dos canais.
 */
describe('Atendimento — base (e2e)', () => {
  let t: AppTeste;
  let atendimento: AtendimentoService;

  beforeAll(async () => {
    t = await criarAppTeste();
    atendimento = t.get(AtendimentoService);
  });
  beforeEach(() => t.limparBanco());
  afterAll(() => t.fechar());

  describe('receber', () => {
    it('cenário 18 — R12: cria contato, identificador, conversa (na fila padrão) e mensagem; idempotente pelo id externo', async () => {
      const fila = await criarFila(t, { area: 'COMERCIAL' });
      const canal = await criarCanal(t, { tipo: 'WHATSAPP', filaPadrao: fila });
      const entrada = {
        canalId: canal.id,
        remetente: {
          tipo: 'WHATSAPP' as const,
          valor: '+55 (11) 98888-7777',
          nome: 'Maria',
        },
        idExternoConversa: '5511988887777@s.whatsapp.net',
        mensagem: {
          idExterno: 'WA-1',
          tipo: 'TEXTO' as const,
          texto: 'Oi, quero um orçamento',
          recebidaEm: new Date('2026-10-23T12:00:00Z'),
        },
      };
      const primeira = await atendimento.receber(entrada);
      expect(primeira.nova).toBe(true);

      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: primeira.conversaId },
        include: { contato: { include: { identificadores: true } } },
      });
      expect(conversa).toMatchObject({
        canalId: canal.id,
        filaId: fila.id,
        status: 'ABERTA',
        naoLidas: 1,
        idExterno: '5511988887777@s.whatsapp.net',
        ultimaMensagemId: primeira.mensagemId,
        aguardandoDesde: entrada.mensagem.recebidaEm,
      });
      expect(conversa.contato).toMatchObject({
        nome: 'Maria',
        telefone: '5511988887777',
        primeiraOrigem: 'WHATSAPP',
      });
      expect(conversa.contato.identificadores).toEqual([
        expect.objectContaining({
          tipo: 'WHATSAPP',
          valor: '5511988887777',
          canalId: canal.id,
        }),
      ]);

      const repetida = await atendimento.receber(entrada);
      expect(repetida).toEqual({ ...primeira, nova: false });
      expect(await t.prisma.mensagem.count()).toBe(1);

      const segunda = await atendimento.receber({
        ...entrada,
        mensagem: { ...entrada.mensagem, idExterno: 'WA-2', texto: 'Alguém?' },
      });
      expect(segunda.conversaId).toBe(primeira.conversaId);
      expect(
        (
          await t.prisma.conversa.findUniqueOrThrow({
            where: { id: primeira.conversaId },
          })
        ).naoLidas,
      ).toBe(2);

      // Auditoria e outbox: conversa e contato criados, emissões de tempo real.
      expect(
        await t.prisma.eventoAuditoria.count({
          where: { acao: { in: ['conversa.criada', 'contato.criado'] } },
        }),
      ).toBe(2);
      const tipos = (await t.prisma.eventoDominio.findMany()).map(
        (evento) => evento.tipo,
      );
      expect(tipos).toEqual(
        expect.arrayContaining([
          'conversa.criada',
          'mensagem.recebida',
          EVENTO_EMISSAO_TEMPO_REAL,
        ]),
      );
    });

    it('R4.2 — liga ao contato que já existe pelo telefone e reaproveita o identificador nas próximas', async () => {
      const contato = await criarContato(t, {
        telefone: '11977776666',
        email: null,
      });
      const canal = await criarCanal(t, { tipo: 'WHATSAPP' });
      const resultado = await atendimento.receber({
        canalId: canal.id,
        remetente: { tipo: 'WHATSAPP', valor: '5511977776666' },
        mensagem: { tipo: 'TEXTO', texto: 'oi', recebidaEm: new Date() },
      });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: resultado.conversaId },
      });
      expect(conversa.contatoId).toBe(contato.id);
      expect(await t.prisma.contato.count()).toBe(1);
    });

    it('R4.1 — contato só com o id do Instagram nasce pelo identificador (sem e-mail nem telefone)', async () => {
      const canal = await criarCanal(t, {
        tipo: 'INSTAGRAM',
        nome: 'Instagram da loja',
      });
      const recebidaEm = new Date();
      const resultado = await atendimento.receber({
        canalId: canal.id,
        remetente: { tipo: 'INSTAGRAM', valor: 'IGSID-123', nome: 'joao.ig' },
        mensagem: {
          idExterno: 'mid.1',
          tipo: 'TEXTO',
          texto: 'Oi!',
          recebidaEm,
        },
      });
      const conversa = await t.prisma.conversa.findUniqueOrThrow({
        where: { id: resultado.conversaId },
        include: { contato: true },
      });
      expect(conversa.contato).toMatchObject({
        nome: 'joao.ig',
        email: null,
        telefone: null,
        primeiraOrigem: 'INSTAGRAM',
      });
      // Janela de 24 h da Meta (R14).
      expect(conversa.janelaAte?.getTime()).toBe(
        recebidaEm.getTime() + 24 * 3600_000,
      );
    });

    it('recusa anexo que não existe e canal excluído', async () => {
      const canal = await criarCanal(t);
      await expect(
        atendimento.receber({
          canalId: canal.id,
          remetente: {
            tipo: 'WEBCHAT',
            valor: 'visitante-1',
            email: 'v@x.com',
          },
          mensagem: {
            tipo: 'IMAGEM',
            arquivoId: '00000000-0000-4000-8000-000000000000',
            recebidaEm: new Date(),
          },
        }),
      ).rejects.toMatchObject({ status: 400 });
      await t.prisma.canal.update({
        where: { id: canal.id },
        data: { excluidoEm: new Date() },
      });
      await expect(
        atendimento.receber({
          canalId: canal.id,
          remetente: {
            tipo: 'WEBCHAT',
            valor: 'visitante-1',
            email: 'v@x.com',
          },
          mensagem: { tipo: 'TEXTO', texto: 'oi', recebidaEm: new Date() },
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('mídia recebida já salva entra na mensagem', async () => {
      const canal = await criarCanal(t, { tipo: 'WHATSAPP' });
      const arquivo = await criarArquivo(t, { mime: 'image/png' });
      const { mensagemId } = await atendimento.receber({
        canalId: canal.id,
        remetente: { tipo: 'WHATSAPP', valor: '11966665555' },
        mensagem: {
          tipo: 'IMAGEM',
          arquivoId: arquivo.id,
          recebidaEm: new Date(),
        },
      });
      expect(
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagemId },
          })
        ).arquivoId,
      ).toBe(arquivo.id);
    });
  });

  describe('atualizarStatus', () => {
    it('só avança (ENVIADA → ENTREGUE → LIDA); FALHOU só antes de entregar; desconhecida é ignorada', async () => {
      const conversa = await criarConversa(t);
      const mensagem = await criarMensagem(t, {
        conversa,
        direcao: 'SAIDA',
        idExterno: 'EXT-1',
      });
      const status = async () =>
        (
          await t.prisma.mensagem.findUniqueOrThrow({
            where: { id: mensagem.id },
          })
        ).status;

      await atendimento.atualizarStatus(conversa.canalId, 'EXT-1', 'ENTREGUE');
      expect(await status()).toBe('ENTREGUE');
      await atendimento.atualizarStatus(conversa.canalId, 'EXT-1', 'ENVIADA');
      expect(await status()).toBe('ENTREGUE');
      await atendimento.atualizarStatus(
        conversa.canalId,
        'EXT-1',
        'FALHOU',
        'erro',
      );
      expect(await status()).toBe('ENTREGUE');
      const lida = new Date('2026-10-23T15:00:00Z');
      await atendimento.atualizarStatus(
        conversa.canalId,
        'EXT-1',
        'LIDA',
        undefined,
        lida,
      );
      const final = await t.prisma.mensagem.findUniqueOrThrow({
        where: { id: mensagem.id },
      });
      expect(final).toMatchObject({ status: 'LIDA', lidaEm: lida });
      expect(final.enviadaEm).not.toBeNull();
      expect(final.entregueEm).not.toBeNull();

      await expect(
        atendimento.atualizarStatus(conversa.canalId, 'NAO-EXISTE', 'LIDA'),
      ).resolves.toBeUndefined();

      const outra = await criarMensagem(t, {
        conversa,
        direcao: 'SAIDA',
        idExterno: 'EXT-2',
      });
      await atendimento.atualizarStatus(
        conversa.canalId,
        'EXT-2',
        'FALHOU',
        'Número sem WhatsApp.',
      );
      expect(
        await t.prisma.mensagem.findUniqueOrThrow({ where: { id: outra.id } }),
      ).toMatchObject({ status: 'FALHOU', erro: 'Número sem WhatsApp.' });
    });
  });

  describe('schema da onda', () => {
    it('R12 — uma conversa em aberto por contato e canal (índice único parcial)', async () => {
      const canal = await criarCanal(t);
      const contato = await criarContato(t);
      await criarConversa(t, { canal, contato });
      await expect(
        criarConversa(t, { canal, contato, status: 'PENDENTE' }),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
      await criarConversa(t, { canal, contato, status: 'RESOLVIDA' });
      await criarConversa(t, { canal, contato, status: 'RESOLVIDA' });
    });

    it('R4.1 — contato sem e-mail, telefone nem identificador é recusado no commit; com identificador, aceito', async () => {
      await expect(
        t.prisma.$transaction(async (tx) => {
          await tx.contato.create({
            data: {
              nome: 'Sem meio',
              primeiraOrigem: 'MANUAL',
              ultimaOrigem: 'MANUAL',
            },
          });
        }),
      ).rejects.toThrow();
      const contato = await t.prisma.$transaction(async (tx) => {
        const criado = await tx.contato.create({
          data: {
            nome: 'Só Messenger',
            primeiraOrigem: 'MESSENGER',
            ultimaOrigem: 'MESSENGER',
          },
        });
        await tx.contatoIdentificador.create({
          data: { contatoId: criado.id, tipo: 'MESSENGER', valor: 'PSID-1' },
        });
        return criado;
      });
      // Tirar o último meio de contato também é recusado.
      await expect(
        t.prisma.contatoIdentificador.deleteMany({
          where: { contatoId: contato.id },
        }),
      ).rejects.toThrow();
      // Identificador de WhatsApp precisa estar em E.164 só com dígitos (CHECK).
      await expect(
        criarIdentificador(t, { contato, tipo: 'WHATSAPP', valor: '+55 11 9' }),
      ).rejects.toThrow();
    });

    it('R5.8 (ajuste) — acesso_ativado_em nasce com a senha própria e não volta a nulo', async () => {
      const ativo = await criarUsuario(t);
      expect(ativo.acessoAtivadoEm).not.toBeNull();
      const convidado = await criarUsuario(t, { senha: null });
      expect(convidado.acessoAtivadoEm).toBeNull();
      const temporaria = await criarUsuario(t, { deveTrocarSenha: true });
      expect(temporaria.acessoAtivadoEm).toBeNull();
      const trocou = await t.prisma.usuario.update({
        where: { id: temporaria.id },
        data: { deveTrocarSenha: false, senhaAlteradaEm: new Date() },
      });
      expect(trocou.acessoAtivadoEm).not.toBeNull();
      const deNovo = await t.prisma.usuario.update({
        where: { id: temporaria.id },
        data: { deveTrocarSenha: true },
      });
      expect(deNovo.acessoAtivadoEm).toEqual(trocou.acessoAtivadoEm);
    });
  });

  it('RegistroCanais — todos os tipos de canal têm adaptador registrado', () => {
    expect(t.get(RegistroCanais).tipos().sort()).toEqual(
      [
        'EMAIL',
        'INSTAGRAM',
        'MESSENGER',
        'WEBCHAT',
        'WHATSAPP',
        'WHATSAPP_OFICIAL',
      ].sort(),
    );
  });
});
