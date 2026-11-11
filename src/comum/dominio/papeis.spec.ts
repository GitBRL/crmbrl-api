import { pessoa } from './papeis-antigos.apoio-spec';
import {
  ehDiretoria,
  ehDoSetor,
  ehLider,
  ehLiderDoSetor,
  ehMembro,
  ehMembroDoSetor,
  liderEsperado,
  nivelDoPapel,
  papelTemSetor,
  podeLiderar,
  rotuloDoPapel,
  setorDaPessoa,
  TODOS_OS_PAPEIS,
} from './papeis';
import { areasVisiveis, permissoesDoPapel } from './permissoes';
import { gerarChaveDoSetor, nomeDoSetor, nomeNormalizado } from './setores';

describe('papéis e hierarquia (R1)', () => {
  it('cada papel tem o nível da tabela da seção 1; só Líder e Membro têm setor', () => {
    expect(
      TODOS_OS_PAPEIS.map((papel) => [
        papel,
        nivelDoPapel(papel),
        papelTemSetor(papel),
      ]),
    ).toEqual([
      ['ADMIN', 'ADMINISTRADOR', false],
      ['C_LEVEL', 'DIRETORIA', false],
      ['LIDER', 'LIDER', true],
      ['MEMBRO', 'MEMBRO', true],
    ]);
  });

  it('R1.2 — membro responde ao líder do mesmo setor; líder, ao C-level; Admin e C-level não têm líder', () => {
    expect(liderEsperado(pessoa('COMERCIAL'))).toEqual({
      papel: 'LIDER',
      area: 'COMERCIAL',
    });
    expect(liderEsperado({ papel: 'MEMBRO', area: 'POS_VENDA' })).toEqual({
      papel: 'LIDER',
      area: 'POS_VENDA',
    });
    expect(liderEsperado(pessoa('LIDER_CS'))).toEqual({
      papel: 'C_LEVEL',
      area: null,
    });
    expect(liderEsperado(pessoa('ADMIN'))).toBeNull();
    expect(liderEsperado(pessoa('C_LEVEL'))).toBeNull();
    expect(podeLiderar(pessoa('LIDER_COMERCIAL'), pessoa('COMERCIAL'))).toBe(
      true,
    );
    expect(podeLiderar(pessoa('LIDER_MARKETING'), pessoa('COMERCIAL'))).toBe(
      false,
    );
    expect(podeLiderar(pessoa('C_LEVEL'), pessoa('COMERCIAL'))).toBe(false);
    expect(podeLiderar(pessoa('C_LEVEL'), pessoa('LIDER_MARKETING'))).toBe(
      true,
    );
    expect(
      podeLiderar(
        { papel: 'LIDER', area: 'POS_VENDA' },
        { papel: 'MEMBRO', area: 'POS_VENDA' },
      ),
    ).toBe(true);
  });

  it('classifica papéis e setores', () => {
    expect(ehDiretoria('ADMIN') && ehDiretoria('C_LEVEL')).toBe(true);
    expect(ehDiretoria('LIDER')).toBe(false);
    expect(ehLider('LIDER')).toBe(true);
    expect(ehLider('MEMBRO')).toBe(false);
    expect(ehMembro('MEMBRO')).toBe(true);
    expect(ehDoSetor(pessoa('LIDER_CS'), 'CS')).toBe(true);
    expect(ehDoSetor(pessoa('CS'), 'COMERCIAL')).toBe(false);
    expect(ehDoSetor(pessoa('C_LEVEL'), 'CS')).toBe(false);
    expect(ehLiderDoSetor(pessoa('LIDER_CS'), 'CS')).toBe(true);
    expect(ehLiderDoSetor(pessoa('CS'), 'CS')).toBe(false);
    expect(ehMembroDoSetor(pessoa('CS'), 'CS')).toBe(true);
    // Admin e C-level não têm setor, mesmo que um dado venha errado.
    expect(setorDaPessoa({ papel: 'ADMIN', area: 'CS' })).toBeNull();
    expect(setorDaPessoa(pessoa('MARKETING'))).toBe('MARKETING');
  });

  it('rótulos: "Líder " + nome do setor; membro, o nome do setor; Admin; C-level', () => {
    expect(rotuloDoPapel('LIDER', 'COMERCIAL')).toBe('Líder Comercial');
    expect(rotuloDoPapel('MEMBRO', 'CS')).toBe('Customer Success');
    expect(rotuloDoPapel('ADMIN')).toBe('Admin');
    expect(rotuloDoPapel('C_LEVEL', null)).toBe('C-level');
    // Setor ainda não conhecido pelo registro de nomes: a chave.
    expect(nomeDoSetor('NAO_CARREGADO')).toBe('NAO_CARREGADO');
  });
});

