---
titulo: Integração Facebook Lead Ads — receber leads dos formulários de anúncios
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [apps de login, janela, pop-up, entrar com o facebook, facebook, instagram, lead ads, formulário instantâneo, leads_retrieval, leads access, central de leads, meta, app, oauth, token de página, reconciliação, anúncios, mapeamento]
---
# Integração Facebook Lead Ads

Recebe os leads dos **formulários de anúncios** do Facebook e do Instagram. Você conecta a página, escolhe o formulário e mapeia as perguntas. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md), [Apps de login](integracoes-apps-de-login.md) e [canais Instagram e Messenger](configuracoes-canais-site-email-meta.md).

Diferente das outras integrações, **não há endereço para colar**: a Meta avisa o CRM por um webhook assinado com o segredo do seu app e o CRM então busca o lead com o token da página. O endereço da integração não recebe leads.

## O que você precisa ter antes
- Uma **página do Facebook** com um formulário de leads (Lead Ads) e você como administrador dela.
- O **app da Meta cadastrado no CRM** (o Admin faz isso uma vez em **Configurações > Apps de login**; o passo a passo de criar o app, o webhook de páginas e as permissões está em [Apps de login](integracoes-apps-de-login.md)). Para ler leads de verdade, o app precisa da permissão **`leads_retrieval`** aprovada pela Meta (App Review) e estar no modo Ativo. Em modo de desenvolvimento, só funciona com contas que têm função no app. Você **não digita mais o ID nem o segredo do app** neste assistente.
- O CRM liberado em **Leads Access** na **Central de Leads** da Meta: Business Suite > Todas as ferramentas > Central de Leads > Integrações de CRM > **Leads Access** > **CRMs**. Sem isso a Meta recusa a leitura dos leads, mesmo com tudo certo no CRM.
- Um **endereço público HTTPS** do CRM para o login. Sem domínio público (ambiente local), use o **token de página** no lugar do login (o modo manual continua existindo).
- Permissões pedidas no login: `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_management` e `business_management`.

## Passo a passo
**Uma vez, pelo Admin (se ainda não foi feito)**
1. Crie o app na Meta e cadastre-o em **Configurações > Apps de login**, como em [Apps de login](integracoes-apps-de-login.md). Se o app não estiver cadastrado, o assistente mostra um aviso com o link **Ir para Configurações > Apps de login**.
2. Cadastre no app o **webhook de páginas** (endereço, token de verificação e o campo `leadgen`). Ele aparece no cartão da Meta nessa tela, não mais neste assistente.

**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Facebook Lead Ads**.
2. Em **Conexão**, em **Como entrar**, deixe **Entrar com o Facebook** (o padrão), dê um nome à conexão (opcional) e clique no botão. O CRM abre **outra janela** com o login do Facebook: entre, autorize e a janela se fecha sozinha, voltando ao assistente. O assistente mostra "Aguardando o login na outra janela…" com **Abrir de novo** e **Cancelar**. Se a janela não fechar, clique em **Voltar ao CRM**. Para reconectar uma conexão existente, use **Reconectar**.
3. **Pop-up bloqueado:** se o navegador impedir a janela, o login abre na própria aba e, ao voltar, o assistente reabre no mesmo passo. Se preferir, permita pop-ups para o endereço do CRM.
4. **Modo manual:** em **Como entrar**, escolha **Colar um token de página** e informe o token e o id da página. Serve para ambiente sem domínio público. O app usado é o mesmo das Configurações.
5. Conexões antigas, criadas com app próprio, continuam funcionando e ainda mostram o quadro **Webhook de páginas no app da Meta** com o endereço e o token da própria conexão.
6. Escolha a **página** e o **formulário** de leads. O CRM assina sozinho o campo `leadgen` da página (a assinatura da página é automática; o cadastro do endereço do webhook no painel do app, no passo 4 do CRM, é feito uma vez) e remove a assinatura quando a integração é excluída ou desativada.
7. No **Mapeamento**, use **Buscar campos da integração**: cada pergunta do formulário aparece pela chave dela (`full_name`, `email`, `phone_number` e as personalizadas), junto com os dados do anúncio (`ad_id`, `ad_name`, `campaign_name`, `form_id`, `platform`). O modelo pronto leva nome, e-mail, telefone, empresa e cargo, e usa campanha, anúncio e plataforma como UTMs. Mapeie as perguntas personalizadas para campos personalizados do contato ou do negócio.
8. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

**Na Central de Leads**
1. Libere o seu app/CRM em **Leads Access**, como descrito acima.

Pode haver várias páginas e formulários por funil: crie uma integração para cada formulário.

## Como testar
Na Meta, use a **Ferramenta de testes de Lead Ads** (Lead Ads Testing Tool) para criar um lead de teste no formulário. Em poucos segundos ele deve aparecer em **Integrações → Histórico** com a mensagem "Lead do Facebook recebido pelo webhook". Se o webhook falhar, a **reconciliação** traz o lead em até 15 minutos ("trazido pela reconciliação").

## O que aparece no histórico
Um recebimento por lead, com uma chave por pergunta mais os dados do anúncio. Um lead **nunca é repetido**, mesmo que a Meta avise duas vezes. **Processado**, **Ignorado** ou **Erro**.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada lead. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Etapa, dono e status só mudam se o formulário trouxer perguntas mapeadas para **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`); em geral basta a etapa de entrada da integração.
- Todo lead precisa de **e-mail ou telefone**: deixe esses campos no formulário.

## Erros comuns
- **Os leads não chegam, mesmo com tudo ligado:** o CRM não foi liberado em **Leads Access** na Central de Leads, ou o app não tem `leads_retrieval` aprovado.
- **"Precisa de atenção":** o token foi revogado ou expirou (por exemplo, troca de senha ou saída da função de administrador da página). O Admin recebe um aviso: **Entre com o Facebook** de novo na conexão.
- **"O app da Meta ainda não foi cadastrado":** peça ao Admin para cadastrar o app em **Configurações > Apps de login**.
- **Retorno do login com erro:** o endereço de retorno não está nos **URIs de redirecionamento OAuth válidos** do app; o link de login vale 10 minutos e é de uso único (volte e comece de novo). Se você cancelar o login, a conexão fica sem concluir.
- **A janela de login não abre:** o navegador bloqueou o pop-up. O CRM então abre o login na própria aba; ou permita pop-ups para o endereço do CRM e clique em **Abrir de novo**.
- **"O app de login mudou nas Configurações: conecte de novo":** o Admin trocou o app. Use **Reconectar** na conexão.
- **Página ou formulário não aparecem:** a conta que entrou precisa administrar a página; use a opção de atualizar as páginas da conexão.
- **Lead antigo não entrou:** a primeira conferência começa na ativação e a reconciliação nunca olha mais de 14 dias para trás.
- **Perguntas personalizadas sem nome no mapeamento:** use **Buscar campos da integração** depois de escolher o formulário.
