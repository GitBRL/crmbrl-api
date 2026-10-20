/**
 * gerar.mjs — transforma o inventario em markdown.
 *
 * Tudo que a ferramenta escreve fica entre os marcadores AUTO_INICIO/AUTO_FIM.
 * O texto escrito a mao fora deles nunca e sobrescrito: a cada execucao so o
 * miolo gerado e substituido.
 */

export const AUTO_INICIO = '<!-- doc-updater:inicio — gerado automaticamente, nao edite a mao -->';
export const AUTO_FIM = '<!-- doc-updater:fim -->';
export const MARCADOR_HISTORICO = '<!-- doc-updater:historico — novas entradas entram aqui -->';

const NUMERO = new Intl.NumberFormat('pt-BR');

function tabela(cabecalhos, linhas) {
  if (!linhas.length) return '_Nada registrado ainda._\n';
  const corpo = linhas.map((celulas) => '| ' + celulas.join(' | ') + ' |').join('\n');
  return (
    '| ' + cabecalhos.join(' | ') + ' |\n' +
    '| ' + cabecalhos.map(() => '---').join(' | ') + ' |\n' +
    corpo + '\n'
  );
}

function lista(itens) {
  return itens.length ? itens.map((item) => '- ' + item).join('\n') + '\n' : '_Nenhum._\n';
}

function dataLegivel(iso) {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function codigo(texto) {
  return '`' + texto + '`';
}

/* ------------------------------------------------------------------ *
 * Blocos do ARQUITETURA.md                                            *
 * ------------------------------------------------------------------ */

function blocoResumo(inv) {
  const g = inv.git ?? {};
  return [
    '### Resumo',
    '',
    tabela(
      ['Item', 'Valor'],
      [
        ['Projeto', codigo(inv.nome)],
        ['Versao', inv.versao ?? '—'],
        ['Framework', inv.framework.nome + ' ' + (inv.framework.versao ?? '')],
        ['Papel', inv.framework.tipo === 'api' ? 'Back-end / API' : 'Front-end / SPA'],
        ['Gerenciador de pacotes', inv.gerenciadorDePacotes],
        ['Arquivos versionaveis', NUMERO.format(inv.totalDeArquivos)],
        ['Linhas de codigo', NUMERO.format(inv.linhasDeCodigo)],
        ['Arquivos de teste', String(inv.testes.length)],
        ['Branch', g.branch ?? '—'],
        ['Commit documentado', g.headCurto ? codigo(g.headCurto) : '—'],
        ['Repositorio remoto', g.remoto ?? 'nenhum configurado'],
      ],
    ),
  ].join('\n');
}

function blocoTopologia(inv) {
  const ehApi = inv.framework.tipo === 'api';
  const este = inv.nome + '<br/>' + inv.framework.nome;
  const linhas = ehApi
    ? [
        '  Clientes["Clientes HTTP<br/>(front-end, integracoes)"] -- HTTP/JSON --> Este["' + este + '"]',
        '  Este --> Dados[("Persistencia")]',
      ]
    : [
        '  Navegador["Navegador"] --> Este["' + este + '"]',
        '  Este -- HTTP/JSON --> Api["API do CRM"]',
      ];
  return ['### Topologia', '', '```mermaid', 'flowchart LR', ...linhas, '```'].join('\n');
}

function blocoEstrutura(inv) {
  const pastas = new Map();
  for (const arquivo of inv.arquivos) {
    const diretorios = arquivo.split('/').slice(0, -1);
    const pasta = diretorios.length ? diretorios.slice(0, 2).join('/') : '(raiz)';
    pastas.set(pasta, (pastas.get(pasta) ?? 0) + 1);
  }
  const linhas = [...pastas.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pasta, total]) => [codigo(pasta), String(total)]);
  return ['### Estrutura de pastas', '', tabela(['Caminho', 'Arquivos'], linhas)].join('\n');
}

function blocoApi(inv) {
  const partes = ['### Modulos', '', tabela(
    ['Modulo', 'Arquivo'],
    inv.modulos.map((m) => [codigo(m.classe), codigo(m.arquivo)]),
  )];

  partes.push('', '### Endpoints HTTP', '', tabela(
    ['Metodo', 'Rota', 'Controller', 'Handler'],
    inv.rotasHttp.map((r) => [
      '`' + r.metodo + '`',
      codigo(r.caminho),
      codigo(r.controller),
      codigo(r.handler),
    ]),
  ));

  partes.push('', '### Providers / servicos', '', tabela(
    ['Classe', 'Arquivo'],
    inv.servicos.map((s) => [codigo(s.classe), codigo(s.arquivo)]),
  ));

  return partes.join('\n');
}

