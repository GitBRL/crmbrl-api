import {
  HOSTS_PADRAO_TRESC_PLUS,
  motivoDaUrlRecusada,
  normalizarHostPermitido,
} from './hosts-permitidos';

const producao = { producao: true, extras: [] as string[] };
const API = ['http:', 'https:'];

describe('R34.1 — hosts permitidos do 3C+ (anti-SSRF)', () => {
  it('aceita 3c.plus, 3c.fluxoti.com e subdomínios por https', () => {
    for (const url of [
      'https://3c.plus/api/v1',
      'https://app.3c.plus/api/v1',
      'https://3c.fluxoti.com/api/v1',
      'https://x.y.3c.fluxoti.com',
    ]) {
      expect(motivoDaUrlRecusada(url, API, producao)).toBeNull();
    }
    expect(HOSTS_PADRAO_TRESC_PLUS).toContain('*.3c.plus');
  });

  it('recusa outros hosts, parentes enganosos e usuário na URL', () => {
    for (const url of [
      'https://evil.com',
      'https://3c.plus.evil.com',
      'https://evil3c.plus',
      'https://3c.plus@evil.com/api',
      'https://user:pass@3c.plus',
    ]) {
      expect(motivoDaUrlRecusada(url, API, producao)).not.toBeNull();
    }
  });

  it('recusa IP literal (privado, loopback, link-local e público) e http em produção', () => {
    for (const url of [
      'http://127.0.0.1:3000',
      'http://169.254.169.254/latest',
      'https://10.1.2.3',
      'https://[::1]/x',
      'https://8.8.8.8',
    ]) {
      expect(motivoDaUrlRecusada(url, API, producao)).not.toBeNull();
    }
    expect(motivoDaUrlRecusada('http://3c.plus/api', API, producao)).toBe(
      'use https em produção',
    );
    expect(
      motivoDaUrlRecusada('http://3c.plus/api', API, {
        producao: false,
        extras: [],
      }),
    ).toBeNull();
  });

  it('a lista do operador acrescenta hosts (inclusive curinga, IP e http)', () => {
    const regra = {
      producao: true,
      extras: ['sim.local', '*.interno.com', '127.0.0.1'],
    };
    expect(motivoDaUrlRecusada('http://sim.local:8097', API, regra)).toBeNull();
    expect(motivoDaUrlRecusada('https://a.interno.com', API, regra)).toBeNull();
    expect(motivoDaUrlRecusada('http://127.0.0.1:3297', API, regra)).toBeNull();
    expect(
      motivoDaUrlRecusada('https://interno.com', API, regra),
    ).not.toBeNull();
    expect(motivoDaUrlRecusada('https://outro.com', API, regra)).not.toBeNull();
  });

  it('só aceita os protocolos pedidos', () => {
    expect(motivoDaUrlRecusada('ftp://3c.plus', API, producao)).not.toBeNull();
    expect(
      motivoDaUrlRecusada('wss://3c.plus', ['ws:', 'wss:'], producao),
    ).toBeNull();
  });

  it('normaliza os itens da variável', () => {
    expect(normalizarHostPermitido(' *.Exemplo.COM. ')).toBe('*.exemplo.com');
    expect(normalizarHostPermitido('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizarHostPermitido('*.10.0.0.1')).toBeNull();
    expect(normalizarHostPermitido('inválido host')).toBeNull();
    expect(normalizarHostPermitido('')).toBeNull();
  });
});
