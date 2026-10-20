/**
 * escanear.mjs — inventario de codigo e arquitetura deste projeto.
 *
 * Nao depende de nenhum pacote externo: le o fonte com regex e consulta o git
 * via linha de comando. O resultado e um objeto serializavel usado tanto para
 * gerar a documentacao quanto para comparar com o estado anterior.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const PASTAS_IGNORADAS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.angular',
  '.nx', '.cache', '.vscode', '.idea', 'tmp',
  // a propria documentacao gerada nao entra no inventario de codigo
  'docs',
]);

const EXTENSOES_CODIGO = new Set(['.ts', '.tsx', '.js', '.mjs', '.html', '.scss', '.css']);

/** Caminha a arvore devolvendo caminhos relativos a `raiz`, em estilo posix. */
export function listarArquivos(raiz, { ignorar = [] } = {}, dir = raiz, acumulador = []) {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isDirectory() && (entrada.name.startsWith('.') || PASTAS_IGNORADAS.has(entrada.name))) continue;
    const caminho = join(dir, entrada.name);
    const relativo = relative(raiz, caminho).split('\\').join('/');
    if (ignorar.some((alvo) => relativo === alvo || relativo.startsWith(alvo + '/'))) continue;
    if (entrada.isDirectory()) listarArquivos(raiz, { ignorar }, caminho, acumulador);
    else acumulador.push(relativo);
  }
  return acumulador;
}

function lerJson(caminho) {
  if (!existsSync(caminho)) return null;
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Extratores de simbolos                                              *
 * ------------------------------------------------------------------ */

/** Classes anotadas: @Component, @Injectable, @Module, @Controller, etc. */
function extrairClassesDecoradas(conteudo) {
  const achados = [];
  const re =
    /@(Component|Injectable|Directive|Pipe|NgModule|Module|Controller|Catch|Resolver|WebSocketGateway)\(([\s\S]{0,3000}?)\)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    const [, decorador, argumentos, classe] = m;
    achados.push({ decorador, classe, argumentos });
  }
  return achados;
}

function valorDaChave(texto, chave) {
  const m = new RegExp(chave + "\\s*:\\s*['\"`]([^'\"`]+)['\"`]").exec(texto);
  return m ? m[1] : null;
}

