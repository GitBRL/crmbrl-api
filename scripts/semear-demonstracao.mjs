#!/usr/bin/env node
// Dados de demonstração do BRL CRM, criados PELA API (Node 24, só `fetch`, sem
// dependências). Tudo passa pelas regras de negócio e gera auditoria, como se
// cada pessoa tivesse usado o sistema: o Admin troca a senha inicial e cria a
// equipe; cada usuário entra, troca a senha temporária e cria os próprios
// contatos, negócios e atividades; as passagens Marketing → Comercial → CS
// rodam sozinhas; webhooks de entrada recebem leads; um vendedor é desligado.
//
// A semeadura completa só roda numa base recém-criada (apenas o Admin do primeiro acesso, sem
// contatos): se já houver dados, para com uma mensagem e não altera nada.
// Para recomeçar, recrie o banco e rode de novo.
//
// Uso:
//   CRM_API_URL=http://127.0.0.1:3200 \
//   ADMIN_EMAIL=admin@demo.local ADMIN_SENHA_INICIAL='<a do .env da API>' \
//   node scripts/semear-demonstracao.mjs
//
// Variáveis (as senhas têm padrão SÓ para desenvolvimento):
//   CRM_API_URL               endereço da API, sem /api (obrigatória)
//   CRM_ORIGEM                Origin aceito pela API (R2.9); padrão http://localhost:4200
//   ADMIN_EMAIL               e-mail do Admin do primeiro acesso; padrão admin@demo.local
//   ADMIN_SENHA_INICIAL       senha inicial do Admin (obrigatória: a do .env da API)
//   SEMEAR_SENHA_ADMIN        nova senha do Admin; padrão Admin@Demo2026
//   SEMEAR_SENHA_USUARIOS     senha de todos os usuários de demonstração; padrão Demo@2026
//   SEMEAR_SENHA_TEMPORARIA   senha do usuário que fica com troca pendente; padrão Trocar@2026
//   SEMEAR_DOMINIO            domínio dos e-mails de demonstração; padrão demo.local
//   SEMEAR_WEBHOOK_SAIDA_URL  destino de um webhook de saída ATIVO (ex.: um receptor
//                             de testes). Sem ela, o destino é criado DESATIVADO,
//                             apontando para https://example.com (nada é enviado).
//   SEMEAR_WEBHOOK_SAIDA_FALHA_URL  opcional: um destino que responde erro, para
//                             ver tentativas e falhas (assina só negocio.perdido).
//   SEMEAR_CONVITE            "false" pula o usuário convidado por e-mail (exige SMTP)
//   SEMEAR_ETAPA             "onda-b": só a etapa da Onda B (importação, disparos, chatbot, automações; idempotente)
//   SEMEAR_ETAPA             "atendimento" (ou o argumento `atendimento`): só a etapa de atendimento, sobre a base
//                             já semeada (idempotente). Veja o cabeçalho da etapa, mais abaixo.

import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';

// ---------------------------------------------------------------- config ---

const AMBIENTE = process.env;
const API = (AMBIENTE.CRM_API_URL ?? '').replace(/\/+$/, '');
const ORIGEM = AMBIENTE.CRM_ORIGEM ?? 'http://localhost:4200';
const ADMIN_EMAIL = (AMBIENTE.ADMIN_EMAIL ?? 'admin@demo.local')
  .trim()
  .toLowerCase();
const ADMIN_SENHA_INICIAL = AMBIENTE.ADMIN_SENHA_INICIAL ?? '';
const SENHA_ADMIN = AMBIENTE.SEMEAR_SENHA_ADMIN ?? 'Admin@Demo2026';
const SENHA_USUARIOS = AMBIENTE.SEMEAR_SENHA_USUARIOS ?? 'Demo@2026';
const SENHA_TEMPORARIA = AMBIENTE.SEMEAR_SENHA_TEMPORARIA ?? 'Trocar@2026';
const DOMINIO = AMBIENTE.SEMEAR_DOMINIO ?? 'demo.local';
const WEBHOOK_SAIDA_URL = AMBIENTE.SEMEAR_WEBHOOK_SAIDA_URL ?? '';
const WEBHOOK_SAIDA_FALHA_URL = AMBIENTE.SEMEAR_WEBHOOK_SAIDA_FALHA_URL ?? '';
const CRIAR_CONVITE = AMBIENTE.SEMEAR_CONVITE !== 'false';
// Etapa a rodar: sem nada = semeadura completa (que termina com o atendimento);
// `atendimento` = só a etapa de atendimento, sobre a base já semeada.
const ETAPA = (process.argv[2] ?? AMBIENTE.SEMEAR_ETAPA ?? '')
  .trim()
  .toLowerCase();

function parar(mensagem) {
  console.error(`\n✗ ${mensagem}`);
  process.exit(1);
}

if (!API) {
  parar(
    'Defina CRM_API_URL com o endereço da API (ex.: http://127.0.0.1:3200). ' +
      'Leia o cabeçalho deste script para as demais variáveis.',
  );
}
if (!ADMIN_SENHA_INICIAL) {
  parar(
    'Defina ADMIN_SENHA_INICIAL com a senha inicial do Admin (a do .env da API).',
  );
}
for (const [nome, senha] of [
  ['SEMEAR_SENHA_ADMIN', SENHA_ADMIN],
  ['SEMEAR_SENHA_USUARIOS', SENHA_USUARIOS],
  ['SEMEAR_SENHA_TEMPORARIA', SENHA_TEMPORARIA],
]) {
  if (senha.length < 8 || senha.length > 128) {
    parar(`${nome} precisa ter de 8 a 128 caracteres (R2.1).`);
  }
}

// ------------------------------------------------------------------ HTTP ---

class ErroDaApi extends Error {
  constructor(metodo, caminho, status, corpo) {
    const detalhe =
      corpo && typeof corpo === 'object'
        ? corpo
        : { mensagem: String(corpo ?? '') };
    super(
      `${metodo} ${caminho} → ${status} ${detalhe.erro ?? ''}: ${detalhe.mensagem ?? ''}` +
        (detalhe.detalhes ? ` ${JSON.stringify(detalhe.detalhes)}` : '') +
        (detalhe.requisicaoId ? ` (requisição ${detalhe.requisicaoId})` : ''),
    );
    this.status = status;
    this.corpo = detalhe;
  }
}

