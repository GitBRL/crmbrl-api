import { ehConflitoDeEscrita, repetirEmConflito } from './repeticao';

function conflito(): Error {
  return Object.assign(new Error('deadlock'), { code: 'P2034' });
}

describe('repetirEmConflito', () => {
  it('reconhece o P2034 do Prisma', () => {
    expect(ehConflitoDeEscrita(conflito())).toBe(true);
    expect(ehConflitoDeEscrita({ code: 'P2002' })).toBe(false);
    expect(ehConflitoDeEscrita(new Error('outro'))).toBe(false);
    expect(ehConflitoDeEscrita(null)).toBe(false);
  });

  it('repete a operação abortada por conflito de escrita e devolve o resultado', async () => {
    let chamadas = 0;
    const resultado = await repetirEmConflito(() => {
      chamadas += 1;
      return chamadas < 3 ? Promise.reject(conflito()) : Promise.resolve('ok');
    });
    expect(resultado).toBe('ok');
    expect(chamadas).toBe(3);
  });

  it('desiste depois das tentativas e relança o conflito', async () => {
    let chamadas = 0;
    await expect(
      repetirEmConflito(() => {
        chamadas += 1;
        return Promise.reject(conflito());
      }, 2),
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(chamadas).toBe(2);
  });

  it('não repete outros erros', async () => {
    let chamadas = 0;
    await expect(
      repetirEmConflito(() => {
        chamadas += 1;
        return Promise.reject(new Error('regra violada'));
      }),
    ).rejects.toThrow('regra violada');
    expect(chamadas).toBe(1);
  });
});
