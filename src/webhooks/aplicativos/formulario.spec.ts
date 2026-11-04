import { lerFormularioAninhado, partesDaChave } from './formulario';

describe('Formulário aninhado (R32.2)', () => {
  it('R32.2 — partesDaChave separa colchetes e mantém chaves simples', () => {
    expect(partesDaChave('fields[email][value]')).toEqual([
      'fields',
      'email',
      'value',
    ]);
    expect(partesDaChave('tags[]')).toEqual(['tags', '']);
    expect(partesDaChave('utm_source')).toEqual(['utm_source']);
    expect(partesDaChave('contact[fields][3]')).toEqual([
      'contact',
      'fields',
      '3',
    ]);
  });

  it('R32.2 — fields[<id>][value] e form[name] do Elementor com Advanced Data', () => {
    const corpo = lerFormularioAninhado(
      'form%5Bid%5D=3f8a1c2&form%5Bname%5D=Contato+do+site' +
        '&fields%5Bname%5D%5Bid%5D=name&fields%5Bname%5D%5Bvalue%5D=Maria+Souza' +
        '&fields%5Bemail%5D%5Bvalue%5D=maria%40empresa.com.br',
    );
    expect(corpo).toEqual({
      form: { id: '3f8a1c2', name: 'Contato do site' },
      fields: {
        name: { id: 'name', value: 'Maria Souza' },
        email: { value: 'maria@empresa.com.br' },
      },
    });
  });

  it('R32.2 — contact[fields][3] mantém o id 3 como chave (não vira posição de lista)', () => {
    const corpo = lerFormularioAninhado(
      'contact[email]=a%40b.com&contact[fields][3]=Natal&contact[fields][12]=VIP',
    );
    expect(corpo).toEqual({
      contact: { email: 'a@b.com', fields: { '3': 'Natal', '12': 'VIP' } },
    });
  });

  it('R32.2 — índices 0..n-1 viram lista; chave repetida e [] também', () => {
    expect(lerFormularioAninhado('a[0]=x&a[1]=y&b=1&b=2&t[]=p&t[]=q')).toEqual({
      a: ['x', 'y'],
      b: ['1', '2'],
      t: ['p', 'q'],
    });
  });

  it('R32.2 — chaves perigosas são descartadas', () => {
    const corpo = lerFormularioAninhado(
      '__proto__[x]=1&constructor[prototype][y]=2&ok=1',
    );
    expect(corpo).toEqual({ ok: '1' });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
