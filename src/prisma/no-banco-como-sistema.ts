import { executarComoSistemaNoBanco } from '../comum/contexto/contexto-requisicao';

/**
 * R35.2: o método fala com o banco como sistema (a RLS não recorta), sem
 * trocar o ator da auditoria. Para as peças internas que a API chama **depois**
 * de autorizar a ação e que precisam enxergar além de quem pediu — o motor do
 * Atendimento (distribuir pela carga de todos, avisar, contar para os outros),
 * conferências feitas para outra pessoa.
 */
export function NoBancoComoSistema(): MethodDecorator {
  return (_alvo, _chave, descritor: PropertyDescriptor) => {
    const original = descritor.value as (...argumentos: unknown[]) => unknown;
    descritor.value = function (this: unknown, ...argumentos: unknown[]) {
      return executarComoSistemaNoBanco(() => original.apply(this, argumentos));
    };
    return descritor;
  };
}
