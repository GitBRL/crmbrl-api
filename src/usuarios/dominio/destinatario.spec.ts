import {
  type PapelDeTeste,
  papelESetor,
} from '../../comum/dominio/papeis-antigos.apoio-spec';
import {
  escolherDestinatario,
  explicarDestinatario,
  type ResultadoDestinatario,
  type UsuarioDaHierarquia,
} from './destinatario';

function usuario(
  id: string,
  papel: PapelDeTeste,
  liderId: string | null = null,
  ativo = true,
): UsuarioDaHierarquia {
  return { id, nome: id.toUpperCase(), ...papelESetor(papel), ativo, liderId };
}

/**
 * Organização de referência:
 *
 *   admin, admin2 (ADMIN)
 *   c1 (C-level, o mais antigo), c2 (C-level)
 *   └─ lc (Líder Comercial, líder: c1)
 *      └─ ana, bia (Comercial, líder: lc)
 */
function organizacao(
  ajustes: Partial<Record<string, Partial<UsuarioDaHierarquia>>> = {},
) {
  const base = [
    usuario('admin', 'ADMIN'),
    usuario('admin2', 'ADMIN'),
    usuario('c1', 'C_LEVEL'),
    usuario('c2', 'C_LEVEL'),
    usuario('lc', 'LIDER_COMERCIAL', 'c1'),
    usuario('ana', 'COMERCIAL', 'lc'),
    usuario('bia', 'COMERCIAL', 'lc'),
  ];
  const usuarios = base.map((item) => ({ ...item, ...ajustes[item.id] }));
  const porId = (id: string): UsuarioDaHierarquia => {
    const encontrado = usuarios.find((item) => item.id === id);
    if (!encontrado) {
      throw new Error(`usuário ${id} não está na organização de teste`);
    }
    return encontrado;
  };
  return { usuarios, porId };
}

function destinatarioDe(resultado: ResultadoDestinatario): string {
  if (resultado.tipo !== 'definido') {
    throw new Error(`esperava um destinatário, veio ${resultado.tipo}`);
  }
  return resultado.destinatario.id;
}