describe('setores (R1.6, R1.8)', () => {
  it('R1.8 — a chave sai do nome: maiúsculas, sem acento, _ no lugar de símbolos, até 40', () => {
    expect(gerarChaveDoSetor('Pós-venda', new Set())).toBe('POS_VENDA');
    expect(gerarChaveDoSetor('  Suporte técnico & TI ', new Set())).toBe(
      'SUPORTE_TECNICO_TI',
    );
    expect(gerarChaveDoSetor('???', new Set())).toBe('SETOR');
    expect(gerarChaveDoSetor('a'.repeat(60), new Set())).toHaveLength(40);
  });

  it('R1.8 — chave repetida (ou reservada dos filtros) ganha _2, _3…', () => {
    expect(gerarChaveDoSetor('Comercial', new Set(['COMERCIAL']))).toBe(
      'COMERCIAL_2',
    );
    expect(
      gerarChaveDoSetor('Comercial', new Set(['COMERCIAL', 'COMERCIAL_2'])),
    ).toBe('COMERCIAL_3');
    expect(gerarChaveDoSetor('Global', new Set())).toBe('GLOBAL_2');
    const longa = 'b'.repeat(40);
    const chave = gerarChaveDoSetor(longa, new Set([longa.toUpperCase()]));
    expect(chave).toHaveLength(40);
    expect(chave.endsWith('_2')).toBe(true);
  });

  it('R1.8 — o nome é comparado sem maiúsculas nem acentos', () => {
    expect(nomeNormalizado('  Pós   Venda ')).toBe(
      nomeNormalizado('pos venda'),
    );
  });
});

describe('permissões derivadas (matriz da seção 12)', () => {
  it('Admin: tudo, inclusive usuários, webhooks, auditoria, logs e anonimização', () => {
    expect(permissoesDoPapel('ADMIN')).toEqual({
      gerenciarUsuarios: true,
      verUsuarios: 'TODOS',
      configurarFunis: 'TODOS',
      verNegocios: 'TODOS',
      reabrirNegocios: 'TODOS',
      verContatos: true,
      editarContatos: 'TODOS',
      importarContatos: true,
      anonimizarContatos: true,
      verAtividades: 'TODOS',
      configurarPassagens: true,
      configurarRodizio: 'TODOS',
      gerenciarWebhooks: true,
      verAuditoria: true,
      verLogsTecnicos: true,
      verDocumentacaoApi: true,
    });
  });

  it('C-level: vê e configura tudo, mas não gerencia usuários, webhooks nem logs', () => {
    expect(permissoesDoPapel('C_LEVEL')).toMatchObject({
      gerenciarUsuarios: false,
      verUsuarios: 'TODOS',
      configurarPassagens: true,
      reabrirNegocios: 'TODOS',
      anonimizarContatos: false,
      gerenciarWebhooks: false,
      verAuditoria: true,
      verLogsTecnicos: false,
    });
  });

  it('líder: o próprio setor e a equipe', () => {
    expect(permissoesDoPapel('LIDER')).toMatchObject({
      verUsuarios: 'EQUIPE',
      configurarFunis: 'AREA',
      verNegocios: 'AREA',
      reabrirNegocios: 'AREA',
      editarContatos: 'EQUIPE',
      verAtividades: 'EQUIPE',
      configurarPassagens: false,
      configurarRodizio: 'AREA',
      verAuditoria: false,
    });
  });

  it('membro: só o que é dele (e os negócios sem responsável do setor)', () => {
    expect(permissoesDoPapel('MEMBRO')).toMatchObject({
      verUsuarios: 'PROPRIOS',
      configurarFunis: 'NENHUM',
      verNegocios: 'PROPRIOS',
      reabrirNegocios: 'NENHUM',
      verContatos: true,
      editarContatos: 'PROPRIOS',
      verAtividades: 'PROPRIOS',
      configurarRodizio: 'NENHUM',
    });
  });

  it('R5.9 — setores visíveis: Admin e C-level, todos os ativos; Líder e Membro, o seu', () => {
    const ativos = ['MARKETING', 'COMERCIAL', 'CS', 'POS_VENDA'];
    expect(areasVisiveis(pessoa('ADMIN'), ativos)).toEqual(ativos);
    expect(areasVisiveis(pessoa('C_LEVEL'), ativos)).toEqual(ativos);
    expect(areasVisiveis(pessoa('LIDER_COMERCIAL'), ativos)).toEqual([
      'COMERCIAL',
    ]);
    expect(
      areasVisiveis({ papel: 'MEMBRO', area: 'POS_VENDA' }, ativos),
    ).toEqual(['POS_VENDA']);
  });
});

describe('permissão de importação (R16.1)', () => {
  it('R16.1 — Admin, C-level e líderes importam; membros não', () => {
    for (const papel of ['ADMIN', 'C_LEVEL', 'LIDER'] as const) {
      expect(permissoesDoPapel(papel).importarContatos).toBe(true);
    }
    expect(permissoesDoPapel('MEMBRO').importarContatos).toBe(false);
  });
});
