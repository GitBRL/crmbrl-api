import {
  areaDoPapel,
  ehDiretoria,
  ehLider,
  ehMembro,
  liderDaArea,
  liderEsperado,
  membroDaArea,
  nivelDoPapel,
  papeisDaArea,
  podeLiderar,
  rotuloDoPapel,
  TODOS_OS_PAPEIS,
} from './papeis';
import { permissoesDoPapel } from './permissoes';

describe('papéis e hierarquia (R1)', () => {
  it('cada papel tem área e nível da tabela da seção 1', () => {
    expect(
      TODOS_OS_PAPEIS.map((papel) => [
        papel,
        areaDoPapel(papel),
        nivelDoPapel(papel),
      ]),
    ).toEqual([
      ['ADMIN', null, 'ADMINISTRADOR'],
      ['C_LEVEL', null, 'DIRETORIA'],
      ['LIDER_COMERCIAL', 'COMERCIAL', 'LIDER'],
      ['COMERCIAL', 'COMERCIAL', 'MEMBRO'],
      ['LIDER_MARKETING', 'MARKETING', 'LIDER'],
      ['MARKETING', 'MARKETING', 'MEMBRO'],
      ['LIDER_CS', 'CS', 'LIDER'],
      ['CS', 'CS', 'MEMBRO'],
    ]);
  });

  it('R1.2 — membro responde ao líder da mesma área; líder, ao C-level; Admin e C-level não têm líder', () => {
    expect(liderEsperado('COMERCIAL')).toBe('LIDER_COMERCIAL');
    expect(liderEsperado('MARKETING')).toBe('LIDER_MARKETING');
    expect(liderEsperado('CS')).toBe('LIDER_CS');
    expect(liderEsperado('LIDER_CS')).toBe('C_LEVEL');
    expect(liderEsperado('ADMIN')).toBeNull();
    expect(liderEsperado('C_LEVEL')).toBeNull();
    expect(podeLiderar('LIDER_COMERCIAL', 'COMERCIAL')).toBe(true);
    expect(podeLiderar('LIDER_MARKETING', 'COMERCIAL')).toBe(false);
    expect(podeLiderar('C_LEVEL', 'COMERCIAL')).toBe(false);
    expect(podeLiderar('C_LEVEL', 'LIDER_MARKETING')).toBe(true);
  });

  it('classifica e relaciona papéis e áreas', () => {
    expect(ehDiretoria('ADMIN') && ehDiretoria('C_LEVEL')).toBe(true);
    expect(ehDiretoria('LIDER_CS')).toBe(false);
    expect(ehLider('LIDER_MARKETING')).toBe(true);
    expect(ehLider('MARKETING')).toBe(false);
    expect(ehMembro('CS')).toBe(true);
    expect(liderDaArea('COMERCIAL')).toBe('LIDER_COMERCIAL');
    expect(membroDaArea('CS')).toBe('CS');
    expect(papeisDaArea('MARKETING')).toEqual(['LIDER_MARKETING', 'MARKETING']);
    expect(rotuloDoPapel('LIDER_COMERCIAL')).toBe('Líder Comercial');
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
      anonimizarContatos: true,
      verAtividades: 'TODOS',
      configurarPassagens: true,
      configurarRodizio: 'TODOS',
      gerenciarWebhooks: true,
      verAuditoria: true,
      verLogsTecnicos: true,
      verDocumentacaoApi: true,
      areasVisiveis: ['MARKETING', 'COMERCIAL', 'CS'],
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

  it('líder: a própria área e a equipe', () => {
    expect(permissoesDoPapel('LIDER_COMERCIAL')).toMatchObject({
      verUsuarios: 'EQUIPE',
      configurarFunis: 'AREA',
      verNegocios: 'AREA',
      reabrirNegocios: 'AREA',
      editarContatos: 'EQUIPE',
      verAtividades: 'EQUIPE',
      configurarPassagens: false,
      configurarRodizio: 'AREA',
      verAuditoria: false,
      areasVisiveis: ['COMERCIAL'],
    });
  });

  it('membro: só o que é dele (e os negócios sem responsável da área)', () => {
    expect(permissoesDoPapel('MARKETING')).toMatchObject({
      verUsuarios: 'PROPRIOS',
      configurarFunis: 'NENHUM',
      verNegocios: 'PROPRIOS',
      reabrirNegocios: 'NENHUM',
      verContatos: true,
      editarContatos: 'PROPRIOS',
      verAtividades: 'PROPRIOS',
      configurarRodizio: 'NENHUM',
      areasVisiveis: ['MARKETING'],
    });
  });
});
