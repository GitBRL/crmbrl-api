---
titulo: Integração Great Pages — receber leads das páginas de captura
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [great pages, página de captura, formulário, webhook, variável de integração, captação de leads, mapeamento]
---
# Integração Great Pages

Recebe os leads dos formulários das páginas do **Great Pages** pela integração **Webhook** do formulário. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta no Great Pages com a página e o formulário criados e acesso para editar a página.
- Nenhuma credencial: o Great Pages não assina o envio. A proteção é o **endereço secreto** da integração; não o publique.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Great Pages**.
2. Em **Ação e nome**, dê um nome e escolha alvo e modo.
3. Em **Endereço**, copie o endereço.

**No Great Pages**
1. Abra a página em **Editar design**, selecione o formulário e clique em **Configurar** > **Configurar Integração**.
2. Escolha **Webhook**, cole o endereço da integração e use o método **Post**.
3. Na coluna **Variável de integração**, o Great Pages mostra o nome de cada campo: são esses nomes que o mapeamento usa.
4. Salve e publique a página.

**De volta ao CRM**
1. No **Mapeamento**, envie um teste e use **Atualizar campos recebidos**, ou digite as variáveis em **Adicionar campo**. O modelo pronto já reconhece `nome`, `email`, `telefone`, `empresa` e UTMs.
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Preencha o formulário da página publicada com dados de teste. O recebimento deve aparecer em **Integrações → Histórico**.

## O que aparece no histórico
**Processado** (contato e negócio criados ou atualizados), **Ignorado** (modo Atualizar sem negócio aberto) ou **Erro**, com cabeçalhos, corpo e avisos.

## Criar ou atualizar: etapa, dono e status
- **Criar:** negócio novo a cada envio. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (reconversão) ou cria. **Atualizar:** só atualiza, senão **Ignorado**. Alvo **Contato:** só o contato.
- Para mudar etapa, dono e status pelo formulário, inclua variáveis com esses dados e mapeie para **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`).
- Todo envio precisa de **e-mail ou telefone**.

## Erros comuns
- **Nada chega:** confira se o método é **Post**, se a página foi publicada depois de salvar e se a integração está **Ativa** (desativada responde 410).
- **Campo não aparece no mapeamento:** o nome é o da **Variável de integração**, não o rótulo. Use **Adicionar campo**.
- **Erro por falta de e-mail e telefone:** mapeie um dos dois.
- **Formato [INFERIDO]:** o formato do Great Pages não tem documentação pública completa. Confira o **primeiro recebimento** no histórico e ajuste o mapeamento se os nomes forem outros.
