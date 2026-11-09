---
titulo: Integrações — aplicativos, histórico e webhooks de saída
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico, /integracoes/saida]
papeis: Só o Admin.
palavras-chave: [facebook lead ads, hotmart, kiwify, eduzz, webhook, integração, aplicativo, catálogo, assistente, mapeamento, histórico, clint, elementor, typeform, rd station, activecampaign, manychat, great pages, lead lovers, captação de leads, formulário, api, assinatura, hmac, entrega, reprocessar, reenviar, url secreta]
---
# Integrações: aplicativos, histórico e webhooks de saída

Abra **Integrações** (menu **Sistema**).

## Aplicativos (receber leads das suas ferramentas)
A tela **Integrações** tem três seções: **Aplicativos**, **Histórico** e **Webhooks de saída**.

1. Em **Aplicativos**, escolha a ferramenta no catálogo (cartões com o logotipo, em ordem alfabética; use a busca). Estão disponíveis ActiveCampaign, Eduzz, Elementor, Facebook Lead Ads, Great Pages, Hotmart, Kiwify, Lead Lovers, ManyChat, RD Station, Typeform e o **Webhook** genérico, para qualquer sistema que chame uma URL. O Facebook Lead Ads e as plataformas de curso (Hotmart, Kiwify e Eduzz) têm passos próprios: conectar a página e o formulário, ou a tabela de eventos.
2. O assistente abre em passos: **Começar** (o que a integração faz e o passo a passo dentro da ferramenta), **Ação e nome**, **Endereço**, **Mapeamento**, **Configurações** e **Salvar**. No celular ele ocupa a tela inteira.
3. **Ação e nome:** dê um nome, escolha o que receber (**Negócio** ou **Contato**) e o que fazer: **Criar** (todo recebimento abre um negócio novo), **Atualizar** (só atualiza o negócio aberto do contato; sem negócio aberto, o recebimento fica como ignorado) ou **Criar ou atualizar** (atualiza o negócio aberto do funil e registra a reconversão; senão cria). Todo recebimento precisa de e-mail ou telefone. Aplicativos com credencial (ActiveCampaign, ManyChat, Typeform) pedem a chave aqui; use **Testar** para conferir sem gravar.
4. Ao sair deste passo a integração é criada **inativa**, para o CRM gerar o endereço. Ela só vira **ativa** no último passo (**Salvar e ativar**). Quem fecha no meio encontra a integração na lista, inativa, e continua por **Editar**.
5. **Endereço:** copie o endereço e cole na ferramenta, como mostrado em **Começar**. No Webhook e no RD Station dá para exigir um segredo de assinatura (gerado pelo CRM ou combinado), que aparece uma única vez. No **Typeform** não há endereço: você escolhe o formulário e o CRM registra o webhook lá.
6. **Mapeamento:** à esquerda ficam os campos que a ferramenta envia; à direita, o campo do CRM onde cada um entra (nome, e-mail, telefone, empresa, valor, UTMs, etiquetas, **etapa**, **dono**, **status**, motivo da perda e campos personalizados do contato ou do negócio). Use **Atualizar campos recebidos** depois de um envio de teste para ver o que chegou, **Buscar campos da integração** (ActiveCampaign, ManyChat e Typeform) para trazer os campos da conta e **Adicionar campo** para digitar um caminho. O aplicativo já traz um modelo pronto; editar uma linha o torna personalizado (**Voltar ao modelo** desfaz). Em **Conferir com um exemplo** o CRM mostra o que faria com um JSON de exemplo, sem gravar nada.
7. **Configurações:** funil e etapa de entrada, **status inicial** do negócio (aberto, ganho ou perdido) e o **motivo de perda padrão**, etiquetas fixas e quem fica com o lead (rodízio, responsável fixo ou líder da área).
8. Para atualizar um negócio pelo recebimento, mapeie **etapa** (nome ou posição da etapa), **dono** (e-mail ou o **Identificador nas integrações** da pessoa, campo que o Admin define no cadastro do usuário em **Configurações → Usuários**) e **status** (aberto, ganho ou perdido). Valor que não existe no funil não derruba o recebimento: o resto é aplicado e o histórico mostra um aviso.

### Suas integrações
Logo abaixo do catálogo, as integrações aparecem **agrupadas por aplicativo**, com funil e etapa, a ação, o último recebimento e a **situação**: **Ativa**, **Inativa** ou **Precisa de atenção** (a ferramenta recusou a credencial; o Admin recebe um aviso). O menu de cada linha tem **Editar**, **Ativar** ou **Desativar** (o endereço passa a responder 410), **Ver histórico**, **Gerar novo endereço** (o antigo para na hora), assinatura e **Excluir** (com confirmação forte). As integrações de um funil também aparecem nas **Configurações do funil**, com **Nova integração** já apontando para ele.

