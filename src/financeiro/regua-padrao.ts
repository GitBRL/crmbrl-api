/** Etapas e textos padrão da régua de cobrança (R24.1), todos editáveis. */

export interface EtapaPadrao {
  marco: number;
  nome: string;
  whatsapp: boolean;
  email: boolean;
  ligacao: boolean;
  textoWhatsapp: string | null;
  assuntoEmail: string | null;
  textoEmail: string | null;
  roteiroLigacao: string | null;
}

const RODAPE = 'Qualquer dúvida, é só responder esta mensagem.';

export const TEXTO_PROMESSA_CONFIRMADA_PADRAO =
  'Olá {{contato.primeiro_nome|cliente}}, combinado! Anotamos o pagamento da parcela {{titulo.numero}} (R$ {{titulo.valor}}) para {{titulo.promessa}}. Link de pagamento: {{titulo.link_pagamento}} Obrigado!';

export const TEXTO_PROMESSA_NAO_CUMPRIDA_PADRAO =
  'Olá {{contato.primeiro_nome|cliente}}, não identificamos o pagamento da parcela {{titulo.numero}} (R$ {{titulo.valor}}) prometido para {{titulo.promessa}}. Para regularizar: {{titulo.link_pagamento}} Se já pagou, nos avise por aqui.';

