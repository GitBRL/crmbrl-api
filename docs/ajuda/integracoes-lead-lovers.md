---
titulo: Integração Lead Lovers — receber contatos por gatilho inteligente
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [lead lovers, gatilho inteligente, httppost simples, webhook, automação, tag, captação de leads, mapeamento]
---
# Integração Lead Lovers

Recebe contatos do **Lead Lovers** por uma ação **HttpPost Simples** de um gatilho inteligente. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta no Lead Lovers com acesso a **Ferramentas > Gestão de contatos > Ações automatizadas**.
- Nenhuma credencial: o Lead Lovers não assina o envio. A proteção é o **endereço secreto** da integração; não o publique.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Lead Lovers**.
2. Em **Ação e nome**, dê um nome e escolha alvo e modo.
3. Em **Endereço**, copie o endereço.

**No Lead Lovers**
1. Em **Ferramentas > Gestão de contatos > Ações automatizadas**, crie um **Novo gatilho inteligente**.
2. Defina os filtros (por exemplo, por tag) e, em **Ações**, escolha **HttpPost Simples**.
3. Cole o endereço da integração e use o tipo **POST**. Salve.

**De volta ao CRM**
1. Os nomes dos campos são os do formulário do Lead Lovers: digite cada um em **Adicionar campo** no **Mapeamento**, ou dispare um teste e use **Atualizar campos recebidos**. O modelo pronto reconhece `nome`, `email`, `telefone` e `tags`.
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Aplique o gatilho a um contato de teste (por exemplo, adicionando a tag do filtro). O recebimento aparece em **Integrações → Histórico**.

## O que aparece no histórico
**Processado**, **Ignorado** (modo Atualizar sem negócio aberto) ou **Erro**, com cabeçalhos, corpo, avisos e o que foi criado ou atualizado.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada envio. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para mudar o negócio, mapeie os destinos **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`), enviando esses valores como campos do HttpPost.
- Todo envio precisa de **e-mail ou telefone**.

## Erros comuns
- **Nada chega:** o gatilho só dispara para contatos que passam nos filtros; confira o filtro e a ação **HttpPost Simples** com tipo **POST**. Confira também se a integração está **Ativa** (desativada responde 410).
- **Mapeamento sem campos:** o Lead Lovers não lista campos para o CRM. Dispare um teste e use **Atualizar campos recebidos**.
- **Erro por falta de e-mail e telefone:** mapeie um dos dois.
- **Formato [INFERIDO]:** o formato do Lead Lovers foi inferido, sem captura real. Confira o **primeiro recebimento** no histórico e ajuste o mapeamento se os nomes dos campos forem outros.
