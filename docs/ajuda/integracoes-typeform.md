---
titulo: Integração Typeform — receber respostas de formulários
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [typeform, formulário, personal token, webhook, respostas, hidden, variáveis, typeform-signature, sincronizar, mapeamento]
---
# Integração Typeform

Recebe as respostas dos formulários do **Typeform**. Diferente das outras, aqui o CRM **registra o webhook sozinho** no formulário escolhido, com um segredo. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta do Typeform com o formulário criado. O uso de webhooks depende do plano do Typeform; confira no seu plano.
- Um **Personal Token** (Account > Your Settings > Personal tokens > **Generate a new token**) com acesso a **Forms: read** e **Webhooks: read/write**. O token fica guardado cifrado e nunca é mostrado de novo.

## Passo a passo
**No Typeform**
1. Gere o Personal Token com os escopos acima.

**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Typeform**.
2. Em **Ação e nome**, dê um nome, escolha alvo e modo e cole o **Personal Token**. Use **Testar** para conferir.
3. Escolha o **formulário** da lista. O CRM registra o webhook nele e gera o segredo (você **não** precisa mexer em Connect > Webhooks do Typeform). Não há endereço para copiar.
4. No **Mapeamento**, use **Buscar campos da integração**: cada pergunta aparece pelo título, e o CRM usa o `ref` dela. Campos ocultos chegam como `hidden.<nome>` e variáveis como `variables.<nome>`. O modelo pronto reconhece as perguntas de nome, e-mail e telefone, as UTMs por campos ocultos (`hidden.utm_*`) e as variáveis `etapa`, `status` e `dono`.
5. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

**No Typeform (campos ocultos e variáveis, opcional)**
- Para UTMs, crie campos ocultos (Hidden fields) `utm_source`, `utm_medium` etc.
- Para mover o negócio de etapa, crie em **Workflow > Variables** uma variável com o **nome exato da etapa de destino** e valor 1.

## Como testar
Responda o formulário publicado com dados de teste. A resposta aparece em **Integrações → Histórico**. Se as respostas não chegarem, abra **Editar**, confira o token e salve de novo; se não resolver, **Desative** e **Ative** a integração para o CRM registrar o webhook no formulário outra vez.

## O que aparece no histórico
**Processado**, **Ignorado** ou **Erro**, com o corpo (uma chave por pergunta, `hidden.*`, `variables.*`), os avisos e o que foi criado. A assinatura `Typeform-Signature` de cada resposta é conferida pelo CRM; resposta com assinatura errada é recusada.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada resposta. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- **Etapa:** variável com o nome exato da etapa e valor 1, ou uma variável `etapa` (nome ou posição). **Status:** variável `status` (`aberto`, `ganho`, `perdido`). **Dono:** variável `dono` (e-mail ou **Identificador nas integrações**). Mapeie `variables.etapa`, `variables.status` e `variables.dono`.
- Toda resposta precisa de **e-mail ou telefone**: inclua uma pergunta de e-mail ou de telefone.

## Erros comuns
- **"Precisa de atenção":** o token expirou ou foi revogado. O Admin recebe um aviso: gere outro token e atualize a credencial.
- **Formulário não aparece na lista:** o token não tem o escopo **Forms: read** ou pertence a outra conta.
- **Respostas não chegam:** confira se a integração está **Ativa** e, se preciso, **Desative** e **Ative** a integração para registrar o webhook de novo. Se o CRM avisar que não conseguiu registrar o webhook, o motivo vem na mensagem (em geral, token sem o escopo **Webhooks: read/write**). Ao desativar ou excluir a integração, o CRM remove ou desativa o webhook no Typeform.
- **Erro por falta de e-mail e telefone:** a resposta precisa ter um dos dois.
- **Pergunta renomeada:** o mapeamento usa o `ref`, que não muda quando o título muda. Perguntas novas aparecem depois de **Buscar campos da integração**.
