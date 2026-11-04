---
titulo: Integração ActiveCampaign — receber contatos e negócios das automações
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [activecampaign, active campaign, automação, webhook, url da conta, chave da api, campos personalizados, contact, deal, mapeamento]
---
# Integração ActiveCampaign

Recebe contatos e negócios do **ActiveCampaign** por uma ação **Webhook** dentro de uma automação, e busca pela API os nomes dos campos personalizados. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta do ActiveCampaign com **Automações**. A ação Webhook em automações depende do plano; confira no seu plano.
- A **URL da conta** e a **chave da API** (Configurações > **Desenvolvedor**). A URL precisa ser **HTTPS e pública**; a chave fica guardada cifrada e nunca é mostrada de novo.
- O ActiveCampaign não assina o envio: a proteção é o **endereço secreto** da integração. A chave da API só serve para buscar os campos.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **ActiveCampaign**.
2. Em **Ação e nome**, dê um nome, escolha alvo e modo e informe a **URL da conta** e a **Chave da API**. Use **Testar** para conferir.
3. Em **Endereço**, copie o endereço.

**No ActiveCampaign**
1. Em **Configurações > Desenvolvedor**, copie a URL da conta e a chave da API (se ainda não fez).
2. Em **Automações**, edite a automação, adicione **Condições e fluxo de trabalho > Webhook** e cole o endereço da integração. Cada automação pode usar uma integração diferente.

**De volta ao CRM**
1. No **Mapeamento**, use **Buscar campos da integração** para dar nome aos campos personalizados (`contact.fields.<id>`). O modelo pronto reconhece `contact.full_name`, `contact.email`, `contact.phone`, `contact.orgname`, `contact.tags`, `deal.value` e `deal.title`.
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Coloque um contato de teste na automação. O recebimento aparece em **Integrações → Histórico**; use **Atualizar campos recebidos** para ver o que chegou.

## O que aparece no histórico
**Processado**, **Ignorado** (modo Atualizar sem negócio aberto) ou **Erro**, com o corpo (`contact[...]` e `deal[...]` normalizados), avisos e o que foi criado ou atualizado.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada envio. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para atualizar pelo ActiveCampaign, crie ações **Atualizar contato** com os campos **Dono do negócio** (e-mail do vendedor ou **Identificador nas integrações**), `etapa_funil` (nome ou posição da etapa) e `status` (`aberto`, `ganho` ou `perdido`). O modelo pronto já mapeia esses três nomes para **dono**, **etapa** e **status**.
- Todo envio precisa de **e-mail ou telefone**.

## Erros comuns
- **"Precisa de atenção" ou erro ao buscar campos:** a URL da conta ou a chave foi recusada. Confira os dois em Configurações > Desenvolvedor e atualize a credencial.
- **URL da conta recusada:** precisa ser HTTPS e pública; endereços internos são bloqueados.
- **Campos `contact.fields.<id>` sem nome:** use **Buscar campos da integração**.
- **Nada chega:** confira se a automação está ativa, se o contato passou pelo passo do webhook e se a integração está **Ativa** (desativada responde 410).
- **Valor de etapa, dono ou status que não existe:** o recebimento é processado com um **aviso** no histórico; corrija o nome na automação.
