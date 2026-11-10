import { papelESetor as comPapel } from '../dominio/papeis-antigos.apoio-spec';
import { idDaRequisicao } from '../../logs/requisicao.middleware';
import {
  contextoAtual,
  definirUsuarioDoContexto,
  executarComContexto,
  executarComoAtor,
  haContexto,
} from './contexto-requisicao';

describe('contexto da requisição (AsyncLocalStorage)', () => {
  it('fora de contexto devolve SISTEMA com um id novo', () => {
    expect(haContexto()).toBe(false);
    const contexto = contextoAtual();
    expect(contexto.tipoAtor).toBe('SISTEMA');
    expect(contexto.requisicaoId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('o contexto atravessa awaits e o usuário definido no meio fica visível para todos', async () => {
    const contexto = { requisicaoId: 'r1', tipoAtor: 'USUARIO' as const };
    await executarComContexto(contexto, async () => {
      await Promise.resolve();
      // Como no SessaoGuard: define o usuário depois de um await.
      await (async () => {
        await new Promise((resolver) => setTimeout(resolver, 1));
        definirUsuarioDoContexto(
          { id: 'u1', ...comPapel('CS'), nome: 'Carla' },
          's1',
        );
      })();
      expect(contextoAtual()).toMatchObject({
        requisicaoId: 'r1',
        tipoAtor: 'USUARIO',
        usuario: { id: 'u1' },
        sessaoId: 's1',
        atorDescricao: 'Carla',
      });
    });
    expect(contexto).toMatchObject({ usuario: { id: 'u1' } });
  });

  it('executarComoAtor troca o ator e mantém o id da requisição', async () => {
    await executarComContexto(
      { requisicaoId: 'r2', ip: '1.2.3.4', tipoAtor: 'USUARIO' },
      () =>
        executarComoAtor(
          { tipoAtor: 'WEBHOOK', descricao: 'Landing' },
          async () => {
            await Promise.resolve();
            expect(contextoAtual()).toEqual({
              requisicaoId: 'r2',
              ip: '1.2.3.4',
              userAgent: undefined,
              tipoAtor: 'WEBHOOK',
              usuario: undefined,
              atorDescricao: 'Landing',
            });
          },
        ),
    );
    const id = executarComoAtor(
      { tipoAtor: 'SISTEMA' },
      () => contextoAtual().requisicaoId,
      'job-1',
    );
    expect(id).toBe('job-1');
  });
});

describe('X-Request-Id (R3.7)', () => {
  it('aceita um id curto e seguro, senão gera outro', () => {
    expect(idDaRequisicao('abc-123_x.y:z')).toBe('abc-123_x.y:z');
    expect(idDaRequisicao(['primeiro', 'segundo'])).toBe('primeiro');
    expect(idDaRequisicao(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(idDaRequisicao('com espaço')).toMatch(/^[0-9a-f-]{36}$/);
    expect(idDaRequisicao('x'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
