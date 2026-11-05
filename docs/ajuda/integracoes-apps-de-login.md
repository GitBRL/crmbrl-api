---
titulo: Apps de login (Meta, Typeform e RD Station) — cadastrar uma vez e entrar com um clique
area: administracao
telas: [/configuracoes, /integracoes, /integracoes/aplicativos]
papeis: Só o Admin.
palavras-chave: [apps de login, login facilitado, app da meta, id do app, segredo do app, client id, client secret, uri de redirecionamento, redirect uri, webhook de páginas, token de verificação, leads_retrieval, app review, leads access, modo de desenvolvimento, typeform, rd station, app publisher, developer apps, trocar segredo, trocar app, entrar com o facebook, janela]
---
# Apps de login (Meta, Typeform e RD Station)

O **Facebook Lead Ads**, o **Typeform** e o **RD Station** deixam você conectar a conta com um **login em outra janela**, sem copiar tokens. Para isso, cada serviço precisa de um **app** (um cadastro de aplicativo no site do serviço) que identifica o CRM. O Admin cadastra cada app **uma única vez** em **Configurações > Apps de login**. Depois disso, ninguém digita ID nem segredo de app nos assistentes de integração nem nos canais Messenger e Instagram: eles usam o app cadastrado.

Só o Admin vê e altera esta seção. Veja também [Facebook Lead Ads](integracoes-facebook-lead-ads.md), [Typeform](integracoes-typeform.md), [RD Station](integracoes-rd-station.md) e [canais Instagram e Messenger](configuracoes-canais-site-email-meta.md).

## Para que serve
- **Uma vez só.** O ID do app (também chamado de *client ID*) fica visível; o **segredo** fica guardado cifrado e nunca é mostrado de novo (aparece só mascarado, com os últimos caracteres).
- **Cada serviço tem o seu cartão**, com a situação, o formulário (ID e segredo), o **endereço de retorno** com botão de copiar, um resumo de "como criar o app" e quanto está em uso (conexões, canais e integrações).
- **Aplicativos que continuam com chave ou endereço colado:** ActiveCampaign, ManyChat, Hotmart, Kiwify, Eduzz, Elementor, Great Pages e Lead Lovers não oferecem login e não precisam de app.

## O que você precisa antes
- Um **endereço público com https** do CRM (o mesmo que a equipe de tecnologia configurou como endereço público do sistema). Os serviços só devolvem o login para um endereço que você cadastra no app deles. Em ambiente local sem domínio público, use o modo manual de cada integração (token de página, token pessoal ou endereço colado).
- Uma conta com permissão para criar apps em cada serviço.
- Os **endereços de retorno** da tela (cartão de cada serviço). Sempre copie o endereço pelo botão da tela; ele já vem com o domínio do seu CRM. Os modelos abaixo usam `https://crm.suaempresa.com.br` só como exemplo:
  - Meta: `https://crm.suaempresa.com.br/api/v1/publico/facebook/oauth/retorno`
  - Typeform e RD Station: `https://crm.suaempresa.com.br/api/v1/publico/conexoes/oauth/retorno`

Os nomes de menus dos sites abaixo mudam com o tempo. Onde estiver escrito "confira na tela do serviço", o texto vem da documentação pública e não foi verificado com uma conta real: compare com o que o serviço mostra.

## Como criar o app da Meta
O mesmo app serve para o Facebook Lead Ads e para os canais Messenger e Instagram.

