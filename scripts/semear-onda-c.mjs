// Etapa "onda-c" da semeadura (BI e Financeiro): 12 meses de histórico coerente para os painéis e as
// comparações com o período anterior fazerem sentido em qualquer dia.
//
// Chamada por scripts/semear-demonstracao.mjs (SEMEAR_ETAPA=onda-c ou ao fim da semeadura completa).
// Diferente das outras etapas, esta grava DIRETO NO BANCO (SQL): a API não permite criar fatos no
// passado (datas de criação, ganho, resposta e pagamento). Por isso só roda no ambiente dos agentes
// (`crmbrl-dev`), em SEMEAR_BANCO_URL, e nunca no do usuário. Os registros históricos não têm
// auditoria (a auditoria registra o que passa pelos serviços).
//
// Idempotente: o marcador é a existência de contatos `*@historico.demo.local`. Todas as datas são
// relativas a hoje (fuso de Brasília), e o sorteio é determinístico (mesma forma em qualquer dia).
//
// O que cria:
//   - 12 meses de leads (origem e UTM), passagens Marketing → Comercial e Comercial → CS, negócios
//     ganhos e perdidos com motivos, atividades (feitas, futuras e atrasadas), conversas com tempos
//     de resposta, SLA e CSAT, e campanhas concluídas (enviado, entregue, lido, respondido, opt-out);
//   - Financeiro: contratos em todos os status, MRR (novo, expansão, contração, churn), parcelas
//     pagas, abertas e atrasadas em todas as faixas, renegociação, régua com execuções diárias,
//     envios por canal, ligações pendentes e uma promessa de pagamento;
//   - probabilidades das etapas do Comercial que estiverem vazias (valor ponderado).

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DIA_MS = 86_400_000;
const FUSO = 'America/Sao_Paulo';
const DOMINIO_HISTORICO = 'historico.demo.local';

// ------------------------------------------------------------ utilidades ---

