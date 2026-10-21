import type { AuditoriaService } from '../auditoria/auditoria.service';
import {
  DadosInvalidosException,
  RegraVioladaException,
} from '../comum/erros/excecoes';
import type { EventosDominioService } from '../eventos/eventos-dominio.service';
import type { Contato } from '../generated/prisma/client';
import type { NotificacoesService } from '../notificacoes/notificacoes.service';
import type { PrismaService, Tx } from '../prisma/prisma.service';
import { ContatosService } from './contatos.service';
import type { EmpresasService } from './empresas.service';
import type { LinhaDoTempoService } from './linha-do-tempo.service';
import type { PermissoesContatosService } from './permissoes-contatos.service';

const ID_EXISTENTE = '00000000-0000-4000-8000-000000000001';

function contato(dados: Partial<Contato> = {}): Contato {
  const criadoEm = new Date('2026-10-01T12:00:00.000Z');
  return {
    id: ID_EXISTENTE,
    nome: 'Maria Souza',
    email: 'maria@x.com',
    telefone: null,
    cargo: null,
    empresaId: null,
    responsavelId: null,
    primeiraOrigem: 'MANUAL',
    primeiraOrigemDetalhe: null,
    primeiraOrigemUtm: null,
    ultimaOrigem: 'MANUAL',
    ultimaOrigemDetalhe: null,
    ultimaOrigemUtm: null,
    ultimaOrigemEm: criadoEm,
    conversoes: 1,
    etiquetas: [],
    camposPersonalizados: {},
    optOutMarketing: false,
    optOutEm: null,
    consentimentoEm: null,
    consentimentoOrigem: null,
    criadoPorId: null,
    criadoEm,
    atualizadoEm: criadoEm,
    excluidoEm: null,
    ...dados,
  };
}

interface Cenario {
  porEmail?: Contato;
  porTelefone?: Contato;
}

/**
 * Transação falsa: registra a ordem das travas e das consultas e responde as
 * buscas por e-mail/telefone com o cenário.
 */
function transacaoFalsa(cenario: Cenario = {}) {
  const passos: string[] = [];
  const existentes = [cenario.porEmail, cenario.porTelefone].filter(
    (item): item is Contato => item !== undefined,
  );
  const tx = {
    $executeRaw: jest.fn(
      (_sql: TemplateStringsArray, ...valores: unknown[]) => {
        passos.push(`trava:${String(valores[0])}`);
        return Promise.resolve(1);
      },
    ),
    $queryRaw: jest.fn((sql: TemplateStringsArray) => {
      const texto = sql.join('?');
      if (texto.includes('WHERE email')) {
        passos.push('busca:email');
        return Promise.resolve(
          cenario.porEmail ? [{ id: cenario.porEmail.id }] : [],
        );
      }
      if (texto.includes('WHERE telefone')) {
        passos.push('busca:telefone');
        return Promise.resolve(
          cenario.porTelefone ? [{ id: cenario.porTelefone.id }] : [],
        );
      }
      return Promise.resolve([]);
    }),
    contato: {
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(existentes.find((item) => item.id === where.id)),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(({ data }: { data: Partial<Contato> }) => {
        passos.push('criar');
        return Promise.resolve(contato({ ...data, id: 'novo' }));
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Contato>;
        }) => {
          passos.push('atualizar');
          const atual = existentes.find((item) => item.id === where.id);
          return Promise.resolve(
            contato({
              ...atual,
              ...data,
              conversoes: (atual?.conversoes ?? 1) + 1,
            }),
          );
        },
      ),
    },
  };
  return { tx: tx as unknown as Tx, passos, mocks: tx };
}

function servico() {
  const auditoria = { registrar: jest.fn(() => Promise.resolve({})) };
  const eventos = { publicar: jest.fn(() => Promise.resolve({})) };
  const notificacoes = { notificar: jest.fn(() => Promise.resolve({})) };
  const empresas = {
    encontrarOuCriarPorNome: jest.fn(() =>
      Promise.resolve({ empresa: { id: 'empresa-1' }, criada: true }),
    ),
  };
  const permissoes = {
    garantirResponsavelAtivo: jest.fn((_tx: Tx, id: string) =>
      Promise.resolve({ id, nome: 'Responsável' }),
    ),
  };
  const contatos = new ContatosService(
    {} as PrismaService,
    auditoria as unknown as AuditoriaService,
    eventos as unknown as EventosDominioService,
    notificacoes as unknown as NotificacoesService,
    empresas as unknown as EmpresasService,
    permissoes as unknown as PermissoesContatosService,
    {} as LinhaDoTempoService,
  );
  return { contatos, auditoria, eventos, empresas, permissoes };
}

const tiposPublicados = (eventos: { publicar: jest.Mock }) =>
  eventos.publicar.mock.calls.map((chamada: unknown[]) => chamada[1]);
const acoesAuditadas = (auditoria: { registrar: jest.Mock }) =>
  auditoria.registrar.mock.calls.map(
    (chamada: unknown[]) => (chamada[1] as { acao: string }).acao,
  );