function blocoFrontend(inv) {
  const partes = ['### Componentes', '', tabela(
    ['Componente', 'Seletor', 'Template', 'Arquivo'],
    inv.componentes.map((c) => [
      codigo(c.classe),
      c.seletor ? codigo(c.seletor) : '—',
      c.template === 'inline' ? 'inline' : codigo(c.template),
      codigo(c.arquivo),
    ]),
  )];

  partes.push('', '### Rotas de navegacao', '', tabela(
    ['Rota', 'Destino', 'Guardas'],
    inv.rotasFront.map((r) => [codigo(r.caminho), codigo(r.alvo), r.guardas || '—']),
  ));

  partes.push('', '### Servicos injetaveis', '', tabela(
    ['Classe', 'Arquivo'],
    inv.servicos.map((s) => [codigo(s.classe), codigo(s.arquivo)]),
  ));

  if (inv.diretivas.length || inv.pipes.length) {
    partes.push('', '### Diretivas e pipes', '', tabela(
      ['Tipo', 'Classe', 'Seletor / nome'],
      [
        ...inv.diretivas.map((d) => ['Diretiva', codigo(d.classe), d.seletor ?? '—']),
        ...inv.pipes.map((p) => ['Pipe', codigo(p.classe), p.nomeDoPipe ?? '—']),
      ],
    ));
  }

  return partes.join('\n');
}

function blocoIntegracao(inv) {
  return [
    '### Chamadas HTTP saindo deste projeto',
    '',
    tabela(
      ['Metodo', 'URL', 'Arquivo'],
      inv.chamadasHttp.map((c) => ['`' + c.metodo + '`', codigo(c.url), codigo(c.arquivo)]),
    ),
  ].join('\n');
}

function blocoDependencias(inv) {
  const producao = Object.entries(inv.dependencias).map(([n, v]) => [codigo(n), v]);
  const desenvolvimento = Object.entries(inv.dependenciasDev).map(([n, v]) => [codigo(n), v]);
  return [
    '### Dependencias de producao',
    '',
    tabela(['Pacote', 'Versao'], producao),
    '',
    '<details><summary>Dependencias de desenvolvimento (' + desenvolvimento.length + ')</summary>',
    '',
    tabela(['Pacote', 'Versao'], desenvolvimento),
    '',
    '</details>',
  ].join('\n');
}

function blocoScripts(inv) {
  return [
    '### Scripts disponiveis',
    '',
    tabela(
      ['Comando', 'Executa'],
      Object.entries(inv.scripts).map(([nome, cmd]) => [
        codigo(inv.gerenciadorDePacotes + ' run ' + nome),
        codigo(cmd),
      ]),
    ),
  ].join('\n');
}

function blocoAmbiente(inv) {
  return [
    '### Variaveis de ambiente usadas no codigo',
    '',
    lista(inv.variaveisDeAmbiente.map(codigo)),
  ].join('\n');
}

/** Corpo auto-gerado do ARQUITETURA.md. */
export function renderizarArquitetura(inv, agora = new Date()) {
  const ehApi = inv.framework.tipo === 'api';
  return [
    '> Atualizado por `tools/doc-updater` em ' + dataLegivel(agora.toISOString()) +
      ' a partir do commit `' + (inv.git?.headCurto ?? 'sem git') + '`.',
    '',
    blocoResumo(inv),
    '',
    blocoTopologia(inv),
    '',
    blocoEstrutura(inv),
    '',
    ehApi ? blocoApi(inv) : blocoFrontend(inv),
    '',
    blocoIntegracao(inv),
    '',
    blocoScripts(inv),
    '',
    blocoAmbiente(inv),
    '',
    blocoDependencias(inv),
  ].join('\n');
}

/** Arquivo completo, usado so quando o ARQUITETURA.md ainda nao existe. */
export function moldeArquitetura(inv, corpoAuto) {
  return [
    '# Arquitetura — ' + inv.nome,
    '',
    '## Contexto',
    '',
    '<!-- Escreva aqui, a mao, o que o projeto faz e como as pecas conversam.',
    '     Esta secao nunca e sobrescrita pela ferramenta. -->',
    '',
    '_Pendente de descricao._',
    '',
    '## Inventario tecnico',
    '',
    AUTO_INICIO,
    '',
    corpoAuto,
    '',
    AUTO_FIM,
    '',
    '## Decisoes de arquitetura',
    '',
    '<!-- Registre aqui trade-offs, padroes adotados e o que foi descartado. -->',
    '',
    '_Pendente de descricao._',
    '',
  ].join('\n');
}