async function lerCorpo(resposta) {
  if (resposta.status === 204) return null;
  const texto = await resposta.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/** Uma sessão de um usuário: guarda o cookie `crmbrl_sessao` entre as chamadas. */
class Sessao {
  constructor(email) {
    this.email = email;
    this.cookie = null;
    this.usuario = null;
  }

  async pedir(metodo, caminho, corpo) {
    const cabecalhos = {
      Accept: 'application/json',
      Origin: ORIGEM,
      'User-Agent': 'semear-demonstracao/1.0',
    };
    if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
    if (this.cookie) cabecalhos.Cookie = this.cookie;
    const resposta = await fetch(`${API}/api/v1${caminho}`, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of resposta.headers.getSetCookie()) {
      const [par] = linha.split(';');
      if (par.startsWith('crmbrl_sessao=')) {
        this.cookie = par.endsWith('=') ? null : par;
      }
    }
    const dados = await lerCorpo(resposta);
    if (!resposta.ok)
      throw new ErroDaApi(metodo, caminho, resposta.status, dados);
    return dados;
  }

  get(caminho) {
    return this.pedir('GET', caminho);
  }
  post(caminho, corpo = {}) {
    return this.pedir('POST', caminho, corpo);
  }
  patch(caminho, corpo) {
    return this.pedir('PATCH', caminho, corpo);
  }
}

async function entrar(email, senha) {
  const sessao = new Sessao(email);
  const perfil = await sessao.post('/auth/entrar', { email, senha });
  sessao.usuario = perfil.usuario;
  sessao.perfil = perfil;
  return sessao;
}

const consultar = (parametros) => `?${new URLSearchParams(parametros)}`;
const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// ------------------------------------------------------- datas e números ---

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;
const AGORA = Date.now();
// Brasil sem horário de verão desde 2019: São Paulo é UTC-3 o ano todo.
const FUSO_SP = 3 * HORA;

/** `dias` a partir de hoje (no calendário de São Paulo), às `hora`:`minuto` de lá. */
function diaEm(dias, hora, minuto = 0) {
  const sp = new Date(AGORA - FUSO_SP);
  const utc = Date.UTC(
    sp.getUTCFullYear(),
    sp.getUTCMonth(),
    sp.getUTCDate() + dias,
    hora,
    minuto,
  );
  return new Date(utc + FUSO_SP).toISOString();
}
const dataEm = (dias) => diaEm(dias, 12).slice(0, 10);
const horasAtras = (horas) => new Date(AGORA - horas * HORA).toISOString();
/** Ainda hoje (São Paulo) e no futuro: daqui a até 3 horas, sem passar das 23h30. */
function maisTardeHoje(horas = 3) {
  const limite = Date.parse(diaEm(0, 23, 30));
  return new Date(
    Math.max(Math.min(AGORA + horas * HORA, limite), AGORA + 15 * MINUTO),
  ).toISOString();
}

/** CNPJ válido (dígitos verificadores, R4.4) a partir de 8 dígitos de raiz. */
function cnpj(raiz) {
  const numeros = `${raiz}0001`.split('').map(Number);
  const digito = (lista) => {
    const pesos =
      lista.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const resto = lista.reduce((soma, n, i) => soma + n * pesos[i], 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const primeiro = digito(numeros);
  const segundo = digito([...numeros, primeiro]);
  const s = [...numeros, primeiro, segundo].join('');
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
}

const email = (local) => `${local}@${DOMINIO}`;

// -------------------------------------------------------------- registro ---

let passos = 0;
function passo(texto) {
  passos += 1;
  console.log(`\n${String(passos).padStart(2, '0')}. ${texto}`);
}
const nota = (texto) => console.log(`    · ${texto}`);

// ============================================================ 1. guarda ===

async function verificarApi() {
  let resposta;
  try {
    resposta = await fetch(`${API}/api/saude`);
  } catch (erro) {
    parar(
      `A API não respondeu em ${API}/api/saude (${erro.cause?.code ?? erro.message}).`,
    );
  }
  const saude = await lerCorpo(resposta);
  if (!resposta.ok || saude?.status !== 'ok') {
    parar(`A API em ${API} não está saudável: ${JSON.stringify(saude)}`);
  }
  nota(
    `API ${saude.versao} em ${API} (banco ${saude.banco?.status}, ${saude.migrations?.aplicadas} migrations)`,
  );
}

/** Entra como Admin e confirma que a base está recém-criada (senão para). */
async function prepararAdmin() {
  let admin;
  let trocou = false;
  try {
    admin = await entrar(ADMIN_EMAIL, ADMIN_SENHA_INICIAL);
  } catch (erro) {
    if (erro.status === 429)
      parar(
        `Login do Admin bloqueado por tentativas (R2.5): ${erro.corpo.mensagem}`,
      );
    if (erro.status !== 401) throw erro;
  }
  if (!admin) {
    try {
      admin = await entrar(ADMIN_EMAIL, SENHA_ADMIN);
      trocou = true;
    } catch (erro) {
      if (erro.status !== 401 && erro.status !== 429) throw erro;
      parar(
        `Não consegui entrar como ${ADMIN_EMAIL} nem com ADMIN_SENHA_INICIAL nem com SEMEAR_SENHA_ADMIN ` +
          `(${erro.corpo.mensagem}). Este script só roda numa base recém-criada, com o Admin do primeiro acesso.`,
      );
    }
  }
  if (admin.usuario.papel !== 'ADMIN') parar(`${ADMIN_EMAIL} não é Admin.`);

  if (admin.perfil.deveTrocarSenha) {
    const atual = trocou ? SENHA_ADMIN : ADMIN_SENHA_INICIAL;
    if (atual === SENHA_ADMIN)
      parar('SEMEAR_SENHA_ADMIN precisa ser diferente da senha inicial.');
    await admin.post('/auth/senha', {
      senhaAtual: atual,
      novaSenha: SENHA_ADMIN,
    });
    nota(`senha inicial do Admin trocada (R2.6, R2.7)`);
  } else {
    nota(`o Admin já tinha trocado a senha inicial`);
  }

  const usuarios = await admin.get(`/usuarios${consultar({ porPagina: 1 })}`);
  const contatos = await admin.get(`/contatos${consultar({ porPagina: 1 })}`);
  if (usuarios.total > 1 || contatos.total > 0) {
    await admin.post('/auth/sair').catch(() => {});
    parar(
      `Esta base já tem dados (${usuarios.total} usuário(s), ${contatos.total} contato(s)): ` +
        'a demonstração já foi semeada, ou a base não é de desenvolvimento. Nada foi alterado ' +
        'além do login. Para semear de novo, recrie o banco do zero (no ambiente dos agentes: ' +
        '`trabalho/dev/ambiente.sh ressemear`) e rode este script outra vez.',
    );
  }
  return admin;
}

// ========================================================== 2. usuários ===

const EQUIPE = [
  {
    chave: 'clevel',
    nome: 'Helena Duarte',
    papel: 'C_LEVEL',
    telefone: '(11) 99101-2001',
  },
  {
    chave: 'liderComercial',
    nome: 'Rafael Mendes',
    papel: 'LIDER_COMERCIAL',
    lider: 'clevel',
    telefone: '(11) 99101-2002',
    local: 'lider.comercial',
  },
  {
    chave: 'liderMarketing',
    nome: 'Camila Rocha',
    papel: 'LIDER_MARKETING',
    lider: 'clevel',
    telefone: '(11) 99101-2003',
    local: 'lider.marketing',
  },
  {
    chave: 'liderCs',
    nome: 'Bruno Tavares',
    papel: 'LIDER_CS',
    lider: 'clevel',
    telefone: '(11) 99101-2004',
    local: 'lider.cs',
  },
  {
    chave: 'comercial1',
    nome: 'Lucas Pereira',
    papel: 'COMERCIAL',
    lider: 'liderComercial',
    telefone: '(21) 99202-3001',
  },
  {
    chave: 'comercial2',
    nome: 'Juliana Alves',
    papel: 'COMERCIAL',
    lider: 'liderComercial',
    telefone: '(21) 99202-3002',
  },
  {
    chave: 'marketing1',
    nome: 'Mariana Costa',
    papel: 'MARKETING',
    lider: 'liderMarketing',
    telefone: '(31) 99303-4001',
  },
  {
    chave: 'marketing2',
    nome: 'Thiago Lima',
    papel: 'MARKETING',
    lider: 'liderMarketing',
    telefone: '(31) 99303-4002',
  },
  {
    chave: 'cs1',
    nome: 'Fernanda Ribeiro',
    papel: 'CS',
    lider: 'liderCs',
    telefone: '(41) 99404-5001',
  },
  {
    chave: 'cs2',
    nome: 'Diego Martins',
    papel: 'CS',
    lider: 'liderCs',
    telefone: '(41) 99404-5002',
  },
  // Entra no rodízio comercial e é desligado no fim (R7): o que estava com ele vai para Rafael.
  {
    chave: 'desligado',
    nome: 'Pedro Santos',
    papel: 'COMERCIAL',
    lider: 'liderComercial',
    telefone: '(21) 99202-3003',
    local: 'pedro.santos',
  },
];

/** Usuários e sessões, por chave (`clevel`, `comercial1`…) e por id. */
const pessoas = {};
const sessaoPorId = new Map();

async function criarEquipe(admin) {
  pessoas.admin = { usuario: admin.usuario, sessao: admin };
  sessaoPorId.set(admin.usuario.id, admin);
  for (const membro of EQUIPE) {
    const enderecoEmail = email(membro.local ?? membro.chave);
    const temporaria = `Tmp-${randomBytes(9).toString('base64url')}`;
    const { usuario } = await admin.post('/usuarios', {
      nome: membro.nome,
      email: enderecoEmail,
      papel: membro.papel,
      liderId: membro.lider ? pessoas[membro.lider].usuario.id : undefined,
      telefone: membro.telefone,
      senhaTemporaria: temporaria,
    });
    // Primeiro acesso de cada um: entra com a temporária e troca (R2.7, R2.8).
    const sessao = await entrar(enderecoEmail, temporaria);
    await sessao.post('/auth/senha', {
      senhaAtual: temporaria,
      novaSenha: SENHA_USUARIOS,
    });
    pessoas[membro.chave] = { usuario, sessao };
    sessaoPorId.set(usuario.id, sessao);
    nota(
      `${usuario.rotuloPapel.padEnd(18)} ${membro.nome.padEnd(17)} ${enderecoEmail}`,
    );
  }
}

const s = (chave) => pessoas[chave].sessao;
const id = (chave) => pessoas[chave].usuario.id;
function sessaoDoResponsavel(negocio, reserva) {
  return (
    (negocio.responsavel && sessaoPorId.get(negocio.responsavel.id)) || reserva
  );
}

// ============================================================= 3. funis ===

const funis = {};
async function lerFunis(admin) {
  for (const funil of await admin.get('/funis')) {
    if (!funil.base) continue;
    funis[funil.area] = {
      id: funil.id,
      etapas: Object.fromEntries(
        funil.etapas.map((etapa) => [etapa.chave, etapa.id]),
      ),
    };
  }
  for (const area of ['MARKETING', 'COMERCIAL', 'CS']) {
    if (!funis[area]) parar(`O funil-base de ${area} não existe (R5.1).`);
  }
  const etapa = (area, chave) => {
    const encontrada = funis[area].etapas[chave];
    if (!encontrada)
      parar(`A etapa "${chave}" do funil ${area} não existe (R5.2).`);
    return encontrada;
  };
  return etapa;
}

// ========================================================== principal ===

// ================================================== Etapa: atendimento ===
//
// Roda sobre a base já semeada (ou logo depois da semeadura completa) e pode ser
// repetida: cada peça só é criada se ainda não existir (por nome/atalho), e as
// conversas de um canal só entram se o canal ainda não tiver nenhuma.
//
//   node scripts/semear-demonstracao.mjs atendimento      (ou SEMEAR_ETAPA=atendimento)
//
// Variáveis da etapa (padrões do ambiente dos agentes, `crmbrl-dev`):
//   WHATSAPP_TOKEN_INTERNO   token do gateway simulado (obrigatória para as conversas do WhatsApp)
//   GATEWAY_URL              gateway simulado; padrão http://127.0.0.1:3210
//   GREENMAIL_SMTP           host:porta do SMTP do GreenMail visto DESTE script; padrão 127.0.0.1:3025
//   GREENMAIL_HOST_API       host do GreenMail visto PELA API (IMAP/SMTP do canal); padrão greenmail
//   SEMEAR_ATENDIMENTO       "false" pula a etapa na semeadura completa
//   SEMEAR_ESPERA_EMAIL      segundos de espera pela varredura do IMAP (a cada minuto); padrão 100

const TOKEN_GATEWAY = AMBIENTE.WHATSAPP_TOKEN_INTERNO ?? '';
const GATEWAY_URL = (AMBIENTE.GATEWAY_URL ?? 'http://127.0.0.1:3210').replace(
  /\/+$/,
  '',
);
const [SMTP_LOCAL_HOST, SMTP_LOCAL_PORTA] = (
  AMBIENTE.GREENMAIL_SMTP ?? '127.0.0.1:3025'
).split(':');
const GREENMAIL_NA_API = AMBIENTE.GREENMAIL_HOST_API ?? 'greenmail';
const ESPERA_EMAIL_S = Number(AMBIENTE.SEMEAR_ESPERA_EMAIL ?? 100);
const RODAR_ATENDIMENTO = AMBIENTE.SEMEAR_ATENDIMENTO !== 'false';
const SEGREDO_META = 'segredo-meta-de-demonstracao';

/** PNG de 1x1 pixel: serve de "foto" enviada pelo cliente no WhatsApp. */
const PNG_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const normalizarBusca = (texto) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Pede algo ao gateway simulado de WhatsApp (porta 3210). */
async function simularWhatsapp(numeroId, de, nome, texto, midia) {
  if (!TOKEN_GATEWAY) {
    parar(
      'Defina WHATSAPP_TOKEN_INTERNO (o do .env do ambiente) para simular o WhatsApp.',
    );
  }
  const resposta = await fetch(`${GATEWAY_URL}/simulador/receber`, {
    method: 'POST',
    headers: {
      'X-Token-Interno': TOKEN_GATEWAY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ numeroId, de, nome, texto, midia }),
  });
  if (!resposta.ok) {
    throw new Error(
      `Simulador do WhatsApp → ${resposta.status}: ${await resposta.text()}`,
    );
  }
}

/** Cliente SMTP mínimo (sem dependências) para entregar e-mails na caixa do GreenMail. */
function enviarEmailSmtp({
  de,
  nomeDe,
  para,
  replyTo,
  assunto,
  texto,
  messageId,
}) {
  const codificar = (valor) =>
    `=?UTF-8?B?${Buffer.from(valor, 'utf8').toString('base64')}?=`;
  const corpo64 = Buffer.from(texto, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const mensagem = [
    `From: ${codificar(nomeDe)} <${de}>`,
    `To: <${para}>`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${codificar(assunto)}`,
    `Message-ID: <${messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    corpo64,
  ]
    .filter((linha) => linha !== null)
    .join('\r\n');
  const comandos = [
    'EHLO semeadura.demo.local',
    `MAIL FROM:<${de}>`,
    `RCPT TO:<${para}>`,
    'DATA',
    `${mensagem}\r\n.`,
    'QUIT',
  ];
  return new Promise((resolver, rejeitar) => {
    const conexao = net.createConnection({
      host: SMTP_LOCAL_HOST,
      port: Number(SMTP_LOCAL_PORTA),
    });
    let buffer = '';
    let indice = -1; // -1 = esperando o "220" de abertura
    conexao.setTimeout(15_000, () =>
      conexao.destroy(new Error('SMTP do GreenMail: tempo esgotado')),
    );
    conexao.on('error', rejeitar);
    conexao.on('data', (pedaco) => {
      buffer += pedaco.toString('utf8');
      let fim;
      while ((fim = buffer.indexOf('\r\n')) >= 0) {
        const linha = buffer.slice(0, fim);
        buffer = buffer.slice(fim + 2);
        if (/^\d{3}-/.test(linha)) continue; // continuação de resposta
        const codigo = Number(linha.slice(0, 3));
        if (codigo >= 400) {
          conexao.destroy();
          rejeitar(new Error(`SMTP do GreenMail recusou: ${linha}`));
          return;
        }
        indice += 1;
        if (indice < comandos.length) {
          conexao.write(`${comandos[indice]}\r\n`);
        } else {
          conexao.end();
          resolver();
        }
      }
    });
  });
}

/** Webhook da Meta assinado com o app secret (o mesmo que a Meta enviaria). */
async function webhookMeta(corpo, segredo = SEGREDO_META) {
  const bruto = JSON.stringify(corpo);
  const assinatura = `sha256=${createHmac('sha256', segredo).update(bruto).digest('hex')}`;
  const resposta = await fetch(`${API}/api/v1/publico/meta/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': assinatura,
    },
    body: bruto,
  });
  if (!resposta.ok) {
    throw new Error(
      `Webhook da Meta → ${resposta.status}: ${await resposta.text()}`,
    );
  }
}

/** Chamada pública do widget do chat do site (sem cookie; o Origin é conferido). */
async function widget(chave, caminho, corpo) {
  const resposta = await fetch(
    `${API}/api/v1/publico/webchat/${chave}${caminho}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGEM },
      body: JSON.stringify(corpo),
    },
  );
  const dados = await lerCorpo(resposta);
  if (!resposta.ok)
    throw new ErroDaApi(
      'POST',
      `/publico/webchat/${chave}${caminho}`,
      resposta.status,
      dados,
    );
  return dados;
}

async function esperarAte(
  descricao,
  funcao,
  { ms = 30_000, passo = 1_000 } = {},
) {
  const limite = Date.now() + ms;
  for (;;) {
    const resultado = await funcao();
    if (resultado) return resultado;
    if (Date.now() > limite)
      throw new Error(`Esperei demais por: ${descricao}`);
    await esperar(passo);
  }
}

async function etapaAtendimento() {
  passo('Atendimento: entrando com a equipe');
  const entradas = {
    admin: [ADMIN_EMAIL, SENHA_ADMIN],
    clevel: [email('clevel'), SENHA_USUARIOS],
    liderComercial: [email('lider.comercial'), SENHA_USUARIOS],
    liderCs: [email('lider.cs'), SENHA_USUARIOS],
    liderMarketing: [email('lider.marketing'), SENHA_USUARIOS],
    comercial1: [email('comercial1'), SENHA_USUARIOS],
    comercial2: [email('comercial2'), SENHA_USUARIOS],
    marketing1: [email('marketing1'), SENHA_USUARIOS],
    marketing2: [email('marketing2'), SENHA_USUARIOS],
    cs1: [email('cs1'), SENHA_USUARIOS],
    cs2: [email('cs2'), SENHA_USUARIOS],
  };
  const eq = {};
  const porId = new Map();
  for (const [chave, [endereco, senha]] of Object.entries(entradas)) {
    try {
      eq[chave] = await entrar(endereco, senha);
    } catch (erro) {
      parar(
        `A etapa "atendimento" roda sobre a base semeada: não consegui entrar como ${endereco} (${erro.message}).`,
      );
    }
    porId.set(eq[chave].usuario.id, eq[chave]);
  }
  const admin = eq.admin;
  nota(`${Object.keys(eq).length} sessões abertas`);

  // ------------------------------------------------------------- filas ---
  passo('Atendimento: filas (R12)');
  const filas = {};
  const filasExistentes = await admin.get('/atendimento/filas');
  const definicoesFilas = [
    {
      chave: 'vendas',
      nome: 'Vendas',
      area: 'COMERCIAL',
      descricao: 'Interessados em contratar: propostas e dúvidas comerciais.',
      slaPrimeiraRespostaMinutos: 10,
      slaResolucaoMinutos: 480,
      estrategia: 'RODIZIO',
      participantes: ['comercial1', 'comercial2'],
    },
    {
      chave: 'preVendas',
      nome: 'Pré-vendas',
      area: 'COMERCIAL',
      descricao: 'Primeiro contato vindo de anúncios e redes sociais.',
      slaPrimeiraRespostaMinutos: 15,
      slaResolucaoMinutos: 240,
      estrategia: 'MENOR_CARGA',
      participantes: ['comercial1', 'comercial2'],
    },
    {
      chave: 'triagem',
      nome: 'Triagem do site',
      area: 'COMERCIAL',
      descricao: 'Chat do site: fica sem responsável até alguém assumir.',
      slaPrimeiraRespostaMinutos: 5,
      slaResolucaoMinutos: 240,
      estrategia: 'MANUAL',
    },
    {
      chave: 'suporte',
      nome: 'Suporte CS',
      area: 'CS',
      descricao: 'Clientes ativos: dúvidas de uso, cobrança e ocorrências.',
      slaPrimeiraRespostaMinutos: 5,
      slaResolucaoMinutos: 240,
      estrategia: 'RODIZIO',
      participantes: ['cs1', 'cs2'],
    },
  ];
  for (const { chave, participantes, ...definicao } of definicoesFilas) {
    let fila = filasExistentes.find((f) => f.nome === definicao.nome);
    if (fila) {
      nota(`fila "${fila.nome}" já existe`);
    } else {
      const lider =
        definicao.area === 'COMERCIAL' ? eq.liderComercial : eq.liderCs;
      fila = await lider.post('/atendimento/filas', {
        ...definicao,
        participantes: participantes?.map((p) => eq[p].usuario.id),
      });
      nota(
        `fila "${fila.nome}" (${fila.area}, ${fila.estrategia}) criada por ${lider.usuario.nome}`,
      );
    }
    filas[chave] = fila;
  }

  // ------------------------------------------------------------ canais ---
  passo('Atendimento: canais de todos os tipos (R13, R14)');
  const canais = {};
  const canaisExistentes = async () => admin.get('/atendimento/canais');
  const canalPorNome = async (nome) =>
    (await canaisExistentes()).find((c) => c.nome === nome);

  // WhatsApp (gateway simulado)
  const numeros = await admin.get('/whatsapp/numeros');
  for (const { chave, nome, fila } of [
    { chave: 'wppVendas', nome: 'WhatsApp Vendas', fila: filas.vendas },
    { chave: 'wppSuporte', nome: 'WhatsApp Suporte', fila: filas.suporte },
  ]) {
    let numero = numeros.find((n) => n.nome === nome);
    if (!numero) {
      numero = await admin.post('/whatsapp/numeros', {
        nome,
        filaPadraoId: fila.id,
        aquecimentoDias: 0,
        // Esperas curtas: a demonstração não precisa imitar o ritmo humano.
        intervaloMinimoSegundos: 1,
        intervaloMaximoSegundos: 2,
        protecoes: { digitandoMaximoSegundos: 1 },
      });
      nota(`número "${nome}" criado → fila ${fila.nome}`);
    }
    if (numero.status !== 'CONECTADO') {
      await admin.post(`/whatsapp/numeros/${numero.id}/conectar`);
      numero = await esperarAte(
        `o número "${nome}" conectar (gateway simulado)`,
        async () => {
          const atual = await admin.get(`/whatsapp/numeros/${numero.id}`);
          return atual.status === 'CONECTADO' ? atual : null;
        },
        { ms: 45_000 },
      );
      nota(`"${nome}" conectado (simulado), telefone ${numero.telefone}`);
    } else {
      nota(`"${nome}" já conectado`);
    }
    canais[chave] = {
      canalId: numero.canalId,
      numeroId: numero.id,
      nome,
      tipo: 'WHATSAPP',
    };
  }

  // Chat do site
  let site = await canalPorNome('Chat do site');
  if (!site) {
    const criado = await admin.post('/webchat/canais', {
      nome: 'Chat do site',
      filaPadraoId: filas.triagem.id,
      dominios: ['https://www.brl-demo.local', ORIGEM],
      contato: 'EMAIL_OU_TELEFONE',
      textoConsentimento:
        'Concordo em ser contatado(a) sobre o meu pedido, conforme a política de privacidade.',
      urlPrivacidade: 'https://www.brl-demo.local/privacidade',
      permitirAnexos: true,
      aparencia: {
        titulo: 'Fale com a gente',
        subtitulo: 'Respondemos em poucos minutos.',
        saudacao: 'Olá! Como podemos ajudar?',
      },
    });
    site = await canalPorNome('Chat do site');
    nota(
      `chat do site criado (chave pública ${criado.chavePublica ?? site?.idExterno ?? '?'})`,
    );
  } else {
    nota('chat do site já existe');
  }
  const chaveSite = (await admin.get(`/webchat/canais/${site.id}`))
    .chavePublica;
  canais.site = {
    canalId: site.id,
    nome: 'Chat do site',
    tipo: 'WEBCHAT',
    chave: chaveSite,
  };

  // E-mail (GreenMail)
  for (const { chave, nome, endereco, senha, fila } of [
    {
      chave: 'emailAtendimento',
      nome: 'E-mail atendimento',
      endereco: email('atendimento'),
      senha: 'atendimento2026',
      fila: filas.suporte,
    },
    {
      chave: 'emailVendas',
      nome: 'E-mail vendas',
      endereco: email('vendas'),
      senha: 'vendas2026',
      fila: filas.vendas,
    },
  ]) {
    let canal = await canalPorNome(nome);
    if (!canal) {
      await admin.post('/email/canais', {
        nome,
        endereco,
        nomeRemetente: nome.replace('E-mail ', 'BRL — '),
        filaPadraoId: fila.id,
        imap: {
          host: GREENMAIL_NA_API,
          porta: 3143,
          tls: false,
          usuario: endereco,
        },
        smtp: {
          host: GREENMAIL_NA_API,
          porta: 3025,
          seguranca: 'NENHUMA',
          usuario: endereco,
        },
        senha,
        assinatura: `Equipe BRL\n${endereco}`,
      });
      canal = await canalPorNome(nome);
      nota(`canal de e-mail "${nome}" (${endereco}) criado`);
    } else {
      nota(`canal de e-mail "${nome}" já existe`);
    }
    canais[chave] = { canalId: canal.id, nome, tipo: 'EMAIL', endereco };
  }

  // Instagram e Messenger (Graph API falsa do serviço "apoio")
  const metas = [
    {
      chave: 'instagram',
      nome: 'Instagram BRL',
      tipo: 'INSTAGRAM',
      pageId: '100000000000001',
      instagramId: '17841400000000001',
      fila: filas.preVendas,
    },
    {
      chave: 'messenger',
      nome: 'Messenger BRL',
      tipo: 'MESSENGER',
      pageId: '100000000000002',
      instagramId: undefined,
      fila: filas.suporte,
    },
  ];
  for (const { chave, nome, tipo, pageId, instagramId, fila } of metas) {
    let canal = await canalPorNome(nome);
    if (!canal) {
      await admin.post('/meta/canais', {
        nome,
        tipo,
        appId: '1000000000000099',
        appSecret: SEGREDO_META,
        pageId,
        instagramId,
        tokenPagina: 'EAAdemo-token-de-pagina-de-demonstracao',
        filaPadraoId: fila.id,
      });
      canal = await canalPorNome(nome);
      nota(`${tipo} "${nome}" criado → fila ${fila.nome}`);
    } else {
      nota(`${tipo} "${nome}" já existe`);
    }
    canais[chave] = {
      canalId: canal.id,
      nome,
      tipo,
      entryId: tipo === 'INSTAGRAM' ? instagramId : pageId,
    };
  }

  // Pesquisa de satisfação ligada em todos os canais (R12.13)
  for (const canal of await canaisExistentes()) {
    if (!canal.pesquisaSatisfacao) {
      await admin.patch(`/atendimento/canais/${canal.id}`, {
        pesquisaSatisfacao: true,
      });
    }
  }
  nota('pesquisa de satisfação (1 a 5) ligada em todos os canais');

  // ------------------------------------------------- respostas rápidas ---
  passo('Atendimento: respostas rápidas');
  const rapidasExistentes = await admin.get('/atendimento/respostas-rapidas');
  const rapidas = [
    {
      atalho: 'ola',
      titulo: 'Saudação',
      texto:
        '{{saudacao}}, {{contato.primeiroNome}}! Aqui é {{usuario.primeiroNome}}, da BRL. Como posso ajudar?',
    },
    {
      atalho: 'proposta',
      titulo: 'Envio de proposta',
      texto:
        'Perfeito, {{contato.primeiroNome}}. Vou montar a proposta e te envio ainda hoje. Pode me confirmar o número de usuários?',
      area: 'COMERCIAL',
    },
    {
      atalho: 'prazo',
      titulo: 'Prazo de retorno',
      texto:
        'Anotei aqui, {{contato.primeiroNome}}. Retorno com a resposta em até 1 dia útil.',
    },
    {
      atalho: 'boleto',
      titulo: '2ª via de boleto',
      texto:
        'Claro, {{contato.primeiroNome}}! Estou gerando a 2ª via e envio por aqui em instantes.',
      area: 'CS',
    },
    {
      atalho: 'obrigado',
      titulo: 'Encerramento',
      texto:
        'Foi um prazer, {{contato.primeiroNome}}! Se precisar de mais alguma coisa é só chamar.',
    },
  ];
  const respostasPorAtalho = {};
  for (const resposta of rapidas) {
    let criada = rapidasExistentes.itens
      ? rapidasExistentes.itens.find((r) => r.atalho === resposta.atalho)
      : rapidasExistentes.find((r) => r.atalho === resposta.atalho);
    if (!criada) {
      const dono =
        resposta.area === 'CS'
          ? eq.liderCs
          : resposta.area === 'COMERCIAL'
            ? eq.liderComercial
            : admin;
      criada = await dono.post('/atendimento/respostas-rapidas', resposta);
    }
    respostasPorAtalho[resposta.atalho] = criada;
  }
  nota(
    `${rapidas.length} respostas rápidas (/${rapidas.map((r) => r.atalho).join(', /')})`,
  );

  // ---------------------------------------------------------- conversas ---
  const semConversas = async (canalId) =>
    (
      await admin.get(
        `/atendimento/conversas${consultar({ canalId, porPagina: 1 })}`,
      )
    ).total === 0;

  const acharConversa = (canalId, busca) =>
    esperarAte(`conversa de "${busca}"`, async () => {
      const lista = await admin.get(
        `/atendimento/conversas${consultar({ canalId, busca, porPagina: 5 })}`,
      );
      return lista.itens[0] ?? null;
    });

  /**
   * As mensagens de entrada chegam por filas (gateway, webhook): antes de agir sobre
   * elas (responder, resolver) espera a mensagem aparecer na conversa do contato.
   */
  const esperarEntrada = (canalId, busca, trecho) =>
    esperarAte(`a mensagem "${trecho}" de ${busca} entrar`, async () => {
      for (const status of ['ABERTA', 'RESOLVIDA']) {
        const lista = await admin.get(
          `/atendimento/conversas${consultar({ canalId, busca, status, porPagina: 5 })}`,
        );
        for (const conversa of lista.itens) {
          const { itens } = await admin.get(
            `/atendimento/conversas/${conversa.id}/mensagens`,
          );
          if (
            itens.some(
              (m) => m.direcao === 'ENTRADA' && m.texto?.includes(trecho),
            )
          )
            return conversa;
        }
      }
      return null;
    });
  const clienteWhatsapp = async (canal, de, nome, texto, midia) => {
    await simularWhatsapp(canal.numeroId, de, nome, texto, midia);
    return esperarEntrada(canal.canalId, nome, texto);
  };

  /** Quem atende: o responsável da conversa; sem responsável, `padrao` assume antes. */
  async function sessaoDeAtendimento(conversa, padrao) {
    if (conversa.responsavel)
      return porId.get(conversa.responsavel.id) ?? admin;
    await padrao.post(`/atendimento/conversas/${conversa.id}/assumir`);
    return padrao;
  }
  async function responder(conversa, padrao, texto, atalho) {
    const sessao = await sessaoDeAtendimento(conversa, padrao);
    let corpo = texto;
    if (atalho) {
      const aplicada = await sessao.post(
        `/atendimento/respostas-rapidas/${respostasPorAtalho[atalho].id}/aplicar`,
        { conversaId: conversa.id },
      );
      corpo = aplicada.texto;
    }
    await sessao.post(`/atendimento/conversas/${conversa.id}/mensagens`, {
      texto: corpo,
    });
    conversa.responsavel ??= { id: sessao.usuario.id };
    return sessao;
  }
  const resolverComPesquisa = async (conversa, padrao) => {
    const sessao = await sessaoDeAtendimento(conversa, padrao);
    await sessao.post(`/atendimento/conversas/${conversa.id}/resolver`, {
      enviarPesquisa: true,
    });
  };

  passo('Atendimento: conversas pelo WhatsApp simulado (gateway)');
  if (await semConversas(canais.wppVendas.canalId)) {
    const canal = canais.wppVendas;
    const falar = (de, nome, texto, midia) =>
      clienteWhatsapp(canal, de, nome, texto, midia);
    // 1. Em andamento: a equipe respondeu e o cliente voltou a escrever
    let c = await falar(
      '(11) 97001-0001',
      'Marina Albuquerque',
      'Oi! Vi o anúncio de vocês e quero entender os planos.',
    );
    await falar(
      '(11) 97001-0001',
      'Marina Albuquerque',
      'Somos 10 pessoas no time comercial. Quanto fica por mês?',
    );
    await responder(c, eq.comercial1, null, 'ola');
    await falar(
      '(11) 97001-0001',
      'Marina Albuquerque',
      'Preciso de uma proposta até sexta, consegue?',
    );
    // 2. O cliente mandou uma imagem; resposta com a rápida de proposta
    c = await falar(
      '(21) 97002-0002',
      'Carlos Eduardo Lima',
      'Bom dia, segue o print da tela que mencionei.',
      {
        base64: PNG_PIXEL,
        nome: 'print-da-tela.png',
        mime: 'image/png',
      },
    );
    await responder(c, eq.comercial2, null, 'proposta');
    // 3. Resolvida, nota 5
    c = await falar(
      '(31) 97003-0003',
      'Fernanda Prado',
      'Olá, queria agendar uma demonstração para a minha equipe.',
    );
    await responder(c, eq.comercial1, null, 'ola');
    await responder(
      c,
      eq.comercial1,
      'Agendado para quinta, 15h. Mando o convite por e-mail. Algo mais?',
    );
    await falar('(31) 97003-0003', 'Fernanda Prado', 'Só isso, obrigada!');
    await responder(c, eq.comercial1, null, 'obrigado');
    await resolverComPesquisa(c, eq.comercial1);
    // 4. Resolvida, nota 2 (avisa o líder)
    const roberto = await falar(
      '(41) 97004-0004',
      'Roberto Nunes',
      'Estou esperando retorno da proposta desde segunda.',
    );
    await responder(
      roberto,
      eq.comercial2,
      'Peço desculpas pela demora, Roberto. Já envio a proposta revisada.',
    );
    await resolverComPesquisa(roberto, eq.comercial2);
    // 5. Recém-chegada, ninguém respondeu (não lida)
    await falar(
      '(51) 97005-0005',
      'Patrícia Gomes',
      'Boa tarde! Vocês integram com o RD Station?',
    );
    // As notas chegam como a próxima mensagem do cliente, em até 24 h (R12.13)
    await falar(
      '(31) 97003-0003',
      'Fernanda Prado',
      '5 - atendimento excelente!',
    );
    await falar(
      '(41) 97004-0004',
      'Roberto Nunes',
      '2 - demorou muito para responder',
    );
    nota(
      '5 conversas no WhatsApp Vendas (resolvidas com nota: Fernanda Prado 5, Roberto Nunes 2)',
    );
  } else {
    nota('WhatsApp Vendas já tem conversas: nada a fazer');
  }
  if (await semConversas(canais.wppSuporte.canalId)) {
    const canal = canais.wppSuporte;
    const falar = (de, nome, texto) => clienteWhatsapp(canal, de, nome, texto);
    let c = await falar(
      '(11) 96001-1001',
      'Bruna Teixeira',
      'Não consigo emitir o boleto deste mês.',
    );
    await responder(c, eq.cs1, null, 'boleto');
    c = await falar(
      '(21) 96002-1002',
      'Gustavo Ferraz',
      'O relatório de vendas não abre no meu navegador.',
    );
    await falar(
      '(21) 96002-1002',
      'Gustavo Ferraz',
      'Já tentei limpar o cache.',
    );
    // Quem recebeu a conversa pelo rodízio passa para a outra pessoa, com nota (R12.7)
    const dono = await sessaoDeAtendimento(c, eq.cs2);
    const outro = dono === eq.cs1 ? eq.cs2 : eq.cs1;
    await dono.post(`/atendimento/conversas/${c.id}/transferir`, {
      usuarioId: outro.usuario.id,
      nota: 'Gustavo já tentou limpar o cache; parece problema do relatório novo. Você acompanha?',
    });
    await outro.post(`/atendimento/conversas/${c.id}/notas`, {
      texto:
        'Reproduzi o erro no Chrome. Abrindo chamado com o time de produto.',
    });
    await outro.post(`/atendimento/conversas/${c.id}/mensagens`, {
      texto:
        'Oi, Gustavo! Reproduzimos o erro e já abrimos um chamado. Aviso assim que corrigir.',
    });
    c = await falar(
      '(31) 96003-1003',
      'Larissa Moura',
      'Obrigada pela ajuda de ontem com a fatura!',
    );
    await responder(
      c,
      eq.cs2,
      'Que bom, Larissa! A fatura já está regularizada.',
    );
    await resolverComPesquisa(c, eq.cs2);
    await falar(
      '(31) 96003-1003',
      'Larissa Moura',
      'nota 4, só o prazo que foi um pouco longo',
    );
    nota(
      '3 conversas no WhatsApp Suporte (uma transferida com nota, uma resolvida com nota 4)',
    );
  } else {
    nota('WhatsApp Suporte já tem conversas: nada a fazer');
  }

  passo('Atendimento: conversas pelo chat do site (widget público)');
  if (await semConversas(canais.site.canalId)) {
    const chave = canais.site.chave;
    const visitantes = [
      {
        nome: 'Henrique Salles',
        email: 'henrique.salles@exemplo.com.br',
        pagina:
          'https://www.brl-demo.local/planos?utm_source=google&utm_medium=cpc&utm_campaign=crm-pme',
        textos: [
          'Olá! Vocês têm plano para equipes pequenas?',
          'Somos 4 vendedores.',
        ],
      },
      {
        nome: 'Camila Vidal',
        telefone: '(61) 95001-2002',
        pagina: 'https://www.brl-demo.local/contato',
        textos: ['Gostaria de falar com alguém sobre integração com WhatsApp.'],
      },
    ];
    for (const v of visitantes) {
      const criado = await widget(chave, '/visitantes', {
        nome: v.nome,
        email: v.email,
        telefone: v.telefone,
        consentimento: true,
        pagina: v.pagina,
      });
      const token = criado.token ?? criado.visitanteToken ?? criado.visitanteId;
      for (const texto of v.textos) {
        await widget(chave, '/mensagens', { token, texto });
        await esperar(150);
      }
    }
    const primeira = await acharConversa(canais.site.canalId, 'Henrique');
    await responder(primeira, eq.comercial1, null, 'ola');
    await acharConversa(canais.site.canalId, 'Camila'); // fica na triagem, sem responsável
    nota(
      '2 conversas no chat do site (a da Camila fica sem responsável na Triagem)',
    );
  } else {
    nota('Chat do site já tem conversas: nada a fazer');
  }

  passo(
    'Atendimento: conversas pelo Instagram e Messenger (webhooks assinados da Meta)',
  );
  const agoraMs = Date.now();
  const mensagemMeta = (canal, psid, mid, texto, deslocamentoMs = 0) => ({
    object: canal.tipo === 'INSTAGRAM' ? 'instagram' : 'page',
    entry: [
      {
        id: canal.entryId,
        time: agoraMs - deslocamentoMs,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: canal.entryId },
            timestamp: agoraMs - deslocamentoMs,
            message: { mid, text: texto },
          },
        ],
      },
    ],
  });
  if (await semConversas(canais.instagram.canalId)) {
    await webhookMeta(
      mensagemMeta(
        canais.instagram,
        'demo-Julia-Ferraz',
        'm_demo_ig_1',
        'Oi! Vi o reel de vocês. Como funciona a automação de leads?',
        60_000,
      ),
    );
    await webhookMeta(
      mensagemMeta(
        canais.instagram,
        'demo-Thiago-Bastos',
        'm_demo_ig_2',
        'Vocês atendem agência de marketing?',
        30_000,
      ),
    );
    const julia = await acharConversa(canais.instagram.canalId, 'Julia');
    await responder(julia, eq.comercial2, null, 'ola');
    nota('2 conversas no Instagram (a da Julia já respondida)');
  } else {
    nota('Instagram já tem conversas: nada a fazer');
  }
  if (await semConversas(canais.messenger.canalId)) {
    await webhookMeta(
      mensagemMeta(
        canais.messenger,
        'demo-Paulo-Andrade',
        'm_demo_fb_1',
        'Boa noite, meu acesso não está funcionando.',
        45_000,
      ),
    );
    await webhookMeta(
      mensagemMeta(
        canais.messenger,
        'demo-Renata-Campos',
        'm_demo_fb_2',
        'Vocês emitem nota fiscal?',
        15_000,
      ),
    );
    const renata = await acharConversa(canais.messenger.canalId, 'Renata');
    await responder(
      renata,
      eq.cs2,
      'Emitimos sim, Renata! A nota sai em até 2 dias úteis após o pagamento.',
    );
    await resolverComPesquisa(renata, eq.cs2);
    await esperar(800);
    await webhookMeta(
      mensagemMeta(
        canais.messenger,
        'demo-Renata-Campos',
        'm_demo_fb_3',
        '5',
        0,
      ),
    );
    nota('2 conversas no Messenger (a da Renata resolvida com nota 5)');
  } else {
    nota('Messenger já tem conversas: nada a fazer');
  }

  passo(
    'Atendimento: e-mails pelo GreenMail (varredura do IMAP a cada minuto)',
  );
  const emailsEntrada = [
    {
      canal: canais.emailAtendimento,
      de: 'compras@lojaexemplo.com.br',
      nome: 'Lojas Exemplo — Compras',
      assunto: 'Divergência na fatura de outubro',
      texto:
        'Olá,\n\nIdentificamos um valor diferente do contratado na fatura de outubro. Podem verificar?\n\nAtenciosamente,\nSetor de Compras',
      busca: 'Lojas Exemplo',
    },
    {
      canal: canais.emailVendas,
      de: 'diretoria@construtoraalfa.com.br',
      nome: 'Ricardo Alfa',
      assunto: 'Solicitação de orçamento para 25 usuários',
      texto:
        'Bom dia,\n\nGostaríamos de um orçamento do CRM para 25 usuários, com integração ao WhatsApp.\n\nAguardo retorno.\nRicardo',
      busca: 'Ricardo Alfa',
    },
    {
      canal: canais.emailVendas,
      de: 'ana.paula@clinicavida.com.br',
      nome: 'Ana Paula Siqueira',
      assunto: 'Dúvida sobre período de teste',
      texto: 'Olá! Existe período de teste gratuito? Quantos dias?',
      busca: 'Ana Paula',
    },
  ];
  const pendentesEmail = [];
  for (const item of emailsEntrada) {
    if (await semConversas(item.canal.canalId)) pendentesEmail.push(item);
  }
  const enviarAgora = pendentesEmail;
  for (const item of enviarAgora) {
    await enviarEmailSmtp({
      de: item.de,
      nomeDe: item.nome,
      para: item.canal.endereco,
      replyTo: item.de,
      assunto: item.assunto,
      texto: item.texto,
      messageId: `demo-${randomBytes(6).toString('hex')}@demo.local`,
    });
  }
  if (enviarAgora.length > 0) {
    nota(
      `${enviarAgora.length} e-mail(s) entregues no GreenMail; esperando a varredura do IMAP (até ${ESPERA_EMAIL_S}s)…`,
    );
    const conversasEmail = [];
    for (const item of enviarAgora) {
      try {
        conversasEmail.push({
          item,
          conversa: await esperarAte(
            `e-mail "${item.assunto}" virar conversa`,
            async () => {
              const lista = await admin.get(
                `/atendimento/conversas${consultar({ canalId: item.canal.canalId, porPagina: 20 })}`,
              );
              return (
                lista.itens.find((c) => c.contato.email === item.de) ?? null
              );
            },
            { ms: ESPERA_EMAIL_S * 1000, passo: 3_000 },
          ),
        });
      } catch (erro) {
        nota(`aviso: ${erro.message} (rode a etapa de novo mais tarde)`);
      }
    }
    // A conversa de orçamento é respondida (a resposta sai por SMTP, encadeada)
    const orcamento = conversasEmail.find((e) =>
      e.item.assunto.startsWith('Solicitação'),
    );
    if (orcamento) {
      await responder(
        orcamento.conversa,
        eq.comercial1,
        'Bom dia, Ricardo! Segue em anexo nossa tabela e já agendamos uma conversa para os detalhes da integração. Quais horários funcionam para você?',
      );
    }
    nota(`${conversasEmail.length} conversa(s) de e-mail criadas`);
  } else {
    nota('Os canais de e-mail já têm conversas: nada a fazer');
  }

  // ------------------------------------------------------- chat interno ---
  passo('Atendimento: chat interno com menções e referências (R15)');
  const geral = (await admin.get('/chat/canais')).find(
    (c) => c.tipo === 'GERAL',
  );
  const mensagensGeral = await admin.get(`/chat/canais/${geral.id}/mensagens`);
  if ((mensagensGeral.itens ?? mensagensGeral).length === 0) {
    const eu = (sessao) => sessao.usuario.id;
    const mencao = (chave) => `<@${eq[chave].usuario.id}>`;
    const enviarChat = (sessao, canalId, texto, extra = {}) =>
      sessao.post(`/chat/canais/${canalId}/mensagens`, { texto, ...extra });

    await enviarChat(
      admin,
      geral.id,
      'Bem-vindos ao chat da equipe! Aqui ficam os avisos gerais. Para falar com uma pessoa, use uma conversa direta.',
    );
    await enviarChat(
      eq.liderComercial,
      geral.id,
      `Bom dia, time! Reunião de pipeline hoje às 10h. ${mencao('comercial1')} e ${mencao('comercial2')}, tragam os negócios em proposta.`,
    );
    await enviarChat(
      eq.liderCs,
      geral.id,
      `${mencao('cs1')} ${mencao('cs2')}: o Suporte CS agora recebe pelo WhatsApp Suporte e pelo Messenger. Vejam a fila "Suporte CS".`,
    );
    await enviarChat(
      eq.comercial1,
      geral.id,
      'Ok! Já estou com 3 propostas em andamento.',
    );

    const meusCanais = async (sessao) => sessao.get('/chat/canais');
    const canalComercial = (await meusCanais(eq.liderComercial)).find(
      (c) => c.tipo === 'AREA',
    );
    if (canalComercial) {
      const negocios = await eq.comercial2
        .get(`/negocios${consultar({ porPagina: 1 })}`)
        .catch(() => null);
      const negocio = negocios?.itens?.[0];
      await enviarChat(
        eq.liderComercial,
        canalComercial.id,
        `${mencao('comercial2')} o cliente da Marina Albuquerque pediu proposta até sexta — pode assumir?`,
      );
      await enviarChat(
        eq.comercial2,
        canalComercial.id,
        negocio
          ? `Assumo! Já vou ligar a conversa ao negócio <negocio:${negocio.id}>.`
          : 'Assumo! Já vou ligar a conversa a um negócio.',
      );
    }

    const grupos = await eq.marketing1.get('/chat/canais');
    if (
      !grupos.some(
        (g) => g.tipo === 'GRUPO' && g.nome === 'Campanha Black Friday',
      )
    ) {
      const grupo = await eq.marketing1.post('/chat/grupos', {
        nome: 'Campanha Black Friday',
        descricao: 'Planejamento e acompanhamento da campanha de novembro.',
        membrosIds: [
          eu(eq.marketing2),
          eu(eq.liderMarketing),
          eu(eq.comercial1),
        ],
      });
      await enviarChat(
        eq.marketing1,
        grupo.id,
        `${mencao('marketing2')} pode subir os criativos até quarta? ${mencao('comercial1')} vai alinhar a oferta com o time comercial.`,
      );
      await enviarChat(
        eq.marketing2,
        grupo.id,
        'Subo na terça. Vou usar o lead magnet novo na landing.',
      );
      await enviarChat(
        eq.liderMarketing,
        grupo.id,
        'Perfeito. Qualquer bloqueio me avisem por aqui.',
      );
    }

    const { canal: direta } = await eq.comercial1.post('/chat/diretas', {
      usuarioId: eu(eq.liderComercial),
    });
    await enviarChat(
      eq.comercial1,
      direta.id,
      'Rafael, você consegue olhar a proposta da Marina antes de eu enviar?',
    );
    await enviarChat(
      eq.liderComercial,
      direta.id,
      'Consigo sim. Me manda por aqui que eu reviso em 10 minutos.',
    );
    nota(
      'mensagens no Geral, no canal Comercial, no grupo "Campanha Black Friday" e numa conversa direta (privada)',
    );
  } else {
    nota('O chat interno já tem mensagens: nada a fazer');
  }

  // --------------------------------------------------------------- fim ---
  for (const sessao of Object.values(eq)) {
    try {
      await sessao.post('/auth/sair');
    } catch {
      // sessão já encerrada
    }
  }
  const metricas = await (async () => {
    try {
      const novo = await entrar(ADMIN_EMAIL, SENHA_ADMIN);
      const resposta = await novo.get('/atendimento/metricas');
      await novo.post('/auth/sair');
      return resposta;
    } catch {
      return null;
    }
  })();
  nota(
    `métricas do Atendimento: ${metricas ? JSON.stringify(metricas).slice(0, 200) : 'indisponíveis'}`,
  );
  console.log('\n✓ Atendimento semeado.\n');
  console.log('Canais:');
  for (const canal of Object.values(canais)) {
    console.log(
      `  ${canal.tipo.padEnd(10)} ${canal.nome}${canal.numeroId ? `  (numeroId ${canal.numeroId})` : ''}${canal.chave ? `  (chave ${canal.chave})` : ''}`,
    );
  }
  console.log(`\nSimular um cliente no WhatsApp (gateway simulado):`);
  console.log(
    `  curl -X POST -H "X-Token-Interno: $WHATSAPP_TOKEN_INTERNO" -H 'Content-Type: application/json' \\`,
  );
  console.log(
    `    -d '{"numeroId":"${canais.wppVendas.numeroId}","de":"11999990001","nome":"Fulano","texto":"Oi"}' ${GATEWAY_URL}/simulador/receber`,
  );
}

