import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * O Swagger (`@nestjs/swagger`) usa o nome da classe como nome do schema no
 * documento OpenAPI: duas classes com o mesmo nome, em módulos diferentes,
 * viram um schema só e uma rota passa a documentar os campos da outra. O
 * contrato com o front é esse documento, então os nomes precisam ser únicos.
 */
describe('Documentação OpenAPI (R11)', () => {
  const raiz = join(__dirname);

  function arquivosDoCodigo(): string[] {
    return readdirSync(raiz, { recursive: true, encoding: 'utf8' })
      .filter(
        (caminho) =>
          caminho.endsWith('.ts') &&
          !caminho.endsWith('.spec.ts') &&
          !caminho.startsWith('generated'),
      )
      .map((caminho) => join(raiz, caminho));
  }

  it('cada classe tem um nome único em src/ (um schema por nome no Swagger)', () => {
    const declaracoes = new Map<string, string[]>();
    for (const arquivo of arquivosDoCodigo()) {
      const texto = readFileSync(arquivo, 'utf8');
      for (const [, nome] of texto.matchAll(
        /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
      )) {
        const onde = declaracoes.get(nome) ?? [];
        onde.push(relative(raiz, arquivo));
        declaracoes.set(nome, onde);
      }
    }
    const repetidas = [...declaracoes.entries()]
      .filter(([, arquivos]) => arquivos.length > 1)
      .map(([nome, arquivos]) => `${nome}: ${arquivos.join(', ')}`);
    expect(repetidas).toEqual([]);
    // Sanidade: a varredura encontrou as classes do projeto.
    expect(declaracoes.has('RespostaErroDto')).toBe(true);
  });
});
