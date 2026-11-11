import {
  type PapelDeTeste,
  pessoa,
} from '../comum/dominio/papeis-antigos.apoio-spec';
import { Prisma } from '../generated/prisma/client';
import {
  type AcessoExtra,
  AcessoAosFunis,
  alcanceEfetivo,
  atuaNoSetor,
  type FunilParaAcesso,
  maiorNivel,
  nivelAlcanca,
  nivelEfetivo,
  type NivelNoFunil,
  podeConfigurarFunis,
  podeConfigurarPassagens,
  podeConfigurarRodizio,
} from './acesso-funis';

const quem = (papel: PapelDeTeste) => pessoa(papel, { id: `id-${papel}` });

const comercial: FunilParaAcesso = {
  id: 'f-com',
  area: 'COMERCIAL',
  visibilidade: 'SETOR',
};
const restrito: FunilParaAcesso = {
  id: 'f-vip',
  area: 'COMERCIAL',
  visibilidade: 'RESTRITA',
};
const semAcessos = { doFunil: [], doSetor: [] };
const todosAtivos = () => true;

const paraSetor = (area: string, nivel: AcessoExtra['nivel']): AcessoExtra => ({
  area,
  usuarioId: null,
  nivel,
});
const paraPessoa = (
  usuarioId: string,
  nivel: AcessoExtra['nivel'],
): AcessoExtra => ({ area: null, usuarioId, nivel });

