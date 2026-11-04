---
titulo: Integração Hotmart — compras, boletos, carrinhos e assinaturas
area: administracao
telas: [/integracoes, /integracoes/aplicativos, /integracoes/historico]
papeis: Só o Admin.
palavras-chave: [hotmart, hottok, compra aprovada, boleto, carrinho abandonado, reembolso, chargeback, assinatura, curso, tabela de eventos, webhook, produto]
---
# Integração Hotmart

Recebe os eventos da **Hotmart** (compra aprovada, boleto, carrinho abandonado, reembolso, chargeback e assinaturas) e deixa você escolher o que cada evento faz no funil. Só o Admin configura. Veja também [Integrações](administracao-integracoes-webhooks.md).

## O que você precisa ter antes
- Uma conta de produtor na Hotmart com acesso a **Ferramentas > Webhook (API e notificações)**.
- O **hottok** (o token do webhook da conta, mostrado nessa página da Hotmart). É **opcional, mas recomendado**: com ele o CRM recusa chamadas que não venham da Hotmart. Guarde-o como senha.

## Passo a passo
**No CRM**
1. Em **Integrações → Aplicativos**, escolha **Hotmart**.
2. Em **Ação e nome**, dê um nome. Não há credencial de API.
3. Em **Endereço**, copie o endereço e cole o **Hottok** no campo do segredo.
4. Na **tabela de eventos**, escolha o que cada evento faz (veja abaixo) e, se quiser, filtre por **produto**.
5. Em **Configurações**, escolha funil, etapa de entrada, etiquetas e distribuição. Termine em **Salvar e ativar**.

**Na Hotmart**
1. Abra **Ferramentas > Webhook (API e notificações)** e clique em **Configurar** ou **Cadastrar webhook**.
2. Dê um nome, escolha a versão **2.0.0**, o produto (ou todos) e os eventos: compra aprovada, boleto impresso, carrinho abandonado, reembolso, chargeback, assinatura cancelada etc.
3. Cole o endereço da integração no campo da URL e salve. Se ainda não colou o hottok no CRM, copie-o dessa página.

## A tabela de eventos
Cada evento tem uma ação:
- **Ignorar:** nada acontece (o recebimento fica **Ignorado**, com o motivo).
- **Criar ou atualizar negócio aberto:** abre o negócio do comprador na etapa que você escolher (sem escolha, vale a etapa de entrada).
- **Marcar como ganho:** ganho com valor e produto.
- **Marcar como perdido:** perdido com o motivo escolhido (sem motivo, vale o motivo padrão da integração).
- **Só etiquetar o contato.**

Todas, menos Ignorar, podem somar etiquetas. Modelos prontos: **Vendas completas** (padrão: compra aprovada vira ganho com valor; carrinho abandonado e boleto abrem negócio na etapa inicial; reembolso, chargeback, compra cancelada e expirada viram perdido com motivo; assinatura cancelada e troca de plano só etiquetam), **Só compras aprovadas** e **Recuperação de vendas** (aprovada, carrinho e boleto). O **filtro por produto** aceita o nome ou o ID do produto; vazio significa todos.

## Como testar
Na Hotmart, use **Enviar teste** (ou faça uma compra de teste) e confira em **Integrações → Histórico**. O carrinho abandonado só é verificado a cada 30 minutos pela Hotmart.

## O que aparece no histórico
Cada evento é um recebimento com o código do evento. **Processado** quando agiu; **Ignorado** quando: o evento está configurado para ser ignorado, não está na tabela, o produto está fora do filtro ou é um **evento repetido** (a Hotmart reenvia automaticamente os envios que falham; o CRM reconhece o mesmo evento e não duplica); **Erro** quando falta e-mail e telefone ou o hottok não confere (recusado na chegada, 401).

## Criar ou atualizar: etapa, dono e status
A tabela de eventos já decide etapa (por evento) e status (ganho ou perdido). O modo e o alvo da integração valem como nas outras: **Criar**, **Criar ou atualizar** (atualiza o negócio aberto do comprador, em vez de abrir outro) ou **Atualizar**; o dono vem da distribuição escolhida em **Configurações** (rodízio, responsável fixo ou líder da área). Reembolso e chargeback só encontram a compra se a **transação** for a mesma: mantenha `negocio.camposPersonalizados.transacao` no mapeamento. Sem isso, só agem sobre negócio **aberto**.

## Erros comuns
- **401, "Assinatura ausente ou inválida":** o hottok colado no CRM é diferente do da Hotmart, ou foi trocado lá. Copie de novo.
- **Tudo "Ignorado" por "Evento não está na tabela":** acrescente o código do evento (por exemplo `PURCHASE_APPROVED`) à tabela.
- **Compra de assinatura criando vários negócios ganhos:** cada cobrança aprovada é uma venda. Se não quiser, mude a regra da compra aprovada.
- **Pix pendente:** a Hotmart não tem evento próprio de Pix gerado; o Pix pendente pode chegar como boleto impresso.
- **Carrinho sem valor nem transação:** é assim mesmo; só vêm comprador (se ele informou), produto e oferta.
- **UTMs vazias:** a Hotmart não manda UTMs, só `src`, `sck` e `xcod` (mapeados como fonte, campanha e conteúdo).
- **Formato [INFERIDO] (Pix e assinaturas):** confira o **primeiro recebimento** de cada tipo de evento no histórico e ajuste o mapeamento.