/** Substitui apenas o miolo gerado, preservando o texto escrito a mao. */
export function mesclarBlocoAuto(conteudoExistente, corpoAuto, inv) {
  if (!conteudoExistente) return moldeArquitetura(inv, corpoAuto);
  const inicio = conteudoExistente.indexOf(AUTO_INICIO);
  const fim = conteudoExistente.indexOf(AUTO_FIM);
  if (inicio === -1 || fim === -1 || fim < inicio) {
    return (
      conteudoExistente.trimEnd() + '\n\n## Inventario tecnico\n\n' +
      AUTO_INICIO + '\n\n' + corpoAuto + '\n\n' + AUTO_FIM + '\n'
    );
  }
  return (
    conteudoExistente.slice(0, inicio) +
    AUTO_INICIO + '\n\n' + corpoAuto + '\n\n' +
    conteudoExistente.slice(fim)
  );
}

/* ------------------------------------------------------------------ *
 * Historico — "o que foi feito"                                       *
 * ------------------------------------------------------------------ */

export function renderizarEntradaDeHistorico({ inv, commits, arquivos, mudancas, nota, agora }) {
  const data = agora ?? new Date();
  const carimbo = data.toISOString().slice(0, 10);
  const titulo =
    '## ' + carimbo +
    (commits.length ? ' — ' + commits.length + ' commit' + (commits.length > 1 ? 's' : '') : ' — sem commits novos');

  const partes = [titulo, ''];

  if (nota) partes.push('**O que foi feito:** ' + nota, '');

  if (commits.length) {
    partes.push(
      '### Commits',
      '',
      tabela(
        ['Commit', 'Data', 'Autor', 'Mensagem'],
        commits.map((c) => [
          codigo(c.curto),
          c.data.slice(0, 10),
          c.autor,
          c.assunto.replace(/\|/g, '\\|'),
        ]),
      ),
      '',
    );
  }

  if (arquivos.length) {
    const total = arquivos.reduce(
      (acc, a) => ({ adicoes: acc.adicoes + a.adicoes, remocoes: acc.remocoes + a.remocoes }),
      { adicoes: 0, remocoes: 0 },
    );
    const principais = [...arquivos]
      .sort((a, b) => b.adicoes + b.remocoes - (a.adicoes + a.remocoes))
      .slice(0, 25);
    partes.push(
      '### Arquivos alterados (' + arquivos.length + ' · +' + total.adicoes + ' / -' + total.remocoes + ')',
      '',
      lista(principais.map((a) => codigo(a.caminho) + ' (+' + a.adicoes + ' / -' + a.remocoes + ')')),
      '',
    );
  }

  partes.push('### Impacto na arquitetura', '');
  if (mudancas.primeiraExecucao) {
    partes.push('Primeira execucao da ferramenta: inventario inicial registrado.', '');
  } else if (!mudancas.temMudancas) {
    partes.push('Nenhuma mudanca estrutural detectada desde a ultima atualizacao.', '');
  } else {
    for (const item of mudancas.itens) {
      const linhas = [];
      for (const adicionado of item.adicionados) linhas.push('**+** ' + codigo(adicionado));
      for (const removido of item.removidos) linhas.push('**−** ' + codigo(removido));
      for (const alterado of item.alterados ?? []) linhas.push('**~** ' + codigo(alterado));
      partes.push('**' + item.rotulo + '**', '', lista(linhas), '');
    }
  }

  const m = mudancas.metricas;
  partes.push(
    '### Metricas',
    '',
    tabela(
      ['Metrica', 'Antes', 'Agora', 'Delta'],
      [
        ['Arquivos', String(m.arquivos.antes), String(m.arquivos.agora), sinal(m.arquivos.agora - m.arquivos.antes)],
        ['Linhas', String(m.linhas.antes), String(m.linhas.agora), sinal(m.linhas.agora - m.linhas.antes)],
      ],
    ),
    '',
    '---',
    '',
  );

  return partes.join('\n');
}

function sinal(n) {
  return n > 0 ? '+' + n : String(n);
}

export function moldeHistorico(nomeProjeto) {
  return [
    '# Historico de mudancas — ' + nomeProjeto,
    '',
    'Registro gerado por `tools/doc-updater`. Cada entrada reune os commits novos,',
    'os arquivos alterados e o impacto deles na arquitetura. Entradas mais recentes no topo.',
    '',
    MARCADOR_HISTORICO,
    '',
  ].join('\n');
}

export function inserirNoHistorico(conteudoExistente, entrada, nomeProjeto) {
  const base = conteudoExistente || moldeHistorico(nomeProjeto);
  const posicao = base.indexOf(MARCADOR_HISTORICO);
  if (posicao === -1) return base.trimEnd() + '\n\n' + entrada;
  const corte = posicao + MARCADOR_HISTORICO.length;
  return base.slice(0, corte) + '\n\n' + entrada + base.slice(corte).replace(/^\n+/, '\n');
}
