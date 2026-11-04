---
titulo: Integração Elementor — receber leads dos formulários do site
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [elementor, formulário, wordpress, webhook, advanced data, utm, campos ocultos, site, captação de leads, mapeamento]
---
# Integração Elementor

Recebe os envios dos formulários do **Elementor Pro** (WordPress) pela ação **Webhook** do formulário, com **Advanced Data**. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- **Elementor Pro** (a ação Webhook e o widget de formulário fazem parte do plano Pro).
- Acesso para editar a página no WordPress.
- Nenhuma credencial: o Elementor não assina o envio. A única proteção é o **endereço secreto** da integração: não o publique.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Elementor**.
2. Em **Ação e nome**, dê um nome e escolha o alvo e o modo (veja abaixo).
3. Em **Endereço**, copie o endereço.

**No Elementor**
1. Abra a página, edite o formulário e, em **Actions After Submit**, adicione a ação **Webhook**.
2. Cole o endereço da integração em **Webhook URL** e ative **Advanced Data**.
3. Em **Form Fields**, aba **Advanced**, copie o **ID** de cada campo: o ID é o nome do campo no mapeamento.
4. Para as UTMs, crie campos ocultos (**Hidden**) com os IDs `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` e `utm_content` e, em **Default Value**, use **Request parameter** (Get) com o mesmo nome. Publique a página.
5. Envie o formulário uma vez.

**De volta ao CRM**
1. No **Mapeamento**, use **Atualizar campos recebidos** para ver os IDs que chegaram. O modelo **Elementor** já reconhece `name`, `email`, `phone`/`tel` e as UTMs; ajuste os IDs ao seu formulário.
2. Em **Configurações**, escolha funil, etapa, etiquetas e distribuição. Termine em **Salvar e ativar**.

## Como testar
Preencha e envie o formulário publicado (use um e-mail de teste). O lead deve aparecer em **Histórico** em poucos segundos. Em **Conferir com um exemplo** dá para simular sem gravar.

## O que aparece no histórico
Um recebimento por envio: **Processado** com o contato e o negócio criados, **Ignorado** (modo Atualizar sem negócio aberto) ou **Erro**. O corpo mostra os campos já "achatados": `<id do campo>`, mais `form_id`, `form_name` e dados da página (`meta_page_url` etc.).

## Criar ou atualizar: etapa, dono e status
- **Criar:** cada envio abre um negócio novo. **Criar ou atualizar:** atualiza o negócio aberto do contato no funil (e registra a reconversão) ou cria. **Atualizar:** só atualiza; sem negócio aberto fica **Ignorado**. Alvo **Contato** não cria negócio.
- Para atualizar pelo formulário, crie campos ocultos no Elementor (por exemplo `etapa`, `dono`, `status`) e mapeie para os destinos **etapa** (nome ou posição), **dono** (e-mail ou **Identificador nas integrações**) e **status** (`aberto`, `ganho`, `perdido`).
- Todo envio precisa de **e-mail ou telefone**.

## Erros comuns
- **Nada chega:** confira se o **Advanced Data** está ligado, se o formulário foi publicado e se a integração está **Ativa** (desativada responde 410).
- **Campos vazios no mapeamento:** o nome do campo é o **ID** do Elementor, não o rótulo. Copie o ID na aba **Advanced**.
- **UTMs vazias:** o campo oculto precisa ter o mesmo nome do parâmetro da URL e a página precisa ser aberta com ele (`?utm_source=...`).
- **Erro por falta de e-mail e telefone:** inclua um dos dois no formulário e mapeie.
- **Formato [INFERIDO]:** o formato exato do Elementor foi montado a partir da documentação pública, sem captura real. Confira o **primeiro recebimento** no histórico e ajuste o mapeamento se algum campo vier com outro nome.
