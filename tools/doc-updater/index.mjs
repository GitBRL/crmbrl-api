#!/usr/bin/env node
/**
 * doc-updater — atualiza a documentacao de codigo e arquitetura DESTE projeto.
 *
 *   1. escaneia o codigo e monta o inventario tecnico;
 *   2. regrava o miolo gerado de `docs/ARQUITETURA.md` (texto a mao preservado);
 *   3. compara com o estado da ultima execucao e registra o que foi feito em
 *      `docs/HISTORICO.md` (commits novos + impacto na arquitetura);
 *   4. salva o estado em `docs/.estado-docs.json`.
 *
 * Uso: node tools/doc-updater/index.mjs [opcoes]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escanearProjeto, commitsDesde, arquivosAlterados } from './escanear.mjs';
import { compararInventarios, resumirParaEstado } from './comparar.mjs';
import {
  AUTO_INICIO,
  AUTO_FIM,
  renderizarArquitetura,
  mesclarBlocoAuto,
  renderizarEntradaDeHistorico,
  inserirNoHistorico,
} from './gerar.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const NOME = RAIZ.split(/[\\/]/).pop();
// a propria ferramenta nao entra no inventario do projeto
const PROPRIA_PASTA = relative(RAIZ, AQUI).split('\\').join('/');

const PASTA_DOCS = join(RAIZ, 'docs');
const CAMINHO_ESTADO = join(PASTA_DOCS, '.estado-docs.json');
const CAMINHO_ARQUITETURA = join(PASTA_DOCS, 'ARQUITETURA.md');
const CAMINHO_HISTORICO = join(PASTA_DOCS, 'HISTORICO.md');

/* ------------------------------------------------------------------ *
 * Argumentos                                                          *
 * ------------------------------------------------------------------ */

function lerArgumentos(argv) {
  const opcoes = { nota: null, desde: null, simulacao: false, json: false, ajuda: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const proximo = () => argv[++i];
    switch (arg) {
      case '--nota': case '-n': opcoes.nota = proximo(); break;
      case '--desde': case '-d': opcoes.desde = proximo(); break;
      case '--dry-run': case '--simular': opcoes.simulacao = true; break;
      case '--json': opcoes.json = true; break;
      case '--ajuda': case '-h': case '--help': opcoes.ajuda = true; break;
      default:
        if (arg.startsWith('-')) {
          console.error('Opcao desconhecida: ' + arg);
          process.exit(1);
        }
    }
  }
  return opcoes;
}

const AJUDA = `
doc-updater — atualiza a documentacao deste projeto

  node tools/doc-updater/index.mjs [opcoes]

Opcoes
  -n, --nota "<texto>"   descricao do que foi feito, gravada no historico
  -d, --desde <ref>      commit/tag inicial (padrao: o ultimo documentado)
      --dry-run          mostra o que mudaria sem gravar nada
      --json             imprime o inventario em JSON no stdout
  -h, --ajuda            esta mensagem

Exemplos
  node tools/doc-updater/index.mjs
  node tools/doc-updater/index.mjs -n "CRUD de leads com paginacao"
  node tools/doc-updater/index.mjs --desde v1.0.0 --dry-run
`;

/* ------------------------------------------------------------------ *
 * Escrita                                                             *
 * ------------------------------------------------------------------ */

function lerSeExistir(caminho) {
  return existsSync(caminho) ? readFileSync(caminho, 'utf8') : null;
}

function gravar(caminho, conteudo, simulacao, relatorio) {
  const anterior = lerSeExistir(caminho);
  if (anterior === conteudo) {
    relatorio.push({ caminho, acao: 'inalterado' });
    return false;
  }
  if (!simulacao) {
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo, 'utf8');
  }
  relatorio.push({ caminho, acao: anterior === null ? 'criado' : 'atualizado' });
  return true;
}

function semCarimbo(texto) {
  return texto
    .split('\n')
    .filter((linha) => !linha.startsWith('> Atualizado por'))
    .join('\n')
    .trim();
}

/** Miolo gerado de um arquivo, sem a linha de carimbo de data. */
function blocoAutoSemCarimbo(conteudo) {
  if (!conteudo) return null;
  const inicio = conteudo.indexOf(AUTO_INICIO);
  const fim = conteudo.indexOf(AUTO_FIM);
  if (inicio === -1 || fim === -1) return null;
  return semCarimbo(conteudo.slice(inicio + AUTO_INICIO.length, fim));
}

