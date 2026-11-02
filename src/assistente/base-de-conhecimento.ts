/**
 * Base de conhecimento do assistente (R25): os artigos `docs/ajuda/*.md`,
 * lidos uma vez na subida da API (na imagem Docker ficam em
 * `/app/docs/ajuda`). Viram um único bloco do prompt de sistema, em ordem
 * alfabética e byte a byte igual entre as perguntas (é o prefixo em cache).
 */
import { join, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type BaseLida, lerBaseDeConhecimento } from './ler-base';

export type { ArtigoLido, BaseLida } from './ler-base';

export interface OpcoesAssistente {
  /** Pasta dos artigos (padrão: `docs/ajuda` a partir do diretório da API). */
  diretorioAjuda: string;
}

export const OPCOES_ASSISTENTE = Symbol('OPCOES_ASSISTENTE');

export const OPCOES_ASSISTENTE_PADRAO: OpcoesAssistente = {
  diretorioAjuda: join(process.cwd(), 'docs', 'ajuda'),
};

/** A base lida na subida, compartilhada por todas as perguntas. */
@Injectable()
export class BaseDeConhecimentoService implements OnModuleInit {
  private readonly log = new Logger('AssistenteIa');
  private base: BaseLida = { artigos: [], texto: '', avisos: [] };

  constructor(
    @Inject(OPCOES_ASSISTENTE) private readonly opcoes: OpcoesAssistente,
  ) {}

  onModuleInit(): void {
    this.recarregar();
  }

  /** Relê a pasta (na subida; também usado pelos testes). */
  recarregar(): BaseLida {
    this.base = lerBaseDeConhecimento(resolve(this.opcoes.diretorioAjuda));
    this.log.log(
      `Base de conhecimento do assistente: ${this.base.artigos.length} artigos`,
    );
    for (const aviso of this.base.avisos) {
      this.log.warn(aviso);
    }
    return this.base;
  }

  atual(): BaseLida {
    return this.base;
  }
}