// ================================================== Etapa: onda-b ===
//
// Importação, disparos, chatbot e automações (Onda B). Roda sobre a base já semeada
// (ou logo depois da semeadura completa) e pode ser repetida: cada peça só é criada
// se ainda não existir (por nome).
//
//   node scripts/semear-demonstracao.mjs onda-b      (ou SEMEAR_ETAPA=onda-b)
//
// Variáveis: as do atendimento (WHATSAPP_TOKEN_INTERNO, GATEWAY_URL) e
//   SEMEAR_ONDA_B  "false" pula a etapa na semeadura completa

const RODAR_ONDA_B = AMBIENTE.SEMEAR_ONDA_B !== 'false';

/** Envia um arquivo (multipart, campo "arquivo") ao contexto indicado. */
async function enviarArquivo(sessao, contexto, nome, mime, conteudo) {
  const formulario = new FormData();
  formulario.append('arquivo', new Blob([conteudo], { type: mime }), nome);
  const resposta = await fetch(`${API}/api/v1/arquivos?contexto=${contexto}`, {
    method: 'POST',
    headers: { Origin: ORIGEM, Cookie: sessao.cookie },
    body: formulario,
  });
  const dados = await lerCorpo(resposta);
  if (!resposta.ok)
    throw new ErroDaApi('POST', '/arquivos', resposta.status, dados);
  return dados;
}

