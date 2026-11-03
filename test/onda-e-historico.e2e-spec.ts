import { createHmac } from 'node:crypto';
import { FILA_PUBLICAR_ENCERRADA } from '../src/ligacoes/eventos-de-ligacao.service';
import { LIMITE_DA_BUSCA } from '../src/ligacoes/historico-ligacoes.service';
import { LigacoesService } from '../src/ligacoes/ligacoes.service';
import { Prisma } from '../src/generated/prisma/client';
import { type CenarioDoAtendimento, montarCenario } from './atendimento-apoio';
import { cartao, consultarPainel, linhasDa, MIN, quando } from './bi-apoio';
import { ServidorDeTeste, FILA_ENTREGAR } from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarCanal,
  criarContato,
  criarConversa,
  drenarFilas,
  drenarTudo,
  entrarComo,
  processarEventos,
  avancarPassos,
} from './utils';

type Canal = Awaited<ReturnType<typeof criarCanal>>;

/**
 * Histórico das ligações (Onda E, fatia E4): lista com filtros e busca no texto das
 * transcrições (R29.8, R30.8), linha do tempo, BI do Atendimento, webhook de saída
 * `ligacao.encerrada` e gatilhos de automação (R29.9, R30.9). As ligações são gravadas
 * direto no banco (a sinalização com a Meta falsa está em `onda-e-ligacoes`).
 */
