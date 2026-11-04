---
titulo: Integração RD Station — receber conversões e oportunidades
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [rd station, rd station marketing, conversão, oportunidade, webhook, lead, chave de autenticação, custom_fields, utm, mapeamento]
---
# Integração RD Station

Recebe as **conversões** e as **oportunidades** do **RD Station Marketing** por um webhook configurado no próprio RD. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta do RD Station Marketing com acesso a **Integrações > Webhook**. A disponibilidade de webhooks depende do plano do RD; confira no seu plano.
- Opcional: uma **chave de autenticação**. O RD permite configurar um cabeçalho com a chave; se você informar a mesma chave no CRM, a integração recusa chamadas sem ela.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **RD Station**.
2. Em **Ação e nome**, dê um nome e escolha alvo e modo.
3. Em **Endereço**, copie o endereço. Se quiser, defina a **chave de autenticação** (gerada pelo CRM ou combinada); ela aparece uma única vez.

**No RD Station Marketing**
1. No menu superior direito, abra **Integrações > Webhook > Configurar** e clique em **Criar webhook**.
2. Dê um nome, cole o endereço da integração e escolha o gatilho: **Conversão** (escolha as conversões ou deixe vazio para todas) ou **Oportunidade**.
3. Se quiser autenticar, configure no RD um cabeçalho com a chave e informe a mesma chave no CRM.
4. Converta um lead de teste.

**De volta ao CRM**
1. No **Mapeamento**, use **Atualizar campos recebidos**. O modelo pronto reconhece `name`, `email`, `mobile_phone`/`personal_phone`, `company`, `job_title`, `tags`, as UTMs da última conversão e os campos personalizados (`custom_fields.<nome>` ou `cf_<nome>`).
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Faça uma conversão de teste (preencha um formulário do RD com seus dados). O recebimento aparece em **Integrações → Histórico**.

## O que aparece no histórico
O RD pode mandar **vários leads de uma vez** (`leads`): cada um é processado e o resultado de cada lead aparece no detalhe do recebimento. Status: **Processado**, **Ignorado** ou **Erro**. Cada recebimento processa até **100 leads**; os que passarem disso ficam como **Ignorado** ("excedentes") no detalhe, e você reenvia esses em outro recebimento.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada lead. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para mudar o negócio pelo RD, use campos personalizados com esses dados e mapeie para **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`).
- Todo lead precisa de **e-mail ou telefone**.

## Erros comuns
- **401 na chamada:** o RD não está enviando o cabeçalho com a chave, ou a chave difere da do CRM. Reconfira os dois lados.
- **Nada chega:** confira o gatilho escolhido no RD (conversão ou oportunidade) e se a integração está **Ativa** (desativada responde 410).
- **Campos personalizados fora do mapeamento:** use **Atualizar campos recebidos** depois de uma conversão que tenha esses campos preenchidos.
- **Formato [INFERIDO]:** o RD tem mais de um formato (lista de leads, lead único e a API 2.0). Confira o **primeiro recebimento** no histórico e ajuste o mapeamento se algum campo vier em outro caminho.