function primeiroLiteral(texto) {
  const m = /^\s*['"`]([^'"`]*)['"`]/.exec(texto);
  return m ? m[1] : null;
}

/** Rotas HTTP de um controller NestJS. */
function extrairRotasNest(conteudo, prefixo) {
  const rotas = [];
  const re =
    /@(Get|Post|Put|Patch|Delete|Options|Head|All)\(([^)]*)\)\s*(?:@[\w.]+\([^)]*\)\s*)*(?:async\s+)?(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    const [, metodo, argumentos, handler] = m;
    const sufixo = primeiroLiteral(argumentos) ?? '';
    const caminho = ('/' + [prefixo, sufixo].filter(Boolean).join('/')).replace(/\/+/g, '/');
    rotas.push({ metodo: metodo.toUpperCase(), caminho, handler });
  }
  return rotas;
}

/** Rotas de um arquivo *.routes.ts do Angular. */
function extrairRotasAngular(conteudo) {
  const rotas = [];
  const re = /\{([^{}]*path\s*:[^{}]*)\}/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    const bloco = m[1];
    const caminho = valorDaChave(bloco, 'path');
    if (caminho === null) continue;
    const redirecionamento = valorDaChave(bloco, 'redirectTo');
    const alvo =
      /component\s*:\s*(\w+)/.exec(bloco)?.[1] ??
      /loadComponent\s*:[\s\S]*?import\(\s*['"`]([^'"`]+)/.exec(bloco)?.[1] ??
      /loadChildren\s*:[\s\S]*?import\(\s*['"`]([^'"`]+)/.exec(bloco)?.[1] ??
      (redirecionamento ? 'redireciona para ' + redirecionamento : '—');
    const guardas = /canActivate\s*:\s*\[([^\]]*)\]/.exec(bloco)?.[1]?.trim() ?? '';
    rotas.push({ caminho: caminho === '' ? '(raiz)' : caminho, alvo, guardas });
  }
  return rotas;
}

/** URLs chamadas via HttpClient / fetch — o contrato com o outro lado. */
function extrairChamadasHttp(conteudo) {
  const chamadas = [];
  const re = /\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*([`'"])([^`'"]+)\2/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) {
    chamadas.push({ metodo: m[1].toUpperCase(), url: m[3] });
  }
  const reFetch = /fetch\(\s*([`'"])([^`'"]+)\1/g;
  while ((m = reFetch.exec(conteudo)) !== null) {
    chamadas.push({ metodo: 'FETCH', url: m[2] });
  }
  return chamadas;
}

/** Variaveis de ambiente lidas no codigo. */
function extrairVariaveisDeAmbiente(conteudo) {
  const nomes = new Set();
  const re = /process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g;
  let m;
  while ((m = re.exec(conteudo)) !== null) nomes.add(m[1] ?? m[2]);
  const reConfig = /configService\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g;
  while ((m = reConfig.exec(conteudo)) !== null) nomes.add(m[1]);
  return [...nomes];
}

/* ------------------------------------------------------------------ *
 * Escaneamento                                                        *
 * ------------------------------------------------------------------ */

function detectarFramework(pacote) {
  const deps = { ...(pacote?.dependencies ?? {}), ...(pacote?.devDependencies ?? {}) };
  if (deps['@nestjs/core']) return { nome: 'NestJS', versao: deps['@nestjs/core'], tipo: 'api' };
  if (deps['@angular/core']) return { nome: 'Angular', versao: deps['@angular/core'], tipo: 'frontend' };
  if (deps['next']) return { nome: 'Next.js', versao: deps['next'], tipo: 'frontend' };
  if (deps['express']) return { nome: 'Express', versao: deps['express'], tipo: 'api' };
  return { nome: 'Node.js', versao: null, tipo: 'desconhecido' };
}

export function escanearProjeto(diretorio, opcoes = {}) {
  const { ignorar = [], nome = diretorio.split(/[\\/]/).pop() } = opcoes;
  const pacote = lerJson(join(diretorio, 'package.json'));
  const framework = detectarFramework(pacote);
  const arquivos = existsSync(diretorio) ? listarArquivos(diretorio, { ignorar }) : [];

  const inventario = {
    nome,
    diretorio,
    versao: pacote?.version ?? null,
    framework,
    gerenciadorDePacotes: existsSync(join(diretorio, 'bun.lock'))
      ? 'bun'
      : existsSync(join(diretorio, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : 'npm',
    scripts: pacote?.scripts ?? {},
    dependencias: pacote?.dependencies ?? {},
    dependenciasDev: pacote?.devDependencies ?? {},
    totalDeArquivos: arquivos.length,
    linhasDeCodigo: 0,
    porExtensao: {},
    modulos: [],
    controllers: [],
    servicos: [],
    componentes: [],
    diretivas: [],
    pipes: [],
    rotasHttp: [],
    rotasFront: [],
    chamadasHttp: [],
    variaveisDeAmbiente: [],
    testes: [],
    arquivos,
  };

  const variaveis = new Set();

  for (const arquivoRelativo of arquivos) {
    const ext = extname(arquivoRelativo);
    inventario.porExtensao[ext] = (inventario.porExtensao[ext] ?? 0) + 1;
    if (!EXTENSOES_CODIGO.has(ext)) continue;

    const conteudo = readFileSync(join(diretorio, arquivoRelativo), 'utf8');
    inventario.linhasDeCodigo += conteudo.split('\n').length;

    const ehTeste = /\.(spec|test|e2e-spec)\.(ts|js)$/.test(arquivoRelativo);
    if (ehTeste) inventario.testes.push(arquivoRelativo);
    if (ext !== '.ts') continue;

    for (const nomeVar of extrairVariaveisDeAmbiente(conteudo)) variaveis.add(nomeVar);

    for (const chamada of ehTeste ? [] : extrairChamadasHttp(conteudo)) {
      if (/^(https?:|\/|\$\{)/.test(chamada.url)) {
        inventario.chamadasHttp.push({ ...chamada, arquivo: arquivoRelativo });
      }
    }
    if (/\.routes\.ts$/.test(arquivoRelativo) || /:\s*Routes\s*=/.test(conteudo)) {
      for (const rota of extrairRotasAngular(conteudo)) {
        inventario.rotasFront.push({ ...rota, arquivo: arquivoRelativo });
      }
    }

    for (const { decorador, classe, argumentos } of extrairClassesDecoradas(conteudo)) {
      const base = { classe, arquivo: arquivoRelativo };
      switch (decorador) {
        case 'Module':
        case 'NgModule':
          inventario.modulos.push(base);
          break;
        case 'Controller': {
          const prefixo = primeiroLiteral(argumentos) ?? '';
          inventario.controllers.push({ ...base, prefixo });
          for (const rota of extrairRotasNest(conteudo, prefixo)) {
            inventario.rotasHttp.push({ ...rota, controller: classe, arquivo: arquivoRelativo });
          }
          break;
        }
        case 'Injectable':
          inventario.servicos.push(base);
          break;
        case 'Component':
          inventario.componentes.push({
            ...base,
            seletor: valorDaChave(argumentos, 'selector'),
            template: valorDaChave(argumentos, 'templateUrl') ?? 'inline',
          });
          break;
        case 'Directive':
          inventario.diretivas.push({ ...base, seletor: valorDaChave(argumentos, 'selector') });
          break;
        case 'Pipe':
          inventario.pipes.push({ ...base, nomeDoPipe: valorDaChave(argumentos, 'name') });
          break;
        default:
          break;
      }
    }
  }

  inventario.variaveisDeAmbiente = [...variaveis].sort();
  inventario.git = escanearGit(diretorio);
  return inventario;
}

export function escanearGit(diretorio) {
  const head = git(diretorio, ['rev-parse', 'HEAD']);
  if (!head) return { repositorio: false };
  return {
    repositorio: true,
    head,
    headCurto: head.slice(0, 7),
    branch: git(diretorio, ['rev-parse', '--abbrev-ref', 'HEAD']),
    remoto: git(diretorio, ['config', '--get', 'remote.origin.url']) || null,
    sujo: git(diretorio, ['status', '--porcelain']).length > 0,
    totalDeCommits: Number(git(diretorio, ['rev-list', '--count', 'HEAD']) || 0),
  };
}

/** Commits entre `desde` (exclusivo) e HEAD. Sem `desde`, pega os ultimos 20. */
export function commitsDesde(diretorio, desde) {
  const formato = '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s';
  const bruto = desde
    ? git(diretorio, ['log', desde + '..HEAD', formato])
    : git(diretorio, ['log', '-20', formato]);
  if (!bruto) return [];
  return bruto.split('\n').filter(Boolean).map((linha) => {
    const [hash, curto, autor, data, assunto] = linha.split('\x1f');
    return { hash, curto, autor, data, assunto };
  });
}

/** Arquivos alterados entre `desde` e HEAD, com contagem de linhas. */
export function arquivosAlterados(diretorio, desde) {
  if (!desde) return [];
  const bruto = git(diretorio, ['diff', '--numstat', desde + '..HEAD']);
  if (!bruto) return [];
  return bruto.split('\n').filter(Boolean).map((linha) => {
    const [adicoes, remocoes, caminho] = linha.split('\t');
    return { caminho, adicoes: Number(adicoes) || 0, remocoes: Number(remocoes) || 0 };
  });
}
