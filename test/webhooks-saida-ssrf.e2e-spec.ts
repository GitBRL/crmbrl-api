import { CriptografiaService } from '../src/comum/criptografia/criptografia.service';
import { FILA_ENTREGAR, ServidorDeTeste } from './webhooks-apoio';
import {
  type AppTeste,
  type ClienteHttp,
  criarAppTeste,
  criarUsuario,
  drenarFilas,
  entrarComo,
  processarEventos,
} from './utils';

/**
 * Proteção contra SSRF (R9.1) com a configuração padrão
 * (`WEBHOOKS_PERMITIR_REDE_INTERNA=false`): rede interna e localhost são
 * recusados ao cadastrar e de novo antes de cada envio.
 */
describe('Webhooks de saída — proteção contra SSRF (e2e)', () => {
  let t: AppTeste;
  let admin: ClienteHttp;
  const servidor = new ServidorDeTeste();

  beforeAll(async () => {
    await servidor.iniciar();
    t = await criarAppTeste();
  });

  beforeEach(async () => {
    await t.limparBanco();
    servidor.limpar();
    admin = await entrarComo(t, await criarUsuario(t, { papel: 'ADMIN' }));
  });

  afterAll(async () => {
    await t.fechar();
    await servidor.parar();
  });

  const cadastrar = (url: string, nome = 'Destino') =>
    admin.post('/api/v1/webhooks/saidas', {
      nome,
      url,
      eventos: ['contato.criado'],
    });

  it('R9.1 — recusa rede interna, localhost e metadados de nuvem ao cadastrar (422)', async () => {
    expect(t.ambiente.webhooksPermitirRedeInterna).toBe(false);
    for (const url of [
      servidor.url,
      'http://localhost:3000/x',
      'http://127.0.0.1/x',
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://2130706433/x',
      'http://10.0.0.8/x',
      'http://172.17.0.1:5432/x',
      'http://192.168.0.10/x',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/x',
    ]) {
      const resposta = await cadastrar(url).expect(422);
      expect({ url, corpo: resposta.body as unknown }).toMatchObject({
        url,
        corpo: {
          erro: 'regra_violada',
          detalhes: { regra: 'R9.1', motivo: 'rede_interna' },
        },
      });
    }
    expect(await t.prisma.webhookSaida.count()).toBe(0);
  });

  it('R9.1 — formato inválido é 400 (protocolo, usuário e senha na URL)', async () => {
    for (const url of [
      'ftp://exemplo.com/x',
      'https://usuario:senha@exemplo.com/x',
      'isto não é uma url',
    ]) {
      const resposta = await cadastrar(url).expect(400);
      expect(resposta.body.detalhes.campos[0].campo).toBe('url');
    }
  });

  it('R9.1 — aceita destino público; trocar para rede interna depois também é recusado', async () => {
    const criado = await cadastrar('https://93.184.216.34/webhook').expect(201);
    const id = (criado.body as { webhook: { id: string } }).webhook.id;
    const resposta = await admin
      .patch(`/api/v1/webhooks/saidas/${id}`, { url: 'http://10.1.1.1/x' })
      .expect(422);
    expect(resposta.body).toMatchObject({ detalhes: { regra: 'R9.1' } });
    expect(
      (await t.prisma.webhookSaida.findUniqueOrThrow({ where: { id } })).url,
    ).toBe('https://93.184.216.34/webhook');
  });

  it('R9.1 — a entrega confere o destino de novo e não envia para a rede interna (ex.: DNS que mudou)', async () => {
    // Gravado direto no banco, como se o endereço tivesse passado a apontar para dentro.
    const destino = await t.prisma.webhookSaida.create({
      data: {
        nome: 'Antigo',
        url: `${servidor.url}/interno`,
        eventos: ['contato.criado'],
        segredoCifrado: t.get(CriptografiaService).cifrar('segredo'),
      },
    });
    await admin
      .post('/api/v1/contatos', { nome: 'Ana', email: 'ana@x.com' })
      .expect(201);
    await processarEventos(t);
    await drenarFilas(t, FILA_ENTREGAR);
    expect(servidor.recebidos).toHaveLength(0);
    const entrega = await t.prisma.webhookEntrega.findFirstOrThrow({
      where: { webhookId: destino.id },
      include: { historicoTentativas: true },
    });
    expect(entrega).toMatchObject({
      status: 'PENDENTE',
      tentativas: 1,
      statusHttp: null,
    });
    expect(entrega.erro).toMatch(
      /^Envio bloqueado: .*rede interna ou localhost/,
    );
    expect(entrega.historicoTentativas).toHaveLength(1);
  });
});