Integrações criadas antes do assistente aparecem com **Endereço antigo**: o CRM guardou só uma impressão do endereço e não consegue mostrá-lo de novo. Elas continuam funcionando; para ter um endereço que dê para copiar, abra **Editar**, vá ao passo **Endereço** e use **Gerar novo endereço** (o atual deixa de funcionar, então troque-o na ferramenta).

### Histórico
Em **Histórico** estão todos os recebimentos dos últimos 90 dias, com filtros de **data**, **status**, **aplicativo** e **integração** (também por **Ver histórico**, no menu da integração). Abra um recebimento para ver o resultado, os avisos, o resultado de cada lead (o RD Station pode mandar vários de uma vez), o contato e o negócio criados ou atualizados, os cabeçalhos e o corpo recebido, com **Copiar** o JSON. Use **Reprocessar** para tentar de novo com a configuração atual (não vale para o que já foi processado nem para o que foi recusado na chegada), **Simular com a configuração atual** e **Editar integração**.

## Um artigo por aplicativo
Cada aplicativo tem um artigo com o que precisa ter antes (plano, credencial), o passo a passo no CRM e na ferramenta, como testar, o que aparece no histórico, erros comuns e os modos criar e atualizar:
- [Webhook](integracoes-webhook.md) (receber e enviar)
- [Apps de login (Meta, Typeform e RD Station)](integracoes-apps-de-login.md): o Admin cadastra o app de cada serviço uma vez em Configurações > Apps de login; depois Facebook Lead Ads, Typeform e RD Station conectam por login em outra janela
- [ActiveCampaign](integracoes-activecampaign.md)
- [Eduzz](integracoes-eduzz.md)
- [Elementor](integracoes-elementor.md)
- [Facebook Lead Ads](integracoes-facebook-lead-ads.md) (exige app da Meta com `leads_retrieval` e o CRM em Leads Access na Central de Leads)
- [Great Pages](integracoes-great-pages.md)
- [Hotmart](integracoes-hotmart.md)
- [Kiwify](integracoes-kiwify.md)
- [Lead Lovers](integracoes-lead-lovers.md)
- [ManyChat](integracoes-manychat.md)
- [RD Station](integracoes-rd-station.md)
- [Typeform](integracoes-typeform.md)

Em aplicativos cujo formato de envio foi inferido da documentação pública (Elementor, Great Pages, Lead Lovers, RD Station, ManyChat e as plataformas de curso), confira o **primeiro recebimento** no histórico e ajuste o mapeamento se algum campo vier com outro nome.

## Webhook de saída (avisar outro sistema quando algo acontece)
1. Crie informando nome, URL e o **formato do envio**. No **Envelope do CRM**, escolha os eventos desejados (cada um tem descrição) e os cabeçalhos extras. No **Formato Clint**, escolha o método (**POST** com JSON ou **GET** com parâmetros na URL), os **gatilhos** (negócio criado, negócio entra na etapa X, negócio muda de etapa, negócio muda de status, cada um com filtro de funil) e os **campos enviados**, cada um com o nome (identificador) que o destino espera, que você pode editar. O formato não muda depois de criado. O segredo aparece uma vez.
2. Use **Enviar teste**. Na aba **Entregas** veja tentativas, status HTTP e **Reenviar**.
2b. O evento **Ligação encerrada** (`ligacao.encerrada`) avisa quando uma ligação do WhatsApp oficial termina, com o contato, o atendente, o resultado, a duração e a espera. Nunca leva o áudio, a transcrição nem as atividades sugeridas. O **resumo** só vai se o Admin ligar **Incluir o resumo da ligação no webhook** nas configurações das ligações do canal; nesse caso o evento espera o resumo ficar pronto (até 20 minutos).
2c. Os eventos do SDR com IA: **Lead qualificado pela IA** (`sdr.lead_qualificado`) e **Lead desqualificado pela IA** (`sdr.lead_desqualificado`). Levam a conversa, o contato, o canal, o modo do SDR, a nota, a temperatura, os critérios (valor e confiança), o motivo e o resumo. O qualificado leva também o negócio e o vendedor escolhido pelo rodízio; no desqualificado o negócio pode ser nulo e o vendedor é sempre nulo.
3. O destino que falha demais é desativado sozinho e aparece em destaque com o motivo. A assinatura de saída usa `X-CRM-Assinatura`; a tela traz exemplos de como validar.