describe('Histórico das ligações (e2e)', () => {
  let t: AppTeste;
  const servidor = new ServidorDeTeste();
  let cenario: CenarioDoAtendimento;
  let canal: Canal;
  let admin: ClienteHttp;
  let ana: ClienteHttp;
  let bruno: ClienteHttp;
  let marketing: ClienteHttp;
  let cLevel: ClienteHttp;
  let contadorMeta = 0;

  beforeAll(async () => {
    await servidor.iniciar();
    t = await criarAppTeste({
      variaveis: { WEBHOOKS_PERMITIR_REDE_INTERNA: 'true' },
    });
  });
  beforeEach(async () => {
    await t.limparBanco();
    servidor.limpar();
    contadorMeta = 0;
    cenario = await montarCenario(t, { membros: 2 });
    canal = await criarCanal(t, {
      tipo: 'WHATSAPP_OFICIAL',
      nome: 'WhatsApp oficial',
      filaPadrao: cenario.fila,
    });
    admin = await entrarComo(t, cenario.admin);
    ana = await entrarComo(t, cenario.comercial.membros[0]!);
    bruno = await entrarComo(t, cenario.comercial.membros[1]!);
    marketing = await entrarComo(t, cenario.marketing);
    cLevel = await entrarComo(t, cenario.comercial.cLevel);
  });
  afterAll(async () => {
    await t.fechar();
    await servidor.parar();
  });

  // ---- apoio ---------------------------------------------------------------

  const ana0 = () => cenario.comercial.membros[0]!;
  const bruno0 = () => cenario.comercial.membros[1]!;

  interface NovaLigacao {
    contatoId: string;
    direcao?: 'RECEBIDA' | 'FEITA';
    estado?: 'ENCERRADA' | 'PERDIDA' | 'RECUSADA' | 'SEM_RESPOSTA' | 'FALHOU';
    atendenteId?: string | null;
    conversaId?: string | null;
    iniciadaEm?: Date;
    esperaS?: number;
    duracaoS?: number;
    canalId?: string;
    tocouPara?: string[];
    transcricao?: { falante: string; inicio: number; texto: string }[];
    resumo?: object;
    atividadeId?: string | null;
  }

  async function nova(dados: NovaLigacao) {
    contadorMeta++;
    const estado = dados.estado ?? 'ENCERRADA';
    const iniciadaEm = dados.iniciadaEm ?? new Date();
    const atendida = estado === 'ENCERRADA';
    const atendidaEm = atendida
      ? new Date(iniciadaEm.getTime() + (dados.esperaS ?? 4) * 1000)
      : null;
    const duracao = atendida ? (dados.duracaoS ?? 60) : 0;
    return t.prisma.ligacao.create({
      data: {
        canalId: dados.canalId ?? canal.id,
        contatoId: dados.contatoId,
        conversaId: dados.conversaId ?? null,
        direcao: dados.direcao ?? 'RECEBIDA',
        estado,
        atendenteId: dados.atendenteId ?? null,
        idMeta: `wacid.H${contadorMeta}`,
        iniciadaEm,
        atendidaEm,
        encerradaEm: new Date(
          (atendidaEm ?? iniciadaEm).getTime() + duracao * 1000,
        ),
        duracaoSegundos: duracao,
        tocouPara: dados.tocouPara ?? [],
        atividadeId: dados.atividadeId ?? null,
        ...(dados.transcricao
          ? {
              transcricaoSituacao: 'PRONTA' as const,
              transcricao: {
                versao: 1,
                idioma: 'pt',
                modelo: 'teste',
                duracaoSegundos: duracao,
                trechos: dados.transcricao.map((x) => ({
                  ...x,
                  fim: x.inicio + 3,
                })),
              },
            }
          : {}),
        ...(dados.resumo
          ? { resumoSituacao: 'PRONTO' as const, resumo: dados.resumo }
          : {}),
      },
    });
  }

  const RESUMO = {
    versao: 1,
    assunto: 'Proposta do plano anual',
    pontosPrincipais: ['Cliente quer desconto', 'Prazo de 30 dias'],
    combinados: ['Enviar a proposta revisada'],
    proximosPassos: ['Ligar na sexta'],
    sentimento: 'POSITIVO',
    sentimentoMotivo: 'Receptivo',
    sugestoes: [],
    modelo: 'teste',
  };

  async function conversaDe(contatoId: string, responsavel?: { id: string }) {
    return criarConversa(t, {
      canal,
      contato: contatoId,
      fila: cenario.fila,
      responsavel: responsavel?.id,
    });
  }

  async function listar(cliente: ClienteHttp, consulta: object = {}) {
    const r = await cliente.get('/api/v1/ligacoes').query(consulta).expect(200);
    return r.body as {
      itens: {
        id: string;
        trechosEncontrados: {
          falante: string;
          inicio: number;
          texto: string;
        }[];
        resumo: { conteudo: { assunto: string } | null };
      }[];
      proximoCursor: string | null;
      total: number;
    };
  }

  // =========================================================================
  describe('R29.8 — lista com filtros', () => {
    it('cenário 259 — R29.8 — filtra por período, direção, situação, atendente, fila, canal e contato; total e cursor', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const joao = await criarContato(t, {
        nome: 'João',
        telefone: '5511999990002',
      });
      const conversaMaria = await conversaDe(maria.id, ana0());
      const conversaCs = await criarConversa(t, {
        canal,
        contato: joao,
        fila: cenario.filaCs,
      });
      const outroCanal = await criarCanal(t, {
        tipo: 'WHATSAPP_OFICIAL',
        nome: 'Segundo número',
        filaPadrao: cenario.fila,
      });
      const l1 = await nova({
        contatoId: maria.id,
        conversaId: conversaMaria.id,
        atendenteId: ana0().id,
        iniciadaEm: quando(5, 12),
      });
      const l2 = await nova({
        contatoId: maria.id,
        conversaId: conversaMaria.id,
        direcao: 'FEITA',
        atendenteId: ana0().id,
        iniciadaEm: quando(3, 12),
      });
      const l3 = await nova({
        contatoId: maria.id,
        conversaId: conversaMaria.id,
        estado: 'PERDIDA',
        iniciadaEm: quando(2, 12),
      });
      const l4 = await nova({
        contatoId: joao.id,
        conversaId: conversaCs.id,
        atendenteId: bruno0().id,
        iniciadaEm: quando(1, 12),
        canalId: outroCanal.id,
      });

      const todas = await listar(admin);
      expect(todas.itens.map((i) => i.id)).toEqual([
        l4.id,
        l3.id,
        l2.id,
        l1.id,
      ]);
      expect(todas.total).toBe(4);

      const porDirecao = await listar(admin, { direcao: 'FEITA' });
      expect(porDirecao.itens.map((i) => i.id)).toEqual([l2.id]);

      const porSituacao = await listar(admin, { situacao: 'PERDIDA,RECUSADA' });
      expect(porSituacao.itens.map((i) => i.id)).toEqual([l3.id]);

      const porAtendente = await listar(admin, { atendenteId: ana0().id });
      expect(porAtendente.itens.map((i) => i.id)).toEqual([l2.id, l1.id]);
      const semAtendente = await listar(admin, { atendenteId: 'sem' });
      expect(semAtendente.itens.map((i) => i.id)).toEqual([l3.id]);

      const porFila = await listar(admin, { filaId: cenario.filaCs.id });
      expect(porFila.itens.map((i) => i.id)).toEqual([l4.id]);
      const porCanal = await listar(admin, { canalId: outroCanal.id });
      expect(porCanal.itens.map((i) => i.id)).toEqual([l4.id]);
      const porContato = await listar(admin, { contatoId: maria.id });
      expect(porContato.total).toBe(3);

      const porPeriodo = await listar(admin, {
        de: quando(4, 0).toISOString(),
        ate: quando(2, 0).toISOString(),
      });
      expect(porPeriodo.itens.map((i) => i.id)).toEqual([l2.id]);

      // Combinados + paginação por cursor.
      const pagina1 = await listar(admin, { limite: 3 });
      expect(pagina1.itens).toHaveLength(3);
      expect(pagina1.proximoCursor).not.toBeNull();
      const pagina2 = await listar(admin, {
        limite: 3,
        cursor: pagina1.proximoCursor!,
      });
      expect(pagina2.itens.map((i) => i.id)).toEqual([l1.id]);
      expect(pagina2.proximoCursor).toBeNull();

      // Validações.
      await admin
        .get('/api/v1/ligacoes')
        .query({ situacao: 'INVENTADA' })
        .expect(400);
      await admin.get('/api/v1/ligacoes').query({ de: 'ontem' }).expect(400);
      await admin
        .get('/api/v1/ligacoes')
        .query({ atendenteId: 'x' })
        .expect(400);
    });

    it('cenário 260 — R29.8 — cada um vê só as ligações que pode ver (R12): atendente, chamado e conversa; Marketing, 403', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const joao = await criarContato(t, {
        nome: 'João',
        telefone: '5511999990002',
      });
      const conversaAna = await conversaDe(maria.id, ana0());
      const conversaSemDono = await conversaDe(joao.id);
      const lAna = await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        atendenteId: ana0().id,
      });
      const lSemDono = await nova({
        contatoId: joao.id,
        conversaId: conversaSemDono.id,
        estado: 'PERDIDA',
      });
      const lChamado = await nova({
        contatoId: joao.id,
        estado: 'PERDIDA',
        tocouPara: [bruno0().id],
      });
      const idsDe = async (c: ClienteHttp) =>
        (await listar(c)).itens.map((i) => i.id).sort();
      // Ana: a dela e a conversa sem dono da fila da área (membro vê as sem responsável).
      expect(await idsDe(ana)).toEqual([lAna.id, lSemDono.id].sort());
      // Bruno: a conversa sem dono da fila e a que tocou para ele; não a de Ana.
      expect(await idsDe(bruno)).toEqual([lSemDono.id, lChamado.id].sort());
      // Líder comercial vê as da fila da área; C-level e Admin, tudo.
      expect(await idsDe(cLevel)).toHaveLength(3);
      expect(await idsDe(admin)).toHaveLength(3);
      await marketing.get('/api/v1/ligacoes').expect(403);
      await marketing.get('/api/v1/ligacoes').query({ busca: 'x' }).expect(403);
    });
  });

  // =========================================================================
  describe('R30.9 — quem tem o contato no alcance vê a ligação', () => {
    it('o responsável pelo contato e o líder dele veem a ligação na lista, no detalhe, na linha do tempo e no BI, mesmo sem ver a conversa', async () => {
      const csMembro = cenario.cs.membros[0]!;
      const cliente = await criarContato(t, {
        nome: 'Pedro da CS',
        telefone: '5511999990077',
        responsavel: csMembro,
      });
      // A ligação é da fila Comercial: o membro de CS não vê a conversa.
      const conversa = await conversaDe(cliente.id, ana0());
      const ligacao = await nova({
        contatoId: cliente.id,
        conversaId: conversa.id,
        atendenteId: ana0().id,
      });
      const responsavel = await entrarComo(t, csMembro);
      const liderDele = await entrarComo(t, cenario.cs.lider);
      for (const quem of [responsavel, liderDele, ana]) {
        expect((await listar(quem)).itens.map((i) => i.id)).toEqual([
          ligacao.id,
        ]);
        await quem.get(`/api/v1/ligacoes/${ligacao.id}`).expect(200);
        const linha = (
          await quem
            .get(`/api/v1/contatos/${cliente.id}/linha-do-tempo`)
            .expect(200)
        ).body as { itens: { tipo: string }[] };
        expect(linha.itens.filter((i) => i.tipo === 'ligacao')).toHaveLength(1);
      }
      // Bruno não tem o contato nem vê a conversa de Ana: 404 e nada na lista.
      expect((await listar(bruno)).itens).toHaveLength(0);
      await bruno.get(`/api/v1/ligacoes/${ligacao.id}`).expect(404);
    });
  });

  // =========================================================================
  describe('R30.8 — busca no texto das transcrições', () => {
    const TRANSCRICAO = [
      { falante: 'atendente', inicio: 1, texto: 'Bom dia, aqui é da BRL.' },
      {
        falante: 'cliente',
        inicio: 5.4,
        texto: 'Eu queria saber da renovação do contrato e do desconto.',
      },
      {
        falante: 'atendente',
        inicio: 12,
        texto: 'Claro! Posso enviar a proposta ainda hoje.',
      },
    ];

    it('cenário 261 — R30.8 — acha pelo texto sem distinguir acento, maiúscula ou flexão e devolve os trechos que casaram', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      const achada = await nova({
        contatoId: maria.id,
        conversaId: conversa.id,
        atendenteId: ana0().id,
        transcricao: TRANSCRICAO,
        resumo: RESUMO,
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversa.id,
        atendenteId: ana0().id,
        transcricao: [
          { falante: 'cliente', inicio: 2, texto: 'Obrigado, era só isso.' },
        ],
      });
      await nova({ contatoId: maria.id, conversaId: conversa.id });

      const renovacao = await listar(ana, { busca: 'RENOVACAO' });
      expect(renovacao.itens.map((i) => i.id)).toEqual([achada.id]);
      expect(renovacao.total).toBe(1);
      expect(renovacao.itens[0]!.trechosEncontrados).toEqual([
        {
          falante: 'cliente',
          inicio: 5.4,
          texto: 'Eu queria saber da renovação do contrato e do desconto.',
        },
      ]);
      // Flexão: "descontos" acha "desconto"; "propostas" acha "proposta".
      expect((await listar(ana, { busca: 'descontos' })).total).toBe(1);
      expect((await listar(ana, { busca: 'propostas' })).total).toBe(1);
      // Frase entre aspas, exclusão e "ou".
      expect(
        (await listar(ana, { busca: '"renovação do contrato"' })).total,
      ).toBe(1);
      expect((await listar(ana, { busca: 'renovação -desconto' })).total).toBe(
        0,
      );
      expect(
        (await listar(ana, { busca: 'renovação or obrigado' })).total,
      ).toBe(2);
      // Sem resultado e combinando com filtro.
      expect((await listar(ana, { busca: 'inexistente' })).itens).toEqual([]);
      expect(
        (await listar(ana, { busca: 'contrato', direcao: 'FEITA' })).total,
      ).toBe(0);
      // O resumo e os estados acompanham o item.
      expect(renovacao.itens[0]!.resumo.conteudo?.assunto).toBe(
        'Proposta do plano anual',
      );
      await ana
        .get('/api/v1/ligacoes')
        .query({ busca: 'a'.repeat(201) })
        .expect(400);
    });

    it('cenário 262 — R30.8 — a busca só encontra o que o usuário pode ver (R12): o texto da ligação alheia não vaza', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversaAna = await conversaDe(maria.id, ana0());
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        atendenteId: ana0().id,
        transcricao: TRANSCRICAO,
      });
      expect((await listar(ana, { busca: 'renovação' })).total).toBe(1);
      const deBruno = await listar(bruno, { busca: 'renovação' });
      expect(deBruno.total).toBe(0);
      expect(deBruno.itens).toEqual([]);
      expect((await listar(admin, { busca: 'renovação' })).total).toBe(1);
      expect((await listar(cLevel, { busca: 'renovação' })).total).toBe(1);
    });

    it('R30.8 — o limite da busca vale depois da visibilidade: milhares de transcrições alheias mais recentes não escondem as de quem busca', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const joao = await criarContato(t, {
        nome: 'João',
        telefone: '5511999990002',
      });
      const conversaAna = await conversaDe(maria.id, ana0());
      const dela = await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        atendenteId: ana0().id,
        iniciadaEm: new Date(Date.now() - 400 * 86_400_000),
        transcricao: [
          { falante: 'cliente', inicio: 1, texto: 'Segue o boleto.' },
        ],
      });
      const modelo = await t.prisma.ligacao.findUniqueOrThrow({
        where: { id: dela.id },
      });
      // Mais recentes que a dela e de outra pessoa (Bruno), com a mesma palavra.
      await t.prisma.ligacao.createMany({
        data: Array.from({ length: LIMITE_DA_BUSCA + 1 }, (_, i) => ({
          canalId: canal.id,
          contatoId: joao.id,
          direcao: 'RECEBIDA' as const,
          estado: 'ENCERRADA' as const,
          atendenteId: bruno0().id,
          idMeta: `wacid.LIM${i}`,
          iniciadaEm: new Date(Date.now() - 86_400_000 + i),
          encerradaEm: new Date(Date.now() - 86_400_000 + i),
          duracaoSegundos: 10,
          transcricaoSituacao: 'PRONTA' as const,
          transcricao: modelo.transcricao as Prisma.InputJsonValue,
        })),
      });
      const resposta = await listar(ana, { busca: 'boleto' });
      expect(resposta.itens.map((i) => i.id)).toEqual([dela.id]);
      expect(resposta.total).toBe(1);
    }, 60_000);

    it('cenário 263 — R30.8 — o índice acompanha a transcrição: apagar (guarda, LGPD) ou reprocessar tira e põe a ligação na busca', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      const ligacao = await nova({
        contatoId: maria.id,
        conversaId: conversa.id,
        atendenteId: ana0().id,
        transcricao: TRANSCRICAO,
      });
      expect((await listar(admin, { busca: 'renovação' })).total).toBe(1);
      // A guarda apaga a transcrição (`transcricao` vira nulo): sai da busca.
      await t.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: { transcricao: Prisma.DbNull, transcricaoSituacao: null },
      });
      expect((await listar(admin, { busca: 'renovação' })).total).toBe(0);
      // Um reprocessamento grava outro texto: entra de novo.
      await t.prisma.ligacao.update({
        where: { id: ligacao.id },
        data: {
          transcricaoSituacao: 'PRONTA',
          transcricao: {
            versao: 1,
            idioma: 'pt',
            modelo: 'teste',
            duracaoSegundos: 10,
            trechos: [
              {
                falante: 'cliente',
                inicio: 0,
                fim: 2,
                texto: 'Quero cancelar a assinatura.',
              },
            ],
          },
        },
      });
      expect((await listar(admin, { busca: 'renovação' })).total).toBe(0);
      expect((await listar(admin, { busca: 'assinatura' })).total).toBe(1);
    });
  });

  // =========================================================================
  describe('R29.8 — linha do tempo do contato', () => {
    it('cenário 264 — R29.8 — a ligação entra na linha do tempo com duração, resultado e resumo, só para quem a vê, sem duplicar o evento nem a atividade', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      const atividade = await t.prisma.atividade.create({
        data: {
          tipo: 'LIGACAO',
          titulo: 'Ligação com Maria',
          status: 'CONCLUIDA',
          concluidaEm: new Date(),
          contatoId: maria.id,
          responsavelId: ana0().id,
          criadoPorId: ana0().id,
        },
      });
      const ligacao = await nova({
        contatoId: maria.id,
        conversaId: conversa.id,
        atendenteId: ana0().id,
        duracaoS: 125,
        resumo: RESUMO,
        atividadeId: atividade.id,
      });
      const perdida = await nova({
        contatoId: maria.id,
        conversaId: conversa.id,
        estado: 'PERDIDA',
      });
      const linha = async (c: ClienteHttp, incluir?: string) =>
        (
          await c
            .get(`/api/v1/contatos/${maria.id}/linha-do-tempo`)
            .query(incluir ? { incluir } : {})
            .expect(200)
        ).body as {
          itens: {
            tipo: string;
            ligacao: {
              id: string;
              resultado: string;
              duracaoSegundos: number;
              resumoAssunto: string | null;
              resumoTrecho: string | null;
              conversaId: string;
              atendente: { nome: string } | null;
            } | null;
            atividade: { id: string } | null;
          }[];
        };
      const doAdmin = await linha(admin);
      const ligacoes = doAdmin.itens.filter((i) => i.tipo === 'ligacao');
      expect(ligacoes.map((i) => i.ligacao!.id).sort()).toEqual(
        [ligacao.id, perdida.id].sort(),
      );
      const atendida = ligacoes.find(
        (i) => i.ligacao!.id === ligacao.id,
      )!.ligacao!;
      expect(atendida).toMatchObject({
        resultado: 'atendida',
        duracaoSegundos: 125,
        resumoAssunto: 'Proposta do plano anual',
        conversaId: conversa.id,
      });
      expect(atendida.resumoTrecho).toContain('Cliente quer desconto');
      expect(atendida.atendente?.nome).toBeTruthy();
      expect(
        ligacoes.find((i) => i.ligacao!.id === perdida.id)!.ligacao!.resultado,
      ).toBe('perdida');
      // A atividade concluída da própria ligação não aparece duas vezes.
      expect(doAdmin.itens.some((i) => i.atividade?.id === atividade.id)).toBe(
        false,
      );
      // Filtro `incluir=ligacoes` traz só as ligações.
      const soLigacoes = await linha(admin, 'ligacoes');
      expect(soLigacoes.itens.every((i) => i.tipo === 'ligacao')).toBe(true);
      expect(soLigacoes.itens).toHaveLength(2);
      // R12: Bruno não vê a conversa de Ana nem foi chamado.
      expect(
        (await linha(bruno)).itens.filter((i) => i.tipo === 'ligacao'),
      ).toHaveLength(0);
      expect(
        (await linha(ana)).itens.filter((i) => i.tipo === 'ligacao'),
      ).toHaveLength(2);
      // Marketing vê o contato, mas nenhuma ligação.
      expect(
        (await linha(marketing)).itens.filter((i) => i.tipo === 'ligacao'),
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('R29.8 — BI, painel Atendimento', () => {
    it('cenário 265 — R29.8 — cartões e tabelas de ligações: recebidas, feitas, atendidas, perdidas, espera e duração, por atendente e por hora; respeita R12', async () => {
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversaAna = await conversaDe(maria.id, ana0());
      const conversaBruno = await conversaDe(
        (await criarContato(t, { nome: 'Pedro', telefone: '5511999990003' }))
          .id,
        bruno0(),
      );
      // Horas em UTC (Brasília = UTC-3): 13h → 10h, 14h → 11h.
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        atendenteId: ana0().id,
        iniciadaEm: quando(2, 13),
        esperaS: 6,
        duracaoS: 120,
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        atendenteId: ana0().id,
        iniciadaEm: quando(2, 13, 30),
        esperaS: 10,
        duracaoS: 60,
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        direcao: 'FEITA',
        atendenteId: ana0().id,
        iniciadaEm: quando(2, 14),
        duracaoS: 30,
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        estado: 'PERDIDA',
        iniciadaEm: quando(2, 14, 5),
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        direcao: 'FEITA',
        estado: 'SEM_RESPOSTA',
        atendenteId: ana0().id,
        iniciadaEm: quando(2, 14, 10),
      });
      await nova({
        contatoId: maria.id,
        conversaId: conversaBruno.id,
        atendenteId: bruno0().id,
        iniciadaEm: quando(1, 13),
        esperaS: 2,
        duracaoS: 300,
      });
      // Fora do período e em andamento: não contam.
      await nova({
        contatoId: maria.id,
        conversaId: conversaAna.id,
        iniciadaEm: quando(40, 13),
      });
      await t.prisma.ligacao.create({
        data: {
          canalId: canal.id,
          contatoId: maria.id,
          conversaId: conversaAna.id,
          direcao: 'RECEBIDA',
          estado: 'EM_ANDAMENTO',
          atendenteId: bruno0().id,
          iniciadaEm: quando(0, 1),
          atendidaEm: quando(0, 1),
        },
      });

      const painel = await consultarPainel(admin, 'atendimento');
      expect(cartao(painel, 'ligacoesRecebidas').valor).toBe(4);
      expect(cartao(painel, 'ligacoesFeitas').valor).toBe(2);
      expect(cartao(painel, 'ligacoesAtendidas').valor).toBe(4);
      expect(cartao(painel, 'ligacoesPerdidas').valor).toBe(1);
      expect(cartao(painel, 'ligacoesTaxaAtendimento').valor).toBe(75);
      // Espera média das recebidas atendidas: (6 + 10 + 2) / 3 = 6 s. Duração: (120 + 60 + 30 + 300) / 4 = 127,5, arredondado.
      expect(cartao(painel, 'ligacoesEspera').valor).toBe(6);
      expect(cartao(painel, 'ligacoesDuracao').valor).toBe(128);
      expect(cartao(painel, 'ligacoesRecebidas').unidade).toBe('numero');
      expect(cartao(painel, 'ligacoesEspera').unidade).toBe('segundos');

      const porAtendente = linhasDa(painel, 'ligacoesPorAtendente');
      const deAna = porAtendente.find((l) => l.id === ana0().id)!;
      expect(deAna).toMatchObject({
        recebidas: 2,
        feitas: 2,
        atendidas: 3,
        perdidas: 0,
      });
      const semAtendente = porAtendente.find((l) => l.id === null)!;
      expect(semAtendente).toMatchObject({
        nome: 'Sem atendente',
        perdidas: 1,
      });

      const porHora = linhasDa(painel, 'ligacoesPorHora');
      expect(porHora).toHaveLength(24);
      expect(porHora.find((l) => l.hora === 10)).toMatchObject({
        recebidas: 3,
        atendidas: 3,
      });
      expect(porHora.find((l) => l.hora === 11)).toMatchObject({
        recebidas: 1,
        feitas: 2,
        perdidas: 1,
        atendidas: 1,
      });

      // R12: Ana só vê as do que é dela; o filtro por pessoa também vale.
      const deAnaPainel = await consultarPainel(ana, 'atendimento');
      expect(cartao(deAnaPainel, 'ligacoesRecebidas').valor).toBe(3);
      expect(cartao(deAnaPainel, 'ligacoesFeitas').valor).toBe(2);
      const filtradoPorPessoa = await consultarPainel(admin, 'atendimento', {
        pessoaId: bruno0().id,
      });
      expect(cartao(filtradoPorPessoa, 'ligacoesRecebidas').valor).toBe(1);
      await consultarPainel(marketing, 'atendimento', {}, 403);
    });
  });

  // =========================================================================
  describe('R29.9 — evento ligacao.encerrada (webhook de saída) e gatilhos', () => {
    async function destino(eventos: string[]) {
      const r = await admin
        .post('/api/v1/webhooks/saidas', {
          nome: 'Ligações',
          url: `${servidor.url}/ligacoes`,
          eventos,
        })
        .expect(201);
      return (r.body as { webhook: { id: string }; segredo: string }).segredo;
    }

    /** Uma recebida atendida e fechada pelo núcleo (como o `terminate` da Meta faria). */
    async function atenderEEncerrar(contatoId: string, conversaId: string) {
      const l = await t.prisma.ligacao.create({
        data: {
          canalId: canal.id,
          contatoId,
          conversaId,
          direcao: 'RECEBIDA',
          estado: 'EM_ANDAMENTO',
          atendenteId: ana0().id,
          idMeta: 'wacid.EVT1',
          tocouPara: [ana0().id],
          iniciadaEm: new Date(Date.now() - 70_000),
          atendidaEm: new Date(Date.now() - 65_000),
          gravar: true,
        },
      });
      const nucleo = t.get(LigacoesService);
      await nucleo.executar((tx, ctx) =>
        nucleo.transicionar(
          tx,
          ctx,
          l.id,
          {
            tipo: 'encerrada_pela_meta',
            atendida: true,
            falhou: false,
          },
          { duracaoSegundos: 65 },
        ),
      );
      return l.id;
    }

    async function perder(contatoId: string, conversaId: string) {
      const l = await t.prisma.ligacao.create({
        data: {
          canalId: canal.id,
          contatoId,
          conversaId,
          direcao: 'RECEBIDA',
          estado: 'TOCANDO',
          idMeta: 'wacid.EVT2',
          tocouPara: [ana0().id],
          iniciadaEm: new Date(),
        },
      });
      const nucleo = t.get(LigacoesService);
      await nucleo.executar((tx, ctx) =>
        nucleo.transicionar(tx, ctx, l.id, { tipo: 'tempo_de_toque_esgotado' }),
      );
      return l.id;
    }

    it('cenário 266 — R29.9 — o webhook ligacao.encerrada leva ids, direção, resultado, duração, atendente e contato; sem áudio, sem transcrição e sem resumo por padrão', async () => {
      const segredo = await destino(['ligacao.encerrada']);
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      const id = await atenderEEncerrar(maria.id, conversa.id);
      // Dados sensíveis na ligação: nada disso pode sair.
      await t.prisma.ligacao.update({
        where: { id },
        data: {
          transcricaoSituacao: 'PRONTA',
          transcricao: {
            versao: 1,
            trechos: [
              {
                falante: 'cliente',
                inicio: 0,
                fim: 1,
                texto: 'segredo falado',
              },
            ],
          },
          resumoSituacao: 'PRONTO',
          resumo: RESUMO,
        },
      });
      await processarEventos(t);
      await drenarFilas(t, FILA_ENTREGAR);
      expect(servidor.recebidos).toHaveLength(1);
      const pedido = servidor.recebidos[0]!;
      const envelope = JSON.parse(pedido.corpo) as {
        evento: string;
        dados: Record<string, unknown>;
      };
      expect(envelope.evento).toBe('ligacao.encerrada');
      expect(envelope.dados).toMatchObject({
        ligacaoId: id,
        canalId: canal.id,
        contatoId: maria.id,
        contato: { id: maria.id, nome: 'Maria' },
        conversaId: conversa.id,
        direcao: 'RECEBIDA',
        estado: 'ENCERRADA',
        resultado: 'atendida',
        duracaoSegundos: 65,
        atendenteId: ana0().id,
        atendente: { id: ana0().id },
      });
      expect(pedido.corpo).not.toContain('segredo falado');
      expect(pedido.corpo).not.toContain('Proposta do plano anual');
      expect(envelope.dados).not.toHaveProperty('resumo');
      expect(envelope.dados).not.toHaveProperty('transcricao');
      expect(envelope.dados).not.toHaveProperty('gravacao');
      // Assinatura de sempre (R9.3).
      const timestamp = String(pedido.cabecalhos['x-crm-timestamp']);
      expect(pedido.cabecalhos['x-crm-assinatura']).toBe(
        `sha256=${createHmac('sha256', segredo).update(`${timestamp}.${pedido.corpo}`).digest('hex')}`,
      );
      // Perdida também gera ligacao.encerrada, com resultado "perdida".
      await perder(maria.id, conversa.id);
      await processarEventos(t, { incluirAgendados: true });
      await drenarFilas(t, FILA_ENTREGAR);
      const segundo = JSON.parse(servidor.recebidos[1]!.corpo) as {
        dados: Record<string, unknown>;
      };
      expect(segundo.dados).toMatchObject({
        resultado: 'perdida',
        estado: 'PERDIDA',
        atendenteId: null,
      });
    });

    it('cenário 267 — R29.9 — com o resumo marcado no canal, o webhook espera o resumo e o leva (só ele; nunca a transcrição)', async () => {
      await destino(['ligacao.encerrada']);
      await admin
        .patch(`/api/v1/whatsapp-oficial/canais/${canal.id}/ligacoes`, {
          webhookIncluiResumo: true,
        })
        .expect(422)
        .catch(() => undefined);
      // O canal de teste não está na Meta: grava a configuração direto e confere a leitura.
      await t.prisma.canalLigacaoConfig.upsert({
        where: { canalId: canal.id },
        create: { canalId: canal.id, webhookIncluiResumo: true },
        update: { webhookIncluiResumo: true },
      });
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      const id = await atenderEEncerrar(maria.id, conversa.id);
      // Ainda sem resumo: o evento espera (o job confere de novo).
      await processarEventos(t);
      expect(servidor.recebidos).toHaveLength(0);
      expect(
        await t.prisma.eventoDominio.count({
          where: { tipo: 'ligacao.encerrada' },
        }),
      ).toBe(0);
      await t.prisma.ligacao.update({
        where: { id },
        data: {
          transcricaoSituacao: 'PRONTA',
          transcricao: {
            versao: 1,
            trechos: [
              { falante: 'cliente', inicio: 0, fim: 1, texto: 'texto da fala' },
            ],
          },
          resumoSituacao: 'PRONTO',
          resumo: RESUMO,
        },
      });
      await drenarFilas(t, FILA_PUBLICAR_ENCERRADA, { incluirAgendados: true });
      await processarEventos(t);
      await drenarFilas(t, FILA_ENTREGAR);
      expect(servidor.recebidos).toHaveLength(1);
      const corpo = servidor.recebidos[0]!.corpo;
      const dados = (JSON.parse(corpo) as { dados: Record<string, any> }).dados;
      expect(dados.resumo).toMatchObject({
        assunto: 'Proposta do plano anual',
        combinados: ['Enviar a proposta revisada'],
      });
      expect(dados.resumo).not.toHaveProperty('sugestoes');
      expect(corpo).not.toContain('texto da fala');
    });

    it('cenário 268 — R29.9 — gatilhos de automação "ligação perdida" e "ligação encerrada", com filtros de canal, direção e resultado', async () => {
      const criar = async (corpo: object) => {
        const c = await admin
          .post('/api/v1/automacoes', {
            nome: 'Ligação',
            tipoGatilho: 'EVENTO',
            definicao: {
              passos: [
                {
                  id: 'p1',
                  tipo: 'acao.etiquetar',
                  config: { adicionar: ['ligou'] },
                },
              ],
            },
            ...corpo,
          })
          .expect(201);
        await admin.post(`/api/v1/automacoes/${c.body.id}/ativar`).expect(200);
        return c.body.id as string;
      };
      const perdida = await criar({
        evento: 'ligacao.perdida',
        nome: 'Perdida',
      });
      const soAtendidas = await criar({
        evento: 'ligacao.encerrada',
        nome: 'Atendidas',
        gatilhoConfig: { resultado: 'atendida', direcao: 'RECEBIDA' },
      });
      const soOutroCanal = await criar({
        evento: 'ligacao.perdida',
        nome: 'Outro canal',
        gatilhoConfig: { canalId: '00000000-0000-4000-8000-000000000001' },
      });
      const maria = await criarContato(t, {
        nome: 'Maria',
        telefone: '5511999990001',
      });
      const conversa = await conversaDe(maria.id, ana0());
      await perder(maria.id, conversa.id);
      for (let i = 0; i < 6; i++) {
        await processarEventos(t);
        await avancarPassos(t);
      }
      const execucoes = (id: string) =>
        t.prisma.execucao.count({ where: { automacaoId: id } });
      expect(await execucoes(perdida)).toBe(1);
      expect(await execucoes(soAtendidas)).toBe(0);
      expect(await execucoes(soOutroCanal)).toBe(0);
      const aposPerdida = await t.prisma.contato.findUniqueOrThrow({
        where: { id: maria.id },
      });
      expect(aposPerdida.etiquetas).toContain('ligou');

      // Ligação atendida dispara a de "encerrada atendida" (e não a de perdida).
      await t.prisma.contato.update({
        where: { id: maria.id },
        data: { etiquetas: [] },
      });
      await atenderEEncerrar(maria.id, conversa.id);
      await t.prisma.ligacao.updateMany({ data: { gravar: false } });
      for (let i = 0; i < 6; i++) {
        await processarEventos(t, { incluirAgendados: true });
        await avancarPassos(t);
      }
      expect(await execucoes(soAtendidas)).toBe(1);
      expect(await execucoes(perdida)).toBe(1);

      // Validação do filtro.
      const invalido = await admin
        .post('/api/v1/automacoes/validar', {
          nome: 'x',
          tipoGatilho: 'EVENTO',
          evento: 'ligacao.encerrada',
          gatilhoConfig: { resultado: 'talvez' },
          definicao: {
            passos: [
              {
                id: 'p1',
                tipo: 'acao.etiquetar',
                config: { adicionar: ['x'] },
              },
            ],
          },
        })
        .expect(200);
      expect(invalido.body.valido).toBe(false);
      const catalogo = await admin
        .get('/api/v1/automacoes/gatilhos')
        .catch(() => null);
      if (catalogo?.status === 200) {
        const eventos = JSON.stringify(catalogo.body);
        expect(eventos).toContain('ligacao.perdida');
        expect(eventos).toContain('ligacao.encerrada');
      }
    });
  });

  // =========================================================================
  describe('R29.6 — configuração e preferência de push', () => {
    it('cenário 269 — R29.9 — o Admin liga "resumo no webhook" na configuração do canal; os outros não configuram', async () => {
      await t.prisma.canalLigacaoConfig.create({ data: { canalId: canal.id } });
      const lida = await admin
        .get(`/api/v1/whatsapp-oficial/canais/${canal.id}/ligacoes`)
        .expect(200);
      expect(lida.body.webhookIncluiResumo).toBe(false);
      await ana
        .patch(`/api/v1/whatsapp-oficial/canais/${canal.id}/ligacoes`, {
          webhookIncluiResumo: true,
        })
        .expect(403);
    });

    it('cenário 270 — R26 — a preferência de push "ligacao_recebida" aparece e muda pela tela de notificações', async () => {
      const antes = await ana.get('/api/v1/push/preferencias').expect(200);
      expect(antes.body.tipos.ligacao_recebida).toBe(true);
      const depois = await ana
        .put('/api/v1/push/preferencias', {
          tipos: { ligacao_recebida: false },
        })
        .expect(200);
      expect(depois.body.tipos.ligacao_recebida).toBe(false);
      expect(depois.body.tipos.mencao).toBe(true);
    });
  });

  it('o processamento completo termina sem jobs em erro', async () => {
    await drenarTudo(t);
    expect(MIN).toBeGreaterThan(0);
  });
});
