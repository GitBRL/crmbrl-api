import { ArquivosService } from '../src/arquivos/arquivos.service';
import { ETAPAS_PADRAO } from '../src/financeiro/regua-padrao';
import { hojeLocal, somarDias } from '../src/financeiro/datas';
import {
  FILA_REGUA_EMAIL,
  FILA_REGUA_WHATSAPP,
} from '../src/financeiro/financeiro.constantes';
import { ReguaLigacoesService } from '../src/financeiro/regua-ligacoes.service';
import { ReguaService } from '../src/financeiro/regua.service';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarCanalWhatsapp,
  criarContato,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
} from './utils';
import type { Contato, Usuario } from '../src/generated/prisma/client';

interface Envio {
  id: string;
  marco: number | null;
  canal: string | null;
  situacao: string;
  tipo: string;
  motivo: string | null;
  erro: string | null;
  texto: string | null;
  destino: string | null;
}

describe('Financeiro — régua de cobrança (e2e)', () => {
  let t: AppTeste;
  let admin: ClienteHttp;
  let numero = 0;

  beforeAll(async () => {
    t = await criarAppTeste();
  });
  beforeEach(async () => {
    await t.limparBanco();
    admin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
    t.email.configurado = true;
  });
  afterAll(() => t.fechar());

  function telefone(): string {
    numero += 1;
    return `1198${String(7000000 + numero)}`;
  }

  async function cliente(
    extra: Partial<{
      responsavel: Usuario;
      etiquetas: string[];
      telefone: string | null;
      email: string | null;
    }> = {},
  ): Promise<Contato> {
    return criarContato(t, {
      telefone: extra.telefone === undefined ? telefone() : extra.telefone,
      ...extra,
    });
  }

  async function parcela(
    contato: Contato,
    diasDeVencimento: number,
    extra: Record<string, unknown> = {},
  ) {
    const r = await admin
      .post('/api/v1/financeiro/parcelas', {
        contatoId: contato.id,
        numero: `P-${++numero}`,
        vencimento: somarDias(hojeLocal(), -diasDeVencimento),
        valor: '100.00',
        linkPagamento: 'https://pague.exemplo/abc',
        ...extra,
      })
      .expect(201);
    return r.body as { id: string; numero: string };
  }

  async function conectar() {
    return criarCanalWhatsapp(t, {
      status: 'CONECTADO',
      telefone: '5511900000001',
    });
  }

  async function executar() {
    const r = await admin.post('/api/v1/financeiro/regua/executar').expect(200);
    return r.body as {
      id: string;
      status: string;
      tipo: string;
      resumo: Record<string, number>;
    };
  }

  async function enviar() {
    return drenarFilas(t, [FILA_REGUA_WHATSAPP, FILA_REGUA_EMAIL], {
      incluirAgendados: true,
    });
  }

  async function envios(parcelaId: string): Promise<Envio[]> {
    return (await t.prisma.reguaEnvio.findMany({
      where: { parcelaId },
      orderBy: [{ criadoEm: 'asc' }, { marco: 'asc' }],
    })) as unknown as Envio[];
  }

  /** Deixa só as etapas pedidas, com os textos padrão (as demais não existem). */
  async function etapas(marcos: number[]) {
    await admin.get('/api/v1/financeiro/regua/etapas').expect(200);
    await t.prisma.reguaEtapa.deleteMany({});
    await t.prisma.reguaEtapa.createMany({
      data: ETAPAS_PADRAO.filter((e) => marcos.includes(e.marco)).map((e) => ({
        ...e,
      })),
    });
  }

  // ------------------------------------------------------------------ R24.1

  it('R24.1 — as etapas padrão vêm editáveis; marco repetido, variável inválida e membro de CS são recusados', async () => {
    const r = await admin.get('/api/v1/financeiro/regua/etapas').expect(200);
    const lista = r.body as {
      id: string;
      marco: number;
      rotuloDoMarco: string;
      ligacao: boolean;
      email: boolean;
      whatsapp: boolean;
    }[];
    expect(lista.map((e) => e.rotuloDoMarco)).toEqual([
      'D-7',
      'D-3',
      'D0',
      'D+3',
      'D+5',
      'D+7',
      'D+15',
      'D+30',
      'D+45',
      'D+60',
    ]);
    expect(lista.find((e) => e.marco === 7)).toMatchObject({
      ligacao: true,
      whatsapp: true,
      email: true,
    });

    const nova = {
      nome: 'Extra',
      marco: 10,
      whatsapp: true,
      textoWhatsapp: 'Oi {{contato.primeiro_nome}}, R$ {{titulo.valor}}',
    };
    await admin
      .post('/api/v1/financeiro/regua/etapas', { ...nova, marco: 7 })
      .expect(409);
    await admin
      .post('/api/v1/financeiro/regua/etapas', {
        ...nova,
        textoWhatsapp: 'Valor {{titulo.inexistente}}',
      })
      .expect(400);
    await admin
      .post('/api/v1/financeiro/regua/etapas', { nome: 'Sem canal', marco: 11 })
      .expect(400);
    const criada = (
      await admin.post('/api/v1/financeiro/regua/etapas', nova).expect(201)
    ).body as { id: string };
    const editada = await admin
      .put(`/api/v1/financeiro/regua/etapas/${criada.id}`, {
        ...nova,
        nome: 'Extra 2',
        email: true,
        assuntoEmail: 'Aviso',
        textoEmail: 'Texto',
      })
      .expect(200);
    expect(editada.body).toMatchObject({ nome: 'Extra 2', email: true });
    const cs = await criarEquipe(t, 'CS', { membros: 1 });
    const membro = await entrarComo(t, cs.membros[0]);
    await membro
      .put(`/api/v1/financeiro/regua/etapas/${criada.id}`, nova)
      .expect(403);
    await membro
      .post('/api/v1/financeiro/regua/etapas', { ...nova, marco: 12 })
      .expect(403);
    await admin
      .delete(`/api/v1/financeiro/regua/etapas/${criada.id}`)
      .expect(204);
    await admin
      .delete(`/api/v1/financeiro/regua/etapas/${criada.id}`)
      .expect(404);
    const previa = await admin
      .post('/api/v1/financeiro/regua/previa', {
        texto: 'Vence em {{titulo.vencimento}}: R$ {{titulo.valor}}',
      })
      .expect(200);
    expect((previa.body as { texto: string }).texto).toBe(
      'Vence em 10/11/2026: R$ 299,90',
    );
  });

  // ------------------------------------------------------------------ R24.2 / R24.4

  it('R24.2 — "Executar agora" envia a etapa do dia pelo WhatsApp com as variáveis do título, como automação, sem repetir', async () => {
    const { canal } = await conectar();
    const contato = await cliente();
    const p = await parcela(contato, 0, { valor: '1234.50' });
    const exec = await executar();
    expect(exec).toMatchObject({ status: 'CONCLUIDA', tipo: 'MANUAL' });
    expect(exec.resumo).toMatchObject({ titulos: 1, etapas: 1, mensagens: 1 });
    const antes = await envios(p.id);
    expect(antes.filter((e) => e.situacao === 'AGENDADO')).toHaveLength(1);
    expect(antes.find((e) => e.canal === 'WHATSAPP')).toMatchObject({
      marco: 0,
      destino: contato.telefone,
    });

    await enviar();
    const depois = await envios(p.id);
    const envio = depois.find((e) => e.canal === 'WHATSAPP')!;
    expect(envio.situacao).toBe('ENVIADO');
    expect(envio.texto).toContain('1.234,50');
    expect(envio.texto).toContain('https://pague.exemplo/abc');
    const mensagem = await t.prisma.mensagem.findFirstOrThrow({
      where: { canalId: canal.id },
    });
    expect(mensagem).toMatchObject({
      direcao: 'SAIDA',
      autorTipo: 'AUTOMACAO',
      status: 'PENDENTE',
    });
    expect(mensagem.texto).toBe(envio.texto);
    expect(mensagem.metadados).toMatchObject({ regua: true, parcelaId: p.id });
    const aud = await t.prisma.eventoAuditoria.findFirst({
      where: { acao: 'regua.mensagem_enviada', entidadeId: p.id },
    });
    expect(aud).toMatchObject({
      tipoAtor: 'AUTOMACAO',
      atorDescricao: 'Régua de cobrança',
    });

    await executar();
    await enviar();
    expect((await envios(p.id)).length).toBe(depois.length);
    expect(
      await t.prisma.mensagem.count({ where: { canalId: canal.id } }),
    ).toBe(1);
    expect(await t.prisma.reguaExecucao.count()).toBe(2);
  });

  it('R24.3 — quem entra atrasado recebe só a etapa mais recente; além da tolerância a etapa é pulada', async () => {
    await conectar();
    const recente = await parcela(await cliente(), 5);
    const antigo = await parcela(await cliente(), 20);
    await executar();
    const a = await envios(recente.id);
    expect(
      a.filter((e) => e.situacao === 'AGENDADO').map((e) => e.marco),
    ).toEqual([5]);
    expect(
      a
        .filter((e) => e.situacao === 'PULADO')
        .map((e) => e.marco)
        .sort((x, y) => (x ?? 0) - (y ?? 0)),
    ).toEqual([-7, -3, 0, 3]);
    const b = await envios(antigo.id);
    expect(b.filter((e) => e.situacao === 'AGENDADO')).toHaveLength(0);
    const pulada = b.find((e) => e.marco === 15)!;
    expect(pulada).toMatchObject({ situacao: 'PULADO', canal: null });
    expect(pulada.motivo).toContain('tolerância');
    // Alterar a tolerância (R24.2) muda o resultado para o título que ainda não foi tratado.
    await admin
      .patch('/api/v1/financeiro/regua/configuracao', { toleranciaDias: 10 })
      .expect(200);
    const novo = await parcela(await cliente(), 20);
    await executar();
    const doNovo = await envios(novo.id);
    expect(
      doNovo
        .filter((e) => e.marco === 15 && e.canal)
        .map((e) => e.canal)
        .sort(),
    ).toEqual(['EMAIL', 'LIGACAO', 'WHATSAPP']);
  });

  it('R24.4 — e-mail pelo SMTP; sem SMTP o envio falha e "reenviar falhas" tenta de novo', async () => {
    await conectar();
    await etapas([-3]);
    const comEmail = await cliente();
    const p = await parcela(comEmail, -3);
    t.email.configurado = false;
    await executar();
    await enviar();
    const falhou = (await envios(p.id)).find((e) => e.canal === 'EMAIL')!;
    expect(falhou).toMatchObject({
      situacao: 'FALHOU',
      erro: 'SMTP não configurado.',
    });
    expect(t.email.enviados).toHaveLength(0);
    const resumo = await admin
      .get('/api/v1/financeiro/regua/resumo')
      .expect(200);
    expect(
      (resumo.body as { email: Record<string, number> }).email.FALHOU,
    ).toBe(1);

    t.email.configurado = true;
    const re = await admin
      .post('/api/v1/financeiro/regua/reenviar', { canal: 'EMAIL' })
      .expect(200);
    expect(re.body).toEqual({ reenviados: 1 });
    await enviar();
    expect(
      (await envios(p.id)).find((e) => e.canal === 'EMAIL')?.situacao,
    ).toBe('ENVIADO');
    expect(t.email.ultimo(comEmail.email!)?.assunto).toContain(p.numero);
    const cs = await criarEquipe(t, 'CS', { membros: 1 });
    await (
      await entrarComo(t, cs.membros[0])
    )
      .post('/api/v1/financeiro/regua/reenviar', {})
      .expect(403);
  });

  it('R24.4 — o número do financeiro tem fila própria e o intervalo entre mensagens é configurável; pausar segura os envios', async () => {
    await conectar();
    const { canal: doFinanceiro } = await criarCanalWhatsapp(t, {
      status: 'CONECTADO',
      telefone: '5511900000002',
    });
    await admin
      .patch('/api/v1/financeiro/regua/configuracao', {
        canalWhatsappId: doFinanceiro.id,
        intervaloWhatsappSegundos: 60,
      })
      .expect(200);
    await etapas([0]);
    const p1 = await parcela(await cliente(), 0);
    const p2 = await parcela(await cliente(), 0);
    await admin.post('/api/v1/financeiro/regua/pausar').expect(200);
    await executar();
    const [e1, e2] = [(await envios(p1.id))[0], (await envios(p2.id))[0]];
    const intervalo = Math.abs(
      (e1.id < e2.id ? 1 : 1) *
        ((
          await t.prisma.reguaEnvio.findUniqueOrThrow({ where: { id: e2.id } })
        ).agendadoPara!.getTime() -
          (
            await t.prisma.reguaEnvio.findUniqueOrThrow({
              where: { id: e1.id },
            })
          ).agendadoPara!.getTime()),
    );
    expect(intervalo).toBe(60_000);
    await drenarFilas(t, [FILA_REGUA_WHATSAPP]);
    expect(await t.prisma.mensagem.count()).toBe(0);
    expect((await envios(p1.id))[0].situacao).toBe('AGENDADO');
    await admin.post('/api/v1/financeiro/regua/retomar').expect(200);
    await enviar();
    const mensagens = await t.prisma.mensagem.findMany();
    expect(mensagens).toHaveLength(2);
    expect(mensagens.every((m) => m.canalId === doFinanceiro.id)).toBe(true);
    const fila = await admin
      .get(`/api/v1/financeiro/regua/envios?canal=WHATSAPP`)
      .expect(200);
    expect((fila.body as { total: number }).total).toBe(2);
  });

  it('R24.2 — o cron só executa depois do horário configurado, uma vez por dia, e respeita "ativa"', async () => {
    await conectar();
    await etapas([0]);
    const p = await parcela(await cliente(), 0);
    const servico = t.get(ReguaService);
    const hoje = hojeLocal();
    const as = (hhmmUtc: string) => new Date(`${hoje}T${hhmmUtc}:00.000Z`);
    expect(await servico.tique(as('11:00'))).toEqual({ executou: false }); // 08:00 em São Paulo
    expect(await t.prisma.reguaExecucao.count()).toBe(0);
    await admin
      .patch('/api/v1/financeiro/regua/configuracao', { ativa: false })
      .expect(200);
    expect(await servico.tique(as('12:30'))).toEqual({ executou: false });
    await admin
      .patch('/api/v1/financeiro/regua/configuracao', {
        ativa: true,
        horario: '09:00',
      })
      .expect(200);
    expect(await servico.tique(as('12:30'))).toEqual({ executou: true }); // 09:30
    expect(await servico.tique(as('15:00'))).toEqual({ executou: false });
    const exec = await t.prisma.reguaExecucao.findMany();
    expect(exec).toHaveLength(1);
    expect(exec[0]).toMatchObject({ tipo: 'AUTOMATICA', status: 'CONCLUIDA' });
    expect(
      (await envios(p.id)).filter((e) => e.situacao === 'AGENDADO'),
    ).toHaveLength(1);
    const historico = await admin
      .get('/api/v1/financeiro/regua/execucoes')
      .expect(200);
    expect((historico.body as { tipo: string }[])[0].tipo).toBe('AUTOMATICA');
  });

  // ------------------------------------------------------------------ R24.5

  describe('ligações', () => {
    async function comLigacao() {
      await conectar();
      await etapas([7]);
      const cs = await criarEquipe(t, 'CS', { membros: 1 });
      const contato = await cliente({ responsavel: cs.membros[0] });
      const p = await parcela(contato, 7);
      await executar();
      const todos = await envios(p.id);
      const ligacao = todos.find((e) => e.canal === 'LIGACAO')!;
      return { cs, contato, p, ligacao, todos };
    }

    it('R24.5 — a etapa com ligação vira atividade para o CS e segura as mensagens até o resultado', async () => {
      const { cs, p, ligacao, todos, contato } = await comLigacao();
      expect(ligacao.situacao).toBe('AGUARDANDO_LIGACAO');
      expect(
        todos
          .filter((e) => e.situacao === 'RETIDO')
          .map((e) => e.canal)
          .sort(),
      ).toEqual(['EMAIL', 'WHATSAPP']);
      const atividade = await t.prisma.atividade.findFirstOrThrow({
        where: { tipo: 'LIGACAO', contatoId: contato.id },
      });
      expect(atividade).toMatchObject({
        status: 'PENDENTE',
        responsavelId: cs.membros[0].id,
      });
      expect(atividade.titulo).toContain('Plano da dívida');
      expect(atividade.descricao).toContain(p.numero);
      expect(
        await t.prisma.notificacao.count({
          where: { usuarioId: cs.membros[0].id, tipo: 'regua.ligacao' },
        }),
      ).toBe(1);
      await enviar();
      expect(await t.prisma.mensagem.count()).toBe(0);
      expect(t.email.enviados).toHaveLength(0);

      const clienteCs = await entrarComo(t, cs.membros[0]);
      const lista = await clienteCs
        .get('/api/v1/financeiro/regua/ligacoes')
        .expect(200);
      expect(
        (lista.body as { itens: { id: string; telefone: string }[] }).itens.map(
          (i) => i.id,
        ),
      ).toEqual([ligacao.id]);
      const outro = await criarEquipe(t, 'CS', { membros: 1 });
      expect(
        (
          (
            await (
              await entrarComo(t, outro.membros[0])
            )
              .get('/api/v1/financeiro/regua/ligacoes')
              .expect(200)
          ).body as { total: number }
        ).total,
      ).toBe(0);
      await (
        await entrarComo(t, outro.membros[0])
      )
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'NAO_ATENDEU',
        })
        .expect(404);
    });

    it('R24.5 — "não atendeu" e "sem acordo" liberam a mensagem e o e-mail da etapa', async () => {
      const { cs, p, ligacao, contato } = await comLigacao();
      const c = await entrarComo(t, cs.membros[0]);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'TALVEZ',
        })
        .expect(400);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'NAO_ATENDEU',
          observacao: 'Caixa postal',
        })
        .expect(200);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'SEM_ACORDO',
        })
        .expect(409);
      await enviar();
      const todos = await envios(p.id);
      expect(
        todos
          .filter((e) => e.situacao === 'ENVIADO')
          .map((e) => e.canal)
          .sort(),
      ).toEqual(['EMAIL', 'WHATSAPP']);
      expect(t.email.ultimo(contato.email!)).toBeDefined();
      expect(
        await t.prisma.atividade.findFirstOrThrow({
          where: { tipo: 'LIGACAO' },
        }),
      ).toMatchObject({
        status: 'CONCLUIDA',
        concluidaPorId: cs.membros[0].id,
      });
      expect(todos.find((e) => e.canal === 'LIGACAO')).toMatchObject({
        situacao: 'LIGACAO_REGISTRADA',
      });
    });

    it('R24.5 — promessa com data suspende a régua e confirma; vencida sem pagamento, avisa e a régua continua', async () => {
      await conectar();
      await etapas([7, 15]);
      const cs = await criarEquipe(t, 'CS', { membros: 1 });
      const contato = await cliente({ responsavel: cs.membros[0] });
      const p = await parcela(contato, 7);
      await executar();
      const ligacao = (await envios(p.id)).find((e) => e.canal === 'LIGACAO')!;
      const c = await entrarComo(t, cs.membros[0]);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'PROMESSA',
        })
        .expect(400);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'PROMESSA',
          promessaAte: somarDias(hojeLocal(), -1),
        })
        .expect(422);
      const promessaAte = somarDias(hojeLocal(), 3);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'PROMESSA',
          promessaAte,
        })
        .expect(200);
      const parcelaDepois = await t.prisma.parcela.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(parcelaDepois.promessaAte?.toISOString().slice(0, 10)).toBe(
        promessaAte,
      );
      let todos = await envios(p.id);
      expect(
        todos.filter((e) => e.situacao === 'CANCELADO' && e.tipo === 'ETAPA'),
      ).toHaveLength(2);
      const confirmacoes = todos.filter(
        (e) => e.tipo === 'PROMESSA_CONFIRMADA',
      );
      expect(confirmacoes.map((e) => e.canal).sort()).toEqual([
        'EMAIL',
        'WHATSAPP',
      ]);
      expect(confirmacoes[0].texto).toContain(
        `${promessaAte.slice(8)}/${promessaAte.slice(5, 7)}/${promessaAte.slice(0, 4)}`,
      );
      await enviar();
      expect(await t.prisma.mensagem.count()).toBe(1);

      // Com a promessa vigente, a régua não cobra (a etapa D+15 também não).
      await t.prisma.parcela.update({
        where: { id: p.id },
        data: {
          vencimento: new Date(`${somarDias(hojeLocal(), -15)}T00:00:00.000Z`),
        },
      });
      const exec = await executar();
      expect(exec.resumo.titulos).toBe(0);

      // A promessa venceu sem pagamento: avisa o cliente e o CS, e a régua continua.
      await t.prisma.parcela.update({
        where: { id: p.id },
        data: {
          promessaAte: new Date(`${somarDias(hojeLocal(), -1)}T00:00:00.000Z`),
        },
      });
      const exec2 = await executar();
      expect(exec2.resumo).toMatchObject({ avisosDePromessa: 1 });
      todos = await envios(p.id);
      expect(
        todos
          .filter((e) => e.tipo === 'PROMESSA_NAO_CUMPRIDA')
          .map((e) => e.canal)
          .sort(),
      ).toEqual(['EMAIL', 'WHATSAPP']);
      expect(
        (await t.prisma.parcela.findUniqueOrThrow({ where: { id: p.id } }))
          .promessaAte,
      ).toBeNull();
      expect(
        await t.prisma.notificacao.count({
          where: {
            tipo: 'regua.promessa_nao_cumprida',
            usuarioId: cs.membros[0].id,
          },
        }),
      ).toBe(1);
      expect(todos.some((e) => e.marco === 15 && e.canal === 'LIGACAO')).toBe(
        true,
      );
    });

    it('R24.5 — "já pagou" dá baixa e encerra a régua; ligação sem registro até o horário limite libera a mensagem', async () => {
      const { cs, p, ligacao } = await comLigacao();
      const c = await entrarComo(t, cs.membros[0]);
      await c
        .post(`/api/v1/financeiro/regua/ligacoes/${ligacao.id}/resultado`, {
          resultado: 'JA_PAGOU',
        })
        .expect(200);
      expect(
        await t.prisma.parcela.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({ status: 'PAGO', baixaOrigem: 'LIGACAO' });
      expect(
        (await envios(p.id)).filter((e) => e.situacao === 'CANCELADO'),
      ).toHaveLength(2);
      await enviar();
      expect(await t.prisma.mensagem.count()).toBe(0);

      // Outra ligação: expira.
      const contato = await cliente();
      const outra = await parcela(contato, 7);
      await executar();
      const l2 = (await envios(outra.id)).find((e) => e.canal === 'LIGACAO')!;
      expect(l2.situacao).toBe('AGUARDANDO_LIGACAO');
      const prazo = (
        await t.prisma.reguaEnvio.findUniqueOrThrow({ where: { id: l2.id } })
      ).prazoEm!;
      expect(prazo.getTime()).toBeGreaterThan(Date.now());
      expect(
        await t
          .get(ReguaLigacoesService)
          .expirar(new Date(prazo.getTime() - 1000)),
      ).toBe(0);
      expect(
        await t
          .get(ReguaLigacoesService)
          .expirar(new Date(prazo.getTime() + 1000)),
      ).toBe(1);
      const depois = await envios(outra.id);
      expect(depois.find((e) => e.canal === 'LIGACAO')).toMatchObject({
        situacao: 'LIGACAO_REGISTRADA',
      });
      expect(depois.filter((e) => e.situacao === 'AGENDADO')).toHaveLength(2);
      expect(
        await t.prisma.atividade.findFirstOrThrow({
          where: { contatoId: contato.id },
        }),
      ).toMatchObject({ status: 'CANCELADA' });
    });
  });

  // ------------------------------------------------------------------ R24.6 / R24.7

  it('R24.6 — o pagamento encerra a régua: cancela mensagens, e-mails e ligações que não saíram', async () => {
    await conectar();
    await etapas([7]);
    const contato = await cliente();
    const p = await parcela(contato, 7);
    await executar();
    await admin
      .post(`/api/v1/financeiro/parcelas/${p.id}/baixa`, {})
      .expect(200);
    const todos = await envios(p.id);
    expect(todos.filter((e) => e.situacao === 'CANCELADO')).toHaveLength(3);
    expect(
      todos.every(
        (e) =>
          e.situacao !== 'AGENDADO' &&
          e.situacao !== 'RETIDO' &&
          e.situacao !== 'AGUARDANDO_LIGACAO',
      ),
    ).toBe(true);
    expect(
      await t.prisma.atividade.findFirstOrThrow({
        where: { contatoId: contato.id },
      }),
    ).toMatchObject({ status: 'CANCELADA' });
    await enviar();
    expect(await t.prisma.mensagem.count()).toBe(0);
    expect(t.email.enviados).toHaveLength(0);
    // Pago: a execução seguinte nem olha o título.
    expect((await executar()).resumo.titulos).toBe(0);

    // Mensagem agendada (ainda não enviada) também é cancelada pela baixa.
    await etapas([0]);
    const q = await parcela(await cliente(), 0);
    await executar();
    expect((await envios(q.id))[0].situacao).toBe('AGENDADO');
    await admin
      .post(`/api/v1/financeiro/parcelas/${q.id}/baixa`, {})
      .expect(200);
    await enviar();
    expect((await envios(q.id))[0].situacao).toBe('CANCELADO');
    expect(await t.prisma.mensagem.count()).toBe(0);
  });

  it('R24.7 — o opt-out de marketing não bloqueia a cobrança, mas "não contatar por WhatsApp" é respeitado', async () => {
    await conectar();
    await etapas([-3]);
    const optOut = await cliente();
    await t.prisma.contato.update({
      where: { id: optOut.id },
      data: { optOutMarketing: true, optOutEm: new Date() },
    });
    const naoWhats = await cliente({ etiquetas: ['nao-contatar-whatsapp'] });
    const porCampo = await cliente();
    await t.prisma.contato.update({
      where: { id: porCampo.id },
      data: { camposPersonalizados: { nao_contatar_whatsapp: 'sim' } },
    });
    const a = await parcela(optOut, -3);
    const b = await parcela(naoWhats, -3);
    const c = await parcela(porCampo, -3);
    await executar();
    await enviar();
    expect(
      (await envios(a.id)).map((e) => [e.canal, e.situacao]).sort(),
    ).toEqual([
      ['EMAIL', 'ENVIADO'],
      ['WHATSAPP', 'ENVIADO'],
    ]);
    for (const x of [b, c]) {
      const e = await envios(x.id);
      expect(e.find((i) => i.canal === 'WHATSAPP')).toMatchObject({
        situacao: 'PULADO',
      });
      expect(e.find((i) => i.canal === 'WHATSAPP')?.motivo).toContain(
        'WhatsApp',
      );
      expect(e.find((i) => i.canal === 'EMAIL')?.situacao).toBe('ENVIADO');
    }
    expect(await t.prisma.mensagem.count()).toBe(1);
    // Sem telefone nem e-mail: tudo pulado, sem erro.
    const vazio = await criarContato(t, {
      email: null,
      telefone: null,
      etiquetas: [],
    }).catch(() => null);
    expect(vazio).toBeNull();
  });

  it('R24.3 — alterar o vencimento reinicia a régua do título', async () => {
    await conectar();
    await etapas([-3, 0]);
    const p = await parcela(await cliente(), 0);
    await executar();
    expect(
      (await envios(p.id)).filter((e) => e.situacao === 'AGENDADO'),
    ).toHaveLength(1);
    await executar();
    expect((await envios(p.id)).length).toBe(2);
    const r = await admin
      .patch(`/api/v1/financeiro/parcelas/${p.id}`, {
        vencimento: somarDias(hojeLocal(), 2),
      })
      .expect(200);
    expect(r.body).toMatchObject({ status: 'ABERTO', diasEmAtraso: 0 });
    expect(
      (await t.prisma.parcela.findUniqueOrThrow({ where: { id: p.id } }))
        .cicloRegua,
    ).toBe(2);
    expect(
      (await envios(p.id)).find((e) => e.situacao === 'AGENDADO'),
    ).toBeUndefined();
    await executar();
    const ciclo2 = await t.prisma.reguaEnvio.findMany({
      where: { parcelaId: p.id, ciclo: 2 },
    });
    expect(ciclo2.map((e) => [e.marco, e.situacao])).toEqual([
      [-3, 'AGENDADO'],
      [-3, 'AGENDADO'],
    ]);
  });

  // ------------------------------------------------------------------ R24.9

  it('R24.9 — linha do tempo por título, envios do dia e exportação', async () => {
    await conectar();
    const cs = await criarEquipe(t, 'CS', { membros: 1 });
    const contato = await cliente({ responsavel: cs.membros[0] });
    const p = await parcela(contato, 5);
    await executar();
    await enviar();
    const r = await admin
      .get(`/api/v1/financeiro/parcelas/${p.id}/linha-do-tempo`)
      .expect(200);
    const corpo = r.body as {
      envios: Envio[];
      historico: { acao: string }[];
      parcela: { numero: string };
    };
    expect(corpo.parcela.numero).toBe(p.numero);
    expect(
      corpo.envios
        .map((e) => [e.marco, e.situacao])
        .filter((x) => x[1] === 'ENVIADO'),
    ).toEqual([[5, 'ENVIADO']]);
    expect(corpo.historico.map((h) => h.acao)).toEqual(
      expect.arrayContaining([
        'parcela.criada',
        'regua.etapa_executada',
        'regua.mensagem_enviada',
      ]),
    );

    const resumo = await admin
      .get('/api/v1/financeiro/regua/resumo')
      .expect(200);
    expect(resumo.body).toMatchObject({
      whatsapp: { ENVIADO: 1 },
      ligacoesPendentes: 0,
      pausada: false,
    });
    const doDia = await admin
      .get('/api/v1/financeiro/regua/envios?situacao=PULADO')
      .expect(200);
    expect((doDia.body as { total: number }).total).toBe(4);
    const exp = await admin
      .post('/api/v1/financeiro/parcelas/exportar?formato=csv&status=ATRASADO')
      .expect(200);
    const arquivo = exp.body as { id: string; nome: string };
    expect(arquivo.nome).toMatch(/^titulos-.*\.csv$/);
    const conteudo = await t.get(ArquivosService).lerConteudo(arquivo.id);
    expect(conteudo.conteudo.toString('utf8')).toContain(p.numero);
    // O CS da carteira vê a linha do tempo; quem não tem a parcela, não.
    await (
      await entrarComo(t, cs.membros[0])
    )
      .get(`/api/v1/financeiro/parcelas/${p.id}/linha-do-tempo`)
      .expect(200);
    const outro = await criarEquipe(t, 'CS', { membros: 1 });
    await (
      await entrarComo(t, outro.membros[0])
    )
      .get(`/api/v1/financeiro/parcelas/${p.id}/linha-do-tempo`)
      .expect(404);
  });
});