describe('nível efetivo num funil (R5.9, R5.11, R5.12)', () => {
  it('R5.9 — Admin e C-level configuram todos os funis, até os restritos de outros setores', () => {
    for (const papel of ['ADMIN', 'C_LEVEL'] as const) {
      expect(nivelEfetivo(quem(papel), restrito, semAcessos, todosAtivos)).toBe(
        'CONFIGURAR',
      );
    }
  });

  it('R5.9 — no funil SETOR, o líder do setor dono configura e o membro age como membro; outro setor não vê', () => {
    expect(
      nivelEfetivo(quem('LIDER_COMERCIAL'), comercial, semAcessos, todosAtivos),
    ).toBe('CONFIGURAR');
    expect(
      nivelEfetivo(quem('COMERCIAL'), comercial, semAcessos, todosAtivos),
    ).toBe('MEMBRO');
    expect(nivelEfetivo(quem('CS'), comercial, semAcessos, todosAtivos)).toBe(
      null,
    );
    expect(
      nivelEfetivo(quem('LIDER_CS'), comercial, semAcessos, todosAtivos),
    ).toBe(null);
  });

  it('R5.9 — no funil RESTRITA, do setor dono só os líderes; o membro só com acesso na lista do funil', () => {
    expect(
      nivelEfetivo(quem('LIDER_COMERCIAL'), restrito, semAcessos, todosAtivos),
    ).toBe('CONFIGURAR');
    expect(
      nivelEfetivo(quem('COMERCIAL'), restrito, semAcessos, todosAtivos),
    ).toBe(null);
    expect(
      nivelEfetivo(
        quem('COMERCIAL'),
        restrito,
        { doFunil: [paraPessoa('id-COMERCIAL', 'VER')], doSetor: [] },
        todosAtivos,
      ),
    ).toBe('VER');
  });

  it('R5.11 — acesso do funil vale pela pessoa e pelo setor dela', () => {
    const doFunil = [
      paraSetor('CS', 'VER'),
      paraPessoa('id-MARKETING', 'GESTOR'),
    ];
    expect(
      nivelEfetivo(
        quem('CS'),
        comercial,
        { doFunil, doSetor: [] },
        todosAtivos,
      ),
    ).toBe('VER');
    expect(
      nivelEfetivo(
        quem('LIDER_CS'),
        comercial,
        { doFunil, doSetor: [] },
        todosAtivos,
      ),
    ).toBe('VER');
    expect(
      nivelEfetivo(
        quem('MARKETING'),
        comercial,
        { doFunil, doSetor: [] },
        todosAtivos,
      ),
    ).toBe('GESTOR');
    expect(
      nivelEfetivo(
        quem('LIDER_MARKETING'),
        comercial,
        { doFunil, doSetor: [] },
        todosAtivos,
      ),
    ).toBe(null);
  });

  it('R5.11 — acesso do setor dono vale nos funis SETOR e não vale nos RESTRITA', () => {
    const doSetor = [paraSetor('CS', 'GESTOR')];
    expect(
      nivelEfetivo(
        quem('CS'),
        comercial,
        { doFunil: [], doSetor },
        todosAtivos,
      ),
    ).toBe('GESTOR');
    expect(
      nivelEfetivo(quem('CS'), restrito, { doFunil: [], doSetor }, todosAtivos),
    ).toBe(null);
  });

  it('R5.11 — vale o maior nível entre o papel no setor dono e os acessos', () => {
    // Membro do setor dono com GESTOR pela pessoa no setor: GESTOR.
    expect(
      nivelEfetivo(
        quem('COMERCIAL'),
        comercial,
        { doFunil: [], doSetor: [paraPessoa('id-COMERCIAL', 'GESTOR')] },
        todosAtivos,
      ),
    ).toBe('GESTOR');
    // Membro do setor dono com VER: continua MEMBRO (o maior).
    expect(
      nivelEfetivo(
        quem('COMERCIAL'),
        comercial,
        { doFunil: [paraPessoa('id-COMERCIAL', 'VER')], doSetor: [] },
        todosAtivos,
      ),
    ).toBe('MEMBRO');
    // Pessoa de outro setor: o maior entre o do setor dela e o dela.
    expect(
      nivelEfetivo(
        quem('CS'),
        comercial,
        {
          doFunil: [paraPessoa('id-CS', 'VER')],
          doSetor: [paraSetor('CS', 'MEMBRO')],
        },
        todosAtivos,
      ),
    ).toBe('MEMBRO');
  });

  it('R5.11 — acesso dado a um setor desativado não conta (o dado à pessoa conta)', () => {
    const doFunil = [paraSetor('CS', 'GESTOR'), paraPessoa('id-CS', 'VER')];
    expect(
      nivelEfetivo(
        quem('CS'),
        comercial,
        { doFunil, doSetor: [] },
        () => false,
      ),
    ).toBe('VER');
    expect(
      nivelEfetivo(
        quem('LIDER_CS'),
        comercial,
        { doFunil, doSetor: [] },
        (area) => area !== 'CS',
      ),
    ).toBe(null);
  });

  it('R5.12 — ordem dos níveis: VER < MEMBRO < GESTOR < CONFIGURAR', () => {
    expect(nivelAlcanca('VER', 'MEMBRO')).toBe(false);
    expect(nivelAlcanca('MEMBRO', 'MEMBRO')).toBe(true);
    expect(nivelAlcanca('GESTOR', 'MEMBRO')).toBe(true);
    expect(nivelAlcanca('CONFIGURAR', 'GESTOR')).toBe(true);
    expect(nivelAlcanca(null, 'VER')).toBe(false);
    expect(maiorNivel('VER', 'GESTOR')).toBe('GESTOR');
    expect(maiorNivel(null, 'VER')).toBe('VER');
    expect(maiorNivel('MEMBRO', null)).toBe('MEMBRO');
  });
});

