import { CriptografiaService } from '../src/comum/criptografia/criptografia.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  carregarEstadoDeAutenticacao,
  CredenciaisIlegiveisError,
  TIPO_DAS_CREDENCIAIS,
} from '../src/whatsapp/transporte/estado-de-autenticacao';
import {
  carregarBaileys,
  type ModuloBaileys,
} from '../src/whatsapp/transporte/transporte-baileys';
import { ambienteDeTeste } from './utils';

/**
 * Estado de autenticação do Baileys no Postgres (§2.3), com o pacote de
 * verdade (`initAuthCreds`, `BufferJSON`, `proto`): tudo cifrado em
 * `whatsapp_chaves`, nada em disco. Só o Prisma e a criptografia (sem a API
 * inteira): cada teste cria os próprios números e apaga no fim.
 */
describe('WhatsApp — estado de autenticação no Postgres (e2e)', () => {
  let baileys: ModuloBaileys;
  let cripto: CriptografiaService;
  let prisma: PrismaService;
  const canais: string[] = [];

  beforeAll(async () => {
    const ambiente = ambienteDeTeste();
    prisma = new PrismaService(ambiente);
    await prisma.$connect();
    cripto = new CriptografiaService(ambiente);
    baileys = await carregarBaileys();
  });
  afterEach(async () => {
    await prisma.canal.deleteMany({ where: { id: { in: canais.splice(0) } } });
  });
  afterAll(() => prisma.$disconnect());

  /** Um canal WHATSAPP com o número (apagado no fim do teste, com as chaves). */
  const criarNumero = async () => {
    const canal = await prisma.canal.create({
      data: { tipo: 'WHATSAPP', nome: `Teste ${canais.length + 1}` },
    });
    canais.push(canal.id);
    const numero = await prisma.whatsappNumero.create({
      data: { canalId: canal.id, nome: canal.nome },
    });
    return { canal, numero };
  };

  const carregar = (numeroId: string) =>
    carregarEstadoDeAutenticacao(numeroId, {
      prisma,
      cripto,
      baileys: {
        initAuthCreds: baileys.initAuthCreds,
        BufferJSON: baileys.BufferJSON,
        reviverChaveDeSincronizacao: (valor) =>
          baileys.proto.Message.AppStateSyncKeyData.fromObject(
            valor as Record<string, unknown>,
          ),
      },
    });

  it('credenciais novas, gravadas cifradas e lidas de volta iguais (Buffers inclusive)', async () => {
    const { numero } = await criarNumero();
    const estado = await carregar(numero.id);
    expect(estado.registrado).toBe(false);
    const creds = estado.state.creds;
    creds.me = { id: '5511999990000:3@s.whatsapp.net', name: 'Loja' };
    await estado.salvarCredenciais();

    const linha = await prisma.whatsappChave.findUniqueOrThrow({
      where: {
        numeroId_tipo_chaveId: {
          numeroId: numero.id,
          tipo: TIPO_DAS_CREDENCIAIS,
          chaveId: '',
        },
      },
    });
    expect(linha.valorCifrado).not.toContain('5511999990000');
    expect(linha.valorCifrado).not.toContain('noiseKey');

    const relido = await carregar(numero.id);
    expect(relido.registrado).toBe(true);
    expect(relido.state.creds.me).toEqual(creds.me);
    expect(Buffer.isBuffer(relido.state.creds.noiseKey.private)).toBe(true);
    expect(
      Buffer.from(relido.state.creds.noiseKey.private).equals(
        Buffer.from(creds.noiseKey.private),
      ),
    ).toBe(true);
    expect(relido.state.creds.registrationId).toBe(creds.registrationId);
  });

  it('chaves do Signal: grava em lote, lê só as pedidas, remove com null e revive as de sincronização', async () => {
    const { numero } = await criarNumero();
    const { numero: outro } = await criarNumero();
    const estado = await carregar(numero.id);
    const chaves = estado.state.keys;
    const preKeys = Object.fromEntries(
      Array.from({ length: 30 }, (_, indice) => [
        String(indice + 1),
        {
          public: Buffer.from(`pub-${indice}`),
          private: Buffer.from(`priv-${indice}`),
        },
      ]),
    );
    await chaves.set({
      'pre-key': preKeys,
      session: { '5511@s.whatsapp.net.0': Buffer.from('sessao') },
      'app-state-sync-key': {
        AAAA: { keyData: Buffer.from('dados'), timestamp: 1 },
      },
    });
    await (
      await carregar(outro.id)
    ).state.keys.set({
      'pre-key': {
        '1': { public: Buffer.from('x'), private: Buffer.from('y') },
      },
    });
    expect(
      await prisma.whatsappChave.count({ where: { numeroId: numero.id } }),
    ).toBe(32);

    const lidas = await chaves.get('pre-key', ['1', '30', '999']);
    expect(Object.keys(lidas).sort()).toEqual(['1', '30']);
    expect(Buffer.from(lidas['30'].private).toString()).toBe('priv-29');
    const sincronizacao = await chaves.get('app-state-sync-key', ['AAAA']);
    expect(sincronizacao.AAAA).toBeInstanceOf(
      baileys.proto.Message.AppStateSyncKeyData,
    );

    // Atualiza uma, remove outra, na ordem pedida.
    await chaves.set({
      'pre-key': {
        '1': { public: Buffer.from('novo'), private: Buffer.from('novo') },
        '2': null,
      },
    });
    const depois = await chaves.get('pre-key', ['1', '2']);
    expect(Object.keys(depois)).toEqual(['1']);
    expect(Buffer.from(depois['1'].public).toString()).toBe('novo');
    // O outro número não foi tocado.
    expect(
      Object.keys(
        await (await carregar(outro.id)).state.keys.get('pre-key', ['1']),
      ),
    ).toEqual(['1']);

    const linhas = await prisma.whatsappChave.findMany({
      where: { numeroId: numero.id },
    });
    for (const linha of linhas) {
      expect(linha.valorCifrado).not.toMatch(/priv-|sessao|dados/);
    }
  });

  it('desativado não grava mais; chave que não decifra some; credencial que não decifra é erro', async () => {
    const { numero } = await criarNumero();
    const estado = await carregar(numero.id);
    estado.desativar();
    await estado.salvarCredenciais();
    await estado.state.keys.set({ session: { a: Buffer.from('x') } });
    expect(
      await prisma.whatsappChave.count({ where: { numeroId: numero.id } }),
    ).toBe(0);

    const ativo = await carregar(numero.id);
    await ativo.state.keys.set({ session: { a: Buffer.from('x') } });
    await prisma.whatsappChave.updateMany({
      where: { numeroId: numero.id, tipo: 'session' },
      data: { valorCifrado: cripto.cifrar('{').replace(/.$/, 'A') },
    });
    expect(await ativo.state.keys.get('session', ['a'])).toEqual({});

    await prisma.whatsappChave.create({
      data: {
        numeroId: numero.id,
        tipo: TIPO_DAS_CREDENCIAIS,
        chaveId: '',
        valorCifrado: 'v1.lixo.lixo.lixo',
      },
    });
    await expect(carregar(numero.id)).rejects.toBeInstanceOf(
      CredenciaisIlegiveisError,
    );
  });
});
