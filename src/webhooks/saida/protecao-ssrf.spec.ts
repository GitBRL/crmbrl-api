import {
  ehEnderecoInterno,
  expandirIpv6,
  type OpcoesDoDestino,
  verificarDestino,
} from './protecao-ssrf';

const resolverCom =
  (tabela: Record<string, string[]>) =>
  (nome: string): Promise<string[]> =>
    tabela[nome]
      ? Promise.resolve(tabela[nome])
      : Promise.reject(new Error('ENOTFOUND'));

const DNS = resolverCom({
  'publico.exemplo': ['93.184.216.34'],
  'interno.exemplo': ['10.0.0.5'],
  'misto.exemplo': ['93.184.216.34', '192.168.0.10'],
  'v6.exemplo': ['2606:2800:220:1:248:1893:25c8:1946'],
});

const desenvolvimento: OpcoesDoDestino = {
  producao: false,
  permitirRedeInterna: false,
  resolver: DNS,
};
const producao: OpcoesDoDestino = { ...desenvolvimento, producao: true };

describe('proteção contra SSRF dos webhooks de saída (R9.1)', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '64:ff9b::a00:1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::',
    'nao-e-ip',
  ])('R9.1 — %s é interno', (endereco) => {
    expect(ehEnderecoInterno(endereco)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
    '64:ff9b::808:808',
    '::ffff:8.8.8.8',
  ])('R9.1 — %s é público', (endereco) => {
    expect(ehEnderecoInterno(endereco)).toBe(false);
  });

  it('expande endereços IPv6, com IPv4 no fim', () => {
    expect(expandirIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandirIpv6('::ffff:1.2.3.4')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x102, 0x304,
    ]);
    expect(expandirIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandirIpv6('1::2::3')).toBeNull();
    expect(expandirIpv6('1:2:3')).toBeNull();
  });

  it('R9.1 — recusa rede interna e localhost, pelo IP ou pelo nome resolvido', async () => {
    for (const url of [
      'http://127.0.0.1:3000/x',
      'http://localhost/x',
      'http://api.localhost/x',
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://2130706433/x',
      'http://0x7f.0.0.1/x',
      'https://interno.exemplo/x',
      'https://misto.exemplo/x',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const resultado = await verificarDestino(url, desenvolvimento);
      expect({
        url,
        motivo: resultado.permitido ? null : resultado.motivo,
      }).toEqual({
        url,
        motivo: 'rede_interna',
      });
    }
  });

  it('R9.1 — aceita destino público e, com a liberação, a rede interna', async () => {
    const publico = await verificarDestino(
      'https://publico.exemplo/webhook?x=1',
      desenvolvimento,
    );
    expect(publico).toMatchObject({
      permitido: true,
      enderecos: ['93.184.216.34'],
    });
    expect(
      (await verificarDestino('https://v6.exemplo/x', producao)).permitido,
    ).toBe(true);
    const interno = await verificarDestino('http://127.0.0.1:8080/x', {
      ...desenvolvimento,
      permitirRedeInterna: true,
    });
    expect(interno.permitido).toBe(true);
  });

  it('R9.1 — em produção exige HTTPS (http só para a rede interna liberada)', async () => {
    expect(
      await verificarDestino('http://publico.exemplo/x', producao),
    ).toMatchObject({ permitido: false, motivo: 'https_obrigatorio' });
    expect(
      (await verificarDestino('https://publico.exemplo/x', producao)).permitido,
    ).toBe(true);
    const liberado = { ...producao, permitirRedeInterna: true };
    expect(
      (await verificarDestino('http://interno.exemplo/x', liberado)).permitido,
    ).toBe(true);
    expect(
      await verificarDestino('http://publico.exemplo/x', liberado),
    ).toMatchObject({ permitido: false, motivo: 'https_obrigatorio' });
  });

  it('recusa formatos inválidos e nomes que não resolvem', async () => {
    for (const url of [
      'nao e url',
      'ftp://publico.exemplo/x',
      'https://usuario:senha@publico.exemplo/x',
      'file:///etc/passwd',
    ]) {
      expect(await verificarDestino(url, desenvolvimento)).toMatchObject({
        permitido: false,
        motivo: 'formato',
      });
    }
    expect(
      await verificarDestino('https://nao-existe.exemplo/x', desenvolvimento),
    ).toMatchObject({ permitido: false, motivo: 'dns' });
    const lento = await verificarDestino('https://lento.exemplo/x', {
      ...desenvolvimento,
      resolver: () => new Promise<string[]>(() => undefined),
      prazoDoDnsMs: 20,
    });
    expect(lento).toMatchObject({ permitido: false, motivo: 'dns' });
  });
});
