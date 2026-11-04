---
titulo: Integração ManyChat — receber contatos dos fluxos de conversa
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [manychat, consulta externa, external request, full contact data, instagram, whatsapp, chave da api, campos personalizados, fluxo, mapeamento]
---
# Integração ManyChat

Recebe os contatos dos fluxos do **ManyChat** pela ação **Fazer uma consulta externa** (External Request) com **Full Contact Data**. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta do ManyChat com um fluxo (Automatização) e a **chave da API** (Configurações > API > **Gerar chave**). O acesso à API e à consulta externa depende do plano do ManyChat (em geral o **Pro**); confira no seu plano.
- A chave é usada **só** para o CRM buscar os campos personalizados. Ela fica guardada cifrada e nunca é mostrada de novo (só mascarada).
- O ManyChat não assina a consulta externa: a proteção é o **endereço secreto** da integração.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **ManyChat**.
2. Em **Ação e nome**, dê um nome, escolha alvo e modo e cole a **Chave da API do ManyChat**. Use **Testar** para conferir sem gravar.
3. Em **Endereço**, copie o endereço.

**No ManyChat**
1. Copie a chave em **Configurações > API** (se ainda não fez).
2. No fluxo (**Automatização**), escolha o gatilho e, em **Ações**, **Fazer uma consulta externa** (External Request) com o tipo **POST**.
3. Cole o endereço da integração e, na aba **Corpo**, clique em **Adicionar Full Contact Data**. Salve.
4. Contatos do **Instagram** só trazem o nome e o @: antes da consulta externa, use um passo de **Coleta de Dados** (tipo Texto) para pedir e-mail ou telefone e gravar num campo personalizado do ManyChat.

**De volta ao CRM**
1. No **Mapeamento**, use **Buscar campos da integração** para listar os campos personalizados do ManyChat e **Atualizar campos recebidos** depois do primeiro envio. O modelo pronto reconhece `name`, `email`, `phone`/`whatsapp_phone`, `tags` e `custom_fields.*`.
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Percorra o fluxo com um contato de teste (o seu próprio, por exemplo). O recebimento aparece em **Integrações → Histórico**.

## O que aparece no histórico
**Processado**, **Ignorado** (modo Atualizar sem negócio aberto) ou **Erro**. Contato sem e-mail e sem telefone fica com **Erro** e a mensagem para coletar e-mail ou telefone no fluxo.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada envio. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para mudar o negócio, crie campos personalizados no ManyChat (por exemplo `etapa`, `dono`, `status`), busque-os e mapeie para **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`).
- Todo envio precisa de **e-mail ou telefone**.

## Erros comuns
- **"Precisa de atenção" ou erro ao buscar campos:** a chave da API foi recusada (revogada ou errada). Gere outra no ManyChat e atualize a credencial no passo **Ação e nome**.
- **Contato do Instagram com erro:** ele não tem e-mail nem telefone. Colete um dos dois no fluxo antes da consulta externa.
- **Campos personalizados vazios:** o corpo precisa do **Full Contact Data**; refaça o passo 3 do ManyChat.
- **Nada chega:** confira o tipo **POST**, se o fluxo foi publicado e se a integração está **Ativa** (desativada responde 410).
- **Formato [INFERIDO]:** o corpo do Full Contact Data pode variar (campos personalizados como objeto ou como lista). Confira o **primeiro recebimento** no histórico e ajuste o mapeamento.
