import type { Request, Response } from 'express';
import { criarMiddlewareDeCabecalhos, HSTS } from './cabecalhos-de-seguranca';

function executar(hsts: boolean): Map<string, string> {
  const cabecalhos = new Map<string, string>();
  const resposta = {
    setHeader: (nome: string, valor: string) => cabecalhos.set(nome, valor),
  } as unknown as Response;
  const proximo = jest.fn();
  criarMiddlewareDeCabecalhos(hsts)({} as Request, resposta, proximo);
  expect(proximo).toHaveBeenCalledTimes(1);
  return cabecalhos;
}

describe('cabeçalhos de segurança', () => {
  it('sempre coloca nosniff, X-Frame-Options e Referrer-Policy', () => {
    const c = executar(false);
    expect(c.get('X-Content-Type-Options')).toBe('nosniff');
    expect(c.get('X-Frame-Options')).toBe('DENY');
    expect(c.has('Strict-Transport-Security')).toBe(false);
  });

  it('com HTTPS de ponta a ponta, acrescenta o HSTS', () => {
    expect(executar(true).get('Strict-Transport-Security')).toBe(HSTS);
  });
});