describe('o mapa de níveis — AcessoAosFunis (R5.9, R5.12)', () => {
  const membro = quem('CS');
  const niveis = new Map<string, NivelNoFunil>([
    ['f-ver', 'VER'],
    ['f-membro', 'MEMBRO'],
    ['f-gestor', 'GESTOR'],
    ['f-config', 'CONFIGURAR'],
  ]);
  const acesso = AcessoAosFunis.comNiveis(membro, niveis);
  const negocio = (funilId: string, responsavelId: string | null) => ({
    funilId,
    responsavelId,
  });

  it('R5.9 — Admin e C-level: todos os funis e negócios, sem filtro', () => {
    const diretoria = AcessoAosFunis.comNiveis(quem('C_LEVEL'), new Map());
    expect(diretoria.todos).toBe(true);
    expect(diretoria.nivel('qualquer')).toBe('CONFIGURAR');
    expect(diretoria.filtroDeNegocios()).toEqual({});
    expect(diretoria.podeVerNegocio(negocio('x', 'outro'))).toBe(true);
  });

  it('R5.12 — VER vê todos os negócios do funil e não age em nenhum', () => {
    expect(acesso.podeVerNegocio(negocio('f-ver', 'outro'))).toBe(true);
    expect(acesso.podeAgirNoNegocio(negocio('f-ver', null))).toBe(false);
    expect(acesso.podeCriarNoFunil('f-ver')).toBe(false);
    expect(acesso.podeConfigurarFunil('f-ver')).toBe(false);
  });

  it('R5.12 — MEMBRO vê e age nos seus e nos sem responsável; não nos dos outros', () => {
    expect(acesso.podeVerNegocio(negocio('f-membro', membro.id))).toBe(true);
    expect(acesso.podeVerNegocio(negocio('f-membro', null))).toBe(true);
    expect(acesso.podeVerNegocio(negocio('f-membro', 'outro'))).toBe(false);
    expect(acesso.podeAgirNoNegocio(negocio('f-membro', null))).toBe(true);
    expect(acesso.podeAgirNoNegocio(negocio('f-membro', 'outro'))).toBe(false);
    expect(acesso.podeCriarNoFunil('f-membro')).toBe(true);
  });

  it('R5.12 — GESTOR vê e age em todos; só CONFIGURAR configura, reabre e exclui', () => {
    expect(acesso.podeAgirNoNegocio(negocio('f-gestor', 'outro'))).toBe(true);
    expect(acesso.podeConfigurarFunil('f-gestor')).toBe(false);
    expect(acesso.podeConfigurarFunil('f-config')).toBe(true);
  });

  it('R5.9 — funil fora do mapa: não vê nada', () => {
    expect(acesso.podeVerFunil('f-outro')).toBe(false);
    expect(acesso.podeVerNegocio(negocio('f-outro', membro.id))).toBe(false);
  });

  it('R5.9 — o filtro do Prisma separa os funis completos dos de membro', () => {
    expect(acesso.filtroDeNegocios()).toEqual({
      OR: [
        { funilId: { in: ['f-ver', 'f-gestor', 'f-config'] } },
        {
          funilId: { in: ['f-membro'] },
          OR: [{ responsavelId: membro.id }, { responsavelId: null }],
        },
      ],
    });
    const nenhum = AcessoAosFunis.comNiveis(membro, new Map());
    expect(nenhum.filtroDeNegocios()).toEqual({ id: { in: [] } });
    expect(nenhum.sqlDeNegocios().strings.join('')).toBe('FALSE');
  });

  it('R5.9 — o SQL leva os mesmos funis e o responsável', () => {
    const sql = acesso.sqlDeNegocios(Prisma.raw('n'));
    expect(sql.values).toEqual([
      ['f-ver', 'f-gestor', 'f-config'],
      ['f-membro'],
      membro.id,
    ]);
    expect(sql.strings.join('?')).toContain('n.responsavel_id IS NULL');
  });
});