/** Sorteio determinístico (mulberry32). */
function criarSorteio(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const formatadorDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export async function semearOndaC({ bancoUrl, admin, passo, nota, email }) {
  const rand = criarSorteio(20261031);
  const inteiro = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const escolher = (lista) => lista[Math.floor(rand() * lista.length)];
  const ponderado = (pares) => {
    const total = pares.reduce((s, [, p]) => s + p, 0);
    let x = rand() * total;
    for (const [valor, peso] of pares) {
      x -= peso;
      if (x < 0) return valor;
    }
    return pares.at(-1)[0];
  };
  const agora = new Date();
  const hojeIso = formatadorDia.format(agora);

  /** Dia (AAAA-MM-DD, Brasília) de `n` dias atrás. */
  const diaIso = (n) =>
    formatadorDia.format(new Date(agora.getTime() - n * DIA_MS));
  /** Instante de `n` dias atrás às `h:m` de Brasília (UTC−3), nunca depois de agora. */
  const em = (n, h = 12, m = 0) => {
    const [a, mes, d] = diaIso(n).split('-').map(Number);
    const t = Date.UTC(a, mes - 1, d, h + 3, m);
    return new Date(Math.min(t, agora.getTime() - 60_000));
  };
  const somarDias = (iso, dias) => {
    const t = Date.parse(`${iso}T00:00:00Z`) + dias * DIA_MS;
    return new Date(t).toISOString().slice(0, 10);
  };
  const diasAtras = (instante) => Math.floor((agora - instante) / DIA_MS);
  const isoDe = (instante) => formatadorDia.format(instante);

  const cliente = new pg.Client({ connectionString: bancoUrl });
  await cliente.connect();
  const ins = async (tabela, dados) => {
    const campos = { id: randomUUID(), ...dados };
    if (!('atualizado_em' in campos) && !SEM_ATUALIZADO.has(tabela)) {
      campos.atualizado_em = campos.criado_em ?? agora;
    }
    const chaves = Object.keys(campos);
    await cliente.query(
      `INSERT INTO ${tabela} (${chaves.join(', ')}) VALUES (${chaves.map((_, i) => `$${i + 1}`).join(', ')})`,
      chaves.map((k) => {
        const v = campos[k];
        return v !== null &&
          typeof v === 'object' &&
          !(v instanceof Date) &&
          !Array.isArray(v)
          ? JSON.stringify(v)
          : v;
      }),
    );
    return campos.id;
  };
  const consultar = async (sql, params = []) =>
    (await cliente.query(sql, params)).rows;

  try {
    const [{ existe }] = await consultar(
      `SELECT EXISTS (SELECT 1 FROM contatos WHERE email LIKE '%@${DOMINIO_HISTORICO}') AS existe`,
    );
    if (existe) {
      nota('o histórico da Onda C já existe (nada a fazer)');
      return;
    }

    // --------------------------------------------------- referências ---
    passo('Onda C: lendo equipe, funis, filas e canais');
    const usuarioPor = {};
    for (const chave of [
      'comercial1',
      'comercial2',
      'lider.comercial',
      'marketing1',
      'marketing2',
      'lider.marketing',
      'cs1',
      'cs2',
      'lider.cs',
    ]) {
      const [u] = await consultar('SELECT id FROM usuarios WHERE email = $1', [
        email(chave),
      ]);
      if (!u)
        throw new Error(
          `Usuário ${email(chave)} não existe: rode a semeadura completa antes.`,
        );
      usuarioPor[chave] = u.id;
    }
    const comerciais = [usuarioPor.comercial1, usuarioPor.comercial2];
    const marketings = [usuarioPor.marketing1, usuarioPor.marketing2];
    const csUsuarios = [usuarioPor.cs1, usuarioPor.cs2];
    const funis = {};
    for (const area of ['MARKETING', 'COMERCIAL', 'CS']) {
      const [f] = await consultar(
        `SELECT id FROM funis WHERE area = $1 AND excluido_em IS NULL ORDER BY criado_em LIMIT 1`,
        [area],
      );
      const etapas = {};
      for (const e of await consultar(
        'SELECT id, chave FROM etapas WHERE funil_id = $1',
        [f.id],
      )) {
        etapas[e.chave] = e.id;
      }
      funis[area] = { id: f.id, etapas };
    }
    const passagemMc = (
      await consultar(
        'SELECT id FROM passagens WHERE funil_origem_id = $1 AND funil_destino_id = $2 LIMIT 1',
        [funis.MARKETING.id, funis.COMERCIAL.id],
      )
    )[0]?.id;
    const passagemCs = (
      await consultar(
        'SELECT id FROM passagens WHERE funil_origem_id = $1 AND funil_destino_id = $2 LIMIT 1',
        [funis.COMERCIAL.id, funis.CS.id],
      )
    )[0]?.id;
    const filas = {};
    for (const f of await consultar(
      `SELECT id, nome, sla_primeira_resposta_minutos AS p, sla_resolucao_minutos AS r FROM filas_atendimento WHERE excluido_em IS NULL`,
    )) {
      filas[f.nome] = f;
    }
    const canais = {};
    for (const c of await consultar(
      `SELECT id, nome FROM canais WHERE excluido_em IS NULL`,
    )) {
      canais[c.nome] = c.id;
    }

    // Probabilidades do Comercial (valor ponderado) onde ainda estiverem vazias.
    await cliente.query(
      `UPDATE etapas SET probabilidade = CASE chave
          WHEN 'novo' THEN 10 WHEN 'qualificacao' THEN 20 WHEN 'apresentacao' THEN 40
          WHEN 'proposta' THEN 60 WHEN 'negociacao' THEN 80 END
        WHERE funil_id = $1 AND probabilidade IS NULL AND chave IN ('novo','qualificacao','apresentacao','proposta','negociacao')`,
      [funis.COMERCIAL.id],
    );

    // As etapas padrão da régua nascem na primeira consulta (a API garante os padrões).
    await admin.get('/financeiro/regua/etapas');
    await admin.get('/financeiro/regua/configuracao');

    await cliente.query('BEGIN');

    // ------------------------------------------------------ contatos ---
    passo('Onda C: contatos e empresas históricos');
    const nomes = [
      'Ana',
      'Bruno',
      'Carla',
      'Daniel',
      'Elisa',
      'Fábio',
      'Giovana',
      'Heitor',
      'Isabela',
      'João',
      'Karina',
      'Leandro',
      'Mônica',
      'Nelson',
      'Olívia',
      'Paulo',
      'Queila',
      'Renato',
      'Sabrina',
      'Tiago',
      'Úrsula',
      'Vítor',
      'Wagner',
      'Yara',
    ];
    const sobrenomes = [
      'Almeida',
      'Barros',
      'Cardoso',
      'Dias',
      'Esteves',
      'Fonseca',
      'Gouveia',
      'Henriques',
      'Ibrahim',
      'Jardim',
      'Klein',
      'Lopes',
      'Moraes',
      'Nogueira',
      'Oliveira',
      'Pires',
      'Queiroz',
      'Rezende',
      'Siqueira',
      'Teixeira',
      'Uchoa',
      'Vasconcelos',
      'Xavier',
    ];
    const ramos = [
      'Logística',
      'Contábil',
      'Clínica',
      'Construtora',
      'Escola',
      'Distribuidora',
      'Agência',
      'Engenharia',
      'Varejo',
      'Consultoria',
      'Indústria',
      'Tecnologia',
    ];
    const sufixos = [
      'Alfa',
      'Beta',
      'Delta',
      'Prime',
      'Nova',
      'Central',
      'Sul',
      'Norte',
      'Atlântica',
      'Horizonte',
      'Vértice',
      'Aurora',
    ];
    const contatos = [];
    for (let i = 1; i <= 260; i++) {
      const nome =
        `${nomes[i % nomes.length]} ${sobrenomes[Math.floor(i / nomes.length) % sobrenomes.length]} ${i > 280 ? i : ''}`.trim();
      contatos.push({
        id: randomUUID(),
        nome: `${nome}`,
        email: `hist-${String(i).padStart(3, '0')}@${DOMINIO_HISTORICO}`,
        telefone: `55119${String(70000000 + i)}`,
        usado: false,
      });
    }
    let proximoContato = 0;
    const novoContato = () => {
      const c = contatos[proximoContato % contatos.length];
      proximoContato += 1;
      return c;
    };
    const origensContato = [
      'SITE',
      'INSTAGRAM',
      'EMAIL',
      'INDICACAO',
      'WHATSAPP',
      'MANUAL',
      'IMPORTACAO',
    ];
    for (const c of contatos) {
      c.origem = escolher(origensContato);
      await ins('contatos', {
        id: c.id,
        nome: c.nome,
        email: c.email,
        telefone: c.telefone,
        primeira_origem: c.origem,
        ultima_origem: c.origem,
        criado_em: em(inteiro(30, 380), 10),
        responsavel_id: escolher([...comerciais, ...csUsuarios]),
      });
    }
    const empresaDoContato = new Map();
    const criarEmpresa = async (contato, indice) => {
      if (empresaDoContato.has(contato.id))
        return empresaDoContato.get(contato.id);
      const id = await ins('empresas', {
        nome: `${escolher(ramos)} ${escolher(sufixos)} ${indice} Ltda`,
        segmento: escolher([
          'Serviços',
          'Saúde',
          'Indústria',
          'Educação',
          'Comércio',
        ]),
        cidade: escolher([
          'São Paulo',
          'Campinas',
          'Curitiba',
          'Belo Horizonte',
          'Recife',
        ]),
        uf: escolher(['SP', 'SP', 'PR', 'MG', 'PE']),
        criado_em: em(inteiro(60, 380), 9),
        responsavel_id: escolher(csUsuarios),
      });
      await cliente.query('UPDATE contatos SET empresa_id = $1 WHERE id = $2', [
        id,
        contato.id,
      ]);
      empresaDoContato.set(contato.id, id);
      return id;
    };

    // ---------------------------------------------- leads e passagens ---
    passo('Onda C: 12 meses de leads, passagens, negócios ganhos e perdidos');
    const combosUtm = [
      {
        source: 'google',
        medium: 'cpc',
        campaign: 'busca-marca',
        origem: 'SITE',
        peso: 18,
      },
      {
        source: 'google',
        medium: 'cpc',
        campaign: 'busca-generica',
        origem: 'SITE',
        peso: 16,
      },
      {
        source: 'meta',
        medium: 'paid-social',
        campaign: 'leads-instagram',
        origem: 'INSTAGRAM',
        peso: 15,
      },
      {
        source: 'meta',
        medium: 'paid-social',
        campaign: 'leads-facebook',
        origem: 'MESSENGER',
        peso: 8,
      },
      {
        source: 'linkedin',
        medium: 'paid-social',
        campaign: 'abm-diretoria',
        origem: 'SITE',
        peso: 7,
      },
      {
        source: 'newsletter',
        medium: 'email',
        campaign: 'boletim-mensal',
        origem: 'EMAIL',
        peso: 10,
      },
      {
        source: 'organico',
        medium: 'seo',
        campaign: 'blog',
        origem: 'SITE',
        peso: 12,
      },
      {
        source: 'parceiros',
        medium: 'referral',
        campaign: 'indicacao-parceiros',
        origem: 'INDICACAO',
        peso: 6,
      },
    ];
    const motivosPerdaMarketing = [
      'Sem perfil para o produto',
      'Contato duplicado',
      'Sem interesse no momento',
      'Dados inválidos',
    ];
    const motivosPerda = [
      ['Preço acima do orçamento', 28],
      ['Escolheu o concorrente', 22],
      ['Sem retorno do cliente', 20],
      ['Projeto adiado', 14],
      ['Sem fit com o produto', 9],
      ['Sem decisor envolvido', 7],
    ];
    const produtosValor = [2500, 4800, 7200, 9800, 14500, 22000, 36000, 58000];

    const negociosComerciais = []; // { id, contato, criadoEm, responsavel, valor, recorrente, status, ganhoEm, perdidoEm }
    let responsavelMkt = 0;
    let responsavelCom = 0;
    const proximoComercial = () =>
      comerciais[responsavelCom++ % comerciais.length];

    const criarComercial = async (d) => {
      const idade = diasAtras(d.criadoEm);
      let status = 'ABERTO';
      let etapaChave;
      let ganhoEm = null;
      let perdidoEm = null;
      let motivo = null;
      const aberto = ponderado([
        [true, idade <= 45 ? 60 : idade <= 75 ? 14 : 3],
        [false, 40],
      ]);
      if (aberto) {
        const fracao = Math.min(1, idade / 45);
        etapaChave =
          fracao < 0.12
            ? 'novo'
            : fracao < 0.3
              ? 'qualificacao'
              : fracao < 0.55
                ? 'apresentacao'
                : fracao < 0.8
                  ? 'proposta'
                  : 'negociacao';
      } else if (rand() < 0.38) {
        status = 'GANHO';
        etapaChave = 'ganho';
        ganhoEm = new Date(
          Math.min(
            d.criadoEm.getTime() +
              inteiro(6, 70) * DIA_MS +
              inteiro(0, 8) * 3_600_000,
            agora.getTime() - 3_600_000,
          ),
        );
      } else {
        status = 'PERDIDO';
        etapaChave = 'perdido';
        perdidoEm = new Date(
          Math.min(
            d.criadoEm.getTime() +
              inteiro(4, 60) * DIA_MS +
              inteiro(0, 8) * 3_600_000,
            agora.getTime() - 3_600_000,
          ),
        );
        motivo = ponderado(motivosPerda);
      }
      const valor = escolher(produtosValor) * (0.8 + rand() * 0.5);
      const recorrente =
        rand() < 0.62 ? Math.round((valor / inteiro(6, 12)) * 100) / 100 : null;
      const id = await ins('negocios', {
        titulo: d.titulo,
        contato_id: d.contato.id,
        funil_id: funis.COMERCIAL.id,
        etapa_id: funis.COMERCIAL.etapas[etapaChave],
        responsavel_id: d.responsavel,
        status,
        valor: Math.round(valor * 100) / 100,
        valor_recorrente: recorrente,
        previsao_fechamento:
          status === 'ABERTO'
            ? somarDias(
                hojeIso,
                rand() < 0.15 ? -inteiro(1, 12) : inteiro(2, 50),
              )
            : null,
        motivo_perda: motivo,
        ganho_em: ganhoEm,
        perdido_em: perdidoEm,
        etapa_desde:
          ganhoEm ??
          perdidoEm ??
          new Date(agora.getTime() - Math.min(idade, inteiro(1, 20)) * DIA_MS),
        negocio_origem_id: d.origemId ?? null,
        origem: d.origem,
        origem_detalhe: d.origemDetalhe ?? null,
        utm: d.utm ?? null,
        criado_em: d.criadoEm,
        atualizado_em: ganhoEm ?? perdidoEm ?? agora,
      });
      const registro = {
        id,
        contato: d.contato,
        criadoEm: d.criadoEm,
        responsavel: d.responsavel,
        valor,
        recorrente,
        status,
        ganhoEm,
        perdidoEm,
        etapaChave,
      };
      negociosComerciais.push(registro);
      return registro;
    };

    let sequenciaLead = 0;
    const leadsCriados = [];
    for (let i = 0; i < 520; i++) {
      const idade = Math.min(364, Math.floor(365 * rand() ** 1.08));
      const criadoEm = em(idade, inteiro(8, 19), inteiro(0, 59));
      const contato = novoContato();
      const comUtm = rand() < 0.78;
      const combo = comUtm
        ? ponderado(combosUtm.map((c) => [c, c.peso]))
        : null;
      const origem = combo
        ? combo.origem
        : escolher(['MANUAL', 'IMPORTACAO', 'WEBHOOK', 'WHATSAPP']);
      sequenciaLead += 1;
      let status = 'ABERTO';
      let etapaChave;
      let ganhoEm = null;
      let perdidoEm = null;
      let motivo = null;
      const decidido = idade >= 10 ? true : rand() < 0.3;
      if (!decidido) {
        etapaChave =
          idade < 2
            ? 'novo_lead'
            : escolher(['em_contato', 'nutricao', 'em_contato']);
      } else {
        const r = rand();
        if (r < 0.56) {
          status = 'GANHO';
          etapaChave = 'qualificado_mql';
          ganhoEm = new Date(
            Math.min(
              criadoEm.getTime() +
                inteiro(1, 12) * DIA_MS +
                inteiro(0, 6) * 3_600_000,
              agora.getTime() - 3_600_000,
            ),
          );
        } else if (r < 0.8 || idade >= 60) {
          status = 'PERDIDO';
          etapaChave = 'descartado';
          perdidoEm = new Date(
            Math.min(
              criadoEm.getTime() + inteiro(2, 20) * DIA_MS,
              agora.getTime() - 3_600_000,
            ),
          );
          motivo = escolher(motivosPerdaMarketing);
        } else {
          etapaChave = escolher(['nutricao', 'em_contato']);
        }
      }
      const utm = combo
        ? {
            source: combo.source,
            medium: combo.medium,
            campaign: combo.campaign,
          }
        : null;
      const responsavel = marketings[responsavelMkt++ % marketings.length];
      const leadId = await ins('negocios', {
        titulo: `Lead — ${contato.nome}`,
        contato_id: contato.id,
        funil_id: funis.MARKETING.id,
        etapa_id: funis.MARKETING.etapas[etapaChave],
        responsavel_id: responsavel,
        status,
        valor: 0,
        motivo_perda: motivo,
        ganho_em: ganhoEm,
        perdido_em: perdidoEm,
        etapa_desde: ganhoEm ?? perdidoEm ?? criadoEm,
        origem,
        origem_detalhe: combo ? `${combo.source} / ${combo.campaign}` : null,
        utm,
        criado_em: criadoEm,
        atualizado_em: ganhoEm ?? perdidoEm ?? criadoEm,
      });
      leadsCriados.push({ id: leadId, criadoEm, responsavel, status, contato });
      if (status === 'GANHO') {
        const criadoCom = new Date(ganhoEm.getTime() + 60_000);
        const comercial = await criarComercial({
          titulo: contato.nome,
          contato,
          criadoEm:
            criadoCom > agora ? new Date(agora.getTime() - 30_000) : criadoCom,
          responsavel: proximoComercial(),
          origemId: leadId,
          origem: 'PASSAGEM',
          origemDetalhe: 'Passagem Marketing → Comercial',
          utm,
        });
        if (passagemMc) {
          await ins('passagem_execucoes', {
            passagem_id: passagemMc,
            negocio_origem_id: leadId,
            negocio_destino_id: comercial.id,
            criado_em: comercial.criadoEm,
          });
        }
      }
    }
    // Negócios do Comercial sem passagem (indicação, WhatsApp, site).
    for (let i = 0; i < 90; i++) {
      const idade = Math.min(364, Math.floor(365 * rand() ** 1.05));
      const contato = novoContato();
      await criarComercial({
        titulo: contato.nome,
        contato,
        criadoEm: em(idade, inteiro(8, 18), inteiro(0, 59)),
        responsavel: proximoComercial(),
        origem: escolher(['INDICACAO', 'WHATSAPP', 'SITE', 'MANUAL', 'EMAIL']),
      });
    }
    const ganhos = negociosComerciais.filter((n) => n.status === 'GANHO');
    nota(
      `${leadsCriados.length} leads, ${negociosComerciais.length} negócios do Comercial (${ganhos.length} ganhos, ${negociosComerciais.filter((n) => n.status === 'PERDIDO').length} perdidos)`,
    );

    // ------------------------------------------------ contratos e CS ---
    passo('Onda C: contratos, MRR, parcelas e negócios de CS');
    const candidatos = ganhos
      .filter((n) => n.recorrente && n.ganhoEm)
      .sort((a, b) => a.ganhoEm - b.ganhoEm);
    const taxa = Math.min(1, 62 / Math.max(1, candidatos.length));
    const escolhidos = candidatos.filter(() => rand() < taxa);
    const contratos = [];
    let sequenciaCliente = 0;
    for (const g of escolhidos) {
      sequenciaCliente += 1;
      const inicio = new Date(
        Math.min(
          g.ganhoEm.getTime() + inteiro(3, 10) * DIA_MS,
          agora.getTime() - DIA_MS,
        ),
      );
      const periodicidade = ponderado([
        ['MENSAL', 80],
        ['TRIMESTRAL', 10],
        ['ANUAL', 6],
        ['SEMESTRAL', 4],
      ]);
      const meses = { MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 }[
        periodicidade
      ];
      const mrr =
        Math.round(Math.max(290, Math.min(6500, g.recorrente)) * 100) / 100;
      contratos.push({
        negocio: g,
        contato: g.contato,
        inicioIso: isoDe(inicio),
        inicio,
        periodicidade,
        meses,
        mrr,
        mrrAtual: mrr,
        valor: Math.round(mrr * meses * 100) / 100,
        dia: escolher([5, 10, 10, 15, 20, 25]),
        status: 'ATIVO',
        responsavel: csUsuarios[sequenciaCliente % csUsuarios.length],
        movimentos: [{ tipo: 'NOVO', delta: mrr, diaIso: isoDe(inicio) }],
        n: sequenciaCliente,
      });
    }
    const idadeInicio = (c) => diasAtras(c.inicio);
    const livres = () =>
      contratos.filter((c) => c.status === 'ATIVO' && !c.marcado);
    const mover = (c, tipo, fator, idade) => {
      const novo = Math.round(c.mrrAtual * fator * 100) / 100;
      c.movimentos.push({
        tipo,
        delta: Math.round((novo - c.mrrAtual) * 100) / 100,
        diaIso: diaIso(idade),
      });
      c.mrrAtual = novo;
      c.valor = Math.round(novo * c.meses * 100) / 100;
    };
    // Churn (cancelamentos e encerramentos): um por alvo de idade, em contratos já com mais de 45 dias.
    const cancelamentos = [8, 21, 36, 52, 70, 110, 150, 220];
    const motivosCancelamento = [
      'Inadimplência',
      'Migrou para o concorrente',
      'Corte de custos',
      'Insatisfação com o suporte',
      'Fechou a empresa',
    ];
    let inadimplenteCancelado = null;
    for (const alvo of cancelamentos) {
      const c =
        escolher(livres().filter((x) => idadeInicio(x) >= alvo + 45) || []) ??
        null;
      if (!c) continue;
      c.marcado = true;
      c.status = 'CANCELADO';
      c.canceladoIdade = alvo;
      c.motivo = escolher(motivosCancelamento);
      if (alvo >= 100 && !inadimplenteCancelado) {
        inadimplenteCancelado = c;
        c.motivo = 'Inadimplência';
      }
      c.movimentos.push({
        tipo: 'CHURN',
        delta: -c.mrrAtual,
        diaIso: diaIso(alvo),
      });
    }
    for (const alvo of [15, 44, 95, 190]) {
      const c =
        escolher(livres().filter((x) => idadeInicio(x) >= alvo + 60) || []) ??
        null;
      if (!c) continue;
      c.marcado = true;
      c.status = 'ENCERRADO';
      c.encerradoIdade = alvo;
      c.movimentos.push({
        tipo: 'CHURN',
        delta: -c.mrrAtual,
        diaIso: diaIso(alvo),
      });
    }
    for (const alvo of [10, 14, 28, 40, 47, 70, 100, 130, 180]) {
      const c =
        escolher(livres().filter((x) => idadeInicio(x) >= alvo + 25) || []) ??
        null;
      if (!c) continue;
      c.marcado = true;
      mover(c, 'EXPANSAO', 1.2 + rand() * 0.3, alvo);
    }
    for (const alvo of [18, 45, 90, 160]) {
      const c =
        escolher(livres().filter((x) => idadeInicio(x) >= alvo + 25) || []) ??
        null;
      if (!c) continue;
      c.marcado = true;
      mover(c, 'CONTRACAO', 0.75 + rand() * 0.1, alvo);
    }
    for (const c of livres()
      .filter((x) => idadeInicio(x) > 60)
      .slice(0, 3)) {
      c.status = 'SUSPENSO';
    }

    const produtos = [
      'Plano Essencial',
      'Plano Profissional',
      'Plano Enterprise',
      'Suporte Premium',
      'Módulo Fiscal',
    ];
    let sequenciaParcela = 0;
    const parcelasInseridas = []; // { id, numero, contrato, vencimentoIso, valor, status, pagoEmIso }
    const atrasadosForcados = [1, 1, 2, 2, 3, 3, 4, 5];
    const candidatosAtraso = contratos
      .filter(
        (c) =>
          (c.status === 'ATIVO' || c.status === 'SUSPENSO') &&
          c.meses === 1 &&
          idadeInicio(c) >= 200,
      )
      .slice(0, atrasadosForcados.length);
    candidatosAtraso.forEach((c, i) => {
      c.mesesEmAtraso = atrasadosForcados[i];
    });
    // Cliente sem contrato mensal antigo suficiente: completa com mensais mais novos.
    for (const c of contratos
      .filter(
        (x) =>
          x.status === 'ATIVO' &&
          x.meses === 1 &&
          !x.mesesEmAtraso &&
          idadeInicio(x) >= 130,
      )
      .slice(
        0,
        Math.max(0, atrasadosForcados.length - candidatosAtraso.length),
      )) {
      c.mesesEmAtraso = atrasadosForcados[candidatosAtraso.length] ?? 2;
      candidatosAtraso.push(c);
    }
    const comPromessa = candidatosAtraso.find((c) => c.mesesEmAtraso === 1);
    const paraRenegociar =
      candidatosAtraso.find((c) => c.mesesEmAtraso === 3) ??
      candidatosAtraso.at(-1);

    for (const c of contratos) {
      const empresaId = await criarEmpresa(c.contato, c.n);
      const fimIso =
        c.status === 'CANCELADO'
          ? diaIso(c.canceladoIdade)
          : c.status === 'ENCERRADO'
            ? diaIso(c.encerradoIdade)
            : null;
      const renovacaoIso =
        c.status === 'ATIVO' ? somarDias(c.inicioIso, 365) : null;
      c.empresaId = empresaId;
      c.renovacaoIso = renovacaoIso;
      c.id = await ins('contratos', {
        empresa_id: empresaId,
        contato_id: c.contato.id,
        negocio_id: c.negocio.id,
        produto: produtos[c.n % produtos.length],
        descricao: `Contrato de ${produtos[c.n % produtos.length].toLowerCase()} (${c.periodicidade.toLowerCase()})`,
        valor: c.valor,
        periodicidade: c.periodicidade,
        mrr:
          c.status === 'CANCELADO' || c.status === 'ENCERRADO' ? 0 : c.mrrAtual,
        inicio_em: c.inicioIso,
        fim_em: c.status === 'ENCERRADO' ? fimIso : null,
        renovacao_em: renovacaoIso,
        renovacao_automatica: c.n % 3 === 0,
        dia_vencimento: c.dia,
        status: c.status,
        responsavel_cs_id: c.responsavel,
        cancelado_em:
          c.status === 'CANCELADO' ? em(c.canceladoIdade, 11) : null,
        motivo_cancelamento: c.status === 'CANCELADO' ? c.motivo : null,
        encerrado_em:
          c.status === 'ENCERRADO' ? em(c.encerradoIdade, 11) : null,
        criado_em: new Date(c.inicio.getTime() - 2 * DIA_MS),
      });
      for (const m of c.movimentos) {
        const acumulado = 0;
        void acumulado;
        await ins('movimentos_mrr', {
          contrato_id: c.id,
          tipo: m.tipo,
          valor_anterior: 0,
          valor_novo: 0,
          delta: m.delta,
          dia: m.diaIso,
          ocorrido_em:
            new Date(`${m.diaIso}T15:00:00Z`) > agora
              ? new Date(agora.getTime() - 60_000)
              : new Date(`${m.diaIso}T15:00:00Z`),
          motivo:
            m.tipo === 'CHURN' ? (c.motivo ?? 'Contrato encerrado') : null,
        });
      }

      // Parcelas: do primeiro vencimento até ~35 dias à frente (ou até o fim do contrato).
      const limiteIso = fimIso ?? somarDias(hojeIso, 35);
      let vencimento =
        c.inicioIso.slice(0, 7) +
        `-${String(Math.min(c.dia, 28)).padStart(2, '0')}`;
      while (vencimento < somarDias(c.inicioIso, 5))
        vencimento = somarMesesIso(vencimento, 1);
      const lista = [];
      while (vencimento <= limiteIso) {
        lista.push(vencimento);
        vencimento = somarMesesIso(vencimento, c.meses);
      }
      const passadas = lista.filter((v) => v < hojeIso);
      const naoPagas = new Set(
        c.mesesEmAtraso
          ? passadas.slice(-c.mesesEmAtraso)
          : c === inadimplenteCancelado
            ? passadas.slice(-3)
            : [],
      );
      let sequencia = 0;
      for (const venc of lista) {
        sequencia += 1;
        sequenciaParcela += 1;
        const dias = Math.floor(
          (Date.parse(`${hojeIso}T00:00:00Z`) -
            Date.parse(`${venc}T00:00:00Z`)) /
            DIA_MS,
        );
        let status;
        if (venc >= hojeIso) status = 'ABERTO';
        else if (naoPagas.has(venc)) status = 'ATRASADO';
        else if (dias <= 4) status = rand() < 0.55 ? 'PAGO' : 'ATRASADO';
        else status = rand() < 0.94 ? 'PAGO' : 'ATRASADO';
        const pagoIso =
          status === 'PAGO'
            ? minimoIso(somarDias(venc, inteiro(-2, 6)), hojeIso)
            : null;
        const numero = `T-H${String(sequenciaParcela).padStart(5, '0')}`;
        const valor = Math.round(c.mrrAtual * c.meses * 100) / 100;
        const id = await ins('parcelas', {
          numero,
          sequencia,
          contrato_id: c.id,
          contato_id: c.contato.id,
          empresa_id: empresaId,
          origem: 'CONTRATO',
          descricao: `${produtos[c.n % produtos.length]} — parcela ${sequencia}`,
          vencimento: venc,
          vencimento_original: venc,
          valor,
          valor_pago: status === 'PAGO' ? valor : null,
          status,
          link_boleto:
            status === 'PAGO'
              ? null
              : `https://pagamentos.demo.local/boleto/${numero}`,
          link_pagamento:
            status === 'PAGO'
              ? null
              : `https://pagamentos.demo.local/pagar/${numero}`,
          pix:
            status === 'PAGO'
              ? null
              : `00020126580014br.gov.bcb.pix0136${numero.toLowerCase()}`,
          pago_em: pagoIso,
          forma_pagamento:
            status === 'PAGO'
              ? escolher(['PIX', 'PIX', 'BOLETO', 'CARTAO', 'TRANSFERENCIA'])
              : null,
          baixa_origem:
            status === 'PAGO'
              ? escolher(['IMPORTACAO', 'IMPORTACAO', 'MANUAL'])
              : null,
          atrasada_em:
            status === 'ATRASADO'
              ? new Date(`${somarDias(venc, 1)}T12:00:00Z`)
              : null,
          criado_em: new Date(
            Math.min(
              new Date(`${somarDias(venc, -20)}T12:00:00Z`).getTime(),
              agora.getTime() - 60_000,
            ),
          ),
        });
        parcelasInseridas.push({
          id,
          numero,
          contrato: c,
          vencimentoIso: venc,
          valor,
          status,
          pagoIso,
          dias,
        });
      }
      if (c.status === 'CANCELADO' && c.n % 2 === 0) {
        // Título que ainda caiu depois do cancelamento: cancelado.
        sequenciaParcela += 1;
        const venc = somarMesesIso(lista.at(-1) ?? c.inicioIso, c.meses);
        await ins('parcelas', {
          numero: `T-H${String(sequenciaParcela).padStart(5, '0')}`,
          sequencia: sequencia + 1,
          contrato_id: c.id,
          contato_id: c.contato.id,
          empresa_id: empresaId,
          origem: 'CONTRATO',
          descricao: 'Parcela cancelada com o contrato',
          vencimento: venc,
          vencimento_original: venc,
          valor: Math.round(c.mrrAtual * c.meses * 100) / 100,
          status: 'CANCELADO',
          criado_em: em(c.canceladoIdade + 10, 9),
        });
      }
    }

    // Renegociação: o título mais antigo do cliente com 3 meses de atraso vira RENEGOCIADO.
    if (paraRenegociar) {
      const alvo = parcelasInseridas
        .filter((p) => p.contrato === paraRenegociar && p.status === 'ATRASADO')
        .sort((a, b) => a.vencimentoIso.localeCompare(b.vencimentoIso))[0];
      if (alvo) {
        sequenciaParcela += 1;
        const venc = somarDias(hojeIso, 10);
        const novaId = await ins('parcelas', {
          numero: `T-H${String(sequenciaParcela).padStart(5, '0')}`,
          contrato_id: paraRenegociar.id,
          contato_id: paraRenegociar.contato.id,
          empresa_id: paraRenegociar.empresaId,
          origem: 'RENEGOCIACAO',
          descricao: 'Renegociação do título atrasado (com 2% de juros)',
          vencimento: venc,
          vencimento_original: venc,
          valor: Math.round(alvo.valor * 1.02 * 100) / 100,
          status: 'ABERTO',
          link_pagamento: `https://pagamentos.demo.local/pagar/reneg-${alvo.numero}`,
          criado_em: em(2, 10),
        });
        await cliente.query(
          `UPDATE parcelas SET status = 'RENEGOCIADO', renegociada_para_id = $1, atrasada_em = NULL WHERE id = $2`,
          [novaId, alvo.id],
        );
        alvo.status = 'RENEGOCIADO';
      }
    }

    // Negócios de CS (um por contrato) e passagem Comercial → CS.
    const csPorEtapa = (c) => {
      const idade = idadeInicio(c);
      if (c.status === 'CANCELADO' || c.status === 'ENCERRADO')
        return ['cancelado', 'PERDIDO'];
      if (idade < 12) return ['boas_vindas', 'ABERTO'];
      if (idade < 35) return ['onboarding', 'ABERTO'];
      if (idade < 60) return ['implantacao', 'ABERTO'];
      const dias = Math.floor(
        (Date.parse(`${c.renovacaoIso}T00:00:00Z`) -
          Date.parse(`${hojeIso}T00:00:00Z`)) /
          DIA_MS,
      );
      return [dias <= 60 ? 'renovacao' : 'acompanhamento', 'ABERTO'];
    };
    let renovacaoForcada = 0;
    for (const c of contratos) {
      let [etapaChave, status] = csPorEtapa(c);
      let previsao = c.renovacaoIso;
      if (status === 'ABERTO' && idadeInicio(c) >= 60) {
        // Algumas renovações vencidas e outras logo à frente, para os cartões do CS.
        if (renovacaoForcada < 3 && c.status === 'ATIVO') {
          previsao = somarDias(hojeIso, -inteiro(2, 14));
          etapaChave = 'renovacao';
          renovacaoForcada += 1;
        } else if (renovacaoForcada < 11 && c.status === 'ATIVO') {
          previsao = somarDias(hojeIso, inteiro(1, 28));
          etapaChave = 'renovacao';
          renovacaoForcada += 1;
        }
        if (previsao !== c.renovacaoIso) {
          await cliente.query(
            'UPDATE contratos SET renovacao_em = $1 WHERE id = $2',
            [previsao, c.id],
          );
          c.renovacaoIso = previsao;
        }
      }
      const perdidoEm =
        status === 'PERDIDO'
          ? em(c.canceladoIdade ?? c.encerradoIdade, 11)
          : null;
      const criadoEm = new Date(
        Math.min(
          (c.negocio.ganhoEm?.getTime() ?? c.inicio.getTime()) + 5 * 60_000,
          agora.getTime() - 60_000,
        ),
      );
      const csId = await ins('negocios', {
        titulo: `CS — ${c.contato.nome}`,
        contato_id: c.contato.id,
        empresa_id: c.empresaId,
        funil_id: funis.CS.id,
        etapa_id: funis.CS.etapas[etapaChave],
        responsavel_id: c.responsavel,
        status,
        valor: Math.round(c.mrrAtual * 12 * 100) / 100,
        valor_recorrente: c.mrrAtual,
        previsao_fechamento: status === 'ABERTO' ? previsao : null,
        motivo_perda:
          status === 'PERDIDO'
            ? (c.motivo ?? 'Contrato encerrado sem renovação')
            : null,
        perdido_em: perdidoEm,
        etapa_desde:
          perdidoEm ??
          new Date(
            agora.getTime() - Math.min(idadeInicio(c), inteiro(2, 25)) * DIA_MS,
          ),
        negocio_origem_id: c.negocio.id,
        origem: 'PASSAGEM',
        origem_detalhe: 'Passagem Comercial → Customer Success',
        criado_em: criadoEm,
        atualizado_em: perdidoEm ?? agora,
      });
      c.csId = csId;
      if (passagemCs) {
        await ins('passagem_execucoes', {
          passagem_id: passagemCs,
          negocio_origem_id: c.negocio.id,
          negocio_destino_id: csId,
          criado_em: criadoEm,
        });
      }
    }
    // Renovações já concluídas ao longo do ano (negócios de CS ganhos).
    for (let i = 0; i < 24; i++) {
      const idade = Math.min(360, Math.floor(365 * rand() ** 1.15));
      const contato = novoContato();
      const ganhoEm = em(idade, inteiro(9, 17));
      const mrr = escolher([450, 780, 1200, 1900, 2600, 3800]);
      await ins('negocios', {
        titulo: `Renovação — ${contato.nome}`,
        contato_id: contato.id,
        funil_id: funis.CS.id,
        etapa_id: funis.CS.etapas.renovado,
        responsavel_id: escolher(csUsuarios),
        status: 'GANHO',
        valor: mrr * 12,
        valor_recorrente: mrr,
        ganho_em: ganhoEm,
        etapa_desde: ganhoEm,
        origem: 'MANUAL',
        criado_em: new Date(ganhoEm.getTime() - inteiro(10, 40) * DIA_MS),
        atualizado_em: ganhoEm,
      });
    }
    nota(`${contratos.length} contratos, ${parcelasInseridas.length} parcelas`);

    // -------------------------------------------------- atividades ---
    passo(
      'Onda C: atividades (feitas, futuras e atrasadas) e interações com os clientes',
    );
    const titulosAtividade = {
      LIGACAO: [
        'Ligar para o contato',
        'Retorno da proposta',
        'Confirmar recebimento',
      ],
      REUNIAO: [
        'Apresentação do produto',
        'Reunião de alinhamento',
        'Demonstração',
      ],
      EMAIL: ['Enviar proposta', 'Enviar material', 'Follow-up por e-mail'],
      TAREFA: ['Preparar contrato', 'Atualizar cadastro', 'Revisar condições'],
      WHATSAPP: ['Mensagem de acompanhamento', 'Confirmar reunião'],
    };
    let atrasadasCriadas = 0;
    const atividade = async (d) => {
      const tipo =
        d.tipo ??
        ponderado([
          ['LIGACAO', 30],
          ['REUNIAO', 18],
          ['EMAIL', 22],
          ['TAREFA', 20],
          ['WHATSAPP', 10],
        ]);
      const venceEm = d.venceEm;
      let status = 'CONCLUIDA';
      let concluidaEm = null;
      if (venceEm > agora) {
        status = 'PENDENTE';
      } else if (d.forcarAberta) {
        status = 'PENDENTE';
        atrasadasCriadas += 1;
      } else if (rand() < 0.05) {
        status = 'CANCELADA';
      } else {
        concluidaEm = new Date(
          Math.min(
            venceEm.getTime() + inteiro(-20, 26) * 3_600_000,
            agora.getTime() - 60_000,
          ),
        );
      }
      await ins('atividades', {
        tipo,
        titulo: `${escolher(titulosAtividade[tipo])} — ${d.contato.nome}`,
        status,
        prioridade: escolher(['BAIXA', 'MEDIA', 'MEDIA', 'ALTA']),
        vence_em: venceEm,
        responsavel_id: d.responsavel,
        criado_por_id: d.responsavel,
        concluida_em: concluidaEm,
        concluida_por_id: concluidaEm ? d.responsavel : null,
        cancelada_em: status === 'CANCELADA' ? venceEm : null,
        contato_id: d.contato.id,
        negocio_id: d.negocioId ?? null,
        criado_em: new Date(
          Math.min(
            venceEm.getTime() - inteiro(1, 5) * DIA_MS,
            agora.getTime() - 60_000,
          ),
        ),
      });
    };
    for (const n of negociosComerciais) {
      const fim = n.ganhoEm ?? n.perdidoEm ?? agora;
      const quantidade = n.status === 'ABERTO' ? inteiro(1, 3) : inteiro(2, 4);
      for (let k = 0; k < quantidade; k++) {
        const t =
          n.criadoEm.getTime() +
          ((fim.getTime() - n.criadoEm.getTime()) * (k + 1)) / (quantidade + 1);
        let venceEm = new Date(t);
        let forcarAberta = false;
        if (n.status === 'ABERTO' && k === quantidade - 1) {
          // O último passo dos negócios abertos fica no futuro, ou atrasado (cerca de 14%).
          if (rand() < 0.14 && atrasadasCriadas < 22) {
            venceEm = new Date(agora.getTime() - inteiro(1, 9) * DIA_MS);
            forcarAberta = true;
          } else {
            venceEm = new Date(agora.getTime() + inteiro(1, 12) * DIA_MS);
          }
        }
        await atividade({
          responsavel: n.responsavel,
          contato: n.contato,
          negocioId: n.id,
          venceEm,
          forcarAberta,
        });
      }
    }
    for (const l of leadsCriados.filter(() => rand() < 0.4)) {
      const venceEm = new Date(
        Math.min(
          l.criadoEm.getTime() + inteiro(1, 6) * DIA_MS,
          agora.getTime() + 3 * DIA_MS,
        ),
      );
      await atividade({
        responsavel: l.responsavel,
        contato: l.contato,
        negocioId: l.id,
        venceEm,
        tipo: escolher(['EMAIL', 'TAREFA', 'LIGACAO']),
      });
    }
    for (const c of contratos) {
      // Relacionamento do CS: onboarding e acompanhamento, e uma interação recente na maioria dos clientes.
      for (const dia of [2, 9]) {
        if (idadeInicio(c) > dia + 2) {
          await atividade({
            responsavel: c.responsavel,
            contato: c.contato,
            negocioId: c.csId,
            venceEm: new Date(c.inicio.getTime() + dia * DIA_MS),
            tipo: dia === 2 ? 'REUNIAO' : 'LIGACAO',
          });
        }
      }
      if (c.status === 'ATIVO' && rand() < 0.78) {
        await atividade({
          responsavel: c.responsavel,
          contato: c.contato,
          negocioId: c.csId,
          venceEm: em(inteiro(3, 24), inteiro(9, 17)),
          tipo: escolher(['REUNIAO', 'LIGACAO']),
        });
      }
    }
    nota(`${atrasadasCriadas} atividades atrasadas e abertas`);

    // ---------------------------------------------------- conversas ---
    passo('Onda C: conversas com tempos de resposta, SLA e CSAT');
    const mapaFila = [
      ['Vendas', ['WhatsApp Vendas', 'E-mail vendas'], comerciais, 33],
      ['Pré-vendas', ['Instagram BRL'], comerciais, 14],
      ['Triagem do site', ['Chat do site'], comerciais, 14],
      [
        'Suporte CS',
        ['WhatsApp Suporte', 'E-mail atendimento', 'Messenger BRL'],
        csUsuarios,
        39,
      ],
    ].filter(
      ([nome, canalNomes]) => filas[nome] && canalNomes.some((n) => canais[n]),
    );
    const totalConversas = 900;
    let nConversas = 0;
    const pesoHora = [
      0, 0, 0, 0, 0, 0, 0, 1, 4, 9, 11, 9, 6, 7, 10, 10, 8, 6, 3, 2, 1, 1, 0, 0,
    ];
    for (let i = 0; i < totalConversas; i++) {
      let idade = Math.min(364, Math.floor(365 * rand() ** 1.05));
      const [filaNome, canalNomes, atendentes] = ponderado(
        mapaFila.map((f) => [f, f[3]]),
      );
      const fila = filas[filaNome];
      const canalNome = escolher(canalNomes.filter((n) => canais[n]));
      const hora = ponderado(pesoHora.map((p, h) => [h, p]));
      let criadoEm = em(idade, hora, inteiro(0, 59));
      // Fim de semana tem pouco movimento: empurra para o dia útil anterior na maioria das vezes.
      const semana = new Date(criadoEm.getTime() - 3 * 3_600_000).getUTCDay();
      if ((semana === 0 || semana === 6) && rand() < 0.8) {
        idade += semana === 0 ? 2 : 1;
        criadoEm = em(idade, hora, inteiro(0, 59));
      }
      // Quanto mais recente, melhor o atendimento (primeira resposta mais curta).
      const melhora = 1 - 0.3 * (1 - Math.min(1, idade / 365));
      const semResposta = rand() < 0.04;
      const minutosPrimeira = Math.max(
        1,
        Math.round(fila.p * Math.exp((rand() - 0.62) * 1.7) * melhora),
      );
      const primeira = semResposta
        ? null
        : new Date(
            criadoEm.getTime() +
              minutosPrimeira * 60_000 +
              inteiro(0, 59) * 1000,
          );
      const minutosResolver = Math.round(
        minutosPrimeira + fila.r * 0.45 * Math.exp((rand() - 0.55) * 1.6),
      );
      const resolvidaEm = new Date(
        Math.min(
          criadoEm.getTime() + minutosResolver * 60_000,
          agora.getTime() - 60_000,
        ),
      );
      if (primeira && primeira > resolvidaEm) continue;
      const responsavel = escolher(atendentes);
      const contato = novoContato();
      const pediu = rand() < 0.82;
      const respondeu = pediu && rand() < 0.58;
      const nota5 = ponderado([
        [1, 6],
        [2, 7],
        [3, 15],
        [4, 32],
        [5, 40],
      ]);
      const conversaId = randomUUID();
      const entradaId = randomUUID();
      const saidaId = randomUUID();
      await ins('conversas', {
        id: conversaId,
        canal_id: canais[canalNome],
        contato_id: contato.id,
        fila_id: fila.id,
        responsavel_id: responsavel,
        atribuida_em: new Date(criadoEm.getTime() + 20_000),
        status: 'RESOLVIDA',
        assunto: escolher([
          'Dúvida sobre proposta',
          'Segunda via de boleto',
          'Como usar o módulo',
          'Prazo de implantação',
          'Cancelamento de serviço',
          'Orçamento',
          'Suporte técnico',
        ]),
        ultima_mensagem_em: resolvidaEm,
        ultima_entrada_em: criadoEm,
        primeira_resposta_em: primeira,
        resolvida_em: resolvidaEm,
        resolvida_por_id: responsavel,
        sla_primeira_resposta_ate: new Date(
          criadoEm.getTime() + fila.p * 60_000,
        ),
        sla_resolucao_ate: new Date(criadoEm.getTime() + fila.r * 60_000),
        satisfacao_solicitada_em: pediu
          ? new Date(resolvidaEm.getTime() + 60_000)
          : null,
        satisfacao_nota: respondeu ? nota5 : null,
        satisfacao_respondida_em: respondeu
          ? new Date(resolvidaEm.getTime() + inteiro(5, 90) * 60_000)
          : null,
        criado_em: criadoEm,
        atualizado_em: resolvidaEm,
      });
      await ins('mensagens', {
        id: entradaId,
        conversa_id: conversaId,
        canal_id: canais[canalNome],
        direcao: 'ENTRADA',
        texto: 'Olá! Preciso de ajuda com o meu atendimento.',
        ocorrida_em: criadoEm,
        criado_em: criadoEm,
      });
      await ins('mensagens', {
        id: saidaId,
        conversa_id: conversaId,
        canal_id: canais[canalNome],
        direcao: 'SAIDA',
        texto: 'Olá! Claro, já vou resolver isso para você.',
        autor_id: responsavel,
        autor_tipo: 'USUARIO',
        status: 'LIDA',
        ocorrida_em: primeira ?? resolvidaEm,
        enviada_em: primeira ?? resolvidaEm,
        criado_em: primeira ?? resolvidaEm,
      });
      await cliente.query(
        'UPDATE conversas SET ultima_mensagem_id = $1 WHERE id = $2',
        [saidaId, conversaId],
      );
      nConversas += 1;
    }
    // Clientes insatisfeitos (nota baixa recente) para o risco de churn.
    const insatisfeitos = contratos
      .filter((c) => c.status === 'ATIVO')
      .slice(0, 4);
    for (const c of insatisfeitos) {
      const criadoEm = em(inteiro(4, 20), 11);
      const resolvidaEm = new Date(criadoEm.getTime() + 3 * 3_600_000);
      await ins('conversas', {
        canal_id: canais['WhatsApp Suporte'] ?? Object.values(canais)[0],
        contato_id: c.contato.id,
        fila_id: filas['Suporte CS']?.id ?? null,
        responsavel_id: c.responsavel,
        status: 'RESOLVIDA',
        assunto: 'Reclamação sobre o atendimento',
        ultima_mensagem_em: resolvidaEm,
        primeira_resposta_em: new Date(criadoEm.getTime() + 25 * 60_000),
        resolvida_em: resolvidaEm,
        sla_primeira_resposta_ate: new Date(criadoEm.getTime() + 5 * 60_000),
        sla_resolucao_ate: new Date(criadoEm.getTime() + 240 * 60_000),
        satisfacao_solicitada_em: resolvidaEm,
        satisfacao_nota: escolher([1, 2]),
        satisfacao_respondida_em: new Date(resolvidaEm.getTime() + 30 * 60_000),
        criado_em: criadoEm,
        atualizado_em: resolvidaEm,
      });
    }
    nota(`${nConversas + insatisfeitos.length} conversas resolvidas`);

    // ------------------------------------------------------ campanhas ---
    passo(
      'Onda C: campanhas concluídas (enviados, entregues, lidos, respondidos, opt-outs)',
    );
    const canalWhats = canais['WhatsApp Vendas'] ?? Object.values(canais)[0];
    const campanhas = [
      ['Webinar de lançamento', 'WHATSAPP', 330, 70],
      ['Black Friday antecipada', 'WHATSAPP', 285, 60],
      ['Reativação de leads frios', 'EMAIL', 240, 90],
      ['Newsletter de novembro', 'EMAIL', 215, 110],
      ['Convite para o evento presencial', 'WHATSAPP', 170, 55],
      ['Pesquisa de necessidades', 'EMAIL', 120, 80],
      ['Oferta de renovação antecipada', 'WHATSAPP', 75, 50],
      ['Material rico: guia de gestão', 'EMAIL', 40, 100],
      ['Lembrete de demonstração', 'WHATSAPP', 18, 45],
      ['Newsletter do mês', 'EMAIL', 6, 100],
    ];
    let ordemCampanha = 0;
    for (const [nome, canal, idade, tamanho] of campanhas) {
      ordemCampanha += 1;
      const inicio = em(idade, 10);
      const campanhaId = await ins('campanhas', {
        nome,
        descricao: 'Campanha histórica de demonstração (Onda C).',
        area: 'MARKETING',
        canal,
        status: 'CONCLUIDA',
        tipo_publico: 'SEGMENTO',
        assunto: canal === 'EMAIL' ? nome : null,
        texto: `Olá {{contato.nome}}, ${nome.toLowerCase()}.`,
        agendada_para: inicio,
        iniciada_em: inicio,
        concluida_em: new Date(inicio.getTime() + 3 * 3_600_000),
        criado_por_id: escolher(marketings),
        criado_em: new Date(inicio.getTime() - 2 * DIA_MS),
      });
      const alcance =
        canal === 'WHATSAPP'
          ? { entregue: 0.95, lido: 0.62, respondeu: 0.14 }
          : { entregue: 0.92, lido: 0.38, respondeu: 0.05 };
      for (let k = 0; k < tamanho; k++) {
        const c = contatos[(ordemCampanha * 7 + k) % contatos.length];
        const enviadoEm = new Date(inicio.getTime() + k * 40_000);
        const falhou = rand() < 0.04;
        const entregue = !falhou && rand() < alcance.entregue / 0.96;
        const lido = entregue && rand() < alcance.lido / alcance.entregue;
        const respondeu = lido && rand() < alcance.respondeu / alcance.lido;
        const saiu = lido && rand() < 0.025;
        await ins('campanha_destinatarios', {
          campanha_id: campanhaId,
          contato_id: c.id,
          destino: canal === 'EMAIL' ? c.email : c.telefone,
          ordem: k + 1,
          status: falhou ? 'FALHOU' : 'ENVIADO',
          motivo: falhou
            ? canal === 'EMAIL'
              ? 'Caixa de e-mail inexistente'
              : 'Número sem WhatsApp'
            : null,
          tentativas: 1,
          canal_id:
            canal === 'WHATSAPP'
              ? canalWhats
              : (canais['E-mail vendas'] ?? canalWhats),
          enviado_em: falhou ? null : enviadoEm,
          entregue_em: entregue ? new Date(enviadoEm.getTime() + 20_000) : null,
          lido_em: lido
            ? new Date(enviadoEm.getTime() + inteiro(2, 600) * 60_000)
            : null,
          respondeu_em: respondeu
            ? new Date(enviadoEm.getTime() + inteiro(10, 1500) * 60_000)
            : null,
          opt_out_em: saiu
            ? new Date(enviadoEm.getTime() + inteiro(10, 900) * 60_000)
            : null,
          falhou_em: falhou ? enviadoEm : null,
          criado_em: new Date(inicio.getTime() - DIA_MS),
        });
      }
    }

    // ------------------------------------------------------- régua ---
    passo(
      'Onda C: régua de cobrança (etapas, execuções diárias, envios, ligações e uma promessa)',
    );
    const etapasRegua = await consultar(
      `SELECT id, nome, marco, whatsapp, email, ligacao, texto_whatsapp, roteiro_ligacao FROM regua_etapas WHERE ativa ORDER BY marco`,
    );
    const execucoes = new Map(); // dia -> { id, enviados, falhas, pulados, ligacoes }
    const execucaoDoDia = async (iso) => {
      if (!execucoes.has(iso)) {
        const inicio = new Date(`${iso}T12:00:00Z`);
        const iniciada =
          inicio > agora ? new Date(agora.getTime() - 180_000) : inicio;
        const id = await ins('regua_execucoes', {
          tipo: 'AUTOMATICA',
          dia: iso,
          status: 'CONCLUIDA',
          iniciada_em: iniciada,
          concluida_em: new Date(iniciada.getTime() + 90_000),
        });
        execucoes.set(iso, {
          id,
          enviados: 0,
          falhas: 0,
          pulados: 0,
          ligacoes: 0,
        });
      }
      return execucoes.get(iso);
    };
    const dinheiro = (v) =>
      Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    let envios = 0;
    let ligacoesPendentes = 0;
    let promessas = 0;
    const respostasLigacao = [
      ['NAO_ATENDEU', 40],
      ['SEM_ACORDO', 20],
      ['PROMESSA', 25],
      ['JA_PAGOU', 15],
    ];
    const parcelasDaRegua = parcelasInseridas.filter(
      (p) =>
        p.status !== 'CANCELADO' &&
        p.status !== 'RENEGOCIADO' &&
        p.dias >= -8 &&
        p.dias <= 62,
    );
    const mensagemDe = (e, p, nomeContato) =>
      `Olá, ${nomeContato.split(' ')[0]}! ${e.marco < 0 ? 'Lembrete:' : e.marco === 0 ? 'Hoje vence' : 'Seu título está em atraso:'} o título ${p.numero} de R$ ${dinheiro(p.valor)} vence em ${p.vencimentoIso.split('-').reverse().join('/')}. Pague pelo link: https://pagamentos.demo.local/pagar/${p.numero}`;
    for (const p of parcelasDaRegua) {
      const contatoDaParcela = p.contrato.contato;
      for (const e of etapasRegua) {
        const diaEnvio = somarDias(p.vencimentoIso, e.marco);
        if (diaEnvio > hojeIso) continue;
        if (p.pagoIso && p.pagoIso < diaEnvio) continue; // já tinha pago: a régua parou
        if (diaEnvio < somarDias(hojeIso, -60)) continue;
        const ex = await execucaoDoDia(diaEnvio);
        const ehHoje = diaEnvio === hojeIso;
        const base = {
          parcela_id: p.id,
          ciclo: 1,
          etapa_id: e.id,
          marco: e.marco,
          etapa_nome: e.nome,
          tipo: 'ETAPA',
          dia: diaEnvio,
          execucao_id: ex.id,
          criado_em:
            new Date(`${diaEnvio}T12:00:00Z`) > agora
              ? new Date(agora.getTime() - 60_000)
              : new Date(`${diaEnvio}T12:00:00Z`),
        };
        const horario = new Date(`${diaEnvio}T12:0${inteiro(0, 9)}:00Z`);
        const quando =
          horario > agora ? new Date(agora.getTime() - 120_000) : horario;
        const pulada =
          p.dias - e.marco > 3 + 0 && e.marco < p.dias - 3 && rand() < 0.08;
        if (pulada) {
          await ins('regua_envios', {
            ...base,
            canal: 'WHATSAPP',
            situacao: 'PULADO',
            motivo: 'Além da tolerância de 3 dias da execução.',
          });
          ex.pulados += 1;
          envios += 1;
          continue;
        }
        if (e.whatsapp) {
          const falha = rand() < 0.05;
          await ins('regua_envios', {
            ...base,
            canal: 'WHATSAPP',
            situacao: falha ? 'FALHOU' : 'ENVIADO',
            destino: contatoDaParcela.telefone,
            texto: mensagemDe(e, p, contatoDaParcela.nome),
            agendado_para: quando,
            enviado_em: falha ? null : quando,
            erro: falha ? 'Número sem WhatsApp' : null,
            tentativas: 1,
          });
          falha ? (ex.falhas += 1) : (ex.enviados += 1);
          envios += 1;
        }
        if (e.email) {
          const falha = rand() < 0.3;
          await ins('regua_envios', {
            ...base,
            canal: 'EMAIL',
            situacao: falha ? 'FALHOU' : 'ENVIADO',
            destino: contatoDaParcela.email,
            assunto: `Título ${p.numero} — ${e.nome}`,
            texto: mensagemDe(e, p, contatoDaParcela.nome),
            agendado_para: quando,
            enviado_em: falha ? null : quando,
            erro: falha ? 'SMTP não configurado.' : null,
            tentativas: 1,
          });
          falha ? (ex.falhas += 1) : (ex.enviados += 1);
          envios += 1;
        }
        if (e.ligacao) {
          const ehPromessa =
            p ===
              parcelasInseridas.find(
                (x) => x.contrato === comPromessa && x.status === 'ATRASADO',
              ) && diaEnvio >= somarDias(hojeIso, -3);
          const pendente =
            !ehPromessa &&
            p.status === 'ATRASADO' &&
            (diaEnvio === hojeIso || diaEnvio === somarDias(hojeIso, -1)) &&
            ligacoesPendentes < 6;
          if (pendente) {
            const atividadeId = await ins('atividades', {
              tipo: 'LIGACAO',
              titulo: `Cobrança: ligar para ${contatoDaParcela.nome} (${e.nome}, título ${p.numero})`,
              status: 'PENDENTE',
              prioridade: 'ALTA',
              vence_em: new Date(agora.getTime() + 6 * 3_600_000),
              responsavel_id: p.contrato.responsavel,
              contato_id: contatoDaParcela.id,
              criado_em: quando,
            });
            await ins('regua_envios', {
              ...base,
              canal: 'LIGACAO',
              situacao: 'AGUARDANDO_LIGACAO',
              destino: contatoDaParcela.telefone,
              texto: e.roteiro_ligacao,
              prazo_em: new Date(agora.getTime() + 6 * 3_600_000),
              atividade_id: atividadeId,
            });
            ligacoesPendentes += 1;
          } else {
            const resultado = ehPromessa
              ? 'PROMESSA'
              : ponderado(respostasLigacao);
            await ins('regua_envios', {
              ...base,
              canal: 'LIGACAO',
              situacao: 'LIGACAO_REGISTRADA',
              destino: contatoDaParcela.telefone,
              texto: e.roteiro_ligacao,
              resultado,
              resultado_em: quando,
              resultado_por_id: p.contrato.responsavel,
              observacao: ehPromessa
                ? 'Cliente prometeu pagar após o fechamento da folha.'
                : null,
              promessa_ate: ehPromessa
                ? somarDias(hojeIso, 4)
                : resultado === 'PROMESSA'
                  ? somarDias(diaEnvio, 5)
                  : null,
            });
            if (ehPromessa) {
              promessas += 1;
              await cliente.query(
                `UPDATE parcelas SET promessa_ate = $1, promessa_registrada_em = $2 WHERE id = $3`,
                [somarDias(hojeIso, 4), em(1, 15), p.id],
              );
            }
          }
          ex.ligacoes += 1;
          envios += 1;
        }
        void ehHoje;
      }
    }
    // Promessa de pagamento: o título atrasado mais recente do cliente escolhido (a régua fica suspensa até a data).
    const alvoPromessa = parcelasInseridas
      .filter((x) => x.contrato === comPromessa && x.status === 'ATRASADO')
      .sort((x, y) => y.vencimentoIso.localeCompare(x.vencimentoIso))[0];
    if (alvoPromessa) {
      const ex = await execucaoDoDia(hojeIso);
      await ins('regua_envios', {
        parcela_id: alvoPromessa.id,
        ciclo: 1,
        marco: alvoPromessa.dias,
        etapa_nome: 'Ligação de cobrança',
        tipo: 'ETAPA',
        canal: 'LIGACAO',
        situacao: 'LIGACAO_REGISTRADA',
        dia: diaIso(1),
        execucao_id: ex.id,
        destino: alvoPromessa.contrato.contato.telefone,
        resultado: 'PROMESSA',
        resultado_em: em(1, 15),
        resultado_por_id: alvoPromessa.contrato.responsavel,
        observacao: 'Cliente prometeu pagar após o fechamento da folha.',
        promessa_ate: somarDias(hojeIso, 4),
        criado_em: em(1, 15),
      });
      await cliente.query(
        'UPDATE parcelas SET promessa_ate = $1, promessa_registrada_em = $2 WHERE id = $3',
        [somarDias(hojeIso, 4), em(1, 15), alvoPromessa.id],
      );
      promessas += 1;
    }
    for (const [, ex] of execucoes) {
      await cliente.query(
        'UPDATE regua_execucoes SET resumo = $1 WHERE id = $2',
        [
          JSON.stringify({
            enviados: ex.enviados,
            falhas: ex.falhas,
            pulados: ex.pulados,
            ligacoes: ex.ligacoes,
          }),
          ex.id,
        ],
      );
    }
    nota(
      `${execucoes.size} execuções, ${envios} envios, ${ligacoesPendentes} ligações pendentes, ${promessas} promessa de pagamento`,
    );

    await cliente.query('COMMIT');
    console.log('\n✓ Etapa onda-c concluída.');
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    await cliente.end();
  }
}

/** Tabelas sem `atualizado_em`. */
const SEM_ATUALIZADO = new Set([
  'movimentos_mrr',
  'passagem_execucoes',
  'regua_execucoes',
  'mensagens_x',
]);

function minimoIso(a, b) {
  return a < b ? a : b;
}

/** Soma meses a uma data ISO mantendo o dia (mês curto usa o último dia). */
function somarMesesIso(iso, meses) {
  const [a, m, d] = iso.split('-').map(Number);
  const total = a * 12 + (m - 1) + meses;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return `${ano}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}
