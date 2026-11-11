import {
  chaveDoAlvo,
  mudancaDeAcessos,
  resumoDosAcessos,
  validarAcessosPedidos,
} from './acessos-extras';

const db = {
  setor: {
    findMany: () =>
      Promise.resolve([
        { chave: 'CS', nome: 'Customer Success', ativo: true },
        { chave: 'ANTIGO', nome: 'Antigo', ativo: false },
      ]),
  },
  usuario: {
    findMany: () =>
      Promise.resolve([
        { id: 'u-ativo', nome: 'Ana', ativo: true },
        { id: 'u-desligado', nome: 'Beto', ativo: false },
      ]),
  },
} as never;

const erro = async (promessa: Promise<unknown>) => {
  try {
    await promessa;
  } catch (e) {
    return (e as { getResponse(): Record<string, unknown> }).getResponse();
  }
  throw new Error('deveria falhar');
};

describe('listas de acessos extras (R5.11)', () => {
  it('R5.11 — cada linha com exatamente um alvo e sem repetir (400)', async () => {
    const semAlvo = await erro(
      validarAcessosPedidos(db, 'COMERCIAL', [{ nivel: 'VER' }], []),
    );
    expect(semAlvo).toMatchObject({ erro: 'dados_invalidos' });
    const dois = await erro(
      validarAcessosPedidos(
        db,
        'COMERCIAL',
        [{ area: 'CS', usuarioId: 'u-ativo', nivel: 'VER' }],
        [],
      ),
    );
    expect(dois).toMatchObject({ erro: 'dados_invalidos' });
    const repetido = await erro(
      validarAcessosPedidos(
        db,
        'COMERCIAL',
        [
          { area: 'CS', nivel: 'VER' },
          { area: 'CS', nivel: 'GESTOR' },
        ],
        [],
      ),
    );
    expect(repetido).toMatchObject({ erro: 'dados_invalidos' });
  });

  it('R5.11 — o setor dono, setor inexistente e alvo novo inativo dão 422', async () => {
    const dono = await erro(
      validarAcessosPedidos(db, 'CS', [{ area: 'CS', nivel: 'VER' }], []),
    );
    expect(dono).toMatchObject({
      erro: 'regra_violada',
      detalhes: { regra: 'R5.11' },
    });
    const inexistente = await erro(
      validarAcessosPedidos(
        db,
        'COMERCIAL',
        [{ area: 'NADA', nivel: 'VER' }],
        [],
      ),
    );
    expect(inexistente).toMatchObject({ detalhes: { regra: 'R5.11' } });
    const desativado = await erro(
      validarAcessosPedidos(
        db,
        'COMERCIAL',
        [{ area: 'ANTIGO', nivel: 'VER' }],
        [],
      ),
    );
    expect(desativado).toMatchObject({ detalhes: { regra: 'R5.11' } });
    const desligado = await erro(
      validarAcessosPedidos(
        db,
        'COMERCIAL',
        [{ usuarioId: 'u-desligado', nivel: 'VER' }],
        [],
      ),
    );
    expect(desligado).toMatchObject({ detalhes: { regra: 'R5.11' } });
  });

  it('R5.11 — alvo inativo que já estava na lista pode continuar', async () => {
    const lista = await validarAcessosPedidos(
      db,
      'COMERCIAL',
      [
        { usuarioId: 'u-desligado', nivel: 'VER' },
        { area: 'ANTIGO', nivel: 'MEMBRO' },
      ],
      [
        { id: 'a1', area: null, usuarioId: 'u-desligado', nivel: 'VER' },
        { id: 'a2', area: 'ANTIGO', usuarioId: null, nivel: 'VER' },
      ],
    );
    expect(lista.map(chaveDoAlvo)).toEqual([
      'pessoa:u-desligado',
      'setor:ANTIGO',
    ]);
  });

  it('R5.11 — a troca grava só o que mudou', () => {
    const gravados = [
      { id: 'a1', area: 'CS', usuarioId: null, nivel: 'VER' as const },
      { id: 'a2', area: null, usuarioId: 'u1', nivel: 'MEMBRO' as const },
      {
        id: 'a3',
        area: 'MARKETING',
        usuarioId: null,
        nivel: 'GESTOR' as const,
      },
    ];
    const mudanca = mudancaDeAcessos(gravados, [
      { area: 'CS', usuarioId: null, nivel: 'VER' },
      { area: null, usuarioId: 'u1', nivel: 'GESTOR' },
      { area: null, usuarioId: 'u2', nivel: 'VER' },
    ]);
    expect(mudanca).toEqual({
      criar: [{ area: null, usuarioId: 'u2', nivel: 'VER' }],
      atualizar: [{ id: 'a2', nivel: 'GESTOR' }],
      remover: ['a3'],
    });
    expect(resumoDosAcessos(gravados)).toEqual([
      { alvo: 'pessoa:u1', nivel: 'MEMBRO' },
      { alvo: 'setor:CS', nivel: 'VER' },
      { alvo: 'setor:MARKETING', nivel: 'GESTOR' },
    ]);
  });
});
