import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { RegraVioladaException } from '../src/comum/erros/excecoes';
import { ContatosService } from '../src/contatos/contatos.service';
import type { Usuario } from '../src/generated/prisma/client';
import { ProcessamentoEntradaService } from '../src/webhooks/entrada/processamento-entrada.service';
import {
  assinarCorpo,
  enviarLead,
  FILA_PROCESSAR,
  tokenDaUrl,
} from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
  etapaDoFunilBase,
  funilBase,
  processarEventos,
} from './utils';

interface PontoCriado {
  id: string;
  url: string;
  token: string;
  segredo?: string;
}

describe('Webhooks de entrada (e2e)', () => {
  let t: AppTeste;
  let adminUsuario: Usuario;
  let admin: ClienteHttp;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(() => t.fechar());

  const criarPonto = async (
    corpo: Record<string, unknown> = {},
  ): Promise<PontoCriado> => {
    const resposta = await admin
      .post('/api/v1/webhooks/entradas', { nome: 'Landing', ...corpo })
      .expect(201);
    const body = resposta.body as {
      webhook: { id: string };
      url: string;
      segredo?: string;
    };
    return {
      id: body.webhook.id,
      url: body.url,
      token: tokenDaUrl(body.url),
      segredo: body.segredo,
    };
  };

  const processar = () =>
    drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });

  const recebimento = (id: string) =>
    t.prisma.webhookRecebimento.findUniqueOrThrow({ where: { id } });

  it('R8.1 — só o Admin configura webhooks de entrada (C-level, líder e membro recebem 403)', async () => {
    const { cLevel, lider, membros } = await criarEquipe(t, 'MARKETING');
    for (const usuario of [cLevel, lider, membros[0]]) {
      const cliente = await entrarComo(t, usuario);
      await cliente.get('/api/v1/webhooks/entradas').expect(403);
      await cliente
        .post('/api/v1/webhooks/entradas', { nome: 'X' })
        .expect(403);
    }
    await admin.get('/api/v1/webhooks/entradas').expect(200);
  });

  it('R8.1/R8.2 — cria com os padrões (Marketing / Novo lead, rodízio, Genérico); a URL com o token só aparece ao criar; o banco guarda só o hash', async () => {
    const resposta = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: '  Landing Black Friday ',
        etiquetasFixas: ['Landing', ' landing ', 'BF'],
      })
      .expect(201);
    const { webhook, url, segredo } = resposta.body as {
      webhook: Record<string, unknown> & { id: string; tokenPrefixo: string };
      url: string;
      segredo?: string;
    };
    expect(segredo).toBeUndefined();
    expect(url).toMatch(
      /^http:\/\/localhost:4200\/api\/v1\/webhooks\/entrada\/[A-Za-z0-9_-]{43}$/,
    );
    const token = tokenDaUrl(url);
    const marketing = await funilBase(t, 'MARKETING');
    const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
    expect(webhook).toMatchObject({
      nome: 'Landing Black Friday',
      tokenPrefixo: token.slice(0, 8),
      enderecoMascarado: `http://localhost:4200/api/v1/webhooks/entrada/${token.slice(0, 8)}…`,
      funil: { id: marketing.id, nome: 'Marketing', area: 'MARKETING' },
      etapa: { id: novoLead.id, nome: 'Novo lead', tipo: 'ABERTA' },
      estrategia: 'RODIZIO',
      responsavelFixo: null,
      modeloMapeamento: 'GENERICO',
      etiquetasFixas: ['Landing', 'BF'],
      exigeAssinatura: false,
      segredoMascarado: null,
      ativo: true,
      recebimentos24h: { total: 0, erros: 0 },
      criadoPor: { id: adminUsuario.id, nome: 'Admin' },
    });
    expect(
      (webhook.mapeamento as { campos: { caminho: string }[] }).campos.map(
        ({ caminho }) => caminho,
      ),
    ).toEqual([
      'name',
      'email',
      'phone',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
    ]);

    const detalhe = await admin
      .get(`/api/v1/webhooks/entradas/${webhook.id}`)
      .expect(200);
    expect(JSON.stringify(detalhe.body)).not.toContain(token);
    const lista = await admin.get('/api/v1/webhooks/entradas').expect(200);
    expect(JSON.stringify(lista.body)).not.toContain(token);
    expect(lista.body).toMatchObject({ total: 1, pagina: 1 });

    const gravado = await t.prisma.webhookEntrada.findUniqueOrThrow({
      where: { id: webhook.id },
    });
    expect(gravado.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(JSON.stringify(gravado)).not.toContain(token);
    const auditoria = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'webhook_entrada.criado', entidadeId: webhook.id },
    });
    expect(auditoria).toMatchObject({
      tipoAtor: 'USUARIO',
      usuarioId: adminUsuario.id,
    });
    expect(JSON.stringify(auditoria.dados)).not.toContain(token);

    // Nome único entre os pontos (sem diferenciar maiúsculas).
    await admin
      .post('/api/v1/webhooks/entradas', { nome: 'landing black friday' })
      .expect(409);
  });

  it('R8.2 — regenerar o token: o endereço novo aparece uma vez e o antigo passa a responder 404', async () => {
    const ponto = await criarPonto();
    const resposta = await admin
      .post(`/api/v1/webhooks/entradas/${ponto.id}/regenerar-token`)
      .expect(200);
    const novo = tokenDaUrl((resposta.body as { url: string }).url);
    expect(novo).not.toBe(ponto.token);
    await enviarLead(t, ponto.token, {
      name: 'Ana',
      email: 'ana@x.com',
    }).expect(404);
    await enviarLead(t, novo, { name: 'Ana', email: 'ana@x.com' }).expect(202);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: 'webhook_entrada.token_regenerado',
          entidadeId: ponto.id,
        },
      }),
    ).toBe(1);
  });

  it('Cenário 7 (R8, R4.2, R5.8) — payload mapeado → 202; contato com origem e UTM, negócio em Marketing / Novo lead, rodízio alternando; o mesmo e-mail não duplica e registra reconversão', async () => {
    const {
      membros: [ana, bruno],
    } = await criarEquipe(t, 'MARKETING', { membros: 2 });
    const ponto = await criarPonto({ etiquetasFixas: ['Landing'] });
    const leads = [
      { name: 'Maria Souza', email: 'maria@x.com', phone: '(11) 98765-4321' },
      { name: 'João Lima', email: 'joao@x.com' },
      { name: 'Carla Dias', phone: '21987654321' },
    ].map((lead) => ({
      ...lead,
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'bf',
    }));
    const ids: string[] = [];
    for (const [indice, lead] of leads.entries()) {
      const resposta = await enviarLead(t, ponto.token, lead, {
        'User-Agent': 'Sistema-Origem/2.0',
      }).expect(202);
      expect(resposta.body).toEqual({
        id: expect.any(String) as string,
        status: 'RECEBIDO',
      });
      const id = (resposta.body as { id: string }).id;
      ids.push(id);
      if (indice === 0) {
        // R8.4: a resposta é imediata; o processamento está na fila.
        expect((await recebimento(id)).status).toBe('RECEBIDO');
        expect(await t.prisma.contato.count()).toBe(0);
        expect(await t.fila.listarTrabalhos(FILA_PROCESSAR)).toHaveLength(1);
      }
      // Um por vez: dentro de um lote, a fila não garante a ordem (R9.6 vale aqui também).
      expect(await processar()).toBe(1);
    }

    const marketing = await funilBase(t, 'MARKETING');
    const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
    const responsaveis: (string | null)[] = [];
    for (const [indice, id] of ids.entries()) {
      const r = await recebimento(id);
      expect(r).toMatchObject({ status: 'PROCESSADO', tentativas: 1 });
      expect(r.mensagem).toMatch(
        /^Contato ".+" criado; negócio criado em Marketing \/ Novo lead, com /,
      );
      const contato = await t.prisma.contato.findUniqueOrThrow({
        where: { id: r.contatoId ?? '' },
      });
      expect(contato).toMatchObject({
        nome: leads[indice].name,
        primeiraOrigem: 'WEBHOOK',
        primeiraOrigemDetalhe: 'Landing',
        primeiraOrigemUtm: { source: 'google', medium: 'cpc', campaign: 'bf' },
        ultimaOrigem: 'WEBHOOK',
        etiquetas: ['Landing'],
        conversoes: 1,
      });
      const negocio = await t.prisma.negocio.findUniqueOrThrow({
        where: { id: r.negocioId ?? '' },
      });
      expect(negocio).toMatchObject({
        contatoId: contato.id,
        funilId: marketing.id,
        etapaId: novoLead.id,
        status: 'ABERTO',
        origem: 'WEBHOOK',
        origemDetalhe: 'Landing',
        utm: { source: 'google', medium: 'cpc', campaign: 'bf' },
      });
      // R4.5: o contato fica com o responsável do negócio que o originou.
      expect(contato.responsavelId).toBe(negocio.responsavelId);
      responsaveis.push(negocio.responsavelId);
    }
    expect(responsaveis).toEqual([ana.id, bruno.id, ana.id]);
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'maria@x.com' },
      }),
    ).toMatchObject({ telefone: '5511987654321' });

    // O responsável é avisado (R8.5), uma vez por lead.
    expect(
      await t.prisma.notificacao.count({
        where: { usuarioId: ana.id, tipo: 'negocio.atribuido' },
      }),
    ).toBe(2);
    // Auditoria com ator WEBHOOK, o nome do ponto e o IP de quem chamou (R8.5, R3.1).
    const criado = await t.prisma.eventoAuditoria.findFirstOrThrow({
      where: { acao: 'contato.criado' },
    });
    expect(criado).toMatchObject({
      tipoAtor: 'WEBHOOK',
      atorDescricao: 'Landing',
      usuarioId: null,
      userAgent: 'Sistema-Origem/2.0',
    });
    expect(criado.ip).toBeTruthy();
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'negocio.criado', tipoAtor: 'WEBHOOK' },
      }),
    ).toBe(3);

    // Segundo envio com o mesmo e-mail: não duplica, reconverte (R4.2) e não
    // abre outro negócio no funil (R5.6).
    const segundo = await enviarLead(t, ponto.token, {
      name: 'Maria S.',
      email: 'MARIA@X.COM',
      utm_source: 'facebook',
    }).expect(202);
    await processar();
    expect(await t.prisma.contato.count()).toBe(3);
    expect(await t.prisma.negocio.count()).toBe(3);
    const maria = await t.prisma.contato.findFirstOrThrow({
      where: { email: 'maria@x.com' },
    });
    expect(maria).toMatchObject({
      nome: 'Maria Souza',
      conversoes: 2,
      primeiraOrigemUtm: { source: 'google', medium: 'cpc', campaign: 'bf' },
      ultimaOrigemUtm: { source: 'facebook' },
    });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: {
          acao: 'contato.reconvertido',
          entidadeId: maria.id,
          tipoAtor: 'WEBHOOK',
        },
      }),
    ).toBe(1);
    const negocioDaMaria = await t.prisma.negocio.findFirstOrThrow({
      where: { contatoId: maria.id },
    });
    expect(negocioDaMaria.reconversoes).toBe(1);
    const segundoRecebimento = await recebimento(
      (segundo.body as { id: string }).id,
    );
    expect(segundoRecebimento).toMatchObject({
      status: 'PROCESSADO',
      contatoId: maria.id,
      negocioId: negocioDaMaria.id,
    });
    expect(segundoRecebimento.mensagem).toMatch(
      /reconvertido \(já existia\); reconversão registrada no negócio aberto/,
    );

    // Os eventos dos módulos de contatos e funis seguem pela outbox.
    expect(await processarEventos(t)).toBeGreaterThan(0);
    const ponto24h = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}`)
      .expect(200);
    expect(ponto24h.body).toMatchObject({
      recebimentos24h: { total: 4, erros: 0 },
      ultimoRecebimentoEm: expect.any(String) as string,
    });
  });

  it('R8.1 — modelo Disparos BRL: telefone do whatsapp quando falta o phone, faturamento e planilha_* em campos personalizados; envio de teste é ignorado', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto({
      nome: 'Disparos',
      modeloMapeamento: 'DISPAROS_BRL',
    });
    const lead = await enviarLead(t, ponto.token, {
      name: 'Lead do Disparo',
      email: '',
      phone: '',
      faturamento: 'Acima de R$ 80 mil',
      whatsapp: '5511999998888',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'São Paulo',
      planilha_segmento: 'Varejo',
    }).expect(202);
    const teste = await enviarLead(t, ponto.token, {
      name: 'Lead de Teste',
      email: 'teste@exemplo.com.br',
      phone: '(11) 99999-8888',
      campanha: 'Teste de webhook',
      teste: true,
    }).expect(202);
    await processar();

    const processado = await recebimento((lead.body as { id: string }).id);
    expect(processado.status).toBe('PROCESSADO');
    const contato = await t.prisma.contato.findUniqueOrThrow({
      where: { id: processado.contatoId ?? '' },
    });
    expect(contato).toMatchObject({
      nome: 'Lead do Disparo',
      email: null,
      telefone: '5511999998888',
      primeiraOrigemDetalhe: 'Disparos',
      primeiraOrigemUtm: {
        campaign: 'Black Friday',
        source: 'Disparos WhatsApp',
      },
      camposPersonalizados: {
        whatsapp: '5511999998888',
        faturamento: 'Acima de R$ 80 mil',
        planilha_cidade: 'São Paulo',
        planilha_segmento: 'Varejo',
      },
    });
    const ignorado = await recebimento((teste.body as { id: string }).id);
    expect(ignorado).toMatchObject({
      status: 'IGNORADO',
      contatoId: null,
      tentativas: 1,
    });
    expect(ignorado.mensagem).toMatch(/"teste" veio igual a true/);
    expect(await t.prisma.contato.count()).toBe(1);
  });

  it('R8.2 — aceita application/x-www-form-urlencoded', async () => {
    const ponto = await criarPonto();
    const resposta = await enviarLead(
      t,
      ponto.token,
      'name=Paula+Reis&email=paula%40x.com&utm_source=site',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    ).expect(202);
    await processar();
    const r = await recebimento((resposta.body as { id: string }).id);
    expect(r).toMatchObject({
      status: 'PROCESSADO',
      tipoConteudo: 'application/x-www-form-urlencoded',
      corpo: { name: 'Paula Reis', email: 'paula@x.com', utm_source: 'site' },
    });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'paula@x.com' },
      }),
    ).toMatchObject({
      nome: 'Paula Reis',
      primeiraOrigemUtm: { source: 'site' },
    });
  });

  it('Cenário 8 (R8.3) — com segredo, assinatura ausente ou inválida → 401 e recebimento com erro; a do corpo bruto passa', async () => {
    const ponto = await criarPonto({ gerarSegredo: true });
    expect(ponto.segredo).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const segredo = ponto.segredo as string;
    const detalhe = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      exigeAssinatura: true,
      segredoMascarado: `••••••••${segredo.slice(-4)}`,
    });
    const gravado = await t.prisma.webhookEntrada.findUniqueOrThrow({
      where: { id: ponto.id },
    });
    expect(gravado.segredoCifrado).toMatch(/^v1\./);
    expect(gravado.segredoCifrado).not.toContain(segredo);

    // O corpo bruto, com espaços: a assinatura vale para estes bytes exatos.
    const bruto = '{ "name": "Ana Paula",  "email": "ana@x.com" }';
    const semAssinatura = await enviarLead(t, ponto.token, bruto).expect(401);
    expect(semAssinatura.body).toMatchObject({
      erro: 'nao_autenticado',
      detalhes: { regra: 'R8.3' },
    });
    const invalida = await enviarLead(t, ponto.token, bruto, {
      'X-Assinatura': assinarCorpo(
        segredo,
        '{"name":"Ana Paula","email":"ana@x.com"}',
      ),
    }).expect(401);
    const recusado = await recebimento(
      (invalida.body as { detalhes: { recebimentoId: string } }).detalhes
        .recebimentoId,
    );
    expect(recusado).toMatchObject({
      status: 'ERRO',
      tentativas: 0,
      corpo: { name: 'Ana Paula', email: 'ana@x.com' },
    });
    expect(recusado.mensagem).toBe(
      'Assinatura inválida: X-Assinatura não confere com o HMAC-SHA256 do corpo.',
    );
    expect(
      await t.prisma.webhookRecebimento.count({ where: { status: 'ERRO' } }),
    ).toBe(2);

    const valida = await enviarLead(t, ponto.token, bruto, {
      'X-Assinatura': assinarCorpo(segredo, bruto),
    }).expect(202);
    expect(await t.fila.listarTrabalhos(FILA_PROCESSAR)).toHaveLength(1);
    await processar();
    expect((await recebimento((valida.body as { id: string }).id)).status).toBe(
      'PROCESSADO',
    );

    // O recusado na chegada não pode ser reprocessado (passaria sem assinatura).
    const reprocessar = await admin
      .post(
        `/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${recusado.id}/reprocessar`,
      )
      .expect(422);
    expect(reprocessar.body).toMatchObject({ detalhes: { regra: 'R8.6' } });
    const lista = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}/recebimentos?status=ERRO`)
      .expect(200);
    expect(lista.body).toMatchObject({ total: 2 });
    expect(lista.body.itens[0]).toMatchObject({
      recusadoNaRecepcao: true,
      podeReprocessar: false,
    });

    // Remover o segredo libera as chamadas sem assinatura.
    await admin
      .delete(`/api/v1/webhooks/entradas/${ponto.id}/segredo`)
      .expect(200);
    await enviarLead(t, ponto.token, { name: 'B', email: 'b@x.com' }).expect(
      202,
    );
    // Definir um segredo informado pelo Admin: a resposta não o repete.
    const definido = await admin
      .post(`/api/v1/webhooks/entradas/${ponto.id}/segredo`, {
        segredo: 'segredo-combinado-123',
      })
      .expect(200);
    expect(definido.body.segredo).toBeUndefined();
    await enviarLead(t, ponto.token, '{"name":"C","email":"c@x.com"}', {
      'X-Assinatura': assinarCorpo(
        'segredo-combinado-123',
        '{"name":"C","email":"c@x.com"}',
      ),
    }).expect(202);
  });

  it('R8.7 — token inexistente: 404; ponto desativado: 410; mais de 60 chamadas por minuto: 429 com Retry-After', async () => {
    await enviarLead(t, 'token-que-nao-existe-1234567890', {
      name: 'A',
      email: 'a@x.com',
    }).expect(404);
    await enviarLead(t, 'curto', { name: 'A' }).expect(404);

    const ponto = await criarPonto();
    // 59 chamadas no último minuto + 1 de verdade = 60: a próxima passa do limite.
    const agora = Date.now();
    await t.prisma.webhookRecebimento.createMany({
      data: Array.from({ length: 59 }, (_, indice) => ({
        webhookId: ponto.id,
        recebidoEm: new Date(agora - 50_000 + indice * 100),
        status: 'PROCESSADO' as const,
      })),
    });
    await enviarLead(t, ponto.token, { name: 'A', email: 'a@x.com' }).expect(
      202,
    );
    const limitado = await enviarLead(t, ponto.token, {
      name: 'B',
      email: 'b@x.com',
    }).expect(429);
    expect(limitado.body).toMatchObject({
      erro: 'muitas_tentativas',
      detalhes: { regra: 'R8.7' },
    });
    const espera = Number(limitado.headers['retry-after']);
    expect(espera).toBeGreaterThanOrEqual(1);
    expect(espera).toBeLessThanOrEqual(11);
    expect(
      await t.prisma.webhookRecebimento.count({
        where: { webhookId: ponto.id },
      }),
    ).toBe(60);
    expect(
      await t.prisma.logTecnico.count({
        where: { contexto: 'Webhooks', nivel: 'AVISO' },
      }),
    ).toBe(1);

    await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, { ativo: false })
      .expect(200);
    const desativado = await enviarLead(t, ponto.token, {
      name: 'A',
      email: 'a@x.com',
    }).expect(410);
    expect(desativado.body).toMatchObject({ erro: 'desativado' });

    await admin.delete(`/api/v1/webhooks/entradas/${ponto.id}`).expect(204);
    await enviarLead(t, ponto.token, { name: 'A', email: 'a@x.com' }).expect(
      404,
    );
    await admin.get(`/api/v1/webhooks/entradas/${ponto.id}`).expect(404);
  });

  it('R8.2 — corpo acima de 256 KB: 413; tipo não suportado: 415 (os dois registrados como erro, sem o corpo)', async () => {
    const ponto = await criarPonto();
    const grande = await enviarLead(t, ponto.token, {
      name: 'A',
      email: 'a@x.com',
      extra: 'x'.repeat(300 * 1024),
    }).expect(413);
    expect(grande.body).toMatchObject({
      erro: 'muito_grande',
      detalhes: { regra: 'R8.2' },
    });
    const texto = await enviarLead(t, ponto.token, 'name=A', {
      'Content-Type': 'text/plain',
    }).expect(415);
    expect(texto.body).toMatchObject({ erro: 'tipo_nao_suportado' });
    const recusados = await t.prisma.webhookRecebimento.findMany({
      where: { webhookId: ponto.id },
      orderBy: { recebidoEm: 'asc' },
    });
    expect(
      recusados.map(({ status, corpo, tentativas }) => ({
        status,
        corpo,
        tentativas,
      })),
    ).toEqual([
      { status: 'ERRO', corpo: null, tentativas: 0 },
      { status: 'ERRO', corpo: null, tentativas: 0 },
    ]);
    expect(recusados[0].mensagem).toMatch(/limite é 256 KB/);
    expect(recusados[1].mensagem).toMatch(/text\/plain/);
    expect(await t.fila.listarTrabalhos(FILA_PROCESSAR)).toHaveLength(0);
  });

  it('R8.5/R8.6 — sem nome vira erro sem novas tentativas; corrigido o mapeamento, o reprocessamento processa; o processado não reprocessa (409)', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto();
    const vazio = await enviarLead(t, ponto.token).expect(202);
    const resposta = await enviarLead(t, ponto.token, {
      full_name: 'Rita Alves',
      email: 'rita@x.com',
    }).expect(202);
    const id = (resposta.body as { id: string }).id;
    await processar();
    expect(await recebimento((vazio.body as { id: string }).id)).toMatchObject({
      status: 'IGNORADO',
      mensagem: 'Corpo vazio: nada a processar.',
    });
    const comErro = await recebimento(id);
    expect(comErro).toMatchObject({ status: 'ERRO', tentativas: 1 });
    expect(comErro.mensagem).toBe(
      'Sem nome: o caminho "name" não trouxe valor.',
    );
    expect(await t.fila.listarTrabalhos(FILA_PROCESSAR)).toHaveLength(0);

    // A prévia sobre o recebimento guardado mostra o problema…
    const previa = await admin
      .post(`/api/v1/webhooks/entradas/${ponto.id}/previa`, {
        recebimentoId: id,
      })
      .expect(200);
    expect(previa.body).toMatchObject({
      valido: false,
      problemas: [comErro.mensagem],
    });

    // …o Admin corrige o mapeamento (só `mapeamento` = PERSONALIZADO) e reprocessa.
    await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, {
        mapeamento: {
          campos: [
            { caminho: 'full_name', destino: 'nome' },
            { caminho: 'name', destino: 'nome' },
            { caminho: 'email', destino: 'email' },
          ],
        },
      })
      .expect(200)
      .expect((r) => expect(r.body.modeloMapeamento).toBe('PERSONALIZADO'));
    const reprocessado = await admin
      .post(
        `/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${id}/reprocessar`,
      )
      .expect(202);
    expect(reprocessado.body).toMatchObject({
      status: 'RECEBIDO',
      podeReprocessar: true,
    });
    await processar();
    const processado = await recebimento(id);
    expect(processado).toMatchObject({ status: 'PROCESSADO', tentativas: 2 });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'rita@x.com' },
      }),
    ).toMatchObject({ nome: 'Rita Alves' });
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'webhook_recebimento.reprocessado', entidadeId: id },
      }),
    ).toBe(1);

    const repetido = await admin
      .post(
        `/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${id}/reprocessar`,
      )
      .expect(409);
    expect(repetido.body).toMatchObject({
      detalhes: { regra: 'R8.6', contatoId: processado.contatoId },
    });

    // Detalhe com o corpo e os cabeçalhos guardados (sem credenciais).
    const detalhe = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${id}`)
      .expect(200);
    expect(detalhe.body).toMatchObject({
      corpo: { full_name: 'Rita Alves', email: 'rita@x.com' },
      contato: { id: processado.contatoId, nome: 'Rita Alves' },
      cabecalhos: {
        'content-type': expect.stringMatching(/^application\/json/) as string,
      },
    });
  });

  it('R8.7 — o limite vale com chamadas simultâneas: de 70 ao mesmo tempo, 60 entram', async () => {
    const ponto = await criarPonto();
    // O supertest abre o servidor a cada pedido: 70 de uma vez passam do
    // limite padrão de ouvintes do Node (só aviso).
    (t.servidor as unknown as Server).setMaxListeners(100);
    const respostas = await Promise.all(
      Array.from({ length: 70 }, (_, indice) =>
        enviarLead(t, ponto.token, {
          name: `Lead ${indice}`,
          email: `lead${indice}@x.com`,
        }),
      ),
    );
    const contagem = (status: number) =>
      respostas.filter((resposta) => resposta.status === status).length;
    expect({ aceitas: contagem(202), limitadas: contagem(429) }).toEqual({
      aceitas: 60,
      limitadas: 10,
    });
    expect(
      await t.prisma.webhookRecebimento.count({
        where: { webhookId: ponto.id },
      }),
    ).toBe(60);
    expect(await t.fila.listarTrabalhos(FILA_PROCESSAR)).toHaveLength(60);
  });

  it('R8.4 — o mesmo recebimento processado por dois jobs ao mesmo tempo vale uma vez só', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto();
    const resposta = await enviarLead(t, ponto.token, {
      name: 'Gil',
      email: 'gil@x.com',
    }).expect(202);
    const id = (resposta.body as { id: string }).id;
    const servico = t.get(ProcessamentoEntradaService);
    await Promise.all([servico.processar(id), servico.processar(id)]);
    expect(await recebimento(id)).toMatchObject({
      status: 'PROCESSADO',
      tentativas: 1,
    });
    expect(
      await t.prisma.contato.findFirstOrThrow({
        where: { email: 'gil@x.com' },
      }),
    ).toMatchObject({ conversoes: 1 });
    expect(await t.prisma.negocio.count()).toBe(1);
    expect(
      await t.prisma.eventoAuditoria.count({
        where: { acao: 'contato.reconvertido' },
      }),
    ).toBe(0);
  });

  it('R8.4 — falha passageira volta para a fila: até 3 tentativas', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto();
    const contatos = t.get(ContatosService);
    const espiao = jest
      .spyOn(contatos, 'encontrarOuCriar')
      .mockRejectedValueOnce(new Error('conexão com o banco caiu'))
      .mockRejectedValueOnce(new Error('conexão com o banco caiu de novo'));
    try {
      const passa = await enviarLead(t, ponto.token, {
        name: 'Lia',
        email: 'lia@x.com',
      }).expect(202);
      const id = (passa.body as { id: string }).id;
      await drenarFilas(t, FILA_PROCESSAR);
      expect(await recebimento(id)).toMatchObject({
        status: 'RECEBIDO',
        tentativas: 1,
        mensagem: expect.stringMatching(/^A tentativa 1 de 3 falhou/) as string,
      });
      await processar();
      expect(await recebimento(id)).toMatchObject({
        status: 'PROCESSADO',
        tentativas: 3,
      });

      espiao.mockRejectedValue(new Error('banco fora do ar'));
      const falha = await enviarLead(t, ponto.token, {
        name: 'Rui',
        email: 'rui@x.com',
      }).expect(202);
      await processar();
      const comErro = await recebimento((falha.body as { id: string }).id);
      expect(comErro).toMatchObject({ status: 'ERRO', tentativas: 3 });
      expect(comErro.mensagem).toBe(
        'Falhou 3 vezes; última falha: banco fora do ar',
      );
      expect(espiao).toHaveBeenCalledTimes(6);
      expect(
        await t.prisma.logTecnico.count({
          where: { contexto: `Fila:${FILA_PROCESSAR}`, nivel: 'ERRO' },
        }),
      ).toBe(5);
    } finally {
      espiao.mockRestore();
    }
  });

  it('textos sem código de regra: a regra que recusa o lead fica fora da mensagem do recebimento, e mensagens antigas saem limpas', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto();
    const espiao = jest
      .spyOn(t.get(ContatosService), 'encontrarOuCriar')
      .mockRejectedValueOnce(
        new RegraVioladaException('R5.1', 'O funil está arquivado.'),
      );
    try {
      const resposta = await enviarLead(t, ponto.token, {
        name: 'Ivo',
        email: 'ivo@x.com',
      }).expect(202);
      const id = (resposta.body as { id: string }).id;
      await processar();
      // Regra recusou: erro definitivo, sem novas tentativas e sem "[R5.1]".
      expect(await recebimento(id)).toMatchObject({
        status: 'ERRO',
        tentativas: 1,
        mensagem: 'O funil está arquivado.',
      });
    } finally {
      espiao.mockRestore();
    }

    // Recebimento gravado antes do ajuste, com o código na mensagem.
    const antigo = await t.prisma.webhookRecebimento.create({
      data: {
        webhookId: ponto.id,
        status: 'ERRO',
        mensagem:
          'Contato "Ana" reconvertido (já existia, R4.2); funil arquivado. [R5.1]',
      },
    });
    const lista = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}/recebimentos`)
      .expect(200);
    const detalhe = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${antigo.id}`)
      .expect(200);
    const limpa = 'Contato "Ana" reconvertido (já existia); funil arquivado.';
    expect(detalhe.body).toMatchObject({ mensagem: limpa });
    expect(
      (lista.body.itens as { id: string; mensagem: string | null }[]).find(
        (item) => item.id === antigo.id,
      ),
    ).toMatchObject({ mensagem: limpa });
  });

  it('R8.1 — RESPONSAVEL_FIXO: o responsável é validado e recebe o negócio; LIDER_DA_AREA vai para o líder', async () => {
    const { lider, membros } = await criarEquipe(t, 'MARKETING', {
      membros: 2,
    });
    const comercial = await criarEquipe(t, 'COMERCIAL', { membros: 1 });
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'Fixo',
        estrategia: 'RESPONSAVEL_FIXO',
      })
      .expect(400);
    const outraArea = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'Fixo',
        estrategia: 'RESPONSAVEL_FIXO',
        responsavelFixoId: comercial.membros[0].id,
      })
      .expect(422);
    expect(outraArea.body).toMatchObject({ detalhes: { regra: 'R8.1' } });
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'Rodizio',
        responsavelFixoId: membros[1].id,
      })
      .expect(400);

    const fixo = await criarPonto({
      nome: 'Fixo',
      estrategia: 'RESPONSAVEL_FIXO',
      responsavelFixoId: membros[1].id,
    });
    const doLider = await criarPonto({
      nome: 'Líder',
      estrategia: 'LIDER_DA_AREA',
    });
    await enviarLead(t, fixo.token, { name: 'A', email: 'a@x.com' }).expect(
      202,
    );
    await enviarLead(t, doLider.token, { name: 'B', email: 'b@x.com' }).expect(
      202,
    );
    await processar();
    const negocios = await t.prisma.negocio.findMany({
      include: { contato: true },
    });
    expect(
      Object.fromEntries(
        negocios.map((n) => [n.contato.email, n.responsavelId]),
      ),
    ).toEqual({ 'a@x.com': membros[1].id, 'b@x.com': lider.id });

    // Trocar a estratégia limpa o responsável fixo.
    const editado = await admin
      .patch(`/api/v1/webhooks/entradas/${fixo.id}`, { estrategia: 'RODIZIO' })
      .expect(200);
    expect(editado.body).toMatchObject({
      estrategia: 'RODIZIO',
      responsavelFixo: null,
    });
  });

  it('R8.1 — edição: trocar o funil revalida a etapa e o responsável fixo; passar para PERSONALIZADO parte do mapeamento que valia', async () => {
    const { membros } = await criarEquipe(t, 'MARKETING', { membros: 1 });
    const comercial = await funilBase(t, 'COMERCIAL');
    const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
    const ponto = await criarPonto({
      modeloMapeamento: 'DISPAROS_BRL',
      estrategia: 'RESPONSAVEL_FIXO',
      responsavelFixoId: membros[0].id,
    });
    // O responsável fixo é de Marketing: não vale no funil Comercial.
    const recusado = await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, { funilId: comercial.id })
      .expect(422);
    expect(recusado.body).toMatchObject({ detalhes: { regra: 'R8.1' } });
    const movido = await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, {
        funilId: comercial.id,
        estrategia: 'RODIZIO',
      })
      .expect(200);
    expect(movido.body).toMatchObject({
      funil: { id: comercial.id },
      etapa: { nome: 'Novo' },
      estrategia: 'RODIZIO',
      responsavelFixo: null,
    });
    await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, { etapaId: novoLead.id })
      .expect(422);

    const personalizado = await admin
      .patch(`/api/v1/webhooks/entradas/${ponto.id}`, {
        modeloMapeamento: 'PERSONALIZADO',
      })
      .expect(200);
    expect(personalizado.body.modeloMapeamento).toBe('PERSONALIZADO');
    expect(personalizado.body.mapeamento.ignorarQuando).toEqual([
      { caminho: 'teste', valor: true },
    ]);
    expect(
      (personalizado.body.mapeamento.campos as { caminho: string }[]).map(
        ({ caminho }) => caminho,
      ),
    ).toContain('planilha_*');

    const auditorias = await t.prisma.eventoAuditoria.findMany({
      where: { acao: 'webhook_entrada.atualizado', entidadeId: ponto.id },
      orderBy: { id: 'asc' },
    });
    expect(auditorias).toHaveLength(2);
    expect(
      Object.keys(
        (auditorias[0].dados as { alteracoes: object }).alteracoes,
      ).sort(),
    ).toEqual(['estrategia', 'etapaId', 'funilId', 'responsavelFixoId']);
    expect(
      Object.keys(
        (auditorias[1].dados as { alteracoes: object }).alteracoes,
      ).sort(),
    ).toEqual(['mapeamento', 'modeloMapeamento']);
  });

  it('R8.1 — validação da configuração: etapa de outro funil, etapa de perda, funil arquivado e mapeamento personalizado inválido', async () => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const novoLead = await etapaDoFunilBase(t, 'MARKETING', 'novo_lead');
    const descartado = await etapaDoFunilBase(t, 'MARKETING', 'descartado');
    const outra = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'X',
        funilId: comercial.id,
        etapaId: novoLead.id,
      })
      .expect(422);
    expect(outra.body).toMatchObject({ detalhes: { regra: 'R5.4' } });
    const perda = await admin
      .post('/api/v1/webhooks/entradas', { nome: 'X', etapaId: descartado.id })
      .expect(422);
    expect(perda.body).toMatchObject({ detalhes: { regra: 'R5.5' } });

    // Funil escolhido sem etapa: a primeira etapa aberta dele.
    const noComercial = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'Comercial',
        funilId: comercial.id,
      })
      .expect(201);
    expect(noComercial.body.webhook.etapa).toMatchObject({ nome: 'Novo' });

    const semMapeamento = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'P',
        modeloMapeamento: 'PERSONALIZADO',
      })
      .expect(400);
    expect(semMapeamento.body.detalhes.campos[0].campo).toBe('mapeamento');
    const invalido = await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'P',
        modeloMapeamento: 'PERSONALIZADO',
        mapeamento: {
          campos: [
            { caminho: 'nome', destino: 'nome' },
            { caminho: 'mail', destino: 'correio' },
          ],
        },
      })
      .expect(400);
    expect(invalido.body).toMatchObject({
      erro: 'dados_invalidos',
      detalhes: { regra: 'R8.1' },
    });
    expect(
      (invalido.body.detalhes.campos as { campo: string }[]).map(
        (c) => c.campo,
      ),
    ).toEqual(['mapeamento.campos.1.destino']);
    await admin
      .post('/api/v1/webhooks/entradas', {
        nome: 'P',
        modeloMapeamento: 'GENERICO',
        mapeamento: { campos: [] },
      })
      .expect(400);
    await admin
      .post('/api/v1/webhooks/entradas', { nome: 'P', campoDesconhecido: 1 })
      .expect(400);

    // Funil arquivado não recebe leads (R5.1).
    await t.prisma.funil.update({
      where: { id: comercial.id },
      data: { ativo: false },
    });
    const arquivado = await admin
      .post('/api/v1/webhooks/entradas', { nome: 'Arq', funilId: comercial.id })
      .expect(422);
    expect(arquivado.body).toMatchObject({ detalhes: { regra: 'R5.1' } });
  });

  it('R8.1 — prévia do mapeamento sobre um JSON de exemplo, sem gravar nada', async () => {
    const modelos = await admin
      .get('/api/v1/webhooks/entradas/modelos')
      .expect(200);
    expect(
      (modelos.body.modelos as { modelo: string }[]).map((m) => m.modelo),
    ).toEqual(['GENERICO', 'DISPAROS_BRL']);
    expect(
      (modelos.body.destinos as { destino: string }[]).map((d) => d.destino),
    ).toContain('utm.campaign');

    const previa = await admin
      .post('/api/v1/webhooks/entradas/previa', {
        modeloMapeamento: 'PERSONALIZADO',
        mapeamento: {
          campos: [
            { caminho: 'lead.nome', destino: 'nome' },
            { caminho: 'lead.contatos[0].email', destino: 'email' },
            { caminho: 'lead.fone', destino: 'telefone' },
            { caminho: 'lead.empresa', destino: 'empresa' },
            { caminho: 'lead.valor', destino: 'valor' },
            { caminho: 'tags', destino: 'etiquetas' },
            { caminho: 'extra.*', destino: 'camposPersonalizados.*' },
          ],
        },
        etiquetasFixas: ['Site'],
        exemplo: {
          lead: {
            nome: 'Bia Costa',
            contatos: [{ email: 'BIA@X.COM' }],
            fone: '(20) 9999-0000',
            empresa: 'ACME',
            valor: 'R$ 2.500,00',
          },
          tags: 'quente, vip',
          extra: { cidade: 'Natal' },
        },
      })
      .expect(200);
    expect(previa.body).toEqual({
      valido: true,
      ignorado: null,
      problemas: [],
      avisos: [
        expect.stringMatching(
          /^Telefone "\(20\) 9999-0000" \(lead\.fone\) inválido/,
        ) as string,
      ],
      contato: {
        nome: 'Bia Costa',
        email: 'bia@x.com',
        telefone: null,
        empresa: 'ACME',
        cargo: null,
        etiquetas: ['Site', 'quente', 'vip'],
        camposPersonalizados: { cidade: 'Natal' },
      },
      negocio: { titulo: null, valor: '2500.00', valorRecorrente: null },
      utm: null,
      // Onda H (R32.4): atualizações pelo recebimento e itens do corpo.
      atualizacoes: {
        etapa: null,
        dono: null,
        status: null,
        motivoPerda: null,
      },
      camposDoNegocio: {},
      itens: 1,
      encontrados: expect.arrayContaining([
        { destino: 'email', caminho: 'lead.contatos[0].email' },
        { destino: 'camposPersonalizados.*', caminho: 'cidade' },
      ]) as unknown,
    });
    const teste = await admin
      .post('/api/v1/webhooks/entradas/previa', {
        modeloMapeamento: 'DISPAROS_BRL',
        exemplo: { name: 'X', phone: '11999998888', teste: 'true' },
      })
      .expect(200);
    expect(teste.body).toMatchObject({
      valido: false,
      ignorado: expect.any(String) as string,
    });
    expect(await t.prisma.contato.count()).toBe(0);
    expect(await t.prisma.webhookRecebimento.count()).toBe(0);
  });

  it('R4.6 — a anonimização do contato apaga o corpo, os cabeçalhos e o IP dos recebimentos dele', async () => {
    await criarEquipe(t, 'MARKETING', { membros: 1 });
    const ponto = await criarPonto();
    const resposta = await enviarLead(t, ponto.token, {
      name: 'Teo Ramos',
      email: 'teo@x.com',
    }).expect(202);
    await processar();
    const id = (resposta.body as { id: string }).id;
    const { contatoId } = await recebimento(id);
    await admin
      .post(`/api/v1/contatos/${contatoId}/anonimizar`, {
        motivo: 'Pedido do titular',
      })
      .expect(204);
    await processarEventos(t);
    expect(await recebimento(id)).toMatchObject({
      status: 'PROCESSADO',
      corpo: null,
      cabecalhos: {},
      ip: null,
      mensagem: 'Corpo, cabeçalhos e IP apagados na anonimização do contato.',
    });
    expect(
      await t.prisma.eventoAuditoria.findFirstOrThrow({
        where: { acao: 'webhook_recebimento.dados_apagados' },
      }),
    ).toMatchObject({
      tipoAtor: 'SISTEMA',
      relacionados: [`contato:${contatoId}`],
      dados: { quantidade: 1 },
    });
    // Sem corpo, não há o que reprocessar (o processado já não reprocessaria).
    const detalhe = await admin
      .get(`/api/v1/webhooks/entradas/${ponto.id}/recebimentos/${id}`)
      .expect(200);
    expect(JSON.stringify(detalhe.body)).not.toContain('teo@x.com');
  });

  it('documenta as rotas no Swagger', async () => {
    const documento = await admin.get('/api/docs-json').expect(200);
    const caminhos = Object.keys(documento.body.paths as object);
    expect(caminhos).toEqual(
      expect.arrayContaining([
        '/api/v1/webhooks/entrada/{token}',
        '/api/v1/webhooks/entradas',
        '/api/v1/webhooks/entradas/modelos',
        '/api/v1/webhooks/entradas/previa',
        '/api/v1/webhooks/entradas/{id}',
        '/api/v1/webhooks/entradas/{id}/regenerar-token',
        '/api/v1/webhooks/entradas/{id}/segredo',
        '/api/v1/webhooks/entradas/{id}/previa',
        '/api/v1/webhooks/entradas/{id}/recebimentos',
        '/api/v1/webhooks/entradas/{id}/recebimentos/{recebimentoId}',
        '/api/v1/webhooks/entradas/{id}/recebimentos/{recebimentoId}/reprocessar',
      ]),
    );
    expect(
      documento.body.paths['/api/v1/webhooks/entrada/{token}'].post.responses,
    ).toHaveProperty('202');
  });
});
