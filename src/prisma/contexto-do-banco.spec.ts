import {
  executarComContexto,
  executarComoAtor,
  executarComoSistemaNoBanco,
} from '../comum/contexto/contexto-requisicao';
import { ATOR_SISTEMA, atorDoBanco } from './contexto-do-banco';

const usuario = {
  id: '6d1f0b8e-0000-4000-8000-000000000001',
  papel: 'MEMBRO' as const,
  nome: 'Ana',
};

describe('ator do banco (R35.2)', () => {
  it('fora de qualquer contexto não há ator (o banco nega)', () => {
    expect(atorDoBanco()).toBe('');
  });

  it('requisição sem login não tem ator; com login, o usuário', () => {
    executarComContexto({ requisicaoId: 'r', tipoAtor: 'USUARIO' }, () => {
      expect(atorDoBanco()).toBe('');
    });
    executarComContexto(
      { requisicaoId: 'r', tipoAtor: 'USUARIO', usuario },
      () => {
        expect(atorDoBanco()).toBe(usuario.id);
      },
    );
  });

  it('jobs, webhooks, automações e IA são sistema (mesmo com o usuário que disparou)', () => {
    for (const tipoAtor of [
      'SISTEMA',
      'WEBHOOK',
      'AUTOMACAO',
      'IA',
      'BOT',
    ] as const) {
      executarComoAtor({ tipoAtor, usuario }, () => {
        expect(atorDoBanco()).toBe(ATOR_SISTEMA);
      });
    }
  });

  it('executarComoSistemaNoBanco eleva só o banco: o ator da auditoria continua o usuário', () => {
    executarComoAtor({ tipoAtor: 'USUARIO', usuario }, () => {
      executarComoSistemaNoBanco(() => {
        expect(atorDoBanco()).toBe(ATOR_SISTEMA);
      });
      expect(atorDoBanco()).toBe(usuario.id);
    });
    executarComoAtor(
      { tipoAtor: 'USUARIO', usuario, bancoComoSistema: true },
      () => {
        expect(atorDoBanco()).toBe(ATOR_SISTEMA);
      },
    );
  });
});