describe('escolherDestinatario (R7.2)', () => {
  it('R7.2 — membro desligado: vai para o líder dele', () => {
    const { usuarios, porId } = organizacao();
    const resultado = escolherDestinatario({
      desligado: porId('ana'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toEqual({
      tipo: 'definido',
      destinatario: porId('lc'),
      motivo: 'LIDER',
      ignorados: [],
    });
  });

  it('R7.2 — líder desligado: vai para o C-level responsável (o líder dele)', () => {
    const { usuarios, porId } = organizacao({ lc: { liderId: 'c2' } });
    const resultado = escolherDestinatario({
      desligado: porId('lc'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toMatchObject({
      tipo: 'definido',
      motivo: 'C_LEVEL_RESPONSAVEL',
      ignorados: [],
    });
    // O C-level responsável, mesmo que não seja o mais antigo.
    expect(destinatarioDe(resultado)).toBe('c2');
  });

  it('R7.2 — membro cujo líder está inativo: sobe direto para o C-level', () => {
    const { usuarios, porId } = organizacao({ lc: { ativo: false } });
    const resultado = escolherDestinatario({
      desligado: porId('ana'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toEqual({
      tipo: 'definido',
      destinatario: porId('c1'),
      motivo: 'SUBIU_NA_CADEIA',
      ignorados: [porId('lc')],
    });
  });

  it('R7.2 — cadeia inteira inativa: vai para um C-level ativo (o primeiro da ordem recebida)', () => {
    const { usuarios, porId } = organizacao({
      lc: { ativo: false },
      c1: { ativo: false },
    });
    const resultado = escolherDestinatario({
      desligado: porId('ana'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toEqual({
      tipo: 'definido',
      destinatario: porId('c2'),
      motivo: 'C_LEVEL_ATIVO',
      ignorados: [porId('lc'), porId('c1')],
    });
  });

  it('R7.2 — líder cujo C-level está inativo: a cadeia acaba e vai para outro C-level ativo', () => {
    const { usuarios, porId } = organizacao({ c1: { ativo: false } });
    const resultado = escolherDestinatario({
      desligado: porId('lc'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toMatchObject({
      tipo: 'definido',
      motivo: 'C_LEVEL_ATIVO',
      ignorados: [porId('c1')],
    });
    expect(destinatarioDe(resultado)).toBe('c2');
  });

  it('R7.2 — membro sem líder (ou com líder inexistente): vai para um C-level ativo', () => {
    const semLider = organizacao({ ana: { liderId: null } });
    expect(
      escolherDestinatario({
        desligado: semLider.porId('ana'),
        executor: semLider.porId('admin'),
        usuarios: semLider.usuarios,
      }),
    ).toMatchObject({
      tipo: 'definido',
      motivo: 'C_LEVEL_ATIVO',
      ignorados: [],
    });

    const liderSumiu = organizacao({ ana: { liderId: 'nao-existe' } });
    expect(
      destinatarioDe(
        escolherDestinatario({
          desligado: liderSumiu.porId('ana'),
          executor: liderSumiu.porId('admin'),
          usuarios: liderSumiu.usuarios,
        }),
      ),
    ).toBe('c1');
  });

  it('R7.2 — cadeia que volta para o próprio desligado (ciclo) não trava: vai para um C-level ativo', () => {
    const { usuarios, porId } = organizacao({
      lc: { ativo: false, liderId: 'ana' },
    });
    const resultado = escolherDestinatario({
      desligado: porId('ana'),
      executor: porId('admin'),
      usuarios,
    });
    expect(resultado).toMatchObject({
      tipo: 'definido',
      motivo: 'C_LEVEL_ATIVO',
      ignorados: [porId('lc')],
    });
    expect(destinatarioDe(resultado)).toBe('c1');
  });

  it('cadeia acabou e não há C-level ativo: fica com o Admin que executa', () => {
    const { usuarios, porId } = organizacao({
      lc: { ativo: false },
      c1: { ativo: false },
      c2: { ativo: false },
    });
    const resultado = escolherDestinatario({
      desligado: porId('bia'),
      executor: porId('admin2'),
      usuarios,
    });
    expect(resultado).toEqual({
      tipo: 'definido',
      destinatario: porId('admin2'),
      motivo: 'SEM_C_LEVEL_ATIVO',
      ignorados: [porId('lc'), porId('c1')],
    });
  });

  describe('C-level desligado', () => {
    it('R7.2 — sem a escolha do Admin: pede a escolha e lista os outros C-levels ativos', () => {
      const { usuarios, porId } = organizacao();
      const resultado = escolherDestinatario({
        desligado: porId('c1'),
        executor: porId('admin'),
        usuarios,
      });
      expect(resultado).toEqual({
        tipo: 'escolha_necessaria',
        candidatos: [porId('c2')],
      });
    });

    it('R7.2 — vai para o C-level ativo escolhido pelo Admin', () => {
      const { usuarios, porId } = organizacao();
      const resultado = escolherDestinatario({
        desligado: porId('c1'),
        executor: porId('admin'),
        usuarios,
        escolhidoId: 'c2',
      });
      expect(resultado).toEqual({
        tipo: 'definido',
        destinatario: porId('c2'),
        motivo: 'ESCOLHIDO_PELO_ADMIN',
        ignorados: [],
      });
    });

    it.each([
      ['um usuário que não é C-level', 'lc', {}],
      ['um C-level desligado', 'c2', { c2: { ativo: false } }],
      ['o próprio desligado', 'c1', {}],
      ['um id desconhecido', 'nao-existe', {}],
    ])('R7.2 — recusa a escolha de %s', (_descricao, escolhidoId, ajustes) => {
      const { usuarios, porId } = organizacao(ajustes);
      // Um terceiro C-level ativo: há candidato válido, a escolha é que não serve.
      const extra = usuario('c3', 'C_LEVEL');
      const resultado = escolherDestinatario({
        desligado: porId('c1'),
        executor: porId('admin'),
        usuarios: [...usuarios, extra],
        escolhidoId,
      });
      expect(resultado).toMatchObject({
        tipo: 'invalido',
        regra: 'R7.2',
        detalhes: { destinatarioId: escolhidoId },
      });
    });

    it('R7.2 — sem outro C-level ativo, o desligamento do C-level é recusado', () => {
      const { usuarios, porId } = organizacao({ c2: { ativo: false } });
      const resultado = escolherDestinatario({
        desligado: porId('c1'),
        executor: porId('admin'),
        usuarios,
        escolhidoId: 'c2',
      });
      expect(resultado).toMatchObject({ tipo: 'invalido', regra: 'R7.2' });
      if (resultado.tipo === 'invalido') {
        expect(resultado.mensagem).toMatch(/Não há outro C-level ativo/);
      }
    });
  });

  describe('Admin desligado', () => {
    it('R7.2 — vai para o Admin que executa', () => {
      const { usuarios, porId } = organizacao();
      const resultado = escolherDestinatario({
        desligado: porId('admin2'),
        executor: porId('admin'),
        usuarios,
      });
      expect(resultado).toEqual({
        tipo: 'definido',
        destinatario: porId('admin'),
        motivo: 'ADMIN_EXECUTOR',
        ignorados: [],
      });
    });

    it('R7.2 — o Admin não desliga a si mesmo', () => {
      const { usuarios, porId } = organizacao();
      expect(
        escolherDestinatario({
          desligado: porId('admin'),
          executor: porId('admin'),
          usuarios,
        }),
      ).toMatchObject({ tipo: 'invalido', regra: 'R7.2' });
    });
  });

  it('a escolha só vale para C-level: em membro e líder, segue a cadeia', () => {
    const { usuarios, porId } = organizacao();
    expect(
      destinatarioDe(
        escolherDestinatario({
          desligado: porId('ana'),
          executor: porId('admin'),
          usuarios,
          escolhidoId: 'c2',
        }),
      ),
    ).toBe('lc');
  });
});

describe('explicarDestinatario', () => {
  it('explica cada caso em português', () => {
    const { usuarios, porId } = organizacao({ lc: { ativo: false } });
    const explicar = (desligado: string, escolhidoId?: string) =>
      explicarDestinatario(
        porId(desligado),
        escolherDestinatario({
          desligado: porId(desligado),
          executor: porId('admin'),
          usuarios,
          escolhidoId,
        }),
      );
    expect(explicar('ana')).toBe(
      'O líder de ANA (Comercial), LC, foi desligado: o que está com ANA sobe na cadeia até C1.',
    );
    expect(explicar('c1')).toBe(
      'C1 (C-level) é C-level: escolha outro C-level ativo para receber o que está com C1.',
    );
    expect(explicar('c1', 'c2')).toBe(
      'O que está com C1 (C-level) vai para o C-level escolhido, C2.',
    );
    expect(explicar('admin2')).toBe(
      'O que está com ADMIN2 (Admin) vai para quem executa o desligamento, ADMIN.',
    );
    const ativa = organizacao();
    expect(
      explicarDestinatario(
        ativa.porId('ana'),
        escolherDestinatario({
          desligado: ativa.porId('ana'),
          executor: ativa.porId('admin'),
          usuarios: ativa.usuarios,
        }),
      ),
    ).toBe('O que está com ANA (Comercial) vai para o líder, LC.');
  });
});