async function etapaOndaB() {
  passo('Onda B: entrando com a equipe');
  const entradas = {
    admin: [ADMIN_EMAIL, SENHA_ADMIN],
    liderComercial: [email('lider.comercial'), SENHA_USUARIOS],
    liderCs: [email('lider.cs'), SENHA_USUARIOS],
  };
  const eq = {};
  for (const [chave, [endereco, senha]] of Object.entries(entradas)) {
    try {
      eq[chave] = await entrar(endereco, senha);
    } catch (erro) {
      parar(
        `A etapa "onda-b" roda sobre a base semeada: não consegui entrar como ${endereco} (${erro.message}).`,
      );
    }
  }
  const { admin, liderComercial: lider } = eq;
  const itens = (r) => (Array.isArray(r) ? r : (r?.itens ?? []));
  const etapa = await lerFunis(admin);

  // ------------------------------------------------------- importação ---
  passo(
    'Onda B: importação (R16): modelo de mapeamento e uma importação concluída',
  );
  const modelos = itens(await lider.get('/importacoes/modelos'));
  const mapeamentoPadrao = {
    Nome: 'nome',
    'E-mail': 'email',
    Celular: 'telefone',
    Cargo: 'cargo',
    Empresa: 'empresa',
    Etiquetas: 'etiquetas',
  };
  let modelo = modelos.find((m) => m.nome === 'Lista de feira (padrão)');
  if (!modelo) {
    modelo = await lider.post('/importacoes/modelos', {
      nome: 'Lista de feira (padrão)',
      tipo: 'CONTATOS',
      mapeamento: mapeamentoPadrao,
      opcoes: { duplicados: 'ATUALIZAR_VAZIOS', etiquetas: ['Feira 2026'] },
    });
    nota('modelo "Lista de feira (padrão)" criado');
  } else {
    nota('modelo de importação já existe');
  }
  const importacoes = itens(await lider.get('/importacoes?porPagina=50'));
  if (importacoes.some((i) => i.status === 'CONCLUIDA')) {
    nota('já existe importação concluída');
  } else {
    const linhas = [
      'Nome;E-mail;Celular;Cargo;Empresa;Etiquetas',
      'Aline Moreira;aline.moreira@feira-demo.example.com;(11) 97100-2001;Diretora comercial;Moreira Alimentos;Feira 2026',
      'Bruno Casagrande;bruno.casagrande@feira-demo.example.com;(11) 97100-2002;Gerente de TI;Casagrande Logística;Feira 2026',
      'Cintia Vasconcelos;cintia.v@feira-demo.example.com;(21) 97100-2003;Sócia;Vasconcelos Design;Feira 2026',
      'Daniel Pires;daniel.pires@feira-demo.example.com;(31) 97100-2004;Comprador;Pires Materiais;',
      'Elisa Tanaka;elisa.tanaka@feira-demo.example.com;(41) 97100-2005;CEO;Tanaka Tech;Feira 2026',
      'Fabio Lacerda;fabio.lacerda@feira-demo.example.com;(51) 97100-2006;Analista;Lacerda & Filhos;Feira 2026',
      'Contato sem e-mail nem telefone;;;Assistente;Sem Dados Ltda;',
      'Aline Moreira (repetida);aline.moreira@feira-demo.example.com;(11) 97100-2001;Diretora;Moreira Alimentos;',
      'Gisele Barros;e-mail-invalido;(61) 97100-2007;Gerente;Barros Consultoria;Feira 2026',
    ];
    const arquivo = await enviarArquivo(
      lider,
      'IMPORTACAO',
      'lista-feira-2026.csv',
      'text/csv',
      `﻿${linhas.join('\n')}\n`,
    );
    const rascunho = await lider.post('/importacoes', {
      tipo: 'CONTATOS',
      arquivoId: arquivo.id,
    });
    await lider.patch(`/importacoes/${rascunho.id}`, {
      modeloId: modelo.id,
      origemDetalhe: 'Feira de negócios 2026',
    });
    await lider.post(`/importacoes/${rascunho.id}/iniciar`);
    const final = await esperarAte(
      'a importação terminar',
      async () => {
        const atual = await lider.get(`/importacoes/${rascunho.id}`);
        return ['CONCLUIDA', 'FALHOU', 'CANCELADA'].includes(atual.status)
          ? atual
          : null;
      },
      { ms: 60_000 },
    );
    nota(
      `importação "${final.status}": ${final.criados} criados, ${final.atualizados} atualizados, ${final.erros} com erro`,
    );
  }

  // ---------------------------------------------------------- disparos ---
  passo('Onda B: disparos (R17): campanhas em vários estados');
  const numerosWhats = await admin.get('/whatsapp/numeros');
  const numero =
    itens(numerosWhats).find(
      (n) =>
        n.status === 'CONECTADO' && /vendas/i.test(n.nome ?? n.apelido ?? ''),
    ) ?? itens(numerosWhats).find((n) => n.status === 'CONECTADO');
  if (!numero)
    parar('Nenhum número de WhatsApp conectado (rode a etapa atendimento).');
  const campanhas = itens(await lider.get('/disparos/campanhas?porPagina=100'));
  const jaTem = (nome) => campanhas.find((c) => c.nome === nome);

  const etiqueta = (nome) => ({
    condicoes: [
      { campo: 'etiquetas', operador: 'contem_alguma', valor: [nome] },
    ],
  });
  async function contatosDaCampanha(rotulo, quantidade, base) {
    const lista = [];
    for (let i = 0; i < quantidade; i++) {
      const numeroTel = `${base + i}`;
      const nome = `${rotulo} ${String(i + 1).padStart(2, '0')}`;
      const { contato } = await lider.post('/contatos', {
        nome,
        telefone: numeroTel,
        origem: 'MANUAL',
        etiquetas: [rotulo],
        consentimento: {
          origem: 'Cadastro de demonstração',
          em: new Date().toISOString(),
        },
      });
      lista.push(contato);
    }
    return lista;
  }
  const ritmo = (min, max) => ({
    intervaloMinimoSegundos: min,
    intervaloMaximoSegundos: max,
    simularDigitando: true,
    pausarAposFalhas: 5,
  });

  // 1. Rascunho
  if (!jaTem('Reengajamento de leads frios')) {
    await lider.post('/disparos/campanhas', {
      nome: 'Reengajamento de leads frios',
      descricao: 'Rascunho: ainda falta escolher o público e o texto final.',
      canal: 'WHATSAPP',
      canalIds: [numero.canalId],
      tipoPublico: 'SEGMENTO',
      segmento: {
        condicoes: [
          {
            campo: 'etiquetas',
            operador: 'contem_alguma',
            valor: ['Lead frio'],
          },
        ],
      },
      texto:
        'Oi {{contato.primeiro_nome|tudo bem}}! {Faz tempo que não falamos|Sentimos sua falta}. Posso te mostrar as novidades?',
      ...ritmo(30, 60),
    });
    nota('rascunho "Reengajamento de leads frios"');
  }

  // 2. Agendada (amanhã às 10h)
  if (!jaTem('Convite para o webinar de março')) {
    const rotulo = 'Webinar Onda B';
    await contatosDaCampanha(rotulo, 5, 11970013000);
    const criada = await lider.post('/disparos/campanhas', {
      nome: 'Convite para o webinar de março',
      descricao: 'Agendada para amanhã às 10h.',
      canal: 'WHATSAPP',
      canalIds: [numero.canalId],
      tipoPublico: 'SEGMENTO',
      segmento: etiqueta(rotulo),
      texto:
        'Olá, {{contato.primeiro_nome}}! Vamos falar de {automação|organização} comercial no nosso webinar. Responda SAIR para não receber mais.',
      janelaEnvio: {
        fusoHorario: 'America/Sao_Paulo',
        dias: Object.fromEntries(
          [1, 2, 3, 4, 5].map((d) => [
            String(d),
            [{ inicio: '09:00', fim: '18:00' }],
          ]),
        ),
      },
      ...ritmo(30, 60),
    });
    await lider.post(`/disparos/campanhas/${criada.id}/iniciar`, {
      agendadaPara: new Date(diaEm(1, 10)).toISOString(),
    });
    nota('agendada "Convite para o webinar de março"');
  }

  // 3. Em andamento (ritmo lento: continua enviando durante a demonstração)
  if (!jaTem('Oferta de renovação antecipada')) {
    const rotulo = 'Renovação Onda B';
    await contatosDaCampanha(rotulo, 14, 11970014000);
    const criada = await lider.post('/disparos/campanhas', {
      nome: 'Oferta de renovação antecipada',
      descricao: 'Em andamento, com intervalos longos (anti-banimento).',
      canal: 'WHATSAPP',
      canalIds: [numero.canalId],
      tipoPublico: 'SEGMENTO',
      segmento: etiqueta(rotulo),
      texto:
        'Oi, {{contato.primeiro_nome}}! Quem renova até o fim do mês ganha {10%|um mês} de desconto. Quer saber mais?',
      ...ritmo(90, 150),
    });
    await lider.post(`/disparos/campanhas/${criada.id}/iniciar`, {});
    nota(
      'em andamento "Oferta de renovação antecipada" (14 contatos, 90–150 s entre envios)',
    );
  }

  // 4. Concluída com respostas e saídas
  if (!jaTem('Pesquisa de satisfação — outubro')) {
    const rotulo = 'Pesquisa Onda B';
    const lista = await contatosDaCampanha(rotulo, 6, 11970015000);
    const criada = await lider.post('/disparos/campanhas', {
      nome: 'Pesquisa de satisfação — outubro',
      descricao: 'Concluída: duas respostas e uma saída (SAIR).',
      canal: 'WHATSAPP',
      canalIds: [numero.canalId],
      tipoPublico: 'SEGMENTO',
      segmento: etiqueta(rotulo),
      texto:
        'Olá, {{contato.primeiro_nome}}! De 0 a 10, quanto você recomendaria a BRL a um colega?',
      ...ritmo(1, 2),
    });
    await lider.post(`/disparos/campanhas/${criada.id}/iniciar`, {});
    await esperarAte(
      'a campanha de pesquisa concluir',
      async () =>
        (await lider.get(`/disparos/campanhas/${criada.id}`)).status ===
        'CONCLUIDA',
      { ms: 120_000, passo: 2_000 },
    );
    await simularWhatsapp(
      numero.id,
      '11970015000',
      lista[0].nome,
      'Dez! Atendimento nota 10.',
    );
    await esperar(800);
    await simularWhatsapp(
      numero.id,
      '11970015001',
      lista[1].nome,
      'Nota 8, mas o suporte poderia ser mais rápido.',
    );
    await esperar(800);
    await simularWhatsapp(numero.id, '11970015002', lista[2].nome, 'SAIR');
    await esperar(2_500);
    const relatorio = await lider.get(
      `/disparos/campanhas/${criada.id}/relatorio`,
    );
    nota(
      `concluída "Pesquisa de satisfação — outubro": ${relatorio.contadores?.enviados} enviados, ${relatorio.contadores?.respondidos} respostas, ${relatorio.contadores?.optOuts} saída`,
    );
  }

  // ----------------------------------------------------------- chatbot ---
  passo('Onda B: chatbot (R18): fluxos de atendimento');
  const fluxos = itens(await lider.get('/chatbot/fluxos?porPagina=100'));
  const filas = await admin.get('/atendimento/filas');
  const fila = (nome) => filas.find((f) => f.nome === nome)?.id;
  const canaisAt = itens(await admin.get('/atendimento/canais'));
  const canalDe = (nome) => canaisAt.find((c) => c.nome === nome)?.id;
  if (!fluxos.some((f) => f.nome === 'Boas-vindas do site')) {
    const definicao = {
      passos: [
        {
          id: 'oi',
          tipo: 'mensagem',
          config: {
            texto: 'Olá! Eu sou o assistente da BRL. Como posso ajudar?',
          },
        },
        {
          id: 'menu',
          tipo: 'pergunta.opcoes',
          rotulo: 'Menu inicial',
          config: {
            texto: 'Escolha uma opção:',
            variavel: 'assunto',
            tentativas: 2,
            mensagemInvalida: 'Não entendi. Responda com o número da opção.',
            opcoes: [
              { id: 'comercial', rotulo: 'Quero conhecer os planos' },
              { id: 'suporte', rotulo: 'Preciso de suporte' },
              { id: 'outro', rotulo: 'Outro assunto' },
            ],
            tempoSemResposta: {
              lembreteAposMinutos: 10,
              lembrete: 'Ainda por aí? Escolha uma opção para continuarmos.',
              encerrarAposMinutos: 30,
            },
          },
          ramos: [
            {
              id: 'comercial',
              rotulo: 'Quero conhecer os planos',
              passos: [
                {
                  id: 'nome',
                  tipo: 'pergunta.aberta',
                  config: {
                    texto: 'Perfeito! Qual é o seu nome?',
                    variavel: 'nome',
                    campoContato: 'nome',
                  },
                },
                {
                  id: 'etq',
                  tipo: 'acao.etiquetar',
                  config: { etiquetas: ['Lead do chatbot'] },
                },
                {
                  id: 'vai_vendas',
                  tipo: 'transferir',
                  config: {
                    mensagem: 'Obrigado! Vou chamar um consultor comercial.',
                    filaId: fila('Vendas'),
                    incluirResumo: true,
                  },
                },
              ],
            },
            {
              id: 'suporte',
              rotulo: 'Preciso de suporte',
              passos: [
                {
                  id: 'vai_suporte',
                  tipo: 'transferir',
                  config: {
                    mensagem: 'Certo, vou chamar o suporte.',
                    filaId: fila('Suporte CS'),
                    incluirResumo: true,
                  },
                },
              ],
            },
            {
              id: 'outro',
              rotulo: 'Outro assunto',
              passos: [
                {
                  id: 'descricao',
                  tipo: 'pergunta.aberta',
                  config: {
                    texto: 'Conte em uma frase o que você precisa.',
                    variavel: 'descricao',
                  },
                },
                {
                  id: 'vai_triagem',
                  tipo: 'transferir',
                  config: {
                    mensagem:
                      'Anotado! Alguém da equipe responde em instantes.',
                    filaId: fila('Triagem do site'),
                    incluirResumo: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const canaisIds = [
      canalDe('Chat do site'),
      canalDe('WhatsApp Suporte'),
    ].filter(Boolean);
    const criado = await lider.post('/chatbot/fluxos', {
      nome: 'Boas-vindas do site',
      descricao:
        'Menu inicial: planos, suporte ou outro assunto, com transferência para a fila certa.',
      area: 'COMERCIAL',
      canalIds: canaisIds,
      gatilho: 'NOVA_CONVERSA',
      prioridade: 10,
      definicao,
    });
    await lider.post(`/chatbot/fluxos/${criado.id}/publicar`, {});
    await lider.post(`/chatbot/fluxos/${criado.id}/ativar`, {});
    nota(
      'fluxo "Boas-vindas do site" publicado e ativo (Chat do site e WhatsApp Suporte)',
    );
  }
  if (!fluxos.some((f) => f.nome === 'Segunda via de boleto')) {
    await lider.post('/chatbot/fluxos', {
      nome: 'Segunda via de boleto',
      descricao:
        'Rascunho: dispara pela palavra "boleto" e transfere ao suporte.',
      area: 'COMERCIAL',
      gatilho: 'PALAVRA_CHAVE',
      palavrasChave: ['boleto', 'segunda via'],
      prioridade: 20,
      definicao: {
        passos: [
          {
            id: 'msg',
            tipo: 'mensagem',
            config: { texto: 'Vou te ajudar com o boleto.' },
          },
          {
            id: 'cpf',
            tipo: 'pergunta.aberta',
            config: {
              texto: 'Qual é o seu e-mail de cadastro?',
              variavel: 'email_cadastro',
              validacao: 'EMAIL',
            },
          },
          {
            id: 'fim',
            tipo: 'transferir',
            config: { filaId: fila('Suporte CS'), incluirResumo: true },
          },
        ],
      },
    });
    nota('rascunho "Segunda via de boleto"');
  }
  // Uma conversa de verdade no chat do site, para o histórico de execuções
  const fluxoAtivo = itens(
    await lider.get('/chatbot/fluxos?porPagina=100'),
  ).find((f) => f.nome === 'Boas-vindas do site');
  if (fluxoAtivo) {
    const execs = itens(
      await lider.get(`/chatbot/fluxos/${fluxoAtivo.id}/execucoes`),
    );
    if (execs.length === 0) {
      const siteCanalId = canalDe('Chat do site');
      const chave = (await admin.get(`/webchat/canais/${siteCanalId}`))
        .chavePublica;
      for (const [nome, textos] of [
        [
          'Visitante Onda B Planos',
          ['Oi, quero saber dos planos', '1', 'Marcelo Prado'],
        ],
        ['Visitante Onda B Suporte', ['Bom dia', '2']],
      ]) {
        const criado = await widget(chave, '/visitantes', {
          nome,
          email: `${nome.toLowerCase().replace(/\s+/g, '.')}@exemplo.com.br`,
          consentimento: true,
          pagina: 'https://www.brl-demo.local/precos',
        });
        const token =
          criado.token ?? criado.visitanteToken ?? criado.visitanteId;
        for (const texto of textos) {
          await widget(chave, '/mensagens', { token, texto });
          await esperar(1_200);
        }
      }
      nota(
        '2 conversas de visitante passaram pelo fluxo (histórico de execuções)',
      );
    }
  }

  // --------------------------------------------------------- automações ---
  passo('Onda B: automações (R19)');
  const automacoes = itens(await lider.get('/automacoes?porPagina=100'));
  const modeloPronto = async (chave, dados) => {
    const existente = automacoes.find((a) => a.nome === (dados.nome ?? ''));
    if (existente) return existente;
    return lider.post(`/automacoes/modelos-prontos/${chave}`, dados);
  };
  const boasVindas = await modeloPronto('boas_vindas_lead', {
    nome: 'Boas-vindas ao lead',
    area: 'COMERCIAL',
  });
  const followUp = await modeloPronto('follow_up_proposta', {
    nome: 'Follow-up de proposta',
    area: 'COMERCIAL',
    gatilhoConfig: { etapaId: etapa('COMERCIAL', 'proposta') },
  });
  for (const automacao of [boasVindas, followUp]) {
    if (!automacao.ativa) {
      await lider.post(`/automacoes/${automacao.id}/ativar`, {});
      nota(`"${automacao.nome}" ativada`);
    }
  }
  const execucoesAnt = itens(
    await lider.get(`/automacoes/execucoes?automacaoId=${boasVindas.id}`),
  );
  if (execucoesAnt.length === 0) {
    // Leads novos disparam a automação de boas-vindas; um negócio na Proposta dispara o follow-up.
    const novos = [];
    for (const [nome, tel] of [
      ['Lead Onda B Patricia Alves', '11970016001'],
      ['Lead Onda B Renato Siqueira', '11970016002'],
      ['Lead Onda B Tatiane Gomes', '11970016003'],
    ]) {
      const { contato } = await lider.post('/contatos', {
        nome,
        telefone: tel,
        origem: 'SITE',
        etiquetas: ['Lead Onda B'],
      });
      novos.push(contato);
      await esperar(500);
    }
    const negocio = await lider.post('/negocios', {
      contatoId: novos[0].id,
      funilId: funis.COMERCIAL.id,
      titulo: 'Onda B — proposta Alves Consultoria',
    });
    await lider.post(`/negocios/${negocio.id}/mover`, {
      etapaId: etapa('COMERCIAL', 'proposta'),
    });
    // Uma execução em modo teste, já terminada, para mostrar o resultado passo a passo.
    await lider.post(`/automacoes/${boasVindas.id}/testar`, {
      entidadeId: novos[2].id,
    });
    await esperar(6_000);
    nota('3 leads novos + 1 negócio na Proposta + 1 execução em modo teste');
  } else {
    nota('automações já têm histórico');
  }
  console.log('\n✓ Etapa onda-b concluída.');
}

async function principal() {
  console.log(
    `Semeando a demonstração do BRL CRM em ${API} (origem ${ORIGEM})`,
  );

  if (ETAPA === 'onda-b') {
    passo('Verificando a API');
    await verificarApi();
    await etapaOndaB();
    return;
  }

  if (ETAPA === 'atendimento') {
    // Só a etapa de atendimento, sobre a base já semeada (idempotente).
    passo('Verificando a API');
    await verificarApi();
    await etapaAtendimento();
    return;
  }

  passo('Verificando a API e a base');
  await verificarApi();
  const admin = await prepararAdmin();

  passo('Criando a equipe (um usuário por papel, hierarquia R1.2)');
  await criarEquipe(admin);

  passo('Lendo os funis-base e ajustando as probabilidades do Comercial');
  const etapa = await lerFunis(admin);
  const FC = funis.COMERCIAL.id;
  const FM = funis.MARKETING.id;
  const FS = funis.CS.id;
  for (const [chave, probabilidade] of [
    ['qualificacao', 20],
    ['apresentacao', 40],
    ['proposta', 60],
    ['negociacao', 80],
  ]) {
    await s('liderComercial').patch(
      `/funis/${FC}/etapas/${etapa('COMERCIAL', chave)}`,
      { probabilidade },
    );
  }
  nota(
    'Qualificação 20%, Apresentação 40%, Proposta 60%, Negociação 80% (por Rafael, líder comercial)',
  );

  // Os destinos de saída vêm antes de tudo para receberem os eventos da semeadura.
  passo('Webhooks de saída');
  const saidas = [];
  if (WEBHOOK_SAIDA_URL) {
    const { webhook } = await admin.post('/webhooks/saidas', {
      nome: 'Receptor de testes (dev)',
      url: WEBHOOK_SAIDA_URL,
      eventos: [
        'contato.criado',
        'contato.atualizado',
        'negocio.criado',
        'negocio.movido',
        'negocio.ganho',
        'negocio.perdido',
        'atividade.criada',
        'atividade.concluida',
        'usuario.desligado',
      ],
      cabecalhos: { Authorization: 'Bearer token-de-demonstracao' },
    });
    saidas.push(webhook);
    nota(`"${webhook.nome}" ativo → ${WEBHOOK_SAIDA_URL}`);
  } else {
    const { webhook } = await admin.post('/webhooks/saidas', {
      nome: 'TicketHub (exemplo, desativado)',
      url: 'https://example.com/webhooks/brl-crm',
      eventos: ['negocio.ganho', 'usuario.desligado'],
      ativo: false,
    });
    saidas.push(webhook);
    nota(
      `"${webhook.nome}" criado DESATIVADO (sem SEMEAR_WEBHOOK_SAIDA_URL): nada é enviado`,
    );
  }
  if (WEBHOOK_SAIDA_FALHA_URL) {
    const { webhook } = await admin.post('/webhooks/saidas', {
      nome: 'Destino com falha (dev)',
      url: WEBHOOK_SAIDA_FALHA_URL,
      eventos: ['negocio.perdido'],
    });
    saidas.push(webhook);
    nota(
      `"${webhook.nome}" → ${WEBHOOK_SAIDA_FALHA_URL} (responde erro: tentativas R9.4)`,
    );
  }

  passo('Empresas');
  const empresas = {};
  const novaEmpresa = async (chave, quem, dados) => {
    empresas[chave] = await s(quem).post('/empresas', dados);
    nota(`${dados.nome} (${pessoas[quem].usuario.nome})`);
  };
  await novaEmpresa('horizonte', 'liderComercial', {
    nome: 'Construtora Horizonte S.A.',
    cnpj: cnpj('34851277'),
    site: 'https://horizonte.example.com.br',
    email: 'compras@horizonte.example.com.br',
    telefone: '(31) 3333-4100',
    segmento: 'Construção civil',
    cidade: 'Belo Horizonte',
    uf: 'MG',
    etiquetas: ['Grande conta', 'Prospect'],
    camposPersonalizados: {
      funcionarios: 320,
      faturamentoAnual: 'R$ 40 milhões',
    },
  });
  await novaEmpresa('padaria', 'comercial1', {
    nome: 'Padaria Pão Dourado Ltda',
    cnpj: cnpj('12457893'),
    telefone: '(11) 3222-1100',
    segmento: 'Alimentação',
    cidade: 'São Paulo',
    uf: 'SP',
    etiquetas: ['Pequena empresa'],
  });
  await novaEmpresa('clinica', 'comercial2', {
    nome: 'Clínica Vida Plena',
    cnpj: cnpj('45120988'),
    site: 'https://vidaplena.example.com.br',
    email: 'administrativo@vidaplena.example.com.br',
    segmento: 'Saúde',
    cidade: 'Curitiba',
    uf: 'PR',
    etiquetas: ['Prospect'],
  });
  await novaEmpresa('technova', 'marketing1', {
    nome: 'TechNova Sistemas',
    site: 'https://technova.example.com',
    segmento: 'Tecnologia',
    cidade: 'Florianópolis',
    uf: 'SC',
    etiquetas: ['Cliente', 'SaaS'],
  });
  await novaEmpresa('modabella', 'desligado', {
    nome: 'Moda Bella Confecções',
    cnpj: cnpj('27654310'),
    segmento: 'Varejo de moda',
    cidade: 'Fortaleza',
    uf: 'CE',
  });
  await novaEmpresa('escola', 'cs1', {
    nome: 'Escola Saber Mais',
    cnpj: cnpj('19283746'),
    email: 'secretaria@sabermais.example.com.br',
    segmento: 'Educação',
    cidade: 'Salvador',
    uf: 'BA',
    etiquetas: ['Cliente'],
  });
  await novaEmpresa('agrovale', 'liderComercial', {
    nome: 'AgroVale Insumos',
    cnpj: cnpj('56473829'),
    segmento: 'Agronegócio',
    cidade: 'Goiânia',
    uf: 'GO',
    etiquetas: ['Grande conta'],
  });
  await novaEmpresa('studiofit', 'marketing2', {
    nome: 'Studio Fit Academia',
    segmento: 'Fitness',
    cidade: 'Rio de Janeiro',
    uf: 'RJ',
  });

  passo('Contatos (origens e UTMs variadas, R4.3)');
  const contatos = {};
  const novoContato = async (chave, quem, dados) => {
    const { criado, contato } = await s(quem).post('/contatos', dados);
    contatos[chave] = contato;
    nota(
      `${criado ? 'novo' : 'reconvertido (R4.2)'}: ${contato.nome} — ${dados.origem ?? 'MANUAL'} (${pessoas[quem].usuario.nome})`,
    );
    return contato;
  };
  const consentimentoSite = {
    origem: 'Formulário do site',
    em: horasAtras(30),
  };
  // Leads do Marketing
  await novoContato('ana', 'marketing1', {
    nome: 'Ana Beatriz Lopes',
    email: 'ana.lopes@clinicavidaplena.example.com.br',
    telefone: '(41) 98877-1201',
    cargo: 'Gerente administrativa',
    empresaId: empresas.clinica.id,
    origem: 'SITE',
    origemDetalhe: 'Formulário "Fale com um especialista"',
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'crm-saude',
      term: 'crm para clínicas',
    },
    etiquetas: ['Lead quente'],
    consentimento: consentimentoSite,
  });
  await novoContato('carlos', 'marketing1', {
    nome: 'Carlos Eduardo Nunes',
    email: 'carlos.nunes@technova.example.com',
    cargo: 'Head de vendas',
    empresaId: empresas.technova.id,
    origem: 'SITE',
    utm: {
      source: 'linkedin',
      medium: 'paid-social',
      campaign: 'webinar-vendas-b2b',
      content: 'carrossel',
    },
    etiquetas: ['Webinar'],
    consentimento: consentimentoSite,
  });
  await novoContato('patricia', 'marketing2', {
    nome: 'Patrícia Gomes',
    telefone: '(85) 98765-1302',
    empresaId: empresas.modabella.id,
    cargo: 'Sócia',
    origem: 'WHATSAPP',
    origemDetalhe: 'Clique no anúncio para WhatsApp',
    utm: {
      source: 'instagram',
      medium: 'paid-social',
      campaign: 'colecao-verao',
    },
  });
  await novoContato('roberto', 'marketing2', {
    nome: 'Roberto Almeida',
    email: 'roberto.almeida@agrovale.example.com.br',
    telefone: '(62) 99812-1403',
    cargo: 'Diretor comercial',
    empresaId: empresas.agrovale.id,
    origem: 'SITE',
    utm: { source: 'google', medium: 'organic' },
    etiquetas: ['Agro'],
  });
  await novoContato('juliana', 'marketing1', {
    nome: 'Juliana Freitas',
    email: 'juliana.freitas@studiofit.example.com.br',
    telefone: '(21) 98123-1504',
    empresaId: empresas.studiofit.id,
    origem: 'SITE',
    utm: {
      source: 'facebook',
      medium: 'paid-social',
      campaign: 'black-friday',
      content: 'video-15s',
    },
    etiquetas: ['Black Friday'],
  });
  await novoContato('marcos', 'liderMarketing', {
    nome: 'Marcos Vinícius Prado',
    email: 'marcos.prado@horizonte.example.com.br',
    cargo: 'Coordenador de suprimentos',
    empresaId: empresas.horizonte.id,
    origem: 'OUTRO',
    origemDetalhe: 'Feira Construir 2026',
    etiquetas: ['Evento'],
  });
  await novoContato('sofia', 'marketing2', {
    nome: 'Sofia Martins',
    email: 'sofia.martins@gmail.example.com',
    telefone: '(51) 99654-1606',
    origem: 'SITE',
    utm: {
      source: 'newsletter',
      medium: 'email',
      campaign: 'novidades-outubro',
    },
    optOutMarketing: true,
    consentimento: { origem: 'Newsletter', em: horasAtras(24 * 40) },
  });
  await novoContato('eduardo', 'marketing1', {
    nome: 'Eduardo Ramos',
    email: 'eduardo@distribuidorasol.example.com.br',
    telefone: '(71) 98432-1707',
    empresaNome: 'Distribuidora Sol Nascente',
    cargo: 'Proprietário',
    origem: 'SITE',
    utm: { source: 'google', medium: 'cpc', campaign: 'crm-distribuidoras' },
  });
  await novoContato('larissa', 'marketing2', {
    nome: 'Larissa Teixeira',
    email: 'larissa.teixeira@outlook.example.com',
    origem: 'OUTRO',
    origemDetalhe: 'Lista de e-mails comprada (descartar)',
  });
  await novoContato('gustavo', 'marketing1', {
    nome: 'Gustavo Henrique Silva',
    email: 'gustavo.silva@padariapaodourado.example.com.br',
    telefone: '(11) 97654-1809',
    empresaId: empresas.padaria.id,
    cargo: 'Gerente',
    origem: 'SITE',
    utm: { source: 'google', medium: 'cpc', campaign: 'crm-varejo' },
  });
  // Contatos do Comercial e do CS
  await novoContato('fernando', 'comercial1', {
    nome: 'Fernando Oliveira',
    email: 'fernando@padariapaodourado.example.com.br',
    telefone: '(11) 98111-2101',
    empresaId: empresas.padaria.id,
    cargo: 'Sócio-diretor',
    origem: 'INDICACAO',
    origemDetalhe: 'Indicação de Gustavo (gerente da padaria)',
  });
  await novoContato('beatriz', 'comercial2', {
    nome: 'Beatriz Cardoso',
    email: 'beatriz.cardoso@vidaplena.example.com.br',
    telefone: '(41) 3021-2202',
    empresaId: empresas.clinica.id,
    cargo: 'Diretora clínica',
    origem: 'MANUAL',
  });
  await novoContato('ricardo', 'liderComercial', {
    nome: 'Ricardo Bastos',
    email: 'ricardo.bastos@horizonte.example.com.br',
    telefone: '(31) 99876-2303',
    empresaId: empresas.horizonte.id,
    cargo: 'CFO',
    origem: 'INDICACAO',
    origemDetalhe: 'Indicação da diretoria',
    etiquetas: ['Decisor'],
  });
  await novoContato('aline', 'comercial2', {
    nome: 'Aline Moreira',
    email: 'aline.moreira@agrovale.example.com.br',
    empresaId: empresas.agrovale.id,
    cargo: 'Gerente de TI',
    origem: 'MANUAL',
  });
  await novoContato('vanessa', 'desligado', {
    nome: 'Vanessa Rocha',
    email: 'vanessa@modabella.example.com.br',
    telefone: '(85) 99123-2505',
    empresaId: empresas.modabella.id,
    cargo: 'Compradora',
    origem: 'WHATSAPP',
  });
  await novoContato('henrique', 'desligado', {
    nome: 'Henrique Barros',
    email: 'henrique.barros@lojasbarros.example.com.br',
    empresaNome: 'Lojas Barros',
    origem: 'INDICACAO',
  });
  await novoContato('paulo', 'comercial1', {
    nome: 'Paulo César Araújo',
    email: 'paulo.araujo@ferragensaraujo.example.com.br',
    telefone: '(19) 98234-2707',
    empresaNome: 'Ferragens Araújo',
    origem: 'MANUAL',
  });
  await novoContato('renata', 'comercial2', {
    nome: 'Renata Figueiredo',
    email: 'renata@figueiredoadvocacia.example.com.br',
    empresaNome: 'Figueiredo Advocacia',
    cargo: 'Sócia',
    origem: 'INDICACAO',
  });
  await novoContato('claudia', 'cs1', {
    nome: 'Cláudia Mendes',
    email: 'claudia.mendes@sabermais.example.com.br',
    telefone: '(71) 99345-2909',
    empresaId: empresas.escola.id,
    cargo: 'Diretora pedagógica',
    origem: 'MANUAL',
    etiquetas: ['Cliente'],
  });
  await novoContato('andre', 'cs2', {
    nome: 'André Luiz Souza',
    email: 'andre.souza@technova.example.com',
    empresaId: empresas.technova.id,
    cargo: 'CEO',
    origem: 'MANUAL',
    etiquetas: ['Cliente', 'Decisor'],
  });
  await novoContato('simone', 'cs2', {
    nome: 'Simone Prates',
    email: 'simone@studiofit.example.com.br',
    empresaId: empresas.studiofit.id,
    origem: 'MANUAL',
  });
  await novoContato('leandro', 'clevel', {
    nome: 'Leandro Castro',
    email: 'leandro.castro@grupocastro.example.com.br',
    telefone: '(61) 99456-3101',
    empresaNome: 'Grupo Castro Participações',
    cargo: 'Presidente',
    origem: 'INDICACAO',
    origemDetalhe: 'Contato pessoal da diretoria',
    etiquetas: ['Estratégico'],
  });
  // Reconversão manual: o mesmo e-mail volta por outra campanha (R4.2, R4.3).
  await novoContato('ana', 'marketing2', {
    nome: 'Ana Beatriz Lopes',
    email: 'ana.lopes@clinicavidaplena.example.com.br',
    origem: 'SITE',
    utm: { source: 'google', medium: 'cpc', campaign: 'remarketing-saude' },
  });
  // Edição (contato.atualizado com antes/depois)
  await s('comercial1').patch(`/contatos/${contatos.fernando.id}`, {
    cargo: 'Sócio-proprietário',
    etiquetas: ['Decisor', 'Pequena empresa'],
    camposPersonalizados: { lojas: 3, melhorHorario: 'manhã' },
  });
  nota('Fernando Oliveira editado (cargo, etiquetas e campos personalizados)');

  // ------------------------------------------------------ negócios ---
  passo('Negócios no funil de Marketing');
  const negocios = {};
  const novoNegocio = async (chave, quem, dados) => {
    const negocio = await s(quem).post('/negocios', dados);
    negocios[chave] = negocio;
    return negocio;
  };
  const mover = async (sessao, negocio, etapaId, extra = {}) => {
    const resultado = await sessao.post(`/negocios/${negocio.id}/mover`, {
      etapaId,
      ...extra,
    });
    return resultado;
  };
  const registrarPassagens = (resultado) => {
    for (const p of resultado.passagens) {
      nota(
        `  ↳ passagem "${p.nome}": ${p.criado ? 'negócio criado' : 'reconversão'} com ${p.responsavel?.nome ?? 'sem responsável'}`,
      );
    }
    return resultado.passagens;
  };

  // O negócio de Marketing herda a origem e a UTM com que o contato chegou (R4.3).
  const semVazios = (utm) => {
    const campos = Object.entries(utm ?? {}).filter(
      ([, valor]) => valor !== null && valor !== undefined,
    );
    return campos.length > 0 ? Object.fromEntries(campos) : undefined;
  };
  const mkt = (chave, quem, contato, extra = {}) => {
    const { tipo, detalhe, utm } = contatos[contato].primeiraOrigem;
    return novoNegocio(chave, quem, {
      contatoId: contatos[contato].id,
      funilId: FM,
      origem: tipo,
      origemDetalhe: detalhe ?? undefined,
      utm: semVazios(utm),
      ...extra,
    });
  };

  await mkt('mAna', 'marketing1', 'ana', {
    titulo: 'Clínica Vida Plena — CRM para a recepção',
    valor: '0.00',
  });
  await mkt('mCarlos', 'marketing1', 'carlos');
  await mkt('mPatricia', 'marketing2', 'patricia', {
    etapaId: etapa('MARKETING', 'em_contato'),
  });
  await mkt('mRoberto', 'marketing2', 'roberto', {
    etapaId: etapa('MARKETING', 'em_contato'),
  });
  await mkt('mJuliana', 'marketing1', 'juliana', {
    etapaId: etapa('MARKETING', 'nutricao'),
  });
  await mkt('mMarcos', 'liderMarketing', 'marcos', {
    etapaId: etapa('MARKETING', 'nutricao'),
  });
  await mkt('mSofia', 'marketing2', 'sofia');
  await mkt('mEduardo', 'marketing1', 'eduardo');
  await mkt('mLarissa', 'marketing2', 'larissa');
  await mkt('mGustavo', 'marketing1', 'gustavo');
  // Sem responsável: qualquer pessoa do Marketing pode assumir (R5.9).
  await novoNegocio('mSemDono', 'liderMarketing', {
    contatoId: contatos.leandro.id,
    funilId: FM,
    titulo: 'Grupo Castro — avaliar interesse',
    responsavelId: null,
  });
  nota('11 negócios em Novo lead, Em contato e Nutrição (um sem responsável)');

  // Movimentações dentro do Marketing
  await mover(
    s('marketing1'),
    negocios.mCarlos,
    etapa('MARKETING', 'em_contato'),
  );
  await mover(
    s('marketing2'),
    negocios.mSofia,
    etapa('MARKETING', 'em_contato'),
  );
  await mover(s('marketing2'), negocios.mSofia, etapa('MARKETING', 'nutricao'));
  // Descartado com motivo (R5.5)
  await mover(
    s('marketing2'),
    negocios.mLarissa,
    etapa('MARKETING', 'descartado'),
    {
      motivoPerda: 'Contato de lista comprada, sem interesse',
    },
  );
  nota('Larissa Teixeira descartada (motivo obrigatório, R5.5)');

  passo('Passagens Marketing → Comercial (MQL, R5.7)');
  const passagensMql = {};
  for (const [chave, quem] of [
    ['mRoberto', 'marketing2'],
    ['mEduardo', 'marketing1'],
    ['mGustavo', 'marketing1'],
    ['mPatricia', 'marketing2'],
  ]) {
    const negocio = negocios[chave];
    if (negocio.etapa.id === etapa('MARKETING', 'novo_lead')) {
      await mover(s(quem), negocio, etapa('MARKETING', 'em_contato'));
    }
    const resultado = await mover(
      s(quem),
      negocio,
      etapa('MARKETING', 'qualificado_mql'),
    );
    nota(`${negocio.titulo} → Qualificado (MQL)`);
    const [passagem] = registrarPassagens(resultado);
    if (passagem)
      passagensMql[chave] = await admin.get(
        `/negocios/${passagem.negocioDestinoId}`,
      );
  }

  passo('Negócios no funil Comercial');
  // Os que vieram do Marketing andam com quem os recebeu no rodízio.
  const cRoberto = passagensMql.mRoberto;
  const cEduardo = passagensMql.mEduardo;
  const cGustavo = passagensMql.mGustavo;
  const sRoberto = sessaoDoResponsavel(cRoberto, s('liderComercial'));
  const sEduardo = sessaoDoResponsavel(cEduardo, s('liderComercial'));
  const sGustavo = sessaoDoResponsavel(cGustavo, s('liderComercial'));
  await s('liderComercial').patch(`/negocios/${cRoberto.id}`, {
    titulo: 'AgroVale — CRM para a força de vendas',
    valor: '36000.00',
    valorRecorrente: '3000.00',
    previsaoFechamento: dataEm(25),
  });
  await mover(sRoberto, cRoberto, etapa('COMERCIAL', 'qualificacao'));
  await mover(sRoberto, cRoberto, etapa('COMERCIAL', 'apresentacao'));
  await s('liderComercial').patch(`/negocios/${cEduardo.id}`, {
    valor: '9600.00',
    valorRecorrente: '800.00',
  });
  await mover(sEduardo, cEduardo, etapa('COMERCIAL', 'qualificacao'));
  nota('AgroVale em Apresentação, Distribuidora Sol Nascente em Qualificação');

  // A jornada completa: Marketing → Comercial → ganho → CS.
  await s('liderComercial').patch(`/negocios/${cGustavo.id}`, {
    titulo: 'Padaria Pão Dourado — plano Essencial',
    valor: '4800.00',
    valorRecorrente: '400.00',
    previsaoFechamento: dataEm(3),
  });
  for (const chave of [
    'qualificacao',
    'apresentacao',
    'proposta',
    'negociacao',
  ]) {
    await mover(sGustavo, cGustavo, etapa('COMERCIAL', chave));
  }
  const ganhoGustavo = await mover(
    sGustavo,
    cGustavo,
    etapa('COMERCIAL', 'ganho'),
  );
  nota(`${cGustavo.titulo} GANHO por ${cGustavo.responsavel?.nome}`);
  const [passagemCsGustavo] = registrarPassagens(ganhoGustavo);

  const com = (chave, quem, contato, extra = {}) =>
    novoNegocio(chave, quem, {
      contatoId: contatos[contato].id,
      funilId: FC,
      ...extra,
    });

  await com('cHorizonte', 'liderComercial', 'ricardo', {
    titulo: 'Construtora Horizonte — plano Corporativo anual',
    valor: '48000.00',
    valorRecorrente: '4000.00',
    previsaoFechamento: dataEm(12),
    etapaId: etapa('COMERCIAL', 'negociacao'),
    origem: 'INDICACAO',
  });
  await com('cPadaria', 'comercial1', 'fernando', {
    titulo: 'Padaria Pão Dourado — filiais',
    valor: '3600.00',
    valorRecorrente: '300.00',
    previsaoFechamento: dataEm(9),
    etapaId: etapa('COMERCIAL', 'proposta'),
    origem: 'INDICACAO',
  });
  await com('cClinica', 'comercial2', 'beatriz', {
    titulo: 'Clínica Vida Plena — implantação',
    valor: '12000.00',
    valorRecorrente: '990.00',
    previsaoFechamento: dataEm(20),
    etapaId: etapa('COMERCIAL', 'apresentacao'),
  });
  await com('cAgro', 'liderComercial', 'aline', {
    titulo: 'AgroVale — módulo de campo',
    valor: '15000.00',
    responsavelId: id('comercial2'),
    etapaId: etapa('COMERCIAL', 'qualificacao'),
  });
  await com('cModa', 'desligado', 'vanessa', {
    titulo: 'Moda Bella — CRM para as lojas',
    valor: '7200.00',
    valorRecorrente: '600.00',
    previsaoFechamento: dataEm(15),
    etapaId: etapa('COMERCIAL', 'proposta'),
    origem: 'WHATSAPP',
  });
  await com('cBarros', 'desligado', 'henrique', {
    titulo: 'Lojas Barros — diagnóstico',
    valor: '2500.00',
    etapaId: etapa('COMERCIAL', 'qualificacao'),
    origem: 'INDICACAO',
  });
  await com('cFerragens', 'comercial1', 'paulo', {
    titulo: 'Ferragens Araújo — plano Essencial',
    valor: '18000.00',
    valorRecorrente: '1500.00',
    etapaId: etapa('COMERCIAL', 'negociacao'),
  });
  await com('cAdvocacia', 'comercial2', 'renata', {
    titulo: 'Figueiredo Advocacia — plano Profissional',
    valor: '6000.00',
    valorRecorrente: '500.00',
    etapaId: etapa('COMERCIAL', 'proposta'),
    origem: 'INDICACAO',
  });
  await com('cCastro', 'clevel', 'leandro', {
    titulo: 'Grupo Castro — projeto piloto',
    valor: '60000.00',
    valorRecorrente: '5000.00',
    previsaoFechamento: dataEm(40),
    responsavelId: id('liderComercial'),
    etapaId: etapa('COMERCIAL', 'apresentacao'),
    origem: 'INDICACAO',
  });
  await com('cSemDono1', 'liderComercial', 'paulo', {
    titulo: 'Ferragens Araújo — segunda loja',
    valor: '3000.00',
    responsavelId: null,
  });
  await com('cSemDono2', 'liderComercial', 'gustavo', {
    titulo: 'Padaria Pão Dourado — delivery',
    valor: '1200.00',
    responsavelId: null,
  });
  await com('cPerdido1', 'comercial2', 'aline', {
    titulo: 'AgroVale — integração com ERP',
    valor: '22000.00',
    etapaId: etapa('COMERCIAL', 'proposta'),
  });
  await com('cPerdido2', 'comercial1', 'carlos', {
    titulo: 'TechNova — equipe de pré-vendas',
    valor: '8400.00',
    etapaId: etapa('COMERCIAL', 'apresentacao'),
  });
  nota('13 negócios manuais, de Novo a Negociação (dois sem responsável)');

  // Edição com antes/depois na auditoria
  await s('comercial1').patch(`/negocios/${negocios.cPadaria.id}`, {
    valor: '4200.00',
    previsaoFechamento: dataEm(7),
  });
  // Um membro assume um negócio sem responsável (R5.9)
  await s('comercial1').post(`/negocios/${negocios.cSemDono1.id}/assumir`);
  nota(
    'Lucas assumiu "Ferragens Araújo — segunda loja"; "Padaria Pão Dourado — delivery" segue sem responsável',
  );

  // Ganhos (passagem para o CS) e perdas
  const ganhoFerragens = await mover(
    s('comercial1'),
    negocios.cFerragens,
    etapa('COMERCIAL', 'ganho'),
  );
  nota('Ferragens Araújo — plano Essencial GANHO');
  const [passagemCsFerragens] = registrarPassagens(ganhoFerragens);
  const ganhoAdvocacia = await mover(
    s('comercial2'),
    negocios.cAdvocacia,
    etapa('COMERCIAL', 'ganho'),
  );
  nota('Figueiredo Advocacia — plano Profissional GANHO');
  const [passagemCsAdvocacia] = registrarPassagens(ganhoAdvocacia);
  await mover(
    s('comercial2'),
    negocios.cPerdido1,
    etapa('COMERCIAL', 'perdido'),
    {
      motivoPerda: 'Escolheu um concorrente com preço menor',
    },
  );
  await mover(
    s('comercial1'),
    negocios.cPerdido2,
    etapa('COMERCIAL', 'perdido'),
    {
      motivoPerda: 'Projeto adiado para 2027',
    },
  );
  nota('2 perdidos com motivo');
  // Reabrir é só do líder da área, C-level ou Admin (R5.5)
  await s('liderComercial').post(`/negocios/${negocios.cPerdido2.id}/reabrir`, {
    etapaId: etapa('COMERCIAL', 'qualificacao'),
  });
  await mover(
    s('comercial1'),
    negocios.cPerdido2,
    etapa('COMERCIAL', 'perdido'),
    {
      motivoPerda: 'Sem orçamento aprovado neste ano',
    },
  );
  nota('TechNova reaberto por Rafael e perdido de novo (outro motivo)');

  passo('Negócios no funil de Customer Success');
  const csDe = async (passagem) =>
    passagem ? admin.get(`/negocios/${passagem.negocioDestinoId}`) : null;
  const sGustavoCs = await csDe(passagemCsGustavo);
  const sFerragensCs = await csDe(passagemCsFerragens);
  const sAdvocaciaCs = await csDe(passagemCsAdvocacia);
  if (sFerragensCs) {
    const quem = sessaoDoResponsavel(sFerragensCs, s('liderCs'));
    await mover(quem, sFerragensCs, etapa('CS', 'onboarding'));
    nota(`Ferragens Araújo em Onboarding (${sFerragensCs.responsavel?.nome})`);
  }
  if (sAdvocaciaCs) {
    const quem = sessaoDoResponsavel(sAdvocaciaCs, s('liderCs'));
    await mover(quem, sAdvocaciaCs, etapa('CS', 'onboarding'));
    await mover(quem, sAdvocaciaCs, etapa('CS', 'implantacao'));
    nota(
      `Figueiredo Advocacia em Implantação (${sAdvocaciaCs.responsavel?.nome})`,
    );
  }
  if (sGustavoCs)
    nota(
      `Padaria Pão Dourado em Boas-vindas (${sGustavoCs.responsavel?.nome})`,
    );

  const cs = (chave, quem, contato, extra = {}) =>
    novoNegocio(chave, quem, {
      contatoId: contatos[contato].id,
      funilId: FS,
      ...extra,
    });
  await cs('sEscola', 'cs1', 'claudia', {
    titulo: 'Escola Saber Mais — implantação das unidades',
    valor: '0.00',
    valorRecorrente: '2500.00',
    etapaId: etapa('CS', 'implantacao'),
  });
  await cs('sTechnova', 'cs2', 'andre', {
    titulo: 'TechNova — acompanhamento',
    valorRecorrente: '1800.00',
    etapaId: etapa('CS', 'acompanhamento'),
  });
  await cs('sTechnovaRenov', 'cs2', 'andre', {
    titulo: 'TechNova — renovação anual',
    valor: '21600.00',
    valorRecorrente: '1800.00',
    previsaoFechamento: dataEm(30),
    etapaId: etapa('CS', 'renovacao'),
  });
  await cs('sEscolaRenov', 'cs1', 'claudia', {
    titulo: 'Escola Saber Mais — renovação 2026',
    valor: '30000.00',
    valorRecorrente: '2500.00',
    etapaId: etapa('CS', 'renovacao'),
  });
  await cs('sStudio', 'cs2', 'simone', {
    titulo: 'Studio Fit — acompanhamento',
    valorRecorrente: '350.00',
    etapaId: etapa('CS', 'acompanhamento'),
  });
  await cs('sStudioOnb', 'liderCs', 'simone', {
    titulo: 'Studio Fit — nova unidade',
    valorRecorrente: '350.00',
    responsavelId: id('cs1'),
  });
  await mover(s('cs1'), negocios.sEscolaRenov, etapa('CS', 'renovado'));
  nota('Escola Saber Mais — renovação 2026 RENOVADO');
  await mover(s('cs2'), negocios.sStudio, etapa('CS', 'cancelado'), {
    motivoPerda: 'Encerrou as atividades da unidade',
  });
  nota('Studio Fit — acompanhamento CANCELADO (churn, com motivo)');

  // ---------------------------------------------------- atividades ---
  passo('Atividades (pendentes, atrasadas, concluídas, canceladas e notas)');
  let totalAtividades = 0;
  const atividade = async (quem, dados, depois) => {
    const criada = await s(quem).post('/atividades', dados);
    totalAtividades += 1;
    if (depois === 'concluir')
      await s(quem).post(`/atividades/${criada.id}/concluir`);
    if (depois === 'cancelar')
      await s(quem).post(`/atividades/${criada.id}/cancelar`);
    return criada;
  };
  const n = (chave) => negocios[chave].id;

  // Lucas (comercial1)
  await atividade('comercial1', {
    tipo: 'LIGACAO',
    titulo: 'Retornar sobre a proposta das filiais',
    negocioId: n('cPadaria'),
    prioridade: 'ALTA',
    venceEm: horasAtras(26),
  });
  await atividade('comercial1', {
    tipo: 'TAREFA',
    titulo: 'Enviar proposta revisada com desconto de 5%',
    negocioId: n('cPadaria'),
    venceEm: maisTardeHoje(2),
  });
  await atividade('comercial1', {
    tipo: 'WHATSAPP',
    titulo: 'Mandar o vídeo de demonstração',
    contatoId: contatos.paulo.id,
    venceEm: diaEm(2, 10),
  });
  await atividade(
    'comercial1',
    {
      tipo: 'EMAIL',
      titulo: 'Enviar contrato para assinatura',
      negocioId: n('cFerragens'),
      venceEm: horasAtras(30),
    },
    'concluir',
  );
  await atividade(
    'comercial1',
    {
      tipo: 'REUNIAO',
      titulo: 'Kickoff com a Ferragens Araújo',
      negocioId: n('cFerragens'),
      inicioEm: diaEm(-2, 14),
      fimEm: diaEm(-2, 15),
    },
    'concluir',
  );
  // Juliana (comercial2)
  await atividade('comercial2', {
    tipo: 'REUNIAO',
    titulo: 'Apresentação para a diretoria da clínica',
    descricao: 'Levar o caso de uso da recepção e a simulação de preços.',
    negocioId: n('cClinica'),
    inicioEm: diaEm(1, 10),
    fimEm: diaEm(1, 11),
  });
  await atividade('comercial2', {
    tipo: 'TAREFA',
    titulo: 'Levantar requisitos do módulo de campo',
    negocioId: n('cAgro'),
    prioridade: 'ALTA',
    venceEm: horasAtras(24 * 3),
  });
  await atividade(
    'comercial2',
    {
      tipo: 'LIGACAO',
      titulo: 'Entender por que escolheram o concorrente',
      negocioId: n('cPerdido1'),
      prioridade: 'BAIXA',
    },
    'cancelar',
  );
  await atividade('comercial2', {
    tipo: 'NOTA',
    titulo: 'Motivo da perda',
    descricao:
      'Cliente achou o preço alto; pediu para voltarmos a falar no próximo semestre.',
    negocioId: n('cPerdido1'),
  });
  // Pedro (vai ser desligado: 3 pendentes e 1 concluída, R7 cenário 4)
  await atividade('desligado', {
    tipo: 'LIGACAO',
    titulo: 'Confirmar quantidade de lojas',
    negocioId: n('cModa'),
    venceEm: horasAtras(20),
  });
  await atividade('desligado', {
    tipo: 'EMAIL',
    titulo: 'Enviar tabela de preços',
    negocioId: n('cModa'),
    venceEm: diaEm(1, 9),
  });
  await atividade('desligado', {
    tipo: 'TAREFA',
    titulo: 'Agendar diagnóstico nas Lojas Barros',
    negocioId: n('cBarros'),
  });
  await atividade(
    'desligado',
    {
      tipo: 'WHATSAPP',
      titulo: 'Primeiro contato com a Vanessa',
      contatoId: contatos.vanessa.id,
      venceEm: horasAtras(48),
    },
    'concluir',
  );
  // Rafael (líder comercial)
  await atividade('liderComercial', {
    tipo: 'TAREFA',
    titulo: 'Revisar o pipeline do trimestre',
    prioridade: 'MEDIA',
  });
  await atividade('liderComercial', {
    tipo: 'REUNIAO',
    titulo: 'Negociação final com o CFO da Horizonte',
    negocioId: n('cHorizonte'),
    inicioEm: diaEm(3, 15),
    fimEm: diaEm(3, 16, 30),
    prioridade: 'ALTA',
  });
  await atividade('liderComercial', {
    tipo: 'TAREFA',
    titulo: 'Preparar proposta do piloto do Grupo Castro',
    negocioId: n('cCastro'),
    venceEm: diaEm(12, 18),
  });
  // Mariana e Thiago (Marketing)
  await atividade('marketing1', {
    tipo: 'LIGACAO',
    titulo: 'Qualificar o lead da Clínica Vida Plena',
    negocioId: n('mAna'),
    venceEm: maisTardeHoje(1),
  });
  await atividade('marketing1', {
    tipo: 'WHATSAPP',
    titulo: 'Convidar para o webinar de vendas B2B',
    negocioId: n('mCarlos'),
    venceEm: horasAtras(5),
  });
  await atividade(
    'marketing1',
    {
      tipo: 'EMAIL',
      titulo: 'Enviar material de boas-vindas',
      negocioId: n('mJuliana'),
    },
    'concluir',
  );
  await atividade('marketing2', {
    tipo: 'TAREFA',
    titulo: 'Montar sequência de nutrição para leads frios',
    venceEm: diaEm(15, 12),
    prioridade: 'BAIXA',
  });
  await atividade(
    'marketing2',
    {
      tipo: 'LIGACAO',
      titulo: 'Ligar para a Sofia (não quer e-mail marketing)',
      negocioId: n('mSofia'),
    },
    'cancelar',
  );
  // Camila (líder de Marketing)
  await atividade('liderMarketing', {
    tipo: 'TAREFA',
    titulo: 'Planejar a campanha de Black Friday',
    venceEm: diaEm(6, 17),
    prioridade: 'ALTA',
  });
  await atividade('liderMarketing', {
    tipo: 'NOTA',
    titulo: 'Feira Construir 2026',
    descricao:
      'Recebemos 40 cartões no estande; Marcos (Horizonte) pediu proposta para o Comercial.',
    contatoId: contatos.marcos.id,
  });
  // CS
  await atividade('cs1', {
    tipo: 'REUNIAO',
    titulo: 'Treinamento da equipe da escola',
    negocioId: n('sEscola'),
    inicioEm: diaEm(2, 14),
    fimEm: diaEm(2, 16),
  });
  await atividade('cs1', {
    tipo: 'TAREFA',
    titulo: 'Configurar as unidades no sistema',
    negocioId: n('sEscola'),
    venceEm: horasAtras(24 * 2),
    prioridade: 'ALTA',
  });
  await atividade('cs2', {
    tipo: 'LIGACAO',
    titulo: 'Check-in mensal com a TechNova',
    negocioId: n('sTechnova'),
    venceEm: maisTardeHoje(3),
  });
  await atividade('cs2', {
    tipo: 'NOTA',
    titulo: 'Cancelamento',
    descricao: 'A unidade da Barra fechou; a matriz segue como cliente.',
    negocioId: n('sStudio'),
  });
  await atividade('liderCs', {
    tipo: 'TAREFA',
    titulo: 'Revisar o health score da carteira',
  });
  // Diretoria
  await atividade('clevel', {
    tipo: 'REUNIAO',
    titulo: 'Comitê de resultados',
    descricao: 'Pauta: funil comercial, churn do mês e Black Friday.',
    inicioEm: diaEm(4, 9),
    fimEm: diaEm(4, 10, 30),
  });
  await atividade('clevel', {
    tipo: 'LIGACAO',
    titulo: 'Conversa com Leandro Castro',
    negocioId: n('cCastro'),
    responsavelId: id('liderComercial'),
    venceEm: diaEm(1, 16),
  });
  nota(`${totalAtividades} atividades de 12 pessoas`);

  // ---------------------------------------------- webhooks de entrada ---
  passo('Webhooks de entrada e recebimentos (R8)');
  const disparos = await admin.post('/webhooks/entradas', {
    nome: 'Disparos BRL — WhatsApp',
    modeloMapeamento: 'DISPAROS_BRL',
    estrategia: 'RODIZIO',
    etiquetasFixas: ['Disparos BRL'],
  });
  nota(
    `"${disparos.webhook.nome}" (modelo Disparos BRL, rodízio no Marketing)`,
  );
  const landing = await admin.post('/webhooks/entradas', {
    nome: 'Landing page — Black Friday',
    modeloMapeamento: 'GENERICO',
    estrategia: 'LIDER_DA_AREA',
    etiquetasFixas: ['Landing', 'Black Friday'],
    gerarSegredo: true,
  });
  nota(
    `"${landing.webhook.nome}" (modelo Genérico, com segredo HMAC, vai para a líder de Marketing)`,
  );

  const enviar = async (
    criado,
    corpo,
    { formulario = false, assinatura } = {},
  ) => {
    const { pathname } = new URL(criado.url);
    const texto = formulario
      ? new URLSearchParams(corpo).toString()
      : JSON.stringify(corpo);
    const cabecalhos = {
      'Content-Type': formulario
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
      'User-Agent': 'disparos-brl/2.3 (demonstracao)',
    };
    if (assinatura === 'valida') {
      cabecalhos['X-Assinatura'] =
        `sha256=${createHmac('sha256', criado.segredo).update(texto).digest('hex')}`;
    } else if (assinatura) {
      cabecalhos['X-Assinatura'] = assinatura;
    }
    const resposta = await fetch(`${API}${pathname}`, {
      method: 'POST',
      headers: cabecalhos,
      body: texto,
    });
    return resposta.status;
  };

  const enviosDisparos = [
    {
      name: 'Marcela Antunes',
      email: 'marcela.antunes@lojamarcela.example.com.br',
      phone: '(11) 98555-4101',
      faturamento: 'De R$ 30 mil a R$ 80 mil',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'São Paulo',
      planilha_segmento: 'Moda',
    },
    {
      name: 'Otávio Rezende',
      email: 'otavio@rezendeautopecas.example.com.br',
      whatsapp: '5531998764102',
      faturamento: 'Acima de R$ 80 mil',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'Belo Horizonte',
      planilha_segmento: 'Autopeças',
    },
    {
      name: 'Priscila Moura',
      email: 'priscila.moura@docesmoura.example.com.br',
      phone: '(81) 99234-4103',
      faturamento: 'Até R$ 30 mil',
      campanha: 'Reativação de base',
      origem: 'Disparos SMS',
      planilha_cidade: 'Recife',
    },
    {
      name: 'Wagner Lopes',
      phone: '(48) 99876-4104',
      faturamento: 'De R$ 30 mil a R$ 80 mil',
      campanha: 'Reativação de base',
      origem: 'Disparos WhatsApp',
      planilha_cidade: 'Florianópolis',
    },
    // O mesmo e-mail de um contato que já existe: reconversão no negócio aberto (R4.2, R5.6)
    {
      name: 'Carlos Eduardo Nunes',
      email: 'carlos.nunes@technova.example.com',
      faturamento: 'Acima de R$ 80 mil',
      campanha: 'Black Friday',
      origem: 'Disparos WhatsApp',
    },
    // Envio de teste do sistema de disparos: ignorado
    {
      name: 'Lead de Teste',
      email: 'teste@exemplo.com.br',
      phone: '(11) 99999-8888',
      teste: true,
    },
    // Sem e-mail nem telefone: erro de validação (R8.5)
    {
      name: 'Lead sem contato',
      faturamento: 'Até R$ 30 mil',
      campanha: 'Black Friday',
    },
  ];
  const respostas = [];
  for (const corpo of enviosDisparos)
    respostas.push(await enviar(disparos, corpo));
  // O sistema de disparos também pode mandar formulário (R8.2)
  respostas.push(
    await enviar(
      disparos,
      {
        name: 'Tatiane Correia',
        email: 'tatiane@correiaimoveis.example.com.br',
        phone: '(27) 99345-4108',
        campanha: 'Imóveis',
        origem: 'Disparos WhatsApp',
      },
      { formulario: true },
    ),
  );
  respostas.push(
    await enviar(
      landing,
      {
        name: 'Felipe Andrade',
        email: 'felipe.andrade@andradecontabil.example.com.br',
        phone: '(11) 97777-4201',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'black-friday',
        utm_term: 'crm com whatsapp',
      },
      { assinatura: 'valida' },
    ),
  );
  respostas.push(
    await enviar(
      landing,
      {
        name: 'Natália Ferraz',
        email: 'natalia@ferrazeventos.example.com.br',
        utm_source: 'facebook',
        utm_medium: 'paid-social',
        utm_campaign: 'black-friday',
        utm_content: 'carrossel-depoimentos',
      },
      { assinatura: 'valida' },
    ),
  );
  // Assinatura errada: 401 e o recebimento fica com erro (R8.3)
  respostas.push(
    await enviar(
      landing,
      { name: 'Assinatura errada', email: 'invasor@example.com' },
      { assinatura: `sha256=${'0'.repeat(64)}` },
    ),
  );
  nota(`${respostas.length} envios: respostas HTTP ${respostas.join(', ')}`);

  // Espera a fila processar (R8.4)
  const pendentes = async () => {
    let restantes = 0;
    for (const criado of [disparos, landing]) {
      const pagina = await admin.get(
        `/webhooks/entradas/${criado.webhook.id}/recebimentos${consultar({ porPagina: 100 })}`,
      );
      restantes += pagina.itens.filter((r) => r.status === 'RECEBIDO').length;
    }
    return restantes;
  };
  let restantes = await pendentes();
  for (let i = 0; i < 45 && restantes > 0; i += 1) {
    await esperar(2000);
    restantes = await pendentes();
  }
  const resumoRecebimentos = {};
  for (const criado of [disparos, landing]) {
    const pagina = await admin.get(
      `/webhooks/entradas/${criado.webhook.id}/recebimentos${consultar({ porPagina: 100 })}`,
    );
    for (const r of pagina.itens)
      resumoRecebimentos[r.status] = (resumoRecebimentos[r.status] ?? 0) + 1;
  }
  nota(
    `recebimentos: ${Object.entries(resumoRecebimentos)
      .map(([status, total]) => `${total} ${status}`)
      .join(', ')}` +
      (restantes > 0
        ? ` (${restantes} ainda na fila: confira se PROCESSAR_FILAS=true)`
        : ''),
  );

  // --------------------------------------------- webhook de saída: teste ---
  if (WEBHOOK_SAIDA_URL) {
    passo('Teste do webhook de saída');
    const teste = await admin.post(`/webhooks/saidas/${saidas[0].id}/testar`);
    nota(`webhook.teste → ${teste.status} (HTTP ${teste.statusHttp ?? '—'})`);
  }

  // ------------------------------------------------------------ LGPD ---
  passo('LGPD: anonimização de um contato (R4.6)');
  const titular = await novoContato('anonimizar', 'marketing1', {
    nome: 'Rodrigo Pacheco',
    email: 'rodrigo.pacheco@example.com',
    telefone: '(11) 98000-5101',
    origem: 'SITE',
    utm: { source: 'google', medium: 'cpc', campaign: 'crm-saude' },
  });
  await admin.post(`/contatos/${titular.id}/anonimizar`, {
    motivo: 'Pedido do titular pelo canal de privacidade (demonstração)',
  });
  nota('contato anonimizado pelo Admin');

  // ----------------------------------------------------- desligamento ---
  passo('Desligamento de Pedro Santos (R7)');
  const previa = await admin.get(
    `/usuarios/${id('desligado')}/desligamento/previa`,
  );
  nota(previa.explicacao);
  const resultado = await admin.post(`/usuarios/${id('desligado')}/desligar`, {
    destinatarioId: previa.destinatario.id,
  });
  const c = resultado.contagens;
  nota(
    `encaminhados para ${resultado.destinatario.nome}: ${c.atividades} atividade(s) pendente(s), ` +
      `${c.negocios} negócio(s) aberto(s), ${c.contatos} contato(s), ${c.empresas} empresa(s)`,
  );

  // -------------------------------------------------------- extras ---
  passo('Usuários extras para as telas de acesso');
  const novo = await admin.post('/usuarios', {
    nome: 'Patrícia Lemos',
    email: email('troca.pendente'),
    papel: 'CS',
    liderId: id('liderCs'),
    senhaTemporaria: SENHA_TEMPORARIA,
  });
  pessoas.trocaPendente = { usuario: novo.usuario, sessao: null };
  nota(
    `${email('troca.pendente')}: senha temporária, troca obrigatória no primeiro acesso (R2.7)`,
  );
  if (CRIAR_CONVITE) {
    try {
      await admin.post('/usuarios', {
        nome: 'Rodrigo Nunes',
        email: email('convidado'),
        papel: 'MARKETING',
        liderId: id('liderMarketing'),
      });
      pessoas.convidado = { usuario: { email: email('convidado') } };
      nota(
        `${email('convidado')}: convite por e-mail (link de definir senha, R2.8)`,
      );
    } catch (erro) {
      if (!(erro instanceof ErroDaApi) || erro.status !== 422) throw erro;
      nota(
        `convite não enviado (${erro.corpo.mensagem}); use SEMEAR_CONVITE=false sem SMTP`,
      );
    }
  }

  // Uma senha errada, para a auditoria mostrar a falha de login (R3.2)
  try {
    await entrar(email('comercial1'), 'senha-errada-de-proposito');
  } catch (erro) {
    if (erro.status !== 401) throw erro;
  }
  // Lucas lê as notificações (estado pessoal, sem auditoria)
  const notificacoes = await s('comercial1').get(
    `/notificacoes${consultar({ porPagina: 5 })}`,
  );
  if (notificacoes.itens[0])
    await s('comercial1').post(
      `/notificacoes/${notificacoes.itens[0].id}/marcar-lida`,
    );

  if (RODAR_ATENDIMENTO) {
    await etapaAtendimento();
    if (RODAR_ONDA_B) await etapaOndaB();
  }

  // Sai de todas as sessões abertas pelo script (o desligado já perdeu a dele, R2.4)
  for (const [chave, { sessao }] of Object.entries(pessoas)) {
    if (!sessao || chave === 'desligado') continue;
    try {
      await sessao.post('/auth/sair');
    } catch {
      // sessão já encerrada: nada a fazer
    }
  }

  // ---------------------------------------------------------- resumo ---
  console.log('\n✓ Demonstração semeada.\n');
  console.log('Usuários (entre pelo front ou por POST /api/v1/auth/entrar):');
  console.log(
    `  ${'Administrador'.padEnd(18)} ${ADMIN_EMAIL.padEnd(34)} ${SENHA_ADMIN}`,
  );
  for (const membro of EQUIPE) {
    const { usuario } = pessoas[membro.chave];
    const senha =
      membro.chave === 'desligado'
        ? `${SENHA_USUARIOS} (desligado: acesso bloqueado)`
        : SENHA_USUARIOS;
    console.log(
      `  ${usuario.rotuloPapel.padEnd(18)} ${usuario.email.padEnd(34)} ${senha}`,
    );
  }
  console.log(
    `  ${'CS'.padEnd(18)} ${email('troca.pendente').padEnd(34)} ${SENHA_TEMPORARIA} (troca obrigatória)`,
  );
  if (pessoas.convidado) {
    console.log(
      `  ${'Marketing'.padEnd(18)} ${email('convidado').padEnd(34)} (convite: link no e-mail)`,
    );
  }
  console.log('\nWebhooks de entrada (o endereço completo só aparece agora):');
  console.log(`  ${disparos.webhook.nome}: ${disparos.url}`);
  console.log(`  ${landing.webhook.nome}: ${landing.url}`);
  console.log(
    `    segredo HMAC (X-Assinatura: sha256=<hmac do corpo>): ${landing.segredo}`,
  );
}

principal().catch((erro) => {
  console.error(`\n✗ A semeadura parou no meio: ${erro.message}`);
  if (!(erro instanceof ErroDaApi)) console.error(erro);
  console.error(
    'A base ficou com parte dos dados; recrie o banco do zero antes de rodar de novo ' +
      '(no ambiente dos agentes: trabalho/dev/ambiente.sh ressemear).',
  );
  process.exit(1);
});
