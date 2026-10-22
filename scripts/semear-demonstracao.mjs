#!/usr/bin/env node
// Dados de demonstração do BRL CRM, criados PELA API (Node 24, só `fetch`, sem
// dependências). Tudo passa pelas regras de negócio e gera auditoria, como se
// cada pessoa tivesse usado o sistema: o Admin troca a senha inicial e cria a
// equipe; cada usuário entra, troca a senha temporária e cria os próprios
// contatos, negócios e atividades; as passagens Marketing → Comercial → CS
// rodam sozinhas; webhooks de entrada recebem leads; um vendedor é desligado.
//
// Só roda numa base recém-criada (apenas o Admin do primeiro acesso, sem
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

import { createHmac, randomBytes } from 'node:crypto';

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

async function principal() {
  console.log(
    `Semeando a demonstração do BRL CRM em ${API} (origem ${ORIGEM})`,
  );

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