describe('ver separado de agir (R5.12)', () => {
  const membro = quem('COMERCIAL');
  const colega = 'id-colega';

  it('R5.12 — membro do setor com VER no próprio funil: nível de ação MEMBRO, mas vê todos', () => {
    const doFunil = [paraPessoa(membro.id, 'VER')];
    expect(
      alcanceEfetivo(membro, comercial, { doFunil, doSetor: [] }, todosAtivos),
    ).toEqual({ nivel: 'MEMBRO', veTodos: true });
    expect(
      nivelEfetivo(membro, comercial, { doFunil, doSetor: [] }, todosAtivos),
    ).toBe('MEMBRO');
    const pelaEquipe = [paraSetor('COMERCIAL', 'VER')];
    expect(
      alcanceEfetivo(
        membro,
        comercial,
        { doFunil: [], doSetor: pelaEquipe },
        todosAtivos,
      ),
    ).toEqual({ nivel: 'MEMBRO', veTodos: true });
  });

  it('R5.12 — só MEMBRO (papel e acessos): vê só os seus; GESTOR e CONFIGURAR veem todos', () => {
    expect(alcanceEfetivo(membro, comercial, semAcessos, todosAtivos)).toEqual({
      nivel: 'MEMBRO',
      veTodos: false,
    });
    expect(
      alcanceEfetivo(
        quem('CS'),
        comercial,
        { doFunil: [paraSetor('CS', 'MEMBRO')], doSetor: [] },
        todosAtivos,
      ),
    ).toEqual({ nivel: 'MEMBRO', veTodos: false });
    expect(
      alcanceEfetivo(
        membro,
        comercial,
        { doFunil: [paraPessoa(membro.id, 'GESTOR')], doSetor: [] },
        todosAtivos,
      ),
    ).toEqual({ nivel: 'GESTOR', veTodos: true });
    expect(
      alcanceEfetivo(
        quem('LIDER_COMERCIAL'),
        comercial,
        semAcessos,
        todosAtivos,
      ),
    ).toEqual({ nivel: 'CONFIGURAR', veTodos: true });
    expect(
      alcanceEfetivo(quem('CS'), comercial, semAcessos, todosAtivos),
    ).toBeNull();
  });

  it('R5.12 — com MEMBRO e VER: vê o negócio do colega, não age nele; age nos seus e nos sem responsável', () => {
    const acesso = AcessoAosFunis.comNiveis(
      membro,
      new Map([['f-com', { nivel: 'MEMBRO' as const, veTodos: true }]]),
    );
    const doColega = { funilId: 'f-com', responsavelId: colega };
    expect(acesso.nivel('f-com')).toBe('MEMBRO');
    expect(acesso.veTodosNoFunil('f-com')).toBe(true);
    expect(acesso.podeVerNegocio(doColega)).toBe(true);
    expect(acesso.podeAgirNoNegocio(doColega)).toBe(false);
    expect(
      acesso.podeAgirNoNegocio({ funilId: 'f-com', responsavelId: membro.id }),
    ).toBe(true);
    expect(
      acesso.podeAgirNoNegocio({ funilId: 'f-com', responsavelId: null }),
    ).toBe(true);
    expect(acesso.podeCriarNoFunil('f-com')).toBe(true);
    expect(acesso.filtroDeNegocios()).toEqual({
      OR: [{ funilId: { in: ['f-com'] } }],
    });
  });
});

describe('configuração e alcance por setor (R5.1, R5.7, matriz da seção 12)', () => {
  it('R5.1 — criar funil: Admin e C-level em todos os setores; o líder, no seu; o membro, em nenhum', () => {
    expect(podeConfigurarFunis(quem('ADMIN'), 'CS')).toBe(true);
    expect(podeConfigurarFunis(quem('C_LEVEL'), 'MARKETING')).toBe(true);
    expect(podeConfigurarFunis(quem('LIDER_CS'), 'CS')).toBe(true);
    expect(podeConfigurarFunis(quem('LIDER_CS'), 'COMERCIAL')).toBe(false);
    expect(podeConfigurarFunis(quem('COMERCIAL'), 'COMERCIAL')).toBe(false);
  });

  it('matriz — passagens só Admin e C-level; rodízio também o líder da área', () => {
    expect(podeConfigurarPassagens(quem('ADMIN'))).toBe(true);
    expect(podeConfigurarPassagens(quem('C_LEVEL'))).toBe(true);
    expect(podeConfigurarPassagens(quem('LIDER_COMERCIAL'))).toBe(false);
    expect(podeConfigurarRodizio(quem('LIDER_COMERCIAL'), 'COMERCIAL')).toBe(
      true,
    );
    expect(podeConfigurarRodizio(quem('LIDER_COMERCIAL'), 'CS')).toBe(false);
    expect(podeConfigurarRodizio(quem('CS'), 'CS')).toBe(false);
  });

  it('R5.8 — atua no setor: diretoria ou alguém do setor (rodízio de contatos)', () => {
    expect(atuaNoSetor(quem('ADMIN'), 'CS')).toBe(true);
    expect(atuaNoSetor(quem('LIDER_CS'), 'CS')).toBe(true);
    expect(atuaNoSetor(quem('CS'), 'CS')).toBe(true);
    expect(atuaNoSetor(quem('COMERCIAL'), 'CS')).toBe(false);
  });
});
