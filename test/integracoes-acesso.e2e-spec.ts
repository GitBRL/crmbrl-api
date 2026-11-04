/**
 * Fechamento da Onda H (R32.13, R32.17): matriz de acesso das rotas das integrações por
 * papel e o histórico de recebimentos de integração excluída.
 */
import type { Usuario } from '../src/generated/prisma/client';
import {
  type AppTeste,
  type ClienteHttp,
  clienteAnonimo,
  criarAppTeste,
  criarEquipe,
  criarUsuario,
  drenarFilas,
  entrarComo,
  funilBase,
} from './utils';
import { enviarLead, FILA_PROCESSAR, tokenDaUrl } from './webhooks-apoio';

const ID = '00000000-0000-4000-8000-000000000000';
const API = '/api/v1';

type Metodo = 'get' | 'post' | 'patch' | 'delete';
type Rota = readonly [Metodo, string];

/** Todas as rotas de Admin da Onda H: aplicativos, integrações, histórico, Facebook Lead Ads e saída. */
const ROTAS_DO_ADMIN: readonly Rota[] = [
  ['get', '/webhooks/aplicativos'],
  ['get', '/webhooks/entradas/modelos'],
  ['post', '/webhooks/entradas/previa'],
  ['post', '/webhooks/entradas/testar-credencial'],
  ['get', '/webhooks/entradas'],
  ['post', '/webhooks/entradas'],
  ['get', `/webhooks/entradas/${ID}`],
  ['get', `/webhooks/entradas/${ID}/endereco`],
  ['post', `/webhooks/entradas/${ID}/testar-credencial`],
  ['post', `/webhooks/entradas/${ID}/buscar-campos`],
  ['get', `/webhooks/entradas/${ID}/campos-recebidos`],
  ['get', `/webhooks/entradas/${ID}/formularios`],
  ['get', `/webhooks/entradas/${ID}/formularios/abc/campos`],
  ['post', `/webhooks/entradas/${ID}/sincronizar`],
  ['patch', `/webhooks/entradas/${ID}`],
  ['delete', `/webhooks/entradas/${ID}`],
  ['post', `/webhooks/entradas/${ID}/regenerar-token`],
  ['post', `/webhooks/entradas/${ID}/segredo`],
  ['delete', `/webhooks/entradas/${ID}/segredo`],
  ['post', `/webhooks/entradas/${ID}/previa`],
  ['get', `/webhooks/entradas/${ID}/recebimentos`],
  ['get', `/webhooks/entradas/${ID}/recebimentos/${ID}`],
  ['post', `/webhooks/entradas/${ID}/recebimentos/${ID}/reprocessar`],
  ['get', '/webhooks/recebimentos'],
  ['get', `/webhooks/recebimentos/${ID}`],
  ['post', `/webhooks/recebimentos/${ID}/reprocessar`],
  ['get', '/webhooks/facebook/configuracao'],
  ['get', '/webhooks/facebook/canais'],
  ['post', '/webhooks/facebook/oauth/iniciar'],
  ['post', '/webhooks/facebook/conexoes/token-de-pagina'],
  ['get', '/webhooks/facebook/conexoes'],
  ['get', `/webhooks/facebook/conexoes/${ID}`],
  ['delete', `/webhooks/facebook/conexoes/${ID}`],
  ['post', `/webhooks/facebook/conexoes/${ID}/atualizar-paginas`],
  ['get', `/webhooks/facebook/conexoes/${ID}/paginas`],
  ['get', `/webhooks/facebook/conexoes/${ID}/paginas/1/formularios`],
  [
    'get',
    `/webhooks/facebook/conexoes/${ID}/paginas/1/formularios/2/perguntas`,
  ],
  ['get', '/webhooks/saidas/eventos'],
  ['get', '/webhooks/saidas/formato-clint'],
  ['get', '/webhooks/saidas'],
  ['post', '/webhooks/saidas'],
  ['get', `/webhooks/saidas/${ID}`],
  ['patch', `/webhooks/saidas/${ID}`],
  ['delete', `/webhooks/saidas/${ID}`],
  ['post', `/webhooks/saidas/${ID}/regenerar-segredo`],
  ['post', `/webhooks/saidas/${ID}/testar`],
  ['get', `/webhooks/saidas/${ID}/entregas`],
  ['get', `/webhooks/saidas/${ID}/entregas/${ID}`],
  ['post', `/webhooks/saidas/${ID}/entregas/${ID}/reenviar`],
  // O identificador nas integrações é um campo do usuário: só o Admin edita.
  ['patch', `/usuarios/${ID}`],
];

