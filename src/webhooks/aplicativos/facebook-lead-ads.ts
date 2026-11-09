/**
 * Facebook Lead Ads (R32.14). Diferente dos outros aplicativos, o CRM busca o
 * lead na Graph API quando a Meta avisa pelo webhook (`object: page`, campo
 * `leadgen`) e entrega ao processamento comum o lead já normalizado
 * (`facebook/lead-facebook.ts`): uma chave por pergunta do formulário mais
 * `leadgen_id`, `ad_id`, `form_id`, `campaign_name` etc.
 *
 * O endereço público da integração (token) existe como nas outras, mas não é
 * usado: quem fala com o CRM é a Meta, pelo roteador `/publico/meta/webhook`.
 * A conexão (app, login e páginas) fica em `ConexaoFacebook`; a integração só
 * guarda a escolha da página e do formulário em `configuracao`.
 */
import {
  ehObjeto,
  itemUnico,
  mapeamentoDe,
  regras,
  DICA_ATUALIZACAO,
} from './comum';
import type { AdaptadorDeAplicativo } from './tipos';

export const adaptadorFacebookLeadAds: AdaptadorDeAplicativo = {
  definicao: {
    aplicativo: 'FACEBOOK_LEAD_ADS',
    nome: 'Facebook Lead Ads',
    descricao:
      'Receba os leads dos formulários de anúncios do Facebook e do Instagram: conecte a página, escolha o formulário e mapeie as perguntas.',
    disponivel: true,
    entrega: 'API',
    tiposDeConteudo: [],
    autenticidade: {
      tipo: 'NENHUMA',
      descricao:
        'A Meta avisa o CRM por um webhook assinado com o segredo do app (X-Hub-Signature-256); o CRM então busca o lead com o token da página. O endereço da integração não recebe leads.',
      segredo: 'NAO_USA',
      rotuloDoSegredo: null,
      cabecalho: 'X-Hub-Signature-256',
    },
    credencial: null,
    login: 'META',
    buscaCampos: true,
    escolheFormulario: true,
    passoAPasso: {
      titulo: 'No Facebook e na Central de Leads',
      passos: [
        'Tenha um app da Meta (developers.facebook.com) com os produtos Login do Facebook e Webhooks. Para ler leads de verdade, o app precisa da permissão leads_retrieval aprovada pela Meta (App Review); em modo de desenvolvimento, só funciona com contas que têm função no app.',
        'Informe o ID e o segredo do app (ou reaproveite os de um canal Messenger ou Instagram já cadastrado) e clique em "Entrar com o Facebook". Se não houver um domínio público (ambiente local), cole um token de página no lugar do login.',
        'O endereço de retorno do login ("URI de redirecionamento OAuth válido" do app) é mostrado na tela: copie-o para as configurações do Login do Facebook.',
        'Escolha a página e o formulário de leads. O CRM assina sozinho o campo leadgen da página (você não precisa mexer em Webhooks no painel do app) e remove a assinatura quando a integração é excluída ou desativada.',
        'Na Central de Leads da Meta (Business Suite > Todas as ferramentas > Central de Leads > Integrações de CRM > "Leads Access" > CRMs), libere o acesso do seu app/CRM, senão a Meta recusa a leitura dos leads.',
        'Cada pergunta do formulário chega pela chave dela (full_name, email, phone_number e as personalizadas), junto com ad_id, form_id, campaign_name e outros dados do anúncio quando houver. Um lead nunca é repetido, mesmo que a Meta avise duas vezes.',
        'A cada 15 minutos o CRM confere os leads dos formulários ativos e recupera os que o webhook não trouxe. Se o token for revogado ou expirar, a integração passa para "precisa de atenção" e o Admin é avisado: entre com o Facebook de novo.',
      ],
    },
    modelo: {
      nome: 'Facebook Lead Ads',
      descricao:
        'Nome, e-mail e telefone dos campos padrão do formulário (full_name, email, phone_number), empresa e cargo, e a campanha, o anúncio e a plataforma como UTMs (campaign, content, source).',
      mapeamento: mapeamentoDe([
        ...regras('nome', 'full_name'),
        ...regras('email', 'email'),
        ...regras('telefone', 'phone_number'),
        ...regras('empresa', 'company_name'),
        ...regras('cargo', 'job_title'),
        ...regras('utm.campaign', 'campaign_name'),
        ...regras('utm.content', 'ad_name'),
        ...regras('utm.source', 'platform'),
      ]),
      exemplo: {
        leadgen_id: '555000000000001',
        page_id: '300000000000001',
        form_id: '400000000000001',
        ad_id: '700000000000001',
        ad_name: 'Anúncio matrícula 2027',
        campaign_name: 'Matrículas 2027',
        platform: 'fb',
        full_name: 'Maria Souza',
        email: 'maria@empresa.com.br',
        phone_number: '+5511987654321',
        serie_de_interesse: '6º ano',
      },
    },
    dicas: [
      'Mapeie as perguntas personalizadas do formulário para campos personalizados do contato ou do negócio.',
      DICA_ATUALIZACAO,
    ],
  },
  normalizarCorpo: (corpo) => itemUnico(ehObjeto(corpo) ? corpo : {}),
  verificarAutenticidade: () => ({
    ok: false,
    mensagem:
      'O Facebook Lead Ads não envia ao endereço da integração: a Meta avisa o CRM pelo webhook da página e o CRM busca o lead pela Graph API.',
  }),
};