export const ETAPAS_PADRAO: readonly EtapaPadrao[] = [
  {
    marco: -7,
    nome: 'Envio do boleto',
    whatsapp: true,
    email: true,
    ligacao: false,
    textoWhatsapp: `{Olá|Oi} {{contato.primeiro_nome|cliente}}! Sua parcela {{titulo.numero}} no valor de R$ {{titulo.valor}} vence em {{titulo.vencimento}}. Boleto: {{titulo.link_boleto}} Pix: {{titulo.pix}} ${RODAPE}`,
    assuntoEmail:
      'Sua parcela {{titulo.numero}} vence em {{titulo.vencimento}}',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nSua parcela {{titulo.numero}} (R$ {{titulo.valor}}) vence em {{titulo.vencimento}}.\nBoleto: {{titulo.link_boleto}}\nLink de pagamento: {{titulo.link_pagamento}}\n\n${RODAPE}`,
    roteiroLigacao: null,
  },
  {
    marco: -3,
    nome: 'Lembrete preventivo',
    whatsapp: true,
    email: true,
    ligacao: false,
    textoWhatsapp: `{Olá|Oi} {{contato.primeiro_nome|cliente}}, lembrando que a parcela {{titulo.numero}} (R$ {{titulo.valor}}) vence em {{titulo.vencimento}}. Link de pagamento: {{titulo.link_pagamento}}`,
    assuntoEmail:
      'Lembrete: parcela {{titulo.numero}} vence em {{titulo.vencimento}}',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nLembrando que a parcela {{titulo.numero}} (R$ {{titulo.valor}}) vence em {{titulo.vencimento}}.\nLink de pagamento: {{titulo.link_pagamento}}\n\n${RODAPE}`,
    roteiroLigacao: null,
  },
  {
    marco: 0,
    nome: 'Dia do vencimento',
    whatsapp: true,
    email: false,
    ligacao: false,
    textoWhatsapp: `{Olá|Oi} {{contato.primeiro_nome|cliente}}, hoje vence a parcela {{titulo.numero}} (R$ {{titulo.valor}}). Pague pelo link {{titulo.link_pagamento}} ou pelo Pix: {{titulo.pix}}`,
    assuntoEmail: null,
    textoEmail: null,
    roteiroLigacao: null,
  },
  {
    marco: 3,
    nome: 'Lembrete de pagamento',
    whatsapp: true,
    email: true,
    ligacao: false,
    textoWhatsapp: `{Olá|Oi|Tudo bem} {{contato.primeiro_nome|cliente}}? Não identificamos o pagamento da parcela {{titulo.numero}} (R$ {{titulo.valor}}, vencida em {{titulo.vencimento}}). Link: {{titulo.link_pagamento}} Se já pagou, desconsidere.`,
    assuntoEmail: 'Parcela {{titulo.numero}} em atraso',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nNão identificamos o pagamento da parcela {{titulo.numero}} (R$ {{titulo.valor}}), vencida em {{titulo.vencimento}}.\nLink de pagamento: {{titulo.link_pagamento}}\n\nSe já pagou, desconsidere este aviso.`,
    roteiroLigacao: null,
  },
  {
    marco: 5,
    nome: 'Aproximação',
    whatsapp: true,
    email: false,
    ligacao: false,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, a parcela {{titulo.numero}} segue em aberto há {{titulo.dias_atraso}} dias (R$ {{titulo.valor}}). Podemos ajudar com algo? Link: {{titulo.link_pagamento}}`,
    assuntoEmail: null,
    textoEmail: null,
    roteiroLigacao: null,
  },
  {
    marco: 7,
    nome: 'Plano da dívida',
    whatsapp: true,
    email: true,
    ligacao: true,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, a parcela {{titulo.numero}} (R$ {{titulo.valor}}) está vencida há {{titulo.dias_atraso}} dias. Vamos combinar o pagamento? Link: {{titulo.link_pagamento}}`,
    assuntoEmail: 'Vamos regularizar a parcela {{titulo.numero}}?',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nA parcela {{titulo.numero}} (R$ {{titulo.valor}}) está vencida há {{titulo.dias_atraso}} dias. Queremos ajudar a regularizar.\nLink de pagamento: {{titulo.link_pagamento}}\n\n${RODAPE}`,
    roteiroLigacao:
      'Ligar para o cliente, confirmar o recebimento do boleto e combinar uma data de pagamento (registre a promessa).',
  },
  {
    marco: 15,
    nome: 'Alerta de protesto',
    whatsapp: true,
    email: true,
    ligacao: true,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, a parcela {{titulo.numero}} (R$ {{titulo.valor}}) está vencida há {{titulo.dias_atraso}} dias e pode ser encaminhada a protesto. Regularize: {{titulo.link_pagamento}}`,
    assuntoEmail: 'Aviso: parcela {{titulo.numero}} pode ser protestada',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nA parcela {{titulo.numero}} (R$ {{titulo.valor}}) está vencida há {{titulo.dias_atraso}} dias e pode ser encaminhada a protesto.\nRegularize em: {{titulo.link_pagamento}}`,
    roteiroLigacao:
      'Informar o risco de protesto e propor pagamento imediato ou parcelamento.',
  },
  {
    marco: 30,
    nome: 'Prazo limite',
    whatsapp: true,
    email: true,
    ligacao: true,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, este é o prazo limite para a parcela {{titulo.numero}} (R$ {{titulo.valor}}, {{titulo.dias_atraso}} dias de atraso). Pague agora: {{titulo.link_pagamento}}`,
    assuntoEmail: 'Prazo limite: parcela {{titulo.numero}}',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nEste é o prazo limite para a regularização da parcela {{titulo.numero}} (R$ {{titulo.valor}}), com {{titulo.dias_atraso}} dias de atraso.\nLink de pagamento: {{titulo.link_pagamento}}`,
    roteiroLigacao:
      'Último contato antes de medidas formais: oferecer condição final de pagamento.',
  },
  {
    marco: 45,
    nome: 'Negociação pós-protesto',
    whatsapp: true,
    email: true,
    ligacao: true,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, a parcela {{titulo.numero}} (R$ {{titulo.valor}}) segue em aberto há {{titulo.dias_atraso}} dias. Vamos negociar? Responda esta mensagem.`,
    assuntoEmail: 'Negociação da parcela {{titulo.numero}}',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nA parcela {{titulo.numero}} (R$ {{titulo.valor}}) segue em aberto há {{titulo.dias_atraso}} dias. Responda este e-mail para negociarmos.`,
    roteiroLigacao:
      'Negociar a quitação (descontos e parcelamento autorizados pela gestão).',
  },
  {
    marco: 60,
    nome: 'Encaminhamento jurídico',
    whatsapp: true,
    email: true,
    ligacao: false,
    textoWhatsapp: `{{contato.primeiro_nome|Olá}}, a parcela {{titulo.numero}} (R$ {{titulo.valor}}) será encaminhada ao jurídico por estar vencida há {{titulo.dias_atraso}} dias. Para evitar, regularize: {{titulo.link_pagamento}}`,
    assuntoEmail: 'Encaminhamento jurídico: parcela {{titulo.numero}}',
    textoEmail: `Olá {{contato.primeiro_nome|cliente}},\n\nA parcela {{titulo.numero}} (R$ {{titulo.valor}}), vencida há {{titulo.dias_atraso}} dias, será encaminhada ao jurídico. Para evitar, regularize: {{titulo.link_pagamento}}`,
    roteiroLigacao: null,
  },
];