1. Entre em **developers.facebook.com**, abra **Meus apps** e crie um app (tipo **Negócios**, ou o tipo que a Meta oferecer para integrar páginas e leads; confira na tela do serviço).
2. **Produtos.** Adicione **Login do Facebook** e **Webhooks**.
3. **URIs de redirecionamento.** Em **Login do Facebook > Configurações**, cole o endereço de retorno da Meta (cartão da Meta no CRM) em **URIs de redirecionamento OAuth válidos** e salve. O endereço precisa ser idêntico, letra por letra. Se você usar mais de um domínio (por exemplo, teste e produção), cadastre um para cada.
4. **Copie o ID e o segredo.** Em **Configurações do app > Básico**, copie o **ID do app** e o **Chave secreta do app** (clique em Mostrar; a Meta pode pedir sua senha). Cole os dois no cartão da Meta em **Configurações > Apps de login** e salve. O CRM confere o par com a Meta: se ela recusar, a tela avisa "A Meta não reconheceu este par" e nada é gravado.
5. **Webhook de páginas.** Depois de salvar, o cartão da Meta mostra o **endereço do webhook** e o **token de verificação**, com botão de copiar. No app da Meta, abra **Webhooks**, escolha o objeto **Page**, clique em **Assinar este objeto** (ou **Editar assinatura**), cole o endereço em **URL de callback** e o token em **Token de verificação**, confirme e **assine o campo `leadgen`**. Sem isso a Meta não avisa o CRM dos leads novos; eles só chegam pela conferência periódica, a cada 15 minutos.
6. **Permissões.** O login do CRM pede estas permissões: `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_management` e `business_management`. Para as contas que têm função no app (administrador, desenvolvedor ou testador), elas funcionam em modo de desenvolvimento. Para qualquer outra conta, o app precisa de **Acesso avançado** a cada uma, pelo **App Review** (Análise do app) da Meta. Confira na tela do serviço a lista de permissões que o painel pede e os documentos exigidos (política de privacidade, vídeo do uso e outros).
7. **Modo do app.** Um app em **modo de desenvolvimento** só funciona com contas que têm função nele e só entrega leads de teste. Para receber leads reais de clientes, o app precisa estar no modo **Ativo** (Live) e ter `leads_retrieval` aprovada. Para passar para Ativo a Meta costuma exigir política de privacidade e verificação do negócio; confira o que ela pede na tela.
8. **Leads Access.** Na **Central de Leads** (Business Suite > Todas as ferramentas > Central de Leads > Integrações de CRM > **Leads Access** > **CRMs**), libere o app. Sem isso a Meta recusa a leitura dos leads, mesmo com tudo certo no CRM.

**O que copiar para o CRM:** só o **ID do app** e o **segredo do app**. O endereço do webhook e o token de verificação fazem o caminho contrário: saem do CRM e vão para a Meta.

## Como criar o app do Typeform
1. Entre no **typeform.com**, abra o menu ao lado do nome da sua organização e vá em **Organization > Developer Apps** (confira o nome do menu na tela do serviço).
2. Escolha registrar um novo app: informe o **nome**, o **site do app** e, em **Redirect URI(s)**, cole o endereço de retorno do Typeform (cartão do Typeform no CRM). Clique em **Register app**.
3. O Typeform mostra o **client ID** e o **client secret**. **O segredo aparece uma vez só**: copie na hora. Se perder, use **Regenerate client secret** em **Edit app** e atualize o CRM (veja "Trocar o segredo").
4. No CRM, em **Configurações > Apps de login**, cartão do Typeform, cole o client ID e o segredo e salve.

**Permissões.** O CRM pede `accounts:read`, `forms:read`, `webhooks:read`, `webhooks:write` e `offline` (este último permite renovar o acesso sem pedir login de novo). Não é preciso configurá-las no site do Typeform; elas vão no pedido de login.

**Conta de outra região.** Contas do data center da União Europeia podem exigir um app registrado na região e usar outro endereço de login. A documentação do Typeform não é clara nesse ponto; confira na tela do serviço. Se o login não funcionar para a sua conta, fale com o suporte.

## Como criar o app do RD Station
1. Com uma conta do RD Station Marketing, abra a **App Store** e entre em **App Publisher** (appstore.rdstation.com, área de publicador).
2. Escolha **Quero criar um aplicativo**, dê um nome, marque **Aplicativo privado** (o app é só seu e não precisa de aprovação) e clique em **Criar app**.
3. Informe a **URL de callback**: o endereço de retorno do RD Station (cartão do RD no CRM). A comparação é exata, letra por letra. **Mudanças na URL de callback podem levar até 1 hora** para valer.
4. Copie o **client ID** e o **client secret** e cole no cartão do RD Station em **Configurações > Apps de login**.

As credenciais de um app valem para **um único produto** do RD Station (o Marketing). Confira na tela do serviço se o seu plano permite webhooks e acesso à API.

