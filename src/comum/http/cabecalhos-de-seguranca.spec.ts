import type { Request, Response } from 'express';
import { criarMiddlewareDeCabecalhos, HSTS } from './cabecalhos-de-seguranca';

function executar(hsts: boolean, caminho = '/'): Map<string, string> {
  const cabecalhos = new Map<string, string>();
  const resposta = {
    setHeader: (nome: string, valor: string) => cabecalhos.set(nome, valor),
  } as unknown as Response;
  const proximo = jest.fn();
  criarMiddlewareDeCabecalhos(hsts)(
    { path: caminho } as Request,
    resposta,
    proximo,
  );
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

  it('R3 — respostas de /api/v1/* levam Cache-Control: no-store; o resto da API não é tocado', () => {
    expect(executar(false, '/api/v1/contatos').get('Cache-Control')).toBe(
      'no-store',
    );
    expect(executar(false, '/api/saude').has('Cache-Control')).toBe(false);
    expect(executar(false, '/api/docs').has('Cache-Control')).toBe(false);
  });
});
