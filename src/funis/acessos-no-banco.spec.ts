import { pessoa } from '../comum/dominio/papeis-antigos.apoio-spec';
import {
  acessosDoFunil,
  funisAcessiveis,
  type LeitorDeAcessos,
  podeSerResponsavel,
} from './acessos-no-banco';

interface Linha {
  funilId?: string;
  areaDono?: string;
  area: string | null;
  usuarioId: string | null;
  nivel: 'VER' | 'MEMBRO' | 'GESTOR';
}

/** Banco de mentira: filtra as linhas pelos campos do `where` que as funções usam. */
function bancoFalso(dados: {
  setores: { chave: string; ativo: boolean }[];
  funis: { id: string; area: string; visibilidade: 'SETOR' | 'RESTRITA' }[];
  acessosFunil: Linha[];
  acessosSetor: Linha[];
}): LeitorDeAcessos {
  const casaAlvo = (
    linha: Linha,
    alvos: { usuarioId?: string; area?: string }[],
  ) =>
    alvos.some(
      (alvo) =>
        (alvo.usuarioId !== undefined && linha.usuarioId === alvo.usuarioId) ||
        (alvo.area !== undefined && linha.area === alvo.area),
    );
  return {
    setor: {
      findUnique: ({ where }: { where: { chave: string } }) =>
        Promise.resolve(
          dados.setores.find((s) => s.chave === where.chave) ?? null,
        ),
      findMany: ({ where }: { where: { chave: { in: string[] } } }) =>
        Promise.resolve(
          dados.setores.filter(
            (s) => where.chave.in.includes(s.chave) && s.ativo,
          ),
        ),
    },
    acessoFunil: {
      findMany: ({ where }: { where: { OR?: object[]; funilId?: string } }) =>
        Promise.resolve(
          dados.acessosFunil.filter((l) =>
            where.funilId
              ? l.funilId === where.funilId
              : casaAlvo(
                  l,
                  where.OR as { usuarioId?: string; area?: string }[],
                ),
          ),
        ),
    },
    acessoSetor: {
      findMany: ({ where }: { where: { OR?: object[]; areaDono?: string } }) =>
        Promise.resolve(
          dados.acessosSetor.filter((l) =>
            where.areaDono
              ? l.areaDono === where.areaDono
              : casaAlvo(
                  l,
                  where.OR as { usuarioId?: string; area?: string }[],
                ),
          ),
        ),
    },
    funil: {
      findMany: ({
        where,
      }: {
        where: {
          OR: { area?: string | { in: string[] }; id?: { in: string[] } }[];
        };
      }) =>
        Promise.resolve(
          dados.funis.filter((f) =>
            where.OR.some((c) =>
              typeof c.area === 'string'
                ? f.area === c.area
                : c.area
                  ? c.area.in.includes(f.area)
                  : (c.id?.in.includes(f.id) ?? false),
            ),
          ),
        ),
    },
  } as unknown as LeitorDeAcessos;
}

const banco = bancoFalso({
  setores: [
    { chave: 'COMERCIAL', ativo: true },
    { chave: 'CS', ativo: true },
    { chave: 'MARKETING', ativo: true },
    { chave: 'ANTIGO', ativo: false },
  ],
  funis: [
    { id: 'f-com', area: 'COMERCIAL', visibilidade: 'SETOR' },
    { id: 'f-vip', area: 'COMERCIAL', visibilidade: 'RESTRITA' },
    { id: 'f-cs', area: 'CS', visibilidade: 'SETOR' },
  ],
  acessosFunil: [
    {
      funilId: 'f-vip',
      area: null,
      usuarioId: 'membro-com-2',
      nivel: 'MEMBRO',
    },
    { funilId: 'f-vip', area: 'ANTIGO', usuarioId: null, nivel: 'GESTOR' },
  ],
  acessosSetor: [
    { areaDono: 'COMERCIAL', area: 'CS', usuarioId: null, nivel: 'VER' },
    { areaDono: 'COMERCIAL', area: null, usuarioId: 'mkt-1', nivel: 'GESTOR' },
  ],
});

