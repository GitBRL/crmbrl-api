/**
 * comparar.mjs — diferenca entre o inventario anterior e o atual.
 *
 * E isso que vira a secao "o que foi feito" do historico: em vez de depender
 * so da mensagem do commit, a ferramenta olha o que mudou de fato na
 * arquitetura (componentes, endpoints, rotas, dependencias, scripts).
 */

function chavesDe(lista, chave) {
  return new Set(lista.map(chave));
}

function diferenca(anterior, atual) {
  return {
    adicionados: [...atual].filter((item) => !anterior.has(item)),
    removidos: [...anterior].filter((item) => !atual.has(item)),
  };
}

function compararListas(listaAnterior = [], listaAtual = [], chave) {
  return diferenca(chavesDe(listaAnterior, chave), chavesDe(listaAtual, chave));
}

function compararMapas(mapaAnterior = {}, mapaAtual = {}) {
  const chaves = new Set([...Object.keys(mapaAnterior), ...Object.keys(mapaAtual)]);
  const adicionados = [];
  const removidos = [];
  const alterados = [];
  for (const chave of chaves) {
    const antes = mapaAnterior[chave];
    const agora = mapaAtual[chave];
    if (antes === undefined) adicionados.push(chave + ' ' + agora);
    else if (agora === undefined) removidos.push(chave + ' ' + antes);
    else if (antes !== agora) alterados.push(chave + ': ' + antes + ' -> ' + agora);
  }
  return { adicionados, removidos, alterados };
}

export function compararInventarios(anterior, atual) {
  if (!anterior) {
    return {
      primeiraExecucao: true,
      temMudancas: true,
      itens: [],
      metricas: {
        arquivos: { antes: 0, agora: atual.totalDeArquivos },
        linhas: { antes: 0, agora: atual.linhasDeCodigo },
      },
    };
  }

  const comparacoes = [
    ['Modulos', compararListas(anterior.modulos, atual.modulos, (m) => m.classe)],
    ['Controllers', compararListas(anterior.controllers, atual.controllers, (c) => c.classe)],
    ['Servicos', compararListas(anterior.servicos, atual.servicos, (s) => s.classe)],
    ['Componentes', compararListas(anterior.componentes, atual.componentes, (c) => c.classe)],
    ['Diretivas', compararListas(anterior.diretivas, atual.diretivas, (d) => d.classe)],
    ['Pipes', compararListas(anterior.pipes, atual.pipes, (p) => p.classe)],
    [
      'Endpoints HTTP',
      compararListas(anterior.rotasHttp, atual.rotasHttp, (r) => r.metodo + ' ' + r.caminho),
    ],
    [
      'Rotas de tela',
      compararListas(anterior.rotasFront, atual.rotasFront, (r) => r.caminho + ' -> ' + r.alvo),
    ],
    ['Testes', compararListas(anterior.testes ?? [], atual.testes ?? [], (t) => t)],
    [
      'Variaveis de ambiente',
      compararListas(anterior.variaveisDeAmbiente ?? [], atual.variaveisDeAmbiente ?? [], (v) => v),
    ],
  ];

  const itens = [];
  for (const [rotulo, resultado] of comparacoes) {
    if (resultado.adicionados.length || resultado.removidos.length) {
      itens.push({ rotulo, ...resultado, alterados: [] });
    }
  }

  for (const [rotulo, mapaAntes, mapaDepois] of [
    ['Dependencias', anterior.dependencias, atual.dependencias],
    ['Dependencias de desenvolvimento', anterior.dependenciasDev, atual.dependenciasDev],
    ['Scripts npm', anterior.scripts, atual.scripts],
  ]) {
    const resultado = compararMapas(mapaAntes, mapaDepois);
    if (resultado.adicionados.length || resultado.removidos.length || resultado.alterados.length) {
      itens.push({ rotulo, ...resultado });
    }
  }

  return {
    primeiraExecucao: false,
    temMudancas: itens.length > 0,
    itens,
    metricas: {
      arquivos: { antes: anterior.totalDeArquivos ?? 0, agora: atual.totalDeArquivos },
      linhas: { antes: anterior.linhasDeCodigo ?? 0, agora: atual.linhasDeCodigo },
    },
  };
}

/**
 * Guarda so o que e comparavel entre execucoes — o inventario inteiro inclui a
 * lista completa de arquivos, que incharia o arquivo de estado sem necessidade.
 */
export function resumirParaEstado(inventario) {
  const { arquivos, diretorio, ...resto } = inventario;
  return resto;
}