describe('ContatosService.encontrarOuCriar (R4.2)', () => {
  it('R4.2 — trava o e-mail e o telefone (nessa ordem) antes de procurar', async () => {
    const { contatos } = servico();
    const { tx, passos } = transacaoFalsa();
    await contatos.encontrarOuCriar(tx, {
      nome: 'Maria',
      email: 'MARIA@x.com',
      telefone: '(11) 98765-4321',
      origem: 'WEBHOOK',
    });
    expect(passos).toEqual([
      'trava:contato-email:maria@x.com',
      'trava:contato-telefone:5511987654321',
      'busca:email',
      'busca:telefone',
      'criar',
    ]);
  });

  it('R4.2/R4.3 — sem ninguém com o e-mail ou o telefone, cria com primeira e última origem iguais', async () => {
    const { contatos, auditoria, eventos } = servico();
    const { tx, mocks } = transacaoFalsa();
    const resultado = await contatos.encontrarOuCriar(tx, {
      nome: 'Maria',
      email: 'maria@x.com',
      origem: 'WEBHOOK',
      origemDetalhe: 'Landing',
      utm: { source: 'google' },
      empresaNome: 'ACME',
    });
    expect(resultado.criado).toBe(true);
    expect(mocks.contato.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        primeiraOrigem: 'WEBHOOK',
        primeiraOrigemDetalhe: 'Landing',
        primeiraOrigemUtm: { source: 'google' },
        ultimaOrigem: 'WEBHOOK',
        ultimaOrigemDetalhe: 'Landing',
        ultimaOrigemUtm: { source: 'google' },
        conversoes: 1,
        empresaId: 'empresa-1',
        responsavelId: null,
      }),
    });
    expect(acoesAuditadas(auditoria)).toEqual(['contato.criado']);
    expect(tiposPublicados(eventos)).toEqual(['contato.criado']);
  });

  it('R4.2 — com o mesmo e-mail, reconverte em vez de criar', async () => {
    const { contatos, auditoria, eventos } = servico();
    const existente = contato({ cargo: 'CEO' });
    const { tx, passos, mocks } = transacaoFalsa({ porEmail: existente });
    const resultado = await contatos.encontrarOuCriar(tx, {
      nome: 'Outro nome',
      email: 'maria@x.com',
      telefone: '11 98765-4321',
      cargo: 'Estagiária',
      origem: 'WEBHOOK',
    });
    expect(resultado.criado).toBe(false);
    expect(passos).not.toContain('criar');
    expect(passos).not.toContain('busca:telefone');
    const { data } = mocks.contato.update.mock.calls[0][0];
    expect(data).toMatchObject({
      telefone: '5511987654321',
      ultimaOrigem: 'WEBHOOK',
      conversoes: { increment: 1 },
    });
    expect(data).not.toHaveProperty('nome');
    expect(data).not.toHaveProperty('cargo');
    expect(acoesAuditadas(auditoria)).toEqual(['contato.reconvertido']);
    expect(tiposPublicados(eventos)).toEqual([
      'contato.reconvertido',
      'contato.atualizado',
    ]);
  });

  it('R4.2 — sem e-mail conhecido, procura pelo telefone normalizado', async () => {
    const { contatos } = servico();
    const existente = contato({ email: null, telefone: '5511987654321' });
    const { tx, passos } = transacaoFalsa({ porTelefone: existente });
    const resultado = await contatos.encontrarOuCriar(tx, {
      nome: 'Maria',
      email: 'nova@x.com',
      telefone: '+55 (11) 98765-4321',
      origem: 'WHATSAPP',
    });
    expect(resultado.criado).toBe(false);
    expect(passos).toEqual([
      'trava:contato-email:nova@x.com',
      'trava:contato-telefone:5511987654321',
      'busca:email',
      'busca:telefone',
      'atualizar',
    ]);
  });

  it('R4.1 — entrada sem meio de contato é recusada antes de tocar no banco', async () => {
    const { contatos } = servico();
    const { tx, passos } = transacaoFalsa();
    await expect(
      contatos.encontrarOuCriar(tx, { nome: 'Sem contato', origem: 'WEBHOOK' }),
    ).rejects.toBeInstanceOf(DadosInvalidosException);
    expect(passos).toEqual([]);
  });

  it('R4.5 — o responsável informado precisa estar ativo', async () => {
    const { contatos, permissoes } = servico();
    permissoes.garantirResponsavelAtivo.mockRejectedValueOnce(
      new RegraVioladaException(
        'R4.5',
        'O responsável precisa ser um usuário ativo.',
      ),
    );
    const { tx, passos } = transacaoFalsa();
    await expect(
      contatos.encontrarOuCriar(tx, {
        nome: 'Maria',
        email: 'maria@x.com',
        origem: 'WEBHOOK',
        responsavelId: '00000000-0000-4000-8000-0000000000a1',
      }),
    ).rejects.toMatchObject({ regra: 'R4.5' });
    expect(passos).not.toContain('criar');
  });
});