/* ------------------------------------------------------------------ *
 * Execucao                                                            *
 * ------------------------------------------------------------------ */

function main() {
  const opcoes = lerArgumentos(process.argv.slice(2));
  if (opcoes.ajuda) {
    console.log(AJUDA);
    return;
  }

  const agora = new Date();
  const relatorio = [];

  const estado = existsSync(CAMINHO_ESTADO) ? JSON.parse(readFileSync(CAMINHO_ESTADO, 'utf8')) : null;
  const inventario = escanearProjeto(RAIZ, { nome: NOME, ignorar: [PROPRIA_PASTA] });

  const referencia = opcoes.desde ?? estado?.commit ?? null;
  const commits = inventario.git?.repositorio ? commitsDesde(RAIZ, referencia) : [];
  const arquivos = inventario.git?.repositorio ? arquivosAlterados(RAIZ, referencia) : [];
  const mudancas = compararInventarios(estado?.inventario ?? null, inventario);

  // ARQUITETURA.md — so reescreve se o conteudo gerado mudou de fato.
  const corpo = renderizarArquitetura(inventario, agora);
  const existente = lerSeExistir(CAMINHO_ARQUITETURA);
  if (blocoAutoSemCarimbo(existente) !== semCarimbo(corpo)) {
    gravar(CAMINHO_ARQUITETURA, mesclarBlocoAuto(existente, corpo, inventario), opcoes.simulacao, relatorio);
  } else {
    relatorio.push({ caminho: CAMINHO_ARQUITETURA, acao: 'inalterado' });
  }

  // HISTORICO.md — so entra uma entrada nova quando ha algo a contar.
  if (opcoes.nota || commits.length > 0 || mudancas.temMudancas) {
    const entrada = renderizarEntradaDeHistorico({
      inv: inventario,
      commits,
      arquivos,
      mudancas,
      nota: opcoes.nota,
      agora,
    });
    gravar(
      CAMINHO_HISTORICO,
      inserirNoHistorico(lerSeExistir(CAMINHO_HISTORICO), entrada, inventario.nome),
      opcoes.simulacao,
      relatorio,
    );
  } else {
    relatorio.push({ caminho: CAMINHO_HISTORICO, acao: 'inalterado' });
  }

  // O estado so e regravado quando ha o que registrar — assim uma execucao sem
  // novidade nenhuma nao gera diff no repositorio.
  const resumo = resumirParaEstado(inventario);
  const mesmoEstado =
    estado &&
    estado.commit === (inventario.git?.head ?? null) &&
    JSON.stringify(estado.inventario) === JSON.stringify(resumo);
  if (mesmoEstado) {
    relatorio.push({ caminho: CAMINHO_ESTADO, acao: 'inalterado' });
  } else {
    const novoEstado = {
      atualizadoEm: agora.toISOString(),
      commit: inventario.git?.head ?? null,
      commitCurto: inventario.git?.headCurto ?? null,
      inventario: resumo,
    };
    gravar(CAMINHO_ESTADO, JSON.stringify(novoEstado, null, 2) + '\n', opcoes.simulacao, relatorio);
  }

  if (opcoes.json) {
    console.log(JSON.stringify(
      {
        geradoEm: agora.toISOString(),
        projeto: inventario.nome,
        inventario: resumo,
        commits,
        arquivosAlterados: arquivos,
        mudancas,
      },
      null,
      2,
    ));
    return;
  }

  const estruturais = mudancas.itens.reduce(
    (acc, i) => acc + i.adicionados.length + i.removidos.length + (i.alterados?.length ?? 0),
    0,
  );
  console.log(
    '\ndoc-updater — ' + inventario.nome + ' [' + inventario.framework.nome + ']' +
    (opcoes.simulacao ? '  [simulacao]' : '') +
    '\n  arquivos: ' + inventario.totalDeArquivos +
    '  linhas: ' + inventario.linhasDeCodigo +
    '  commits novos: ' + commits.length +
    '  mudancas estruturais: ' + estruturais +
    '\n',
  );
  for (const item of relatorio) {
    console.log('  ' + item.acao.padEnd(11) + relative(RAIZ, item.caminho).split('\\').join('/'));
  }
  console.log('');
}

main();