describe('acessos lidos do banco (R5.9, R5.11, R5.13)', () => {
  it('R5.11 — funisAcessiveis junta o setor da pessoa, os acessos do setor e os do funil', async () => {
    const cs = await funisAcessiveis(banco, pessoa('CS', { id: 'cs-1' }));
    expect(cs.nivel('f-cs')).toBe('MEMBRO');
    expect(cs.nivel('f-com')).toBe('VER');
    // O acesso do setor não vale no restrito.
    expect(cs.nivel('f-vip')).toBe(null);
    const mkt = await funisAcessiveis(
      banco,
      pessoa('MARKETING', { id: 'mkt-1' }),
    );
    expect(mkt.nivel('f-com')).toBe('GESTOR');
    expect(mkt.nivel('f-vip')).toBe(null);
  });

  it('R5.9 — no RESTRITA, o membro do setor dono só com acesso na lista do funil', async () => {
    const semLista = await funisAcessiveis(
      banco,
      pessoa('COMERCIAL', { id: 'membro-com-1' }),
    );
    expect(semLista.nivel('f-com')).toBe('MEMBRO');
    expect(semLista.nivel('f-vip')).toBe(null);
    const naLista = await funisAcessiveis(
      banco,
      pessoa('COMERCIAL', { id: 'membro-com-2' }),
    );
    expect(naLista.nivel('f-vip')).toBe('MEMBRO');
    const lider = await funisAcessiveis(
      banco,
      pessoa('LIDER_COMERCIAL', { id: 'lider-com' }),
    );
    expect(lider.nivel('f-vip')).toBe('CONFIGURAR');
  });

  it('R5.13 — responsável válido: ativo e com nível MEMBRO ou mais no funil', async () => {
    const vip = await acessosDoFunil(banco, {
      id: 'f-vip',
      area: 'COMERCIAL',
      visibilidade: 'RESTRITA',
    });
    const ativo = { ativo: true };
    expect(
      podeSerResponsavel(
        vip,
        pessoa('COMERCIAL', { id: 'membro-com-2', ...ativo }),
      ),
    ).toBe(true);
    expect(
      podeSerResponsavel(
        vip,
        pessoa('COMERCIAL', { id: 'membro-com-1', ...ativo }),
      ),
    ).toBe(false);
    expect(
      podeSerResponsavel(vip, pessoa('LIDER_COMERCIAL', { id: 'l', ...ativo })),
    ).toBe(true);
    expect(
      podeSerResponsavel(
        vip,
        pessoa('COMERCIAL', { id: 'membro-com-2', ativo: false }),
      ),
    ).toBe(false);
    const com = await acessosDoFunil(banco, {
      id: 'f-com',
      area: 'COMERCIAL',
      visibilidade: 'SETOR',
    });
    // VER (o CS pelo setor) não é responsável; GESTOR (mkt-1 pela pessoa) é.
    expect(
      podeSerResponsavel(com, pessoa('CS', { id: 'cs-1', ...ativo })),
    ).toBe(false);
    expect(
      podeSerResponsavel(com, pessoa('MARKETING', { id: 'mkt-1', ...ativo })),
    ).toBe(true);
    expect(
      podeSerResponsavel(com, pessoa('C_LEVEL', { id: 'c', ...ativo })),
    ).toBe(true);
  });

  it('R5.11 — acesso para setor desativado não conta para quem é dele', async () => {
    const vip = await acessosDoFunil(banco, {
      id: 'f-vip',
      area: 'COMERCIAL',
      visibilidade: 'RESTRITA',
    });
    expect(vip.nivelDe({ id: 'x', papel: 'MEMBRO', area: 'ANTIGO' })).toBe(
      null,
    );
  });
});
