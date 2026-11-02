import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ServicoIndisponivelException } from '../../comum/erros/excecoes';

/** Limite de tamanho do widget compilado (contrato: < 40 KB). */
export const TAMANHO_MAXIMO_DO_WIDGET = 40 * 1024;

/** O script do widget pronto para servir. */
export interface CodigoDoWidget {
  readonly conteudo: string;
  readonly etag: string;
  readonly bytes: number;
}

const NOME_DO_WIDGET = 'widget-do-site';

/**
 * O widget do chat do site (`widget/widget-do-site.ts`), servido pela API em
 * `/api/v1/publico/webchat/widget.js`.
 *
 * O build normal (`nest build`) compila o widget junto com a API, em
 * `dist/canais/webchat/widget/widget-do-site.js`: em produção o arquivo é lido
 * de lá, uma vez. Rodando direto do TypeScript (testes, `ts-node`), o fonte é
 * transpilado na hora com o `typescript` das dependências de desenvolvimento.
 */
@Injectable()
export class WidgetDoSite {
  private readonly logger = new Logger('Webchat');
  private codigo?: CodigoDoWidget;

  obter(): CodigoDoWidget {
    this.codigo ??= this.carregar();
    return this.codigo;
  }

  private carregar(): CodigoDoWidget {
    const pasta = join(__dirname, 'widget');
    const compilado = join(pasta, `${NOME_DO_WIDGET}.js`);
    const fonte = join(pasta, `${NOME_DO_WIDGET}.ts`);
    let conteudo: string;
    if (existsSync(compilado)) {
      conteudo = readFileSync(compilado, 'utf8');
    } else if (existsSync(fonte)) {
      conteudo = transpilarWidget(readFileSync(fonte, 'utf8'));
    } else {
      throw new ServicoIndisponivelException(
        'O widget do chat do site não está disponível nesta instalação.',
      );
    }
    conteudo = embrulharWidget(conteudo);
    const bytes = Buffer.byteLength(conteudo, 'utf8');
    if (bytes > TAMANHO_MAXIMO_DO_WIDGET) {
      this.logger.warn(
        `O widget do chat do site tem ${Math.round(bytes / 1024)} KB (o limite é ${TAMANHO_MAXIMO_DO_WIDGET / 1024} KB).`,
      );
    }
    return {
      conteudo,
      bytes,
      etag: `"${createHash('sha256').update(conteudo).digest('hex').slice(0, 32)}"`,
    };
  }
}

/**
 * O JavaScript do widget pronto para a página: sem o comentário do source map
 * e dentro de uma função com um `exports` local. O build da API emite
 * CommonJS e, com `module: nodenext`, todo arquivo é módulo: o widget
 * compilado começa com `Object.defineProperty(exports, "__esModule", …)`,
 * que quebraria no navegador (não há `exports` lá).
 */
export function embrulharWidget(compilado: string): string {
  const corpo = compilado
    .replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '')
    .replace(/^\s*"use strict";\s*/, '')
    .trim();
  return `/*! BRL CRM — chat do site */\n(function(){"use strict";var exports={};\n${corpo}\n})();\n`;
}

/**
 * Transpila o fonte do widget com as opções do build da API (só fora do
 * build: testes, desenvolvimento) — o resultado é o mesmo do `nest build`.
 */
export function transpilarWidget(fonte: string): string {
  // Dependência de desenvolvimento, carregada só aqui (em produção o .js existe).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const arquivoDeConfiguracao = join(
    __dirname,
    '..',
    '..',
    '..',
    'tsconfig.build.json',
  );
  const configuracao = existsSync(arquivoDeConfiguracao)
    ? ts.getParsedCommandLineOfConfigFile(
        arquivoDeConfiguracao,
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
      )?.options
    : undefined;
  return ts.transpileModule(fonte, {
    compilerOptions: {
      ...(configuracao ?? {
        target: ts.ScriptTarget.ES2022,
        strict: true,
      }),
      removeComments: true,
      sourceMap: false,
      declaration: false,
    },
    fileName: join(__dirname, 'widget', `${NOME_DO_WIDGET}.ts`),
    reportDiagnostics: false,
  }).outputText;
}
