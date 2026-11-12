import type { NextFunction, Request, Response } from 'express';

/**
 * Cabeçalhos de segurança de toda resposta da API (o Caddy do front repete os
 * mesmos, e acrescenta a CSP do front, mas a API também pode ser acessada direto).
 * Sem CSP aqui: a documentação em `/api/docs` (Swagger UI) usa scripts inline.
 */
export const CABECALHOS_DE_SEGURANCA: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** HSTS: só em produção com cookie seguro (HTTPS de ponta a ponta), por 180 dias. */
export const HSTS = 'max-age=15552000';

export function criarMiddlewareDeCabecalhos(
  hsts: boolean,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    // Respostas da API (dados de pessoas, de negócios, de conversas) nunca ficam em cache de
    // navegador nem de proxy. Quem tem política própria (download de arquivo, widget, gravação)
    // troca o cabeçalho depois, na própria resposta.
    if (req.path?.startsWith('/api/v1/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    for (const [nome, valor] of Object.entries(CABECALHOS_DE_SEGURANCA)) {
      res.setHeader(nome, valor);
    }
    if (hsts) {
      res.setHeader('Strict-Transport-Security', HSTS);
    }
    next();
  };
}