## Entrar com o login (depois do app cadastrado)
- Na integração, clique em **Entrar com o Facebook**, **Entrar com o Typeform** ou **Entrar com o RD Station**. O CRM abre uma **janela separada** com a página do serviço. Entre, autorize e a janela se fecha sozinha, voltando para o assistente. Se ela não fechar, aparece "Pronto! Pode fechar esta janela" e o botão **Voltar ao CRM**.
- Enquanto você autoriza, o assistente mostra "Aguardando o login na outra janela…", com **Abrir de novo** e **Cancelar**.
- Se o navegador **bloquear a janela** (pop-up), o CRM abre o login na própria aba e, ao voltar, o assistente reabre no mesmo passo. Você também pode permitir pop-ups para o endereço do CRM.
- O link de login vale **10 minutos** e só pode ser usado uma vez.

## Trocar o segredo
Use quando o segredo vazou, foi regenerado no serviço ou você só quer renová-lo.
1. Gere o novo segredo no serviço (Meta: Configurações do app > Básico, **Redefinir** a chave secreta; Typeform: **Regenerate client secret**; RD Station: gere novo segredo no App Publisher, conforme a tela do serviço).
2. Em **Configurações > Apps de login**, no cartão, deixe o ID como está, informe só o **novo segredo** e salve.
3. O CRM atualiza as conexões, os canais e as integrações que usam o app. **Não é preciso reconectar ninguém**, porque o ID continua o mesmo.

Se o campo do segredo ficar vazio ao salvar, o segredo atual é mantido.

## Trocar de app (outro ID)
Só faça se realmente precisar de outro app (por exemplo, o antigo foi bloqueado).
1. Crie o novo app no serviço, com os mesmos endereços de retorno.
2. No cartão, informe o **novo ID e o novo segredo** e salve. Se o app estiver em uso, o CRM mostra quantas conexões, canais e integrações dependem dele e pede **confirmação**.
3. Depois de confirmar, tudo o que usava o app antigo fica como **Precisa de atenção**, com o aviso "O app de login mudou nas Configurações: conecte de novo". Reconecte cada conexão, canal e integração com **Entrar com…** ou **Reconectar**.

Para **remover** um app, não pode haver conexão, canal ou integração ativa usando-o; senão o CRM recusa e mostra o que está em uso. Remova ou troque esses itens primeiro.

## O modo manual continua existindo
O login não é obrigatório. Você ainda pode usar o **token de página** (Facebook), o **token pessoal** (Typeform) e o **endereço colado no RD Station**. Os assistentes mostram as duas opções, e o login é a opção padrão quando o app está cadastrado.

## Erros comuns
- **"O app da Meta ainda não foi cadastrado" (ou do Typeform ou do RD):** cadastre o app em **Configurações > Apps de login**. Só o Admin consegue; os outros papéis falam com ele.
- **"A Meta não reconheceu este par":** o ID e o segredo não combinam. Copie de novo em **Configurações do app > Básico** e confira se não há espaço sobrando.
- **O serviço mostra erro de endereço de retorno ou de redirecionamento:** o endereço não está cadastrado no app, ou difere do mostrado no CRM (https, domínio, barra no fim). Copie pelo botão da tela. No RD Station, a mudança pode demorar até 1 hora.
- **A janela fecha sem concluir, ou a tela mostra "Login cancelado":** você cancelou ou recusou as permissões. Clique em **Entrar com…** de novo e aceite tudo o que é pedido.
- **"O link de login expirou" ou erro de state:** o link vale 10 minutos e é de uso único. Comece de novo pelo assistente.
- **Páginas ou leads não aparecem na Meta:** o app está em modo de desenvolvimento, falta `leads_retrieval` aprovada, a conta que entrou não administra a página ou o app não foi liberado em Leads Access.
- **Conexão "Precisa de atenção":** o acesso foi revogado, o serviço recusou renovar o acesso, ou o app mudou. Use **Reconectar** na conexão. No Typeform e no RD, o CRM renova o acesso sozinho enquanto o serviço permitir.
- **Ao trocar o domínio do CRM:** cadastre os novos endereços de retorno em cada app e reconecte.
- **Não consigo remover ou trocar o app:** há itens usando-o; a tela lista quantos. Resolva-os primeiro.
