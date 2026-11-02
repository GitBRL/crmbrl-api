import type { Canal, Conversa } from '../generated/prisma/client';
import type { AdaptadorCanal } from './adaptador-canal';
import { RegistroCanais } from './registro-canais';

const adaptador = (
  tipo: AdaptadorCanal['tipo'],
  extra: Partial<AdaptadorCanal> = {},
): AdaptadorCanal => ({
  tipo,
  enviar: () => Promise.resolve({}),
  ...extra,
});

describe('RegistroCanais', () => {
  it('registra um adaptador por tipo e recusa o segundo', () => {
    const registro = new RegistroCanais();
    const email = adaptador('EMAIL');
    registro.registrar(email);
    expect(registro.obter('EMAIL')).toBe(email);
    expect(registro.tipos()).toEqual(['EMAIL']);
    expect(() => registro.registrar(adaptador('EMAIL'))).toThrow(/Já existe/);
  });

  it('sem adaptador, obter responde 503 com mensagem em português', () => {
    const registro = new RegistroCanais();
    expect(registro.buscar('WEBCHAT')).toBeUndefined();
    expect(() => registro.obter('WEBCHAT')).toThrow(
      expect.objectContaining({
        status: 503,
        mensagem: 'O canal chat do site não está disponível nesta instalação.',
      }),
    );
  });

  it('substituir troca o adaptador (testes) e desfaz', () => {
    const registro = new RegistroCanais();
    const real = adaptador('WHATSAPP');
    registro.registrar(real);
    const falso = adaptador('WHATSAPP');
    const desfazer = registro.substituir(falso);
    expect(registro.obter('WHATSAPP')).toBe(falso);
    desfazer();
    expect(registro.obter('WHATSAPP')).toBe(real);
  });

  it('podeResponder usa a regra do adaptador; sem ela, pode', () => {
    const registro = new RegistroCanais();
    registro.registrar(
      adaptador('INSTAGRAM', {
        podeResponder: () => ({ pode: false, motivo: 'janela' }),
      }),
    );
    const conversa = {} as Conversa;
    expect(
      registro.podeResponder(conversa, { tipo: 'INSTAGRAM' } as Canal),
    ).toEqual({
      pode: false,
      motivo: 'janela',
    });
    expect(
      registro.podeResponder(conversa, { tipo: 'EMAIL' } as Canal),
    ).toEqual({ pode: true });
  });
});
