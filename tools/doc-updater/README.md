# doc-updater

Atualiza a documentação de código e arquitetura **deste projeto** e registra, a cada
execução, o que mudou desde a anterior.

Sem dependências: só Node (>= 20) e `git` no PATH. Tudo vive dentro do repositório.

## Uso

O atalho é o script `docs` do `package.json`:

```bash
# npm — as flags vão depois de `--`
npm run docs
npm run docs -- --nota "CRUD de leads com paginação"
npm run docs -- --dry-run

# bun — as flags vão direto
bun run docs
bun run docs --nota "CRUD de leads com paginação"
bun run docs --dry-run
```

Sem passar pelo gerenciador de pacotes dá na mesma:

```bash
node tools/doc-updater/index.mjs --nota "CRUD de leads com paginação"
```

Pelo Claude Code, com a sessão aberta na raiz deste projeto:
`/atualizar-docs <resumo do que foi feito>` — roda a ferramenta e ainda preenche as
seções narrativas que o script não tem como inferir.

### Opções

| Opção | Efeito |
| --- | --- |
| `-n, --nota "<texto>"` | Texto do "o que foi feito" gravado no histórico |
| `-d, --desde <ref>` | Commit/tag inicial do diff (padrão: o último documentado) |
| `--dry-run` | Mostra o que mudaria sem gravar |
| `--json` | Imprime o inventário completo em JSON no stdout |
| `-h, --ajuda` | Ajuda |

## O que ele gera

```
docs/ARQUITETURA.md       inventário técnico + topologia
docs/HISTORICO.md         o que foi feito, uma entrada por execução
docs/.estado-docs.json    base de comparação da próxima execução
```

## Texto gerado × texto escrito à mão

O trecho entre os marcadores é reescrito a cada execução:

```markdown
<!-- doc-updater:inicio — gerado automaticamente, nao edite a mao -->
...tabelas de módulos, endpoints/componentes, rotas, scripts, dependências...
<!-- doc-updater:fim -->
```

Tudo fora dos marcadores — *Contexto* e *Decisões de arquitetura* — é preservado.
Escreva ali à vontade.

O arquivo só é reescrito quando o conteúdo gerado muda de fato; o carimbo de data
sozinho não gera diff, para não poluir o `git log`.

## Como o "o que foi feito" é apurado

A cada execução o inventário atual é comparado com o `docs/.estado-docs.json` da
execução anterior. A entrada do histórico reúne:

- **commits novos** desde o commit documentado da última vez, com autor e data;
- **arquivos alterados** no intervalo, com `+adições/-remoções`;
- **impacto na arquitetura** — módulos, controllers, serviços, componentes, pipes,
  diretivas, endpoints HTTP, rotas de tela, testes, variáveis de ambiente,
  dependências e scripts que entraram (`+`), saíram (`−`) ou mudaram de versão (`~`);
- **métricas** de arquivos e linhas, com delta.

Ou seja: mesmo sem nota nenhuma, o histórico mostra o que mudou na prática.

## O que o scanner reconhece

| Origem | Extraído |
| --- | --- |
| `package.json` | framework, versão, scripts, dependências, gerenciador |
| NestJS | `@Module`, `@Controller` (com prefixo), `@Get/@Post/@Put/@Patch/@Delete`, `@Injectable` |
| Angular | `@Component` (seletor/template), `@Directive`, `@Pipe`, `@Injectable`, rotas de `*.routes.ts` com guardas |
| Qualquer `.ts` | chamadas `HttpClient`/`fetch`, `process.env.X`, `configService.get('x')` |
| git | branch, HEAD, remoto, commits e diffstat do intervalo |

A leitura é por regex sobre o fonte — rápida e sem build, mas literal: decorador
montado dinamicamente ou rota construída em runtime não aparece. O que o scanner não
vê, escreva nas seções à mão.

Ficam fora do inventário: `node_modules`, `dist`, `coverage`, pastas ocultas, a pasta
`docs/` e a própria `tools/doc-updater/`.
