/**
 * Widget do chat do site do BRL CRM (§2.5, R14) — TypeScript puro, sem
 * framework, um arquivo (o build normal compila; a API serve em
 * `/api/v1/publico/webchat/widget.js`). É um script (sem import/export) com
 * tudo dentro de uma função: nada vaza para a página além de
 * `window.CrmBrlChat`.
 *
 * Instalação: `<script src="https://<crm>/api/v1/publico/webchat/widget.js"
 * data-chave="wc_…" async></script>`. Opcionais: `data-tema` (claro, escuro,
 * automatico), `data-posicao` (direita, esquerda), `data-aberto="true"`.
 *
 * Fala com a API só por pedidos "simples" (GET, POST de formulário e
 * multipart, sem cabeçalhos próprios: não há preflight de CORS) e com o
 * Socket.IO do namespace `/webchat` por WebSocket direto (protocolo Engine.IO
 * 4, implementado aqui em poucas linhas). Todo texto entra na tela por
 * `textContent`; links só http(s).
 */
(() => {
  type Tema = 'claro' | 'escuro' | 'automatico';
  interface Aparencia {
    titulo: string;
    subtitulo: string | null;
    saudacao: string | null;
    corPrimaria: string;
    corTextoPrimaria: string;
    tema: Tema;
    posicao: 'direita' | 'esquerda';
  }
  interface Configuracao {
    nome: string;
    aparencia: Aparencia;
    contato: 'EMAIL' | 'TELEFONE' | 'EMAIL_OU_TELEFONE';
    textoConsentimento: string;
    urlPrivacidade: string | null;
    permitirAnexos: boolean;
    horario: { aberto: boolean; proximaAbertura: string | null };
    mensagemForaHorario: string | null;
    limites: { tamanhoMaximoTexto: number; tamanhoMaximoAnexo: number };
  }
  interface Mensagem {
    id: string;
    de: 'visitante' | 'equipe';
    tipo: string;
    texto: string | null;
    arquivo: {
      nome: string;
      mime: string;
      tamanho: number;
      url: string;
    } | null;
    autor: { nome: string } | null;
    em: string;
    idCliente: string | null;
    /** Só no widget: enviando ou falhou. */
    situacao?: 'enviando' | 'falhou';
  }
  interface Guardado {
    token?: string;
    nome?: string;
  }
  interface Resposta<T> {
    ok: boolean;
    status: number;
    dados: T & { mensagem?: string };
  }

  const w = window as unknown as Record<string, unknown>;
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script || w.CrmBrlChat) {
    return;
  }
  const chave = script.dataset.chave ?? '';
  if (!chave) {
    console.warn('[CRM BRL] Chat do site: falta o atributo data-chave.');
    return;
  }
  const BASE = new URL(script.src).origin;
  const API = `${BASE}/api/v1/publico/webchat/${encodeURIComponent(chave)}`;
  const GUARDA = `crmbrl-chat:${chave}`;
  const NS = '/webchat';

  let config: Configuracao | null = null;
  let guardado: Guardado = ler();
  const mensagens = new Map<string, Mensagem>();
  let aberto = false;
  let naoLidas = 0;
  let resolvida = false;
  let haMais = false;
  let ws: WebSocket | null = null;
  let conectado = false;
  let tentativas = 0;
  let religar: number | undefined;
  let digitandoEnviadoEm = 0;
  let pararDigitando: number | undefined;
  let equipeDigitando: number | undefined;
  let lidoEm = 0;

  // --------------------------------------------------------------- armazenamento
  function ler(): Guardado {
    try {
      return JSON.parse(localStorage.getItem(GUARDA) ?? '{}') as Guardado;
    } catch {
      return {};
    }
  }
  function guardar(dados: Guardado): void {
    guardado = dados;
    try {
      localStorage.setItem(GUARDA, JSON.stringify(dados));
    } catch {
      // Navegação privada sem armazenamento: vale só nesta página.
    }
  }

  // ------------------------------------------------------------------- HTTP
  async function pedir<T>(
    caminho: string,
    corpo?: Record<string, string> | FormData,
  ): Promise<Resposta<T>> {
    const opcoes: RequestInit = { credentials: 'omit', mode: 'cors' };
    if (corpo) {
      opcoes.method = 'POST';
      opcoes.body =
        corpo instanceof FormData ? corpo : new URLSearchParams(corpo);
    }
    try {
      const resposta = await fetch(API + caminho, opcoes);
      const dados = (await resposta
        .json()
        .catch(() => ({}))) as Resposta<T>['dados'];
      if (resposta.status === 401 && guardado.token) {
        esquecer();
      }
      return { ok: resposta.ok, status: resposta.status, dados };
    } catch {
      return {
        ok: false,
        status: 0,
        dados: {
          mensagem: 'Sem conexão. Tente de novo.',
        } as Resposta<T>['dados'],
      };
    }
  }

  function esquecer(): void {
    guardar({ nome: guardado.nome });
    mensagens.clear();
    resolvida = false;
    ws?.close();
    ws = null;
    desenhar();
  }

  // ------------------------------------------------- Socket.IO (Engine.IO 4)
  function conectar(): void {
    if (ws || !guardado.token) {
      return;
    }
    const socket = new WebSocket(
      `${BASE.replace(/^http/, 'ws')}/api/socket.io/?EIO=4&transport=websocket`,
    );
    ws = socket;
    socket.onmessage = (evento) => receberPacote(socket, String(evento.data));
    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        conectado = false;
        if (guardado.token) {
          const espera = [1, 2, 5, 10, 30][Math.min(tentativas++, 4)] * 1000;
          religar = window.setTimeout(conectar, espera);
        }
      }
    };
  }

  function receberPacote(socket: WebSocket, pacote: string): void {
    if (pacote === '2') {
      socket.send('3');
      return;
    }
    if (pacote[0] === '0') {
      socket.send(
        `40${NS},${JSON.stringify({ chave, token: guardado.token })}`,
      );
      return;
    }
    if (pacote[0] !== '4') {
      return;
    }
    const tipo = pacote[1];
    let corpo = pacote.slice(2);
    if (corpo.startsWith(NS)) {
      corpo = corpo.slice(NS.length).replace(/^,/, '');
    }
    if (tipo === '0') {
      conectado = true;
      tentativas = 0;
      if (aberto) {
        avisarLido();
      }
    } else if (tipo === '4') {
      const erro = JSON.parse(corpo || '{}') as { message?: string };
      ws = null;
      socket.close();
      if (erro.message === 'nao_autenticado') {
        esquecer();
      } else if (erro.message !== 'origem_nao_permitida') {
        religar = window.setTimeout(conectar, 30_000);
      }
    } else if (tipo === '1') {
      ws = null;
      socket.close();
    } else if (tipo === '2') {
      const partes = /^(\d*)(\[[\s\S]*\])$/.exec(corpo);
      if (!partes) {
        return;
      }
      const [nome, dados] = JSON.parse(partes[2]) as [string, unknown];
      tratarEvento(nome, dados);
      if (partes[1]) {
        // `vista`: a mensagem apareceu na tela (painel aberto, aba visível).
        socket.send(
          `43${NS},${partes[1]}${JSON.stringify([{ ok: true, vista: aVista() }])}`,
        );
      }
    }
  }

  function emitir(evento: string, dados: unknown): void {
    if (ws && conectado) {
      ws.send(`42${NS},${JSON.stringify([evento, dados])}`);
    }
  }

  function tratarEvento(nome: string, dados: unknown): void {
    if (nome === 'mensagem') {
      const mensagem = dados as Mensagem;
      const nova = !mensagens.has(mensagem.id);
      incluir(mensagem);
      if (mensagem.de === 'equipe') {
        resolvida = false;
        mostrarDigitando(null);
        if (aVista()) {
          avisarLido();
        } else if (nova) {
          naoLidas++;
        }
      }
      desenhar();
    } else if (nome === 'digitando') {
      const aviso = dados as { ativo?: boolean; nome?: string };
      mostrarDigitando(aviso.ativo === false ? null : (aviso.nome ?? ''));
    }
  }

  function aVista(): boolean {
    return aberto && document.visibilityState !== 'hidden';
  }

  function avisarLido(): void {
    const agora = Date.now();
    if (
      agora - lidoEm > 2000 &&
      [...mensagens.values()].some((m) => m.de === 'equipe')
    ) {
      lidoEm = agora;
      emitir('lido', {});
    }
  }

  // --------------------------------------------------------------- dados
  function incluir(mensagem: Mensagem): void {
    if (mensagem.idCliente) {
      mensagens.delete(`tmp:${mensagem.idCliente}`);
    }
    mensagens.set(mensagem.id, mensagem);
  }

  function idNovo(): string {
    const c = (window.crypto as Crypto | undefined)?.randomUUID?.();
    return (
      c ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    );
  }

  async function carregarSessao(): Promise<void> {
    const resposta = await pedir<{
      conversa: { status: string } | null;
      mensagens: Mensagem[];
      haMais: boolean;
    }>('/sessao', { token: guardado.token ?? '' });
    if (!resposta.ok) {
      return;
    }
    resolvida = resposta.dados.conversa?.status === 'RESOLVIDA';
    haMais = resposta.dados.haMais;
    resposta.dados.mensagens.forEach(incluir);
    conectar();
    desenhar();
  }

  async function carregarAnteriores(): Promise<void> {
    const primeira = ordenadas()[0];
    if (!primeira || !guardado.token) {
      return;
    }
    const resposta = await pedir<{ mensagens: Mensagem[]; haMais: boolean }>(
      '/historico',
      {
        token: guardado.token,
        antes: primeira.id,
      },
    );
    if (resposta.ok) {
      haMais = resposta.dados.haMais;
      resposta.dados.mensagens.forEach(incluir);
      desenhar(false);
    }
  }

  async function enviarTexto(
    texto: string,
    idCliente = idNovo(),
  ): Promise<void> {
    const provisoria: Mensagem = {
      id: `tmp:${idCliente}`,
      de: 'visitante',
      tipo: 'TEXTO',
      texto,
      arquivo: null,
      autor: null,
      em: new Date().toISOString(),
      idCliente,
      situacao: 'enviando',
    };
    mensagens.set(provisoria.id, provisoria);
    desenhar();
    const resposta = await pedir<{ mensagem: Mensagem }>('/mensagens', {
      token: guardado.token ?? '',
      texto,
      idCliente,
    });
    if (resposta.ok) {
      resolvida = false;
      incluir(resposta.dados.mensagem);
    } else if (guardado.token) {
      provisoria.situacao = 'falhou';
      aviso(resposta.dados.mensagem);
    }
    desenhar();
  }

  async function enviarArquivo(arquivo: File): Promise<void> {
    if (!config || !guardado.token) {
      return;
    }
    if (arquivo.size > config.limites.tamanhoMaximoAnexo) {
      aviso(
        `O arquivo passa de ${Math.round(config.limites.tamanhoMaximoAnexo / 1048576)} MB.`,
      );
      return;
    }
    const formulario = new FormData();
    // O token vem antes do arquivo: a API confere antes de receber o conteúdo.
    formulario.append('token', guardado.token);
    formulario.append('idCliente', idNovo());
    formulario.append('arquivo', arquivo, arquivo.name);
    aviso('Enviando o arquivo…', true);
    const resposta = await pedir<{ mensagem: Mensagem }>('/anexos', formulario);
    aviso(resposta.ok ? null : resposta.dados.mensagem);
    if (resposta.ok) {
      resolvida = false;
      incluir(resposta.dados.mensagem);
      desenhar();
    }
  }

  function ordenadas(): Mensagem[] {
    return [...mensagens.values()].sort((a, b) => a.em.localeCompare(b.em));
  }

  // ------------------------------------------------------------------- tela
  const host = document.createElement('div');
  host.setAttribute('data-crmbrl-chat', '');
  const raiz = host.attachShadow({ mode: 'open' });
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    classe?: string,
    texto?: string,
  ): HTMLElementTagNameMap[K] => {
    const elemento = document.createElement(tag);
    if (classe) {
      elemento.className = classe;
    }
    if (texto !== undefined) {
      elemento.textContent = texto;
    }
    return elemento;
  };
  const icone = (caminho: string): SVGSVGElement => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', caminho);
    svg.append(path);
    return svg;
  };
  const ICONES = {
    chat: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z',
    fechar: 'M6 6l12 12M18 6L6 18',
    enviar: 'M3 11l18-8-8 18-2-8z',
    anexo:
      'M16 6l-8.5 8.5a2.5 2.5 0 0 0 3.5 3.5L19 10a4.5 4.5 0 0 0-6.4-6.4L4.5 11.7',
  };

  const estilo = el('style');
  const botao = el('button', 'lancador');
  const contador = el('span', 'contador');
  const painel = el('section', 'painel');
  const titulo = el('strong');
  const subtitulo = el('span', 'sub');
  const situacao = el('span', 'situacao');
  const sair = el('button', 'acao', 'Encerrar');
  const fechar = el('button', 'acao fechar');
  const corpo = el('div', 'corpo');
  const lista = el('div', 'lista');
  const anteriores = el('button', 'anteriores', 'Ver mensagens anteriores');
  const digitando = el('div', 'digitando');
  const faixa = el('div', 'faixa');
  const rodape = el('form', 'rodape');
  const entrada = el('textarea');
  const anexar = el('button', 'acao anexar');
  const seletor = el('input');
  const enviar = el('button', 'enviar');
  const avisoEl = el('div', 'aviso');

  function montar(): void {
    if (!config) {
      return;
    }
    const a = config.aparencia;
    const tema = (script?.dataset.tema as Tema | undefined) ?? a.tema;
    const lado =
      script?.dataset.posicao === 'esquerda' || a.posicao === 'esquerda'
        ? 'left'
        : 'right';
    estilo.textContent = CSS.replace(/LADO/g, lado)
      .replace('COR_TEXTO', a.corTextoPrimaria)
      .replace('COR', a.corPrimaria);
    host.dataset.tema = tema;

    botao.type = 'button';
    botao.setAttribute('aria-label', `Abrir o chat: ${a.titulo}`);
    botao.append(icone(ICONES.chat), contador);
    botao.onclick = () => alternar();

    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', a.titulo);
    const cabecalho = el('header');
    const textos = el('div', 'textos');
    titulo.textContent = a.titulo;
    subtitulo.textContent = a.subtitulo ?? '';
    textos.append(titulo, subtitulo, situacao);
    sair.type = 'button';
    sair.title = 'Encerrar a conversa e esquecer este navegador';
    sair.onclick = () => void encerrar();
    fechar.type = 'button';
    fechar.setAttribute('aria-label', 'Fechar o chat');
    fechar.append(icone(ICONES.fechar));
    fechar.onclick = () => alternar(false);
    cabecalho.append(textos, sair, fechar);

    lista.setAttribute('aria-live', 'polite');
    anteriores.type = 'button';
    anteriores.onclick = () => void carregarAnteriores();
    corpo.append(faixa, anteriores, lista, digitando);

    entrada.rows = 1;
    entrada.placeholder = 'Escreva sua mensagem…';
    entrada.setAttribute('aria-label', 'Mensagem');
    entrada.maxLength = config.limites.tamanhoMaximoTexto;
    entrada.onkeydown = (evento) => {
      if (evento.key === 'Enter' && !evento.shiftKey) {
        evento.preventDefault();
        submeter();
      }
    };
    entrada.oninput = () => avisarDigitando();
    seletor.type = 'file';
    seletor.hidden = true;
    seletor.accept =
      'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip,audio/*,video/*';
    seletor.onchange = () => {
      const arquivo = seletor.files?.[0];
      seletor.value = '';
      if (arquivo) {
        void enviarArquivo(arquivo);
      }
    };
    anexar.type = 'button';
    anexar.setAttribute('aria-label', 'Enviar arquivo');
    anexar.append(icone(ICONES.anexo));
    anexar.onclick = () => seletor.click();
    anexar.hidden = !config.permitirAnexos;
    enviar.type = 'submit';
    enviar.setAttribute('aria-label', 'Enviar');
    enviar.append(icone(ICONES.enviar));
    rodape.append(entrada, seletor, anexar, enviar);
    rodape.onsubmit = (evento) => {
      evento.preventDefault();
      submeter();
    };

    painel.append(cabecalho, corpo, avisoEl, rodape);
    raiz.append(estilo, painel, botao);
    document.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape' && aberto) {
        alternar(false);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (aVista() && naoLidas > 0) {
        naoLidas = 0;
        avisarLido();
        desenhar(false);
      }
    });
    document.body.append(host);
  }

  function submeter(): void {
    const texto = entrada.value.trim();
    if (texto) {
      entrada.value = '';
      window.clearTimeout(pararDigitando);
      digitandoEnviadoEm = 0;
      emitir('digitando', { ativo: false });
      void enviarTexto(texto);
    }
  }

  function alternar(abrir = !aberto): void {
    aberto = abrir;
    painel.classList.toggle('visivel', abrir);
    botao.setAttribute('aria-expanded', String(abrir));
    if (abrir) {
      naoLidas = 0;
      avisarLido();
      desenhar();
      window.setTimeout(
        () => (guardado.token ? entrada : raiz.querySelector('input'))?.focus(),
        50,
      );
    } else {
      botao.focus();
      desenhar(false);
    }
  }

  function aviso(texto: string | null | undefined, neutro = false): void {
    avisoEl.textContent = texto ?? '';
    avisoEl.classList.toggle('neutro', neutro);
  }

  function mostrarDigitando(nome: string | null): void {
    window.clearTimeout(equipeDigitando);
    digitando.textContent =
      nome === null ? '' : `${nome || 'Alguém'} está digitando…`;
    if (nome !== null) {
      equipeDigitando = window.setTimeout(() => mostrarDigitando(null), 6000);
    }
  }

  function avisarDigitando(): void {
    const agora = Date.now();
    if (agora - digitandoEnviadoEm > 2000) {
      digitandoEnviadoEm = agora;
      emitir('digitando', { ativo: true });
    }
    window.clearTimeout(pararDigitando);
    pararDigitando = window.setTimeout(() => {
      digitandoEnviadoEm = 0;
      emitir('digitando', { ativo: false });
    }, 4000);
  }

  async function encerrar(): Promise<void> {
    if (
      !guardado.token ||
      !window.confirm(
        'Encerrar a conversa? Ela deixa de aparecer neste navegador.',
      )
    ) {
      return;
    }
    await pedir('/sair', { token: guardado.token });
    window.clearTimeout(religar);
    esquecer();
  }

  function desenhar(rolar = true): void {
    if (!config) {
      return;
    }
    contador.textContent = naoLidas > 0 ? String(naoLidas) : '';
    contador.hidden = naoLidas === 0;
    const { horario } = config;
    situacao.textContent = horario.aberto ? 'Online' : 'Fora do horário';
    situacao.classList.toggle('fora', !horario.aberto);
    faixa.textContent = horario.aberto
      ? ''
      : (config.mensagemForaHorario ??
        'Estamos fora do horário de atendimento. Deixe sua mensagem: respondemos assim que voltarmos.');
    faixa.hidden = horario.aberto;
    sair.hidden = !guardado.token;
    rodape.hidden = !guardado.token;
    anteriores.hidden = !haMais || !guardado.token;
    lista.replaceChildren();
    if (!guardado.token) {
      lista.append(formulario());
      return;
    }
    if (config.aparencia.saudacao) {
      lista.append(
        bolha({
          id: 'saudacao',
          de: 'equipe',
          tipo: 'TEXTO',
          texto: config.aparencia.saudacao,
          arquivo: null,
          autor: null,
          em: '',
          idCliente: null,
        }),
      );
    }
    let dia = '';
    for (const mensagem of ordenadas()) {
      const data = mensagem.em
        ? new Date(mensagem.em).toLocaleDateString()
        : '';
      if (data && data !== dia) {
        dia = data;
        lista.append(el('div', 'dia', data));
      }
      lista.append(bolha(mensagem));
    }
    if (resolvida) {
      lista.append(
        el(
          'div',
          'dia',
          'Conversa encerrada. Envie uma mensagem para começar outra.',
        ),
      );
    }
    if (rolar) {
      corpo.scrollTop = corpo.scrollHeight;
    }
  }

  function bolha(mensagem: Mensagem): HTMLElement {
    const item = el(
      'div',
      `msg ${mensagem.de}${mensagem.situacao ? ` ${mensagem.situacao}` : ''}`,
    );
    if (mensagem.de === 'equipe' && mensagem.autor) {
      item.append(el('span', 'autor', mensagem.autor.nome));
    }
    const arquivo = mensagem.arquivo;
    if (arquivo) {
      const link = el('a', 'arquivo');
      link.href = BASE + arquivo.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (arquivo.mime.startsWith('image/')) {
        const imagem = el('img');
        imagem.src = link.href;
        imagem.alt = arquivo.nome;
        imagem.loading = 'lazy';
        link.append(imagem);
      } else {
        link.textContent = `📎 ${arquivo.nome} (${Math.max(1, Math.round(arquivo.tamanho / 1024))} KB)`;
      }
      item.append(link);
    }
    if (mensagem.texto) {
      item.append(textoComLinks(mensagem.texto));
    }
    const rodapeMsg =
      mensagem.situacao === 'enviando'
        ? 'Enviando…'
        : mensagem.situacao === 'falhou'
          ? 'Não enviada — toque para tentar de novo'
          : mensagem.em
            ? new Date(mensagem.em).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            : '';
    if (rodapeMsg) {
      item.append(el('span', 'hora', rodapeMsg));
    }
    if (mensagem.situacao === 'falhou') {
      item.onclick = () => {
        mensagens.delete(mensagem.id);
        void enviarTexto(mensagem.texto ?? '', mensagem.idCliente ?? undefined);
      };
    }
    return item;
  }

  function textoComLinks(texto: string): HTMLElement {
    const paragrafo = el('p');
    for (const parte of texto.split(/(https?:\/\/[^\s<>"']+)/)) {
      if (/^https?:\/\//.test(parte)) {
        const link = el('a', undefined, parte);
        link.href = parte;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        paragrafo.append(link);
      } else if (parte) {
        paragrafo.append(document.createTextNode(parte));
      }
    }
    return paragrafo;
  }

  function formulario(): HTMLElement {
    const c = config as Configuracao;
    const form = el('form', 'inicio');
    form.noValidate = true;
    form.append(
      el(
        'p',
        'convite',
        c.aparencia.saudacao ?? 'Conte quem você é para começarmos.',
      ),
    );
    const campo = (rotulo: string, nome: string, tipo: string, valor = '') => {
      const label = el('label', undefined, rotulo);
      const input = el('input');
      input.name = nome;
      input.type = tipo;
      input.value = valor;
      input.autocomplete =
        nome === 'nome' ? 'name' : nome === 'email' ? 'email' : 'tel';
      label.append(input);
      form.append(label);
      return input;
    };
    const nome = campo('Nome', 'nome', 'text', guardado.nome ?? '');
    const email =
      c.contato !== 'TELEFONE' ? campo('E-mail', 'email', 'email') : null;
    const telefone =
      c.contato !== 'EMAIL' ? campo('Telefone', 'telefone', 'tel') : null;
    const consentimento = el('label', 'consentimento');
    const marca = el('input');
    marca.type = 'checkbox';
    consentimento.append(
      marca,
      document.createTextNode(` ${c.textoConsentimento} `),
    );
    if (c.urlPrivacidade) {
      const link = el('a', undefined, 'Política de privacidade');
      link.href = c.urlPrivacidade;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      consentimento.append(link);
    }
    const erro = el('p', 'erro');
    erro.setAttribute('role', 'alert');
    const iniciar = el('button', 'iniciar', 'Iniciar conversa');
    iniciar.type = 'submit';
    form.append(consentimento, erro, iniciar);
    form.onsubmit = async (evento) => {
      evento.preventDefault();
      erro.textContent = '';
      const valores = {
        nome: nome.value.trim(),
        email: email?.value.trim() ?? '',
        telefone: telefone?.value.trim() ?? '',
      };
      if (!valores.nome) {
        erro.textContent = 'Informe o seu nome.';
        return;
      }
      if (
        c.contato === 'EMAIL_OU_TELEFONE' &&
        !valores.email &&
        !valores.telefone
      ) {
        erro.textContent = 'Informe o seu e-mail ou telefone.';
        return;
      }
      if (!marca.checked) {
        erro.textContent = 'É preciso concordar para iniciar a conversa.';
        return;
      }
      iniciar.disabled = true;
      const corpoDoPedido: Record<string, string> = {
        nome: valores.nome,
        consentimento: 'true',
        pagina: location.href.slice(0, 1000),
      };
      if (valores.email) {
        corpoDoPedido.email = valores.email;
      }
      if (valores.telefone) {
        corpoDoPedido.telefone = valores.telefone;
      }
      const resposta = await pedir<{ token: string }>(
        '/visitantes',
        corpoDoPedido,
      );
      iniciar.disabled = false;
      if (!resposta.ok) {
        erro.textContent =
          resposta.dados.mensagem ?? 'Não foi possível começar agora.';
        return;
      }
      guardar({ token: resposta.dados.token, nome: valores.nome });
      conectar();
      desenhar();
      entrada.focus();
    };
    return form;
  }

  // ------------------------------------------------------------------ estilo
  const CSS = `
:host{all:initial;--cor:COR;--cor-texto:COR_TEXTO;--fundo:#fff;--texto:#1f2937;--suave:#6b7280;--bolha:#f3f4f6;--borda:#e5e7eb;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
:host([data-tema=escuro]){--fundo:#111827;--texto:#f3f4f6;--suave:#9ca3af;--bolha:#1f2937;--borda:#374151}
@media (prefers-color-scheme:dark){:host([data-tema=automatico]){--fundo:#111827;--texto:#f3f4f6;--suave:#9ca3af;--bolha:#1f2937;--borda:#374151}}
*{box-sizing:border-box}
svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
button{font:inherit;cursor:pointer}
.lancador{position:fixed;bottom:20px;LADO:20px;width:58px;height:58px;border-radius:50%;border:0;background:var(--cor);color:var(--cor-texto);box-shadow:0 6px 20px rgba(0,0,0,.25);display:grid;place-items:center;z-index:2147483000}
.lancador svg{width:26px;height:26px}
.contador{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;line-height:20px;text-align:center}
.contador[hidden]{display:none}
.painel{position:fixed;bottom:90px;LADO:20px;width:370px;height:min(600px,calc(100vh - 110px));background:var(--fundo);color:var(--texto);border:1px solid var(--borda);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}
.painel.visivel{display:flex}
header{display:flex;align-items:center;gap:8px;padding:14px 12px 14px 16px;background:var(--cor);color:var(--cor-texto)}
.textos{flex:1;display:flex;flex-direction:column;min-width:0}
.textos strong{font-size:16px}
.sub,.situacao{font-size:12px;opacity:.9}
.situacao:before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}
.situacao.fora:before{background:#f59e0b}
.acao{background:transparent;border:0;color:inherit;padding:6px;border-radius:8px;font-size:12px}
.acao:hover,.acao:focus-visible{background:rgba(127,127,127,.2)}
.acao[hidden],.rodape[hidden],.anteriores[hidden],.faixa[hidden]{display:none}
.corpo{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.lista{display:flex;flex-direction:column;gap:6px}
.faixa{background:#fef3c7;color:#92400e;border-radius:10px;padding:8px 10px;font-size:13px}
.anteriores{align-self:center;background:transparent;border:1px solid var(--borda);color:var(--suave);border-radius:14px;padding:4px 12px;font-size:12px}
.dia{align-self:center;color:var(--suave);font-size:12px;margin:6px 0;text-align:center}
.msg{max-width:80%;padding:8px 11px;border-radius:14px;background:var(--bolha);align-self:flex-start;word-wrap:break-word;overflow-wrap:anywhere}
.msg.visitante{align-self:flex-end;background:var(--cor);color:var(--cor-texto)}
.msg.enviando{opacity:.6}
.msg.falhou{outline:2px solid #dc2626;cursor:pointer}
.msg p{margin:0;white-space:pre-wrap}
.msg a{color:inherit}
.autor{display:block;font-size:12px;font-weight:600;color:var(--suave);margin-bottom:2px}
.hora{display:block;font-size:11px;opacity:.7;margin-top:2px;text-align:right}
.arquivo img{display:block;max-width:100%;max-height:220px;border-radius:10px;margin-bottom:4px}
.digitando{color:var(--suave);font-size:12px;min-height:16px}
.aviso{color:#dc2626;font-size:12px;padding:0 14px}
.aviso.neutro{color:var(--suave)}
.rodape{display:flex;align-items:flex-end;gap:6px;padding:10px;border-top:1px solid var(--borda)}
textarea{flex:1;resize:none;max-height:120px;border:1px solid var(--borda);border-radius:12px;padding:9px 11px;font:inherit;background:var(--fundo);color:var(--texto)}
textarea:focus,input:focus{outline:2px solid var(--cor);outline-offset:1px}
.enviar{width:40px;height:40px;border-radius:50%;border:0;background:var(--cor);color:var(--cor-texto);display:grid;place-items:center}
.anexar{color:var(--suave);height:40px}
.inicio{display:flex;flex-direction:column;gap:10px}
.inicio label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--suave)}
.inicio input:not([type=checkbox]){border:1px solid var(--borda);border-radius:10px;padding:9px 11px;font:inherit;background:var(--fundo);color:var(--texto)}
.consentimento{flex-direction:row!important;align-items:flex-start;gap:6px!important;font-size:12px!important}
.consentimento a{color:var(--cor)}
.convite{margin:0}
.erro{color:#dc2626;font-size:12px;margin:0;min-height:16px}
.iniciar{border:0;border-radius:10px;padding:11px;background:var(--cor);color:var(--cor-texto);font-weight:600}
.iniciar:disabled{opacity:.6}
@media (max-width:480px){.painel{inset:0;width:auto;height:auto;border-radius:0;border:0}.painel.visivel~.lancador{display:none}}
`;

  // ----------------------------------------------------------------- início
  async function iniciar(): Promise<void> {
    const resposta = await pedir<Configuracao>('/configuracao');
    if (!resposta.ok) {
      console.warn(
        `[CRM BRL] Chat do site indisponível: ${resposta.dados.mensagem ?? resposta.status}`,
      );
      return;
    }
    config = resposta.dados;
    montar();
    desenhar();
    if (guardado.token) {
      await carregarSessao();
    }
    if (script?.dataset.aberto === 'true') {
      alternar(true);
    }
  }

  w.CrmBrlChat = {
    abrir: () => alternar(true),
    fechar: () => alternar(false),
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void iniciar());
  } else {
    void iniciar();
  }
})();
