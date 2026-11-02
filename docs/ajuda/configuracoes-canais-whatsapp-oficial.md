---
titulo: Conectar o WhatsApp oficial (API da Meta) e usar templates
area: configuracoes
telas: [/configuracoes/canais, /configuracoes/canais/whatsapp-oficial/:id, /atendimento/:conversaId]
papeis: Só o Admin cadastra, testa, sincroniza e exclui o canal. Quem vê a conversa envia as respostas e os templates.
palavras-chave: [whatsapp oficial, api da meta, cloud api, templates, template, janela de 24 horas, webhook, token, app secret, waba, phone number id, verify token, testar conexão, sincronizar templates, fora da janela, whatsapp business]
---
# Conectar o WhatsApp oficial (API da Meta) e usar templates

O **WhatsApp oficial** é um canal à parte, ao lado do WhatsApp por QR code. Ele usa a API oficial da Meta: não há QR, o número fica na conta do WhatsApp Business e, depois de 24 horas sem resposta do cliente, só dá para enviar **templates** aprovados pela Meta. O mesmo cliente pode falar pelos dois canais e continua sendo um contato só.

## Conectar o número (Admin)
1. Abra **Configurações > Canais**, clique em **Novo canal** e escolha **WhatsApp oficial (API da Meta)**.
2. Preencha os campos. A tela traz o passo a passo, e cada campo tem uma dica de onde achar no Meta Business:
   - **ID do número de telefone** e **ID da conta (WABA)**: no painel do app da Meta, em WhatsApp > Configuração da API (só números).
   - **Token de acesso**: token de um usuário do sistema do Gerenciador de Negócios, com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
   - **Chave secreta do app**: em Configurações do app > Básico. O CRM usa para conferir a assinatura de cada aviso da Meta.
   - **Número exibido** (opcional): só para identificar o número na lista.
3. Escolha a **fila das conversas novas** e clique em **Criar canal**.
4. No canal salvo, clique em **Testar conexão**. Se funcionar, o estado vira **Conectado** e aparecem o nome verificado e a qualidade do número. Se falhar, o estado vira **Com erro** e o motivo fica à vista (por exemplo, token inválido).
5. Em **Webhook**, clique em **Copiar** no endereço e no token de verificação e cole na Meta (WhatsApp > Configuração > Webhook). Assine o campo `messages`. O endereço é o mesmo do Instagram e do Messenger.
6. Clique em **Sincronizar templates** para trazer os modelos da conta.

Os segredos (token e chave secreta) ficam cifrados e nunca são mostrados de novo: a tela mostra só o final, como `••••••••Zx0P`. Para trocar, cole o novo valor; em branco, o gravado é mantido. **Gerar outro token de verificação** (menu ⋯) invalida o antigo, e você precisa colar o novo na Meta.

## Templates
- A lista mostra todos os templates da conta com a situação na Meta (aprovado, em análise, rejeitado, pausado). Só os **aprovados** podem ser enviados.
- A sincronização roda sozinha todo dia às 3h; use **Sincronizar templates** depois de criar ou aprovar um novo. Se a Meta falhar ou o token não valer, a tela mostra o motivo.
- Templates com cabeçalho de localização não são suportados.

## Responder no Atendimento: a janela de 24 horas
- **Dentro da janela** (até 24 horas depois da última mensagem do cliente): o campo de mensagem funciona como nos outros canais, com texto, anexos e áudio gravado. O botão **Enviar template** também está disponível.
- **Fora da janela**: aparece um aviso e o campo de mensagem dá lugar à lista de templates. A nota interna continua liberada.

Para enviar um template:
1. Busque pelo nome ou pelo texto e clique no template.
2. Preencha as variáveis (cabeçalho, corpo e, se houver, o final do link do botão). A prévia mostra o que o cliente vai ver.
3. Se o cabeçalho for imagem, vídeo ou documento, escolha o arquivo.
4. Clique em **Enviar template**. A mensagem aparece na conversa com a etiqueta **template**.

## Status e falhas
Cada mensagem enviada mostra **enviada**, **entregue** ou **lida**. Se falhar, a bolha mostra o motivo em português (janela fechada, número sem WhatsApp, template pausado, o contato pediu para não ser contatado, token inválido…) e o botão **Tentar de novo**. Quem tem a etiqueta "não contatar por WhatsApp" não recebe mensagem pelos dois canais, e templates de marketing respeitam o opt-out de marketing.

Mensagens enviadas direto pelo celular do número (coexistência) ainda não aparecem no CRM.