describe('Integrações: acesso e histórico (e2e, R32.13 e R32.17)', () => {
  let t: AppTeste;
  let admin: ClienteHttp;
  let adminUsuario: Usuario;

  beforeAll(async () => {
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    adminUsuario = await criarUsuario(t, { papel: 'ADMIN', nome: 'Admin' });
    admin = await entrarComo(t, adminUsuario);
  });

  afterAll(async () => {
    await t.fechar();
  });

  it('cenário 380 (R32.17, R8.6) — integração excluída sai do histórico e do detalhe juntos; o corpo fica guardado até a retenção', async () => {
    const comercial = await funilBase(t, 'COMERCIAL');
    const criada = (
      await admin
        .post(`${API}/webhooks/entradas`, {
          nome: 'Site que será excluído',
          funilId: comercial.id,
          etapaId: comercial.etapas[0].id,
        })
        .expect(201)
    ).body as { webhook: { id: string }; url: string };
    const outra = (
      await admin
        .post(`${API}/webhooks/entradas`, {
          nome: 'Site que fica',
          funilId: comercial.id,
          etapaId: comercial.etapas[0].id,
        })
        .expect(201)
    ).body as { webhook: { id: string }; url: string };
    const recebimentoDe = async (url: string, email: string) => {
      const resposta = await enviarLead(t, tokenDaUrl(url), {
        name: 'Ana Excluída',
        email,
      }).expect(202);
      return (resposta.body as { id: string }).id;
    };
    const idExcluida = await recebimentoDe(criada.url, 'excluida@x.com');
    const idMantida = await recebimentoDe(outra.url, 'mantida@x.com');
    await drenarFilas(t, FILA_PROCESSAR, { incluirAgendados: true });

    const total = async (consulta = '') =>
      (
        (await admin.get(`${API}/webhooks/recebimentos${consulta}`).expect(200))
          .body as { total: number }
      ).total;
    expect(await total()).toBe(2);
    await admin.get(`${API}/webhooks/recebimentos/${idExcluida}`).expect(200);

    await admin
      .delete(`${API}/webhooks/entradas/${criada.webhook.id}`)
      .expect(204);

    // Lista, filtro por aplicativo, detalhe e reprocessar concordam: o excluído não aparece em nenhum.
    expect(await total()).toBe(1);
    expect(await total('?aplicativo=WEBHOOK')).toBe(1);
    const lista = (await admin.get(`${API}/webhooks/recebimentos`).expect(200))
      .body as { itens: { id: string }[] };
    expect(lista.itens.map(({ id }) => id)).toEqual([idMantida]);
    await admin.get(`${API}/webhooks/recebimentos/${idExcluida}`).expect(404);
    await admin
      .post(`${API}/webhooks/recebimentos/${idExcluida}/reprocessar`)
      .expect(404);
    await admin
      .get(`${API}/webhooks/recebimentos?integracaoId=${criada.webhook.id}`)
      .expect(404);
    await admin.get(`${API}/webhooks/recebimentos/${idMantida}`).expect(200);
    // O corpo continua guardado (retenção de 90 dias, R8.6): só ninguém o vê.
    expect(
      await t.prisma.webhookRecebimento.count({
        where: { webhookId: criada.webhook.id },
      }),
    ).toBe(1);
  });

  it('cenário 381 (R32.13) — matriz de acesso: todas as rotas da Onda H são só do Admin; sem login 401; as públicas não pedem sessão', async () => {
    const equipe = await criarEquipe(t, 'COMERCIAL');
    const cs = await criarEquipe(t, 'CS', { cLevel: equipe.cLevel });
    const marketing = await criarEquipe(t, 'MARKETING', {
      cLevel: equipe.cLevel,
    });
    const papeis: [string, ClienteHttp][] = [
      ['C_LEVEL', await entrarComo(t, equipe.cLevel)],
      ['LIDER_COMERCIAL', await entrarComo(t, equipe.lider)],
      ['COMERCIAL', await entrarComo(t, equipe.membros[0])],
      ['LIDER_CS', await entrarComo(t, cs.lider)],
      ['CS', await entrarComo(t, cs.membros[0])],
      ['LIDER_MARKETING', await entrarComo(t, marketing.lider)],
      ['MARKETING', await entrarComo(t, marketing.membros[0])],
    ];
    const anonimo = clienteAnonimo(t);
    const falhas: string[] = [];
    for (const [metodo, rota] of ROTAS_DO_ADMIN) {
      const caminho = `${API}${rota}`;
      const alvo = rota.startsWith('/usuarios/') ? { nome: 'X' } : {};
      const anon = await anonimo[metodo](caminho, alvo);
      if (anon.status !== 401) {
        falhas.push(
          `anônimo ${metodo} ${rota} = ${anon.status} (esperado 401)`,
        );
      }
      for (const [papel, cliente] of papeis) {
        const r = await cliente[metodo](caminho, alvo);
        if (r.status !== 403) {
          falhas.push(
            `${papel} ${metodo} ${rota} = ${r.status} (esperado 403)`,
          );
        }
      }
      // O Admin passa da barreira: o que sobra é validação ou "não encontrado", nunca 401, 403 ou erro do servidor.
      const a = await admin[metodo](caminho, alvo);
      if (a.status === 401 || a.status === 403 || a.status >= 500) {
        falhas.push(`ADMIN ${metodo} ${rota} = ${a.status}`);
      }
    }
    expect(falhas).toEqual([]);

    // Públicas: nenhuma pede sessão (nem devolve 401/403 por falta dela).
    const semToken = await anonimo.post(
      `${API}/webhooks/entrada/${'x'.repeat(40)}`,
      {},
    );
    expect(semToken.status).toBe(404);
    const retorno = await anonimo.get(`${API}/publico/facebook/oauth/retorno`);
    expect(retorno.status).toBe(302);
    expect(String(retorno.headers.location)).toContain('facebook=erro');
    // O webhook da Meta pede a assinatura do app, não a sessão: sem ela, 401 pela assinatura.
    const meta = await anonimo.post(`${API}/publico/meta/webhook`, {
      object: 'page',
      entry: [],
    });
    expect([200, 401]).toContain(meta.status);
    // Nenhuma rota do catálogo expõe o endereço público a quem não é Admin.
    for (const [papel, cliente] of papeis) {
      const r = await cliente.get(`${API}/webhooks/entradas/${ID}/endereco`);
      expect([papel, r.status]).toEqual([papel, 403]);
    }
  });
});
