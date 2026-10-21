import type { EventoPublicado } from '../src/eventos/eventos-dominio.service';
import type { Usuario } from '../src/generated/prisma/client';
import { EntregasService } from '../src/webhooks/saida/entregas.service';
import {
  assinaturaEsperada,
  FILA_ENTREGAR,
  portaFechada,
  ServidorDeTeste,
} from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarEquipe,
  criarNegocio,
  criarUsuario,
  drenarFilas,
  entrarComo,
  etapaDoFunilBase,
  processarEventos,
} from './utils';

interface DestinoCriado {
  id: string;
  segredo: string;
}

interface Envelope {
  id: string;
  evento: string;
  ocorridoEm: string;
  dados: Record<string, unknown>;
}

describe('Webhooks de saída (e2e)', () => {
  let t: AppTeste;
  const servidor = new ServidorDeTeste();
  let adminUsuario: Usuario;
  let admin: ClienteHttp;

  beforeAll(async () => {
    await servidor.iniciar();
    // O servidor de teste escuta em 127.0.0.1: rede interna liberada (R9.1).
    t = await criarAppTeste({
      variaveis: { WEBHOOKS_PERMITIR_REDE_INTERNA: 'true' },
    });
  });

  beforeEach(async () => {
    await t.limparBanco();
    servidor.limpar();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    await t.fechar();
    await servidor.parar();
  });

  const criarDestino = async (
    corpo: Record<string, unknown> = {},
  ): Promise<DestinoCriado> => {
    const resposta = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'Destino',
        url: `${servidor.url}/hook`,
        eventos: ['contato.criado'],
        ...corpo,
      })
      .expect(201);
    const body = resposta.body as { webhook: { id: string }; segredo: string };
    return { id: body.webhook.id, segredo: body.segredo };
  };

  /** Cria um contato pela API (publica `contato.criado`) e leva o evento às entregas. */
  const criarContatoPelaApi = async (email: string): Promise<string> => {
    const resposta = await admin
      .post('/api/v1/contatos', { nome: `Contato ${email}`, email })
      .expect(201);
    await processarEventos(t);
    return (resposta.body as { contato: { id: string } }).contato.id;
  };

  const entregar = (incluirAgendados = false) =>
    drenarFilas(t, FILA_ENTREGAR, { incluirAgendados });

  const entregasDe = (webhookId: string) =>
    t.prisma.webhookEntrega.findMany({
      where: { webhookId },
      include: { historicoTentativas: { orderBy: { numero: 'asc' } } },
      orderBy: { criadoEm: 'asc' },
    });

  it('Cenário 12 (R9) — o servidor de teste recebe negocio.ganho com assinatura válida; um 500 agenda nova tentativa; o sucesso marca a entrega como entregue', async () => {
    const destino = await criarDestino({
      nome: 'ERP',
      eventos: ['negocio.ganho'],
    });
    const { membros } = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    const negocio = await criarNegocio(t, {
      area: 'COMERCIAL',
      responsavel: membros[0],
      valor: '1500.00',
      titulo: 'Contrato ACME',
    });
    const ganho = await etapaDoFunilBase(t, 'COMERCIAL', 'ganho');
    await admin
      .post(`/api/v1/negocios/${negocio.id}/mover`, { etapaId: ganho.id })
      .expect(200);
    await processarEventos(t);
    const eventoGanho = await t.prisma.eventoDominio.findFirstOrThrow({
      where: { tipo: 'negocio.ganho' },
    });
    // Só o evento assinado vira entrega (o movimento e a passagem para o CS não).
    const [pendente] = await entregasDe(destino.id);
    expect(await t.prisma.webhookEntrega.count()).toBe(1);
    expect(pendente).toMatchObject({
      eventoId: eventoGanho.id,
      tipoEvento: 'negocio.ganho',
      status: 'PENDENTE',
      tentativas: 0,
    });

    servidor.responder({ status: 500, corpo: 'erro no destino' });
    expect(await entregar()).toBe(1);
    expect(servidor.recebidos).toHaveLength(1);
    const primeiro = servidor.recebidos[0];
    expect(primeiro.metodo).toBe('POST');
    expect(primeiro.caminho).toBe('/hook');
    expect(primeiro.cabecalhos).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'CRM-BRL-Webhooks/1.0',
      'x-crm-evento': 'negocio.ganho',
      'x-crm-entrega': pendente.id,
    });
    const timestamp = primeiro.cabecalhos['x-crm-timestamp'] as string;
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    // R9.3: o destino confere a assinatura com o segredo mostrado na criação.
    expect(primeiro.cabecalhos['x-crm-assinatura']).toBe(
      assinaturaEsperada(destino.segredo, timestamp, primeiro.corpo),
    );
    const envelope = JSON.parse(primeiro.corpo) as Envelope;
    expect(Object.keys(envelope)).toEqual([
      'id',
      'evento',
      'ocorridoEm',
      'dados',
    ]);
    expect(envelope).toMatchObject({
      id: eventoGanho.id,
      evento: 'negocio.ganho',
      ocorridoEm: eventoGanho.criadoEm.toISOString(),
      dados: {
        negocioId: negocio.id,
        negocio: { titulo: 'Contrato ACME', status: 'GANHO', valor: '1500.00' },
      },
    });

    // A falha agenda a próxima tentativa para 1 minuto depois (R9.4).
    const [falhou] = await entregasDe(destino.id);
    expect(falhou).toMatchObject({
      status: 'PENDENTE',
      tentativas: 1,
      statusHttp: 500,
      trechoResposta: 'erro no destino',
      erro: 'HTTP 500 Internal Server Error',
      entregueEm: null,
    });
    expect(
      (falhou.proximaTentativaEm?.getTime() ?? 0) -
        (falhou.ultimaTentativaEm?.getTime() ?? 0),
    ).toBeGreaterThanOrEqual(59_000);
    const agendados = await t.fila.listarTrabalhos<{ entregaId: string }>(
      FILA_ENTREGAR,
    );
    expect(agendados).toHaveLength(1);
    expect(agendados[0].dados.entregaId).toBe(pendente.id);
    expect(agendados[0].executarEm.getTime()).toBe(
      falhou.proximaTentativaEm?.getTime(),
    );
    expect(await entregar()).toBe(0);
    expect(
      (
        await t.prisma.webhookSaida.findUniqueOrThrow({
          where: { id: destino.id },
        })
      ).falhasConsecutivas,
    ).toBe(1);

    // A nova tentativa recebe 200: entregue, com o mesmo envelope (R9.6).
    expect(await entregar(true)).toBe(1);
    const [entregue] = await entregasDe(destino.id);
    expect(entregue).toMatchObject({
      status: 'ENTREGUE',
      tentativas: 2,
      statusHttp: 200,
      erro: null,
      proximaTentativaEm: null,
    });
    expect(entregue.entregueEm).toBeInstanceOf(Date);
    expect(
      entregue.historicoTentativas.map(({ numero, sucesso, statusHttp }) => ({
        numero,
        sucesso,
        statusHttp,
      })),
    ).toEqual([
      { numero: 1, sucesso: false, statusHttp: 500 },
      { numero: 2, sucesso: true, statusHttp: 200 },
    ]);
    const segundo = servidor.recebidos[1];
    expect(segundo.corpo).toBe(primeiro.corpo);
    expect(segundo.cabecalhos['x-crm-entrega']).toBe(pendente.id);
    expect(segundo.cabecalhos['x-crm-assinatura']).toBe(
      assinaturaEsperada(
        destino.segredo,
        segundo.cabecalhos['x-crm-timestamp'] as string,
        segundo.corpo,
      ),
    );
    expect(
      (
        await t.prisma.webhookSaida.findUniqueOrThrow({
          where: { id: destino.id },
        })
      ).falhasConsecutivas,
    ).toBe(0);

    // O Admin vê a entrega e as tentativas (R9.5).
    const detalhe = await admin
      .get(`/api/v1/webhooks/saidas/${destino.id}/entregas/${pendente.id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      evento: 'negocio.ganho',
      status: 'ENTREGUE',
      payload: { id: eventoGanho.id, evento: 'negocio.ganho' },
      historicoTentativas: [
        {
          numero: 1,
          sucesso: false,
          statusHttp: 500,
          trechoResposta: 'erro no destino',
        },
        { numero: 2, sucesso: true, statusHttp: 200, trechoResposta: 'ok' },
      ],
    });
  });

  it('R9.2 — só os destinos ativos que assinam o evento recebem; a reentrega do evento pela outbox não duplica', async () => {
    const assinante = await criarDestino({ nome: 'A' });
    const outro = await criarDestino({ nome: 'B', eventos: ['negocio.ganho'] });
    const inativo = await criarDestino({ nome: 'C', ativo: false });
    await criarContatoPelaApi('ana@x.com');
    expect((await entregasDe(assinante.id)).length).toBe(1);
    expect((await entregasDe(outro.id)).length).toBe(0);
    expect((await entregasDe(inativo.id)).length).toBe(0);

    const registro = await t.prisma.eventoDominio.findFirstOrThrow({
      where: { tipo: 'contato.criado' },
    });
    const evento: EventoPublicado = {
      id: registro.id,
      tipo: registro.tipo,
      dados: registro.dados,
      ocorridoEm: registro.criadoEm,
      tipoAtor: registro.tipoAtor,
      usuarioId: registro.usuarioId,
      requisicaoId: registro.requisicaoId,
      tentativa: 2,
    };
    expect(await t.get(EntregasService).criarEntregas(evento)).toBe(0);
    expect(await t.prisma.webhookEntrega.count()).toBe(1);
    expect(await t.fila.listarTrabalhos(FILA_ENTREGAR)).toHaveLength(1);

    await entregar();
    expect(servidor.recebidos).toHaveLength(1);
    const envelope = JSON.parse(servidor.recebidos[0].corpo) as Envelope;
    expect(envelope).toMatchObject({
      id: registro.id,
      evento: 'contato.criado',
      dados: { email: 'ana@x.com', primeiraOrigem: { tipo: 'MANUAL' } },
    });
  });

  it('R9.4 — sem sucesso, novas tentativas em 1 min, 5 min, 30 min, 2 h, 6 h e 24 h; depois a entrega falha e os Admins são avisados', async () => {
    const outroAdmin = await criarUsuario(t, { papel: 'ADMIN' });
    const destino = await criarDestino();
    servidor.padrao = { status: 503, corpo: 'fora do ar' };
    await criarContatoPelaApi('bia@x.com');
    const esperas: number[] = [];
    for (let rodada = 0; rodada < 7; rodada++) {
      expect(
        await t.fila.drenar(FILA_ENTREGAR, {
          incluirAgendados: true,
          maxRodadas: 1,
        }),
      ).toBe(1);
      const [entrega] = await entregasDe(destino.id);
      if (entrega.proximaTentativaEm && entrega.ultimaTentativaEm) {
        esperas.push(
          Math.round(
            (entrega.proximaTentativaEm.getTime() -
              entrega.ultimaTentativaEm.getTime()) /
              1000,
          ),
        );
      }
    }
    expect(esperas).toEqual([60, 300, 1800, 7200, 21600, 86400]);
    expect(await entregar(true)).toBe(0);
    const [entrega] = await entregasDe(destino.id);
    expect(entrega).toMatchObject({
      status: 'FALHOU',
      tentativas: 7,
      statusHttp: 503,
      proximaTentativaEm: null,
    });
    expect(entrega.historicoTentativas).toHaveLength(7);
    expect(servidor.recebidos).toHaveLength(7);
    for (const usuario of [adminUsuario, outroAdmin]) {
      const avisos = await t.prisma.notificacao.findMany({
        where: { usuarioId: usuario.id, tipo: 'webhook_saida.falhou' },
      });
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toMatchObject({
        link: `/integracoes?webhookSaida=${destino.id}`,
        dados: { entregaId: entrega.id, evento: 'contato.criado' },
      });
    }
    const resposta = await admin
      .get(`/api/v1/webhooks/saidas/${destino.id}`)
      .expect(200);
    expect(resposta.body).toMatchObject({
      falhasConsecutivas: 7,
      ativo: true,
      entregas: { pendentes: 0, falhas: 1 },
    });
  });

  it('R9.4 — 20 falhas seguidas desativam o destino e avisam os Admins; reativar zera a contagem', async () => {
    const destino = await criarDestino();
    servidor.padrao = { status: 500 };
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
      await criarContatoPelaApi(email);
    }
    await entregar(true);
    // 3 entregas × 7 tentativas = 21, mas a 21ª já encontra o destino desativado.
    expect(servidor.recebidos).toHaveLength(20);
    const desativado = await t.prisma.webhookSaida.findUniqueOrThrow({
      where: { id: destino.id },
    });
    expect(desativado).toMatchObject({
      ativo: false,
      falhasConsecutivas: 20,
    });
    expect(desativado.desativadoAutomaticamenteEm).toBeInstanceOf(Date);
    const entregas = await entregasDe(destino.id);
    expect(entregas.every(({ status }) => status === 'FALHOU')).toBe(true);
    expect(
      entregas.filter(
        ({ erro }) => erro === 'Destino desativado: a entrega não foi enviada.',
      ),
    ).toHaveLength(1);
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: adminUsuario.id, tipo: 'webhook_saida.desativado' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'webhook_saida.desativado_automaticamente' },
      }),
    ).toMatchObject({ entidadeId: destino.id, tipoAtor: 'SISTEMA' });

    // Desativado, não recebe eventos novos nem aceita reenvio.
    await criarContatoPelaApi('d@x.com');
    expect(await t.prisma.webhookEntrega.count()).toBe(3);
    const reenvio = await admin
      .post(
        `/api/v1/webhooks/saidas/${destino.id}/entregas/${entregas[0].id}/reenviar`,
      )
      .expect(422);
    expect(reenvio.body).toMatchObject({ detalhes: { regra: 'R9.4' } });

    const reativado = await admin
      .patch(`/api/v1/webhooks/saidas/${destino.id}`, { ativo: true })
      .expect(200);
    expect(reativado.body).toMatchObject({
      ativo: true,
      falhasConsecutivas: 0,
      desativadoAutomaticamenteEm: null,
    });
  });

  it('R9.4 — dois jobs da mesma tentativa não enviam duas vezes; depois de um reenvio, o job antigo não vale mais', async () => {
    const destino = await criarDestino();
    await criarContatoPelaApi('dup@x.com');
    const [pendente] = await entregasDe(destino.id);
    const servico = t.get(EntregasService);
    const agendada = (pendente.proximaTentativaEm as Date).toISOString();
    await Promise.all([
      servico.executarTentativa(pendente.id, agendada),
      servico.executarTentativa(pendente.id, agendada),
    ]);
    expect(servidor.recebidos).toHaveLength(1);
    const [entregue] = await entregasDe(destino.id);
    expect(entregue).toMatchObject({ status: 'ENTREGUE', tentativas: 1 });
    expect(entregue.historicoTentativas).toHaveLength(1);

    // Falha agenda a próxima para +1 min; o reenvio passa na frente e o job
    // agendado, quando chega, vê que não é mais a vez dele.
    servidor.limpar();
    servidor.responder({ status: 500 });
    await admin
      .post(
        `/api/v1/webhooks/saidas/${destino.id}/entregas/${pendente.id}/reenviar`,
      )
      .expect(202);
    await entregar();
    expect(await t.fila.listarTrabalhos(FILA_ENTREGAR)).toHaveLength(1);
    await admin
      .post(
        `/api/v1/webhooks/saidas/${destino.id}/entregas/${pendente.id}/reenviar`,
      )
      .expect(202);
    expect(await t.fila.listarTrabalhos(FILA_ENTREGAR)).toHaveLength(2);
    await entregar(true);
    expect(servidor.recebidos).toHaveLength(2);
    const [final] = await entregasDe(destino.id);
    expect(final).toMatchObject({ status: 'ENTREGUE', tentativas: 1 });
    expect(final.historicoTentativas).toHaveLength(3);
  });

  it('R9.5 — reenviar recomeça as tentativas pela fila, com o mesmo envelope; o histórico guarda todas', async () => {
    const destino = await criarDestino();
    servidor.padrao = { status: 500 };
    await criarContatoPelaApi('rui@x.com');
    await entregar(true);
    const [falhou] = await entregasDe(destino.id);
    expect(falhou.status).toBe('FALHOU');

    servidor.padrao = { status: 202, corpo: 'recebido' };
    const resposta = await admin
      .post(
        `/api/v1/webhooks/saidas/${destino.id}/entregas/${falhou.id}/reenviar`,
      )
      .expect(202);
    expect(resposta.body).toMatchObject({
      status: 'PENDENTE',
      tentativas: 0,
      eventoId: falhou.eventoId,
    });
    expect(await entregar()).toBe(1);
    const [entregue] = await entregasDe(destino.id);
    expect(entregue).toMatchObject({
      status: 'ENTREGUE',
      tentativas: 1,
      statusHttp: 202,
    });
    expect(entregue.historicoTentativas.map(({ numero }) => numero)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const corpos = new Set(servidor.recebidos.map(({ corpo }) => corpo));
    expect(corpos.size).toBe(1);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'webhook_entrega.reenviada', entidadeId: falhou.id },
      }),
    ).toBe(1);

    // Reenviar uma entregue também vale (o consumidor deduplica pelo id, R9.6).
    await admin
      .post(
        `/api/v1/webhooks/saidas/${destino.id}/entregas/${falhou.id}/reenviar`,
      )
      .expect(202);
    await entregar();
    expect(servidor.recebidos).toHaveLength(9);
    const lista = await admin
      .get(`/api/v1/webhooks/saidas/${destino.id}/entregas?status=ENTREGUE`)
      .expect(200);
    expect(lista.body).toMatchObject({ total: 1 });
    expect(lista.body.itens[0]).not.toHaveProperty('payload');
  });

  it('R9.5 — evento de teste: webhook.teste só para o destino, na hora, sem novas tentativas nem contar falha', async () => {
    const destino = await criarDestino({ nome: 'TicketHub' });
    const resposta = await admin
      .post(`/api/v1/webhooks/saidas/${destino.id}/testar`)
      .expect(200);
    expect(resposta.body).toMatchObject({
      evento: 'webhook.teste',
      status: 'ENTREGUE',
      statusHttp: 200,
      tentativas: 1,
      historicoTentativas: [{ numero: 1, sucesso: true, statusHttp: 200 }],
    });
    expect(servidor.recebidos).toHaveLength(1);
    const pedido = servidor.recebidos[0];
    expect(pedido.cabecalhos['x-crm-evento']).toBe('webhook.teste');
    expect(pedido.cabecalhos['x-crm-assinatura']).toBe(
      assinaturaEsperada(
        destino.segredo,
        pedido.cabecalhos['x-crm-timestamp'] as string,
        pedido.corpo,
      ),
    );
    expect(JSON.parse(pedido.corpo)).toMatchObject({
      evento: 'webhook.teste',
      dados: {
        destino: { id: destino.id, nome: 'TicketHub' },
        solicitadoPor: { id: adminUsuario.id, nome: 'Admin' },
      },
    });

    servidor.padrao = { status: 500 };
    const falha = await admin
      .post(`/api/v1/webhooks/saidas/${destino.id}/testar`)
      .expect(200);
    expect(falha.body).toMatchObject({
      status: 'FALHOU',
      statusHttp: 500,
      proximaTentativaEm: null,
    });
    expect(await t.fila.listarTrabalhos(FILA_ENTREGAR)).toHaveLength(0);
    const depois = await t.prisma.webhookSaida.findUniqueOrThrow({
      where: { id: destino.id },
    });
    expect(depois.falhasConsecutivas).toBe(0);
    expect(
      await t.prisma.notificacao.count({
        where: { tipo: 'webhook_saida.falhou' },
      }),
    ).toBe(0);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'webhook_saida.teste_enviado', entidadeId: destino.id },
      }),
    ).toBe(2);
  });

  it('R9.1/R10.3 — segredo gerado e mostrado uma vez; cabeçalhos extras cifrados, mascarados e enviados; regenerar troca a assinatura', async () => {
    const criado = await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'Com cabeçalhos',
        url: `${servidor.url}/com-cabecalhos?origem=crm`,
        eventos: ['contato.criado', 'webhook.teste'],
        cabecalhos: { Authorization: 'Bearer chave-secreta-1234' },
      })
      .expect(201);
    const { webhook, segredo } = criado.body as {
      webhook: Record<string, unknown> & { id: string };
      segredo: string;
    };
    expect(segredo).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(webhook).toMatchObject({
      segredoMascarado: `••••••••${segredo.slice(-4)}`,
      cabecalhos: [{ nome: 'Authorization', valorMascarado: '••••••••1234' }],
      falhasConsecutivas: 0,
      entregas: { pendentes: 0, falhas: 0 },
    });
    const detalhe = await admin
      .get(`/api/v1/webhooks/saidas/${webhook.id}`)
      .expect(200);
    expect(JSON.stringify(detalhe.body)).not.toContain(segredo);
    expect(JSON.stringify(detalhe.body)).not.toContain('chave-secreta');
    const gravado = await t.prisma.webhookSaida.findUniqueOrThrow({
      where: { id: webhook.id },
    });
    expect(gravado.segredoCifrado).not.toContain(segredo);
    expect(gravado.cabecalhosCifrados).not.toContain('chave-secreta');
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'webhook_saida.criado', entidadeId: webhook.id },
    });
    expect(JSON.stringify(auditoria.dados)).not.toMatch(
      /chave-secreta|com-cabecalhos/,
    );

    await admin
      .post(`/api/v1/webhooks/saidas/${webhook.id}/testar`)
      .expect(200);
    expect(servidor.recebidos[0].cabecalhos.authorization).toBe(
      'Bearer chave-secreta-1234',
    );
    expect(servidor.recebidos[0].caminho).toBe('/com-cabecalhos?origem=crm');

    // Atualização parcial dos cabeçalhos: null remove, os novos entram.
    const editado = await admin
      .patch(`/api/v1/webhooks/saidas/${webhook.id}`, {
        cabecalhos: { authorization: null, 'X-Tenant': 'brl' },
      })
      .expect(200);
    expect(editado.body.cabecalhos).toEqual([
      { nome: 'X-Tenant', valorMascarado: '••••••••' },
    ]);
    await admin
      .patch(`/api/v1/webhooks/saidas/${webhook.id}`, {
        cabecalhos: { 'X-CRM-Evento': 'falso' },
      })
      .expect(400);

    const regenerado = await admin
      .post(`/api/v1/webhooks/saidas/${webhook.id}/regenerar-segredo`)
      .expect(200);
    const novo = (regenerado.body as { segredo: string }).segredo;
    expect(novo).not.toBe(segredo);
    await admin
      .post(`/api/v1/webhooks/saidas/${webhook.id}/testar`)
      .expect(200);
    const ultimo = servidor.recebidos.at(-1);
    const ts = ultimo?.cabecalhos['x-crm-timestamp'] as string;
    expect(ultimo?.cabecalhos['x-tenant']).toBe('brl');
    expect(ultimo?.cabecalhos.authorization).toBeUndefined();
    expect(ultimo?.cabecalhos['x-crm-assinatura']).toBe(
      assinaturaEsperada(novo, ts, ultimo?.corpo ?? ''),
    );
    expect(ultimo?.cabecalhos['x-crm-assinatura']).not.toBe(
      assinaturaEsperada(segredo, ts, ultimo?.corpo ?? ''),
    );

    // Eventos válidos (R9.2) e nome único.
    await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'X',
        url: `${servidor.url}/x`,
        eventos: ['contato.removido'],
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/saidas', {
        nome: 'com cabeçalhos',
        url: `${servidor.url}/x`,
        eventos: ['contato.criado'],
      })
      .expect(409);
    const eventos = await admin
      .get('/api/v1/webhooks/saidas/eventos')
      .expect(200);
    expect((eventos.body as { evento: string }[]).map((e) => e.evento)).toEqual(
      [
        'contato.criado',
        'contato.atualizado',
        'negocio.criado',
        'negocio.movido',
        'negocio.ganho',
        'negocio.perdido',
        'atividade.criada',
        'atividade.concluida',
        'usuario.desligado',
        'webhook.teste',
      ],
    );
  });

  it('R9.5 — guarda até 2 KB da resposta e o erro de conexão', async () => {
    const destino = await criarDestino();
    servidor.responder({ status: 400, corpo: 'x'.repeat(10_000) });
    await criarContatoPelaApi('ze@x.com');
    await entregar();
    const [entrega] = await entregasDe(destino.id);
    expect(entrega.statusHttp).toBe(400);
    expect(entrega.trechoResposta).toHaveLength(2_048);
    expect(entrega.historicoTentativas[0].trechoResposta).toHaveLength(2_048);

    // Destino que não responde (porta fechada): erro de conexão registrado.
    await t.prisma.webhookSaida.update({
      where: { id: destino.id },
      data: { url: `http://127.0.0.1:${await portaFechada()}/fechado` },
    });
    await entregar(true);
    const [depois] = await entregasDe(destino.id);
    expect(depois.historicoTentativas[1]).toMatchObject({
      sucesso: false,
      statusHttp: null,
    });
    expect(depois.historicoTentativas[1].erro).toMatch(
      /^Falha de conexão \(ECONNREFUSED\)/,
    );
  });

  it('R4.6 — a anonimização do contato tira os dados pessoais dos envelopes guardados', async () => {
    const destino = await criarDestino();
    servidor.padrao = { status: 500 };
    const contatoId = await criarContatoPelaApi('lgpd@x.com');
    await entregar();
    const [antes] = await entregasDe(destino.id);
    expect(JSON.stringify(antes.payload)).toContain('lgpd@x.com');

    await admin
      .post(`/api/v1/contatos/${contatoId}/anonimizar`, { motivo: 'Pedido' })
      .expect(204);
    await processarEventos(t);
    const entregas = await entregasDe(destino.id);
    const original = entregas.find(({ id }) => id === antes.id);
    expect(original?.payload).toMatchObject({
      evento: 'contato.criado',
      dados: { contatoId, anonimizado: true },
    });
    expect(
      JSON.stringify(entregas.map(({ payload }) => payload)),
    ).not.toContain('lgpd@x.com');
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: 'webhook_entrega.dados_apagados',
          relacionados: { has: `contato:${contatoId}` },
        },
      }),
    ).toBe(1);
    // A próxima tentativa já sai sem os dados pessoais.
    servidor.padrao = { status: 200 };
    servidor.recebidos.length = 0;
    await entregar(true);
    expect(servidor.recebidos.map(({ corpo }) => corpo).join()).not.toContain(
      'lgpd@x.com',
    );
  });

  it('R9.1 — só o Admin gerencia webhooks de saída', async () => {
    const cLevel = await entrarComo(
      t,
      await criarUsuario(t, { papel: 'C_LEVEL' }),
    );
    await cLevel.get('/api/v1/webhooks/saidas').expect(403);
    await cLevel
      .post('/api/v1/webhooks/saidas', {
        nome: 'X',
        url: `${servidor.url}/x`,
        eventos: ['contato.criado'],
      })
      .expect(403);
  });

  it('documenta as rotas no Swagger', async () => {
    const documento = await admin.get('/api/docs-json').expect(200);
    expect(Object.keys(documento.body.paths as object)).toEqual(
      expect.arrayContaining([
        '/api/v1/webhooks/saidas',
        '/api/v1/webhooks/saidas/eventos',
        '/api/v1/webhooks/saidas/{id}',
        '/api/v1/webhooks/saidas/{id}/regenerar-segredo',
        '/api/v1/webhooks/saidas/{id}/testar',
        '/api/v1/webhooks/saidas/{id}/entregas',
        '/api/v1/webhooks/saidas/{id}/entregas/{entregaId}',
        '/api/v1/webhooks/saidas/{id}/entregas/{entregaId}/reenviar',
      ]),
    );
  });
});
